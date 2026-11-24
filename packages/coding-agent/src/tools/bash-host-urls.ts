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
import { isShellEnvironmentAssignment, lexShellCommand, type ShellToken } from "./shell-tokenize";

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

/** Whether this process spells program names the way Windows does. */
const WINDOWS = process.platform === "win32";

/** The last path segment of `word`. `\` separates only where Windows does. */
function programName(word: string, windows: boolean): string {
	const slash = word.lastIndexOf("/");
	const back = windows ? word.lastIndexOf("\\") : -1;
	return word.slice(Math.max(slash, back) + 1);
}

/** `word` without a Windows script suffix (`npx.cmd`, `NPX.CMD`). */
function stripLauncherSuffix(word: string): string {
	const lower = word.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".ps1"]) {
		if (lower.endsWith(suffix)) return word.slice(0, -suffix.length);
	}
	return word;
}

/**
 * Whether `word` names the launcher `name`. Windows (and `cmd.exe`) reads
 * program names without regard to case and splits paths on `\`; a POSIX shell
 * does neither. A Windows script suffix never counts.
 */
function launcherIs(word: string, name: string, windows: boolean): boolean {
	const found = stripLauncherSuffix(programName(word, windows));
	return windows ? found.toLowerCase() === name : found === name;
}

/** Whether `word` names the `omp` program, by any path. */
function isOmp(word: string, windows: boolean): boolean {
	return launcherIs(word, "omp", windows);
}

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
	"in",
	"esac",
	"function",
	"coproc",
	"!",
	"{",
	"}",
	"[[",
	"]]",
	"noglob",
]);

/** Keywords whose following words name a variable or a pattern, not a command. */
const HEADER_KEYWORDS = new Set(["for", "case", "select"]);

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
	long: ["package", "registry", "cache-dir", "minimum-release-age", "cwd", "env-file", "cafile", "ca"],
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

/** A redirection operator and the kind of target it takes. Longest first. */
const REDIRECTS: { operator: string; kind: "file" | "fd" | "here" }[] = [
	{ operator: "&>>", kind: "file" },
	{ operator: "&>", kind: "file" },
	{ operator: "<<<", kind: "here" },
	{ operator: "<<-", kind: "here" },
	{ operator: "<<", kind: "here" },
	{ operator: "<&", kind: "fd" },
	{ operator: ">&", kind: "fd" },
	{ operator: "<>", kind: "file" },
	{ operator: ">>", kind: "file" },
	{ operator: ">", kind: "file" },
	{ operator: "<", kind: "file" },
];

/** What a redirection's target is. */
type Target = "file" | "fd" | "here";

/**
 * The redirection operator `text` starts at `at`, or `undefined`: the span it
 * occupies. A run of digits before it is its descriptor, but only at the
 * word's own start (`2>>log`; `a2>b` keeps `a2` an argument).
 */
function matchOperator(text: string, at: number): { start: number; end: number; kind: Target } | undefined {
	let op = at;
	if (at === 0) {
		while (op < text.length && text[op] >= "0" && text[op] <= "9") op++;
	}
	const rest = text.slice(op);
	for (const { operator, kind } of REDIRECTS) {
		if (rest.startsWith(operator)) return { start: at, end: op + operator.length, kind };
	}
	return undefined;
}

/** One piece of a word: text, or a redirection operator or its target. */
interface Piece {
	raw: string;
	value: string;
	operator?: boolean;
	target?: Target;
}

/** The pieces of `raw` (`2>out` is `2>` then `out`). Quotes stay text. */
function wordPieces(raw: string): Piece[] {
	const pieces: Piece[] = [];
	let text = "";
	let value = "";
	let quote = "";
	const flush = () => {
		if (text !== "") pieces.push({ raw: text, value });
		text = "";
		value = "";
	};
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i];
		if (quote !== "") {
			if (ch === quote) {
				quote = "";
				text += ch;
			} else if (ch === "\\" && quote === '"' && i + 1 < raw.length) {
				text += ch + raw[i + 1];
				value += raw[i + 1];
				i++;
			} else {
				text += ch;
				value += ch;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			text += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < raw.length) {
			text += ch + raw[i + 1];
			value += raw[i + 1];
			i++;
			continue;
		}
		const operator = matchOperator(raw, i);
		if (operator) {
			flush();
			const op = raw.slice(operator.start, operator.end);
			pieces.push({ raw: op, value: op, operator: true });
			i = operator.end - 1;
			continue;
		}
		text += ch;
		value += ch;
	}
	flush();
	for (let i = 0; i < pieces.length - 1; i++) {
		const operator = pieces[i].operator ? matchOperator(pieces[i].raw, 0) : undefined;
		if (operator && operator.end === pieces[i].raw.length) pieces[i + 1].target = operator.kind;
	}
	return pieces;
}

