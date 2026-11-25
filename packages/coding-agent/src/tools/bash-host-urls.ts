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
/** Whether `word` is an unquoted shell variable assignment (`NAME=...` or `NAME+=...`). */
const SHELL_ASSIGNMENT_RAW = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ENV_ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WORD_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const GLOB_RUN = /([*?[\]{}]+)/;

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

function wrapperBase(word: string, cmd: boolean): string {
	let name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
	if (cmd && name.toLowerCase().endsWith(".exe")) name = name.slice(0, -4);
	return name;
}

const WRAPPERS = new Set([
	"env",
	"sudo",
	"doas",
	"nice",
	"ionice",
	"nohup",
	"setsid",
	"time",
	"gtime",
	"timeout",
	"gtimeout",
	"stdbuf",
	"chrt",
	"command",
	"exec",
	"xargs",
	"ifne",
	"npx",
	"npm",
	"bunx",
	"bun",
	"pnpx",
	"pnpm",
	"yarn",
	"uv",
	"ssh",
	"find",
]);

const PREFIX_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{", "coproc"]);

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * `lead` and the file `host` that `url` resolved to, as one shell word. With `live`, the URL was
 * written unquoted: a pattern in its last segments (`local://logs/*.txt`) is still the shell's to expand.
 */
function spellWord(lead: string, host: string, url: string, cmd: boolean, live: boolean): string {
	const glob = live ? url.search(/[*?[\]{}]/) : -1;
	const pattern = glob < 0 ? "" : url.slice(url.lastIndexOf("/", glob) + 1);
	if (pattern === "" || !host.endsWith(pattern)) return quoteWord(lead + host, cmd);
	const spelled = pattern
		.split(GLOB_RUN)
		.map((part, index) => (index % 2 === 1 ? part : quoteWord(part, cmd)))
		.join("");
	return quoteWord(lead + host.slice(0, host.length - pattern.length), cmd) + spelled;
}

/** The end of the `$(` substitution opened just before `start` in `text`: the index of its `)`, or -1. */
function substitutionEnd(text: string, start: number): number {
	type Frame = { kind: "paren" | "case-head" | "case-pat" | "case-body"; quote: string };
	const frames: Frame[] = [{ kind: "paren", quote: "" }];
	let word = "";
	let quoted = false;
	let cmdPos = true;

	const finishWord = (nextCmdPos?: boolean) => {
		if (word.length > 0 && !quoted) {
			const top = frames[frames.length - 1];
			if (word === "case" && cmdPos) {
				frames.push({ kind: "case-head", quote: "" });
				cmdPos = false;
			} else if (top.kind === "case-head" && word === "in") {
				top.kind = "case-pat";
				cmdPos = false;
			} else if ((top.kind === "case-body" || top.kind === "case-pat") && word === "esac" && cmdPos) {
				frames.pop();
				cmdPos = false;
			} else if (nextCmdPos !== undefined) {
				cmdPos = nextCmdPos;
			} else {
				cmdPos = false;
			}
		} else if (nextCmdPos !== undefined) {
			cmdPos = nextCmdPos;
		} else if (word.length > 0 || quoted) {
			cmdPos = false;
		}
		word = "";
		quoted = false;
	};

	for (let i = start; i < text.length; i++) {
		const top = frames[frames.length - 1];
		const ch = text[i];
		if (top.quote === "'") {
			if (ch === "'") top.quote = "";
			continue;
		}
		if (top.quote === '"') {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') {
				top.quote = "";
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
				frames.push({ kind: "paren", quote: "" });
				i++;
				cmdPos = true;
			}
			continue;
		}
		if (ch === "\\") {
			quoted = true;
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quoted = true;
			top.quote = ch;
			continue;
		}
		if (ch === "#" && word.length === 0 && !quoted) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			finishWord(cmdPos && word.length === 0 && !quoted ? cmdPos : false);
			continue;
		}
		if (ch === "\n" || ch === "&" || ch === "|") {
			finishWord(true);
			continue;
		}
		if (ch === ";") {
			if (text[i + 1] === ";") {
				finishWord(true);
				const cur = frames[frames.length - 1];
				if (cur.kind === "case-body") cur.kind = "case-pat";
				i++;
				if (text[i + 1] === "&") i++;
			} else if (text[i + 1] === "&") {
				finishWord(true);
				const cur = frames[frames.length - 1];
				if (cur.kind === "case-body") cur.kind = "case-pat";
				i++;
			} else {
				finishWord(true);
			}
			continue;
		}
		if (ch === "(") {
			if (word === "$" && !quoted) {
				word = "";
				frames.push({ kind: "paren", quote: "" });
				cmdPos = true;
			} else if (frames[frames.length - 1].kind === "case-pat" && word.length === 0 && !quoted) {
				// Optional `(` before a case pattern.
			} else {
				finishWord(true);
				frames.push({ kind: "paren", quote: "" });
			}
			continue;
		}
		if (ch === ")") {
			finishWord(true);
			const cur = frames[frames.length - 1];
			if (cur.kind === "case-pat") {
				cur.kind = "case-body";
				cmdPos = true;
				continue;
			}
			if (cur.kind === "paren") {
				frames.pop();
				if (frames.length === 0) return i;
			}
			continue;
		}
		word += ch;
	}
	return -1;
}

type SepToken = {
	kind: "sep";
	raw: string;
	boundary: boolean;
	opener?: "(" | "$(" | "<(" | ">(";
	closer?: boolean;
};

type RedirOpToken = {
	kind: "redir-op";
	raw: string;
	target: "file" | "heredoc" | "herestring" | "dup";
};

type WordToken = {
	kind: "word";
	raw: string;
	value: string;
	quoted: boolean;
};

type LexToken = SepToken | RedirOpToken | WordToken;

