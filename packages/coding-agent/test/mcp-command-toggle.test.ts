import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import { handleMcpAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/mcp";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPDroppedServer } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function createController(
	builtinDrops = new Map<string, MCPDroppedServer>(),
	options?: {
		getServerConfig?: (name: string) => MCPServerConfig | undefined;
		getSource?: (name: string) => SourceMeta | undefined;
		settings?: Settings;
	},
) {
	const refreshMCPTools = vi.fn(async () => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		}),
	);
	const mcpManager = createMcpManagerStub({
		connectServers,
		getBuiltinDrops: () => builtinDrops,
		...(options?.getServerConfig ? { getServerConfig: options.getServerConfig } : {}),
		...(options?.getSource ? { getSource: options.getSource } : {}),
	});
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
		...(options?.settings ? { settings: options.settings } : {}),
	});
	const controller = new MCPCommandController(ctx);

	return { controller, mcpManager, refreshMCPTools, connectServers };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

function discoveredLookup(name: string, config: MCPServerConfig, sourcePath: string) {
	const source: SourceMeta = {
		provider: "claude",
		providerName: "Claude Code",
		path: sourcePath,
		level: "user",
	};
	return {
		getServerConfig: (serverName: string) => (serverName === name ? config : undefined),
		getSource: (serverName: string) => (serverName === name ? source : undefined),
	};
}

const FOREIGN_COMMAND = "omp201-foreign-cmd";

