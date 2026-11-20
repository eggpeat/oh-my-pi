/**
 * Internal URLs in a command a host shell runs.
 *
 * The embedded shell opens `local://…`, `skill://…` and the other file-backed
 * schemes itself and hands the programs it spawns the files they alias
 * (`crates/shell/src/host/urls.rs`); a named service and a pty command run
 * in that shell too, as a process of their own. Only a client terminal (ACP)
 * runs a command under a shell omp does not provide, which knows none of the
 * schemes. {@link hostCommandUrls} gives such a command the same result: every
 * word naming a URL the session backs with a file is rewritten to that file
 * before the shell sees it, under the rules the embedded shell applies to an
 * external's arguments. Everything else is left exactly as written.
 *
 * `omp` resolves the URLs it is given itself, so only a command that *runs*
 * `omp` — the program, or the command a known wrapper is given — keeps those
 * words. An argument merely spelled `omp` does not. A wrapper's own file
 * arguments — and an `omp` executable path handed to a wrapper
 * (`env local://bin/omp …`) — are still rewritten. The launcher rules match
 * `crates/shell/src/host/urls.rs` 1-for-1.
 */
import * as fs from "node:fs/promises";
import { ShellFsOp } from "@oh-my-pi/pi-natives";
import { isCmdShell } from "@oh-my-pi/pi-utils/procmgr";
import type { InternalUrlFilesystem } from "../internal-urls/url-filesystem";

/** The host path backing `url`, or `undefined` when nothing backs it or it cannot be resolved. */
export type UrlBacking = (url: string) => Promise<string | undefined>;

/** {@link UrlBacking} over a session's URL filesystem, within its tier. */
export function urlBacking(filesystem: InternalUrlFilesystem): UrlBacking {
	return async url => {
		const answer = await filesystem.handle({ op: ShellFsOp.BackingPath, path: url });
		return answer.error ? undefined : answer.path;
	};
}

/** `scheme://`, as the shell's filesystem spells a URL path (a drive letter is no scheme). */
const URL_ROOT = /^[A-Za-z][A-Za-z0-9+.-]+:\/\//;
const WORD_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const GLOB_RUN = /([*?[\]{}]+)/;
const RAW_SHELL_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "{", "}", "!"]);
const MAX_ENV_SPLITS = 64;

/** Whether `url` names nothing below its scheme: a bare root, or one followed by words. */
function namesNothing(url: string): boolean {
	const rest = url.replace(URL_ROOT, "").replace(/^\/+/, "");
	return rest.replace(/\/+$/, "") === "" || /^\s/.test(rest);
}

/**
 * Where the URL a word hands a program starts: at its beginning, or after what attaches it to an
 * option: a name and `=` (`--index=skill://x/data`, `FILE=local://in`), a short option letter
 * (`-olocal://out`), and then an `@` for "the contents of" (`@local://body.json`, `body=@local://b.md`).
 */
function urlStart(text: string): number | undefined {
	if (URL_ROOT.test(text)) return 0;
	const eq = text.indexOf("=");
	let at = 0;
	if (eq >= 0 && !text.slice(0, eq).includes("://")) at = eq + 1;
	else if (/^-[A-Za-z]/.test(text)) at = 2;
	if (text[at] === "@") at++;
	return URL_ROOT.test(text.slice(at)) ? at : undefined;
}

/** Whether `word` names the `omp` program, by any path. */
function isOmp(word: string): boolean {
	const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase();
	return name === "omp" || name === "omp.exe";
}

function programName(word: string): string {
	let name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
	if (name.length > 4 && name.toLowerCase().endsWith(".exe")) name = name.slice(0, -4);
	return process.platform === "win32" ? name.toLowerCase() : name;
}

function programIs(word: string, expect: string): boolean {
	const name = programName(word);
	return name === (process.platform === "win32" ? expect.toLowerCase() : expect);
}

function identAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	if (eq <= 0) return false;
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq));
}

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Escape `\`, `$` and backticks once per enclosing matched `` ` `` command. */
function escapeLayers(text: string, layers: number): string {
	if (layers <= 0) return text;
	return text.replace(/[\\$`]/g, ch => "\\".repeat(layers) + ch);
}

/**
 * `lead` and the file `host` that `url` resolved to, as one shell word. With `live`, the URL was
 * written unquoted: a pattern in its last segments (`local://logs/*.txt`) is still the shell's to expand.
 */
function spellWord(lead: string, host: string, url: string, cmd: boolean, live: boolean, layers: number): string {
	const glob = live ? url.search(/[*?[\]{}]/) : -1;
	const pattern = glob < 0 ? "" : url.slice(url.lastIndexOf("/", glob) + 1);
	const finish = (text: string) => escapeLayers(text, layers);
	if (pattern === "" || !host.endsWith(pattern)) return finish(quoteWord(lead + host, cmd));
	const spelled = pattern
		.split(GLOB_RUN)
		.map((part, index) => (index % 2 === 1 ? part : quoteWord(part, cmd)))
		.join("");
	return finish(quoteWord(lead + host.slice(0, host.length - pattern.length), cmd) + spelled);
}

/** Index of the closing unescaped `` ` `` matching the `` ` `` opened just before `start`, or -1. */
function backtickEnd(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		if (text[i] === "\\") {
			i++;
			continue;
		}
		if (text[i] === "`") return i;
	}
	return -1;
}

/** Index of the first `)` of `))` closing `$((` opened just before `start`, or -1. */
function arithEnd(text: string, start: number): number {
	let parens = 2;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = "";
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") parens++;
		else if (ch === ")") {
			parens--;
			if (parens === 0) return i - 1;
		}
	}
	return -1;
}

type CasePhase = "subject" | "await-in" | "pattern" | "body";

/**
 * The end of the `$(` substitution opened just before `start` in `text`: the index of its `)`, or -1.
 * A `)` that closes a `case` pattern is not the end of the substitution, including inside double quotes.
 */
function substitutionEnd(text: string, start: number): number {
	let depth = 1;
	let quote = "";
	const cases: CasePhase[] = [];
	let atCommand = true;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = "";
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
				const end = arithEnd(text, i + 3);
				if (end >= 0) i = end + 1;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const end = substitutionEnd(text, i + 2);
				if (end >= 0) i = end;
				continue;
			}
			if (ch === "`") {
				const end = backtickEnd(text, i + 1);
				if (end >= 0) i = end;
			}
			continue;
		}
		if (ch === "'") {
			quote = "'";
			atCommand = false;
			continue;
		}
		if (ch === '"') {
			quote = '"';
			atCommand = false;
			continue;
		}
		if (ch === "`") {
			const end = backtickEnd(text, i + 1);
			if (end >= 0) i = end;
			atCommand = false;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
			const end = arithEnd(text, i + 3);
			if (end >= 0) {
				i = end + 1;
				atCommand = false;
				continue;
			}
		}
		if (ch === "#") {
			const prev = i === start ? " " : text[i - 1];
			if (" \t\n;&|()<>".includes(prev)) {
				const nl = text.indexOf("\n", i + 1);
				if (nl < 0) return -1;
				i = nl - 1;
				continue;
			}
		}
		if (ch === "(") {
			depth++;
			atCommand = true;
			continue;
		}
		if (ch === ")") {
			if (cases[cases.length - 1] === "pattern") {
				cases[cases.length - 1] = "body";
				atCommand = true;
				continue;
			}
			if (--depth === 0) return i;
			atCommand = true;
			continue;
		}
		if (ch === ";" && (text[i + 1] === ";" || text[i + 1] === "&")) {
			const phase = cases[cases.length - 1];
			if (phase === "body" || phase === "pattern") cases[cases.length - 1] = "pattern";
			atCommand = true;
			i += text[i + 1] === ";" && text[i + 2] === "&" ? 2 : 1;
			continue;
		}
		const redir = unquotedRedirAt(text, i);
		if (redir) {
			i = skipRedirTarget(text, redir.opEnd) - 1;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
			atCommand = true;
			continue;
		}
		if (ch === " " || ch === "\t") continue;
		const wordStart = i;
		while (i < text.length && !" \t\n;&|()<>'\"`".includes(text[i]) && text[i] !== "\\") i++;
		const word = text.slice(wordStart, i);
		if (i > wordStart) i--;
		if (atCommand && (identAssignment(word) || SHELL_KEYWORDS.has(word) || word === "time")) continue;
		if (atCommand && word === "case") {
			cases.push("subject");
			atCommand = false;
			continue;
		}
		if (atCommand && word === "esac" && cases.length > 0) {
			cases.pop();
			atCommand = true;
			continue;
		}
		if (word === "in" && cases[cases.length - 1] === "await-in") {
			cases[cases.length - 1] = "pattern";
			atCommand = false;
			continue;
		}
		if (cases[cases.length - 1] === "subject") cases[cases.length - 1] = "await-in";
		atCommand = false;
	}
	return -1;
}