/** A word of a command. */
interface Word {
	raw: string;
	value: string;
	/** Set when the previous word was a redirection operator by itself. */
	target?: Target;
}

/** A command's words and the tokens that spell it. */
interface Segment {
	tokens: ShellToken[];
	words: Word[];
}

/** The commands in `text`. `cmd` reads a backslash as an ordinary character. */
function scanCommands(text: string, cmd: boolean): Segment[] {
	const tokens = lexShellCommand(text);
	const segments: Segment[] = [];
	let current: ShellToken[] = [];
	let words: Word[] = [];
	let expectTarget: Target | undefined;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.kind === "separator") {
			const previous = tokens[i - 1];
			const next = tokens[i + 1];
			// The `&` of `2>&1` belongs to the redirection, not a command split.
			const fdDup =
				token.raw === "&" &&
				((previous?.kind === "word" && /[<>0-9]$/.test(previous.raw)) ||
					(next?.kind === "word" && /^[0-9]/.test(next.raw)));
			if (!fdDup && /[;&|()\n]/.test(token.raw)) {
				current.push(token);
				segments.push({ tokens: current, words });
				current = [];
				words = [];
				expectTarget = undefined;
				continue;
			}
			current.push(token);
			if (fdDup) expectTarget = "fd";
			continue;
		}
		const word: Word = { raw: token.raw, value: cmd ? cmdValue(token.raw) : token.value, target: expectTarget };
		expectTarget = undefined;
		const operator = matchOperator(token.raw, 0);
		if (operator && operator.start === 0 && operator.end === token.raw.length) expectTarget = operator.kind;
		words.push(word);
		current.push(token);
	}
	if (current.length > 0 || words.length > 0) segments.push({ tokens: current, words });
	return segments;
}

/** A word as `cmd.exe` reads it: `\` is not an escape (`C:\bin\npx.cmd`). */
function cmdValue(raw: string): string {
	const quote = raw[0];
	if ((quote === '"' || quote === "'") && raw.length > 1 && raw.endsWith(quote)) return raw.slice(1, -1);
	return raw;
}

/** `env -S`'s split string and where its words sit. */
interface Split {
	option: number;
	value: number;
	/** Text of the value word before the split string (`-S` when attached). */
	lead: string;
	text: string;
	words: { start: number; end: number; value: string }[];
	/** Entry index of each split word, filled by {@link expandEntries}. */
	entries: number[];
}

/** `env -S` in `words`, or `undefined` when this command has none. */
function findSplit(words: readonly Word[], windows: boolean): Split | undefined {
	for (let i = 0; i < words.length; i++) {
		if (!launcherIs(words[i].value, "env", windows)) continue;
		let j = i + 1;
		while (j < words.length) {
			const option = words[j].value;
			if (option === "-S" || option === "--split-string") {
				const value = j + 1;
				if (value >= words.length) return undefined;
				const text = words[value].value;
				return { option: j, value, lead: "", text, words: splitStringSpans(text), entries: [] };
			}
			let lead = "";
			let text: string | undefined;
			if (option.startsWith("--split-string=")) {
				lead = "--split-string=";
				text = option.slice(lead.length);
			} else if (option.startsWith("-S") && option.length > 2) {
				lead = "-S";
				text = option.slice(2);
			}
			if (text !== undefined) {
				return { option: j, value: j, lead, text, words: splitStringSpans(text), entries: [] };
			}
			if (option === "--") break;
			if (option === "-") {
				j++;
				continue;
			}
			if (!option.startsWith("-")) break;
			j += optionWords(option, ENV);
		}
		return undefined;
	}
	return undefined;
}

