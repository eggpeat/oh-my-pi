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
/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: a here-document and its delimiter. */
const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/g;
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
	const name = programName(word).toLowerCase();
	return name === "omp" || name === "omp.exe";
}

/** The last path segment of `word`: the program's name. */
function programName(word: string): string {
	return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
}

/** `NAME=value`, as a simple command or a wrapper's options take before the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Options that take the next word as their value: short letters and long names. */
interface OptionValues {
	short: string;
	long: readonly string[];
}

const NICE: OptionValues = { short: "n", long: ["adjustment"] };
const NOHUP: OptionValues = { short: "", long: [] };
const TIME: OptionValues = { short: "of", long: ["output", "format"] };
const ENV: OptionValues = { short: "uCS", long: ["unset", "chdir", "split-string"] };
const SUDO: OptionValues = {
	short: "ugCDhpRrTtUa",
	long: [
		"user",
		"group",
		"close-from",
		"chdir",
		"host",
		"prompt",
		"chroot",
		"role",
		"type",
		"command-timeout",
		"other-user",
		"auth-type",
	],
};
const DOAS: OptionValues = { short: "uC", long: ["user", "config"] };
const TIMEOUT: OptionValues = { short: "sk", long: ["signal", "kill-after"] };
const STDBUF: OptionValues = { short: "ioe", long: ["input", "output", "error"] };
const SETSID: OptionValues = { short: "", long: [] };
const XARGS: OptionValues = {
	short: "nILPsdEa",
	long: [
		"max-args",
		"replace",
		"max-lines",
		"max-procs",
		"max-chars",
		"delimiter",
		"eof",
		"arg-file",
		"process-slot-var",
	],
};
const IFNE: OptionValues = { short: "", long: [] };
const NPX: OptionValues = {
	short: "pc",
	long: [
		"cache",
		"prefix",
		"registry",
		"userconfig",
		"package",
		"call",
		"node-options",
		"shell",
		"loglevel",
		"log-level",
		"npm",
		"workspace",
	],
};
const BUNX: OptionValues = {
	short: "p",
	long: ["package", "registry", "cache-dir", "minimum-release-age", "cwd", "env-file"],
};
const NPM_GLOBAL: OptionValues = {
	short: "w",
	long: [
		"prefix",
		"registry",
		"userconfig",
		"cache",
		"loglevel",
		"log-level",
		"workspace",
		"location",
		"tag",
		"otp",
		"before",
		"script-shell",
	],
};
const NPM_EXEC: OptionValues = { short: "cw", long: ["package", "call", "workspace", "prefix"] };
const UV_GLOBAL: OptionValues = { short: "", long: ["directory", "project", "config-file", "cache-dir"] };
const UV_RUN: OptionValues = {
	short: "wpif",
	long: [
		"with",
		"with-editable",
		"with-requirements",
		"python",
		"package",
		"project",
		"directory",
		"env-file",
		"extra",
		"group",
		"only-group",
		"no-group",
		"index",
		"default-index",
		"index-url",
		"extra-index-url",
		"find-links",
		"config-file",
		"cache-dir",
	],
};
const SSH: OptionValues = { short: "BbcDEeFIiJLlmOoPpQRSWw", long: [] };
const COMMAND: OptionValues = { short: "", long: [] };
const EXEC: OptionValues = { short: "a", long: [] };
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * Index of the word naming the `omp` command, past any wrapper (`nice omp …`,
 * `npx omp …`) and the options and assignments before it. A word spelled
 * `omp` anywhere else (`grep omp …`) is an argument, not the program.
 */
function ompCommand(words: readonly string[]): number | undefined {
	let at = 0;
	for (;;) {
		while (at < words.length && ASSIGNMENT.test(words[at])) at++;
		const word = words[at];
		if (word === undefined) return undefined;
		if (isOmp(word)) return at;
		const next = wrapperCommand(words, at);
		if (next === undefined) return undefined;
		at = next;
	}
}