function lexCodeTokens(text: string, cmd: boolean): LexToken[] {
	const tokens: LexToken[] = [];
	let wordStart = -1;
	let value = "";
	let quoted = false;
	let lastUnquotedDollar = false;
	let inSingle = false;
	let inDouble = false;

	const endWord = (end: number) => {
		if (wordStart < 0) return;
		tokens.push({ kind: "word", raw: text.slice(wordStart, end), value, quoted });
		wordStart = -1;
		value = "";
		quoted = false;
		lastUnquotedDollar = false;
	};

	const pushSep = (raw: string, boundary: boolean, opener?: SepToken["opener"], closer?: boolean) => {
		if (!boundary && !opener && !closer) {
			const prev = tokens[tokens.length - 1];
			if (prev?.kind === "sep" && !prev.boundary && !prev.opener && !prev.closer) {
				prev.raw += raw;
				return;
			}
		}
		tokens.push({ kind: "sep", raw, boundary, opener, closer });
	};

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else value += ch;
			continue;
		}
		if (inDouble) {
			if (!cmd && ch === "\\" && i + 1 < text.length) {
				const next = text[i + 1];
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') inDouble = false;
			else value += ch;
			continue;
		}
		if (ch === " " || ch === "\t") {
			endWord(i);
			let j = i + 1;
			while (j < text.length && (text[j] === " " || text[j] === "\t")) j++;
			pushSep(text.slice(i, j), false);
			i = j - 1;
			continue;
		}
		if (!cmd && ch === "#" && wordStart < 0) {
			let j = i + 1;
			while (j < text.length && text[j] !== "\n") j++;
			pushSep(text.slice(i, j), false);
			i = j - 1;
			continue;
		}
		if (ch === "\n") {
			endWord(i);
			pushSep("\n", true);
			continue;
		}
		if (ch === ";") {
			endWord(i);
			if (text[i + 1] === ";") {
				const len = text[i + 2] === "&" ? 3 : 2;
				pushSep(text.slice(i, i + len), true);
				i += len - 1;
			} else if (text[i + 1] === "&") {
				pushSep(";&", true);
				i++;
			} else {
				pushSep(";", true);
			}
			continue;
		}
		if (ch === "|") {
			endWord(i);
			if (text[i + 1] === "|" || (!cmd && text[i + 1] === "&")) {
				pushSep(text.slice(i, i + 2), true);
				i++;
			} else {
				pushSep("|", true);
			}
			continue;
		}
		if (ch === "&") {
			endWord(i);
			if (text[i + 1] === "&") {
				pushSep("&&", true);
				i++;
			} else if (!cmd && text[i + 1] === ">") {
				const len = text[i + 2] === ">" ? 3 : 2;
				tokens.push({ kind: "redir-op", raw: text.slice(i, i + len), target: "file" });
				i += len - 1;
			} else {
				pushSep("&", true);
			}
			continue;
		}
		if (ch === "(") {
			if (wordStart >= 0 && lastUnquotedDollar) {
				const prefixRaw = text.slice(wordStart, i);
				if (prefixRaw === "$") {
					wordStart = -1;
					value = "";
					quoted = false;
					lastUnquotedDollar = false;
					pushSep("$(", true, "$(");
					continue;
				}
				endWord(i);
				pushSep("(", true, "$(");
				continue;
			}
			const prev = tokens[tokens.length - 1];
			if (wordStart < 0 && !cmd && prev?.kind === "redir-op" && (prev.raw === "<" || prev.raw === ">")) {
				tokens.pop();
				pushSep(`${prev.raw}(`, true, prev.raw === "<" ? "<(" : ">(");
				continue;
			}
			endWord(i);
			pushSep("(", true, "(");
			continue;
		}
		if (ch === ")") {
			endWord(i);
			pushSep(")", true, undefined, true);
			continue;
		}
		if (ch === "<" || ch === ">") {
			let fdPrefix = "";
			if (wordStart >= 0) {
				const rawSoFar = text.slice(wordStart, i);
				if (!quoted && /^\d+$/.test(rawSoFar)) {
					fdPrefix = rawSoFar;
					wordStart = -1;
					value = "";
					lastUnquotedDollar = false;
				} else {
					endWord(i);
				}
			}
			if (!cmd && text.startsWith("<<<", i)) {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}<<<`, target: "herestring" });
				i += 2;
			} else if (!cmd && text.startsWith("<<-", i)) {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}<<-`, target: "heredoc" });
				i += 2;
			} else if (!cmd && text.startsWith("<<", i)) {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}<<`, target: "heredoc" });
				i += 1;
			} else if (text.startsWith(">&", i) || text.startsWith("<&", i)) {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}${text.slice(i, i + 2)}`, target: "dup" });
				i += 1;
			} else if (text.startsWith(">>", i) || text.startsWith("<>", i) || (!cmd && text.startsWith(">|", i))) {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}${text.slice(i, i + 2)}`, target: "file" });
				i += 1;
			} else {
				tokens.push({ kind: "redir-op", raw: `${fdPrefix}${ch}`, target: "file" });
			}
			continue;
		}
		if (wordStart < 0) wordStart = i;
		if (!cmd && ch === "'") {
			inSingle = true;
			quoted = true;
			lastUnquotedDollar = false;
		} else if (ch === '"') {
			inDouble = true;
			quoted = true;
			lastUnquotedDollar = false;
		} else if (!cmd && ch === "\\" && i + 1 < text.length) {
			if (text[i + 1] !== "\n") {
				value += text[i + 1];
				quoted = true;
			}
			lastUnquotedDollar = false;
			i++;
		} else {
			value += ch;
			lastUnquotedDollar = ch === "$";
		}
	}
	endWord(text.length);
	return tokens;
}

type TreeNode =
	| LexToken
	| {
			kind: "group";
			opener: SepToken;
			inner: TreeNode[];
			closer?: SepToken;
	  };

function buildTokenTree(tokens: LexToken[]): TreeNode[] {
	const root: TreeNode[] = [];
	const stack: { opener: SepToken; inner: TreeNode[] }[] = [];
	const current = () => (stack.length > 0 ? stack[stack.length - 1].inner : root);
	for (const token of tokens) {
		if (token.kind === "sep" && token.opener) {
			stack.push({ opener: token, inner: [] });
			continue;
		}
		if (token.kind === "sep" && token.closer && stack.length > 0) {
			const frame = stack.pop()!;
			current().push({ kind: "group", opener: frame.opener, inner: frame.inner, closer: token });
			continue;
		}
		current().push(token);
	}
	while (stack.length > 0) {
		const frame = stack.pop()!;
		current().push({ kind: "group", opener: frame.opener, inner: frame.inner });
	}
	return root;
}

function splitEnvS(input: string): string[] | undefined {
	const args: string[] = [];
	let dq = false;
	let sq = false;
	let sep = true;
	const pushChar = (ch: string) => {
		if (sep) {
			sep = false;
			args.push("");
		}
		args[args.length - 1] += ch;
	};
	const startEmpty = () => {
		if (sep) {
			sep = false;
			args.push("");
		}
	};
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (ch === "'" && !dq) {
			sq = !sq;
			startEmpty();
			continue;
		}
		if (ch === '"' && !sq) {
			dq = !dq;
			startEmpty();
			continue;
		}
		if (!sq && !dq && /[ \t\n\x0b\x0c\r]/.test(ch)) {
			sep = true;
			while (i + 1 < input.length && /[ \t\n\x0b\x0c\r]/.test(input[i + 1])) i++;
			continue;
		}
		if (ch === "#" && sep) return args;
		if (ch === "\\" && !(sq && input[i + 1] !== "\\" && input[i + 1] !== "'")) {
			if (i + 1 >= input.length) return undefined;
			const esc = input[++i];
			if (esc === '"' || esc === "#" || esc === "$" || esc === "'" || esc === "\\") {
				pushChar(esc);
			} else if (esc === "_") {
				if (!dq) sep = true;
				else pushChar(" ");
			} else if (esc === "c") {
				if (dq) return undefined;
				return args;
			} else if (esc === "f") {
				pushChar("\x0c");
			} else if (esc === "n") {
				pushChar("\n");
			} else if (esc === "r") {
				pushChar("\r");
			} else if (esc === "t") {
				pushChar("\t");
			} else if (esc === "v") {
				pushChar("\x0b");
			} else {
				return undefined;
			}
			continue;
		}
		pushChar(ch);
	}
	if (sq || dq) return undefined;
	return args;
}

function quoteEnvSWord(word: string): string {
	if (word.length > 0 && !/[ \t\n\x0b\x0c\r'"\\#$]/.test(word)) return word;
	return `'${word.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

