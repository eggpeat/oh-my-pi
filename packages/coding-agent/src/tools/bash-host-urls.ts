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
import { lexShellCommand } from "./shell-tokenize";

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
/** An unquoted standalone redirection operator whose target is the following word (`>`, `2>>`, `<`). */
const BARE_REDIRECT_OP = /^\d*(?:<<-?|<<<|<&|>&|<>|>>|<|>)$/;
/** Any unquoted redirection operator (`2>/dev/null`, `2>&1`, `<local://in`). */
const ATTACHED_REDIRECT = /^\d*(?:<<-?|<<<|<&|>&|<>|>>|<|>)/;
/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: a here-document and its delimiter. */
const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;
const SHELL_KEYWORDS = new Set(["!", "{", "if", "elif", "then", "else", "while", "until", "do"]);
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
	if (ASSIGNMENT.test(word)) return false;
	const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase();
	return name === "omp" || name === "omp.exe";
}

function wrapperName(word: string): string {
	return word
		.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1)
		.toLowerCase()
		.replace(/\.(?:exe|cmd)$/, "");
}

function isEnvVar(word: string): boolean {
	return !word.startsWith("-") && word.indexOf("=") > 0;
}

function skipOneOption(
	words: readonly string[],
	i: number,
	shortValues: string,
	shortAbort: string,
	longValues: ReadonlySet<string>,
	longAbort: ReadonlySet<string>,
): number | undefined {
	const word = words[i];
	if (word === undefined) return undefined;
	if (word.startsWith("--")) {
		const rest = word.slice(2);
		const eq = rest.indexOf("=");
		const name = eq >= 0 ? rest.slice(0, eq) : rest;
		if (longAbort.has(name)) return undefined;
		const step = eq < 0 && longValues.has(name) ? 2 : 1;
		return i + step <= words.length ? i + step : undefined;
	}
	if (word.length <= 1 || !word.startsWith("-")) return undefined;
	let step = 1;
	for (let idx = 1; idx < word.length; idx++) {
		const flag = word[idx];
		if (shortAbort.includes(flag)) return undefined;
		if (shortValues.includes(flag)) {
			if (idx + 1 === word.length) step = 2;
			break;
		}
	}
	return i + step <= words.length ? i + step : undefined;
}

function skipOptions(
	words: readonly string[],
	start: number,
	shortValues: string,
	shortAbort: string,
	longValues: ReadonlySet<string>,
	longAbort: ReadonlySet<string>,
): number | undefined {
	let i = start;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") return i + 1;
		if (word.length <= 1 || !word.startsWith("-")) break;
		const next = skipOneOption(words, i, shortValues, shortAbort, longValues, longAbort);
		if (next === undefined) return undefined;
		i = next;
	}
	return i;
}

const HELP_VERSION_ABORT = new Set(["help", "version"]);
const ENV_LONG_VALUES = new Set(["unset", "chdir", "default-path", "argv0"]);
const ENV_LONG_ABORT = new Set(["split-string", "null", "help", "version"]);
const SUDO_LONG_VALUES = new Set([
	"auth-type",
	"class",
	"close-from",
	"chdir",
	"group",
	"host",
	"prompt",
	"chroot",
	"role",
	"command-timeout",
	"type",
	"other-user",
	"user",
]);
const SUDO_LONG_ABORT = new Set(["edit", "list", "validate", "version", "help", "remove-timestamp"]);
const NICE_LONG_VALUES = new Set(["adjustment"]);
const TIME_LONG_VALUES = new Set(["format", "output"]);
const TIMEOUT_LONG_VALUES = new Set(["signal", "kill-after"]);
const STDBUF_LONG_VALUES = new Set(["input", "output", "error"]);
const XARGS_LONG_VALUES = new Set(["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"]);
const NPX_LONG_VALUES = new Set([
	"package",
	"workspace",
	"cache",
	"userconfig",
	"registry",
	"shell",
	"script-shell",
	"node-options",
	"node-arg",
	"prefix",
]);
const NPX_LONG_ABORT = new Set(["call", "help", "version"]);
const BUNX_LONG_VALUES = new Set(["package", "cwd", "config", "env-file"]);
const BUN_LONG_ABORT = new Set(["eval", "print", "help", "version"]);
const PNPM_LONG_VALUES = new Set(["dir", "filter", "package", "workspace-root", "cwd"]);
const NPM_LONG_VALUES = new Set(["prefix", "workspace", "userconfig", "registry", "cache"]);
const EMPTY_SET = new Set<string>();

