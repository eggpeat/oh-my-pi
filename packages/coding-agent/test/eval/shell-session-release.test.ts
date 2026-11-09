import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { evaluateLoopCondition } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { BashRunner } from "@oh-my-pi/pi-coding-agent/session/bash-runner";
import { EvalRunner } from "@oh-my-pi/pi-coding-agent/session/eval-runner";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;
const usedSessionIds = new Set<string>();

beforeEach(() => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-shell-release-");
	setAgentDir(path.join(temp.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	for (const id of usedSessionIds) {
		releaseShellSessions(id);
	}
	usedSessionIds.clear();
	restoreSettingsTestState(settingsState);
	AgentStorage.close();
	temp.removeSync();
});

function createHarness(initialSessionId: string) {
	let currentSessionId = initialSessionId;
	usedSessionIds.add(initialSessionId);
	const settings = Settings.isolated({
		"eval.autoProvision": false,
	});
	const agent = { appendMessage: () => {} } as unknown as Agent;
	const sessionManager = {
		getCwd: () => temp.path(),
		getSessionId: () => currentSessionId,
		getSessionFile: () => undefined,
		getLeafId: () => null,
		appendMessage: () => "msg-id",
	} as unknown as SessionManager;
	const evalOwnerId = `owner:${initialSessionId}`;
	const toolSession: ToolSession = {
		cwd: temp.path(),
		hasUI: false,
		skills: [],
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => currentSessionId,
		getEvalSessionId: () => currentSessionId,
		getEvalKernelOwnerId: () => evalOwnerId,
	};
	const bashRunner = new BashRunner({
		agent,
		sessionManager,
		settings,
		extensionRunner: () => undefined,
		isStreaming: () => false,
	});
	const evalRunner = new EvalRunner(
		{
			agent,
			sessionManager,
			settings,
			extensionRunner: () => undefined,
			evalToolSession: toolSession,
			isStreaming: () => false,
			appendSessionMessage: () => {},
		},
		{ kernelOwnerId: evalOwnerId },
	);
	const evalTool = new EvalTool(toolSession);

	async function runSh(command: string): Promise<string> {
		const code = `const out = await sh(${JSON.stringify(command)}); print("SH_OUT:" + JSON.stringify(out));`;
		const result = await evalTool.execute("eval-sh", { language: "js", code, timeout: 30 });
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		const line = text.split("\n").find(entry => entry.startsWith("SH_OUT:"));
		if (!line) throw new Error(`missing SH_OUT line in eval result:\n${text}`);
		return JSON.parse(line.slice("SH_OUT:".length));
	}

	async function runJs(code: string): Promise<unknown> {
		const wrapped = `const value = await (async () => { ${code} })(); print("JS_OUT:" + JSON.stringify(value));`;
		const result = await evalTool.execute("eval-js", { language: "js", code: wrapped, timeout: 30 });
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		const line = text.split("\n").find(entry => entry.startsWith("JS_OUT:"));
		if (!line) throw new Error(`missing JS_OUT line in eval result:\n${text}`);
		return JSON.parse(line.slice("JS_OUT:".length));
	}

	return {
		bashRunner,
		evalRunner,
		runSh,
		runJs,
		setSessionId(nextId: string) {
			usedSessionIds.add(nextId);
			currentSessionId = nextId;
		},
	};
}

describe("eval sh session shell lifecycle", () => {
	it.skipIf(process.platform === "win32")(
		"keeps eval sh, bash, and loop-condition shells isolated and releases all of them when the owning session transitions",
		async () => {
			const firstId = `eval-sh-first-${crypto.randomUUID()}`;
			const secondId = `eval-sh-second-${crypto.randomUUID()}`;
			const harness = createHarness(firstId);
			const runLoop = (command: string, sessionId = firstId) =>
				evaluateLoopCondition({ command, until: false }, { cwd: temp.path(), timeoutMs: 5_000, sessionId });

			await harness.runSh("PI_EVAL_SH_VAR=from-eval");
			await harness.bashRunner.executeBash("PI_BASH_VAR=from-bash");
			expect(await runLoop("PI_LOOP_VAR=from-loop")).toEqual({ kind: "continue" });

			expect(await harness.runSh('printf "%s:%s:%s" "$PI_EVAL_SH_VAR" "$PI_BASH_VAR" "$PI_LOOP_VAR"')).toBe(
				"from-eval::",
			);
			expect(
				(await harness.bashRunner.executeBash('printf "%s:%s:%s" "$PI_EVAL_SH_VAR" "$PI_BASH_VAR" "$PI_LOOP_VAR"'))
					.output,
			).toBe(":from-bash:");
			expect(
				await runLoop('test "$PI_LOOP_VAR" = from-loop && test -z "$PI_EVAL_SH_VAR" && test -z "$PI_BASH_VAR"'),
			).toEqual({ kind: "continue" });

			const transition = harness.bashRunner.beginSessionTransition();
			harness.setSessionId(secondId);
			harness.bashRunner.markSessionTransition(transition);
			harness.bashRunner.finishSessionTransition(transition, true);

			harness.setSessionId(firstId);
			expect(await harness.runSh('printf "%s:%s:%s" "$PI_EVAL_SH_VAR" "$PI_BASH_VAR" "$PI_LOOP_VAR"')).toBe("::");
			expect(
				(await harness.bashRunner.executeBash('printf "%s:%s:%s" "$PI_EVAL_SH_VAR" "$PI_BASH_VAR" "$PI_LOOP_VAR"'))
					.output,
			).toBe("::");
			expect(await runLoop('test -n "$PI_LOOP_VAR"')).toMatchObject({ kind: "halt" });
		},
	);

	it.skipIf(process.platform === "win32")(
		"releases settled eval sh shells when EvalRunner.disposeKernels tears down the session",
		async () => {
			const sessionId = `eval-sh-dispose-${crypto.randomUUID()}`;
			const harness = createHarness(sessionId);

			await harness.runSh("PI_EVAL_DISPOSE_VAR=kept");
			expect(await harness.runSh('printf "[%s]" "$PI_EVAL_DISPOSE_VAR"')).toBe("[kept]");

			await harness.evalRunner.disposeKernels();

			expect(await harness.runSh('printf "[%s]" "$PI_EVAL_DISPOSE_VAR"')).toBe("[]");
		},
	);

	it.skipIf(process.platform === "win32")(
		"quotes sh template interpolations safely across quotes, comments, and case command substitutions",
		async () => {
			const sessionId = `eval-sh-quotes-${crypto.randomUUID()}`;
			const harness = createHarness(sessionId);
			const outcome = await harness.runJs(`
				const payload = "$(printf injected)";
				const literal = await sh\`# don't
printf '%s|%s|%s|%s|%s|%s|%s' \${payload} "\${payload}" '\${payload}' $'\\'\${payload}' "\\"\${payload}\\"" "$( (printf '%s' "\${payload}") )" "$(case case in (case|other) printf 'case:'; printf '%s' "\${payload}" ;; esac)"\`;
				const rejected = [];
				for (const fn of [
					() => sh\`printf '%s' ok # don't \${payload}\`,
					() => sh\`cat <<EOF
\${payload}
EOF\`,
					() => sh\`printf '%s' "$((\${payload}))"\`,
				]) {
					try {
						await fn();
						rejected.push("resolved");
					} catch (error) {
						rejected.push(error.name);
					}
				}
				return { literal, rejected };
			`);
			expect(outcome).toEqual({
				literal:
					'$(printf injected)|$(printf injected)|$(printf injected)|\'$(printf injected)|"$(printf injected)"|$(printf injected)|case:$(printf injected)',
				rejected: ["TypeError", "TypeError", "TypeError"],
			});
		},
	);
});