/** `text` split the way `env -S` splits it, each word with its span in `text`. */
function splitStringSpans(text: string): { start: number; end: number; value: string }[] {
	const words: { start: number; end: number; value: string }[] = [];
	let i = 0;
	while (i < text.length) {
		while (i < text.length && /\s/.test(text[i])) i++;
		if (i >= text.length) break;
		let value = "";
		let quote = "";
		let contentStart = -1;
		let contentEnd = i;
		while (i < text.length) {
			const ch = text[i];
			if (quote === "'") {
				if (ch === "'") quote = "";
				else {
					if (contentStart < 0) contentStart = i;
					contentEnd = i + 1;
					value += ch;
				}
				i++;
				continue;
			}
			if (ch === "\\" && i + 1 < text.length) {
				if (contentStart < 0) contentStart = i;
				contentEnd = i + 2;
				value += text[i + 1];
				i += 2;
				continue;
			}
			if (quote !== "") {
				if (ch === quote) quote = "";
				else {
					if (contentStart < 0) contentStart = i;
					contentEnd = i + 1;
					value += ch;
				}
				i++;
				continue;
			}
			if (ch === "'" || ch === '"') {
				quote = ch;
				i++;
				continue;
			}
			if (/\s/.test(ch)) break;
			if (contentStart < 0) contentStart = i;
			contentEnd = i + 1;
			value += ch;
			i++;
		}
		words.push({ start: contentStart < 0 ? i : contentStart, end: contentEnd, value });
	}
	return words;
}

/** A word as the command analysis sees it. */
interface Entry {
	value: string;
	target?: Target;
}

/** A command's words, with `env -S` expanded the way `env` runs it. */
interface Expanded {
	entries: Entry[];
	/** Command-word index of each entry, or -1 for a word only the split string holds. */
	entryOf: number[];
	split?: Split;
}

function expandEntries(words: readonly Word[], windows: boolean): Expanded {
	const split = findSplit(words, windows);
	if (split === undefined) {
		return {
			entries: words.map(word => ({ value: word.value, target: word.target })),
			entryOf: words.map((_, index) => index),
		};
	}
	const entries: Entry[] = [];
	const entryOf = words.map(() => -1);
	for (let i = 0; i < words.length; i++) {
		// The value word first: an attached `-Stext` is option and value in one.
		if (i === split.value) {
			for (const word of split.words) {
				split.entries.push(entries.length);
				entries.push({ value: word.value });
			}
			continue;
		}
		if (i === split.option) continue;
		entryOf[i] = entries.length;
		entries.push({ value: words[i].value, target: words[i].target });
	}
	return { entries, entryOf, split };
}

interface CommandParse {
	command: { index: number; word: string } | undefined;
	settings: number[];
}

/**
 * The command word a simple command runs, after assignments, shell keywords,
 * redirections and any wrapper chain. A word spelled `omp` anywhere else is
 * an argument. Walks the wrapper chain in a loop.
 */
function commandWord(entries: readonly Entry[], windows: boolean, from = 0): CommandParse {
	const settings: number[] = [];
	let at = from;
	while (at < entries.length) {
		const entry = entries[at];
		if (isShellEnvironmentAssignment(entry.value)) {
			settings.push(at);
			at++;
			continue;
		}
		if (HEADER_KEYWORDS.has(entry.value)) return { settings, command: undefined };
		if (NO_COMMAND_KEYWORDS.has(entry.value) || entry.target !== undefined || matchOperator(entry.value, 0)) {
			at++;
			continue;
		}
		break;
	}
	if (at >= entries.length) return { settings, command: undefined };
	for (;;) {
		const next = wrapperCommand(entries, at, windows);
		if (next === undefined) break;
		settings.push(...next.settings);
		at = next.index;
		while (at < entries.length && isShellEnvironmentAssignment(entries[at].value)) {
			settings.push(at);
			at++;
		}
		if (at >= entries.length) return { settings, command: undefined };
	}
	return { settings, command: { index: at, word: entries[at].value } };
}

