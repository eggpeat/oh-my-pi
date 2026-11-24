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
/** An unquoted redirection operator that opens a file (`<local://in`, `2>>local://log`). */
const REDIRECT = /^\d*(?:&>>|&>|<>>|<>|>>|<<|>|>|<|<)/;
/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: a here-document and its delimiter. */
const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([A-Za-z_][A-Za-z0-9_./:@%+=,-]*))/g;
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
	const name = launcherName(word);
	return name === "omp";
}

/** The last path segment of `word`: the program's name. */
function programName(word: string): string {
	return word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
}

/** A launcher's name: the last path segment, lowercased, without a Windows script suffix. */
function launcherName(word: string): string {
	const name = programName(word).toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".ps1"]) {
		if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
	}
	return name;
}

/** `NAME=value`, as a simple command or a wrapper's options take before the command. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Reserved words that may precede a simple command and are not one. */
const NO_COMMAND_KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"while",
	"until",
	"do",
	"done",
	"for",
	"in",
	"case",
	"esac",
	"select",
	"function",
	"coproc",
	"!",
	"{",
	"}",
	"[[",
	"]]",
	"noglob",
]);

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
	short: "pcw",
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
const BUN_GLOBAL: OptionValues = {
	short: "",
	long: [
		"cwd",
		"env-file",
		"preload",
		"require",
		"import",
		"define",
		"loader",
		"conditions",
		"main-fields",
		"tsconfig",
		"port",
		"config",
	],
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
const NPM_EXEC: OptionValues = {
	short: "cw",
	long: [
		"package",
		"call",
		"workspace",
		"prefix",
		"cache",
		"registry",
		"userconfig",
		"loglevel",
		"log-level",
		"location",
		"tag",
		"otp",
		"before",
		"script-shell",
	],
};
const PNPM: OptionValues = { short: "C", long: ["dir", "filter"] };
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

interface CommandWord {
	/** Index of the command word itself; for `env -S`, first word of the split string. */
	index: number;
	/** The command word itself; for `env -S`, first word of the split string. */
	word: string;
}

interface CommandParse {
	/** The program the command line runs, after any wrappers. `undefined` when there is none. */
	command: CommandWord | undefined;
	/** The `NAME=value` words the command inherits. */
	settings: number[];
}

/**
 * The command word a simple command runs and the settings it inherits, after leading
 * assignments, shell keywords and redirections, and any wrapper chain (`nice omp …`,
 * `npx omp …`). A word spelled `omp` anywhere else (`grep omp …`) is an argument.
 */
function commandWord(words: readonly string[], from = 0): CommandParse {
	const settings: number[] = [];
	let at = from;
	while (at < words.length) {
		const word = words[at];
		if (ASSIGNMENT.test(word)) {
			settings.push(at);
			at++;
			continue;
		}
		if (NO_COMMAND_KEYWORDS.has(word)) {
			at++;
			continue;
		}
		const redirect = skipRedirects(words, at);
		if (redirect > 0) {
			at += redirect;
			continue;
		}
		break;
	}
	if (at >= words.length) return { settings, command: undefined };
	const next = wrapperCommand(words, at);
	if (next === undefined) return { settings, command: { index: at, word: words[at] } };
	settings.push(...next.settings);
	return { settings, command: next.command };
}

/** The command a wrapper at `at` runs, or `undefined` when `words[at]` is no known wrapper. */
function wrapperCommand(words: readonly string[], at: number): CommandParse | undefined {
	const after = (values: OptionValues, dash = false) => afterOptions(words, at + 1, values, dash);
	const commandAt = (next: number): CommandParse | undefined => {
		if (next <= at || next >= words.length) return undefined;
		return commandWord(words, next);
	};
	switch (launcherName(words[at])) {
		case "nice":
			return commandAt(after(NICE));
		case "nohup":
			return commandAt(after(NOHUP));
		case "time":
			return commandAt(after(TIME));
		case "env":
			return envCommand(words, at);
		case "sudo":
			return settingsCommand(words, at, after(SUDO));
		case "doas":
			return settingsCommand(words, at, after(DOAS));
		case "timeout":
		case "gtimeout":
			return commandAt(after(TIMEOUT) + 1);
		case "stdbuf":
			return commandAt(after(STDBUF));
		case "setsid":
			return commandAt(after(SETSID));
		case "xargs":
			return commandAt(after(XARGS));
		case "ifne":
			return commandAt(after(IFNE));
		case "npx":
			return commandAt(after(NPX));
		case "bunx":
			return commandAt(after(BUNX));
		case "bun": {
			const sub = after(BUN_GLOBAL);
			if (words[sub] !== "x") return undefined;
			return commandAt(afterOptions(words, sub + 1, BUNX));
		}
		case "npm": {
			const sub = after(NPM_GLOBAL);
			if (words[sub] !== "exec" && words[sub] !== "x") return undefined;
			return commandAt(afterOptions(words, sub + 1, NPM_EXEC));
		}
		case "pnpm": {
			const sub = after(PNPM);
			if (words[sub] !== "exec") return undefined;
			return commandAt(afterOptions(words, sub + 1, PNPM));
		}
		case "uv":
			return uvCommand(words, at);
		case "ssh": {
			const host = after(SSH);
			if (host >= words.length) return undefined;
			return commandAt(afterOptions(words, host + 1, SSH));
		}
		case "command": {
			const next = after(COMMAND);
			const namesOnly = words.slice(at + 1, next).some(word => /^-[^-]/.test(word) && /[vV]/.test(word));
			return namesOnly ? undefined : commandAt(next);
		}
		case "exec":
			return commandAt(after(EXEC));
		default:
			return undefined;
	}
}

/** `sudo`/`doas`: the command after options and `NAME=value` settings, which stay its own. */
function settingsCommand(words: readonly string[], at: number, options: number): CommandParse | undefined {
	const settings: number[] = [];
	let i = options;
	while (i < words.length && ASSIGNMENT.test(words[i])) {
		settings.push(i);
		i++;
	}
	if (i >= words.length) return { settings, command: undefined };
	const parsed = commandWord(words, i);
	if (parsed.command === undefined) return { settings, command: undefined };
	settings.push(...parsed.settings);
	return { settings, command: parsed.command };
}

/**
 * `env [options] [NAME=value…] command`: options come first, then the settings the
 * command inherits, then the command. `-S`/`--split-string` names the command inside
 * its value instead.
 */
function envCommand(words: readonly string[], at: number): CommandParse | undefined {
	const settings: number[] = [];
	let i = at + 1;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") {
			i++;
			break;
		}
		if (word === "-") {
			i++;
			continue;
		}
		if (word === "-S" || word === "--split-string") {
			const value = words[i + 1];
			return splitStringCommand(value, i, settings);
		}
		if (word.startsWith("--split-string=")) return splitStringCommand(word.slice(15), i, settings);
		if (word.startsWith("-S") && word.length > 2) return splitStringCommand(word.slice(2), i, settings);
		if (word.startsWith("-")) {
			i += optionWords(word, ENV);
			continue;
		}
		break;
	}
	// `env` takes `NAME=value` settings after its options; coreutils does not
	// validate the name, and a lone `-` is a setting too.
	while (i < words.length && (words[i] === "-" || words[i].includes("="))) {
		if (words[i] !== "-") settings.push(i);
		i++;
	}
	if (i >= words.length) return { settings, command: undefined };
	const parsed = commandWord(words, i);
	settings.push(...parsed.settings);
	return { settings, command: parsed.command };
}

