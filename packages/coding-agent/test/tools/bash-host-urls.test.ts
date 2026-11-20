/**
 * Internal URLs in commands that leave the bash tool's own shell: the rewrite a client terminal's
 * command gets, checked against a fixed backing, and the shell processes a named service and a pty
 * command run as, through `BashTool` with a real `local://` root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClients from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { hostCommandUrls, type UrlBacking } from "@oh-my-pi/pi-coding-agent/tools/bash-host-urls";
import { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { ProcSpec, UnitSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

/** `local://<path>` is `/host/<path>`; `local://nope/…` is refused; nothing else is backed. */
const backing: UrlBacking = async url => {
	if (url.startsWith("local://nope")) throw new Error("ENOENT");
	return url.startsWith("local://") ? `/host/${url.slice("local://".length)}` : undefined;
};

const host = (command: string, shell?: string) => hostCommandUrls(command, backing, shell);
const hasBash = process.platform !== "win32" && fs.existsSync("/bin/bash");

describe("hostCommandUrls", () => {
	it("names the file behind a URL argument, bare or attached to an option", async () => {
		expect(
			await host(
				"node local://run.mjs --env-file=local://a.env -olocal://out.json -F body=@local://b.md --data-binary @local://c.json",
			),
		).toBe(
			"node /host/run.mjs --env-file=/host/a.env -o/host/out.json -F body=@/host/b.md --data-binary @/host/c.json",
		);
	});

	it("resolves quoted words, redirections, assignments and command substitutions", async () => {
		expect(await host(`gh pr edit --body-file "local://b.md"`)).toBe("gh pr edit --body-file /host/b.md");
		expect(await host("python3 - <local://in.py 2>>local://err.log > local://out.txt")).toBe(
			"python3 - </host/in.py 2>>/host/err.log > /host/out.txt",
		);
		expect(await host("ENV_FILE=local://a.env uv run python local://smoke.py")).toBe(
			"ENV_FILE=/host/a.env uv run python /host/smoke.py",
		);
		expect(await host(`node "$(realpath local://ui.cjs)" -p "$(cat local://prompt.txt)" $(cat local://x)`)).toBe(
			`node "$(realpath /host/ui.cjs)" -p "$(cat /host/prompt.txt)" $(cat /host/x)`,
		);
	});

	it("quotes a path the shell would otherwise split, keeping a pattern live", async () => {
		const spaced: UrlBacking = async url => `/Users/a b/${url.slice("local://".length)}`;
		expect(await hostCommandUrls(`cat --from="local://it's.txt"`, spaced)).toBe(
			`cat '--from=/Users/a b/it'\\''s.txt'`,
		);
		expect(await hostCommandUrls("wc -l local://logs/*.txt 'local://logs/*.txt'", spaced)).toBe(
			"wc -l '/Users/a b/logs/'*.txt '/Users/a b/logs/*.txt'",
		);
		expect(await hostCommandUrls("type local://a.txt", spaced, "C:\\Windows\\System32\\cmd.exe")).toBe(
			'type "/Users/a b/a.txt"',
		);
	});

	it("leaves omp's own URLs, message text, and what nothing backs as written", async () => {
		for (const command of [
			"omp read 'skill://tdd:1-14' local://x.md",
			"sudo /usr/local/bin/omp read local://x.md",
			"curl https://example.com/a.txt -H 'Referer: https://example.com/?next=local://x'",
			"log.sh 'local://handover.md is ready for review'",
			"bm read memory://notes/startup local://nope/missing.md",
			"rg -n 'local://' src; echo 'skill:// external command'",
			`echo "$dir/local://x" 'see $(cat local://x)'`,
		]) {
			expect(await host(command)).toBe(command);
		}
		// The next command after `omp` is no longer its own.
		expect(await host("omp read local://x.md && cat local://x.md | omp -p local://y")).toBe(
			"omp read local://x.md && cat /host/x.md | omp -p local://y",
		);
	});

	it("treats a here-document body as input, not command text", async () => {
		const command = [
			"python3 - local://args.json <<'PY' && cat local://after.txt",
			'open("local://inside.txt")',
			"PY",
			"node local://tail.mjs <<-EOF",
			"\tlocal://body",
			"\tEOF",
			"cat local://done.txt",
		].join("\n");
		expect(await host(command)).toBe(
			[
				"python3 - /host/args.json <<'PY' && cat /host/after.txt",
				'open("local://inside.txt")',
				"PY",
				"node /host/tail.mjs <<-EOF",
				"\tlocal://body",
				"\tEOF",
				"cat /host/done.txt",
			].join("\n"),
		);
	});

	it("rewrites a URL when omp is only an argument", async () => {
		expect(await host("grep omp local://out.txt")).toBe("grep omp /host/out.txt");
		expect(await host("ls ./omp local://dir")).toBe("ls ./omp /host/dir");
		expect(await host("rg -n omp local://out.txt")).toBe("rg -n omp /host/out.txt");
	});

	it("keeps a real omp command's URLs and still rewrites launcher files and executables", async () => {
		expect(await host("nice omp read local://x")).toBe("nice omp read local://x");
		expect(await host("local://bin/omp read local://doc")).toBe("/host/bin/omp read local://doc");
		expect(await host("env local://bin/omp read local://doc")).toBe("env /host/bin/omp read local://doc");
		expect(await host("npx --loglevel warn omp read local://x:1")).toBe("npx --loglevel warn omp read local://x:1");
		expect(await host("npx --no-audit omp read local://x:1")).toBe("npx --no-audit omp read local://x:1");
		expect(await host("npx --cache omp eslint local://app.ts")).toBe("npx --cache omp eslint /host/app.ts");
		expect(await host("npm exec -p omp read local://x")).toBe("npm exec -p omp read local://x");
		expect(await host("npm --prefix local://tools exec -- omp read local://book:1")).toBe(
			"npm --prefix /host/tools exec -- omp read local://book:1",
		);
		expect(await host("env -- -flag=/opt/omp grep x local://file")).toBe("env -- -flag=/opt/omp grep x /host/file");
		expect(await host("env -u FOO - omp read local://x")).toBe("env -u FOO - omp read local://x");
		expect(await host("env --default-signal omp read local://x")).toBe("env --default-signal omp read local://x");
		expect(await host("env --default-signal=PIPE omp read local://x")).toBe(
			"env --default-signal=PIPE omp read local://x",
		);
		expect(await host("env --list-signal-handling omp read local://x")).toBe(
			"env --list-signal-handling omp read local://x",
		);
		expect(await host("env -S cat omp local://in")).toBe("env -S cat omp /host/in");
		expect(await host("env -S omp read local://in")).toBe("env -S omp read local://in");
		expect(await host("env -S 'omp read' local://in")).toBe("env -S 'omp read' local://in");
		expect(await host("env -S local://bin/omp read local://in")).toBe("env -S /host/bin/omp read local://in");
		expect(await host("env -S 'local://bin/omp read' local://file")).toBe("env -S '/host/bin/omp read' local://file");
		expect(await host(`RUN=omp env -S '\${RUN}' read local://in`)).toBe(`RUN=omp env -S '\${RUN}' read local://in`);
		expect(await host(`env -S '\${RUN}' read local://in`)).toBe(`env -S '\${RUN}' read local://in`);
		expect(await host(`RUN=cat env -S '\${RUN}' omp local://in`)).toBe(`RUN=cat env -S '\${RUN}' omp /host/in`);
		expect(await host("env tool.name=/opt/omp grep x local://file")).toBe("env tool.name=/opt/omp grep x /host/file");
		expect(await host("setsid omp read local://x:1")).toBe("setsid omp read local://x:1");
		expect(await host("setsid grep omp local://x")).toBe("setsid grep omp /host/x");
		expect(await host("xargs omp read local://x")).toBe("xargs omp read local://x");
		expect(await host("xargs --replace omp read local://x")).toBe("xargs --replace omp read local://x");
		expect(await host("ifne grep local://x")).toBe("ifne grep /host/x");
		expect(await host("uv run -w requests omp read local://book:1")).toBe(
			"uv run -w requests omp read local://book:1",
		);
		expect(await host("uv run --resolution lowest omp read local://book")).toBe(
			"uv run --resolution lowest omp read local://book",
		);
		expect(await host("bunx --minimum-release-age 86400 omp read local://book:1")).toBe(
			"bunx --minimum-release-age 86400 omp read local://book:1",
		);
		expect(await host("bunx --registry https://example omp read local://book:1")).toBe(
			"bunx --registry https://example omp read local://book:1",
		);
		expect(await host("REF=local://a omp read local://x")).toBe("REF=local://a omp read local://x");
		expect(
			await host("env -C local://dir FOO=local://var find local://docs -exec local://bin/omp read local://doc \\;"),
		).toBe("env -C /host/dir FOO=local://var find /host/docs -exec /host/bin/omp read local://doc \\;");
		// Lookup, module, script and edit modes do not run the omp binary; builtin follows command/exec.
		expect(await host("command -v omp local://file")).toBe("command -v omp /host/file");
		expect(await host("command -V omp local://file")).toBe("command -V omp /host/file");
		expect(await host("command -p omp read local://file")).toBe("command -p omp read local://file");
		expect(await host("builtin command omp read local://file")).toBe("builtin command omp read local://file");
		expect(await host("builtin exec omp read local://file")).toBe("builtin exec omp read local://file");
		expect(await host("builtin omp local://file")).toBe("builtin omp /host/file");
		expect(await host("uv run --module omp local://file")).toBe("uv run --module omp /host/file");
		expect(await host("uv run -m omp local://file")).toBe("uv run -m omp /host/file");
		expect(await host("uv run --script omp local://file")).toBe("uv run --script omp /host/file");
		expect(await host("sudo -e omp local://file")).toBe("sudo -e omp /host/file");
		// Deep launcher chains walk iteratively without overflowing the stack.
		const chain = "nice ".repeat(5_000);
		expect(await host(`${chain}omp read local://x`)).toBe(`${chain}omp read local://x`);
		expect(await host(`${chain}cat local://x`)).toBe(`${chain}cat /host/x`);
	});

	it("finds the command word past shell keywords, redirects, and quoted operator-like arguments", async () => {
		expect(await host("if omp read local://in; then cat local://out; fi")).toBe(
			"if omp read local://in; then cat /host/out; fi",
		);
		expect(await host("time FOO=x omp read local://in")).toBe("time FOO=x omp read local://in");
		expect(await host("time -p FOO=local://a omp read local://in")).toBe("time -p FOO=local://a omp read local://in");
		expect(await host("TAG+=extra omp read local://in")).toBe("TAG+=extra omp read local://in");
		expect(await host("<local://in omp read local://doc")).toBe("</host/in omp read local://doc");
		expect(await host("< local://in omp read local://doc")).toBe("< /host/in omp read local://doc");
		expect(await host('cat "<<<" local://in')).toBe('cat "<<<" /host/in');
		expect(await host("omp read local://a 2>&1 local://b")).toBe("omp read local://a 2>&1 local://b");
		expect(await host("omp read local://a &> local://log local://b")).toBe(
			"omp read local://a &> /host/log local://b",
		);
		expect(await host("cat >&local://log")).toBe("cat >&/host/log");
		expect(await host("cat >&2")).toBe("cat >&2");
		expect(await host("findstr # local://in", "C:\\Windows\\System32\\cmd.exe")).toBe("findstr # /host/in");
		expect(await host("findstr # local://in")).toBe("findstr # local://in");
	});

	it("keeps each remote omp command's URLs and rewrites local ssh options", async () => {
		expect(await host("ssh server omp read local://book")).toBe("ssh server omp read local://book");
		expect(await host("ssh host -p 2223 omp read local://x")).toBe("ssh host -p 2223 omp read local://x");
		expect(await host("ssh host -F local://cfg omp read local://x")).toBe("ssh host -F /host/cfg omp read local://x");
		expect(await host("ssh host LANG=C omp read local://in")).toBe("ssh host LANG=C omp read local://in");
		expect(await host("ssh host 'LANG=C omp read' local://in")).toBe("ssh host 'LANG=C omp read' local://in");
		expect(await host("ssh host '$(command -v omp)' local://in")).toBe("ssh host '$(command -v omp)' local://in");
		expect(await host("ssh host 'cat \"$HOME/note\"' local://in")).toBe("ssh host 'cat \"$HOME/note\"' /host/in");
		expect(await host("ssh host '$RUNNER' local://in")).toBe("ssh host '$RUNNER' local://in");
		expect(await host(`ssh host sh -c 'omp read "$1"' _ local://in`)).toBe(
			`ssh host sh -c 'omp read "$1"' _ local://in`,
		);
		expect(await host("ssh -F local://config server omp read local://book")).toBe(
			"ssh -F /host/config server omp read local://book",
		);
		expect(await host('ssh server omp read local://book "|" cat')).toBe('ssh server omp read local://book "|" cat');
		expect(await host('ssh server omp read local://book "|" cat local://other')).toBe(
			'ssh server omp read local://book "|" cat /host/other',
		);
		expect(await host("ssh server omp read local://book 2>&1")).toBe("ssh server omp read local://book 2>&1");
		expect(await host('ssh server omp read local://book "|" cat local://other "2>&1"')).toBe(
			'ssh server omp read local://book "|" cat /host/other "2>&1"',
		);
	});

	it("rewrites file targets, not here-document markers, here-strings or arithmetic shifts", async () => {
		expect(await host("cat << 'local://done'\nbody\nlocal://done\necho hi")).toBe(
			"cat << 'local://done'\nbody\nlocal://done\necho hi",
		);
		expect(await host("cat 0<<EOF\nlocal://body\nEOF\ncat local://after")).toBe(
			"cat 0<<EOF\nlocal://body\nEOF\ncat /host/after",
		);
		expect(await host('cat <<<"$(cat <<EOF\nlocal://body\nEOF\n)" && cat local://after')).toBe(
			'cat <<<"$(cat <<EOF\nlocal://body\nEOF\n)" && cat /host/after',
		);
		expect(await host("cat <<< local://text")).toBe("cat <<< local://text");
		expect(await host("cat <<< literal\ncat local://in")).toBe("cat <<< literal\ncat /host/in");
		expect(await host('cat <<END"MARK"\nlocal://inside\nEND\nlocal://still\nENDMARK\ncat local://done')).toBe(
			'cat <<END"MARK"\nlocal://inside\nEND\nlocal://still\nENDMARK\ncat /host/done',
		);
		expect(await host("echo $((1 << 2))\ncat local://file")).toBe("echo $((1 << 2))\ncat /host/file");
		expect(await host("if ((1 << 2)); then\ncat local://in\nfi")).toBe("if ((1 << 2)); then\ncat /host/in\nfi");
		expect(await host("for (( i=1; i < 2; i=i<<1 )); do\ncat local://in\ndone")).toBe(
			"for (( i=1; i < 2; i=i<<1 )); do\ncat /host/in\ndone",
		);
	});

	it("rewrites commands inside case patterns, quoted substitutions with redirects, and fd-redirection substitutions", async () => {
		expect(await host("case x in x) cat local://a;; esac")).toBe("case x in x) cat /host/a;; esac");
		expect(await host('echo "$(case x in x) cat local://a;; esac)"')).toBe(
			'echo "$(case x in x) cat /host/a;; esac)"',
		);
		expect(await host('echo "$(cat < local://in > local://out)"')).toBe('echo "$(cat < /host/in > /host/out)"');
		expect(await host('echo "$(> local://out case x in x) cat < local://a;; esac)"')).toBe(
			'echo "$(> /host/out case x in x) cat < /host/a;; esac)"',
		);
		expect(await host("2>&$(cat local://fd)")).toBe("2>&$(cat /host/fd)");
		expect(await host("2>& $(cat local://fd)")).toBe("2>& $(cat /host/fd)");
	});

	it("escapes only inside matched backtick commands without corrupting later dollar paths", async () => {
		const dollarBacking: UrlBacking = async url => {
			if (url === "local://tick") return "/host/a`b/file";
			if (url === "local://dollar") return "/host/$dir/file";
			return undefined;
		};
		expect(await hostCommandUrls("echo `cat local://tick`; cat local://dollar", dollarBacking)).toBe(
			"echo `cat '/host/a\\`b/file'`; cat '/host/$dir/file'",
		);
		expect(await hostCommandUrls("echo `cat local://dollar", dollarBacking)).toBe("echo `cat '/host/$dir/file'");
		if (hasBash) {
			const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-url-bt-"));
			try {
				const nested = path.join(dir, "a`b");
				const dollarDir = path.join(dir, "$sub");
				await fs.promises.mkdir(nested);
				await fs.promises.mkdir(dollarDir);
				const tickFile = path.join(nested, "file");
				const dollarFile = path.join(dollarDir, "file");
				await fs.promises.writeFile(tickFile, "ok\n");
				await fs.promises.writeFile(dollarFile, "plain\n");
				const realBacking: UrlBacking = async url => {
					if (url === "local://file") return tickFile;
					if (url === "local://dollar") return dollarFile;
					return undefined;
				};
				const command = await hostCommandUrls(
					'printf "%s:%s" "`cat local://file`" "$(cat local://dollar)"',
					realBacking,
				);
				const result = Bun.spawnSync(["/bin/bash", "-c", command]);
				expect(result.exitCode).toBe(0);
				expect(result.stdout.toString()).toBe("ok:plain");
			} finally {
				await fs.promises.rm(dir, { recursive: true, force: true });
			}
		}
	});
});

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/** A UI whose `custom()` mounts the pty overlay on a headless TUI and resolves with its result. */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(
		factory: (tui: TUI, uiTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
	): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
		return promise;
	};
	return { custom };
}

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