/** The command a wrapper at `at` runs, or `undefined` when it is not one. */
function wrapperCommand(
	entries: readonly Entry[],
	at: number,
	windows: boolean,
): { index: number; settings: number[] } | undefined {
	const word = entries[at].value;
	const after = (values: OptionValues, dash = false) => afterOptions(entries, at + 1, values, dash);
	const commandAt = (next: number): { index: number; settings: number[] } | undefined =>
		next > at && next < entries.length ? { index: next, settings: [] } : undefined;
	if (launcherIs(word, "nice", windows)) return commandAt(after(NICE));
	if (launcherIs(word, "nohup", windows)) return commandAt(after(NOHUP));
	if (launcherIs(word, "time", windows)) return commandAt(after(TIME));
	if (launcherIs(word, "env", windows)) return envCommand(entries, at);
	if (launcherIs(word, "sudo", windows)) return settingsCommand(entries, after(SUDO));
	if (launcherIs(word, "doas", windows)) return settingsCommand(entries, after(DOAS));
	if (launcherIs(word, "timeout", windows) || launcherIs(word, "gtimeout", windows)) {
		return commandAt(after(TIMEOUT) + 1);
	}
	if (launcherIs(word, "stdbuf", windows)) return commandAt(after(STDBUF));
	if (launcherIs(word, "setsid", windows)) return commandAt(after(SETSID));
	if (launcherIs(word, "xargs", windows)) return commandAt(after(XARGS));
	if (launcherIs(word, "ifne", windows)) return commandAt(after(IFNE));
	if (launcherIs(word, "npx", windows)) return commandAt(after(NPX));
	if (launcherIs(word, "bunx", windows)) return commandAt(after(BUNX));
	if (launcherIs(word, "bun", windows)) {
		const sub = after(BUN_GLOBAL);
		if (entries[sub]?.value !== "x") return undefined;
		return commandAt(afterOptions(entries, sub + 1, BUNX));
	}
	if (launcherIs(word, "npm", windows)) {
		const sub = after(NPM_GLOBAL);
		if (entries[sub]?.value !== "exec" && entries[sub]?.value !== "x") return undefined;
		return commandAt(afterOptions(entries, sub + 1, NPM_EXEC));
	}
	if (launcherIs(word, "pnpm", windows)) {
		const sub = after(PNPM);
		if (entries[sub]?.value !== "exec") return undefined;
		return commandAt(afterOptions(entries, sub + 1, PNPM));
	}
	if (launcherIs(word, "uv", windows)) return uvCommand(entries, at);
	if (launcherIs(word, "ssh", windows)) {
		const host = after(SSH);
		if (host >= entries.length) return undefined;
		return commandAt(afterOptions(entries, host + 1, SSH));
	}
	if (launcherIs(word, "command", windows)) {
		const next = after(COMMAND);
		const namesOnly = entries
			.slice(at + 1, next)
			.some(entry => /^-[^-]/.test(entry.value) && /[vV]/.test(entry.value));
		return namesOnly ? undefined : commandAt(next);
	}
	if (launcherIs(word, "exec", windows)) return commandAt(after(EXEC));
	return undefined;
}

/** `sudo`/`doas`: the command after options and the settings it inherits. */
function settingsCommand(
	entries: readonly Entry[],
	options: number,
): { index: number; settings: number[] } | undefined {
	const settings: number[] = [];
	let i = options;
	while (i < entries.length && isShellEnvironmentAssignment(entries[i].value)) {
		settings.push(i);
		i++;
	}
	return i < entries.length ? { index: i, settings } : undefined;
}

/** `env` after its options. A `-S` value is already expanded. */
function envCommand(entries: readonly Entry[], at: number): { index: number; settings: number[] } | undefined {
	const settings: number[] = [];
	let i = at + 1;
	while (i < entries.length) {
		const value = entries[i].value;
		if (value === "--") {
			i++;
			break;
		}
		if (value === "-") {
			i++;
			continue;
		}
		if (!value.startsWith("-")) break;
		i += optionWords(value, ENV);
	}
	while (i < entries.length && (entries[i].value === "-" || entries[i].value.includes("="))) {
		if (entries[i].value !== "-") settings.push(i);
		i++;
	}
	return i < entries.length ? { index: i, settings } : undefined;
}

/** `uv run`: `-m`/`--module` and `-s`/`--script` are not an executable launch. */
function uvCommand(entries: readonly Entry[], at: number): { index: number; settings: number[] } | undefined {
	const sub = afterOptions(entries, at + 1, UV_GLOBAL);
	if (entries[sub]?.value !== "run") return undefined;
	let i = sub + 1;
	while (i < entries.length) {
		const word = entries[i].value;
		if (word === "--") {
			i++;
			break;
		}
		if (word === "-" || !word.startsWith("-")) break;
		if (
			word === "-m" ||
			word === "--module" ||
			word.startsWith("--module=") ||
			word === "-s" ||
			word === "--script" ||
			word.startsWith("--script=")
		) {
			return undefined;
		}
		i += optionWords(word, UV_RUN);
	}
	return i < entries.length ? { index: i, settings: [] } : undefined;
}