interface HereDoc {
	delimiter: string;
	tabs: boolean;
}

/** The here-document operator at `i`, if `<<` there is a redirection and not `<<<`. */
function readHereDoc(text: string, i: number): { end: number; doc: HereDoc } | undefined {
	if (text[i] !== "<" || text[i + 1] !== "<" || text[i + 2] === "<") return undefined;
	let j = i + 2;
	const tabs = text[j] === "-";
	if (tabs) j++;
	while (text[j] === " " || text[j] === "\t") j++;
	if (j >= text.length || text[j] === "\n") return undefined;
	let delimiter = "";
	let quote = "";
	while (j < text.length && text[j] !== "\n") {
		const ch = text[j];
		if (quote) {
			if (ch === quote) quote = "";
			else delimiter += ch;
			j++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			j++;
			continue;
		}
		if (ch === "\\") {
			if (j + 1 < text.length && text[j + 1] !== "\n") {
				delimiter += text[j + 1];
				j += 2;
				continue;
			}
		}
		if (" \t;&|()<>".includes(ch)) break;
		delimiter += ch;
		j++;
	}
	if (quote || delimiter === "") return undefined;
	return { end: j, doc: { delimiter, tabs } };
}

type ScanMode = "cmd" | "squote" | "dquote" | "comment" | "arith" | "bracket" | "backtick";

interface ScanFrame {
	mode: ScanMode;
	closeAt: number;
	parens: number;
	cases: CasePhase[];
}

/**
 * Split `text` into command text and here-document bodies. A `<<` inside arithmetic, quotes or a
 * comment is not a document; `<<<` is a here-string; `<<END"MARK"` waits for `ENDMARK`, not `END`.
 */