describe("bash internal URLs outside the embedded shell", () => {
	let tempDir: string;
	let localRoot: string;
	let session: ToolSession;
	/** Prints its arguments, then `$BODY` when set, one per line. */
	let argvScript: string;

	beforeEach(async () => {
		tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "bash-host-urls-")));
		const localProtocolOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "bash-host-urls" };
		localRoot = resolveLocalRoot(localProtocolOptions);
		await fs.promises.mkdir(localRoot, { recursive: true });
		await fs.promises.writeFile(path.join(localRoot, "data.txt"), "payload-from-local\n");
		argvScript = path.join(tempDir, "argv.js");
		await fs.promises.writeFile(
			argvScript,
			"console.log(process.argv.slice(2).concat(process.env.BODY ?? []).join('\\n'));\n",
		);
		session = {
			cwd: tempDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-host-urls",
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			queueLaunchCompletion: () => Promise.resolve(),
			queueServiceNotify: () => {},
			localProtocolOptions,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	it("starts a named service as a shell process that gets its command as written", async () => {
		const daemon: UnitSnapshot = {
			id: "web-1",
			kind: "proc",
			scope: { kind: "project", dir: tempDir },
			key: "web",
			label: "web",
			generation: "web-gen-1",
			state: "running",
			pids: [1],
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner: "bash-host-urls",
			leases: 1,
			policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
			supervised: true,
		};
		let started: ProcSpec | undefined;
		const client = {
			onCompletion: () => () => {},
			onNotify: () => () => {},
			onReconnect: () => () => {},
			close() {},
			async request(operation: { op: string; proc?: ProcSpec }) {
				if (operation.op === "open") {
					started = operation.proc;
					return { unit: daemon, lease: "lease-1", created: true };
				}
				if (operation.op === "logs") return { text: "", terminalOutput: "", cursor: 0, unit: daemon };
				throw new Error(`Unexpected daemon op ${operation.op}`);
			},
		} as unknown as DaemonClient;
		vi.spyOn(daemonClients, "daemonClient").mockResolvedValue(client);

		await new BashTool(session).execute("start-web", {
			command: `SEED=local://data.txt uv run python local://serve.py --prompt "$(cat local://data.txt)" < local://data.txt; omp read local://data.txt:1-2`,
			name: "web",
		});

		// The engine in that process resolves the URLs itself, to the files this session backs them with.
		const args = started?.args ?? [];
		expect(args.at(-1)).toBe(
			`SEED=local://data.txt uv run python local://serve.py --prompt "$(cat local://data.txt)" < local://data.txt; omp read local://data.txt:1-2`,
		);
		expect(args.at(-2)).toBe("--");
		expect(args).toContain(SHELL_PROCESS_SELECTOR);
		// What backs them is in the script the process sources, not on its command line.
		expect(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 1]).toBe("--source");
		expect(await fs.promises.readFile(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 2], "utf-8")).toContain(
			`urlmap 'local://' '${localRoot}'`,
		);
	});

	it.skipIf(ptyUnavailable)("runs a pty command on the files its URLs alias", async () => {
		initTheme();
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: tempDir, TERM: "dumb" },
			prefix: undefined,
		});
		const result = await new BashTool({ ...session, hasUI: true } as ToolSession).execute(
			"pty",
			{
				command: `/bin/cat local://data.txt && '${process.execPath}' '${argvScript}' local://data.txt > local://pty-out.txt`,
				pty: true,
				timeout: 15,
			},
			undefined,
			undefined,
			{ hasUI: true, ui: headlessUi() } as unknown as AgentToolContext,
		);

		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("payload-from-local");
		expect(await fs.promises.readFile(path.join(localRoot, "pty-out.txt"), "utf-8")).toBe(
			`${path.join(localRoot, "data.txt")}\n`,
		);
	});

	it.skipIf(ptyUnavailable)(
		"runs a pty command in the session's shell: omp's jq on a local:// file, the session's functions and exports",
		async () => {
			initTheme();
			vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
				shell: "/bin/bash",
				args: ["-c"],
				env: { PATH: Bun.env.PATH ?? "", HOME: tempDir, TERM: "dumb" },
				prefix: undefined,
			});
			const empty = path.join(tempDir, "empty");
			await fs.promises.mkdir(empty);
			await fs.promises.writeFile(path.join(localRoot, "data.json"), '{"a":[40,2]}\n');
			const tool = new BashTool({ ...session, hasUI: true } as ToolSession);
			// An earlier call of the session leaves a function and an export behind.
			await tool.execute("define", { command: 'label() { echo "sum=$1 $SEEDED"; }; export SEEDED=seeded' });

			const result = await tool.execute(
				"pty-jq",
				{
					// No directory on the search path has a jq: the one that runs is omp's.
					command: `PATH='${empty}'; label "$(jq '.a | add' local://data.json)" > local://sum.txt; [ -t 1 ] && echo on-a-terminal`,
					pty: true,
					timeout: 30,
				},
				undefined,
				undefined,
				{ hasUI: true, ui: headlessUi() } as unknown as AgentToolContext,
			);

			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("on-a-terminal");
			expect(await fs.promises.readFile(path.join(localRoot, "sum.txt"), "utf-8")).toBe("sum=42 seeded\n");
		},
		60_000,
	);

	it("hands an eval sh() external the files its URL arguments alias", async () => {
		const result = await runEvalShell(
			{
				command: `BODY=local://data.txt '${process.execPath}' '${argvScript}' --body-file=local://data.txt`,
			},
			{ session },
		);

		const data = path.join(localRoot, "data.txt");
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(`--body-file=${data}\n${data}\n`);
	});

	it.skipIf(!hasBash)(
		"applies the same launcher, env -S, and ssh ownership rules in both the embedded shell and hostCommandUrls",
		async () => {
			const binDir = path.join(tempDir, "bin");
			const vbinDir = path.join(localRoot, "bin");
			await fs.promises.mkdir(binDir, { recursive: true });
			await fs.promises.mkdir(vbinDir, { recursive: true });
			const writeBin = async (dir: string, name: string, body: string) => {
				const target = path.join(dir, name);
				await fs.promises.writeFile(target, `#!/bin/sh\n${body}\n`);
				await fs.promises.chmod(target, 0o755);
			};
			const echoArgs = 'printf "%s\\n" "$@"';
			await writeBin(binDir, "omp", echoArgs);
			await writeBin(vbinDir, "omp", echoArgs);
			await writeBin(binDir, "probe", echoArgs);
			await writeBin(binDir, "uv", echoArgs);
			await writeBin(binDir, "npx", echoArgs);
			await writeBin(binDir, "npm", echoArgs);
			await writeBin(binDir, "ssh", echoArgs);

			const dataPath = path.join(localRoot, "data.txt");
			const vOmpPath = path.join(vbinDir, "omp");
			const localBacking: UrlBacking = async url => {
				if (!url.startsWith("local://")) return undefined;
				return path.join(localRoot, url.slice("local://".length));
			};

			// One table of commands exercised against BOTH `hostCommandUrls` (executed under `/bin/bash`)
			// and the embedded shell (`runEvalShell`), asserting identical argv reaches the target program.
			const cases: Array<{ cmd: string; expected: string[] }> = [
				{ cmd: "probe omp local://data.txt", expected: ["omp", dataPath] },
				{
					cmd: "uv run --resolution lowest omp read local://data.txt",
					expected: ["run", "--resolution", "lowest", "omp", "read", "local://data.txt"],
				},
				{ cmd: "uv run --module omp local://data.txt", expected: ["run", "--module", "omp", dataPath] },
				{
					cmd: "npx --no-audit omp read local://data.txt",
					expected: ["--no-audit", "omp", "read", "local://data.txt"],
				},
				{
					cmd: "npm --prefix local://data.txt exec -- omp read local://data.txt",
					expected: ["--prefix", dataPath, "exec", "--", "omp", "read", "local://data.txt"],
				},
				{ cmd: "builtin command omp read local://data.txt", expected: ["read", "local://data.txt"] },
				{ cmd: "time FOO=x omp read local://data.txt", expected: ["read", "local://data.txt"] },
				{ cmd: "TAG+=extra omp read local://data.txt", expected: ["read", "local://data.txt"] },
				{ cmd: "/usr/bin/env -S 'local://bin/omp read' local://data.txt", expected: ["read", "local://data.txt"] },
				{ cmd: "env -S 'omp read' local://data.txt", expected: ["read", "local://data.txt"] },
				{
					cmd: `RUN='${vOmpPath}' /usr/bin/env -S '\${RUN}' read local://data.txt`,
					expected: ["read", "local://data.txt"],
				},
				{
					cmd: "ssh -F local://data.txt host -p 2223 LANG=C omp read local://data.txt '|' cat local://data.txt",
					expected: [
						"-F",
						dataPath,
						"host",
						"-p",
						"2223",
						"LANG=C",
						"omp",
						"read",
						"local://data.txt",
						"|",
						"cat",
						dataPath,
					],
				},
				{
					cmd: "ssh host '$(command -v omp)' local://data.txt",
					expected: ["host", "$(command -v omp)", "local://data.txt"],
				},
				{ cmd: "ssh host 'cat \"$HOME/note\"' local://data.txt", expected: ["host", 'cat "$HOME/note"', dataPath] },
			];

			for (const { cmd, expected } of cases) {
				const embedded = await runEvalShell(
					{ command: `TIMEFORMAT=''; PATH='${binDir}':$PATH; ${cmd}` },
					{ session },
				);
				expect(embedded.exitCode, `embedded failed for: ${cmd}\n${embedded.output}`).toBe(0);
				expect(embedded.output.trimEnd().split("\n"), `embedded mismatch for: ${cmd}`).toEqual(expected);

				const rewritten = await hostCommandUrls(cmd, localBacking);
				const client = Bun.spawnSync(["/bin/bash", "-c", `PATH='${binDir}':$PATH; ${rewritten}`]);
				expect(
					client.exitCode,
					`client failed for: ${cmd}\nrewritten: ${rewritten}\n${client.stderr.toString()}`,
				).toBe(0);
				expect(
					client.stdout.toString().trimEnd().split("\n"),
					`client mismatch for: ${cmd}\nrewritten: ${rewritten}`,
				).toEqual(expected);
			}
		},
	);
});