/** The first word from `from` that is not an option or a redirection. */
function afterOptions(entries: readonly Entry[], from: number, values: OptionValues, dash = false): number {
	let at = from;
	while (at < entries.length) {
		const value = entries[at].value;
		if (value === "--") return at + 1;
		if (value === "-") {
			if (dash) {
				at++;
				continue;
			}
			return at;
		}
		// `nice 2>/dev/null -n 5 omp` — the redirection is not an option.
		if (entries[at].target !== undefined || matchOperator(value, 0)) {
			at++;
			continue;
		}
		if (!value.startsWith("-")) return at;
		at += optionWords(value, values);
	}
	return at;
}

/** The words one option occupies: its own, plus the next when its value is separate. */
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

/** `find … -exec cmd \; -exec cmd {} +`: each action's command word range. */
function findActions(entries: readonly Entry[], from: number): { start: number; end: number }[] {
	const actions: { start: number; end: number }[] = [];
	let i = from;
	while (i < entries.length) {
		if (FIND_EXEC.has(entries[i].value) && entries[i + 1] !== undefined && entries[i + 1].value !== ";") {
			const start = i + 1;
			let end = start;
			while (end < entries.length && entries[end].value !== ";") {
				// A batch ends only at `{} +`. Any other `+` is an argument.
				if (entries[end].value === "+" && entries[end - 1]?.value === "{}") break;
				end++;
			}
			actions.push({ start, end });
			i = end + 1;
		} else {
			i++;
		}
	}
	return actions;
}

/**
 * Which entries stay as written: the arguments and inherited settings of an
 * `omp` run. Its command word, a redirection's file target and a wrapper's
 * own file options still resolve.
 */
function literalArgs(entries: readonly Entry[], windows: boolean): boolean[] {
	const literal = entries.map(() => false);
	const parsed = commandWord(entries, windows);
	if (parsed.command === undefined) return literal;
	const keep = (index: number) => {
		const target = entries[index]?.target;
		return target === undefined || target === "here";
	};
	if (launcherIs(parsed.command.word, "find", windows)) {
		let inherited = false;
		for (const action of findActions(entries, parsed.command.index + 1)) {
			if (action.start >= action.end) continue;
			const actionParse = commandWord(entries.slice(action.start, action.end), windows);
			if (actionParse.command === undefined || !isOmp(actionParse.command.word, windows)) continue;
			inherited = true;
			for (const setting of actionParse.settings) literal[action.start + setting] = true;
			for (let i = actionParse.command.index + 1; i < action.end - action.start; i++) {
				if (keep(action.start + i)) literal[action.start + i] = true;
			}
		}
		if (inherited) {
			for (const setting of parsed.settings) literal[setting] = true;
		}
		return literal;
	}
	if (!isOmp(parsed.command.word, windows)) return literal;
	for (const setting of parsed.settings) literal[setting] = true;
	for (let i = parsed.command.index + 1; i < entries.length; i++) {
		if (keep(i)) literal[i] = true;
	}
	return literal;
}

