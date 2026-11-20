import { afterEach, describe, expect, it, vi } from "bun:test";
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
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

let session: AgentSession | undefined;
let authStorage: AuthStorage | undefined;

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
	} finally {
		authStorage?.close();
		vi.restoreAllMocks();
		session = undefined;
		authStorage = undefined;
	}
});

describe("/todo ACP/RPC slash command", () => {
	it("marks every task completed on bare /todo done and injects a neutral system reminder", async () => {
		const initial: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "in_progress" },
					{ content: "Add tests", status: "pending" },
				],
			},
			{
				name: "Verify",
				tasks: [{ content: "Run suite", status: "pending" }],
			},
		];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);

		const result = await executeAcpBuiltinSlashCommand("/todo done", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Marked all tasks completed."]);
		expect(session.getTodoPhases()).toEqual([
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "completed" },
					{ content: "Add tests", status: "completed" },
				],
			},
			{
				name: "Verify",
				tasks: [{ content: "Run suite", status: "completed" }],
			},
		]);
		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("<system-reminder>");
		expect(reminders[0]).toContain("The user manually modified the todo list (/todo done (all)).");
		expect(reminders[0]).not.toMatch(/Do NOT/i);
	});

	it("marks every task abandoned on bare /todo drop and injects a neutral system reminder", async () => {
		const initial: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "in_progress" },
					{ content: "Add tests", status: "pending" },
				],
			},
		];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);

		const result = await executeAcpBuiltinSlashCommand("/todo drop", runtime);

		expect(result).toEqual({ consumed: true });
		expect(output).toEqual(["Marked all tasks abandoned."]);
		expect(session.getTodoPhases()).toEqual([
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "abandoned" },
					{ content: "Add tests", status: "abandoned" },
				],
			},
		]);
		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("The user manually modified the todo list (/todo drop (all)).");
		expect(reminders[0]).not.toMatch(/Do NOT/i);
	});

	it("injects removal-intent system reminders on /todo rm (all) and /todo rm <phase>", async () => {
		const initial: TodoPhase[] = [
			{ name: "Foundation", tasks: [{ content: "Scaffold crate", status: "completed" }] },
			{ name: "Auth", tasks: [{ content: "Port store", status: "pending" }] },
		];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);

		expect(await executeAcpBuiltinSlashCommand("/todo rm Auth", runtime)).toEqual({ consumed: true });
		expect(output[0]).toBe("Removed phase: Auth");

		expect(await executeAcpBuiltinSlashCommand("/todo rm", runtime)).toEqual({ consumed: true });
		expect(output[1]).toBe("Cleared all todos.");
		expect(session.getTodoPhases()).toEqual([]);

		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(2);
		expect(reminders[0]).toMatch(/Do NOT re-add them/i);
		expect(reminders[1]).toContain("intentionally cleared the todo list");
		expect(reminders[1]).toMatch(/Do NOT recreate/i);
	});

	it("surfaces applyOpsToPhases errors on bare /todo done without committing or sending a reminder", async () => {
		const initial: TodoPhase[] = [{ name: "Work", tasks: [{ content: "", status: "pending" }] }];
		const { session, sessionManager, output, runtime } = createTodoTestHarness(initial);
		const entriesBefore = sessionManager.getBranch().length;

		const result = await executeAcpBuiltinSlashCommand("/todo done", runtime);

		expect(result).toEqual({ consumed: true, failed: true });
		expect(output).toEqual(["Missing task content"]);
		expect(session.getTodoPhases()).toEqual(initial);
		expect(sessionManager.getBranch()).toHaveLength(entriesBefore);
		expect(developerMessagesFrom(session, sessionManager)).toEqual([]);
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

	it("keeps TUI TodoCommandController bare done/drop and error surfacing aligned", async () => {
		const initial: TodoPhase[] = [
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "in_progress" },
					{ content: "Add tests", status: "pending" },
				],
			},
		];
		const { session, sessionManager } = createTodoTestHarness(initial);
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

		await controller.handleTodoCommand("drop");

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Marked all tasks abandoned.");
		expect(session.getTodoPhases()).toEqual([
			{
				name: "Build",
				tasks: [
					{ content: "Wire parser", status: "abandoned" },
					{ content: "Add tests", status: "abandoned" },
				],
			},
		]);
		expect(setTodos).toHaveBeenCalledWith(session.getTodoPhases());
		const reminders = developerMessagesFrom(session, sessionManager);
		expect(reminders).toHaveLength(1);
		expect(reminders[0]).toContain("The user manually modified the todo list (/todo drop (all)).");
	});
});
