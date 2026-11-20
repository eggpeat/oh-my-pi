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
import { ompLaunch } from "./shell-launch";

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
/** A redirection fd prefix (`2`, `{fd}`). */
const FD_PREFIX = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
/** A here-string operator (`<<<`, `0<<<`). */
const HERESTRING_OP = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?<<</;
/** A here-document operator (`<<`, `<<-`). */
const HEREDOC_OP = /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?<<-?/;
/** An fd-duplication operator (`<&`, `0<&`, `2>&`, `{fd}>&`; bare `>&` redirects a file in bash). */
const FD_REDIRECT_OP = /^(?:(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?<&|(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})>&)/;
/** An unquoted file-redirection operator (`<`, `>`, `>>`, `<>`, `>|`, `&>`, `&>>`, `>&`). */
const FILE_REDIRECT_OP = /^(?:&>>|&>|>&|(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<>|>>|>\||<|>))/;
/** `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`: a here-document and its delimiter. */
const HEREDOC = /(?<!<)<<(-?)(?!<)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([^\s;&|()<>'"]+))/g;
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

interface HostToken {
	kind: "word" | "separator";
	raw: string;
	value: string;
	splits: boolean;
}

interface CaseFrame {
	depth: number;
	phase: "word" | "in" | "pattern" | "body";
	seenWord: boolean;
	patternStart: boolean;
}

const CASE_WORD_END = /[\s;&|()<>]/;
const CASE_KEYWORD = /[a-z]+/y;
const COMMAND_INTRO = new Set(["if", "then", "do", "else", "elif", "while", "until", "time"]);

/** Whole lowercase keyword at `index` if terminated by a shell word boundary (not `=`, `-`, etc.). */
function readKeyword(text: string, index: number): string | undefined {
	CASE_KEYWORD.lastIndex = index;
	const word = CASE_KEYWORD.exec(text)?.[0];
	if (!word) return undefined;
	const after = index + word.length;
	return after >= text.length || CASE_WORD_END.test(text[after]!) ? word : undefined;
}

/** The end of a backtick command substitution opened just before `start`: the index of its closing `` ` ``, or -1. */
function backtickEnd(text: string, start: number): number {
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "`") return i;
	}
	return -1;
}

/** The end of the `$((` arithmetic expansion opened just before `start` in `text`: the index of its closing `)`, or -1. */
function arithmeticEnd(text: string, start: number): number {
	let depth = 2;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i;
	}
	return -1;
}