function partitionHeredocs(text: string): Array<{ kind: "code" | "body"; text: string }> {
	if (!text.includes("<<")) return [{ kind: "code", text }];
	const parts: Array<{ kind: "code" | "body"; text: string }> = [];
	const stack: ScanFrame[] = [{ mode: "cmd", closeAt: -1, parens: 0, cases: [] }];
	const pending: HereDoc[] = [];
	let atCommand = true;
	let codeFrom = 0;
	let i = 0;
	const top = () => stack[stack.length - 1];
	const inCommand = () => {
		const mode = top().mode;
		return mode === "cmd" || mode === "backtick";
	};
	const flushCode = (end: number) => {
		if (end > codeFrom) parts.push({ kind: "code", text: text.slice(codeFrom, end) });
		codeFrom = end;
	};
	while (i < text.length) {
		const ch = text[i];
		const frame = top();
		if (frame.mode === "comment") {
			if (ch === "\n") stack.pop();
			else {
				i++;
				continue;
			}
		}
		if (frame.mode === "squote") {
			if (ch === "'") stack.pop();
			i++;
			continue;
		}
		if (frame.mode === "arith") {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === "'") {
				stack.push({ mode: "squote", closeAt: -1, parens: 0, cases: [] });
				i++;
				continue;
			}
			if (ch === '"') {
				stack.push({ mode: "dquote", closeAt: -1, parens: 0, cases: [] });
				i++;
				continue;
			}
			if (ch === "(") {
				frame.parens++;
				i++;
				continue;
			}
			if (ch === ")") {
				frame.parens--;
				if (frame.parens <= 0) {
					stack.pop();
					atCommand = true;
				}
				i++;
				continue;
			}
			i++;
			continue;
		}
		if (frame.mode === "bracket") {
			if (ch === "]") stack.pop();
			i++;
			continue;
		}
		if (ch === "\n" && pending.length > 0 && inCommand()) {
			i++;
			flushCode(i);
			const bodyFrom = i;
			while (pending.length > 0 && i < text.length) {
				const nl = text.indexOf("\n", i);
				const lineEnd = nl < 0 ? text.length : nl;
				const line = text.slice(i, lineEnd);
				const open = pending[0];
				if ((open.tabs ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
				i = nl < 0 ? text.length : nl + 1;
			}
			parts.push({ kind: "body", text: text.slice(bodyFrom, i) });
			codeFrom = i;
			continue;
		}
		if (!inCommand() && frame.mode === "dquote") {
			if (ch === "\\") {
				i += 2;
				continue;
			}
			if (ch === '"') {
				stack.pop();
				i++;
				continue;
			}
			if (ch === "`") {
				stack.push({ mode: "backtick", closeAt: -1, parens: 0, cases: [] });
				i++;
				atCommand = true;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
				stack.push({ mode: "arith", closeAt: 0, parens: 2, cases: [] });
				i += 3;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				stack.push({ mode: "cmd", closeAt: 0, parens: 1, cases: [] });
				i += 2;
				atCommand = true;
				continue;
			}
			i++;
			continue;
		}
		if (ch === "\\") {
			if (text[i + 1] !== "\n") atCommand = false;
			i += 2;
			continue;
		}
		if (ch === "'" && frame.mode !== "dquote") {
			stack.push({ mode: "squote", closeAt: -1, parens: 0, cases: [] });
			i++;
			atCommand = false;
			continue;
		}
		if (ch === '"' && frame.mode !== "dquote") {
			stack.push({ mode: "dquote", closeAt: -1, parens: 0, cases: [] });
			i++;
			atCommand = false;
			continue;
		}
		if (ch === "`" && frame.mode === "backtick") {
			stack.pop();
			i++;
			continue;
		}
		if (ch === "`" && (frame.mode === "cmd" || frame.mode === "dquote")) {
			stack.push({ mode: "backtick", closeAt: -1, parens: 0, cases: [] });
			i++;
			atCommand = true;
			continue;
		}
		if (ch === "$" && text[i + 1] === "[") {
			stack.push({ mode: "bracket", closeAt: -1, parens: 0, cases: [] });
			i += 2;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
			stack.push({ mode: "arith", closeAt: 0, parens: 2, cases: [] });
			i += 3;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			stack.push({ mode: "cmd", closeAt: 0, parens: 1, cases: [] });
			i += 2;
			atCommand = true;
			continue;
		}
		if (inCommand() && atCommand && ch === "(" && text[i + 1] === "(") {
			stack.push({ mode: "arith", closeAt: 0, parens: 2, cases: [] });
			i += 2;
			continue;
		}
		if (inCommand() && ch === "<" && text[i + 1] === "<") {
			if (text[i + 2] === "<") {
				while (text[i] === "<") i++;
				i = skipRedirTarget(text, i);
				continue;
			}
			const doc = readHereDoc(text, i);
			if (doc) {
				pending.push(doc.doc);
				i = doc.end;
				continue;
			}
			i += 2;
			continue;
		}
		if (inCommand()) {
			const redir = unquotedRedirAt(text, i);
			if (redir) {
				i = skipRedirTarget(text, redir.opEnd);
				continue;
			}
		}
		if (inCommand() && ch === "#") {
			const prev = i === 0 ? " " : text[i - 1];
			if (" \t\n;&|()<>".includes(prev)) {
				stack.push({ mode: "comment", closeAt: -1, parens: 0, cases: [] });
				i++;
				continue;
			}
		}
		if (frame.mode === "cmd" && ch === "(") {
			frame.parens++;
			atCommand = true;
			i++;
			continue;
		}
		if (frame.mode === "cmd" && ch === ")") {
			if (frame.cases[frame.cases.length - 1] === "pattern") {
				frame.cases[frame.cases.length - 1] = "body";
				atCommand = true;
				i++;
				continue;
			}
			if (frame.parens > 0) frame.parens--;
			if (frame.closeAt >= 0 && frame.parens === frame.closeAt) stack.pop();
			atCommand = true;
			i++;
			continue;
		}
		if (inCommand() && ch === ";" && (text[i + 1] === ";" || text[i + 1] === "&")) {
			const phase = frame.cases[frame.cases.length - 1];
			if (phase === "body" || phase === "pattern") frame.cases[frame.cases.length - 1] = "pattern";
			atCommand = true;
			i += text[i + 1] === ";" && text[i + 2] === "&" ? 3 : 2;
			continue;
		}
		if (inCommand() && (ch === "\n" || ch === ";" || ch === "&" || ch === "|")) {
			atCommand = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			i++;
			continue;
		}
		if (inCommand() && atCommand) {
			const wordStart = i;
			while (i < text.length && !" \t\n;&|()<>'\"`".includes(text[i]) && text[i] !== "\\") i++;
			if (i === wordStart) {
				i++;
				continue;
			}
			const word = text.slice(wordStart, i);
			if (identAssignment(word) || SHELL_KEYWORDS.has(word) || word === "time") continue;
			if (word === "case") {
				frame.cases.push("subject");
				atCommand = false;
				continue;
			}
			if (word === "esac" && frame.cases.length > 0) {
				frame.cases.pop();
				continue;
			}
			if (word === "in" && frame.cases[frame.cases.length - 1] === "await-in") {
				frame.cases[frame.cases.length - 1] = "pattern";
				atCommand = false;
				continue;
			}
			if (frame.cases[frame.cases.length - 1] === "subject") frame.cases[frame.cases.length - 1] = "await-in";
			atCommand = false;
			continue;
		}
		if (inCommand() && frame.cases[frame.cases.length - 1] === "subject") {
			frame.cases[frame.cases.length - 1] = "await-in";
		}
		if (inCommand() && frame.cases[frame.cases.length - 1] === "await-in") {
			const wordStart = i;
			while (i < text.length && !" \t\n;&|()<>'\"`\\".includes(text[i])) i++;
			if (i > wordStart && text.slice(wordStart, i) === "in") {
				frame.cases[frame.cases.length - 1] = "pattern";
				atCommand = false;
				continue;
			}
			if (i > wordStart) continue;
		}
		atCommand = false;
		i++;
	}
	flushCode(text.length);
	return parts.length > 0 ? parts : [{ kind: "code", text }];
}

// ── Command lexer (recognizes unquoted redirects, quotes, and matched substitutions) ──

type RedirOp = "heredoc" | "herestring" | "file" | "dup";

type CmdToken =
	| { kind: "space"; raw: string }
	| { kind: "sep"; raw: string }
	| { kind: "redir"; op: RedirOp; opRaw: string; targetRaw: string; targetValue: string }
	| { kind: "word"; raw: string; value: string; quoted: boolean };

function isMeta(ch: string): boolean {
	return (
		ch === " " ||
		ch === "\t" ||
		ch === "\n" ||
		ch === ";" ||
		ch === "&" ||
		ch === "|" ||
		ch === "(" ||
		ch === ")" ||
		ch === "<" ||
		ch === ">"
	);
}

function readWord(text: string, start: number): { end: number; raw: string; value: string; quoted: boolean } {
	let i = start;
	let value = "";
	let quoted = false;
	while (i < text.length && !isMeta(text[i])) {
		const ch = text[i];
		if (ch === "'") {
			quoted = true;
			i++;
			while (i < text.length && text[i] !== "'") {
				value += text[i];
				i++;
			}
			if (i < text.length) i++;
			continue;
		}
		if (ch === '"') {
			quoted = true;
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length) {
					const next = text[i + 1];
					if (next === '"' || next === "\\" || next === "$" || next === "`") {
						value += next;
						i += 2;
						continue;
					}
					value += text[i];
					i++;
					continue;
				}
				if (text[i] === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
					const end = arithEnd(text, i + 3);
					if (end >= 0) {
						value += text.slice(i, end + 2);
						i = end + 2;
						continue;
					}
				}
				if (text[i] === "$" && text[i + 1] === "(") {
					const end = substitutionEnd(text, i + 2);
					if (end >= 0) {
						value += text.slice(i, end + 1);
						i = end + 1;
						continue;
					}
				}
				if (text[i] === "`") {
					const end = backtickEnd(text, i + 1);
					if (end >= 0) {
						value += text.slice(i, end + 1);
						i = end + 1;
						continue;
					}
				}
				value += text[i];
				i++;
			}
			if (i < text.length) i++;
			continue;
		}
		if (ch === "\\") {
			quoted = true;
			if (i + 1 < text.length) {
				if (text[i + 1] !== "\n") value += text[i + 1];
				i += 2;
			} else {
				value += ch;
				i++;
			}
			continue;
		}
		if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
			const end = arithEnd(text, i + 3);
			if (end >= 0) {
				value += text.slice(i, end + 2);
				i = end + 2;
				continue;
			}
		}
		if (ch === "$" && text[i + 1] === "(") {
			const end = substitutionEnd(text, i + 2);
			if (end >= 0) {
				value += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		if (ch === "`") {
			const end = backtickEnd(text, i + 1);
			if (end >= 0) {
				value += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
		}
		value += ch;
		i++;
	}
	return { end: i, raw: text.slice(start, i), value, quoted };
}

function skipRedirTarget(text: string, from: number): number {
	let j = from;
	while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
	if (j >= text.length || isMeta(text[j])) return j;
	return readWord(text, j).end;
}

function unquotedRedirAt(text: string, start: number): { op: RedirOp; opEnd: number } | undefined {
	if (text[start] === "&" && text[start + 1] === ">") {
		return { op: "file", opEnd: text[start + 2] === ">" ? start + 3 : start + 2 };
	}
	let j = start;
	while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
	const ch = text[j];
	if (ch !== "<" && ch !== ">") return undefined;
	const rest = text.slice(j);
	if (rest.startsWith("<<<")) return { op: "herestring", opEnd: j + 3 };
	if (rest.startsWith("<<-")) return { op: "heredoc", opEnd: j + 3 };
	if (rest.startsWith("<<")) return { op: "heredoc", opEnd: j + 2 };
	if (rest.startsWith("<&") || rest.startsWith(">&")) return { op: "dup", opEnd: j + 2 };
	if (rest.startsWith("<>") || rest.startsWith(">>") || rest.startsWith(">|")) return { op: "file", opEnd: j + 2 };
	return { op: "file", opEnd: j + 1 };
}

function lexCommand(text: string): CmdToken[] {
	const tokens: CmdToken[] = [];
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === " " || ch === "\t") {
			const from = i;
			while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
			tokens.push({ kind: "space", raw: text.slice(from, i) });
			continue;
		}
		if (ch === "\\" && text[i + 1] === "\n") {
			tokens.push({ kind: "space", raw: "\\\n" });
			i += 2;
			continue;
		}
		if (ch === "#") {
			const nl = text.indexOf("\n", i + 1);
			const end = nl < 0 ? text.length : nl;
			tokens.push({ kind: "space", raw: text.slice(i, end) });
			i = end;
			continue;
		}
		const redir = unquotedRedirAt(text, i);
		if (redir) {
			const opRaw = text.slice(i, redir.opEnd);
			i = redir.opEnd;
			if (i < text.length && !isMeta(text[i])) {
				const target = readWord(text, i);
				i = target.end;
				tokens.push({
					kind: "redir",
					op: redir.op,
					opRaw,
					targetRaw: target.raw,
					targetValue: target.value,
				});
			} else {
				tokens.push({ kind: "redir", op: redir.op, opRaw, targetRaw: "", targetValue: "" });
			}
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
			let len = 1;
			const rest = text.slice(i);
			if (rest.startsWith(";;&")) len = 3;
			else if (
				rest.startsWith("||") ||
				rest.startsWith("|&") ||
				rest.startsWith("&&") ||
				rest.startsWith(";;") ||
				rest.startsWith(";&")
			) {
				len = 2;
			}
			tokens.push({ kind: "sep", raw: text.slice(i, i + len) });
			i += len;
			continue;
		}
		const word = readWord(text, i);
		tokens.push({ kind: "word", raw: word.raw, value: word.value, quoted: word.quoted });
		i = word.end > i ? word.end : i + 1;
	}
	return tokens;
}

