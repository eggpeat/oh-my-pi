import { isShellEnvironmentAssignment } from "./shell-tokenize";

/** The command word a shell line runs, after launchers and their options. */
export interface ShellLaunch {
	at: number;
	remote: boolean;
}

/** Argument positions that belong to omp (its own args and inherited env settings). */
export interface OmpLaunch {
	/** Indices at or after this position are omp's own arguments. */
	literalFrom: number;
	/** Original word indices holding environment settings inherited by omp. */
	envIndices: number[];
}

type WordOrigin = { kind: "arg"; index: number } | { kind: "split"; index: number; soleWord: boolean };

interface LaunchWord {
	text: string;
	origin: WordOrigin;
}

interface OptionSpec {
	readonly longValue: ReadonlySet<string>;
	readonly shortValue: string;
	readonly shortOptional: string;
	readonly longAbort: ReadonlySet<string>;
	readonly shortAbort: string;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_SPEC: OptionSpec = {
	longValue: EMPTY_SET,
	shortValue: "",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

function launcherName(word: string, windows: boolean): string {
	const sep = windows ? Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) : word.lastIndexOf("/");
	const base = word.slice(sep + 1);
	if (!windows) return base;
	const lower = base.toLowerCase();
	if (lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".com")) {
		return lower.slice(0, -4);
	}
	return lower;
}

function isOmpWord(word: string, windows: boolean): boolean {
	const sep = windows ? Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) : word.lastIndexOf("/");
	const base = word.slice(sep + 1);
	if (!windows) return base === "omp";
	const lower = base.toLowerCase();
	return lower === "omp" || lower === "omp.exe" || lower === "omp.cmd" || lower === "omp.bat" || lower === "omp.com";
}

/** `NAME=VALUE`, as sudo and doas take before the command they run. */
function plainAssignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** env accepts names a shell assignment would reject (`tool.name=value`). */
function envAssignment(word: string): boolean {
	return /^[^=]+=/.test(word);
}

type ScanOutcome = { kind: "operand"; at: number; afterDoubleDash: boolean } | { kind: "abort" };

/** Scan options from `from`, handling grouped short flags, optional attached values, `--`, and non-exec modes. */
function scanOptions(words: readonly LaunchWord[], from: number, spec: OptionSpec): ScanOutcome {
	let i = from;
	while (i < words.length) {
		const w = words[i]!.text;
		if (w === "--") return { kind: "operand", at: i + 1, afterDoubleDash: true };
		if (!w.startsWith("-") || w === "-") return { kind: "operand", at: i, afterDoubleDash: false };
		if (w.startsWith("--")) {
			const eq = w.indexOf("=");
			const name = eq >= 0 ? w.slice(0, eq) : w;
			if (spec.longAbort.has(name)) return { kind: "abort" };
			const takesNext = eq < 0 && spec.longValue.has(w);
			i += takesNext ? 2 : 1;
		} else {
			let takesNext = false;
			for (let j = 1; j < w.length; j++) {
				const c = w[j]!;
				if (spec.shortAbort.includes(c)) return { kind: "abort" };
				if (spec.shortValue.includes(c)) {
					takesNext = j === w.length - 1;
					break;
				}
				if (spec.shortOptional.includes(c)) {
					break;
				}
			}
			i += takesNext ? 2 : 1;
		}
	}
	return { kind: "operand", at: i, afterDoubleDash: false };
}

const SUDO_SPEC: OptionSpec = {
	longValue: new Set([
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
	]),
	shortValue: "ugCDhpRrTtU",
	shortOptional: "",
	longAbort: new Set(["--edit", "--list", "--version", "--help"]),
	shortAbort: "elV",
};

const DOAS_SPEC: OptionSpec = {
	longValue: EMPTY_SET,
	shortValue: "ua",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "C",
};

