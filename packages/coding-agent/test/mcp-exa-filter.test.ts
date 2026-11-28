/**
 * Regression: Exa MCP servers are filtered out by default because the native
 * Exa integration covers `web_search_exa`. But a config that explicitly
 * requests Exa tools the native integration does NOT provide (e.g.
 * `web_fetch_exa`, `web_search_advanced_exa`) must stay mounted as an MCP
 * server instead of being dropped.
 */
import { describe, expect, test } from "bun:test";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { filterExaMCPServers, shouldFilterBrowserMCPForPrelude } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";

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

	test("keeps a keyless exa server when native Exa is disabled", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
		};
		const settings = Settings.isolated({ "exa.enabled": false });
		const result = filterExaMCPServers(configs, { exa: SOURCE }, settings);

		expect(result.configs).toEqual(configs);
		expect(result.sources).toEqual({ exa: SOURCE });
		expect(result.exaApiKeys).toEqual([]);
	});

	test("keeps Exa servers and their credentials in MCP when keyless web services are disabled", () => {
		const configs: Record<string, MCPServerConfig> = {
			keyless: { type: "http", url: "https://mcp.exa.ai/mcp" },
			exa: {
				type: "stdio",
				command: "exa-mcp",
				env: { EXA_API_KEY: "configured-key" },
			},
		};
		const sources = { keyless: SOURCE, exa: SOURCE };
		const settings = Settings.isolated({ "providers.webKeyless": false });
		const result = filterExaMCPServers(configs, sources, settings);

		expect(result.configs).toEqual(configs);
		expect(result.sources).toEqual(sources);
		expect(result.exaApiKeys).toEqual([]);
	});

	test("filters a keyless exa server when native keyless search is enabled", () => {
		const configs: Record<string, MCPServerConfig> = {
			exa: { type: "http", url: "https://mcp.exa.ai/mcp" },
		};
		const settings = Settings.isolated({ "exa.enabled": true, "providers.webKeyless": true });
		const result = filterExaMCPServers(configs, { exa: SOURCE }, settings);

		expect(result.configs).toEqual({});
		expect(result.sources).toEqual({});
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
