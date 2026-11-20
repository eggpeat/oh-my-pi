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
 * arguments are still rewritten. The walk matches `omp_owned` in `urls.rs`.
 */
import * as fs from "node:fs/promises";
import { ShellFsOp } from "@oh-my-pi/pi-natives";
import { isCmdShell } from "@oh-my-pi/pi-utils/procmgr";
import type { InternalUrlFilesystem } from "../internal-urls/url-filesystem";
import { lexShellCommand, type ShellToken } from "./shell-tokenize";

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
/** An unquoted redirection operator attached to its target (`<local://in`, `2>>local://log`). */
const REDIRECT = /^\d*(?:<>|>>|<|>)/;
const REDIR_OP = /^(\d*)(<<<|<<-|<<|<>|>>|<&|>&|<|>)/;
const WORD_SAFE = /^[A-Za-z0-9_./:@%+=,-]+$/;
const GLOB_RUN = /([*?[\]{}]+)/;
const COMMAND_SEP = /[\n;&|()]/;

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

function shellAssignment(word: string): boolean {
	const eq = word.indexOf("=");
	if (eq <= 0) return false;
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word.slice(0, eq));
}

function remoteSep(word: string): boolean {
	return word === "|" || word === "||" || word === "&" || word === "&&" || word === ";" || word === ";;" || word === ";&" || word === ";;&";
}

type RedirectKind = "heredoc" | "herestring" | "file" | "dup" | "none";

function redirectKind(word: string): RedirectKind {
	const match = REDIR_OP.exec(word);
	if (!match) return "none";
	const op = match[2];
	if (op === "<<<") return "herestring";
	if (op === "<<" || op === "<<-") return "heredoc";
	if (op === "<&" || op === ">&") return "dup";
	return "file";
}

function operatorOnly(word: string): boolean {
	return /^(\d*)(<<<|<<-|<<|<>|>>|<&|>&|<|>)$/.test(word);
}

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** Escape `\`, `$` and backticks once per enclosing `` ` `` command. */
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
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = "";
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
		if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
			atCommand = true;
			continue;
		}
		if (ch === " " || ch === "\t") continue;
		const wordStart = i;
		while (i < text.length && !" \t\n;&|()<>'\"".includes(text[i]) && text[i] !== "\\") i++;
		const word = text.slice(wordStart, i);
		i--;
		if (atCommand && shellAssignment(word)) continue;
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
 * comment is not a document; `<<END"MARK"` waits for `ENDMARK`, not `END`.
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
			if (ch === ")" && text[i + 1] === ")") {
				stack.pop();
				i += 2;
				atCommand = true;
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
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
				stack.push({ mode: "cmd", closeAt: 0, parens: 1, cases: [] });
				i += 2;
				atCommand = true;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] === "(") {
				stack.push({ mode: "arith", closeAt: -1, parens: 0, cases: [] });
				i += 3;
				continue;
			}
			i++;
			continue;
		}
		if (ch === "\\") {
			i += 2;
			atCommand = false;
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
			stack.push({ mode: "arith", closeAt: -1, parens: 0, cases: [] });
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
			stack.push({ mode: "arith", closeAt: -1, parens: 0, cases: [] });
			i += 2;
			continue;
		}
		if (inCommand() && ch === "<" && text[i + 1] === "<" && text[i + 2] !== "<") {
			const doc = readHereDoc(text, i);
			if (doc) {
				pending.push(doc.doc);
				i = doc.end;
				atCommand = false;
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
		if (inCommand() && (ch === "\n" || ch === ";" || ch === "&" || ch === "|")) {
			atCommand = true;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			atCommand = atCommand || false;
			i++;
			continue;
		}
		if (inCommand() && atCommand) {
			const wordStart = i;
			while (i < text.length && !" \t\n;&|()<>'\"".includes(text[i]) && text[i] !== "\\" && text[i] !== "`") i++;
			const word = text.slice(wordStart, i);
			if (shellAssignment(word)) continue;
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
			while (i < text.length && !" \t\n;&|()<>".includes(text[i])) i++;
			if (text.slice(wordStart, i) === "in") {
				frame.cases[frame.cases.length - 1] = "pattern";
				atCommand = false;
				continue;
			}
		}
		atCommand = false;
		i++;
	}
	flushCode(text.length);
	return parts.length > 0 ? parts : [{ kind: "code", text }];
}

