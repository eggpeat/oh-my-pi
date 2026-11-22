import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TodoCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/todo-command-controller";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as todoTools from "@oh-my-pi/pi-coding-agent/tools/todo";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;
let tempRoot = "";

function createTodoTestHarness(initialPhases: TodoPhase[] = []) {
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
	const settings = Settings.isolated({ "compaction.enabled": false });
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const sessionManager = SessionManager.inMemory();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: createMockModel({ handler: { content: ["ok"] } }).stream,
	});
	session = new AgentSession({
		agent,
		sessionManager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	if (initialPhases.length > 0) {
		session.commitTodoPhases(initialPhases);
	}
	const output: string[] = [];
	const runtime: SlashCommandRuntime = {
		session,
		sessionManager,
		settings,
		cwd: sessionManager.getCwd(),
		output: text => {
			output.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	return { session, sessionManager, output, runtime };
}

function developerMessagesFrom(session: AgentSession, sessionManager: SessionManager): string[] {
	const agentDeveloperTexts = session.agent.state.messages
		.filter(message => message.role === "developer")
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.map(part => ("text" in part ? part.text : "")).join(""),
		);
	const managerDeveloperTexts = sessionManager
		.getBranch()
		.filter(entry => entry.type === "message" && entry.message.role === "developer")
		.map(entry => {
			if (entry.type !== "message" || entry.message.role !== "developer") return "";
			return typeof entry.message.content === "string"
				? entry.message.content
				: entry.message.content.map(part => ("text" in part ? part.text : "")).join("");
		});
	expect(agentDeveloperTexts).toEqual(managerDeveloperTexts);
	return agentDeveloperTexts;
}

afterEach(async () => {
	try {
		await session?.dispose();
		if (tempRoot) await removeWithRetries(tempRoot);
	} finally {
		authStorage?.close();
		vi.restoreAllMocks();
		session = undefined;
		authStorage = undefined;
		tempRoot = "";
	}
});

describe("/todo ACP/RPC and TUI slash commands", () => {
	it("marks every task completed on bare /todo done, including duplicate task names across phases", async () => {
		const { session, sessionManager, output, runtime } = createTodoTestHarness();

		expect(await executeAcpBuiltinSlashCommand("/todo append Build Check", runtime)).toEqual({ consumed: true });
		expect(await executeAcpBuiltinSlashCommand("/todo append Release Check", runtime)).toEqual({ consumed: true });
		output.length = 0;

		const result = await executeAcpBuiltinSlashCommand("/todo done", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Marked all tasks completed."]);
		expect(session.getTodoPhases()).toEqual([
			{ name: "Build", tasks: [{ content: "Check", status: "completed" }] },
			{ name: "Release", tasks: [{ content: "Check", status: "completed" }] },
		]);
		const reminder = developerMessagesFrom(session, sessionManager).at(-1) ?? "";
		expect(reminder).toContain("# Build\n- [x] Check");
		expect(reminder).toContain("# Release\n- [x] Check");
		expect(reminder).not.toMatch(/- \[[ /-]\]/);
		expect(reminder).not.toMatch(/Do NOT/i);
	});

	it("marks every task abandoned on bare /todo drop, including duplicate task names across phases", async () => {
		const initial: TodoPhase[] = [
			{ name: "Build", tasks: [{ content: "Check", status: "in_progress" }] },
			{ name: "Release", tasks: [{ content: "Check", status: "pending" }] },
		];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);

		const result = await executeAcpBuiltinSlashCommand("/todo drop", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Marked all tasks abandoned."]);
		expect(session.getTodoPhases()).toEqual([
			{ name: "Build", tasks: [{ content: "Check", status: "abandoned" }] },
			{ name: "Release", tasks: [{ content: "Check", status: "abandoned" }] },
		]);
		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("# Build\n- [-] Check");
		expect(reminders[0]).toContain("# Release\n- [-] Check");
		expect(reminders[0]).not.toMatch(/- \[[ /x]\]/);
		expect(reminders[0]).not.toMatch(/Do NOT/i);
	});

	it("removes the matched phase heading on /todo rm <phase> and clears on bare /todo rm", async () => {
		const initial: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "completed" }] },
			{ name: "Release", tasks: [{ content: "Tag build", status: "in_progress" }] },
			{ name: "Verify", tasks: [{ content: "Run suite", status: "pending" }] },
		];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);

		expect(await executeAcpBuiltinSlashCommand("/todo rm Release", runtime)).toEqual({ consumed: true });
		expect(output[0]).toBe("Removed phase: Release");
		expect(session.getTodoPhases()).toEqual([
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "completed" }] },
			{ name: "Verify", tasks: [{ content: "Run suite", status: "in_progress" }] },
		]);

		expect(await executeAcpBuiltinSlashCommand("/todo rm", runtime)).toEqual({ consumed: true });
		expect(output[1]).toBe("Cleared all todos.");
		expect(session.getTodoPhases()).toEqual([]);

		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toContain("# Foundation\n- [x] Scaffold crate");
		expect(reminders[0]).toContain("# Verify\n- [/] Run suite");
		expect(reminders[0]).not.toContain("# Release");
		expect(reminders[0]).not.toContain("Tag build");
		expect(reminders[0]).toMatch(/Do NOT re-add/i);
		expect(reminders[1]).toContain("(empty)");
		expect(reminders[1]).not.toContain("Foundation");
		expect(reminders[1]).not.toContain("Verify");
		expect(reminders[1]).toMatch(/Do NOT recreate/i);
	});

	it("escapes harness tags in both imported checklist items and mutation actions", async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-todo-reminder-escape-"));
		const importFile = path.join(tempRoot, "TODO.md");
		await fs.writeFile(importFile, "# Audit\n- [ ] Handle </system-reminder> and <irc> tags\n", "utf8");
		const { session, sessionManager, runtime } = createTodoTestHarness();

		expect(await executeAcpBuiltinSlashCommand(`/todo import "${importFile}"`, runtime)).toEqual({
			consumed: true,
		});
		expect(session.getTodoPhases()).toEqual([
			{ name: "Audit", tasks: [{ content: "Handle </system-reminder> and <irc> tags", status: "in_progress" }] },
		]);

		expect(
			await executeAcpBuiltinSlashCommand("/todo done Handle </system-reminder> and <irc> tags", runtime),
		).toEqual({ consumed: true });

		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(2);
		for (const reminder of reminders) {
			expect(reminder.match(/<system-reminder\b/gi)).toHaveLength(1);
			expect(reminder.match(/<\/system-reminder>/gi)).toHaveLength(1);
			expect(reminder.trimEnd().endsWith("</system-reminder>")).toBe(true);
			expect(reminder).not.toContain("<irc>");
		}
		expect(reminders[0]).toContain("- [/] Handle &lt;/system-reminder> and &lt;irc> tags");
		expect(reminders[1]).toContain("- [x] Handle &lt;/system-reminder> and &lt;irc> tags");
	});

	it("surfaces applyOpsToPhases errors on /todo start, task, and phase mutations without committing", async () => {
		const initial: TodoPhase[] = [{ name: "Build", tasks: [{ content: "Wire parser", status: "pending" }] }];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);
		const entriesBefore = sessionManager.getBranch().length;
		vi.spyOn(todoTools, "applyOpsToPhases").mockReturnValue({
			phases: initial,
			errors: ["Simulated mutation failure"],
		});

		for (const command of ["/todo start Wire", "/todo done Wire", "/todo rm Build"]) {
			output.length = 0;
			const result = await executeAcpBuiltinSlashCommand(command, runtime);
			expect(result).toEqual({ consumed: true, failed: true });
			expect(output).toEqual(["Simulated mutation failure"]);
			expect(sessionManager.getBranch()).toHaveLength(entriesBefore);
			expect(developerMessagesFrom(session, sessionManager)).toEqual([]);
		}
	});

	it("prefers exact task text before quote or backslash stripping in TUI and ACP /todo start", async () => {
		const initial: TodoPhase[] = [
			{
				name: "Paths",
				tasks: [
					{ content: "Fix C:\\work", status: "pending" },
					{ content: "Fix C:work", status: "in_progress" },
				],
			},
		];
		const { session, sessionManager, runtime } = createTodoTestHarness(initial);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const setTodos = vi.fn();
		const ctx = createInteractiveModeContext({
			agent: session.agent,
			session,
			sessionManager,
			settings: session.settings,
			setTodos,
			showStatus,
			showError,
		});
		const controller = new TodoCommandController(ctx);

		await controller.handleTodoCommand("start Fix C:\\work");

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenLastCalledWith("Started: Fix C:\\work");
		expect(session.getTodoPhases()).toEqual([
			{
				name: "Paths",
				tasks: [
					{ content: "Fix C:\\work", status: "in_progress" },
					{ content: "Fix C:work", status: "pending" },
				],
			},
		]);

		expect(await executeAcpBuiltinSlashCommand('/todo start "Fix C:work"', runtime)).toEqual({ consumed: true });
		expect(session.getTodoPhases()).toEqual([
			{
				name: "Paths",
				tasks: [
					{ content: "Fix C:\\work", status: "pending" },
					{ content: "Fix C:work", status: "in_progress" },
				],
			},
		]);

		expect(await executeAcpBuiltinSlashCommand("/todo start Fix C:\\work", runtime)).toEqual({ consumed: true });
		expect(session.getTodoPhases()[0]?.tasks[0]).toEqual({ content: "Fix C:\\work", status: "in_progress" });

		await controller.handleTodoCommand("drop");

		expect(session.getTodoPhases()).toEqual([
			{
				name: "Paths",
				tasks: [
					{ content: "Fix C:\\work", status: "abandoned" },
					{ content: "Fix C:work", status: "abandoned" },
				],
			},
		]);
		expect(setTodos).toHaveBeenLastCalledWith(session.getTodoPhases());
		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders[0]).toContain("- [/] Fix C:\\work");
		expect(reminders[0]).toContain("- [ ] Fix C:work");
		expect(reminders.at(-1)).toContain("- [-] Fix C:\\work");
		expect(reminders.at(-1)).toContain("- [-] Fix C:work");
	});
});