// ── Launcher walk & option tables (identical to crates/shell/src/host/urls.rs) ──

interface VWord {
	text: string;
	origin: number;
}

interface Launch {
	words: VWord[];
	at: number;
	passed: number[];
	aborted: boolean;
}

interface OptSet {
	shortVal: string;
	longVal: ReadonlySet<string>;
	stopShort: string;
	stopLong: ReadonlySet<string>;
}

function optSet(shortVal: string, longVal: readonly string[], stopShort: string, stopLong: readonly string[]): OptSet {
	return { shortVal, longVal: new Set(longVal), stopShort, stopLong: new Set(stopLong) };
}

const ENV = optSet("CPafu", ["argv0", "chdir", "env0-from", "file", "unset"], "0", [
	"help",
	"list-signal-handling",
	"null",
	"version",
]);
const SUDO = optSet(
	"CDRTUghprtu",
	[
		"chdir",
		"chroot",
		"close-from",
		"command-timeout",
		"group",
		"host",
		"other-user",
		"prompt",
		"role",
		"type",
		"user",
	],
	"KVevl",
	["edit", "help", "list", "remove-timestamp", "validate", "version"],
);
const DOAS = optSet("au", [], "CL", []);
const NICE = optSet("n", ["adjustment"], "", ["help", "version"]);
const NOHUP = optSet("", [], "", ["help", "version"]);
const TIME = optSet("fo", ["output", "format"], "", ["help", "version"]);
const TIMEOUT = optSet("ks", ["kill-after", "signal"], "", ["help", "version"]);
const STDBUF = optSet("eio", ["error", "input", "output"], "", ["help", "version"]);
const SETSID = optSet("", [], "Vh", ["help", "version"]);
const IFNE = optSet("", [], "h", ["help", "version"]);
const XARGS = optSet(
	"EILPadns",
	["arg-file", "delimiter", "max-args", "max-chars", "max-lines", "max-procs", "process-slot-var"],
	"",
	["help", "version"],
);
const EXEC = optSet("a", [], "", ["help"]);
const COMMAND = optSet("", [], "Vv", ["help"]);