interface OptSet {
	shortVal: string;
	longVal: ReadonlySet<string>;
	longBool: ReadonlySet<string>;
	open: boolean;
}

function optSet(shortVal: string, longVal: readonly string[], longBool: readonly string[], open: boolean): OptSet {
	return { shortVal, longVal: new Set(longVal), longBool: new Set(longBool), open };
}

interface WordScan {
	words: string[];
	remote: boolean;
	end: number;
}

interface Launch {
	at: number;
	passed: number[];
}

function atStop(scan: WordScan, index: number): boolean {
	return index >= scan.end || (scan.remote && index < scan.words.length && remoteSep(scan.words[index]));
}

function wordAt(scan: WordScan, index: number): string | undefined {
	if (index >= scan.end || index >= scan.words.length) return undefined;
	return scan.words[index];
}

const ENV = optSet(
	"uCSafP",
	["unset", "chdir", "split-string", "argv0", "file", "env0-from", "block-signal", "default-signal", "ignore-signal"],
	["ignore-environment", "null", "debug", "list-signal-handling", "help", "version"],
	false,
);
const SUDO = optSet(
	"ugCDhpRrTtU",
	["user", "group", "close-from", "chdir", "host", "prompt", "chroot", "role", "command-timeout", "type", "other-user"],
	["help", "version"],
	false,
);
const DOAS = optSet("aCu", [], [], false);
const NICE = optSet("n", ["adjustment"], ["help", "version"], false);
const NOHUP = optSet("", [], ["help", "version"], false);
const TIME = optSet("of", ["output", "format"], ["help", "version", "portability", "verbose", "append"], false);
const TIMEOUT = optSet("sk", ["signal", "kill-after"], ["preserve-status", "foreground", "verbose", "help", "version"], false);
const STDBUF = optSet("ioe", ["input", "output", "error"], ["help", "version"], false);
const SETSID = optSet("", [], ["ctty", "fork", "wait", "help", "version"], false);
const IFNE = optSet("", [], ["help"], false);
const XARGS = optSet(
	"adnLPsIE",
	["arg-file", "delimiter", "max-args", "max-lines", "max-procs", "max-chars", "replace", "eof"],
	["exit", "interactive", "no-run-if-empty", "null", "verbose", "help", "version"],
	false,
);
const EXEC = optSet("a", [], [], false);
const COMMAND = optSet("", [], [], false);
const NPM_BOOL = [
	"all", "allow-same-version", "allow-scripts-pending", "allow-scripts-pin", "audit", "bin-links", "bypass-2fa",
	"color", "commit-hooks", "dangerously-allow-all-scripts", "description", "dev", "diff-ignore-all-space",
	"diff-name-only", "diff-no-prefix", "diff-text", "dry-run", "engine-strict", "expect-results", "force",
	"foreground-scripts", "format-package-lock", "fund", "git-tag-version", "global", "global-style", "help",
	"if-present", "ignore-scripts", "include-attestations", "include-staged", "include-workspace-root",
	"init-private", "install-links", "json", "legacy-bundling", "legacy-peer-deps", "link", "long", "no-install",
	"offline", "omit-lockfile-registry-resolved", "optional", "package-lock", "package-lock-only", "packages-all",
	"parseable", "prefer-dedupe", "prefer-offline", "prefer-online", "production", "progress", "provenance",
	"quiet", "read-only", "rebuild-bundle", "save", "save-bundle", "save-dev", "save-exact", "save-optional",
	"save-peer", "save-prod", "shrinkwrap", "sign-git-commit", "sign-git-tag", "silent", "strict-allow-scripts",
	"strict-peer-deps", "strict-ssl", "timing", "unicode", "update-notifier", "usage", "verbose", "version",
	"versions", "workspaces", "workspaces-update", "yes",
];
const NPM_VAL = [
	"allow-scripts", "auth-type", "before", "cache", "cache-max", "cache-min", "cafile", "call", "cert", "cidr",
	"cpu", "depth", "diff", "editor", "fetch-retries", "fetch-timeout", "git", "globalconfig", "heading",
	"https-proxy", "include", "key", "libc", "local-address", "location", "lockfile-version", "loglevel",
	"logs-max", "message", "min-release-age", "node-options", "noproxy", "omit", "os", "otp", "package",
	"pack-destination", "prefix", "proxy", "registry", "save-prefix", "scope", "script-shell", "searchlimit",
	"shell", "tag", "umask", "user-agent", "userconfig", "viewer", "which", "workspace",
];
const NPM = optSet("cCwmL", NPM_VAL, NPM_BOOL, true);
const NPX = optSet("pcCwmL", NPM_VAL, NPM_BOOL, true);
const BUNX = optSet(
	"p",
	["package", "cwd", "env-file", "minimum-release-age", "registry", "ca", "cafile"],
	["bun", "no-install", "trust", "ignore-scripts", "verbose", "silent", "help", "version"],
	false,
);
const UV = optSet(
	"wpifPC",
	[
		"allow-insecure-host", "cache-dir", "color", "config-file", "config-setting", "directory", "env-file",
		"extra", "extra-index-url", "find-links", "group", "index", "index-url", "no-extra", "no-group",
		"only-group", "package", "project", "python", "with", "with-editable", "with-requirements",
	],
	[
		"active", "all-extras", "all-groups", "exact", "frozen", "help", "isolated", "locked", "module",
		"no-cache", "no-dev", "no-editable", "no-env-file", "no-project", "no-sync", "offline", "quiet",
		"script", "upgrade", "verbose", "version",
	],
	false,
);
const SSH = optSet("BbcDEeFIJiLlmOopQRWSw", [], [], false);