/** The end of the `$(` / `<(` / `>(` substitution opened just before `start` in `text`: the index of its `)`, or -1. */
function substitutionEnd(text: string, start: number): number {
	let depth = 1;
	let quote = "";
	let commandStart = true;
	let wordStart = true;
	// Track POSIX case grammar and comments so pattern `)` and commented `)` do not close the
	// substitution, and words like `case=ok` or a pattern named `case` do not open a case block.
	const cases: CaseFrame[] = [];
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		const top = cases.at(-1);
		const atCase = top !== undefined && top.depth === depth;
		if (quote === "'") {
			if (ch === "'") quote = "";
			continue;
		}
		if (ch === "\\") {
			if (!quote) {
				commandStart = false;
				wordStart = false;
				if (atCase) {
					if (top.phase === "word") top.seenWord = true;
					else if (top.phase === "pattern") top.patternStart = false;
				}
			}
			i++;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = "";
			else if (ch === "$" && text[i + 1] === "(") {
				const nested = text[i + 2] === "(" ? arithmeticEnd(text, i + 3) : substitutionEnd(text, i + 2);
				if (nested >= 0) i = nested;
			} else if (ch === "`") {
				const nested = backtickEnd(text, i + 1);
				if (nested >= 0) i = nested;
			}
			continue;
		}
		if (ch === "#" && wordStart) {
			while (i + 1 < text.length && text[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === "`") {
			const nested = backtickEnd(text, i + 1);
			if (nested >= 0) i = nested;
			commandStart = false;
			wordStart = false;
			if (atCase) {
				if (top.phase === "word") top.seenWord = true;
				else if (top.phase === "pattern") top.patternStart = false;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			commandStart = false;
			wordStart = false;
			if (atCase) {
				if (top.phase === "word") top.seenWord = true;
				else if (top.phase === "pattern") top.patternStart = false;
			}
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
			if (atCase && top.phase === "word" && top.seenWord) top.phase = "in";
			if (ch === "\n") commandStart = true;
			wordStart = true;
			continue;
		}
		if (ch === ";") {
			wordStart = true;
			if (atCase && top.phase === "body" && (text[i + 1] === ";" || text[i + 1] === "&")) {
				const second = text[++i];
				if (second === ";" && text[i + 1] === "&") i++;
				top.phase = "pattern";
				top.patternStart = true;
				commandStart = true;
				continue;
			}
			commandStart = true;
			continue;
		}
		if (ch === "&" || ch === "|") {
			wordStart = true;
			if (atCase && top.phase === "pattern") {
				top.patternStart = false;
				continue;
			}
			commandStart = true;
			continue;
		}
		if (ch === "<" || ch === ">") {
			wordStart = true;
			continue;
		}
		if (ch === "(") {
			wordStart = true;
			if (atCase && top.phase === "pattern" && top.patternStart) {
				// Optional leading `(` before a POSIX case pattern: `case x in (a) ...`
				top.patternStart = false;
				continue;
			}
			if (atCase && top.phase === "word") top.seenWord = true;
			else if (atCase && top.phase === "pattern") top.patternStart = false;
			depth++;
			commandStart = true;
			continue;
		}
		if (ch === ")") {
			wordStart = true;
			if (atCase && top.phase === "pattern") {
				top.phase = "body";
				commandStart = true;
				continue;
			}
			if (--depth === 0) return i;
			commandStart = true;
			continue;
		}
		if (atCase && top.phase === "word") {
			top.seenWord = true;
			commandStart = false;
			wordStart = false;
			continue;
		}
		if (atCase && top.phase === "in") {
			if (wordStart && readKeyword(text, i) === "in") {
				top.phase = "pattern";
				top.patternStart = true;
				i += 1;
				wordStart = false;
				continue;
			}
			commandStart = false;
			wordStart = false;
			continue;
		}
		if (atCase && top.phase === "pattern") {
			if (top.patternStart && wordStart && readKeyword(text, i) === "esac") {
				cases.pop();
				i += 3;
				commandStart = false;
				wordStart = false;
				continue;
			}
			top.patternStart = false;
			commandStart = false;
			wordStart = false;
			continue;
		}
		if (commandStart && wordStart) {
			if ((ch === "{" || ch === "!") && (i + 1 >= text.length || CASE_WORD_END.test(text[i + 1]!))) {
				commandStart = true;
				wordStart = false;
				continue;
			}
			const word = readKeyword(text, i);
			if (word === "case") {
				cases.push({ depth, phase: "word", seenWord: false, patternStart: false });
				commandStart = false;
				wordStart = false;
				i += 3;
			} else if (word === "esac" && atCase && top.phase === "body") {
				cases.pop();
				commandStart = false;
				wordStart = false;
				i += 3;
			} else if (word && COMMAND_INTRO.has(word)) {
				commandStart = true;
				wordStart = false;
				i += word.length - 1;
			} else {
				commandStart = false;
				wordStart = false;
			}
			continue;
		}
		wordStart = false;
	}
	return -1;
}

/**
 * Lex shell command text into words and separators while keeping `$(…)`, `$((…))`,
 * `<(…)`, `>(…)`, and `` `…` `` intact inside words, honoring `\`-newline continuations
 * without splitting commands, skipping `#` comments, splitting unquoted redirects even
 * without spaces, and preserving literal backslashes under cmd/PowerShell.
 */
function lexHostCommand(command: string, cmd: boolean, powershell: boolean): HostToken[] {
	const backslashLiteral = cmd || powershell;
	const posix = !cmd && !powershell;
	const tokens: HostToken[] = [];
	let value = "";
	let wordStart = -1;
	let sepStart = -1;
	let sepSplits = false;
	let inSingle = false;
	let inDouble = false;
	let lastUnquotedRedir = false;
	const startWord = (index: number) => {
		if (wordStart >= 0) return;
		if (sepStart >= 0) {
			tokens.push({ kind: "separator", raw: command.slice(sepStart, index), value: "", splits: sepSplits });
			sepStart = -1;
			sepSplits = false;
		}
		wordStart = index;
	};
	const endWord = (index: number) => {
		if (wordStart < 0) return;
		tokens.push({ kind: "word", raw: command.slice(wordStart, index), value, splits: false });
		value = "";
		wordStart = -1;
		lastUnquotedRedir = false;
	};
	const pushSep = (index: number, splits: boolean) => {
		endWord(index);
		if (sepStart < 0) sepStart = index;
		if (splits) sepSplits = true;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else value += ch;
			continue;
		}
		if (inDouble) {
			if (!backslashLiteral && ch === "\\" && i + 1 < command.length) {
				const next = command[i + 1]!;
				if (next === "\n") {
					i++;
					continue;
				}
				if (next === "\r" && command[i + 2] === "\n") {
					i += 2;
					continue;
				}
				if (next === '"' || next === "\\" || next === "$" || next === "`") {
					value += next;
					i++;
					continue;
				}
			}
			if (ch === '"') {
				inDouble = false;
				continue;
			}
			if (!cmd && ch === "$" && command[i + 1] === "(") {
				const end = command[i + 2] === "(" ? arithmeticEnd(command, i + 3) : substitutionEnd(command, i + 2);
				if (end >= 0) {
					value += command.slice(i, end + 1);
					i = end;
					continue;
				}
			}
			if (posix && ch === "`") {
				const end = backtickEnd(command, i + 1);
				if (end >= 0) {
					value += command.slice(i, end + 1);
					i = end;
					continue;
				}
			}
			value += ch;
			continue;
		}
		if (!backslashLiteral && ch === "\\") {
			const step = command[i + 1] === "\n" ? 1 : command[i + 1] === "\r" && command[i + 2] === "\n" ? 2 : 0;
			if (step > 0) {
				if (wordStart < 0 && sepStart < 0) sepStart = i;
				i += step;
				continue;
			}
		}
		if (posix && ch === "#" && wordStart < 0) {
			if (sepStart < 0) sepStart = i;
			while (i + 1 < command.length && command[i + 1] !== "\n") i++;
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushSep(i, false);
			continue;
		}
		if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
			pushSep(i, true);
			continue;
		}
		if (ch === "&") {
			if (lastUnquotedRedir) {
				value += ch;
				lastUnquotedRedir = false;
				continue;
			}
			if (command[i + 1] === ">" && (i === 0 || command[i - 1] !== "&")) {
				endWord(i);
				startWord(i);
				value += ch;
				lastUnquotedRedir = true;
				continue;
			}
			pushSep(i, true);
			continue;
		}
		if (ch === "|") {
			if (lastUnquotedRedir && command[i - 1] === ">") {
				value += ch;
				lastUnquotedRedir = false;
				continue;
			}
			pushSep(i, true);
			continue;
		}
		if (posix && (ch === "<" || ch === ">") && command[i + 1] === "(") {
			startWord(i);
			lastUnquotedRedir = false;
			const end = substitutionEnd(command, i + 2);
			if (end >= 0) {
				value += command.slice(i, end + 1);
				i = end;
				continue;
			}
		}
		if (ch === "<" || ch === ">") {
			if (!lastUnquotedRedir) {
				if (wordStart >= 0 && !FD_PREFIX.test(command.slice(wordStart, i))) {
					endWord(i);
				}
				startWord(i);
			}
			value += ch;
			lastUnquotedRedir = true;
			continue;
		}
		startWord(i);
		if (!cmd && ch === "'") {
			inSingle = true;
			lastUnquotedRedir = false;
		} else if (ch === '"') {
			inDouble = true;
			lastUnquotedRedir = false;
		} else if (!backslashLiteral && ch === "\\" && i + 1 < command.length) {
			value += command[i + 1]!;
			i++;
			lastUnquotedRedir = false;
		} else if (!cmd && ch === "$" && command[i + 1] === "(") {
			lastUnquotedRedir = false;
			const end = command[i + 2] === "(" ? arithmeticEnd(command, i + 3) : substitutionEnd(command, i + 2);
			if (end >= 0) {
				value += command.slice(i, end + 1);
				i = end;
			} else {
				value += ch;
			}
		} else if (posix && ch === "`") {
			lastUnquotedRedir = false;
			const end = backtickEnd(command, i + 1);
			if (end >= 0) {
				value += command.slice(i, end + 1);
				i = end;
			} else {
				value += ch;
			}
		} else {
			value += ch;
			lastUnquotedRedir = false;
		}
	}
	endWord(command.length);
	if (sepStart >= 0) {
		tokens.push({ kind: "separator", raw: command.slice(sepStart), value: "", splits: sepSplits });
	}
	return tokens;
}

