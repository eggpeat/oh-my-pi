/**
 * Regression: Exa MCP servers are filtered out by default because the native
 * Exa integration covers `web_search_exa`. But a config that explicitly
 * requests Exa tools the native integration does NOT provide (e.g.
 * `web_fetch_exa`, `web_search_advanced_exa`) must stay mounted as an MCP
 * server instead of being dropped — and so must any Exa MCP server while the
 * native integration cannot serve it (`exa.enabled: false`, or keyless while
 * `providers.webKeyless` is off and no Exa credential exists): folding there
 * leaves Exa reachable through neither the MCP tool nor `web_search`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import "@oh-my-pi/pi-coding-agent/discovery";
import {
	filterExaMCPServers,
	loadAllMCPConfigs,
	shouldFilterBrowserMCPForPrelude,
} from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/tmp/mcp.json",
	level: "user",
};

describe("browser prelude MCP filtering", () => {
	test("filters only when unrestricted browser and Eval are all active", () => {
		expect(
			shouldFilterBrowserMCPForPrelude({
				restrictToolNames: false,
				browserEnabled: true,
				evalRegistered: true,
				evalActive: true,
			}),
		).toBe(true);
		for (const options of [
			{ restrictToolNames: false, browserEnabled: false, evalRegistered: true, evalActive: true },
			{ restrictToolNames: true, browserEnabled: true, evalRegistered: true, evalActive: true },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: false, evalActive: false },
			{ restrictToolNames: false, browserEnabled: true, evalRegistered: true, evalActive: false },
		]) {
			expect(shouldFilterBrowserMCPForPrelude(options)).toBe(false);
		}
	});
});

describe("Exa MCP filtering", () => {
	test("filters an exa server restricted to the native web_search_exa tool", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=sk-1" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("keeps an exa server that requests tools beyond the native integration", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "http",
				url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,web_search_advanced_exa&exaApiKey=sk-1",
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
		expect(result.sources.exa).toEqual(SOURCE);
		expect(result.exaApiKeys).toEqual(["sk-1"]);
	});

	test("filters an exa server with no tools restriction", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(result.configs).toEqual({});
	});

	test("keeps a stdio exa server that requests extra tools", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools=web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});

	test("keeps a stdio exa server with a separate tools argument", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: {
				type: "stdio",
				command: "npx",
				args: ["-y", "exa-mcp-server", "--tools", "web_search_exa,web_fetch_exa"],
			},
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});
});

describe("Exa MCP filtering with native coverage limits", () => {
	test("keeps every exa server and extracts no key when the native provider is disabled", () => {
		const configs: Record<string, MCPServerConfig> = {
			keyless: { type: "http", url: "https://mcp.exa.ai/mcp" },
			keyed: { type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=sk-2" },
		};
		const result = filterExaMCPServers(configs, { keyless: SOURCE, keyed: SOURCE }, { nativeEnabled: false });

		expect(Object.keys(result.configs).sort()).toEqual(["keyed", "keyless"]);
		expect(result.exaApiKeys).toEqual([]);
	});

	test("keeps a keyless exa server but folds a keyed one when native keyless search is off", () => {
		const configs: Record<string, MCPServerConfig> = {
			keyless: { type: "http", url: "https://mcp.exa.ai/mcp" },
			keyed: { type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=sk-2" },
		};
		const result = filterExaMCPServers(configs, { keyless: SOURCE, keyed: SOURCE }, { keylessCovered: false });

		expect(Object.keys(result.configs)).toEqual(["keyless"]);
		expect(result.exaApiKeys).toEqual(["sk-2"]);
	});

	test("keeps a keyless exa server that requests extra tools when keyless search is covered", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa" },
		};
		const result = filterExaMCPServers(configs, { exa: SOURCE });

		expect(Object.keys(result.configs)).toEqual(["exa"]);
	});
});

describe("Exa MCP fold against live native-search settings", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let originalHome: string | undefined;
	let originalExaKey: string | undefined;
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

	beforeEach(async () => {
		originalHome = process.env.HOME;
		originalExaKey = process.env.EXA_API_KEY;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-exa-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-exa-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-exa-agent-"));
		process.env.HOME = tempHome;
		delete process.env.EXA_API_KEY;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({ mcpServers: { exa: { type: "http", url: "https://mcp.exa.ai/mcp" } } }),
		);
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
		if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = originalExaKey;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("folds the keyless exa server under default settings", async () => {
		const settings = await Settings.init({ inMemory: true });

		const result = await loadAllMCPConfigs(projectDir, { settings });

		expect(result.configs.exa).toBeUndefined();
	});

	test("keeps a keyless exa server when keyless services are off and no credential exists", async () => {
		const settings = await Settings.init({ inMemory: true, overrides: { "providers.webKeyless": false } });

		const result = await loadAllMCPConfigs(projectDir, { settings });

		expect(result.configs.exa?.type).toBe("http");
	});

	test("keeps a keyless exa server when the native exa provider is disabled", async () => {
		const settings = await Settings.init({ inMemory: true, overrides: { "exa.enabled": false } });

		const result = await loadAllMCPConfigs(projectDir, { settings });

		expect(result.configs.exa?.type).toBe("http");
	});

	test("folds a keyless exa server when keyless services are off but a credential exists", async () => {
		const settings = await Settings.init({ inMemory: true, overrides: { "providers.webKeyless": false } });
		const authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("exa", "sk-stored");

		const result = await loadAllMCPConfigs(projectDir, { settings, authStorage });

		expect(result.configs.exa).toBeUndefined();
	});
});