const NPM_VAL = [
	"_auth",
	"access",
	"allow-directory",
	"allow-file",
	"allow-git",
	"allow-remote",
	"allow-scripts",
	"also",
	"audit-level",
	"auth-type",
	"before",
	"ca",
	"cache",
	"cache-max",
	"cache-min",
	"cafile",
	"cert",
	"cidr",
	"cpu",
	"depth",
	"diff",
	"diff-dst-prefix",
	"diff-src-prefix",
	"diff-unified",
	"editor",
	"expect-result-count",
	"expires",
	"fetch-retries",
	"fetch-retry-factor",
	"fetch-retry-maxtimeout",
	"fetch-retry-mintimeout",
	"fetch-timeout",
	"git",
	"globalconfig",
	"heading",
	"https-proxy",
	"include",
	"init-author-email",
	"init-author-name",
	"init-author-url",
	"init-license",
	"init-module",
	"init-type",
	"init-version",
	"init.author.email",
	"init.author.name",
	"init.author.url",
	"init.license",
	"init.module",
	"init.version",
	"install-strategy",
	"key",
	"libc",
	"local-address",
	"location",
	"lockfile-version",
	"loglevel",
	"logs-dir",
	"logs-max",
	"maxsockets",
	"message",
	"min-release-age",
	"name",
	"node-arg",
	"node-gyp",
	"node-options",
	"noproxy",
	"omit",
	"only",
	"orgs",
	"orgs-permission",
	"os",
	"otp",
	"pack-destination",
	"package",
	"packages",
	"packages-and-scopes-permission",
	"password",
	"prefix",
	"preid",
	"provenance-file",
	"proxy",
	"registry",
	"replace-registry-host",
	"save-prefix",
	"sbom-format",
	"sbom-type",
	"scope",
	"scopes",
	"script-shell",
	"searchexclude",
	"searchlimit",
	"searchopts",
	"searchstaleness",
	"shell",
	"tag",
	"tag-version-prefix",
	"token-description",
	"umask",
	"user-agent",
	"userconfig",
	"viewer",
	"which",
	"workspace",
];
const NPM = optSet("CLmw", NPM_VAL, "H?chv", ["call", "help", "usage", "version", "versions"]);
const NPX = optSet("CLmpw", NPM_VAL, "H?chv", ["call", "help", "usage", "version", "versions"]);

const BUN_GLOBAL = optSet(
	"Fcr",
	[
		"ca",
		"cafile",
		"conditions",
		"config",
		"cpu-prof-dir",
		"cpu-prof-interval",
		"cpu-prof-name",
		"cwd",
		"dns-result-order",
		"elide-lines",
		"env-file",
		"fetch-preconnect",
		"filter",
		"heap-prof-dir",
		"heap-prof-interval",
		"heap-prof-name",
		"import",
		"install",
		"max-http-header-size",
		"minimum-release-age",
		"port",
		"preload",
		"redirect-warnings",
		"registry",
		"require",
		"shell",
		"watch-kill-signal",
	],
	"epv",
	["eval", "help", "print", "revision", "version"],
);
const BUNX = optSet(
	"p",
	["ca", "cafile", "config", "cwd", "env-file", "minimum-release-age", "package", "registry"],
	"v",
	["help", "version"],
);

const UV_VAL = [
	"allow-insecure-host",
	"build-constraints",
	"cache-dir",
	"color",
	"config-file",
	"config-setting",
	"config-settings-package",
	"constraints",
	"default-index",
	"directory",
	"env-file",
	"exclude-newer",
	"exclude-newer-package",
	"extra",
	"extra-index-url",
	"find-links",
	"fork-strategy",
	"from",
	"group",
	"index",
	"index-strategy",
	"index-url",
	"keyring-provider",
	"link-mode",
	"no-binary-package",
	"no-build-isolation-package",
	"no-build-package",
	"no-editable-package",
	"no-extra",
	"no-group",
	"no-sources-package",
	"only-group",
	"overrides",
	"package",
	"prerelease",
	"prerelease-package",
	"project",
	"python",
	"python-platform",
	"refresh-package",
	"reinstall-package",
	"resolution",
	"torch-backend",
	"upgrade-group",
	"upgrade-package",
	"with",
	"with-editable",
	"with-requirements",
];
const UV_GLOBAL = optSet("CPfipw", UV_VAL, "Vh", ["help", "version"]);
const UV_RUN = optSet("CPfipw", UV_VAL, "Vhms", ["gui-script", "help", "module", "script", "version"]);
const UVX = optSet("CPbcfipw", UV_VAL, "Vh", ["help", "version"]);
const SSH = optSet("BbcDEeFIJiLlmOopQRWSw", [], "GNV", []);

function shortStep(letters: string, opts: OptSet): "one" | "next" | "stop" {
	for (let i = 0; i < letters.length; i++) {
		const ch = letters[i];
		if (opts.stopShort.includes(ch)) return "stop";
		if (opts.shortVal.includes(ch)) return i + 1 === letters.length ? "next" : "one";
	}
	return "one";
}

function skipOpts(words: VWord[], index: number, opts: OptSet): number | undefined {
	let at = index;
	while (at < words.length) {
		const word = words[at].text;
		if (word === "-" || !word.startsWith("-")) break;
		if (word === "--") return at + 1;
		if (word.startsWith("--")) {
			const body = word.slice(2);
			const eq = body.indexOf("=");
			const name = eq >= 0 ? body.slice(0, eq) : body;
			if (opts.stopLong.has(name)) return undefined;
			if (eq >= 0) {
				at++;
				continue;
			}
			at += opts.longVal.has(name) && at + 1 < words.length ? 2 : 1;
			continue;
		}
		const step = shortStep(word.slice(1), opts);
		if (step === "stop") return undefined;
		at += step === "next" && at + 1 < words.length ? 2 : 1;
	}
	return at;
}

function unescapeEnvS(ch: string): string {
	switch (ch) {
		case "n":
			return "\n";
		case "t":
			return "\t";
		case "r":
			return "\r";
		case "f":
			return "\f";
		case "v":
			return "\v";
		case "_":
			return " ";
		default:
			return ch;
	}
}

function splitEnvS(raw: string, origin: number): VWord[] {
	const out: VWord[] = [];
	let current = "";
	let inWord = false;
	let quote = "";
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i];
		if (quote === "'") {
			if (ch === "\\" && i + 1 < raw.length && (raw[i + 1] === "'" || raw[i + 1] === "\\")) {
				current += raw[i + 1];
				i += 2;
				continue;
			}
			if (ch === "'") quote = "";
			else current += ch;
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < raw.length) {
				const esc = raw[i + 1];
				if (esc === "c") break;
				current += unescapeEnvS(esc);
				i += 2;
				continue;
			}
			if (ch === '"') quote = "";
			else current += ch;
			i++;
			continue;
		}
		if (/\s/.test(ch)) {
			if (inWord) {
				out.push({ text: current, origin });
				current = "";
				inWord = false;
			}
			i++;
			continue;
		}
		if (ch === "#" && !inWord) {
			while (i < raw.length && raw[i] !== "\n") i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < raw.length) {
			const esc = raw[i + 1];
			if (esc === "c") break;
			if (esc === "_") {
				if (inWord) {
					out.push({ text: current, origin });
					current = "";
					inWord = false;
				}
				i += 2;
				continue;
			}
			inWord = true;
			current += unescapeEnvS(esc);
			i += 2;
			continue;
		}
		inWord = true;
		current += ch;
		i++;
	}
	if (inWord) out.push({ text: current, origin });
	return out;
}