type HeredocPending = { delimiter: string; tabs: boolean };

type HeredocScanFrame = {
	kind: "paren" | "subst" | "arith";
	quote: string;
	arithParens: number;
};

function readHeredocDelimiter(line: string, start: number): { delimiter: string; nextIndex: number } | undefined {
	let i = start;
	while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
	if (i >= line.length) return undefined;
	let delim = "";
	let hasChars = false;
	let quote = "";
	for (; i < line.length; i++) {
		const ch = line[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			else delim += ch;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === "\\")) {
				delim += line[++i];
			} else if (ch === '"') {
				quote = "";
			} else {
				delim += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasChars = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 < line.length) {
				delim += line[++i];
				hasChars = true;
			}
			continue;
		}
		if (/[ \t;&|()<>]/.test(ch)) break;
		delim += ch;
		hasChars = true;
	}
	return hasChars ? { delimiter: delim, nextIndex: i } : undefined;
}

function scanLineHeredocs(line: string, stack: HeredocScanFrame[], pending: HeredocPending[]): void {
	let wordStart = true;
	for (let i = 0; i < line.length; i++) {
		const top = stack[stack.length - 1];
		const ch = line[i];
		if (top.quote === "'") {
			if (ch === "'") top.quote = "";
			continue;
		}
		if (top.quote === '"') {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"') {
				top.quote = "";
				continue;
			}
			if (ch === "$" && line[i + 1] === "(") {
				if (line[i + 2] === "(") {
					stack.push({ kind: "arith", quote: "", arithParens: 0 });
					i += 2;
				} else {
					stack.push({ kind: "subst", quote: "", arithParens: 0 });
					i += 1;
					wordStart = true;
				}
			}
			continue;
		}
		if (top.kind === "arith") {
			if (ch === "\\") {
				i++;
			} else if (ch === "'" || ch === '"') {
				top.quote = ch;
			} else if (ch === "(") {
				top.arithParens++;
			} else if (ch === ")") {
				if (top.arithParens > 0) top.arithParens--;
				else if (line[i + 1] === ")") {
					stack.pop();
					i++;
					wordStart = true;
				}
			}
			continue;
		}
		if (ch === "\\") {
			i++;
			wordStart = false;
			continue;
		}
		if (ch === "'" || ch === '"') {
			top.quote = ch;
			wordStart = false;
			continue;
		}
		if (ch === "#" && wordStart) break;
		if (ch === " " || ch === "\t") {
			wordStart = true;
			continue;
		}
		if (ch === ";" || ch === "&" || ch === "|") {
			wordStart = true;
			continue;
		}
		if (ch === "$" && line[i + 1] === "(") {
			if (line[i + 2] === "(") {
				stack.push({ kind: "arith", quote: "", arithParens: 0 });
				i += 2;
			} else {
				stack.push({ kind: "subst", quote: "", arithParens: 0 });
				i += 1;
				wordStart = true;
			}
			continue;
		}
		if (ch === "(") {
			if (line[i + 1] === "(") {
				stack.push({ kind: "arith", quote: "", arithParens: 0 });
				i += 1;
			} else {
				stack.push({ kind: "paren", quote: "", arithParens: 0 });
				wordStart = true;
			}
			continue;
		}
		if (ch === ")") {
			if (stack.length > 1) stack.pop();
			wordStart = true;
			continue;
		}
		if (ch === "<" && line[i + 1] === "<") {
			if (line[i + 2] === "<") {
				i += 2;
				wordStart = false;
				continue;
			}
			const tabs = line[i + 2] === "-";
			const delimStart = i + (tabs ? 3 : 2);
			const parsed = readHeredocDelimiter(line, delimStart);
			if (parsed) {
				pending.push({ delimiter: parsed.delimiter, tabs });
				i = parsed.nextIndex - 1;
			} else {
				i = delimStart - 1;
			}
			wordStart = true;
			continue;
		}
		wordStart = false;
	}
}

type ArgRole = "literal" | "rewrite" | "env-s";

type SplitWordEntry = { kind: "word"; value: string; literal: boolean } | { kind: "child"; splitId: number };