function skipEnv(words: readonly string[], start: number): number | undefined {
	let i = start;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") {
			i++;
			while (i < words.length && isEnvVar(words[i])) i++;
			return i;
		}
		if (word === "-" || isEnvVar(word)) {
			i++;
			continue;
		}
		if (word.startsWith("-")) {
			const next = skipOneOption(words, i, "uCPa", "S0", ENV_LONG_VALUES, ENV_LONG_ABORT);
			if (next === undefined) return undefined;
			i = next;
			continue;
		}
		break;
	}
	return i;
}

function skipSudo(words: readonly string[], start: number): number | undefined {
	let i = start;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") {
			i++;
			while (i < words.length && ASSIGNMENT.test(words[i])) i++;
			return i;
		}
		if (ASSIGNMENT.test(word)) {
			i++;
			continue;
		}
		if (word.length > 1 && word.startsWith("-")) {
			const next = skipOneOption(words, i, "ugCDhpRrTtUac", "eVvlK", SUDO_LONG_VALUES, SUDO_LONG_ABORT);
			if (next === undefined) return undefined;
			i = next;
			continue;
		}
		break;
	}
	return i;
}

function skipCommandBuiltin(words: readonly string[], start: number): number | undefined {
	let i = start;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") return i + 1;
		if (word.length > 1 && word.startsWith("-")) {
			if (/^-p+$/.test(word)) {
				i++;
				continue;
			}
			return undefined;
		}
		break;
	}
	return i;
}

function skipExecBuiltin(words: readonly string[], start: number): number | undefined {
	let i = start;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") return i + 1;
		if (word.length > 1 && word.startsWith("-")) {
			let step = 1;
			for (let idx = 1; idx < word.length; idx++) {
				const ch = word[idx];
				if (ch === "c" || ch === "l") continue;
				if (ch === "a") {
					if (idx + 1 === word.length) step = 2;
					break;
				}
				return undefined;
			}
			if (i + step > words.length) return undefined;
			i += step;
			continue;
		}
		break;
	}
	return i;
}

function unwrapWrapper(words: readonly string[], i: number): number | undefined {
	const word = words[i];
	if (word === undefined) return undefined;
	switch (wrapperName(word)) {
		case "env":
			return skipEnv(words, i + 1);
		case "sudo":
			return skipSudo(words, i + 1);
		case "doas":
			return skipOptions(words, i + 1, "ua", "CL", EMPTY_SET, HELP_VERSION_ABORT);
		case "nice":
			return skipOptions(words, i + 1, "n", "", NICE_LONG_VALUES, HELP_VERSION_ABORT);
		case "nohup": {
			const next = words[i + 1];
			if (next === "--") return i + 2;
			return next !== undefined && next.startsWith("-") ? undefined : i + 1;
		}
		case "time":
			return skipOptions(words, i + 1, "fo", "V", TIME_LONG_VALUES, HELP_VERSION_ABORT);
		case "timeout":
		case "gtimeout": {
			const duration = skipOptions(words, i + 1, "sk", "", TIMEOUT_LONG_VALUES, HELP_VERSION_ABORT);
			return duration !== undefined && duration < words.length ? duration + 1 : undefined;
		}
		case "stdbuf":
			return skipOptions(words, i + 1, "ioe", "", STDBUF_LONG_VALUES, HELP_VERSION_ABORT);
		case "setsid":
			return skipOptions(words, i + 1, "", "Vh", EMPTY_SET, HELP_VERSION_ABORT);
		case "ifne":
			return skipOptions(words, i + 1, "", "", EMPTY_SET, HELP_VERSION_ABORT);
		case "xargs":
			return skipOptions(words, i + 1, "IJLnPsdaESR", "", XARGS_LONG_VALUES, HELP_VERSION_ABORT);
		case "command":
			return skipCommandBuiltin(words, i + 1);
		case "exec":
			return skipExecBuiltin(words, i + 1);
		case "noglob":
		case "nocorrect":
			return i + 1;
		case "npx":
			return skipOptions(words, i + 1, "pw", "cvh", NPX_LONG_VALUES, NPX_LONG_ABORT);
		case "bunx":
			return skipOptions(words, i + 1, "p", "vh", BUNX_LONG_VALUES, HELP_VERSION_ABORT);
		case "bun": {
			const sub = skipOptions(words, i + 1, "Ccr", "vhep", BUNX_LONG_VALUES, BUN_LONG_ABORT);
			return sub !== undefined && words[sub] === "x"
				? skipOptions(words, sub + 1, "p", "vh", BUNX_LONG_VALUES, HELP_VERSION_ABORT)
				: undefined;
		}
		case "pnpm":
		case "yarn": {
			const sub = skipOptions(words, i + 1, "CFp", "vh", PNPM_LONG_VALUES, HELP_VERSION_ABORT);
			return sub !== undefined && (words[sub] === "dlx" || words[sub] === "exec")
				? skipOptions(words, sub + 1, "pw", "cvh", NPX_LONG_VALUES, NPX_LONG_ABORT)
				: undefined;
		}
		case "npm": {
			const sub = skipOptions(words, i + 1, "Cw", "vh", NPM_LONG_VALUES, HELP_VERSION_ABORT);
			return sub !== undefined && (words[sub] === "exec" || words[sub] === "x")
				? skipOptions(words, sub + 1, "pw", "cvh", NPX_LONG_VALUES, NPX_LONG_ABORT)
				: undefined;
		}
		default:
			return undefined;
	}
}