function stepEnv(words: VWord[], envAt: number, passed: number[], splits: { count: number }): number | undefined {
	let at = envAt + 1;
	while (at < words.length) {
		const word = words[at].text;
		if (word === "-" || !word.startsWith("-")) break;
		if (word === "--") {
			at++;
			break;
		}
		if (word.startsWith("--")) {
			const body = word.slice(2);
			const eq = body.indexOf("=");
			const name = eq >= 0 ? body.slice(0, eq) : body;
			if (ENV.stopLong.has(name)) return undefined;
			if (name === "split-string") {
				if (splits.count >= MAX_ENV_SPLITS) return undefined;
				splits.count++;
				if (eq >= 0) {
					words.splice(at, 1, ...splitEnvS(body.slice(eq + 1), words[at].origin));
				} else if (at + 1 < words.length) {
					words.splice(at, 2, ...splitEnvS(words[at + 1].text, words[at + 1].origin));
				} else {
					return undefined;
				}
				continue;
			}
			if (eq >= 0) {
				at++;
				continue;
			}
			at += ENV.longVal.has(name) && at + 1 < words.length ? 2 : 1;
			continue;
		}
		const letters = word.slice(1);
		let splitOffset: number | "consumed" | undefined;
		for (let offset = 0; offset < letters.length; offset++) {
			const ch = letters[offset];
			if (ENV.stopShort.includes(ch)) return undefined;
			if (ch === "S") {
				splitOffset = offset;
				break;
			}
			if (ENV.shortVal.includes(ch)) {
				at += offset + 1 === letters.length && at + 1 < words.length ? 2 : 1;
				splitOffset = "consumed";
				break;
			}
		}
		if (splitOffset === undefined) {
			at++;
		} else if (splitOffset !== "consumed") {
			if (splits.count >= MAX_ENV_SPLITS) return undefined;
			splits.count++;
			if (splitOffset + 1 < letters.length) {
				words.splice(at, 1, ...splitEnvS(letters.slice(splitOffset + 1), words[at].origin));
			} else if (at + 1 < words.length) {
				words.splice(at, 2, ...splitEnvS(words[at + 1].text, words[at + 1].origin));
			} else {
				return undefined;
			}
		}
	}
	if (at < words.length && words[at].text === "-") at++;
	while (at < words.length && words[at].text.includes("=")) {
		passed.push(words[at].origin);
		at++;
	}
	return at;
}

/** Iterative walk past launchers (`while` loop: constant stack depth). */
function launchOf(initial: VWord[]): Launch {
	const words = initial.slice();
	let at = 0;
	const passed: number[] = [];
	const splits = { count: 0 };
	while (at < words.length) {
		const word = words[at].text;
		if (programIs(word, "env")) {
			const next = stepEnv(words, at, passed, splits);
			if (next === undefined) return { words, at, passed, aborted: true };
			at = next;
			continue;
		}
		if (programIs(word, "sudo")) {
			let next = skipOpts(words, at + 1, SUDO);
			if (next === undefined) return { words, at, passed, aborted: true };
			while (next < words.length && identAssignment(words[next].text)) {
				passed.push(words[next].origin);
				next++;
			}
			at = next;
			continue;
		}
		const simple = (opts: OptSet): boolean => {
			const next = skipOpts(words, at + 1, opts);
			if (next === undefined) return false;
			at = next;
			return true;
		};
		if (programIs(word, "doas")) {
			if (!simple(DOAS)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "nice")) {
			if (!simple(NICE)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "nohup")) {
			if (!simple(NOHUP)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "time")) {
			if (!simple(TIME)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "timeout") || programIs(word, "gtimeout")) {
			const duration = skipOpts(words, at + 1, TIMEOUT);
			if (duration === undefined || duration >= words.length) {
				return { words, at: duration ?? at, passed, aborted: true };
			}
			at = duration + 1;
			continue;
		}
		if (programIs(word, "stdbuf")) {
			if (!simple(STDBUF)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "setsid")) {
			if (!simple(SETSID)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "ifne")) {
			if (!simple(IFNE)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "xargs")) {
			if (!simple(XARGS)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "exec")) {
			if (!simple(EXEC)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "command")) {
			if (!simple(COMMAND)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "npx")) {
			if (!simple(NPX)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "npm")) {
			const sub = skipOpts(words, at + 1, NPM);
			if (sub === undefined) return { words, at, passed, aborted: true };
			if (sub >= words.length || (words[sub].text !== "exec" && words[sub].text !== "x")) break;
			const next = skipOpts(words, sub + 1, NPM);
			if (next === undefined) return { words, at, passed, aborted: true };
			at = next;
			continue;
		}
		if (programIs(word, "bunx")) {
			if (!simple(BUNX)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "bun")) {
			const sub = skipOpts(words, at + 1, BUN_GLOBAL);
			if (sub === undefined) return { words, at, passed, aborted: true };
			if (sub >= words.length || words[sub].text !== "x") break;
			const next = skipOpts(words, sub + 1, BUNX);
			if (next === undefined) return { words, at, passed, aborted: true };
			at = next;
			continue;
		}
		if (programIs(word, "uvx")) {
			if (!simple(UVX)) return { words, at, passed, aborted: true };
			continue;
		}
		if (programIs(word, "uv")) {
			const sub = skipOpts(words, at + 1, UV_GLOBAL);
			if (sub === undefined) return { words, at, passed, aborted: true };
			if (sub < words.length && words[sub].text === "run") {
				const next = skipOpts(words, sub + 1, UV_RUN);
				if (next === undefined) return { words, at, passed, aborted: true };
				at = next;
				continue;
			}
			if (sub + 1 < words.length && words[sub].text === "tool" && words[sub + 1].text === "run") {
				const next = skipOpts(words, sub + 2, UVX);
				if (next === undefined) return { words, at, passed, aborted: true };
				at = next;
				continue;
			}
			break;
		}
		break;
	}
	return { words, at, passed, aborted: false };
}

function markOmpArgs(rewrite: boolean[], words: VWord[], ompAt: number, passed: number[], includeExec: boolean): void {
	const from = includeExec ? ompAt : ompAt + 1;
	for (let i = from; i < words.length; i++) {
		const origin = words[i].origin;
		if (origin < rewrite.length) rewrite[origin] = false;
	}
	for (const origin of passed) {
		if (origin < rewrite.length) rewrite[origin] = false;
	}
}

type RemoteTok = { kind: "sep" } | { kind: "redir"; hasTarget: boolean } | { kind: "word"; word: VWord };