type SplitContainer = {
	argIdx: number;
	rawPrefix: string;
	valuePrefix: string;
	items: SplitWordEntry[];
};

type PlanWord = {
	value: string;
	raw?: string;
	origin: { kind: "arg"; idx: number } | { kind: "split"; splitId: number; wordIdx: number };
};

interface CommandArg {
	nodes: TreeNode[];
	staticWord?: WordToken;
}

interface ArgAnalysis {
	roles: ArgRole[];
	splits: SplitContainer[];
	rootSplits: number[];
}
function skipOpts(
	words: PlanWord[],
	from: number,
	shortVals: string,
	longVals: ReadonlySet<string>,
	allowNumericShort = false,
): number {
	let i = from;
	while (i < words.length) {
		const w = words[i].value;
		if (w === "--") return i + 1;
		if (!w.startsWith("-") || w === "-") break;
		if (w.startsWith("--")) {
			if (w.includes("=")) {
				i++;
				continue;
			}
			i += longVals.has(w) ? 2 : 1;
			continue;
		}
		if (allowNumericShort && /^\d+$/.test(w.slice(1))) {
			i++;
			continue;
		}
		let consumed = false;
		for (let k = 1; k < w.length; k++) {
			if (shortVals.includes(w[k])) {
				i += k + 1 < w.length ? 1 : 2;
				consumed = true;
				break;
			}
		}
		if (!consumed) i++;
	}
	return Math.min(i, words.length);
}

function skipOptsFlag(
	words: PlanWord[],
	from: number,
	shortVals: string,
	longVals: ReadonlySet<string>,
	flagShorts: string,
	flagLongs: ReadonlySet<string>,
): { next: number; flagged: boolean } {
	let i = from;
	let flagged = false;
	while (i < words.length) {
		const w = words[i].value;
		if (w === "--") return { next: i + 1, flagged };
		if (!w.startsWith("-") || w === "-") break;
		if (w.startsWith("--")) {
			const eq = w.indexOf("=");
			const optName = eq >= 0 ? w.slice(0, eq) : w;
			if (flagLongs.has(optName)) flagged = true;
			if (eq >= 0) {
				i++;
				continue;
			}
			i += longVals.has(w) ? 2 : 1;
			continue;
		}
		let consumed = false;
		for (let k = 1; k < w.length; k++) {
			if (flagShorts.includes(w[k])) flagged = true;
			if (shortVals.includes(w[k])) {
				i += k + 1 < w.length ? 1 : 2;
				consumed = true;
				break;
			}
		}
		if (!consumed) i++;
	}
	return { next: Math.min(i, words.length), flagged };
}

const SUDO_LONG_VALS = new Set([
	"--user",
	"--group",
	"--close-from",
	"--chdir",
	"--host",
	"--prompt",
	"--chroot",
	"--role",
	"--command-timeout",
	"--type",
	"--other-user",
]);
const IONICE_LONG_VALS = new Set(["--class", "--classdata", "--pid", "--pgid", "--uid"]);
const IONICE_PID_LONGS = new Set(["--pid", "--pgid", "--uid"]);
const TIME_LONG_VALS = new Set(["--output", "--format"]);
const TIMEOUT_LONG_VALS = new Set(["--signal", "--kill-after"]);
const STDBUF_LONG_VALS = new Set(["--input", "--output", "--error"]);
const XARGS_LONG_VALS = new Set([
	"--arg-file",
	"--delimiter",
	"--max-args",
	"--max-procs",
	"--max-chars",
	"--process-slot-var",
]);
const NPX_LONG_VALS = new Set([
	"--package",
	"--call",
	"--cache",
	"--userconfig",
	"--prefix",
	"--loglevel",
	"--workspace",
	"--shell",
	"--registry",
	"--node-options",
]);
const NPM_GLOBAL_LONG_VALS = new Set([
	"--prefix",
	"--cache",
	"--userconfig",
	"--globalconfig",
	"--loglevel",
	"--workspace",
	"--registry",
	"--shell",
	"--script-shell",
	"--node-options",
]);
const NPM_EXEC_LONG_VALS = new Set([...NPM_GLOBAL_LONG_VALS, "--package", "--call"]);
const BUNX_LONG_VALS = new Set(["--package", "--shell", "--registry", "--minimum-release-age", "--cwd", "--config"]);
const BUN_GLOBAL_LONG_VALS = new Set(["--cwd", "--config", "--env-file", "--preload"]);
const PNPM_GLOBAL_LONG_VALS = new Set(["--dir", "--filter", "--loglevel", "--registry", "--store-dir"]);
const PNPM_EXEC_LONG_VALS = new Set([...PNPM_GLOBAL_LONG_VALS, "--package"]);
const UV_GLOBAL_LONG_VALS = new Set([
	"--directory",
	"--project",
	"--config-file",
	"--cache-dir",
	"--color",
	"--python-preference",
	"--python-fetch",
]);
const UV_RUN_LONG_VALS = new Set([
	...UV_GLOBAL_LONG_VALS,
	"--with",
	"--with-editable",
	"--with-requirements",
	"--python",
	"--package",
	"--env-file",
	"--extra",
	"--group",
	"--only-group",
	"--no-group",
	"--index",
	"--default-index",
	"--index-url",
	"--extra-index-url",
	"--find-links",
	"--refresh-package",
	"--reinstall-package",
	"--upgrade-package",
	"--resolution",
	"--prerelease",
	"--index-strategy",
	"--keyring-provider",
	"--link-mode",
	"--exclude-newer",
	"--max-concurrent-downloads",
	"--max-concurrent-builds",
	"--max-concurrent-installs",
	"--module",
	"--script",
	"--gui-script",
]);
const UV_NON_CMD_LONGS = new Set(["--module", "--script", "--gui-script"]);
const ENV_LONG_VALS = new Set(["--unset", "--chdir", "--argv0", "--env0-from"]);
const CALL_LONG = new Set(["--call"]);

function isShellAssignmentWord(word: PlanWord): boolean {
	if (word.raw !== undefined) return SHELL_ASSIGNMENT_RAW.test(word.raw);
	const eq = word.value.indexOf("=");
	if (eq <= 0) return false;
	const name = word.value[eq - 1] === "+" ? word.value.slice(0, eq - 1) : word.value.slice(0, eq);
	return ENV_ASSIGNMENT_NAME.test(name);
}