/** Whether a simple command's words invoke `omp`, directly or through wrappers. */
function runsOmp(words: readonly string[]): boolean {
	let i = 0;
	while (i < words.length && SHELL_KEYWORDS.has(words[i])) i++;
	for (;;) {
		while (i < words.length && ASSIGNMENT.test(words[i])) i++;
		const word = words[i];
		if (word === undefined) return false;
		const next = unwrapWrapper(words, i);
		if (next === undefined) return isOmp(word);
		if (next <= i) return false;
		i = next;
	}
}

function endsWithUnescapedDollar(raw: string): boolean {
	if (!raw.endsWith("$")) return false;
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
		} else if (inDouble) {
			if (ch === "\\" && i + 1 < raw.length) i++;
			else if (ch === '"') inDouble = false;
		} else if (ch === "'") {
			inSingle = true;
		} else if (ch === '"') {
			inDouble = true;
		} else if (ch === "\\") {
			if (i + 1 === raw.length - 1) return false;
			i++;
		}
	}
	return !inSingle && !inDouble;
}

interface Clause {
	parts: Array<string | { raw: string; value: string }>;
	words: string[];
	skipRedirectTarget: boolean;
	inSkippedWord: boolean;
	mergeNextWord: boolean;
}

function emptyClause(): Clause {
	return { parts: [], words: [], skipRedirectTarget: false, inSkippedWord: false, mergeNextWord: false };
}

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
	let depth = 1;
	let quote = "";
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\") i++;
		else if (quote) {
			if (ch === quote) quote = "";
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
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
		const out: string[] = [];
		const pending: { delimiter: string; tabs: boolean }[] = [];
		let code: string[] = [];
		const flush = async () => {
			if (code.length > 0) out.push(await this.#code(code.join("\n")));
			code = [];
		};
		for (const line of command.split("\n")) {
			const open = pending[0];
			if (open) {
				out.push(line);
				if ((open.tabs ? line.replace(/^\t+/, "") : line) === open.delimiter) pending.shift();
				continue;
			}
			code.push(line);
			for (const match of line.matchAll(HEREDOC)) {
				pending.push({ delimiter: match[2] ?? match[3] ?? match[4], tabs: match[1] === "-" });
			}
			if (pending.length > 0) await flush();
		}
		await flush();
		return out.join("\n");
	}

	/** Command text without here-document bodies, simple command by simple command. */
	async #code(text: string): Promise<string> {
		if (!text.includes("://")) return text;
		// `omp` resolves the URLs it is given itself (`omp read skill://x:1-20`), so a simple
		// command whose command word (past assignments and wrappers) is `omp` keeps its URLs.
		const flushClause = async (clause: Clause): Promise<string> => {
			const omp = runsOmp(clause.words);
			let rendered = "";
			for (const part of clause.parts) {
				if (typeof part === "string") {
					rendered += part;
				} else if (omp || !part.value.includes("://")) {
					rendered += part.raw;
				} else {
					rendered += await this.#word(part.raw, part.value);
				}
			}
			return rendered;
		};

		let frame = { out: "", clause: emptyClause() };
		const stack: Array<{ frame: typeof frame; substitution: boolean }> = [];
		const flush = async () => {
			frame.out += await flushClause(frame.clause);
			frame.clause = emptyClause();
		};
		const tokens = lexShellCommand(text);
		for (let idx = 0; idx < tokens.length; idx++) {
			const token = tokens[idx];
			if (token.kind === "word") {
				frame.clause.parts.push({ raw: token.raw, value: token.value });
				if (frame.clause.mergeNextWord) {
					frame.clause.mergeNextWord = false;
					if (!frame.clause.inSkippedWord && frame.clause.words.length > 0) {
						frame.clause.words[frame.clause.words.length - 1] += token.value;
					}
				} else if (frame.clause.skipRedirectTarget) {
					frame.clause.skipRedirectTarget = false;
					frame.clause.inSkippedWord = true;
				} else if (BARE_REDIRECT_OP.test(token.raw)) {
					frame.clause.skipRedirectTarget = true;
					frame.clause.inSkippedWord = false;
				} else if (ATTACHED_REDIRECT.test(token.raw)) {
					frame.clause.inSkippedWord = true;
				} else {
					frame.clause.inSkippedWord = false;
					frame.clause.words.push(token.value);
				}
				continue;
			}
			if (!/[\n;&|()]/.test(token.raw)) {
				frame.clause.parts.push(token.raw);
				frame.clause.mergeNextWord = false;
				frame.clause.inSkippedWord = false;
				continue;
			}
			const prev = idx > 0 ? tokens[idx - 1] : undefined;
			for (let c = 0; c < token.raw.length; c++) {
				const ch = token.raw[c];
				if (ch === "(") {
					const isCommandSubst =
						c === 0 && token.raw[1] !== "(" && prev?.kind === "word" && endsWithUnescapedDollar(prev.raw);
					if (isCommandSubst) {
						frame.clause.parts.push("(");
					} else {
						await flush();
						frame.out += "(";
					}
					stack.push({ frame, substitution: isCommandSubst });
					frame = { out: "", clause: emptyClause() };
				} else if (ch === ")") {
					await flush();
					const parent = stack.pop();
					if (parent) {
						if (parent.substitution) {
							parent.frame.clause.parts.push(`${frame.out})`);
						} else {
							parent.frame.out += `${frame.out})`;
						}
						parent.frame.clause.mergeNextWord = true;
						frame = parent.frame;
					}
				} else if (ch === "\n" || ch === ";" || ch === "&" || ch === "|") {
					await flush();
					frame.out += ch;
				} else {
					frame.clause.parts.push(ch);
					frame.clause.mergeNextWord = false;
					frame.clause.inSkippedWord = false;
				}
			}
		}
		await flush();
		while (stack.length > 0) {
			const parent = stack.pop();
			if (parent) {
				if (parent.substitution) {
					parent.frame.clause.parts.push(frame.out);
				} else {
					parent.frame.out += frame.out;
				}
				frame = parent.frame;
				await flush();
			}
		}
		return frame.out;
	}

	/** One word naming a URL: its spelling with the URL's file in place, or as written. */
	async #word(raw: string, value: string): Promise<string> {
		if (raw.includes("$(")) return this.#substitutions(raw);
		// Any other expansion decides the word's text only once the shell runs it.
		if (/[$`]/.test(raw)) return raw;
		const redirect = REDIRECT.exec(raw)?.[0] ?? "";
		const operand = value.slice(redirect.length);
		const at = urlStart(operand);
		if (at === undefined) return raw;
		const url = operand.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		// Words after a URL make it message text, unless a file has exactly that name.
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return redirect + spellWord(operand.slice(0, at), host, url, this.#cmd, raw.endsWith(url));
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
