import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/discovery/ssh";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const SPILL = "demo output\n";

describe("eval sh internal URLs", () => {
	let temp: TempDir;
	let sessionId: string | undefined;

	afterEach(() => {
		releaseShellSessions(sessionId);
		capability.reset();
		temp?.removeSync();
	});

	it("reads local spills and exec-tier ssh:// URLs from the embedded cat builtin", async () => {
		temp = TempDir.createSync("@eval-shell-urls-");
		sessionId = `shell-urls-${crypto.randomUUID()}`;
		const artifacts = path.join(temp.path(), "artifacts");
		const localRoot = resolveLocalRoot({
			getArtifactsDir: () => artifacts,
			getSessionId: () => sessionId ?? null,
		});
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "0.log"), SPILL);
		await Bun.write(
			path.join(temp.path(), "ssh.json"),
			JSON.stringify({ hosts: { "eval-fixture-host": { host: "198.51.100.7" } } }),
		);
		capability.reset();
		const session: ToolSession = {
			cwd: temp.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifacts,
			getSessionId: () => sessionId ?? null,
		};

		const spill = await runEvalShell({ command: "cat local://0.log", timeout: 10 }, { session });
		expect(spill.exitCode).toBe(0);
		expect(spill.timedOut).toBeUndefined();
		expect(spill.output).toBe(SPILL);

		const hosts = await runEvalShell({ command: "cat ssh://", timeout: 10 }, { session });
		expect(hosts.exitCode).toBe(0);
		expect(hosts.timedOut).toBeUndefined();
		expect(hosts.output).toContain("[eval-fixture-host](ssh://eval-fixture-host/) — `198.51.100.7`");
	});
});
