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

/** Whether this process spells program names the way Windows does. */
const windows = process.platform === "win32";

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

	it("treats omp as the program, not an argument or a wrapper's value", async () => {
		for (const [command, expected] of [
			["grep omp local://out.txt", "grep omp /host/out.txt"],
			["rg -n 'omp' local://x.md", "rg -n 'omp' /host/x.md"],
			["ls ./omp local://dir", "ls ./omp /host/dir"],
			["omp read local://x.md", "omp read local://x.md"],
			["nice omp read local://x.md", "nice omp read local://x.md"],
			["sudo /usr/local/bin/omp read local://x.md", "sudo /usr/local/bin/omp read local://x.md"],
			["nice env omp read local://x.md", "nice env omp read local://x.md"],
			["time omp read local://x.md", "time omp read local://x.md"],
			["command omp read local://x.md", "command omp read local://x.md"],
			["npx --cache omp eslint local://app.ts", "npx --cache omp eslint /host/app.ts"],
			["npx --loglevel warn omp read local://x:1", "npx --loglevel warn omp read local://x:1"],
			["npx -p omp eslint local://app.ts", "npx -p omp eslint /host/app.ts"],
			["npm --prefix tools exec -- omp read local://x", "npm --prefix tools exec -- omp read local://x"],
			["npm exec -p omp read local://x", "npm exec -p omp read local://x"],
			["uv run -w requests omp read local://book:1", "uv run -w requests omp read local://book:1"],
			[
				"bunx --minimum-release-age 86400 omp read local://book:1",
				"bunx --minimum-release-age 86400 omp read local://book:1",
			],
			["env - omp read local://x", "env - omp read local://x"],
			["env -- -flag=/opt/omp grep x local://file", "env -- -flag=/opt/omp grep x /host/file"],
			["setsid omp read local://x", "setsid omp read local://x"],
			["setsid grep x local://file", "setsid grep x /host/file"],
			["xargs omp read local://x", "xargs omp read local://x"],
			["ifne omp read local://x", "ifne omp read local://x"],
			["ssh server omp read local://x", "ssh server omp read local://x"],
			["ssh -F local://conf server omp read local://x", "ssh -F /host/conf server omp read local://x"],
			["find local://dir -exec omp read local://x \\;", "find /host/dir -exec omp read local://x \\;"],
			// A wrapper's own file argument resolves; the command it runs keeps its URLs.
			["npx --cache local://cache omp read local://book:1", "npx --cache /host/cache omp read local://book:1"],
			["nice local://bin/omp read local://x", "nice /host/bin/omp read local://x"],
			["local://bin/omp read local://x", "/host/bin/omp read local://x"],
			["npx -w omp eslint local://x", "npx -w omp eslint /host/x"],
			["npm exec --cache omp -- eslint local://x", "npm exec --cache omp -- eslint /host/x"],
			["env -S grep omp local://x", "env -S grep omp /host/x"],
			["env -S omp read local://x", "env -S omp read local://x"],
			["env -S 'omp read' local://x", "env -S 'omp read' local://x"],
			["env -S 'grep omp' local://x", "env -S 'grep omp' /host/x"],
			["env -S 'ref=local://in omp read' local://x", "env -S 'ref=local://in omp read' local://x"],
			["bun x omp read local://x", "bun x omp read local://x"],
			["pnpm exec omp read local://x", "pnpm exec omp read local://x"],
			["npx.cmd omp read local://x", "npx.cmd omp read local://x"],
			["NPX omp read local://x", windows ? "NPX omp read local://x" : "NPX omp read /host/x"],
			["NPX.CMD omp read local://x", windows ? "NPX.CMD omp read local://x" : "NPX.CMD omp read /host/x"],
			["C:/tools/npx.cmd omp read local://x", "C:/tools/npx.cmd omp read local://x"],
			["/usr/local/bin/npx omp read local://x", "/usr/local/bin/npx omp read local://x"],
			["REF=local://x omp read local://y", "REF=local://x omp read local://y"],
			["env REF=local://x omp read local://y", "env REF=local://x omp read local://y"],
			["env -- --flag=/opt/omp grep x local://file", "env -- --flag=/opt/omp grep x /host/file"],
			["npx --cache FOO=local://dir omp read local://x", "npx --cache FOO=/host/dir omp read local://x"],
			["exec -a omp grep needle local://x", "exec -a omp grep needle /host/x"],
			["exec -a foo omp read local://x", "exec -a foo omp read local://x"],
			["ssh server -p 2222 omp read local://x", "ssh server -p 2222 omp read local://x"],
			[
				"ssh -F local://conf server -p 2222 omp read local://x",
				"ssh -F /host/conf server -p 2222 omp read local://x",
			],
			["ssh server env omp read local://x", "ssh server env omp read local://x"],
			["uv run -m omp local://x", "uv run -m omp /host/x"],
			["uv run --module omp local://x", "uv run --module omp /host/x"],
			["uv run --module=omp local://x", "uv run --module=omp /host/x"],
			["uv run omp local://x", "uv run omp local://x"],
			["uv run local://script.py", "uv run /host/script.py"],
			["uv run local://bin/omp local://x", "uv run /host/bin/omp local://x"],
			["2>&1 omp read local://x", "2>&1 omp read local://x"],
			["nice 2>/dev/null -n 5 omp read local://x", "nice 2>/dev/null -n 5 omp read local://x"],
			["bun x --cafile ca.pem omp read local://x", "bun x --cafile ca.pem omp read local://x"],
			["bun x --ca ca.pem omp read local://x", "bun x --ca ca.pem omp read local://x"],
			["uv run --script ./omp local://x", "uv run --script ./omp /host/x"],
			["uv run -s ./omp local://x", "uv run -s ./omp /host/x"],
			["env -S 'MODE=quiet omp read' local://x", "env -S 'MODE=quiet omp read' local://x"],
			["env -S 'local://bin/omp read' local://x", "env -S '/host/bin/omp read' local://x"],
			["env -S MODE=quiet omp read local://x", "env -S MODE=quiet omp read local://x"],
			["REF+=local://x omp read local://y", "REF+=local://x omp read local://y"],
			["REF=local://x find . -exec omp read {} \\;", "REF=local://x find . -exec omp read {} \\;"],
			["find . -exec omp + local://x \\;", "find . -exec omp + local://x \\;"],
			["find . -exec omp read {} + local://x \\;", "find . -exec omp read {} + /host/x \\;"],
			['for omp in local://x; do cat "$omp"; done', 'for omp in /host/x; do cat "$omp"; done'],
			['grep "<<" local://x', 'grep "<<" /host/x'],
			['omp read ">" local://x', 'omp read ">" local://x'],
			["omp read $(cat local://in) local://two", "omp read $(cat /host/in) local://two"],
			["omp read local://in>local://out", "omp read local://in>/host/out"],
		] as const) {
			expect(await host(command)).toBe(expected);
		}
	});

	it("reads a Windows launcher path the way cmd.exe does", async () => {
		// cmd.exe keeps backslashes, so this names npx even on a POSIX host.
		expect(await host("C:\\bin\\npx.cmd omp read local://x", "cmd.exe")).toBe("C:\\bin\\npx.cmd omp read local://x");
	});

	it("finds the command after shell keywords, assignments and redirections", async () => {
		for (const [command, expected] of [
			["if omp read local://x; then :; fi", "if omp read local://x; then :; fi"],
			["! omp read local://x", "! omp read local://x"],
			[">/dev/null omp read local://x", ">/dev/null omp read local://x"],
			[">local://out omp read local://x", ">/host/out omp read local://x"],
			["> local://out omp read local://x", "> /host/out omp read local://x"],
			["if > /dev/null omp read local://x; then :; fi", "if > /dev/null omp read local://x; then :; fi"],
			["REF=local://x > local://out omp read local://y", "REF=local://x > /host/out omp read local://y"],
			["for i in local://x; do cat local://y; done", "for i in /host/x; do cat /host/y; done"],
			["case local://x in x) cat local://y;; esac", "case /host/x in x) cat /host/y;; esac"],
			["while omp read local://x; do cat local://y; done", "while omp read local://x; do cat /host/y; done"],
			["{ omp read local://x; }", "{ omp read local://x; }"],
			["[[ -f local://x ]]", "[[ -f /host/x ]]"],
			["time -o local://log omp read local://x", "time -o /host/log omp read local://x"],
		] as const) {
			expect(await host(command)).toBe(expected);
		}
	});

	it("rewrites redirection targets and nested commands even for omp", async () => {
		for (const [command, expected] of [
			["omp read local://in > local://out", "omp read local://in > /host/out"],
			["omp read local://in >local://out", "omp read local://in >/host/out"],
			["omp read local://in < local://in2", "omp read local://in < /host/in2"],
			["omp read local://in 2> local://err", "omp read local://in 2> /host/err"],
			["omp read local://in 2>> local://err", "omp read local://in 2>> /host/err"],
			["omp read local://in &> local://log", "omp read local://in &> /host/log"],
			["omp read local://in >& local://log", "omp read local://in >& /host/log"],
			["omp read local://in &>> local://log", "omp read local://in &>> /host/log"],
			["omp read local://in >| local://out", "omp read local://in >| /host/out"],
			["omp read local://in <> local://rw", "omp read local://in <> /host/rw"],
			["omp read local://in > local://out 2>&1", "omp read local://in > /host/out 2>&1"],
			['omp read "$(cat local://in)"', 'omp read "$(cat /host/in)"'],
			["omp read $(cat local://in)", "omp read $(cat /host/in)"],
			['omp read "pre $(cat local://in) post"', 'omp read "pre $(cat /host/in) post"'],
			['omp read "$(omp read local://in)"', 'omp read "$(omp read local://in)"'],
			["omp read local://x > /dev/null", "omp read local://x > /dev/null"],
			["omp read local://x 2>&1", "omp read local://x 2>&1"],
			["omp read local://x >&2", "omp read local://x >&2"],
			["omp read local://x 2>&-", "omp read local://x 2>&-"],
			["omp read local://x <&0", "omp read local://x <&0"],
			// Here-documents and here-strings are input text, not file targets.
			["omp <<< local://text", "omp <<< local://text"],
			["omp << 'local://done'", "omp << 'local://done'"],
			["omp read local://x <<EOF", "omp read local://x <<EOF"],
			["cat <<< local://text", "cat <<< local://text"],
			["cat << 'local://done'", "cat << 'local://done'"],
			["cat << local://done", "cat << local://done"],
		] as const) {
			expect(await host(command)).toBe(expected);
		}
	});

	it("handles each find action separately", async () => {
		for (const [command, expected] of [
			[
				"find local://dir -exec omp read local://x \\; -exec cat local://y \\;",
				"find /host/dir -exec omp read local://x \\; -exec cat /host/y \\;",
			],
			[
				"find local://dir -exec cat local://y \\; -exec omp read local://x \\;",
				"find /host/dir -exec cat /host/y \\; -exec omp read local://x \\;",
			],
			["find . -exec omp read local://x \\;", "find . -exec omp read local://x \\;"],
			["find . -exec cat local://x \\;", "find . -exec cat /host/x \\;"],
			["find . -name omp -exec cat local://x \\;", "find . -name omp -exec cat /host/x \\;"],
			["find . -exec nice local://bin/omp read local://x \\;", "find . -exec nice /host/bin/omp read local://x \\;"],
			[
				"find . -exec env REF=local://x omp read local://y \\;",
				"find . -exec env REF=local://x omp read local://y \\;",
			],
			["find . -exec env -S 'omp read' local://x \\;", "find . -exec env -S 'omp read' local://x \\;"],
			["find . -exec env -S 'grep omp' local://x \\;", "find . -exec env -S 'grep omp' /host/x \\;"],
			["find . -exec uv run -m omp local://x \\;", "find . -exec uv run -m omp /host/x \\;"],
			[
				"find . -exec ssh server -p 2222 omp read local://x \\;",
				"find . -exec ssh server -p 2222 omp read local://x \\;",
			],
			["find . -exec exec -a omp grep needle local://x \\;", "find . -exec exec -a omp grep needle /host/x \\;"],
			["find . -exec npx.cmd omp read local://x \\;", "find . -exec npx.cmd omp read local://x \\;"],
			[
				"find . -exec C:/tools/npx.cmd omp read local://x \\;",
				"find . -exec C:/tools/npx.cmd omp read local://x \\;",
			],
			[
				"find . -exec NPX omp read local://x \\;",
				windows ? "find . -exec NPX omp read local://x \\;" : "find . -exec NPX omp read /host/x \\;",
			],
			[
				"find . -exec /usr/local/bin/npx omp read local://x \\;",
				"find . -exec /usr/local/bin/npx omp read local://x \\;",
			],
			["find . -exec bun x omp read local://x \\;", "find . -exec bun x omp read local://x \\;"],
			["find . -exec pnpm exec omp read local://x \\;", "find . -exec pnpm exec omp read local://x \\;"],
			["find . -exec npx -w omp eslint local://x \\;", "find . -exec npx -w omp eslint /host/x \\;"],
			[
				"find . -exec npm exec --cache omp -- eslint local://x \\;",
				"find . -exec npm exec --cache omp -- eslint /host/x \\;",
			],
			[
				"find . -exec npx --cache local://dir omp read local://x \\;",
				"find . -exec npx --cache /host/dir omp read local://x \\;",
			],
			[
				"find . -exec npx --cache FOO=local://dir omp read local://x \\;",
				"find . -exec npx --cache FOO=/host/dir omp read local://x \\;",
			],
			["find . -exec REF=local://x omp read local://y \\;", "find . -exec REF=local://x omp read local://y \\;"],
			["find . -exec uv run omp local://x \\;", "find . -exec uv run omp local://x \\;"],
			["find . -exec uv run local://script.py \\;", "find . -exec uv run /host/script.py \\;"],
			["find . -exec uv run local://bin/omp local://x \\;", "find . -exec uv run /host/bin/omp local://x \\;"],
			["find . -exec ssh server cat local://x \\;", "find . -exec ssh server cat /host/x \\;"],
			[
				"find . -exec ssh server LANG=C omp read local://x \\;",
				"find . -exec ssh server LANG=C omp read local://x \\;",
			],
			["find . -exec command -v omp local://x \\;", "find . -exec command -v omp /host/x \\;"],
			["find . -exec exec -a foo omp read local://x \\;", "find . -exec exec -a foo omp read local://x \\;"],
			["find . -exec time omp read local://x \\;", "find . -exec time omp read local://x \\;"],
			["find . -exec command omp read local://x \\;", "find . -exec command omp read local://x \\;"],
			["find . -exec exec omp read local://x \\;", "find . -exec exec omp read local://x \\;"],
			["find . -exec nice omp read local://x \\;", "find . -exec nice omp read local://x \\;"],
			["find . -exec env - omp read local://x \\;", "find . -exec env - omp read local://x \\;"],
			["find . -exec env -u LEAF omp read local://x \\;", "find . -exec env -u LEAF omp read local://x \\;"],
			["find . -exec env -i omp read local://x \\;", "find . -exec env -i omp read local://x \\;"],
			["find . -exec env -C /tmp omp read local://x \\;", "find . -exec env -C /tmp omp read local://x \\;"],
			["find . -exec nice -n 5 omp read local://x \\;", "find . -exec nice -n 5 omp read local://x \\;"],
			["find . -exec nohup omp read local://x \\;", "find . -exec nohup omp read local://x \\;"],
			["find . -exec stdbuf -oL omp read local://x \\;", "find . -exec stdbuf -oL omp read local://x \\;"],
			["find . -exec setsid omp read local://x \\;", "find . -exec setsid omp read local://x \\;"],
			["find . -exec xargs -n 1 omp read local://x \\;", "find . -exec xargs -n 1 omp read local://x \\;"],
			["find . -exec ifne omp read local://x \\;", "find . -exec ifne omp read local://x \\;"],
			["find . -exec timeout 30 omp read local://x \\;", "find . -exec timeout 30 omp read local://x \\;"],
			[
				"find . -exec timeout -s KILL 30 omp read local://x \\;",
				"find . -exec timeout -s KILL 30 omp read local://x \\;",
			],
			["find . -exec doas -u root omp read local://x \\;", "find . -exec doas -u root omp read local://x \\;"],
			["find . -exec sudo -u root omp read local://x \\;", "find . -exec sudo -u root omp read local://x \\;"],
			["find . -exec command -p omp read local://x \\;", "find . -exec command -p omp read local://x \\;"],
			["find . -exec exec -a nice grep omp local://x \\;", "find . -exec exec -a nice grep omp /host/x \\;"],
			["find . -exec omp read local://x > local://out \\;", "find . -exec omp read local://x > /host/out \\;"],
			["find . -exec > local://out omp read local://x \\;", "find . -exec > /host/out omp read local://x \\;"],
			['find . -exec omp read "$(cat local://in)" \\;', 'find . -exec omp read "$(cat /host/in)" \\;'],
			['find . -exec cat "$(omp read local://in)" \\;', 'find . -exec cat "$(omp read local://in)" \\;'],
			["find . -exec omp <<< local://text \\;", "find . -exec omp <<< local://text \\;"],
			["find . -exec omp read local://x +", "find . -exec omp read local://x +"],
			["find . -execdir omp read local://x \\;", "find . -execdir omp read local://x \\;"],
			["find . -ok omp read local://x \\;", "find . -ok omp read local://x \\;"],
			["find . -okdir omp read local://x \\;", "find . -okdir omp read local://x \\;"],
		] as const) {
			expect(await host(command)).toBe(expected);
		}
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

	it("keeps a URL delimiter spelling the document it opens", async () => {
		const command = ["cat << local://done", "local://body", "local://done", "cat local://after.txt"].join("\n");
		expect(await host(command)).toBe(
			["cat << local://done", "local://body", "local://done", "cat /host/after.txt"].join("\n"),
		);
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
});