/** Reserved words that introduce the simple command which follows them. */
const COMMAND_PREFIX = new Set(["if", "then", "elif", "else", "while", "until", "do", "!", "{", "}"]);

interface TokenProtection {
	/** Keep URL text literal, but still rewrite substitutions (`$(…)`, `<(…)`, `` `…` ``) inside. */
	literal: Set<number>;
	/** Keep completely verbatim (here-document delimiters and fd targets). */
	rawOnly: Set<number>;
}

/** Classify tokens that belong to omp, here-doc delimiters, here-strings, and fd redirects. */
function classifyProtectedTokens(tokens: HostToken[], windows: boolean): TokenProtection {
	const literal = new Set<number>();
	const rawOnly = new Set<number>();
	const segment: number[] = [];
	const words: string[] = [];
	const finish = () => {
		const omp = ompLaunch(words, windows);
		if (omp !== undefined) {
			for (let i = omp.literalFrom; i < segment.length; i++) literal.add(segment[i]!);
			for (const idx of omp.envIndices) literal.add(segment[idx]!);
		}
		segment.length = 0;
		words.length = 0;
	};
	let expectTarget: "none" | "file" | "heredoc" | "herestring" | "fd" = "none";
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (token.kind === "separator") {
			if (token.splits) {
				finish();
				expectTarget = "none";
			}
			continue;
		}
		if (expectTarget !== "none") {
			if (expectTarget === "heredoc" || expectTarget === "fd") rawOnly.add(i);
			else if (expectTarget === "herestring") literal.add(i);
			expectTarget = "none";
			continue;
		}
		const herestring = HERESTRING_OP.exec(token.raw);
		if (herestring) {
			if (herestring[0].length === token.raw.length) expectTarget = "herestring";
			else literal.add(i);
			continue;
		}
		const heredoc = HEREDOC_OP.exec(token.raw);
		if (heredoc) {
			if (heredoc[0].length === token.raw.length) expectTarget = "heredoc";
			else rawOnly.add(i);
			continue;
		}
		const fdRedir = FD_REDIRECT_OP.exec(token.raw);
		if (fdRedir) {
			if (fdRedir[0].length === token.raw.length) expectTarget = "fd";
			else rawOnly.add(i);
			continue;
		}
		if (!token.raw.startsWith("<(") && !token.raw.startsWith(">(")) {
			const fileRedir = FILE_REDIRECT_OP.exec(token.raw);
			if (fileRedir) {
				if (fileRedir[0].length === token.raw.length) expectTarget = "file";
				continue;
			}
		}
		if (words.length === 0 && COMMAND_PREFIX.has(token.value)) {
			finish();
			continue;
		}
		segment.push(i);
		words.push(token.value);
	}
	finish();
	return { literal, rawOnly };
}