function readRemoteWord(text: string, start: number): { value: string; end: number } | undefined {
	let value = "";
	let i = start;
	while (i < text.length && !isMeta(text[i])) {
		const ch = text[i];
		if (ch === "'") {
			i++;
			while (i < text.length && text[i] !== "'") {
				value += text[i];
				i++;
			}
			if (i >= text.length) return undefined;
			i++;
			continue;
		}
		if (ch === '"') {
			i++;
			while (i < text.length && text[i] !== '"') {
				if (text[i] === "\\" && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) {
					value += text[i + 1];
					i += 2;
					continue;
				}
				value += text[i];
				i++;
			}
			if (i >= text.length) return undefined;
			i++;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= text.length) return undefined;
			value += text[i + 1];
			i += 2;
			continue;
		}
		value += ch;
		i++;
	}
	return { value, end: i };
}

function lexRemote(remoteWords: VWord[]): RemoteTok[] | undefined {
	const out: RemoteTok[] = [];
	for (const item of remoteWords) {
		const text = item.text;
		const origin = item.origin;
		let i = 0;
		while (i < text.length) {
			const ch = text[i];
			if (ch === " " || ch === "\t") {
				i++;
				continue;
			}
			if (ch === "#") {
				const nl = text.indexOf("\n", i + 1);
				i = nl < 0 ? text.length : nl;
				continue;
			}
			const redir = unquotedRedirAt(text, i);
			if (redir) {
				i = redir.opEnd;
				let hasTarget = false;
				if (i < text.length && !isMeta(text[i])) {
					const target = readRemoteWord(text, i);
					if (!target) return undefined;
					i = target.end;
					hasTarget = true;
				}
				out.push({ kind: "redir", hasTarget });
				continue;
			}
			if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(" || ch === ")") {
				const rest = text.slice(i);
				let len = 1;
				if (rest.startsWith(";;&")) len = 3;
				else if (
					rest.startsWith("||") ||
					rest.startsWith("|&") ||
					rest.startsWith("&&") ||
					rest.startsWith(";;") ||
					rest.startsWith(";&")
				) {
					len = 2;
				}
				i += len;
				out.push({ kind: "sep" });
				continue;
			}
			const word = readRemoteWord(text, i);
			if (!word) return undefined;
			out.push({ kind: "word", word: { text: word.value, origin } });
			i = word.end;
		}
	}
	return out;
}

function ambiguousRemoteCmd(words: VWord[]): boolean {
	if (words.length === 0) return false;
	const cmd = words[0].text;
	if (/[$`*?[]/.test(cmd)) return true;
	const base = programName(cmd);
	if (base === "eval" || base === "." || base === "source") return true;
	if (base === "sh" || base === "bash" || base === "zsh" || base === "dash" || base === "ksh") {
		for (let i = 1; i < words.length; i++) {
			const w = words[i].text;
			if (!w.startsWith("-") || w === "--") break;
			if (!w.startsWith("--") && w.slice(1).includes("c")) return true;
		}
	}
	return false;
}

function markSsh(rewrite: boolean[], sshWords: VWord[], rawWords: ArgWord[]): void {
	const host = skipOpts(sshWords, 1, SSH);
	if (host === undefined) return;
	const remote = host + 1;
	if (remote >= sshWords.length) return;
	// If any remote argument contains an unquoted local expansion (`$var`), it is
	// ambiguous until the local shell expands it unless a clear command precedes it.
	const remoteSlice = sshWords.slice(remote);
	const tokens = lexRemote(remoteSlice);
	if (!tokens) {
		for (const word of remoteSlice) rewrite[word.origin] = false;
		return;
	}
	let i = 0;
	while (i < tokens.length) {
		if (tokens[i].kind === "sep") {
			i++;
			continue;
		}
		const cmdWords: VWord[] = [];
		const allOrigins: number[] = [];
		while (i < tokens.length && tokens[i].kind !== "sep") {
			const tok = tokens[i];
			if (tok.kind === "redir") {
				i++;
				if (!tok.hasTarget && i < tokens.length && tokens[i].kind === "word") {
					allOrigins.push((tokens[i] as Extract<RemoteTok, { kind: "word" }>).word.origin);
					i++;
				}
			} else if (tok.kind === "word") {
				allOrigins.push(tok.word.origin);
				cmdWords.push(tok.word);
				i++;
			}
		}
		let start = 0;
		while (start < cmdWords.length && SHELL_KEYWORDS.has(cmdWords[start].text)) start++;
		const leadAssigns: number[] = [];
		while (start < cmdWords.length && identAssignment(cmdWords[start].text)) {
			leadAssigns.push(cmdWords[start].origin);
			start++;
		}
		if (start >= cmdWords.length) continue;
		const launch = launchOf(cmdWords.slice(start));
		if (launch.aborted || launch.at >= launch.words.length) continue;
		const first = launch.words[launch.at];
		const rawFirst = rawWords[first.origin];
		if (isOmp(first.text)) {
			markOmpArgs(rewrite, launch.words, launch.at, launch.passed, true);
			for (const origin of leadAssigns) rewrite[origin] = false;
		} else if (ambiguousRemoteCmd(launch.words.slice(launch.at)) || (rawFirst && /[$`]/.test(rawFirst.raw))) {
			for (const origin of allOrigins) rewrite[origin] = false;
		}
	}
}

function markFind(rewrite: boolean[], findWords: VWord[]): boolean {
	let reaches = false;
	for (let i = 1; i < findWords.length; i++) {
		const w = findWords[i].text;
		if (w !== "-exec" && w !== "-execdir" && w !== "-ok" && w !== "-okdir") continue;
		const start = i + 1;
		let end = start;
		while (end < findWords.length && findWords[end].text !== ";" && findWords[end].text !== "+") end++;
		if (start < end) {
			const launch = launchOf(findWords.slice(start, end));
			if (!launch.aborted && launch.at < launch.words.length && isOmp(launch.words[launch.at].text)) {
				reaches = true;
				markOmpArgs(rewrite, launch.words, launch.at, launch.passed, false);
			}
		}
		i = end;
	}
	return reaches;
}

interface ArgWord {
	raw: string;
	value: string;
	quoted: boolean;
}

/** `true` where a URL in `args[i]` should be rewritten to its host path. */
function classifyArgs(args: ArgWord[]): boolean[] {
	const rewrite = args.map(() => true);
	let start = 0;
	while (start < args.length && !args[start].quoted && SHELL_KEYWORDS.has(args[start].value)) {
		start++;
	}
	const leadAssigns: number[] = [];
	while (start < args.length && RAW_SHELL_ASSIGN.test(args[start].raw)) {
		leadAssigns.push(start);
		start++;
	}
	if (start >= args.length) return rewrite;
	const initial: VWord[] = [];
	for (let i = start; i < args.length; i++) {
		initial.push({ text: args[i].value, origin: i });
	}
	const launch = launchOf(initial);
	if (launch.aborted || launch.at >= launch.words.length) return rewrite;
	const cmd = launch.words[launch.at].text;
	if (programIs(cmd, "ssh")) {
		markSsh(rewrite, launch.words.slice(launch.at), args);
		return rewrite;
	}
	if (programIs(cmd, "find")) {
		const reaches = markFind(rewrite, launch.words.slice(launch.at));
		if (reaches) {
			for (const origin of leadAssigns) rewrite[origin] = false;
			for (const origin of launch.passed) if (origin < rewrite.length) rewrite[origin] = false;
		}
		return rewrite;
	}
	if (isOmp(cmd)) {
		for (const origin of leadAssigns) rewrite[origin] = false;
		markOmpArgs(rewrite, launch.words, launch.at, launch.passed, false);
	}
	return rewrite;
}

