import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyStartupCwd } from "@oh-my-pi/pi-coding-agent/cli/startup-cwd";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as natives from "@oh-my-pi/pi-natives";
import { getProjectDir, postmortem, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../src/ui/theme/service";
import { createModeTerminal } from "./helpers/mode-terminal";

describe("InteractiveMode restart", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessionManager: SessionManager;
	let session: AgentSession | undefined;
	let originalArgv: string[];
	let originalProjectDir: string;

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@omp-restart-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		originalArgv = process.argv;
		originalProjectDir = getProjectDir();
		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "persona sessions"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		process.argv = originalArgv;
		await session?.dispose();
		session = undefined;
		await sessionManager.close();
		authStorage.close();
		setProjectDir(originalProjectDir);
		tempDir.removeSync();
		resetSettingsForTest();
	});

	async function restart(argv: string[], beforeRestart?: (mode: InteractiveMode) => Promise<void>): Promise<string[]> {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
		});
		const mode = new InteractiveMode(
			session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			createModeTerminal().frame,
		);
		process.argv = [originalArgv[0], originalArgv[1], ...argv];
		await beforeRestart?.(mode);
		// Stop only at the process replacement boundary; teardown and argv production run for real.
		const exec = vi.spyOn(natives, "execReplace").mockImplementation(() => undefined as never);
		const spawn = vi.spyOn(Bun, "spawn").mockReturnValue({ exited: Promise.resolve(0) } as never);
		vi.spyOn(postmortem, "cleanup").mockResolvedValue();
		vi.spyOn(postmortem, "drainStdout").mockResolvedValue();
		vi.spyOn(postmortem, "quit").mockResolvedValue();
		await mode.restart();
		const command = process.platform === "win32" ? spawn.mock.calls[0]?.[0] : exec.mock.calls[0]?.[1];
		if (!Array.isArray(command)) throw new Error("expected replacement command");
		return command;
	}

	it("resumes an explicitly opened persona journal without rediscovering its ID", async () => {
		sessionManager.appendMessage({ role: "user", content: "initial request", timestamp: 1 });
		sessionManager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			api: "anthropic-messages",
			content: [{ type: "text", text: "saved answer" }],
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			timestamp: 2,
		});
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const transcript = sessionManager.buildSessionContext().messages;
		await sessionManager.close();
		sessionManager = await SessionManager.open(file);
		const command = await restart([
			"--session",
			file,
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--append-system-prompt",
			"persona prompt",
			"--skills",
			"/office/skills",
			"-e",
			"/office/extension.ts",
			"--model",
			"openai-codex/gpt-6.1-sol:high",
			"initial request",
		]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.model).toBe("openai-codex/gpt-6.1-sol:high");
		expect(parsed.messages).toEqual([]);
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(file);
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual(transcript);
		} finally {
			await resumed.close();
		}
	});

	it("resumes a journal created in a flag-looking relative directory", async () => {
		using relativeDir = TempDir.createSync("-omp-restart-");
		await sessionManager.close();
		sessionManager = SessionManager.create(tempDir.path(), relativeDir.path());
		sessionManager.appendMessage({ role: "user", content: "saved request", timestamp: 1 });
		await sessionManager.ensureOnDisk();
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("expected persisted journal");
		const id = sessionManager.getSessionId();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", `--session-dir=${relativeDir.path()}`]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		const resumed = await createSessionManager(parsed, tempDir.path(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getSessionFile()).toBe(path.resolve(file));
			expect(resumed.getSessionId()).toBe(id);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "saved request", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});

	it("does not resume a journal that has never materialized", async () => {
		const file = sessionManager.getSessionFile();
		const command = await restart(["--model", "anthropic/claude-sonnet-4-5", "initial request"]);
		const parsed = parseArgs(command.slice(command.indexOf("--model")));
		expect(parsed.resume).toBeUndefined();
		expect(parsed.messages).toEqual([]);
		expect(sessionManager.isSessionOnDisk()).toBe(false);
		if (!file) throw new Error("expected allocated journal path");
		expect(await Bun.file(file).exists()).toBe(false);
	});

	it("replaces a relative --cwd with the resolved directory and preserves home launches across restart", async () => {
		const homeDir = path.join(tempDir.path(), "home");
		await fs.mkdir(path.join(homeDir, "tmp"), { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);

		setProjectDir(tempDir.path());
		const launchArgv = ["--cwd", "home", "--model", "anthropic/claude-sonnet-4-5"];
		await applyStartupCwd(parseArgs(launchArgv));
		await sessionManager.close();
		sessionManager = SessionManager.create(getProjectDir(), path.join(tempDir.path(), "home-sessions"));

		const command = await restart(launchArgv);
		const parsed = parseArgs(command.slice(command.findIndex(arg => arg.startsWith("-"))));
		await applyStartupCwd(parsed);
		expect(getProjectDir()).toBe(homeDir);
	});

	it("updates --cwd after /move so restart neither fails on a removed startup directory nor jumps back", async () => {
		const dirA = path.join(tempDir.path(), "dir-a");
		const dirB = path.join(tempDir.path(), "dir-b");
		const agentDir = path.join(tempDir.path(), "agent");
		await fs.mkdir(dirA, { recursive: true });
		await fs.mkdir(dirB, { recursive: true });

		setProjectDir(tempDir.path());
		const launchArgv = [`--cwd=${dirA}`, "--model", "anthropic/claude-sonnet-4-5"];
		await applyStartupCwd(parseArgs(launchArgv));
		await sessionManager.close();
		sessionManager = SessionManager.create(dirA, SessionManager.getDefaultSessionDir(dirA, agentDir));
		sessionManager.appendMessage({ role: "user", content: "moved session", timestamp: 1 });
		await sessionManager.ensureOnDisk();

		const command = await restart(launchArgv, async mode => {
			await fs.rm(dirA, { recursive: true });
			await mode.handleMoveCommand(dirB);
		});

		expect(command).not.toContain(`--cwd=${dirA}`);
		const parsed = parseArgs(command.slice(command.findIndex(arg => arg.startsWith("-"))));
		await applyStartupCwd(parsed);
		expect(parsed.cwd).toBe(dirB);
		expect(getProjectDir()).toBe(dirB);
		const resumed = await createSessionManager(parsed, getProjectDir(), Settings.isolated());
		if (!resumed) throw new Error("expected resumed journal");
		try {
			expect(resumed.getCwd()).toBe(dirB);
			expect(resumed.buildSessionContext().messages).toEqual([
				{ role: "user", content: "moved session", timestamp: 1 },
			]);
		} finally {
			await resumed.close();
		}
	});
});