function isPowerShell(shell: string | undefined): boolean {
	return shell !== undefined && /(?:^|[\\/])(?:powershell|pwsh)(?:\.exe)?$/i.test(shell);
}

function isWindowsShell(shell: string | undefined): boolean {
	if (process.platform === "win32") return true;
	if (shell === undefined) return false;
	return isCmdShell(shell) || isPowerShell(shell) || shell.includes("\\");
}

class HostUrls {
	readonly #backing: UrlBacking;
	readonly #cmd: boolean;
	readonly #powershell: boolean;
	readonly #windows: boolean;
	readonly #resolved = new Map<string, Promise<string | undefined>>();

	constructor(backing: UrlBacking, cmd: boolean, powershell: boolean, windows: boolean) {
		this.#backing = backing;
		this.#cmd = cmd;
		this.#powershell = powershell;
		this.#windows = windows;
	}

	#hasSubstitution(raw: string): boolean {
		if (this.#cmd) return false;
		if (this.#powershell) return raw.includes("$(");
		return raw.includes("$(") || raw.includes("<(") || raw.includes(">(") || raw.includes("`");
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
		let out = "";
		const tokens = lexHostCommand(text, this.#cmd, this.#powershell);
		// omp resolves its own URLs. Launcher options and file redirects still belong
		// to the launcher/shell, here-doc delimiters and here-strings stay verbatim,
		// and substitutions inside omp's arguments run as independent commands.
		const { literal, rawOnly } = classifyProtectedTokens(tokens, this.#windows);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (
				token.kind === "separator" ||
				rawOnly.has(i) ||
				(!token.value.includes("://") && !token.raw.includes("://"))
			) {
				out += token.raw;
				continue;
			}
			if (literal.has(i)) {
				out += this.#hasSubstitution(token.raw) ? await this.#substitutions(token.raw) : token.raw;
				continue;
			}
			out += await this.#word(token.raw, token.value);
		}
		return out;
	}

	/** One word naming a URL: its spelling with the URL's file in place, or as written. */
	async #word(raw: string, value: string): Promise<string> {
		if (this.#hasSubstitution(raw)) return this.#substitutions(raw);
		// Any other expansion decides the word's text only once the shell runs it.
		if (/[$`]/.test(raw)) return raw;
		const redirect = FILE_REDIRECT_OP.exec(raw)?.[0] ?? "";
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

	/** A word holding `$(…)`, `<(…)`, `>(…)`, or `` `…` ``: outside single quotes, each is its own command. */
	async #substitutions(raw: string): Promise<string> {
		const backslashLiteral = this.#cmd || this.#powershell;
		const posix = !this.#cmd && !this.#powershell;
		let out = "";
		let quote = "";
		for (let i = 0; i < raw.length; i++) {
			const ch = raw[i]!;
			if (quote === "'") {
				if (ch === "'") quote = "";
			} else if (!backslashLiteral && ch === "\\") {
				out += raw.slice(i, i + 2);
				i++;
				continue;
			} else if (ch === '"') {
				quote = quote ? "" : '"';
			} else if (ch === "'" && !quote && !this.#cmd) {
				quote = "'";
			} else if (!this.#cmd && ch === "$" && raw[i + 1] === "(" && raw[i + 2] !== "(") {
				const end = substitutionEnd(raw, i + 2);
				if (end >= 0) {
					out += `$(${await this.#code(raw.slice(i + 2, end))})`;
					i = end;
					continue;
				}
			} else if (posix && !quote && (ch === "<" || ch === ">") && raw[i + 1] === "(") {
				const end = substitutionEnd(raw, i + 2);
				if (end >= 0) {
					out += `${ch}(${await this.#code(raw.slice(i + 2, end))})`;
					i = end;
					continue;
				}
			} else if (posix && ch === "`") {
				const end = backtickEnd(raw, i + 1);
				if (end >= 0) {
					const body = raw.slice(i + 1, end);
					const inner = quote === '"' && body.includes('\\"') ? body.replaceAll('\\"', '"') : body;
					const rewritten = await this.#code(inner);
					const escaped = quote === '"' && body.includes('\\"') ? rewritten.replaceAll('"', '\\"') : rewritten;
					out += `\`${escaped}\``;
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
 * `omp`'s own arguments, here-document bodies, message text, and URLs nothing backs stay as written.
 */
export function hostCommandUrls(command: string, backing: UrlBacking, shell?: string): Promise<string> {
	return new HostUrls(
		backing,
		shell !== undefined && isCmdShell(shell),
		isPowerShell(shell),
		isWindowsShell(shell),
	).command(command);
}