/**
 * The command inside `env -S`'s `value`: split like the shell does, then parsed as
 * its own command line. `option` stands in for every word inside the string.
 */
function splitStringCommand(value: string | undefined, option: number, settings: number[]): CommandParse {
	if (value === undefined) return { settings, command: undefined };
	const argv = splitStringWords(value);
	if (argv.length === 0) return { settings, command: undefined };
	const parsed = commandWord(argv);
	if (parsed.settings.length > 0) settings.push(option);
	const command = parsed.command === undefined ? undefined : { index: option, word: parsed.command.word };
	return { settings, command };
}

/** `text` split into words the way `env -S` splits it: whitespace, with quotes and `\`. */
function splitStringWords(text: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === "'") {
			if (ch === "'") quote = "";
			else word += ch;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 < text.length) word += text[++i];
			continue;
		}
		if (quote !== "") {
			if (ch === quote) quote = "";
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (word !== "") {
				words.push(word);
				word = "";
			}
			continue;
		}
		word += ch;
	}
	if (word !== "") words.push(word);
	return words;
}

/** `uv [options] run [options] command`: `-m`/`--module` runs a module, not an executable. */
function uvCommand(words: readonly string[], at: number): CommandParse | undefined {
	const sub = afterOptions(words, at + 1, UV_GLOBAL);
	if (words[sub] !== "run") return undefined;
	let i = sub + 1;
	while (i < words.length) {
		const word = words[i];
		if (word === "--") {
			i++;
			break;
		}
		if (word === "-" || !word.startsWith("-")) break;
		if (word === "-m" || word === "--module" || word.startsWith("--module=")) return undefined;
		i += optionWords(word, UV_RUN);
	}
	if (i >= words.length) return undefined;
	return commandWord(words, i);
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

/** Any redirection operator, attached or separate (`>`, `2>`, `<<EOF`, `<<<x`, `2>&1`). */
const REDIRECT_OP = /^\d*(?:&>>|&>|<<<|<<|<&|<>|>&|>>|>|>|<|<)/;

/** A file redirection as a whole word, whose target is the next word (`>`, `2>`, `<>`, `<`). */
const REDIRECT_FILE_WORD = /^\d*(?:&>>|&>|<>|>>|>|<|<)$/;

/** The words one redirection occupies before the command: its own, plus a separate target. */
function skipRedirects(words: readonly string[], at: number): number {
	const match = REDIRECT_OP.exec(words[at]);
	if (!match) return 0;
	return match[0].length === words[at].length ? 2 : 1;
}

/** Whether `words[i]` is a redirection's file target (`>local://out`, `> out`). */
function redirectTarget(words: readonly string[], i: number): boolean {
	const own = REDIRECT.exec(words[i]);
	if (own && own[0].length < words[i].length) return true;
	return i > 0 && REDIRECT_FILE_WORD.test(words[i - 1]);
}

/** `find … -exec cmd \; -exec cmd +`: the word range each action's command occupies. */
function findActions(words: readonly string[], from: number): { start: number; end: number }[] {
	const actions: { start: number; end: number }[] = [];
	let i = from;
	while (i < words.length) {
		if (FIND_EXEC.has(words[i]) && words[i + 1] !== undefined && words[i + 1] !== ";" && words[i + 1] !== "+") {
			const start = i + 1;
			let end = start;
			while (end < words.length && words[end] !== ";" && words[end] !== "+") end++;
			actions.push({ start, end });
			i = end + 1;
		} else {
			i++;
		}
	}
	return actions;
}

/**
 * Which words of a simple command stay as written: the arguments and inherited settings
 * of an `omp` run itself. Its own command word (`nice local://bin/omp …` still needs the
 * executable) and a redirection's file target (`omp read local://in > local://out`,
 * which the shell opens rather than omp) still resolve.
 */
function literalArgs(words: readonly string[]): boolean[] {
	const literal = words.map(() => false);
	// A here-document's delimiter and a here-string's text are input, not file
	// targets (`cat << 'local://done'`, `cat <<< local://text`).
	for (let i = 0; i < words.length; i++) {
		const match = /^\d*<<(?:<|[-~])?/.exec(words[i]);
		if (!match) continue;
		literal[i] = true;
		if (match[0].length === words[i].length) literal[i + 1] = true;
	}
	const parsed = commandWord(words);
	if (parsed.command === undefined) return literal;
	if (launcherName(parsed.command.word) === "find") {
		for (const action of findActions(words, parsed.command.index + 1)) {
			const actionParse = commandWord(words.slice(action.start, action.end));
			const actionCommand = actionParse.command;
			if (actionCommand === undefined || !isOmp(actionCommand.word)) continue;
			for (const setting of actionParse.settings) literal[action.start + setting] = true;
			for (let i = actionCommand.index + 1; i < action.end - action.start; i++) {
				if (!redirectTarget(words, action.start + i)) literal[action.start + i] = true;
			}
		}
		return literal;
	}
	if (!isOmp(parsed.command.word)) return literal;
	for (const setting of parsed.settings) literal[setting] = true;
	for (let i = parsed.command.index + 1; i < words.length; i++) {
		if (!redirectTarget(words, i)) literal[i] = true;
	}
	return literal;
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
			// its own command's arguments stay as written, but a wrapper's own
			// file arguments, a redirection target, and a nested command are
			// still the shell's to resolve.
			const literal = literalArgs(tokens.flatMap(token => (token.kind === "word" ? [token.value] : [])));
			let word = 0;
			for (const token of tokens) {
				if (token.kind === "separator") {
					out += token.raw;
					continue;
				}
				out += literal[word] && !token.raw.includes("$(") ? token.raw : await this.#word(token.raw, token.value);
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