/** The index of the command word a wrapper at `at` runs, or `undefined` when it is no wrapper. */
function wrapperCommand(words: readonly string[], at: number): number | undefined {
	const after = (values: OptionValues) => afterOptions(words, at + 1, values);
	const command = (next: number) => (next > at && next < words.length ? next : undefined);
	switch (programName(words[at])) {
		case "nice":
			return command(after(NICE));
		case "nohup":
			return command(after(NOHUP));
		case "time":
			return command(after(TIME));
		case "env": {
			// `env` takes `NAME=value` settings after its options; coreutils
			// does not validate the name, and a lone `-` is a setting too.
			const options = afterOptions(words, at + 1, ENV, true);
			return command(skipWords(words, options, word => word === "-" || word.includes("=")));
		}
		case "sudo":
			return command(skipWords(words, after(SUDO), word => ASSIGNMENT.test(word)));
		case "doas":
			return command(skipWords(words, after(DOAS), word => ASSIGNMENT.test(word)));
		case "timeout":
		case "gtimeout":
			return command(after(TIMEOUT) + 1);
		case "stdbuf":
			return command(after(STDBUF));
		case "setsid":
			return command(after(SETSID));
		case "xargs":
			return command(after(XARGS));
		case "ifne":
			return command(after(IFNE));
		case "npx":
			return command(after(NPX));
		case "bunx":
			return command(after(BUNX));
		case "npm": {
			const sub = afterOptions(words, at + 1, NPM_GLOBAL);
			if (words[sub] !== "exec" && words[sub] !== "x") return undefined;
			return command(afterOptions(words, sub + 1, NPM_EXEC));
		}
		case "uv": {
			const sub = afterOptions(words, at + 1, UV_GLOBAL);
			if (words[sub] !== "run") return undefined;
			return command(afterOptions(words, sub + 1, UV_RUN));
		}
		case "ssh":
			return command(after(SSH) + 1);
		case "command": {
			const next = after(COMMAND);
			const namesOnly = words.slice(at + 1, next).some(word => /^-[^-]/.test(word) && /[vV]/.test(word));
			return namesOnly ? undefined : command(next);
		}
		case "exec":
			return command(after(EXEC));
		case "find": {
			const exec = words.findIndex((word, index) => index > at && FIND_EXEC.has(word));
			return exec < 0 ? undefined : command(exec + 1);
		}
		default:
			return undefined;
	}
}

/** The first word from `from` on that is not an option (`--` ends them). */
function afterOptions(words: readonly string[], from: number, values: OptionValues, dash = false): number {
	let at = from;
	while (at < words.length) {
		const word = words[at];
		if (word === "--") return at + 1;
		if (word === "-") {
			if (dash) {
				at++;
				continue;
			}
			return at;
		}
		if (!word.startsWith("-")) return at;
		at += optionWords(word, values);
	}
	return at;
}

/** The words one option occupies: its own, plus the next when its value is not attached. */
function optionWords(word: string, values: OptionValues): number {
	if (word.startsWith("--")) {
		if (word.includes("=")) return 1;
		return values.long.includes(word.slice(2)) ? 2 : 1;
	}
	for (let i = 1; i < word.length; i++) {
		if (values.short.includes(word[i])) return i + 1 < word.length ? 1 : 2;
	}
	return 1;
}

/** The first word from `from` on that `skip` rejects. */
function skipWords(words: readonly string[], from: number, skip: (word: string) => boolean): number {
	let at = from;
	while (at < words.length && skip(words[at])) at++;
	return at;
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

	/** Command text without here-document bodies, word by word. */
	async #code(text: string): Promise<string> {
		if (!text.includes("://")) return text;
		const segments: ShellToken[][] = [];
		let segment: ShellToken[] = [];
		for (const token of lexShellCommand(text)) {
			segment.push(token);
			if (token.kind === "separator" && /[\n;&|()]/.test(token.raw)) {
				segments.push(segment);
				segment = [];
			}
		}
		if (segment.length > 0) segments.push(segment);
		let out = "";
		for (const tokens of segments) {
			// `omp` resolves the URLs it is given itself (`omp read skill://x:1-20`):
			// its own command's arguments are its own, while a wrapper's arguments
			// (`npx --cache local://dir omp …`) still name host files.
			const omp = ompCommand(tokens.flatMap(token => (token.kind === "word" ? [token.value] : [])));
			let word = 0;
			for (const token of tokens) {
				if (token.kind === "separator") {
					out += token.raw;
					continue;
				}
				out += omp !== undefined && word >= omp ? token.raw : await this.#word(token.raw, token.value);
				word++;
			}
		}
		return out;
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
