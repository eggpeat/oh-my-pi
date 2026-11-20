/** The command word a shell line runs, after launchers and their options. */
export interface ShellLaunch {
	at: number;
	remote: boolean;
}

function basename(word: string): string {
	return word.slice(word.lastIndexOf("/") + 1);
}

/** `NAME=VALUE`, as the shell and sudo take before the command they run. */
function assignment(word: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/** env accepts names a shell assignment would reject (`tool.name=value`). */
function envAssignment(word: string): boolean {
	return /^[^=]+=/.test(word);
}

/** Index of the first operand, past options whose separate values are in `takesValue`. */
function operand(words: string[], from: number, takesValue: ReadonlySet<string>): number {
	let at = from;
	while (at < words.length) {
		const word = words[at]!;
		if (word === "--") return at + 1;
		if (!word.startsWith("-") || word === "-") break;
		at += takesValue.has(word) ? 2 : 1;
	}
	return at;
}

const NPM_GLOBAL_VALUE = new Set([
	"--prefix",
	"--cache",
	"--registry",
	"--loglevel",
	"--userconfig",
	"--globalconfig",
	"--workspace",
	"-w",
	"--node-options",
	"--location",
	"--otp",
]);
const NPX_VALUE = new Set([...NPM_GLOBAL_VALUE, "-p", "--package", "-c", "--call", "--npm"]);
// Unlike npx, npm's -p means parseable output, not a package.
const NPM_EXEC_VALUE = new Set([...NPM_GLOBAL_VALUE, "--package", "-c", "--call"]);
const BUNX_VALUE = new Set([
	"--registry",
	"--cache-dir",
	"--minimum-release-age",
	"--backend",
	"--linker",
	"--filter",
	"--config",
	"--cwd",
]);
const XARGS_VALUE = new Set([
	"-a",
	"--arg-file",
	"-d",
	"--delimiter",
	"-E",
	"--eof",
	"-I",
	"--replace",
	"-L",
	"--max-lines",
	"-n",
	"--max-args",
	"-P",
	"--max-procs",
	"-s",
	"--max-chars",
	"--process-slot-var",
]);
const ENV_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string", "-P"]);
const SUDO_VALUE = new Set([
	"-u",
	"-g",
	"-C",
	"-D",
	"-h",
	"-p",
	"-R",
	"-r",
	"-T",
	"-t",
	"-U",
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
const TIMEOUT_VALUE = new Set(["-s", "--signal", "-k", "--kill-after"]);
const NICE_VALUE = new Set(["-n", "--adjustment"]);
const TIME_VALUE = new Set(["-o", "--output", "-f", "--format"]);
const STDBUF_VALUE = new Set(["-i", "-o", "-e", "--input", "--output", "--error"]);
const UV_RUN_VALUE = new Set([
	"--with",
	"-w",
	"--with-editable",
	"--with-requirements",
	"-p",
	"--python",
	"--package",
	"--project",
	"--directory",
	"--env-file",
	"--extra",
	"--group",
	"--only-group",
	"--no-group",
	"--index",
	"--default-index",
	"-i",
	"--index-url",
	"--extra-index-url",
	"-f",
	"--find-links",
	"--config-file",
	"--cache-dir",
]);

const NO_VALUE: ReadonlySet<string> = new Set();
const EXEC_VALUE = new Set(["-a"]);
const SSH_VALUE = new Set([..."pilojFSLRDWbcEemOQw"].map(flag => `-${flag}`));

/** The next command word after a launcher at `from`, and whether it is remote. */
function launcher(words: string[], from: number): ShellLaunch | undefined {
	const program = basename(words[from]!);
	let at: number;
	switch (program) {
		case "env":
			// Options precede env's optional compatibility dash and settings;
			// after --, a setting may itself begin with a dash.
			at = operand(words, from + 1, ENV_VALUE);
			if (words[at] === "-") at++;
			while (at < words.length && envAssignment(words[at]!)) at++;
			return { at, remote: false };
		case "sudo":
		case "doas":
			at = operand(words, from + 1, SUDO_VALUE);
			while (at < words.length && assignment(words[at]!)) at++;
			return { at, remote: false };
		case "timeout":
		case "gtimeout":
			// The first operand is the duration.
			return { at: operand(words, from + 1, TIMEOUT_VALUE) + 1, remote: false };
		case "nice":
			return { at: operand(words, from + 1, NICE_VALUE), remote: false };
		case "nohup":
		case "setsid":
		case "ifne":
			return { at: operand(words, from + 1, NO_VALUE), remote: false };
		case "time":
			return { at: operand(words, from + 1, TIME_VALUE), remote: false };
		case "stdbuf":
			return { at: operand(words, from + 1, STDBUF_VALUE), remote: false };
		case "exec":
			return { at: operand(words, from + 1, EXEC_VALUE), remote: false };
		case "xargs":
			return { at: operand(words, from + 1, XARGS_VALUE), remote: false };
		case "npx":
			return { at: operand(words, from + 1, NPX_VALUE), remote: false };
		case "bunx":
			return { at: operand(words, from + 1, BUNX_VALUE), remote: false };
		case "npm":
			at = from + 1;
			while (at < words.length) {
				const word = words[at]!;
				if (word === "exec") return { at: operand(words, at + 1, NPM_EXEC_VALUE), remote: false };
				if (word === "--" || !word.startsWith("-") || word === "-") return undefined;
				at += NPM_GLOBAL_VALUE.has(word) ? 2 : 1;
			}
			return undefined;
		case "uv":
			if (words[from + 1] !== "run") return undefined;
			return { at: operand(words, from + 2, UV_RUN_VALUE), remote: false };
		case "ssh": {
			const host = operand(words, from + 1, SSH_VALUE);
			return host < words.length ? { at: host + 1, remote: true } : undefined;
		}
		default:
			return undefined;
	}
}

export function shellLaunch(words: string[]): ShellLaunch {
	let at = 0;
	while (at < words.length && assignment(words[at]!)) at++;
	let remote = false;
	while (at < words.length) {
		const next = launcher(words, at);
		if (!next) break;
		at = Math.min(next.at, words.length);
		remote ||= next.remote;
	}
	return { at, remote };
}

/** Index of the local omp command word, not an argument or a launcher's option value. */
export function ompCommand(words: string[]): number | undefined {
	const launched = shellLaunch(words);
	if (launched.remote) return undefined;
	const word = words[launched.at];
	if (!word) return undefined;
	const name = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1).toLowerCase();
	return name === "omp" || name === "omp.exe" ? launched.at : undefined;
}
