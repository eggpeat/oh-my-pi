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
 * Launcher, `env -S`, `find`, and `ssh` ownership rules are shared with the
 * embedded shell via {@link classifyShellUrlArgs} from `@oh-my-pi/pi-natives`.
 */
import * as fs from "node:fs/promises";
import { classifyShellUrlArgs, type ShellEnvSplitPlan, ShellFsOp } from "@oh-my-pi/pi-natives";
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
const RAW_SHELL_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*\+?=/.source;
const SHELL_ASSIGN_RE = new RegExp(RAW_SHELL_ASSIGN);
const FD_TARGET_RE = /^(?:\d+-?|-)$/;
const SHELL_KEYWORDS = new Set(["if", "then", "elif", "else", "while", "until", "do", "{", "}", "!"]);

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

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** `text` as one literal word inside an `env -S` split string. */
function quoteEnvSWord(text: string): string {
	if (text !== "" && /^[\x21-\x7e]+$/.test(text) && !/['"\\#$]/.test(text)) return text;
	return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
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

/** Index of the first `)` of `))` closing `$((` or `((` opened just before `start`, or -1. */
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
	let afterFor = false;
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
			afterFor = false;
			continue;
		}
		if (ch === '"') {
			quote = '"';
			atCommand = false;
			afterFor = false;
			continue;
		}
		if (ch === "`") {
			const end = backtickEnd(text, i + 1);
			if (end >= 0) i = end;
			atCommand = false;
			afterFor = false;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
			const end = arithEnd(text, i + 3);
			if (end >= 0) {
				i = end + 1;
				atCommand = false;
				afterFor = false;
				continue;
			}
		}
		if ((atCommand || afterFor) && ch === "(" && text[i + 1] === "(") {
			const end = arithEnd(text, i + 2);
			if (end >= 0) {
				i = end + 1;
				atCommand = true;
				afterFor = false;
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
			afterFor = false;
			continue;
		}
		if (ch === ")") {
			if (cases[cases.length - 1] === "pattern") {
				cases[cases.length - 1] = "body";
				atCommand = true;
				afterFor = false;
				continue;
			}
			if (--depth === 0) return i;
			atCommand = true;
			afterFor = false;
			continue;
		}
		if (ch === ";" && (text[i + 1] === ";" || text[i + 1] === "&")) {
			const phase = cases[cases.length - 1];
			if (phase === "body" || phase === "pattern") cases[cases.length - 1] = "pattern";
			atCommand = true;
			afterFor = false;
			i += text[i + 1] === ";" && text[i + 2] === "&" ? 2 : 1;
			continue;
		}
		const atBoundary = i === start || isMeta(text[i - 1]);
		const redir = unquotedRedirAt(text, i, atBoundary);
		if (redir) {
			i = skipRedirTarget(text, redir.opEnd) - 1;
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
			atCommand = true;
			if (ch !== "\n") afterFor = false;
			continue;
		}
		if (ch === " " || ch === "\t") continue;
		const wordStart = i;
		while (i < text.length && !" \t\n;&|()<>'\"`".includes(text[i]) && text[i] !== "\\") i++;
		const word = text.slice(wordStart, i);
		if (i > wordStart) i--;
		afterFor = false;
		if (atCommand && (SHELL_ASSIGN_RE.test(word) || SHELL_KEYWORDS.has(word) || word === "time")) continue;
		if (atCommand && word === "for") {
			afterFor = true;
			atCommand = false;
			continue;
		}
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

/** The here-document operator at `i` (pointing at `<<`), if `<<` there is not `<<<`. */
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
	afterFor: boolean;
	inRedirTarget: boolean;
	redirTargetStarted: boolean;
}

function makeFrame(mode: ScanMode, closeAt = -1, parens = 0): ScanFrame {
	return { mode, closeAt, parens, cases: [], afterFor: false, inRedirTarget: false, redirTargetStarted: false };
}

/**
 * Split `text` into command text and here-document bodies.
 *
 * Handles numbered here-documents (`0<<EOF`), quoted/mixed delimiters (`<<END"MARK"`),
 * here-strings (`<<<`) including nested here-documents inside `<<<"$(cat <<EOF … EOF)"`,
 * and arithmetic `((…))` / `$((…))` / `for ((…))` shifts without false matches.
 */
function partitionHeredocs(text: string, cmd: boolean): Array<{ kind: "code" | "body"; text: string }> {
	if (cmd || !text.includes("<<")) return [{ kind: "code", text }];
	const parts: Array<{ kind: "code" | "body"; text: string }> = [];
	const stack: ScanFrame[] = [makeFrame("cmd")];
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
				stack.push(makeFrame("squote"));
				i++;
				continue;
			}
			if (ch === '"') {
				stack.push(makeFrame("dquote"));
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
			frame.inRedirTarget = false;
			frame.redirTargetStarted = false;
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
				stack.push(makeFrame("backtick"));
				i++;
				atCommand = true;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
				stack.push(makeFrame("arith", 0, 2));
				i += 3;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				stack.push(makeFrame("cmd", 0, 1));
				i += 2;
				atCommand = true;
				continue;
			}
			i++;
			continue;
		}
		if (ch === "\\") {
			if (text[i + 1] !== "\n") {
				if (frame.inRedirTarget) frame.redirTargetStarted = true;
				else atCommand = false;
				frame.afterFor = false;
			}
			i += 2;
			continue;
		}
		if (ch === "'" && frame.mode !== "dquote") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			else atCommand = false;
			frame.afterFor = false;
			stack.push(makeFrame("squote"));
			i++;
			continue;
		}
		if (ch === '"' && frame.mode !== "dquote") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			else atCommand = false;
			frame.afterFor = false;
			stack.push(makeFrame("dquote"));
			i++;
			continue;
		}
		if (ch === "`" && frame.mode === "backtick") {
			stack.pop();
			i++;
			continue;
		}
		if (ch === "`" && frame.mode === "cmd") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			frame.afterFor = false;
			stack.push(makeFrame("backtick"));
			i++;
			atCommand = true;
			continue;
		}
		if (ch === "$" && text[i + 1] === "[") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			frame.afterFor = false;
			stack.push(makeFrame("bracket"));
			i += 2;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			frame.afterFor = false;
			stack.push(makeFrame("arith", 0, 2));
			i += 3;
			continue;
		}
		if (ch === "$" && text[i + 1] === "(") {
			if (frame.inRedirTarget) frame.redirTargetStarted = true;
			frame.afterFor = false;
			stack.push(makeFrame("cmd", 0, 1));
			i += 2;
			atCommand = true;
			continue;
		}
		if (inCommand() && (atCommand || frame.afterFor) && !frame.inRedirTarget && ch === "(" && text[i + 1] === "(") {
			frame.afterFor = false;
			stack.push(makeFrame("arith", 0, 2));
			i += 2;
			continue;
		}
		if (inCommand()) {
			const atBoundary = i === 0 || isMeta(text[i - 1]);
			const redir = unquotedRedirAt(text, i, atBoundary);
			if (redir) {
				frame.inRedirTarget = false;
				frame.redirTargetStarted = false;
				frame.afterFor = false;
				if (redir.op === "heredoc") {
					const doc = readHereDoc(text, redir.ltPos);
					if (doc) {
						pending.push(doc.doc);
						i = doc.end;
					} else {
						i = redir.opEnd;
					}
					continue;
				}
				// Consume only the redirect operator (including extra `<` on `<<<`) so any nested
				// `$(cat <<EOF … EOF)` inside the target word is still scanned normally.
				i = redir.opEnd;
				if (redir.op === "herestring") {
					while (text[i] === "<") i++;
				}
				frame.inRedirTarget = true;
				frame.redirTargetStarted = false;
				continue;
			}
		}
		if (inCommand() && ch === "#") {
			const prev = i === 0 ? " " : text[i - 1];
			if (" \t\n;&|()<>".includes(prev)) {
				stack.push(makeFrame("comment"));
				i++;
				continue;
			}
		}
		if (frame.mode === "cmd" && ch === "(") {
			frame.inRedirTarget = false;
			frame.redirTargetStarted = false;
			frame.afterFor = false;
			frame.parens++;
			atCommand = true;
			i++;
			continue;
		}
		if (frame.mode === "cmd" && ch === ")") {
			frame.inRedirTarget = false;
			frame.redirTargetStarted = false;
			frame.afterFor = false;
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
			frame.inRedirTarget = false;
			frame.redirTargetStarted = false;
			frame.afterFor = false;
			const phase = frame.cases[frame.cases.length - 1];
			if (phase === "body" || phase === "pattern") frame.cases[frame.cases.length - 1] = "pattern";
			atCommand = true;
			i += text[i + 1] === ";" && text[i + 2] === "&" ? 3 : 2;
			continue;
		}
		if (inCommand() && (ch === "\n" || ch === ";" || ch === "&" || ch === "|")) {
			frame.inRedirTarget = false;
			frame.redirTargetStarted = false;
			if (ch !== "\n") frame.afterFor = false;
			atCommand = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (frame.inRedirTarget && frame.redirTargetStarted) {
				frame.inRedirTarget = false;
				frame.redirTargetStarted = false;
			}
			i++;
			continue;
		}
		if (inCommand() && frame.inRedirTarget) {
			frame.redirTargetStarted = true;
			while (i < text.length && !" \t\n;&|()<>'\"`\\$".includes(text[i])) i++;
			if (text[i] === "$" && text[i + 1] !== "(" && text[i + 1] !== "[") i++;
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
			frame.afterFor = false;
			if (SHELL_ASSIGN_RE.test(word) || SHELL_KEYWORDS.has(word) || word === "time") continue;
			if (word === "for") {
				frame.afterFor = true;
				atCommand = false;
				continue;
			}
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
		frame.afterFor = false;
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

type RedirOp = "heredoc" | "herestring" | "file" | "dup" | "dup_or_file";

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

function unquotedRedirAt(
	text: string,
	start: number,
	allowFd: boolean,
): { op: RedirOp; ltPos: number; opEnd: number } | undefined {
	if (text[start] === "&" && text[start + 1] === ">") {
		return { op: "file", ltPos: start, opEnd: text[start + 2] === ">" ? start + 3 : start + 2 };
	}
	let j = start;
	if (allowFd) {
		while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
	}
	const ch = text[j];
	if (ch !== "<" && ch !== ">") return undefined;
	const rest = text.slice(j);
	if (rest.startsWith("<<<")) return { op: "herestring", ltPos: j, opEnd: j + 3 };
	if (rest.startsWith("<<-")) return { op: "heredoc", ltPos: j, opEnd: j + 3 };
	if (rest.startsWith("<<")) return { op: "heredoc", ltPos: j, opEnd: j + 2 };
	if (rest.startsWith("<&")) return { op: "dup", ltPos: j, opEnd: j + 2 };
	// Bare `>&word` (no leading fd) redirects stdout+stderr to a file when `word` is not an fd/dash.
	if (rest.startsWith(">&")) {
		return { op: j === start ? "dup_or_file" : "dup", ltPos: j, opEnd: j + 2 };
	}
	if (rest.startsWith("<>") || rest.startsWith(">>") || rest.startsWith(">|")) {
		return { op: "file", ltPos: j, opEnd: j + 2 };
	}
	return { op: "file", ltPos: j, opEnd: j + 1 };
}

function lexCommand(text: string, cmd: boolean): CmdToken[] {
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
		if (!cmd && ch === "\\" && text[i + 1] === "\n") {
			tokens.push({ kind: "space", raw: "\\\n" });
			i += 2;
			continue;
		}
		if (!cmd && ch === "#") {
			const nl = text.indexOf("\n", i + 1);
			const end = nl < 0 ? text.length : nl;
			tokens.push({ kind: "space", raw: text.slice(i, end) });
			i = end;
			continue;
		}
		const redir = unquotedRedirAt(text, i, true);
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

interface ArgWord {
	raw: string;
	value: string;
	quoted: boolean;
}

interface SegmentPlan {
	keep: boolean[];
	envSplits: Map<number, ShellEnvSplitPlan>;
}

/**
 * Classify one simple command's non-redirect words by skipping shell keywords,
 * Bash's `time [-p] [--]` prefix, and leading `NAME=val` / `NAME+=val`
 * assignments, then delegating to the embedded shell's shared classifier.
 */
function classifyArgs(args: ArgWord[]): SegmentPlan {
	const keep = args.map(() => false);
	const envSplits = new Map<number, ShellEnvSplitPlan>();
	let start = 0;
	while (start < args.length) {
		const word = args[start];
		if (!word.quoted && SHELL_KEYWORDS.has(word.value)) {
			start++;
			continue;
		}
		if (!word.quoted && word.value === "time") {
			let next = start + 1;
			if (next < args.length && !args[next].quoted && args[next].value === "-p") next++;
			if (next < args.length && !args[next].quoted && args[next].value === "--") next++;
			// Leave `time -o file …` / `time -f fmt …` for the launcher table to parse.
			if (next >= args.length || args[next].quoted || !args[next].value.startsWith("-")) {
				start = next;
				continue;
			}
		}
		break;
	}
	const leadAssigns: number[] = [];
	const leadEnv: Record<string, string> = {};
	let hasLeadEnv = false;
	while (start < args.length && SHELL_ASSIGN_RE.test(args[start].raw)) {
		leadAssigns.push(start);
		const raw = args[start].raw;
		const val = args[start].value;
		const eq = val.indexOf("=");
		if (eq > 0 && val[eq - 1] !== "+" && !/[$`]/.test(raw)) {
			leadEnv[val.slice(0, eq)] = val.slice(eq + 1);
			hasLeadEnv = true;
		}
		start++;
	}
	if (start >= args.length) return { keep, envSplits };
	const argv = args.slice(start).map(word => word.value);
	const plan = classifyShellUrlArgs(argv, hasLeadEnv ? leadEnv : undefined);
	if (plan.keepEnv) {
		for (const idx of leadAssigns) keep[idx] = true;
	}
	for (let i = 0; i < plan.keep.length; i++) {
		if (plan.keep[i]) keep[start + i] = true;
	}
	for (const split of plan.envSplits) {
		envSplits.set(start + split.index, split);
	}
	return { keep, envSplits };
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
		const parts = partitionHeredocs(command, this.#cmd);
		if (!parts.some(part => part.kind === "body")) {
			return this.#code(command, 0);
		}
		// Mask here-document bodies with unique placeholders so a here-document inside `$(…)`
		// or `<<<"$(…)"` keeps its surrounding quotes and parentheses balanced across `#code`.
		let prefix = "\0OMPHD";
		while (command.includes(prefix)) prefix += "_";
		const replacements: Array<{ marker: string; body: string }> = [];
		let masked = "";
		for (const part of parts) {
			if (part.kind === "code") {
				masked += part.text;
			} else {
				const tail = part.text.endsWith("\n") ? "\n" : "";
				const marker = `${prefix}${replacements.length}\0${tail}`;
				replacements.push({ marker, body: part.text });
				masked += marker;
			}
		}
		let rewritten = await this.#code(masked, 0);
		for (const { marker, body } of replacements) {
			const at = rewritten.indexOf(marker);
			if (at >= 0) {
				rewritten = rewritten.slice(0, at) + body + rewritten.slice(at + marker.length);
			}
		}
		return rewritten;
	}

	/** Command text without here-document bodies, simple command by simple command. */
	async #code(text: string, layers: number): Promise<string> {
		if (!text.includes("://")) return text;
		const tokens = lexCommand(text, this.#cmd);
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
		const { keep, envSplits } = classifyArgs(argWords);
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
			out += await this.#emitWord(tok.raw, tok.value, keep[argIdx], envSplits.get(argIdx), layers);
		}
		return out;
	}

	async #redirTarget(op: RedirOp, raw: string, value: string, layers: number): Promise<string> {
		if (op === "heredoc") return raw;
		if ((raw.includes("$(") || raw.includes("`")) && raw.includes("://")) {
			return this.#expansions(raw, layers);
		}
		if (op === "file") return this.#word(raw, value, layers);
		if (op === "dup_or_file") {
			return FD_TARGET_RE.test(value) ? raw : this.#word(raw, value, layers);
		}
		return raw;
	}

	async #emitWord(
		raw: string,
		value: string,
		keep: boolean,
		envSplit: ShellEnvSplitPlan | undefined,
		layers: number,
	): Promise<string> {
		if ((raw.includes("$(") || raw.includes("`")) && raw.includes("://")) {
			return this.#expansions(raw, layers);
		}
		if (envSplit !== undefined) {
			return (await this.#resolveEnvSplit(envSplit, layers)) ?? raw;
		}
		if (keep || !value.includes("://")) return raw;
		return this.#word(raw, value, layers);
	}

	async #resolveEnvSplit(plan: ShellEnvSplitPlan, layers: number): Promise<string | undefined> {
		let out = plan.prefix;
		let cursor = 0;
		let changed = false;
		for (const word of plan.words) {
			if (word.keep || !word.text.includes("://")) continue;
			const resolved = await this.#resolveArgValue(word.text);
			if (resolved !== undefined) {
				out += plan.raw.slice(cursor, word.start);
				out += quoteEnvSWord(resolved);
				cursor = word.end;
				changed = true;
			}
		}
		if (!changed) return undefined;
		out += plan.raw.slice(cursor);
		return escapeLayers(quoteWord(out, this.#cmd), layers);
	}

	async #resolveArgValue(value: string): Promise<string | undefined> {
		const at = urlStart(value);
		if (at === undefined) return undefined;
		const url = value.slice(at);
		if (namesNothing(url)) return undefined;
		const host = await this.#host(url);
		if (host === undefined) return undefined;
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return undefined;
		return value.slice(0, at) + host;
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