function longTakes(name: string, next: string | undefined, opts: OptSet): boolean {
	if (opts.longBool.has(name)) return false;
	if (opts.longVal.has(name)) return next !== undefined;
	return opts.open && next !== undefined && !next.startsWith("-");
}

function shortTakesNext(letters: string, shortVal: string): boolean {
	for (let i = 0; i < letters.length; i++) {
		if (shortVal.includes(letters[i])) return i === letters.length - 1;
	}
	return false;
}

function skipOpts(scan: WordScan, index: number, opts: OptSet): number {
	let at = index;
	while (!atStop(scan, at)) {
		const word = wordAt(scan, at);
		if (word === undefined || word === "-" || !word.startsWith("-")) break;
		if (word === "--") return at + 1;
		if (word.startsWith("--")) {
			const body = word.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				at++;
				continue;
			}
			const next = atStop(scan, at + 1) ? undefined : wordAt(scan, at + 1);
			at += longTakes(body, next, opts) ? 2 : 1;
			continue;
		}
		at += shortTakesNext(word.slice(1), opts.shortVal) && !atStop(scan, at + 1) ? 2 : 1;
	}
	return at;
}

function follow(scan: WordScan, at: number, passed: number[]): Launch {
	if (wordAt(scan, at) === undefined || atStop(scan, at)) return { at, passed };
	const inner = launchOf(scan, at);
	return { at: inner.at, passed: passed.concat(inner.passed) };
}

