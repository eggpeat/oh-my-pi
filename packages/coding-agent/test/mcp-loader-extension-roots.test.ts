/**
 * Regression: `discoverAndLoadMCPTools` must forward the session's effective
 * extension roots to the manager. Dropping them made discovery (and every later
 * live reconcile, which reuses the stored discovery options) fall back to
 * ambient extension discovery, so MCP servers from session-provided extension
 * paths were never found.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import "@oh-my-pi/pi-coding-agent/discovery";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("discoverAndLoadMCPTools extension roots", () => {
	let tempHome = "";
	let projectDir = "";
	let userAgentDir = "";
	let extensionDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-loader-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-loader-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-loader-agent-"));
		extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-loader-extension-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(userAgentDir);
		clearFsCache();
		await fs.writeFile(
			path.join(extensionDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { extensionserver: { command: "extension-mcp" } } }),
		);
		// Stand in for the transport only: report every resolved server as connected.
		vi.spyOn(MCPManager.prototype, "connectServers").mockImplementation(async configs => ({
			tools: [],
			errors: new Map(),
			connectedServers: Object.keys(configs),
			exaApiKeys: [],
		}));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
		await removeWithRetries(extensionDir);
	});

	test("discovers MCP servers from session-provided extension roots", async () => {
		const result = await discoverAndLoadMCPTools(projectDir, {
			filterExa: false,
			extensionRoots: { explicit: [extensionDir], mode: "explicit-only", configured: [], configuredLevel: "user" },
		});
		expect(result.connectedServers).toEqual(["extensionserver"]);
	});
});