function analyzeCommandArgs(args: CommandArg[], cmd: boolean): ArgAnalysis {
	const roles: ArgRole[] = Array.from<ArgRole>({ length: args.length }).fill("rewrite");
	const splits: SplitContainer[] = [];
	const rootSplits: number[] = [];

	const markLiteral = (origin: PlanWord["origin"]) => {
		if (origin.kind === "arg") {
			roles[origin.idx] = "literal";
		} else {
			const entry = splits[origin.splitId]?.items[origin.wordIdx];
			if (entry?.kind === "word") entry.literal = true;
		}
	};

	const spliceEnvSplit = (
		words: PlanWord[],
		at: number,
		removeCount: number,
		targetOrigin: PlanWord["origin"],
		rawPrefix: string,
		valuePrefix: string,
		rawVal: string,
	): boolean => {
		const parts = splitEnvS(rawVal);
		if (!parts) return false;
		const splitId = splits.length;
		let argIdx = -1;
		if (targetOrigin.kind === "arg") {
			argIdx = targetOrigin.idx;
			roles[argIdx] = "env-s";
			rootSplits.push(splitId);
		} else {
			const parent = splits[targetOrigin.splitId];
			if (parent) {
				argIdx = parent.argIdx;
				parent.items[targetOrigin.wordIdx] = { kind: "child", splitId };
			}
		}
		splits.push({
			argIdx,
			rawPrefix,
			valuePrefix,
			items: parts.map(value => ({ kind: "word", value, literal: false })),
		});
		const replacement: PlanWord[] = parts.map((value, wordIdx) => ({
			value,
			origin: { kind: "split", splitId, wordIdx },
		}));
		words.splice(at, removeCount, ...replacement);
		return true;
	};

	const advanceEnv = (words: PlanWord[], start: number, inherited: PlanWord["origin"][]): number => {
		let i = start;
		while (i < words.length) {
			const w = words[i].value;
			if (w === "--") {
				i++;
				break;
			}
			if (!w.startsWith("-") || w === "-") break;
			if (w.startsWith("--")) {
				if (w.startsWith("--split-string=")) {
					const val = w.slice("--split-string=".length);
					if (spliceEnvSplit(words, i, 1, words[i].origin, "--split-string=", "--split-string=", val)) {
						continue;
					}
					i++;
					continue;
				}
				if (w === "--split-string") {
					const next = words[i + 1];
					if (next && spliceEnvSplit(words, i, 2, next.origin, "", "", next.value)) {
						continue;
					}
					i = Math.min(i + 2, words.length);
					continue;
				}
				if (w.includes("=")) {
					i++;
					continue;
				}
				i += ENV_LONG_VALS.has(w) ? 2 : 1;
				continue;
			}
			let consumed = false;
			let spliced = false;
			for (let k = 1; k < w.length; k++) {
				if (w[k] === "S") {
					if (k + 1 < w.length) {
						const prefix = w.slice(0, k + 1);
						const val = w.slice(k + 1);
						if (spliceEnvSplit(words, i, 1, words[i].origin, prefix, prefix, val)) {
							spliced = true;
							break;
						}
						consumed = true;
						i++;
						break;
					}
					const next = words[i + 1];
					if (next && spliceEnvSplit(words, i, 2, next.origin, "", "", next.value)) {
						spliced = true;
						break;
					}
					consumed = true;
					i = Math.min(i + 2, words.length);
					break;
				}
				if ("uCaP".includes(w[k])) {
					i = Math.min(i + (k + 1 < w.length ? 1 : 2), words.length);
					consumed = true;
					break;
				}
			}
			if (!consumed && !spliced) i++;
		}
		if (words[i]?.value === "-") i++;
		while (i < words.length && words[i].value.includes("=")) {
			inherited.push(words[i].origin);
			i++;
		}
		return i;
	};

	const walk = (words: PlanWord[], startIdx: number, inherited: PlanWord["origin"][], allowUrlExec: boolean): void => {
		let idx = startIdx;
		while (idx < words.length) {
			const cur = words[idx];
			if (isOmp(cur.value)) {
				if (!allowUrlExec || !URL_ROOT.test(cur.value)) {
					markLiteral(cur.origin);
				}
				for (let j = idx + 1; j < words.length; j++) markLiteral(words[j].origin);
				for (const origin of inherited) markLiteral(origin);
				return;
			}
			const base = wrapperBase(cur.value, cmd);
			if (!WRAPPERS.has(base)) return;
			switch (base) {
				case "env":
					idx = advanceEnv(words, idx + 1, inherited);
					break;
				case "sudo": {
					let i = skipOpts(words, idx + 1, "ugCDhRrTtUac", SUDO_LONG_VALS);
					while (i < words.length && isShellAssignmentWord(words[i])) {
						inherited.push(words[i].origin);
						i++;
					}
					idx = i;
					break;
				}
				case "doas": {
					let i = skipOpts(words, idx + 1, "Cu", new Set());
					while (i < words.length && isShellAssignmentWord(words[i])) {
						inherited.push(words[i].origin);
						i++;
					}
					idx = i;
					break;
				}
				case "nice":
					idx = skipOpts(words, idx + 1, "n", new Set(["--adjustment"]), true);
					break;
				case "ionice": {
					const { next, flagged } = skipOptsFlag(
						words,
						idx + 1,
						"cnpPu",
						IONICE_LONG_VALS,
						"pPu",
						IONICE_PID_LONGS,
					);
					if (flagged) return;
					idx = next;
					break;
				}
				case "nohup":
				case "setsid":
				case "ifne":
					idx = skipOpts(words, idx + 1, "", new Set());
					break;
				case "time":
				case "gtime": {
					let i = skipOpts(words, idx + 1, "of", TIME_LONG_VALS);
					while (!cmd && i < words.length && isShellAssignmentWord(words[i])) {
						inherited.push(words[i].origin);
						i++;
					}
					idx = i;
					break;
				}
				case "timeout":
				case "gtimeout": {
					const i = skipOpts(words, idx + 1, "sk", TIMEOUT_LONG_VALS);
					idx = Math.min(i + 1, words.length);
					break;
				}
				case "stdbuf":
					idx = skipOpts(words, idx + 1, "ioe", STDBUF_LONG_VALS);
					break;
				case "chrt": {
					const { next, flagged } = skipOptsFlag(words, idx + 1, "", new Set(), "p", new Set(["--pid"]));
					if (flagged) return;
					idx = Math.min(next + 1, words.length);
					break;
				}
				case "command": {
					const { next, flagged } = skipOptsFlag(words, idx + 1, "", new Set(), "vV", new Set());
					if (flagged) return;
					idx = next;
					break;
				}
				case "exec":
					idx = skipOpts(words, idx + 1, "a", new Set());
					break;
				case "xargs":
					idx = skipOpts(words, idx + 1, "adEILnPs", XARGS_LONG_VALS);
					break;
				case "npx": {
					const { next, flagged } = skipOptsFlag(words, idx + 1, "pcw", NPX_LONG_VALS, "c", CALL_LONG);
					if (flagged) return;
					idx = next;
					break;
				}
				case "npm": {
					const i = skipOpts(words, idx + 1, "Cw", NPM_GLOBAL_LONG_VALS);
					const sub = words[i]?.value;
					if (sub !== "exec" && sub !== "x") return;
					const { next, flagged } = skipOptsFlag(words, i + 1, "Cwc", NPM_EXEC_LONG_VALS, "c", CALL_LONG);
					if (flagged) return;
					idx = next;
					break;
				}
				case "bunx": {
					const { next, flagged } = skipOptsFlag(words, idx + 1, "pc", BUNX_LONG_VALS, "c", new Set());
					if (flagged) return;
					idx = next;
					break;
				}
				case "bun": {
					const i = skipOpts(words, idx + 1, "cr", BUN_GLOBAL_LONG_VALS);
					if (words[i]?.value !== "x") return;
					const { next, flagged } = skipOptsFlag(words, i + 1, "pc", BUNX_LONG_VALS, "c", new Set());
					if (flagged) return;
					idx = next;
					break;
				}
				case "pnpx": {
					const { next, flagged } = skipOptsFlag(words, idx + 1, "cC", PNPM_EXEC_LONG_VALS, "c", new Set());
					if (flagged) return;
					idx = next;
					break;
				}
				case "pnpm": {
					const i = skipOpts(words, idx + 1, "C", PNPM_GLOBAL_LONG_VALS);
					const sub = words[i]?.value;
					if (sub !== "dlx" && sub !== "exec") return;
					const { next, flagged } = skipOptsFlag(words, i + 1, "cC", PNPM_EXEC_LONG_VALS, "c", new Set());
					if (flagged) return;
					idx = next;
					break;
				}
				case "yarn": {
					const i = skipOpts(words, idx + 1, "", new Set(["--cwd"]));
					const sub = words[i]?.value;
					if (sub !== "dlx" && sub !== "exec") return;
					idx = skipOpts(words, i + 1, "p", new Set(["--package", "--cwd"]));
					break;
				}
				case "uv": {
					const i = skipOpts(words, idx + 1, "C", UV_GLOBAL_LONG_VALS);
					if (words[i]?.value !== "run") return;
					const { next, flagged } = skipOptsFlag(words, i + 1, "wpifPCm", UV_RUN_LONG_VALS, "m", UV_NON_CMD_LONGS);
					if (flagged) return;
					idx = next;
					break;
				}
				case "ssh": {
					const i = skipOpts(words, idx + 1, "BbcDEeFIiJLlmOopQRSWw", new Set());
					if (i + 1 >= words.length) return;
					const remote = words.slice(i + 1);
					let segStart = 0;
					while (segStart < remote.length) {
						let segEnd = segStart;
						while (segEnd < remote.length && ![";", "|", "||", "&&", "&", "\n"].includes(remote[segEnd].value)) {
							segEnd++;
						}
						const seg: PlanWord[] = [];
						for (let r = segStart; r < segEnd; r++) {
							const rw = remote[r].value.replace(/^\d+/, "");
							if (["<", ">", ">>", ">|", "<>", "&>", "&>>", "<<", "<<-", "<<<"].includes(rw)) {
								r++;
								continue;
							}
							if (rw.length > 1 && (rw.startsWith(">") || rw.startsWith("<") || rw.startsWith("&>"))) {
								continue;
							}
							seg.push(remote[r]);
						}
						let c = 0;
						const remoteInherited: PlanWord["origin"][] = [];
						while (c < seg.length && isShellAssignmentWord(seg[c])) {
							remoteInherited.push(seg[c].origin);
							c++;
						}
						if (c < seg.length) walk(seg, c, remoteInherited, false);
						segStart = segEnd + 1;
					}
					return;
				}
				case "find": {
					for (let f = idx + 1; f < words.length; f++) {
						if (
							words[f].value === "-exec" ||
							words[f].value === "-execdir" ||
							words[f].value === "-ok" ||
							words[f].value === "-okdir"
						) {
							const actionStart = f + 1;
							let actionEnd = actionStart;
							while (
								actionEnd < words.length &&
								words[actionEnd].value !== ";" &&
								words[actionEnd].value !== "+"
							) {
								actionEnd++;
							}
							if (actionStart < actionEnd) {
								walk(words.slice(actionStart, actionEnd), 0, [], true);
							}
							f = actionEnd;
						}
					}
					return;
				}
				default:
					return;
			}
		}
	};

	const words: PlanWord[] = [];
	const inherited: PlanWord["origin"][] = [];
	let i = 0;
	if (!cmd) {
		while (i < args.length) {
			const st = args[i].staticWord;
			if (!st) break;
			if (!st.quoted && PREFIX_KEYWORDS.has(st.value)) {
				i++;
				continue;
			}
			if (SHELL_ASSIGNMENT_RAW.test(st.raw)) {
				inherited.push({ kind: "arg", idx: i });
				i++;
				continue;
			}
			break;
		}
	}
	for (let j = i; j < args.length; j++) {
		const st = args[j].staticWord;
		words.push({
			value: st ? st.value : "",
			raw: st?.raw,
			origin: { kind: "arg", idx: j },
		});
	}
	// Dynamic word (e.g. `$(echo omp)`) cannot be matched statically as `omp` or a wrapper.
	if (words.length > 0 && args[i].staticWord) {
		walk(words, 0, inherited, true);
	}
	return { roles, splits, rootSplits };
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
		if (this.#cmd) return this.#code(command);
		const out: string[] = [];
		const pending: HeredocPending[] = [];
		const stack: HeredocScanFrame[] = [{ kind: "paren", quote: "", arithParens: 0 }];
		let cmdLines: string[] = [];
		const bodies = new Map<number, string[]>();
		let activeBodyAfter: number | undefined;

		const flush = async () => {
			if (cmdLines.length === 0) return;
			const parts: { text: string; inputNewlines: boolean }[] = [];
			await this.#code(cmdLines.join("\n"), parts);
			if (bodies.size === 0) {
				out.push(parts.map(p => p.text).join(""));
			} else {
				let lineIdx = 0;
				let rebuilt = "";
				for (const part of parts) {
					if (!part.inputNewlines) {
						rebuilt += part.text;
						continue;
					}
					for (const ch of part.text) {
						rebuilt += ch;
						if (ch === "\n") {
							const attached = bodies.get(lineIdx);
							if (attached) rebuilt += `${attached.join("\n")}\n`;
							lineIdx++;
						}
					}
				}
				const tail = bodies.get(lineIdx);
				if (tail) rebuilt += `\n${tail.join("\n")}`;
				out.push(rebuilt);
				bodies.clear();
			}
			cmdLines = [];
		};

		for (const line of command.split("\n")) {
			const open = pending[0];
			if (open) {
				if (activeBodyAfter !== undefined) {
					let list = bodies.get(activeBodyAfter);
					if (!list) {
						list = [];
						bodies.set(activeBodyAfter, list);
					}
					list.push(line);
				} else {
					out.push(line);
				}
				if ((open.tabs ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
				if (pending.length === 0) activeBodyAfter = undefined;
				continue;
			}
			cmdLines.push(line);
			scanLineHeredocs(line, stack, pending);
			if (pending.length > 0) {
				if (stack.length === 1 && stack[0].quote === "") {
					activeBodyAfter = undefined;
					await flush();
				} else {
					activeBodyAfter = cmdLines.length - 1;
				}
			}
		}
		await flush();
		return out.join("\n");
	}

	/** Command text without here-document bodies. */
	async #code(text: string, sink?: { text: string; inputNewlines: boolean }[]): Promise<string> {
		if (!text.includes("://")) {
			sink?.push({ text, inputNewlines: true });
			return text;
		}
		const tree = buildTokenTree(lexCodeTokens(text, this.#cmd));
		const parts: { text: string; inputNewlines: boolean }[] = sink ?? [];
		await this.#evalTree(tree, parts);
		return sink ? "" : parts.map(p => p.text).join("");
	}

	async #evalTree(nodes: TreeNode[], parts: { text: string; inputNewlines: boolean }[]): Promise<void> {
		let segment: TreeNode[] = [];
		const flushSegment = async () => {
			if (segment.length === 0) return;
			await this.#evalSimpleCommand(segment, parts);
			segment = [];
		};
		for (const node of nodes) {
			if (node.kind === "group") {
				if (node.opener.opener === "(") {
					await flushSegment();
					parts.push({ text: node.opener.raw, inputNewlines: true });
					await this.#evalTree(node.inner, parts);
					if (node.closer) parts.push({ text: node.closer.raw, inputNewlines: true });
				} else {
					segment.push(node);
				}
				continue;
			}
			if (node.kind === "sep" && node.boundary) {
				await flushSegment();
				parts.push({ text: node.raw, inputNewlines: true });
				continue;
			}
			segment.push(node);
		}
		await flushSegment();
	}

	async #evalSimpleCommand(nodes: TreeNode[], parts: { text: string; inputNewlines: boolean }[]): Promise<void> {
		type ItemRole =
			| { kind: "sep"; node: SepToken }
			| { kind: "redir-op"; node: RedirOpToken }
			| { kind: "redir-target"; node: TreeNode; target: RedirOpToken["target"] }
			| { kind: "arg"; argIndex: number };

		const items: ItemRole[] = [];
		const args: CommandArg[] = [];

		let i = 0;
		while (i < nodes.length) {
			const cur = nodes[i];
			if (cur.kind === "sep") {
				items.push({ kind: "sep", node: cur });
				i++;
				continue;
			}
			if (cur.kind === "redir-op") {
				items.push({ kind: "redir-op", node: cur });
				i++;
				while (i < nodes.length && nodes[i].kind === "sep") {
					items.push({ kind: "sep", node: nodes[i] as SepToken });
					i++;
				}
				if (i < nodes.length) {
					items.push({ kind: "redir-target", node: nodes[i], target: cur.target });
					i++;
				}
				continue;
			}
			const argNodes: TreeNode[] = [];
			while (i < nodes.length && nodes[i].kind !== "sep" && nodes[i].kind !== "redir-op") {
				argNodes.push(nodes[i]);
				i++;
			}
			const staticWord = argNodes.length === 1 && argNodes[0].kind === "word" ? argNodes[0] : undefined;
			const argIndex = args.length;
			args.push({ nodes: argNodes, staticWord });
			items.push({ kind: "arg", argIndex });
		}

		const analysis = analyzeCommandArgs(args, this.#cmd);
		const resolvedSplits = new Map<number, string>();
		if (analysis.splits.length > 0) {
			for (let s = analysis.splits.length - 1; s >= 0; s--) {
				const container = analysis.splits[s];
				let changed = false;
				const rebuiltWords: string[] = [];
				for (const item of container.items) {
					if (item.kind === "word") {
						if (!item.literal && item.value.includes("://")) {
							const host = await this.#resolveSingleWord(item.value, item.value);
							if (host !== undefined) {
								changed = true;
								rebuiltWords.push(host);
								continue;
							}
						}
						rebuiltWords.push(item.value);
					} else {
						const childRebuilt = resolvedSplits.get(item.splitId);
						if (childRebuilt !== undefined) {
							changed = true;
							rebuiltWords.push(childRebuilt);
						} else {
							rebuiltWords.push(this.#joinSplitRaw(analysis.splits, item.splitId));
						}
					}
				}
				if (changed) {
					resolvedSplits.set(s, container.valuePrefix + rebuiltWords.map(quoteEnvSWord).join(" "));
				}
			}
		}

		for (const item of items) {
			if (item.kind === "sep" || item.kind === "redir-op") {
				parts.push({ text: item.node.raw, inputNewlines: true });
				continue;
			}
			if (item.kind === "redir-target") {
				if (item.node.kind === "group") {
					parts.push({ text: item.node.opener.raw, inputNewlines: true });
					await this.#evalTree(item.node.inner, parts);
					if (item.node.closer) parts.push({ text: item.node.closer.raw, inputNewlines: true });
				} else if (item.node.kind === "word") {
					if (item.target === "heredoc") {
						parts.push({ text: item.node.raw, inputNewlines: true });
					} else if (item.target === "file") {
						await this.#emitWord(item.node.raw, item.node.value, false, parts);
					} else {
						await this.#emitWord(item.node.raw, item.node.value, true, parts);
					}
				}
				continue;
			}
			const arg = args[item.argIndex];
			const role = analysis.roles[item.argIndex];
			if (role === "env-s" && arg.staticWord) {
				const splitId = analysis.rootSplits.find(id => analysis.splits[id].argIdx === item.argIndex);
				const rebuilt = splitId !== undefined ? resolvedSplits.get(splitId) : undefined;
				if (rebuilt !== undefined) {
					const container = analysis.splits[splitId!];
					const rawToken = arg.staticWord.raw;
					if (!/[$`]/.test(rawToken)) {
						const withoutValuePrefix = rebuilt.slice(container.valuePrefix.length);
						parts.push({
							text: container.rawPrefix + quoteWord(withoutValuePrefix, this.#cmd),
							inputNewlines: false,
						});
						continue;
					}
					const updated = await this.#rewriteEnvSWithExpansions(
						rawToken,
						container,
						analysis.splits,
						resolvedSplits,
					);
					parts.push({ text: updated, inputNewlines: false });
					continue;
				}
			}
			for (const node of arg.nodes) {
				if (node.kind === "group") {
					parts.push({ text: node.opener.raw, inputNewlines: true });
					await this.#evalTree(node.inner, parts);
					if (node.closer) parts.push({ text: node.closer.raw, inputNewlines: true });
				} else if (node.kind === "word") {
					await this.#emitWord(node.raw, node.value, role === "literal", parts);
				}
			}
		}
	}

	#joinSplitRaw(splits: SplitContainer[], splitId: number): string {
		const container = splits[splitId];
		const words = container.items.map(item =>
			item.kind === "word" ? quoteEnvSWord(item.value) : quoteEnvSWord(this.#joinSplitRaw(splits, item.splitId)),
		);
		return container.valuePrefix + words.join(" ");
	}

	async #rewriteEnvSWithExpansions(
		rawToken: string,
		container: SplitContainer,
		splits: SplitContainer[],
		resolvedSplits: Map<number, string>,
	): Promise<string> {
		let result = rawToken.includes("$(") ? await this.#substitutions(rawToken) : rawToken;
		for (const item of container.items) {
			let orig: string | undefined;
			let replacement: string | undefined;
			if (item.kind === "word" && !item.literal && item.value.includes("://") && !/[$`]/.test(item.value)) {
				const resolved = await this.#resolveSingleWord(item.value, item.value);
				if (resolved !== undefined) {
					orig = item.value;
					replacement = resolved;
				}
			} else if (item.kind === "child") {
				const childRebuilt = resolvedSplits.get(item.splitId);
				if (childRebuilt !== undefined) {
					orig = this.#joinSplitRaw(splits, item.splitId);
					replacement = childRebuilt;
				}
			}
			if (orig !== undefined && replacement !== undefined) {
				const quoted = WORD_SAFE.test(replacement)
					? replacement
					: `'${replacement.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
				result = result.replaceAll(orig, quoted);
			}
		}
		return result;
	}

	async #emitWord(
		raw: string,
		value: string,
		literal: boolean,
		parts: { text: string; inputNewlines: boolean }[],
	): Promise<void> {
		if (!value.includes("://") && !raw.includes("$(")) {
			parts.push({ text: raw, inputNewlines: true });
			return;
		}
		if (literal) {
			if (raw.includes("$(")) {
				parts.push({ text: await this.#substitutions(raw), inputNewlines: true });
			} else {
				parts.push({ text: raw, inputNewlines: true });
			}
			return;
		}
		if (raw.includes("$(")) {
			parts.push({ text: await this.#substitutions(raw), inputNewlines: true });
			return;
		}
		const rewritten = await this.#word(raw, value);
		parts.push({ text: rewritten, inputNewlines: rewritten === raw });
	}

	async #resolveSingleWord(raw: string, value: string): Promise<string | undefined> {
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
	async #word(raw: string, value: string): Promise<string> {
		if (raw.includes("$(")) return this.#substitutions(raw);
		// Any other expansion decides the word's text only once the shell runs it.
		if (/[$`]/.test(raw)) return raw;
		const at = urlStart(value);
		if (at === undefined) return raw;
		const url = value.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		// Words after a URL make it message text, unless a file has exactly that name.
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return spellWord(value.slice(0, at), host, url, this.#cmd, raw.endsWith(url));
	}

	/** A word holding `$(…)`: outside single quotes, each substitution is a command of its own. */
	async #substitutions(raw: string): Promise<string> {
		let out = "";
		let quote = "";
		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i];
			if (quote === "'") {
				if (ch === "'") quote = "";
			} else if (ch === "\\") {
				out += raw.slice(i, i + 2);
				i++;
				continue;
			} else if (ch === '"') {
				quote = quote ? "" : '"';
			} else if (ch === "'" && !quote) {
				quote = "'";
			} else if (ch === "$" && raw[i + 1] === "(" && raw[i + 2] !== "(") {
				const end = substitutionEnd(raw, i + 2);
				if (end >= 0) {
					out += `$(${await this.#code(raw.slice(i + 2, end))})`;
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