function launchOf(scan: WordScan, index: number): Launch {
	const word = wordAt(scan, index);
	if (word === undefined || atStop(scan, index)) return { at: index, passed: [] };
	if (programIs(word, "env")) {
		let at = skipOpts(scan, index + 1, ENV);
		const passed: number[] = [];
		if (wordAt(scan, at) === "-") at++;
		while (!atStop(scan, at) && wordAt(scan, at)?.includes("=")) {
			passed.push(at);
			at++;
		}
		return follow(scan, at, passed);
	}
	if (programIs(word, "sudo")) {
		let at = skipOpts(scan, index + 1, SUDO);
		const passed: number[] = [];
		while (!atStop(scan, at) && wordAt(scan, at) !== undefined && shellAssignment(wordAt(scan, at) as string)) {
			passed.push(at);
			at++;
		}
		return follow(scan, at, passed);
	}
	const simple = (opts: OptSet) => follow(scan, skipOpts(scan, index + 1, opts), []);
	if (programIs(word, "doas")) return simple(DOAS);
	if (programIs(word, "nice")) return simple(NICE);
	if (programIs(word, "nohup")) return simple(NOHUP);
	if (programIs(word, "time")) return simple(TIME);
	if (programIs(word, "timeout") || programIs(word, "gtimeout")) {
		const duration = skipOpts(scan, index + 1, TIMEOUT);
		const command = wordAt(scan, duration) !== undefined && !atStop(scan, duration) ? duration + 1 : duration;
		return follow(scan, command, []);
	}
	if (programIs(word, "stdbuf")) return simple(STDBUF);
	if (programIs(word, "setsid")) return simple(SETSID);
	if (programIs(word, "ifne")) return simple(IFNE);
	if (programIs(word, "xargs")) return simple(XARGS);
	if (programIs(word, "exec")) return simple(EXEC);
	if (programIs(word, "command") || programIs(word, "builtin")) return simple(COMMAND);
	if (programIs(word, "npx")) return simple(NPX);
	if (programIs(word, "npm")) {
		const sub = skipOpts(scan, index + 1, NPM);
		const name = wordAt(scan, sub);
		if (atStop(scan, sub) || (name !== "exec" && name !== "x")) return { at: index, passed: [] };
		return follow(scan, skipOpts(scan, sub + 1, NPM), []);
	}
	if (programIs(word, "bunx")) return simple(BUNX);
	if (programIs(word, "bun")) {
		const sub = skipOpts(scan, index + 1, BUNX);
		if (wordAt(scan, sub) === "x") return follow(scan, skipOpts(scan, sub + 1, BUNX), []);
		return { at: index, passed: [] };
	}
	if (programIs(word, "uvx")) return simple(UV);
	if (programIs(word, "uv")) {
		const sub = skipOpts(scan, index + 1, UV);
		if (wordAt(scan, sub) === "run") return follow(scan, skipOpts(scan, sub + 1, UV), []);
		if (wordAt(scan, sub) === "tool" && wordAt(scan, sub + 1) === "run") {
			return follow(scan, skipOpts(scan, sub + 2, UV), []);
		}
		return { at: index, passed: [] };
	}
	return { at: index, passed: [] };
}

/** `true` where a URL in that word is rewritten. Frozen markers stay, file targets always rewrite. */
function classify(words: string[]): boolean[] {
	const rewrite = words.map(() => true);
	const frozen = words.map(() => false);
	const always = words.map(() => false);
	for (let i = 0; i < words.length; i++) {
		const kind = redirectKind(words[i]);
		const bare = operatorOnly(words[i]);
		if (kind === "heredoc" || kind === "herestring") {
			frozen[i] = true;
			if (bare && i + 1 < words.length) frozen[i + 1] = true;
		} else if (kind === "file") {
			if (bare && i + 1 < words.length) always[i + 1] = true;
			else if (!bare) always[i] = true;
		}
	}
	let start = 0;
	while (start < words.length && shellAssignment(words[start])) start++;
	if (start < words.length && programIs(words[start], "ssh")) return finish(markSsh(words, start, rewrite), frozen, always);
	if (start < words.length && programIs(words[start], "find")) {
		return finish(markFind(words, start, rewrite), frozen, always);
	}
	const scan: WordScan = { words, remote: false, end: words.length };
	const launch = start < words.length ? launchOf(scan, start) : { at: start, passed: [] };
	if (launch.at < words.length && programIs(words[launch.at], "ssh")) {
		return finish(markSsh(words, launch.at, rewrite), frozen, always);
	}
	if (launch.at < words.length && programIs(words[launch.at], "find")) {
		return finish(markFind(words, launch.at, rewrite), frozen, always);
	}
	if (launch.at < words.length && isOmp(words[launch.at])) {
		for (let i = 0; i < start; i++) rewrite[i] = false;
		for (let i = launch.at; i < words.length; i++) rewrite[i] = false;
		for (const passed of launch.passed) if (passed < words.length) rewrite[passed] = false;
	}
	return finish(rewrite, frozen, always);
}

function finish(rewrite: boolean[], frozen: boolean[], always: boolean[]): boolean[] {
	for (let i = 0; i < rewrite.length; i++) {
		if (frozen[i]) rewrite[i] = false;
		else if (always[i]) rewrite[i] = true;
	}
	return rewrite;
}

