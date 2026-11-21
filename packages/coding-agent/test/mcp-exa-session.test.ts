/**
 * Regression tests for Exa MCP folding decisions that depend on session settings
 * and credentials. Keyless Exa MCP servers must survive whenever native Exa
 * cannot cover them, without enabling keyless native search.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgProvidersWebKeyless } from "@oh-my-pi/pi-coding-agent/session/settings";
import { ExaProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getConfigRootDir, getProjectDir, removeWithRetries, setAgentDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const KEYLESS_EXA = { type: "http", url: "https://mcp.exa.ai/mcp" } as const;
const DUMMY_KEY = "exa-test-key";

async function writeMcpJson(dir: string, servers: Record<string, unknown>): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

describe("Exa MCP folding with session settings", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;
	let originalExaApiKey: string | undefined;
	let originalProjectDir = "";

	beforeEach(async () => {
		originalHome = process.env.HOME;
		originalExaApiKey = process.env.EXA_API_KEY;
		originalProjectDir = getProjectDir();
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-session-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-session-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-session-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = originalExaApiKey;
		setProjectDir(originalProjectDir);
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("keeps a keyless Exa MCP server when providers.webKeyless is off and no Exa key exists", async () => {
		delete process.env.EXA_API_KEY;
		const authStorage = createInMemoryAuthStorage();
		try {
			const sessionSettings = Settings.isolated({ "exa.enabled": true, "providers.webKeyless": false });
			await writeMcpJson(path.join(projectDir, ".omp"), { exa: KEYLESS_EXA });

			const keylessResult = await loadAllMCPConfigs(projectDir, { settings: sessionSettings, authStorage });
			expect(keylessResult.configs.exa).toEqual(KEYLESS_EXA);
			expect(keylessResult.sources.exa?.level).toBe("project");
			expect(keylessResult.exaApiKeys).toEqual([]);
			expect(cfgProvidersWebKeyless.get(sessionSettings)).toBe(false);
			expect(new ExaProvider().isKeyless(authStorage)).toBe(true);
			expect(process.env.EXA_API_KEY).toBeUndefined();

			// An embedded key in the MCP config still folds into native Exa when native Exa is enabled.
			clearFsCache();
			const keyedExa = { type: "http", url: `https://mcp.exa.ai/mcp?exaApiKey=${DUMMY_KEY}` } as const;
			await writeMcpJson(path.join(projectDir, ".omp"), { exa: keyedExa });
			const keyedResult = await loadAllMCPConfigs(projectDir, { settings: sessionSettings, authStorage });
			expect(keyedResult.configs.exa).toBeUndefined();
			expect(keyedResult.exaApiKeys).toEqual([DUMMY_KEY]);

			// Turning native Exa off keeps even a keyed Exa MCP server without extracting its key.
			const disabledResult = await loadAllMCPConfigs(projectDir, {
				settings: Settings.isolated({ "exa.enabled": false }),
				authStorage,
			});
			expect(disabledResult.configs.exa).toEqual(keyedExa);
			expect(disabledResult.exaApiKeys).toEqual([]);

			// Once an Exa credential exists in authStorage, native Exa is no longer keyless so keyless MCP folds.
			clearFsCache();
			await writeMcpJson(path.join(projectDir, ".omp"), { exa: KEYLESS_EXA });
			authStorage.keys.setRuntime("exa", DUMMY_KEY);
			const authenticatedResult = await loadAllMCPConfigs(projectDir, { settings: sessionSettings, authStorage });
			expect(authenticatedResult.configs.exa).toBeUndefined();
			expect(authenticatedResult.exaApiKeys).toEqual([]);

			// Without an explicit authStorage, EXA_API_KEY still marks native Exa as authenticated.
			process.env.EXA_API_KEY = DUMMY_KEY;
			const envAuthenticatedResult = await loadAllMCPConfigs(projectDir, { settings: sessionSettings });
			expect(envAuthenticatedResult.configs.exa).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});

	test("uses the owning SDK session settings for Exa MCP discovery and reload", async () => {
		delete process.env.EXA_API_KEY;
		// Global settings keep native Exa and keyless search on while the session overrides them off.
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": true, "providers.webKeyless": true } });
		await writeMcpJson(path.join(projectDir, ".omp"), {
			exa: { type: "stdio", command: "/nonexistent/exa-mcp-server" },
		});

		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionsToDispose: Array<{ dispose(): Promise<void> }> = [];
		try {
			const startWithSettings = async (overrides: Record<string, unknown>) => {
				const result = await createAgentSession({
					cwd: projectDir,
					agentDir: userAgentDir,
					modelRegistry,
					sessionManager: SessionManager.inMemory(projectDir),
					settings: Settings.isolated({
						"browser.enabled": false,
						"disassembler.backend": "none",
						...overrides,
					}),
					model: getBundledModel("openai", "gpt-4o-mini"),
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableLsp: false,
					skipPythonPreflight: true,
					enableMCP: true,
				});
				sessionsToDispose.push(result.session);
				if (!result.mcpManager) throw new Error("expected the session to own an MCP manager");
				return result;
			};

			const disabled = await startWithSettings({ "exa.enabled": false });
			expect(disabled.mcpManager!.getAllServerNames()).toContain("exa");
			await disabled.session.reloadMCPServers();
			expect(disabled.mcpManager!.getAllServerNames()).toContain("exa");

			const noKeyless = await startWithSettings({ "exa.enabled": true, "providers.webKeyless": false });
			expect(noKeyless.mcpManager!.getAllServerNames()).toContain("exa");
			await noKeyless.session.reloadMCPServers();
			expect(noKeyless.mcpManager!.getAllServerNames()).toContain("exa");

			// Adding a stored Exa key makes native Exa authenticated, so reload folds the keyless server.
			authStorage.keys.setRuntime("exa", DUMMY_KEY);
			await noKeyless.session.reloadMCPServers();
			expect(noKeyless.mcpManager!.getAllServerNames()).not.toContain("exa");
		} finally {
			for (const session of sessionsToDispose) await session.dispose().catch(() => {});
			authStorage.close();
		}
	});

	test("honors session settings and authStorage in /mcp reload, /mcp enable, and dashboard toggle", async () => {
		initTheme();
		delete process.env.EXA_API_KEY;
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": true, "providers.webKeyless": true } });
		setProjectDir(projectDir);
		await writeMcpJson(path.join(projectDir, ".omp"), {
			exa: { type: "stdio", command: "/nonexistent/exa-mcp-server" },
		});

		const authStorage = createInMemoryAuthStorage();
		const manager = new MCPManager(projectDir);
		manager.setAuthStorage(authStorage);
		try {
			const disabledSettings = Settings.isolated({ "exa.enabled": false });
			const ctx = createInteractiveModeContext({
				settings: disabledSettings,
				mcpManager: manager,
				session: { modelRegistry: { authStorage } as unknown as ModelRegistry },
			});
			const controller = new MCPCommandController(ctx);

			// `/mcp reload` uses the session's settings, not global settings.
			await controller.reloadServers();
			expect(manager.getAllServerNames()).toContain("exa");

			// `/mcp enable` uses the session's settings when connecting the enabled server.
			await manager.disconnectAll();
			await writeMcpJson(path.join(projectDir, ".omp"), {
				exa: { type: "stdio", command: "/nonexistent/exa-mcp-server", enabled: false },
			});
			clearFsCache();
			await controller.handle("/mcp enable exa");
			expect(manager.getAllServerNames()).toContain("exa");

			// Dashboard toggle uses both the session's settings and the manager's authStorage.
			await manager.disconnectAll();
			const noKeylessSettings = Settings.isolated({ "exa.enabled": true, "providers.webKeyless": false });
			const dashboard = createExtensionDashboardRuntime({
				cwd: projectDir,
				settings: noKeylessSettings,
				mcpManager: manager,
			});
			await dashboard.applyMcpToggle("exa", true);
			expect(manager.getAllServerNames()).toContain("exa");

			await manager.disconnectAll();
			authStorage.keys.setRuntime("exa", DUMMY_KEY);
			await dashboard.applyMcpToggle("exa", true);
			expect(manager.getAllServerNames()).not.toContain("exa");

			// `/mcp reload` and `/mcp enable` also forward session authStorage to config loading.
			const authOnlyManager = new MCPManager(projectDir);
			try {
				const authController = new MCPCommandController(
					createInteractiveModeContext({
						settings: noKeylessSettings,
						mcpManager: authOnlyManager,
						session: { modelRegistry: { authStorage } as unknown as ModelRegistry },
					}),
				);
				await authController.reloadServers();
				expect(authOnlyManager.getAllServerNames()).not.toContain("exa");

				await writeMcpJson(path.join(projectDir, ".omp"), {
					exa: { type: "stdio", command: "/nonexistent/exa-mcp-server", enabled: false },
				});
				clearFsCache();
				await authController.handle("/mcp enable exa");
				expect(authOnlyManager.getAllServerNames()).not.toContain("exa");
			} finally {
				await authOnlyManager.disconnectAll();
			}
		} finally {
			await manager.disconnectAll();
			authStorage.close();
		}
	});
});