/** `text` as one literal shell word. */
function quoteWord(text: string, cmd: boolean): string {
	if (text === "" || WORD_SAFE.test(text)) return text;
	return cmd ? `"${text}"` : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** `text` quoted the way `original` was. */
function requote(original: string, text: string, cmd: boolean): string {
	if (!cmd && original.startsWith("'")) return `'${text.replaceAll("'", `'\\''`)}'`;
	if (original.startsWith('"')) return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	return quoteWord(text, cmd);
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

interface MaskedSub {
	placeholder: string;
	prefix: string;
	suffix: string;
	text: string;
}

class HostUrls {
	readonly #backing: UrlBacking;
	readonly #cmd: boolean;
	/** Windows program-name rules: this process, or a `cmd.exe` command. */
	readonly #windows: boolean;
	readonly #resolved = new Map<string, Promise<string | undefined>>();

	constructor(backing: UrlBacking, cmd: boolean) {
		this.#backing = backing;
		this.#cmd = cmd;
		this.#windows = cmd || WINDOWS;
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
		// A substitution is a command of its own. Mask it so the outer command's
		// words stay the outer command's, then write it back rewritten.
		const masked = this.#mask(text);
		if (!masked.text.includes("://")) return await this.#restore(masked.text, masked.subs);
		const segments = scanCommands(masked.text, this.#cmd);
		let out = "";
		for (const segment of segments) {
			const expanded = expandEntries(segment.words, this.#windows);
			const literal = literalArgs(expanded.entries, this.#windows);
			let word = -1;
			for (const token of segment.tokens) {
				if (token.kind === "separator") {
					out += token.raw;
					continue;
				}
				word++;
				const current = segment.words[word];
				if (expanded.split !== undefined && word === expanded.split.value) {
					out += await this.#splitValue(expanded.split, literal, current);
					continue;
				}
				const entry = expanded.entryOf[word];
				out += await this.#word(current, entry >= 0 && literal[entry] === true);
			}
		}
		return await this.#restore(out, masked.subs);
	}

	/** `$(…)` and backtick regions replaced by placeholders that name no URL. */
	#mask(text: string): { text: string; subs: MaskedSub[] } {
		const subs: MaskedSub[] = [];
		let out = "";
		let quote = "";
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (quote === "'") {
				out += ch;
				if (ch === "'") quote = "";
				continue;
			}
			if (ch === "\\" && i + 1 < text.length) {
				out += ch + text[i + 1];
				i++;
				continue;
			}
			if (ch === '"') {
				quote = quote === '"' ? "" : '"';
				out += ch;
				continue;
			}
			if (ch === "'" && quote === "") {
				quote = "'";
				out += ch;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(" && text[i + 2] !== "(") {
				const end = substitutionEnd(text, i + 2);
				if (end >= 0) {
					const placeholder = `\u0001${subs.length}\u0002`;
					subs.push({ placeholder, prefix: "$(", suffix: ")", text: text.slice(i + 2, end) });
					out += placeholder;
					i = end;
					continue;
				}
			}
			if (ch === "`") {
				const end = text.indexOf("`", i + 1);
				if (end >= 0) {
					const placeholder = `\u0001${subs.length}\u0002`;
					subs.push({ placeholder, prefix: "`", suffix: "`", text: text.slice(i + 1, end) });
					out += placeholder;
					i = end;
					continue;
				}
			}
			out += ch;
		}
		return { text: out, subs };
	}

	async #restore(text: string, subs: readonly MaskedSub[]): Promise<string> {
		for (const sub of subs) {
			text = text.replaceAll(sub.placeholder, sub.prefix + (await this.#code(sub.text)) + sub.suffix);
		}
		return text;
	}

	/** One word, with the URLs the provider backs replaced by their files. */
	async #word(word: Word, literal: boolean): Promise<string> {
		let out = "";
		for (const piece of wordPieces(word.raw)) {
			if (piece.operator) {
				out += piece.raw;
				continue;
			}
			const target = piece.target ?? word.target;
			// A here-document delimiter and a descriptor stay as written. A file
			// target is opened by the shell, so it resolves whatever the command is.
			if (target === "here" || target === "fd" || (target === undefined && literal)) {
				out += piece.raw;
				continue;
			}
			out += await this.#resolve(piece.raw, piece.value);
		}
		return out;
	}

	/** An `env -S` value, with the words the provider backs rewritten in place. */
	async #splitValue(split: Split, literal: readonly boolean[], word: Word): Promise<string> {
		let text = split.lead + split.text.slice(0, split.words[0]?.start ?? split.text.length);
		for (let i = 0; i < split.words.length; i++) {
			const part = split.words[i];
			const rewritten = literal[split.entries[i] ?? -1] ? part.value : await this.#resolve(part.value, part.value);
			text += /\s/.test(rewritten) ? quoteWord(rewritten, this.#cmd) : rewritten;
			const end = i + 1 < split.words.length ? split.words[i + 1].start : split.text.length;
			text += split.text.slice(part.end, end);
		}
		return requote(word.raw, text, this.#cmd);
	}

	/** One piece naming a URL: its spelling with the file in place, or as written. */
	async #resolve(raw: string, value: string): Promise<string> {
		const at = urlStart(value);
		if (at === undefined) return raw;
		const url = value.slice(at);
		if (namesNothing(url)) return raw;
		const host = await this.#host(url);
		if (host === undefined) return raw;
		if (/\s/.test(url) && !(await fs.lstat(host).then(Boolean, () => false))) return raw;
		return spellWord(value.slice(0, at), host, url, this.#cmd, raw.endsWith(url));
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