function markSsh(words: string[], sshAt: number, rewrite: boolean[]): boolean[] {
	const kept: number[] = [];
	for (let i = sshAt; i < words.length; i++) {
		const kind = redirectKind(words[i]);
		if (kind === "file" || kind === "dup" || kind === "heredoc" || kind === "herestring") continue;
		kept.push(i);
	}
	const remoteWords = kept.map(index => words[index]);
	const scan: WordScan = { words: remoteWords, remote: false, end: remoteWords.length };
	const host = skipOpts(scan, 1, SSH);
	const remote = host + 1;
	const remoteScan: WordScan = { words: remoteWords, remote: true, end: remoteWords.length };
	let index = remote;
	while (index < remoteWords.length) {
		if (remoteSep(remoteWords[index])) {
			index++;
			continue;
		}
		const launch = launchOf(remoteScan, index);
		if (launch.at >= remoteWords.length) break;
		if (atStop(remoteScan, launch.at)) {
			index = launch.at;
			continue;
		}
		let end = launch.at;
		while (end < remoteWords.length && !remoteSep(remoteWords[end])) end++;
		if (launch.at < end && isOmp(remoteWords[launch.at])) {
			for (let i = launch.at; i < end; i++) rewrite[kept[i]] = false;
			for (const passed of launch.passed) if (passed < end) rewrite[kept[passed]] = false;
		}
		index = end;
	}
	return rewrite;
}

function markFind(words: string[], findAt: number, rewrite: boolean[]): boolean[] {
	let reaches = false;
	for (let i = findAt + 1; i < words.length; i++) {
		if (words[i] !== "-exec" && words[i] !== "-execdir" && words[i] !== "-ok" && words[i] !== "-okdir") continue;
		const start = i + 1;
		let end = start;
		while (end < words.length && words[end] !== ";" && words[end] !== "+") end++;
		if (start < end) {
			const launch = launchOf({ words, remote: false, end }, start);
			if (launch.at < end && isOmp(words[launch.at])) {
				reaches = true;
				for (let at = launch.at; at < end; at++) rewrite[at] = false;
				for (const passed of launch.passed) if (passed < end) rewrite[passed] = false;
			}
		}
		i = end;
	}
	if (reaches) {
		for (let i = 0; i < findAt; i++) rewrite[i] = false;
	}
	return rewrite;
}

function backtickToggles(raw: string): number {
	let n = 0;
	let quote = "";
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			i++;
			continue;
		}
		if (ch === "'") {
			quote = "'";
			continue;
		}
		if (ch === '"') {
			quote = quote === '"' ? "" : '"';
			continue;
		}
		if (ch === "`") n++;
	}
	return n;
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

	/** Command text without here-document bodies, word by word. */
	async #code(text: string, layers: number): Promise<string> {
		if (!text.includes("://")) return text;
		const tokens = lexShellCommand(text);
		let out = "";
		let depth = layers;
		let i = 0;
		while (i < tokens.length) {
			const token = tokens[i];
			if (token.kind === "separator" && COMMAND_SEP.test(token.raw)) {
				out += token.raw;
				depth += backtickToggles(token.raw);
				i++;
				continue;
			}
			const segment: ShellToken[] = [];
			while (i < tokens.length) {
				const next = tokens[i];
				if (next.kind === "separator" && COMMAND_SEP.test(next.raw)) break;
				segment.push(next);
				i++;
			}
			const words = segment.flatMap(item => (item.kind === "word" ? [item.value] : []));
			const rewrite = classify(words);
			let wordIndex = 0;
			for (const item of segment) {
				if (item.kind === "separator") out += item.raw;
				else out += await this.#emit(item, rewrite[wordIndex++], this.#cmd ? 0 : depth);
				depth += backtickToggles(item.raw);
			}
		}
		return out;
	}

	async #emit(token: Extract<ShellToken, { kind: "word" }>, rewrite: boolean, layers: number): Promise<string> {
		if ((token.raw.includes("$(") || token.raw.includes("`")) && token.raw.includes("://")) {
			return this.#expansions(token.raw, layers);
		}
		if (!rewrite || !token.value.includes("://")) return token.raw;
		if (/[$`]/.test(token.raw)) return token.raw;
		return this.#word(token.raw, token.value, layers);
	}

	/** One word naming a URL: its spelling with the URL's file in place, or as written. */
	async #word(raw: string, value: string, layers: number): Promise<string> {
		const redirect = REDIRECT.exec(raw)?.[0] ?? "";
		const operand = value.slice(redirect.length);
		const at = urlStart(operand);
		if (at === undefined) return raw;
		const url = operand.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return redirect + spellWord(operand.slice(0, at), host, url, this.#cmd, raw.endsWith(url), layers);
	}

	/** A word holding `$(…)` or `` `…` ``: each substitution is a command of its own. */
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
				const end = raw.indexOf("`", i + 1);
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