function foreignConfig(enabled?: boolean): MCPServerConfig {
	return {
		type: "stdio",
		command: FOREIGN_COMMAND,
		envPolicy: "literal",
		...(enabled === undefined ? {} : { enabled }),
	};
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, connectServers } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("enabling a server a built-in transform dropped records the enable and connects it", async () => {
		// Codex's config is another tool's file: the enable can only live in the
		// user allowlist, and that entry is what keeps the next discovery from
		// dropping the server again.
		const codexConfig = path.join(projectDir, ".codex", "config.toml");
		await Bun.write(codexConfig, '[mcp_servers.codex_js]\ncommand = "/opt/codex/cua_node/bin/node_repl"\n');
		const source: SourceMeta = {
			provider: "codex",
			providerName: "OpenAI Codex",
			path: codexConfig,
			level: "project",
		};
		const { controller, connectServers } = createController(
			new Map([["codex_js", { reason: "eval already runs JavaScript", source }]]),
		);

		await controller.handle("/mcp enable codex_js");

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers).toEqual(["codex_js"]);
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs.codex_js).toMatchObject({ type: "stdio", command: "/opt/codex/cua_node/bin/node_repl" });
	});

	function userPath(): string {
		return getMCPConfigPath("user", projectDir);
	}

	async function loadedHas(name: string): Promise<boolean> {
		const loaded = await loadAllMCPConfigs(projectDir, { filterExa: false, enableProjectConfig: true });
		return loaded.configs[name] !== undefined;
	}

	function acpRuntime(mcpManager?: SlashCommandRuntime["mcpManager"], settings = Settings.isolated()) {
		const outputs: string[] = [];
		const runtime = {
			session: {},
			sessionManager: {},
			settings,
			cwd: projectDir,
			mcpManager,
			output: (text: string) => {
				outputs.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		} as unknown as SlashCommandRuntime;
		return { runtime, outputs, settings };
	}

	async function runAcp(args: string, mcpManager?: SlashCommandRuntime["mcpManager"], settings?: Settings) {
		const ctx = acpRuntime(mcpManager, settings);
		await handleMcpAcp({ args } as ParsedSlashCommand, ctx.runtime);
		return ctx;
	}

	test("disabling a discovered server denylists it instead of copying it into user config", async () => {
		// A third-party server must not be cloned into ~/.omp/agent/mcp.json, or that
		// copy permanently shadows later changes to the upstream definition.
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(), foreignPath),
		);

		await controller.handle("/mcp disable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain(FOREIGN_COMMAND);
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("enabling a switched-off discovered server allowlists it instead of copying it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(false), foreignPath),
		);

		await controller.handle("/mcp enable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers).toContain("omp201-foreign");
		expect(user.disabledServers ?? []).not.toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("enabling an already-on discovered server does not copy it or allowlist it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		const { controller } = createController(
			new Map(),
			discoveredLookup("omp201-foreign", foreignConfig(), foreignPath),
		);

		await controller.handle("/mcp enable omp201-foreign");

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers ?? []).not.toContain("omp201-foreign");
	});

	test("enabling a configured server on the denylist turns it back on", async () => {
		// disabledServers wins over enabled: true. Leaving the name there keeps
		// the server off after the next load.
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd" },
		});
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-native"] }, null, 2)}\n`);
		const { controller, connectServers } = createController();

		await controller.handle("/mcp enable omp201-native");

		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		expect(user.enabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(true);
		expect(await loadedHas("omp201-native")).toBe(true);
		expect(connectServers).toHaveBeenCalled();
	});

	test("disabling a configured server on the allowlist turns it back off", async () => {
		// enabledServers overrides enabled: false. Leaving the name there keeps
		// the server on after the next load.
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd", enabled: false },
		});
		await Bun.write(userPath(), `${JSON.stringify({ enabledServers: ["omp201-native"] }, null, 2)}\n`);
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp disable omp201-native");

		const user = await readMCPConfigFile(userPath());
		expect(user.enabledServers ?? []).not.toContain("omp201-native");
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(false);
		expect(await loadedHas("omp201-native")).toBe(false);
		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("omp201-native");
	});

	test("enabling a standalone mcp.json server writes that file and clears a stale denylist", async () => {
		const standalone = path.join(projectDir, "mcp.json");
		await Bun.write(
			standalone,
			`${JSON.stringify(
				{ mcpServers: { "omp201-solo": { type: "stdio", command: "solo-cmd", enabled: false } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-solo"] }, null, 2)}\n`);
		const { controller } = createController();

		await controller.handle("/mcp enable omp201-solo");

		const saved = await readMCPConfigFile(standalone);
		expect(saved.mcpServers?.["omp201-solo"]?.enabled).toBe(true);
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-solo");
		expect(user.enabledServers ?? []).not.toContain("omp201-solo");
		expect(user.mcpServers?.["omp201-solo"]).toBeUndefined();
	});

	test("disabling a discovered server does not rewrite an opted-out project mcp.json", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-foreign": foreignConfig(),
		});
		const before = await Bun.file(projectPath).text();
		const settings = Settings.isolated();
		cfgMcpEnableProjectConfig.set(settings, false);
		const { controller } = createController(new Map(), {
			settings,
			...discoveredLookup("omp201-foreign", foreignConfig(), path.join(projectDir, "claude.json")),
		});

		await controller.handle("/mcp disable omp201-foreign");

		expect(await Bun.file(projectPath).text()).toBe(before);
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain(FOREIGN_COMMAND);
	});

	test("ACP enable clears a stale denylist so the configured server loads", async () => {
		await writeProjectConfig(projectDir, {
			"omp201-native": { type: "stdio", command: "native-cmd" },
		});
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-native"] }, null, 2)}\n`);

		const { outputs } = await runAcp("enable omp201-native");

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-native");
		const project = await readMCPConfigFile(getMCPConfigPath("project", projectDir));
		expect(project.mcpServers?.["omp201-native"]?.enabled).toBe(true);
		expect(await loadedHas("omp201-native")).toBe(true);
	});

	test("ACP disable clears a stale allowlist on a user config server", async () => {
		await Bun.write(
			userPath(),
			`${JSON.stringify(
				{
					mcpServers: { "omp201-user": { type: "stdio", command: "user-cmd", enabled: false } },
					enabledServers: ["omp201-user"],
				},
				null,
				2,
			)}\n`,
		);

		const { outputs } = await runAcp("disable omp201-user");

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.enabledServers ?? []).not.toContain("omp201-user");
		expect(user.disabledServers ?? []).not.toContain("omp201-user");
		expect(user.mcpServers?.["omp201-user"]?.enabled).toBe(false);
		expect(await loadedHas("omp201-user")).toBe(false);
	});

	test("ACP enable of a discovered server allowlists it instead of copying it", async () => {
		const foreignPath = path.join(projectDir, "claude.json");
		await Bun.write(foreignPath, "tool-owned\n");
		const manager = createMcpManagerStub(discoveredLookup("omp201-foreign", foreignConfig(false), foreignPath));

		const { outputs } = await runAcp("enable omp201-foreign", manager);

		expect(outputs.join("\n")).not.toContain("not found");
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers).toContain("omp201-foreign");
		expect(await Bun.file(userPath()).text()).not.toContain("envPolicy");
		expect(await Bun.file(foreignPath).text()).toBe("tool-owned\n");
	});

	test("ACP enable of an already-on discovered server does not copy it or allowlist it", async () => {
		const manager = createMcpManagerStub(
			discoveredLookup("omp201-foreign", foreignConfig(), path.join(projectDir, "claude.json")),
		);

		await runAcp("enable omp201-foreign", manager);

		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.enabledServers ?? []).not.toContain("omp201-foreign");
	});

	test("ACP enable of a standalone mcp.json server writes that file and clears a stale denylist", async () => {
		const standalone = path.join(projectDir, "mcp.json");
		await Bun.write(
			standalone,
			`${JSON.stringify(
				{ mcpServers: { "omp201-solo": { type: "stdio", command: "solo-cmd", enabled: false } } },
				null,
				2,
			)}\n`,
		);
		await Bun.write(userPath(), `${JSON.stringify({ disabledServers: ["omp201-solo"] }, null, 2)}\n`);

		await runAcp("enable omp201-solo");

		const saved = await readMCPConfigFile(standalone);
		expect(saved.mcpServers?.["omp201-solo"]?.enabled).toBe(true);
		const user = await readMCPConfigFile(userPath());
		expect(user.disabledServers ?? []).not.toContain("omp201-solo");
		expect(user.enabledServers ?? []).not.toContain("omp201-solo");
		expect(user.mcpServers?.["omp201-solo"]).toBeUndefined();
	});

	test("ACP disable does not rewrite an opted-out project mcp.json", async () => {
		const projectPath = getMCPConfigPath("project", projectDir);
		await writeProjectConfig(projectDir, {
			"omp201-foreign": foreignConfig(),
		});
		const before = await Bun.file(projectPath).text();
		const settings = Settings.isolated();
		cfgMcpEnableProjectConfig.set(settings, false);

		await runAcp("disable omp201-foreign", undefined, settings);

		expect(await Bun.file(projectPath).text()).toBe(before);
		const user = await readMCPConfigFile(userPath());
		expect(user.mcpServers?.["omp201-foreign"]).toBeUndefined();
		expect(user.disabledServers).toContain("omp201-foreign");
	});
});
