import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { MCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("ACP /mcp config resolution", () => {
	let projectDir = "";
	let processDir = "";
	let agentDir = "";
	const outputs: string[] = [];

	beforeEach(async () => {
		outputs.length = 0;
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-project-"));
		processDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-process-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-acp-agent-"));
		// The session cwd deliberately differs from the process-wide project dir.
		setProjectDir(processDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(processDir);
		await removeWithRetries(agentDir);
	});

	function makeRuntime(): SlashCommandRuntime {
		return {
			session: { modelRegistry: { authStorage: {} } },
			sessionManager: {},
			settings: Settings.isolated(),
			cwd: projectDir,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: () => Promise.resolve(),
		} as unknown as SlashCommandRuntime;
	}

	async function writeConfig(scope: "user" | "project", config: MCPConfigFile): Promise<void> {
		await Bun.write(getMCPConfigPath(scope, projectDir), `${JSON.stringify(config, null, 2)}\n`);
	}

	function runMcp(args: string, runtime: SlashCommandRuntime) {
		return handleMcpAcp({ name: "mcp", args, text: `/mcp ${args}` }, runtime);
	}

	function mockConnections() {
		const connection = { capabilities: {} } as never;
		const connect = vi.spyOn(mcpClient, "connectToServer").mockResolvedValue(connection);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue();
		return connect;
	}

	test("list shows the effective project entries and user enable/disable overrides", async () => {
		await writeConfig("project", {
			mcpServers: {
				shared: { type: "stdio", command: "project-command" },
				"disabled-shadow": { type: "stdio", command: "project-disabled", enabled: false },
				forced: { type: "stdio", command: "project-forced", enabled: false },
				denied: { type: "stdio", command: "project-denied" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				shared: { type: "stdio", command: "user-command" },
				"disabled-shadow": { type: "stdio", command: "user-shadow" },
				"user-only": { type: "stdio", command: "user-only-command" },
			},
			disabledServers: ["denied"],
			enabledServers: ["forced"],
		});
		const runtime = makeRuntime();

		const result = await runMcp("list", runtime);

		expect(result).toEqual({ consumed: true });
		expect(outputs).toEqual([
			[
				"shared | stdio | enabled | project-command [project]",
				"disabled-shadow | stdio | disabled | project-disabled [project]",
				"forced | stdio | enabled | project-forced [project]",
				"denied | stdio | disabled | project-denied [project]",
				"user-only | stdio | enabled | user-only-command [user]",
			].join("\n"),
		]);
	});

	test("test connects only to effectively enabled servers in the session cwd", async () => {
		await writeConfig("project", {
			mcpServers: {
				"disabled-shadow": { type: "stdio", command: "project-disabled", enabled: false },
				forced: { type: "stdio", command: "project-forced", enabled: false },
				denied: { type: "stdio", command: "project-denied" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				"disabled-shadow": { type: "stdio", command: "user-shadow" },
			},
			disabledServers: ["denied"],
			enabledServers: ["forced"],
		});
		const runtime = makeRuntime();
		const connect = mockConnections();

		const shadowResult = await runMcp("test disabled-shadow", runtime);
		expect(shadowResult).toEqual({ consumed: true, failed: true });
		expect(outputs.at(-1)).toContain('Server "disabled-shadow" not found');
		expect(connect).not.toHaveBeenCalled();

		const forcedResult = await runMcp("test forced", runtime);
		expect(forcedResult).toEqual({ consumed: true });
		expect(outputs.at(-1)).toBe('Server "forced" connected (0 tools).');
		expect(connect).toHaveBeenCalledTimes(1);
		expect(connect).toHaveBeenCalledWith(
			"forced",
			expect.objectContaining({ command: "project-forced", enabled: false }),
			{ live: true, cwd: projectDir },
		);

		const deniedResult = await runMcp("test denied", runtime);
		expect(deniedResult).toEqual({ consumed: true, failed: true });
		expect(outputs.at(-1)).toContain('Server "denied" not found');
		expect(connect).toHaveBeenCalledTimes(1);
	});

	test("project-config opt-out exposes user entries without resurrecting project entries", async () => {
		await writeConfig("project", {
			mcpServers: {
				shared: { type: "stdio", command: "project-command" },
				"project-only": { type: "stdio", command: "project-only-command" },
			},
		});
		await writeConfig("user", {
			mcpServers: {
				shared: { type: "stdio", command: "user-command" },
				"user-only": { type: "stdio", command: "user-only-command" },
			},
		});
		const runtime = makeRuntime();
		cfgMcpEnableProjectConfig.set(runtime.settings, false);
		const connect = mockConnections();

		const listResult = await runMcp("list", runtime);
		expect(listResult).toEqual({ consumed: true });
		expect(outputs.at(-1)).toBe(
			[
				"shared | stdio | enabled | user-command [user]",
				"user-only | stdio | enabled | user-only-command [user]",
			].join("\n"),
		);

		const testResult = await runMcp("test shared", runtime);
		expect(testResult).toEqual({ consumed: true });
		expect(connect).toHaveBeenCalledWith("shared", expect.objectContaining({ command: "user-command" }), {
			live: true,
			cwd: projectDir,
		});

		const projectResult = await runMcp("test project-only", runtime);
		expect(projectResult).toEqual({ consumed: true, failed: true });
		expect(outputs.at(-1)).toContain('Server "project-only" not found');
		expect(connect).toHaveBeenCalledTimes(1);
	});
});