class HostUrls {
	readonly #backing: UrlBacking;
	readonly #cmd: boolean;
	readonly #resolved = new Map<string, Promise<string | undefined>>();

	constructor(backing: UrlBacking, cmd: boolean) {
		this.#backing = backing;
		this.#cmd = cmd;
	}

	/** `command` with here-document bodies, which are input rather than command text, left alone. */
	async command(command: string): Promise<string> {
		if (!command.includes("://")) return command;
		let out = "";
		for (const part of partitionHeredocs(command)) {
			out += part.kind === "body" ? part.text : await this.#code(part.text, 0);
		}
		return out;
	}

	/** Command text without here-document bodies, simple command by simple command. */
	async #code(text: string, layers: number): Promise<string> {
		if (!text.includes("://")) return text;
		const tokens = lexCommand(text);
		const effectiveLayers = this.#cmd ? 0 : layers;
		let out = "";
		let i = 0;
		while (i < tokens.length) {
			const head = tokens[i];
			if (head.kind === "sep") {
				out += head.raw;
				i++;
				continue;
			}
			const segment: CmdToken[] = [];
			while (i < tokens.length && tokens[i].kind !== "sep") {
				segment.push(tokens[i]);
				i++;
			}
			out += await this.#segment(segment, effectiveLayers);
		}
		return out;
	}

	async #segment(segment: CmdToken[], layers: number): Promise<string> {
		// Pair bare redirect operators (`> local://out`, `<< 'EOF'`) with their target word first,
		// so redirects never masquerade as the command word or arguments.
		const targetRole = new Map<number, RedirOp>();
		const argWords: ArgWord[] = [];
		const argIndexAt = new Map<number, number>();
		let pendingRedir: RedirOp | undefined;
		for (let i = 0; i < segment.length; i++) {
			const tok = segment[i];
			if (tok.kind === "space" || tok.kind === "sep") continue;
			if (tok.kind === "redir") {
				pendingRedir = tok.targetRaw === "" ? tok.op : undefined;
				continue;
			}
			if (pendingRedir !== undefined) {
				targetRole.set(i, pendingRedir);
				pendingRedir = undefined;
				continue;
			}
			argIndexAt.set(i, argWords.length);
			argWords.push({ raw: tok.raw, value: tok.value, quoted: tok.quoted });
		}
		const rewriteArgs = classifyArgs(argWords);
		let out = "";
		for (let i = 0; i < segment.length; i++) {
			const tok = segment[i];
			if (tok.kind === "space" || tok.kind === "sep") {
				out += tok.raw;
				continue;
			}
			if (tok.kind === "redir") {
				if (tok.targetRaw === "") {
					out += tok.opRaw;
				} else {
					out += tok.opRaw + (await this.#redirTarget(tok.op, tok.targetRaw, tok.targetValue, layers));
				}
				continue;
			}
			const role = targetRole.get(i);
			if (role !== undefined) {
				out += await this.#redirTarget(role, tok.raw, tok.value, layers);
				continue;
			}
			const argIdx = argIndexAt.get(i) ?? 0;
			out += await this.#emitWord(tok.raw, tok.value, rewriteArgs[argIdx], layers);
		}
		return out;
	}

	async #redirTarget(op: RedirOp, raw: string, value: string, layers: number): Promise<string> {
		if (op === "heredoc") return raw;
		if ((raw.includes("$(") || raw.includes("`")) && raw.includes("://")) {
			return this.#expansions(raw, layers);
		}
		if (op !== "file") return raw;
		return this.#word(raw, value, layers);
	}

	async #emitWord(raw: string, value: string, rewrite: boolean, layers: number): Promise<string> {
		if ((raw.includes("$(") || raw.includes("`")) && raw.includes("://")) {
			return this.#expansions(raw, layers);
		}
		if (!rewrite || !value.includes("://")) return raw;
		return this.#word(raw, value, layers);
	}

	/** One word naming a URL: its spelling with the URL's file in place, or as written. */
	async #word(raw: string, value: string, layers: number): Promise<string> {
		if (/[$`]/.test(raw)) return raw;
		const at = urlStart(value);
		if (at === undefined) return raw;
		const url = value.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return spellWord(value.slice(0, at), host, url, this.#cmd, raw.endsWith(url), layers);
	}

	/** A word holding `$(…)` or matched `` `…` ``: each substitution is a command of its own. */
	async #expansions(raw: string, layers: number): Promise<string> {
		let out = "";
		let quote = "";
		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i];
			if (quote === "'") {
				out += ch;
				if (ch === "'") quote = "";
				continue;
			}
			if (ch === "\\") {
				out += raw.slice(i, i + 2);
				i++;
				continue;
			}
			if (ch === '"') {
				quote = quote ? "" : '"';
				out += ch;
				continue;
			}
			if (ch === "'" && !quote) {
				quote = "'";
				out += ch;
				continue;
			}
			if (ch === "$" && raw[i + 1] === "(" && raw[i + 2] !== "(") {
				const end = substitutionEnd(raw, i + 2);
				if (end >= 0) {
					out += `$(${await this.#code(raw.slice(i + 2, end), layers)})`;
					i = end;
					continue;
				}
			}
			if (ch === "`") {
				const end = backtickEnd(raw, i + 1);
				if (end > i) {
					out += "`" + (await this.#code(raw.slice(i + 1, end), layers + 1)) + "`";
					i = end;
					continue;
				}
			}
			out += ch;
		}
		return out;
	}

	#host(url: string): Promise<string | undefined> {
		let host = this.#resolved.get(url);
		if (!host) {
			host = this.#backing(url).catch(() => undefined);
			this.#resolved.set(url, host);
		}
		return host;
	}
}

/**
 * `command` as `shell` should run it: every word naming a URL that `backing` resolves is rewritten
 * to the host file, attached options, redirections, variable assignments and `$(…)` included.
 * `omp` commands, here-document bodies, message text, and URLs nothing backs stay as written.
 */
export function hostCommandUrls(command: string, backing: UrlBacking, shell?: string): Promise<string> {
	return new HostUrls(backing, shell !== undefined && isCmdShell(shell)).command(command);
}