const TIMEOUT_SPEC: OptionSpec = {
	longValue: new Set(["--signal", "--kill-after"]),
	shortValue: "sk",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const NICE_SPEC: OptionSpec = {
	longValue: new Set(["--adjustment"]),
	shortValue: "n",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const TIME_SPEC: OptionSpec = {
	longValue: new Set(["--output", "--format"]),
	shortValue: "of",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const STDBUF_SPEC: OptionSpec = {
	longValue: new Set(["--input", "--output", "--error"]),
	shortValue: "ioe",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const EXEC_SPEC: OptionSpec = {
	longValue: EMPTY_SET,
	shortValue: "a",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const COMMAND_SPEC: OptionSpec = {
	longValue: EMPTY_SET,
	shortValue: "",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "vV",
};

const XARGS_SPEC: OptionSpec = {
	// --replace, --eof, and --max-lines take optional attached =VALUE in GNU xargs.
	longValue: new Set(["--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"]),
	shortValue: "adEILnPs",
	shortOptional: "iel",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const NPM_GLOBAL_LONG = [
	"--prefix",
	"--cache",
	"--registry",
	"--loglevel",
	"--userconfig",
	"--globalconfig",
	"--workspace",
	"--node-options",
	"--location",
	"--otp",
];

const NPM_GLOBAL_SPEC: OptionSpec = {
	longValue: new Set(NPM_GLOBAL_LONG),
	shortValue: "w",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const NPX_SPEC: OptionSpec = {
	longValue: new Set([...NPM_GLOBAL_LONG, "--package", "--npm"]),
	shortValue: "wp",
	shortOptional: "",
	longAbort: new Set(["--call"]),
	shortAbort: "c",
};

const NPM_EXEC_SPEC: OptionSpec = {
	// Unlike npx, npm's -p means parseable output, not a package.
	longValue: new Set([...NPM_GLOBAL_LONG, "--package"]),
	shortValue: "w",
	shortOptional: "",
	longAbort: new Set(["--call"]),
	shortAbort: "c",
};

const BUNX_SPEC: OptionSpec = {
	longValue: new Set([
		"--package",
		"--cwd",
		"--env-file",
		"--minimum-release-age",
		"--registry",
		"--ca",
		"--cafile",
		"--cache-dir",
		"--backend",
		"--linker",
		"--filter",
		"--config",
	]),
	shortValue: "pcF",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const BUN_GLOBAL_SPEC: OptionSpec = {
	longValue: new Set([
		"--cwd",
		"--env-file",
		"--config",
		"--filter",
		"--shell",
		"--preload",
		"--require",
		"--import",
		"--port",
		"--conditions",
		"--extension-order",
		"--tsconfig-override",
		"--define",
		"--drop",
		"--feature",
		"--loader",
		"--jsx-factory",
		"--jsx-fragment",
		"--jsx-import-source",
		"--jsx-runtime",
		"--install",
		"--elide-lines",
		"--console-depth",
		"--user-agent",
		"--main-fields",
		"--unhandled-rejections",
		"--dns-result-order",
		"--max-http-header-size",
		"--redirect-warnings",
		"--disable-warning",
		"--title",
		"--cpu-prof-name",
		"--cpu-prof-dir",
		"--cpu-prof-interval",
		"--heap-prof-name",
		"--heap-prof-dir",
		"--heap-prof-interval",
		"--fetch-preconnect",
		"--cron-title",
		"--cron-period",
	]),
	shortValue: "Frcdl",
	shortOptional: "",
	longAbort: new Set(["--eval", "--print"]),
	shortAbort: "ep",
};

const UV_GLOBAL_SPEC: OptionSpec = {
	longValue: new Set([
		"--directory",
		"--project",
		"--config-file",
		"--cache-dir",
		"--color",
		"--allow-insecure-host",
		"--python-preference",
		"--python-fetch",
	]),
	shortValue: "",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "",
};

const UV_RUN_SPEC: OptionSpec = {
	longValue: new Set([
		"--with",
		"--with-editable",
		"--with-requirements",
		"--python",
		"--package",
		"--project",
		"--directory",
		"--env-file",
		"--extra",
		"--no-extra",
		"--group",
		"--only-group",
		"--no-group",
		"--no-editable-package",
		"--python-platform",
		"--index",
		"--default-index",
		"--index-url",
		"--extra-index-url",
		"--find-links",
		"--config-file",
		"--cache-dir",
	]),
	shortValue: "wpif",
	shortOptional: "",
	longAbort: new Set(["--module", "--script", "--gui-script"]),
	shortAbort: "ms",
};

const SSH_SPEC: OptionSpec = {
	longValue: EMPTY_SET,
	shortValue: "BbcDEeFIiJLlmOopQRSWw",
	shortOptional: "",
	longAbort: EMPTY_SET,
	shortAbort: "GV",
};

const ENV_LONG_VALUE = new Set(["--unset", "--chdir", "--file", "--argv0"]);
const ENV_SHORT_VALUE = "uCfPa";

/** Split the operand of `env -S` / `--split-string` into words. */
function splitEnvString(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let inWord = false;
	let quote = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i]!;
		if (quote) {
			if (ch === "\\" && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === "\\")) {
				current += input[++i]!;
			} else if (ch === quote) {
				quote = "";
			} else {
				current += ch;
			}
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			if (inWord) {
				words.push(current);
				current = "";
				inWord = false;
			}
			continue;
		}
		if (ch === "#" && !inWord) break;
		inWord = true;
		if (ch === "'" || ch === '"') {
			quote = ch;
		} else if (ch === "\\" && i + 1 < input.length) {
			const next = input[++i]!;
			if (next === "_") current += " ";
			else if (next === "t") current += "\t";
			else if (next === "n") current += "\n";
			else if (next === "r") current += "\r";
			else if (next === "c") break;
			else current += next;
		} else {
			current += ch;
		}
	}
	if (inWord) words.push(current);
	return words;
}

function recordEnvOrigin(origin: WordOrigin, envIndices: number[]): void {
	if (origin.kind === "arg" || origin.soleWord) {
		if (!envIndices.includes(origin.index)) envIndices.push(origin.index);
	}
}

function buildEnvSplice(
	words: readonly LaunchWord[],
	splitText: string,
	srcIndex: number,
	separateWord: boolean,
	restFrom: number,
): LaunchWord[] {
	const pieces = splitEnvString(splitText);
	const soleWord = separateWord && pieces.length === 1;
	const spliced: LaunchWord[] = [];
	for (const piece of pieces) {
		spliced.push({ text: piece, origin: { kind: "split", index: srcIndex, soleWord } });
	}
	for (let j = restFrom; j < words.length; j++) {
		spliced.push(words[j]!);
	}
	return spliced;
}

type EnvStep = { kind: "done"; at: number } | { kind: "splice"; words: LaunchWord[] };

function stepEnv(words: readonly LaunchWord[], from: number, splitsRemaining: number, envIndices: number[]): EnvStep {
	let i = from;
	while (i < words.length) {
		const w = words[i]!.text;
		if (w === "--") {
			i++;
			break;
		}
		if (!w.startsWith("-") || w === "-") break;
		if (w.startsWith("--")) {
			if (splitsRemaining > 0) {
				if (w === "--split-string") {
					if (i + 1 >= words.length) return { kind: "done", at: words.length };
					const next = words[i + 1]!;
					return {
						kind: "splice",
						words: buildEnvSplice(words, next.text, next.origin.index, true, i + 2),
					};
				}
				if (w.startsWith("--split-string=")) {
					return {
						kind: "splice",
						words: buildEnvSplice(words, w.slice("--split-string=".length), words[i]!.origin.index, false, i + 1),
					};
				}
			} else if (w === "--split-string") {
				i += 2;
				continue;
			}
			const takesNext = !w.includes("=") && ENV_LONG_VALUE.has(w);
			i += takesNext ? 2 : 1;
		} else {
			let takesNext = false;
			for (let j = 1; j < w.length; j++) {
				const c = w[j]!;
				if (c === "S") {
					const rest = w.slice(j + 1);
					if (splitsRemaining > 0) {
						if (rest.length > 0) {
							return {
								kind: "splice",
								words: buildEnvSplice(words, rest, words[i]!.origin.index, false, i + 1),
							};
						}
						if (i + 1 >= words.length) return { kind: "done", at: words.length };
						const next = words[i + 1]!;
						return {
							kind: "splice",
							words: buildEnvSplice(words, next.text, next.origin.index, true, i + 2),
						};
					}
					takesNext = rest.length === 0;
					break;
				}
				if (ENV_SHORT_VALUE.includes(c)) {
					takesNext = j === w.length - 1;
					break;
				}
			}
			i += takesNext ? 2 : 1;
		}
	}
	if (i < words.length && words[i]!.text === "-") i++;
	while (i < words.length && envAssignment(words[i]!.text)) {
		recordEnvOrigin(words[i]!.origin, envIndices);
		i++;
	}
	return { kind: "done", at: i };
}

type StepResult =
	| { kind: "advance"; at: number; remote: boolean }
	| { kind: "spliceEnv"; words: LaunchWord[] }
	| { kind: "stop" };

function stepLauncher(
	words: readonly LaunchWord[],
	from: number,
	windows: boolean,
	splitsRemaining: number,
	envIndices: number[],
): StepResult {
	const raw = words[from]!.text;
	const program = launcherName(raw, windows);
	let outcome: ScanOutcome;
	switch (program) {
		case "env": {
			const env = stepEnv(words, from + 1, splitsRemaining, envIndices);
			return env.kind === "done"
				? { kind: "advance", at: env.at, remote: false }
				: { kind: "spliceEnv", words: env.words };
		}
		case "sudo":
			outcome = scanOptions(words, from + 1, SUDO_SPEC);
			if (outcome.kind === "abort") return { kind: "stop" };
			while (outcome.at < words.length && plainAssignment(words[outcome.at]!.text)) {
				recordEnvOrigin(words[outcome.at]!.origin, envIndices);
				outcome.at++;
			}
			return { kind: "advance", at: outcome.at, remote: false };
		case "doas":
			outcome = scanOptions(words, from + 1, DOAS_SPEC);
			if (outcome.kind === "abort") return { kind: "stop" };
			while (outcome.at < words.length && plainAssignment(words[outcome.at]!.text)) {
				recordEnvOrigin(words[outcome.at]!.origin, envIndices);
				outcome.at++;
			}
			return { kind: "advance", at: outcome.at, remote: false };
		case "timeout":
		case "gtimeout":
			outcome = scanOptions(words, from + 1, TIMEOUT_SPEC);
			if (outcome.kind === "abort") return { kind: "stop" };
			// The first operand is the duration.
			return { kind: "advance", at: outcome.at + 1, remote: false };
		case "nice":
			outcome = scanOptions(words, from + 1, NICE_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "nohup":
		case "setsid":
		case "ifne":
			outcome = scanOptions(words, from + 1, EMPTY_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "command":
			outcome = scanOptions(words, from + 1, COMMAND_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "time":
			outcome = scanOptions(words, from + 1, TIME_SPEC);
			if (outcome.kind === "abort") return { kind: "stop" };
			// Bare `time` is a shell reserved word, so assignments after it precede the command.
			if (raw === "time") {
				while (outcome.at < words.length && isShellEnvironmentAssignment(words[outcome.at]!.text)) {
					recordEnvOrigin(words[outcome.at]!.origin, envIndices);
					outcome.at++;
				}
			}
			return { kind: "advance", at: outcome.at, remote: false };
		case "stdbuf":
			outcome = scanOptions(words, from + 1, STDBUF_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "exec":
			outcome = scanOptions(words, from + 1, EXEC_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "xargs":
			outcome = scanOptions(words, from + 1, XARGS_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "npx":
			outcome = scanOptions(words, from + 1, NPX_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "bunx":
			outcome = scanOptions(words, from + 1, BUNX_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "npm":
			outcome = scanOptions(words, from + 1, NPM_GLOBAL_SPEC);
			if (
				outcome.kind !== "operand" ||
				outcome.afterDoubleDash ||
				outcome.at >= words.length ||
				words[outcome.at]!.text !== "exec"
			) {
				return { kind: "stop" };
			}
			outcome = scanOptions(words, outcome.at + 1, NPM_EXEC_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "bun":
			outcome = scanOptions(words, from + 1, BUN_GLOBAL_SPEC);
			if (
				outcome.kind !== "operand" ||
				outcome.afterDoubleDash ||
				outcome.at >= words.length ||
				words[outcome.at]!.text !== "x"
			) {
				return { kind: "stop" };
			}
			outcome = scanOptions(words, outcome.at + 1, BUNX_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "uv":
			outcome = scanOptions(words, from + 1, UV_GLOBAL_SPEC);
			if (
				outcome.kind !== "operand" ||
				outcome.afterDoubleDash ||
				outcome.at >= words.length ||
				words[outcome.at]!.text !== "run"
			) {
				return { kind: "stop" };
			}
			outcome = scanOptions(words, outcome.at + 1, UV_RUN_SPEC);
			return outcome.kind === "abort" ? { kind: "stop" } : { kind: "advance", at: outcome.at, remote: false };
		case "ssh":
			outcome = scanOptions(words, from + 1, SSH_SPEC);
			return outcome.kind === "operand" && outcome.at < words.length
				? { kind: "advance", at: outcome.at + 1, remote: true }
				: { kind: "stop" };
		default:
			return { kind: "stop" };
	}
}

interface ResolvedLaunch {
	at: number;
	remote: boolean;
	omp: OmpLaunch | undefined;
}

function resolveLaunch(words: string[], windows: boolean): ResolvedLaunch {
	const envIndices: number[] = [];
	let cur: readonly LaunchWord[] = words.map((text, index) => ({ text, origin: { kind: "arg", index } }));
	let at = 0;
	while (at < cur.length && isShellEnvironmentAssignment(cur[at]!.text)) {
		envIndices.push(at);
		at++;
	}
	let remote = false;
	let splitsRemaining = 4;
	let inEnv = false;
	while (at < cur.length) {
		if (inEnv) {
			inEnv = false;
			const env = stepEnv(cur, at, splitsRemaining, envIndices);
			if (env.kind === "splice") {
				cur = env.words;
				at = 0;
				splitsRemaining = Math.max(0, splitsRemaining - 1);
				inEnv = true;
				continue;
			}
			at = Math.min(env.at, cur.length);
			continue;
		}
		const step = stepLauncher(cur, at, windows, splitsRemaining, envIndices);
		if (step.kind === "advance") {
			at = Math.min(step.at, cur.length);
			remote ||= step.remote;
		} else if (step.kind === "spliceEnv") {
			cur = step.words;
			at = 0;
			splitsRemaining = Math.max(0, splitsRemaining - 1);
			inEnv = true;
		} else {
			break;
		}
	}
	const origAt = at < cur.length ? cur[at]!.origin.index : words.length;
	let omp: OmpLaunch | undefined;
	if (at < cur.length && isOmpWord(cur[at]!.text, windows)) {
		let literalFrom = words.length;
		for (let j = at + 1; j < cur.length; j++) {
			const origin = cur[j]!.origin;
			if (origin.kind === "arg") {
				literalFrom = origin.index;
				break;
			}
		}
		omp = { literalFrom, envIndices };
	}
	return { at: origAt, remote, omp };
}

export function shellLaunch(words: string[], windows = false): ShellLaunch {
	const resolved = resolveLaunch(words, windows);
	return { at: resolved.at, remote: resolved.remote };
}

/** Literal omp argument positions (including inherited env settings), locally or behind ssh. */
export function ompLaunch(words: string[], windows = false): OmpLaunch | undefined {
	return resolveLaunch(words, windows).omp;
}
