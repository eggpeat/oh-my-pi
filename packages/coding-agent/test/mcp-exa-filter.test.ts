/**
 * Regression: a configured Exa MCP server used to fold into native Exa search
 * even when that session could not use it, and a borrowed key was written to
 * process-wide EXA_API_KEY. The server now stays mounted unless this session's
 * native search can serve it, and the borrowed key stays with that session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { initTheme } from "@oh-my-pi/pi-coding-agent";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	filterExaMCPServers,
	loadAllMCPConfigs,
	shouldFilterBrowserMCPForPrelude,
} from "@oh-my-pi/pi-coding-agent/mcp/config";
import { HttpUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/http-upstream";
import { SseUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/sse-upstream";
import type { MCPDiscoverOptions, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPManager as RealMCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	clearSessionExaApiKey,
	getSessionExaApiKey,
	setManagerExaApiKey,
	setSessionExaApiKey,
} from "@oh-my-pi/pi-coding-agent/web/search/exa-session-key";
import {
	ExaProvider,
	resetExaSearchThrottleForTest,
	searchExa,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import {
	__resetDirsFromEnvForTests,
	getMCPConfigPath,
	getProjectDir,
	isRecord,
	logger,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const ENV_KEYS = [
	"HOME",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"EXA_API_KEY",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map(key => [key, process.env[key]]));

function restoreEnvironment(): void {
	for (const key of ENV_KEYS) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	__resetDirsFromEnvForTests();
}

const KEYED_EXA: MCPServerConfig = {
	type: "http",
	url: "https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=key-alpha",
};
const KEYED_EXA_B: MCPServerConfig = {
	type: "http",
	url: "https://mcp.exa.ai/mcp?tools=web_search_exa&exaApiKey=key-beta",
};
const KEYLESS_EXA: MCPServerConfig = { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa" };

const trackedSessionIds: string[] = [];
const trackedManagers: MCPManager[] = [];
const trackedAuthStorages: AuthStorage[] = [];
const trackedServers: Array<ReturnType<typeof Bun.serve>> = [];
const sessions: AgentSession[] = [];

function sourcesFor(...names: string[]): Record<string, SourceMeta> {
	const sources: Record<string, SourceMeta> = {};
	for (const name of names) sources[name] = { path: `/tmp/${name}.json` } as SourceMeta;
	return sources;
}

function emptyAuthStorage(): AuthStorage {
	const storage = createInMemoryAuthStorage();
	trackedAuthStorages.push(storage);
	return storage;
}

function registryFor(authStorage: AuthStorage, scope: Settings): ModelRegistry {
	return new ModelRegistry(authStorage, undefined, { settings: scope });
}

function nativeOptions(sessionSettings: Settings, authStorage: AuthStorage, extra?: { webSearchActive?: boolean }) {
	const sessionManager = SessionManager.inMemory();
	trackedSessionIds.push(sessionManager.getSessionId());
	return {
		settings: sessionSettings,
		authStorage,
		modelRegistry: registryFor(authStorage, sessionSettings),
		webSearchActive: () => extra?.webSearchActive ?? true,
		installExaApiKey: (key: string | undefined) => setSessionExaApiKey(sessionManager.getSessionId(), key),
		sessionManager,
	};
}

async function writeProjectMcp(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(getMCPConfigPath("project", projectDir), `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

function recordingFetch(seen: string[]): typeof fetch {
	return (async (_input: unknown, init?: { headers?: Record<string, string> }) => {
		seen.push(new Headers(init?.headers).get("x-api-key") ?? "");
		return Response.json({ results: [] });
	}) as typeof fetch;
}

let tempHome = "";
let projectDir = "";
let agentDir = "";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-fold-home-"));
	projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-fold-project-"));
	agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-exa-fold-agent-"));
	process.env.HOME = tempHome;
	delete process.env.PI_CONFIG_FILES;
	delete process.env.PI_CONFIG_DIR;
	delete process.env.EXA_API_KEY;
	setProjectDir(projectDir);
	setAgentDir(agentDir);
	vi.spyOn(os, "homedir").mockReturnValue(tempHome);
	resetExaSearchThrottleForTest();
	clearFsCache();
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	for (const server of trackedServers.splice(0)) server.stop(true);
	for (const id of trackedSessionIds.splice(0)) clearSessionExaApiKey(id);
	for (const manager of trackedManagers.splice(0)) await manager.disconnectAll().catch(() => {});
	for (const storage of trackedAuthStorages.splice(0)) storage.close();
	setProjectDir(originalProjectDir);
	restoreEnvironment();
	resetSettingsForTest();
	clearFsCache();
	await removeWithRetries(tempHome);
	await removeWithRetries(projectDir);
	await removeWithRetries(agentDir);
});

afterAll(() => {
	closeModelCache();
});

describe("browser prelude MCP filtering", () => {
	test("filters only when unrestricted browser and Eval are all active", () => {
		expect(
			shouldFilterBrowserMCPForPrelude({
				restrictToolNames: false,
				browserEnabled: true,
				evalActive: true,
				evalRegistered: true,
			}),
		).toBe(true);
		expect(
			shouldFilterBrowserMCPForPrelude({
				restrictToolNames: true,
				browserEnabled: true,
				evalActive: true,
				evalRegistered: true,
			}),
		).toBe(false);
	});
});

describe("Exa MCP fold decisions", () => {
	test("a keyed server folds only when this load installs its key", () => {
		expect(
			filterExaMCPServers({ exa: KEYED_EXA }, sourcesFor("exa"), { nativeEnabled: true }).configs.exa,
		).toBeUndefined();
		expect(
			filterExaMCPServers({ exa: KEYED_EXA }, sourcesFor("exa"), { nativeEnabled: true, installsExaApiKeys: false })
				.configs.exa?.type,
		).toBe("http");
	});

	test("the first key installs and a second account stays mounted", () => {
		const result = filterExaMCPServers({ exa: KEYED_EXA, exaAlt: KEYED_EXA_B }, sourcesFor("exa", "exaAlt"), {
			nativeEnabled: true,
		});
		expect(result.configs.exa).toBeUndefined();
		expect(result.configs.exaAlt?.type).toBe("http");
		expect(result.exaApiKeys).toEqual(["key-alpha", "key-beta"]);
	});

	test("a native credential folds keyed servers of any account", () => {
		const result = filterExaMCPServers({ exa: KEYED_EXA, exaAlt: KEYED_EXA_B }, sourcesFor(), {
			nativeEnabled: true,
			hasNativeCredential: true,
		});
		expect(result.configs.exa).toBeUndefined();
		expect(result.configs.exaAlt).toBeUndefined();
	});

	test("a keyless server folds when the same load installs a key", () => {
		const result = filterExaMCPServers({ exa: KEYED_EXA, exaKeyless: KEYLESS_EXA }, sourcesFor(), {
			nativeEnabled: true,
			keylessCovered: false,
		});
		expect(result.configs.exa).toBeUndefined();
		expect(result.configs.exaKeyless).toBeUndefined();
	});

	test("both stay when nothing can be installed and keyless search is off", () => {
		const result = filterExaMCPServers({ exa: KEYED_EXA, exaKeyless: KEYLESS_EXA }, sourcesFor(), {
			nativeEnabled: true,
			installsExaApiKeys: false,
			keylessCovered: false,
		});
		expect(result.configs.exa?.type).toBe("http");
		expect(result.configs.exaKeyless?.type).toBe("http");
	});

	test("an unresolved placeholder, command, or env name keeps its server", () => {
		const placeholder = filterExaMCPServers(
			{ exa: { type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=$" + "{EXA_TOKEN}" } },
			sourcesFor(),
			{ nativeEnabled: true },
		);
		const command = filterExaMCPServers(
			{ exa: { type: "stdio", command: "exa-mcp", env: { EXA_API_KEY: "!print-exa-key" } } },
			sourcesFor(),
			{ nativeEnabled: true },
		);
		process.env.EXA_KEY_SOURCE_VAR = "key-live-secret";
		try {
			const envName = filterExaMCPServers(
				{ exa: { type: "stdio", command: "exa-mcp", env: { EXA_API_KEY: "EXA_KEY_SOURCE_VAR" } } },
				sourcesFor(),
				{ nativeEnabled: true },
			);
			expect(envName.configs.exa?.type).toBe("stdio");
		} finally {
			delete process.env.EXA_KEY_SOURCE_VAR;
		}
		expect(placeholder.configs.exa?.type).toBe("http");
		expect(command.configs.exa?.type).toBe("stdio");
	});

	test("a literal env value folds, and extra tools stay mounted", () => {
		const literal = filterExaMCPServers(
			{
				exa: { type: "stdio", command: "exa-mcp", env: { EXA_API_KEY: "key-alpha" }, envPolicy: "literal" },
			},
			sourcesFor(),
			{ nativeEnabled: true },
		);
		const extra = filterExaMCPServers(
			{ exa: { type: "http", url: "https://mcp.exa.ai/mcp?tools=web_fetch_exa&exaApiKey=key-alpha" } },
			sourcesFor(),
			{ nativeEnabled: true },
		);
		expect(literal.configs.exa).toBeUndefined();
		expect(extra.configs.exa?.type).toBe("http");
		expect(extra.exaApiKeys).toEqual(["key-alpha"]);
	});

	test("nativeEnabled false keeps every server and extracts no keys", () => {
		const result = filterExaMCPServers({ exa: KEYED_EXA, exaKeyless: KEYLESS_EXA }, sourcesFor(), {
			nativeEnabled: false,
		});
		expect(result.configs.exa?.type).toBe("http");
		expect(result.exaApiKeys).toEqual([]);
	});
});

describe("Exa MCP fold against live native-search settings", () => {
	test("a keyed server folds and installs its key under default settings", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = emptyAuthStorage();
		const sessionSettings = Settings.isolated();
		const installed: Array<string | undefined> = [];
		const options = nativeOptions(sessionSettings, authStorage);
		const result = await loadAllMCPConfigs(projectDir, {
			...options,
			installExaApiKey: key => {
				installed.push(key);
				options.installExaApiKey(key);
			},
		});
		expect(result.configs.exa).toBeUndefined();
		expect(installed).toEqual(["key-alpha"]);
	});

	test("a session can turn Exa off while the global setting stays on", async () => {
		await Settings.init({ inMemory: true });
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = emptyAuthStorage();
		const sessionSettings = Settings.isolated({ "exa.enabled": false });
		const result = await loadAllMCPConfigs(projectDir, nativeOptions(sessionSettings, authStorage));
		expect(result.configs.exa?.type).toBe("http");
	});

	test("web search off, inactive, or offline keeps the keyed server", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = emptyAuthStorage();
		for (const sessionSettings of [
			Settings.isolated({ "web_search.enabled": false }),
			Settings.isolated({ "models.offline": true }),
		]) {
			const result = await loadAllMCPConfigs(projectDir, nativeOptions(sessionSettings, authStorage));
			expect(result.configs.exa?.type).toBe("http");
		}
		const inactive = await loadAllMCPConfigs(
			projectDir,
			nativeOptions(Settings.isolated(), authStorage, { webSearchActive: false }),
		);
		expect(inactive.configs.exa?.type).toBe("http");
	});

	test("a web role chain without web/exa keeps the keyed server", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = emptyAuthStorage();
		const sessionSettings = Settings.isolated({
			modelRoles: { web: "web/parallel" },
			"retry.fallbackChains": { web: [] },
		});
		const result = await loadAllMCPConfigs(projectDir, nativeOptions(sessionSettings, authStorage));
		expect(result.configs.exa?.type).toBe("http");
	});

	test("a keyless server stays without a credential and folds when one is stored", async () => {
		await writeProjectMcp(projectDir, { exa: KEYLESS_EXA });
		const sessionSettings = Settings.isolated({ "providers.webKeyless": false });
		const empty = emptyAuthStorage();
		const kept = await loadAllMCPConfigs(projectDir, nativeOptions(sessionSettings, empty));
		expect(kept.configs.exa?.type).toBe("http");

		const stored = createInMemoryAuthStorage();
		stored.keys.setRuntime("exa", "stored-key");
		try {
			const folded = await loadAllMCPConfigs(projectDir, nativeOptions(sessionSettings, stored));
			expect(folded.configs.exa).toBeUndefined();
		} finally {
			stored.close();
		}
	});

	test("an environment credential folds keyed and keyless servers without exporting a borrowed key", async () => {
		process.env.EXA_API_KEY = "env-key";
		await writeProjectMcp(projectDir, { exa: KEYED_EXA, exaKeyless: KEYLESS_EXA });
		const authStorage = emptyAuthStorage();
		const result = await loadAllMCPConfigs(
			projectDir,
			nativeOptions(Settings.isolated({ "providers.webKeyless": false }), authStorage),
		);
		expect(result.configs.exa).toBeUndefined();
		expect(result.configs.exaKeyless).toBeUndefined();
	});

	test("without an installer the keyed server stays, and an empty load revokes", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = emptyAuthStorage();
		const sessionSettings = Settings.isolated();
		const {
			installExaApiKey: _omitted,
			sessionManager: _session,
			...options
		} = nativeOptions(sessionSettings, authStorage);
		const kept = await loadAllMCPConfigs(projectDir, options);
		expect(kept.configs.exa?.type).toBe("http");

		clearFsCache();
		const installed: Array<string | undefined> = [];
		await writeProjectMcp(projectDir, {});
		await loadAllMCPConfigs(projectDir, {
			...nativeOptions(sessionSettings, authStorage),
			installExaApiKey: key => installed.push(key),
		});
		expect(installed).toEqual([undefined]);
	});
});

describe("session-scoped Exa API keys", () => {
	test("session and manager keys resolve and clear without touching the environment", () => {
		const sessionId = SessionManager.inMemory().getSessionId();
		const otherId = SessionManager.inMemory().getSessionId();
		trackedSessionIds.push(sessionId, otherId);
		const manager = createMcpManagerStub();
		setSessionExaApiKey(sessionId, "borrowed-key");
		setManagerExaApiKey(manager, "manager-key");
		expect(getSessionExaApiKey(sessionId, manager)).toBe("borrowed-key");
		expect(getSessionExaApiKey(otherId, manager)).toBe("manager-key");
		clearSessionExaApiKey(sessionId, manager);
		expect(getSessionExaApiKey(sessionId, manager)).toBeUndefined();
		expect(process.env.EXA_API_KEY).toBeUndefined();
	});
});

describe("searchExa with a borrowed key", () => {
	test("uses the session key, then a stored credential, then the environment", async () => {
		const sessionId = SessionManager.inMemory().getSessionId();
		trackedSessionIds.push(sessionId);
		setSessionExaApiKey(sessionId, "borrowed-key");
		const empty = emptyAuthStorage();
		const seen: string[] = [];
		await searchExa({ query: "q", num_results: 1, authStorage: empty, sessionId, fetch: recordingFetch(seen) });
		const stored = emptyAuthStorage();
		stored.keys.setRuntime("exa", "stored-key");
		await searchExa({ query: "q", num_results: 1, authStorage: stored, sessionId, fetch: recordingFetch(seen) });
		clearSessionExaApiKey(sessionId);
		process.env.EXA_API_KEY = "env-key";
		await searchExa({ query: "q", num_results: 1, authStorage: empty, sessionId, fetch: recordingFetch(seen) });
		expect(seen).toEqual(["borrowed-key", "stored-key", "env-key"]);
	});

	test("a manager owner supplies the key, and availability follows session settings", async () => {
		const manager = createMcpManagerStub();
		setManagerExaApiKey(manager, "borrowed-key");
		const sessionId = SessionManager.inMemory().getSessionId();
		trackedSessionIds.push(sessionId);
		const authStorage = emptyAuthStorage();
		const seen: string[] = [];
		await searchExa({
			query: "q",
			num_results: 1,
			authStorage,
			sessionId,
			keyOwner: manager,
			fetch: recordingFetch(seen),
		});
		expect(seen).toEqual(["borrowed-key"]);
		const provider = new ExaProvider();
		expect(await provider.isKeyless(authStorage, undefined, sessionId, manager)).toBe(false);
		expect(await provider.isAvailable(authStorage, undefined, Settings.isolated({ "exa.enabled": false }))).toBe(
			false,
		);
		expect(await provider.isAvailable(authStorage, undefined, Settings.isolated())).toBe(true);
	});
});

describe("/mcp controller lifecycle", () => {
	function createController(sessionSettings: Settings) {
		const sessionManager = SessionManager.inMemory();
		trackedSessionIds.push(sessionManager.getSessionId());
		const connectServers = vi.fn(async () => ({
			tools: [] as never[],
			errors: new Map<string, string>(),
			connectedServers: [] as string[],
			exaApiKeys: [] as string[],
		}));
		const discoverAndConnect = vi.fn(async (_options?: MCPDiscoverOptions) => ({
			tools: [] as never[],
			errors: new Map<string, string>(),
			connectedServers: [] as string[],
			exaApiKeys: [] as string[],
		}));
		const mcpManager = createMcpManagerStub({ connectServers, discoverAndConnect });
		trackedManagers.push(mcpManager);
		const authStorage = emptyAuthStorage();
		const ctx = createInteractiveModeContext({
			sessionManager,
			settings: sessionSettings,
			mcpManager,
			session: {
				refreshMCPTools: vi.fn(async () => {}),
				getEnabledToolNames: () => ["web_search"],
				getActiveToolNames: () => ["web_search"],
				getEvalPreludes: () => [],
				modelRegistry: registryFor(authStorage, sessionSettings),
				effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
			},
		});
		return {
			controller: new MCPCommandController(ctx),
			mcpManager,
			sessionManager,
			connectServers,
			discoverAndConnect,
		};
	}

	test("enabling folds a keyed server and disabling revokes the borrowed key", async () => {
		await writeProjectMcp(projectDir, { exa: { ...KEYED_EXA, enabled: false } });
		const { controller, mcpManager, sessionManager, connectServers } = createController(Settings.isolated());
		await controller.handle("/mcp enable exa");
		expect(getSessionExaApiKey(sessionManager.getSessionId(), mcpManager)).toBe("key-alpha");
		expect(connectServers).not.toHaveBeenCalled();
		expect(process.env.EXA_API_KEY).toBeUndefined();

		await controller.handle("/mcp disable exa");
		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("exa");
		expect(getSessionExaApiKey(sessionManager.getSessionId(), mcpManager)).toBeUndefined();
	});

	test("reload forwards the session credential store and key installer", async () => {
		const sessionSettings = Settings.isolated();
		const { controller, discoverAndConnect } = createController(sessionSettings);
		await controller.handle("/mcp reload");
		const options = discoverAndConnect.mock.calls[0]?.[0];
		expect(options?.modelRegistry).toBeDefined();
		expect(options?.settings).toBe(sessionSettings);
		expect(options?.installExaApiKey).toBeInstanceOf(Function);
		expect((options?.webSearchActive as (() => boolean) | undefined)?.()).toBe(true);
	});
});

describe("extension dashboard Exa toggles", () => {
	test("enabling installs the key and disabling revokes it", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const sessionManager = SessionManager.inMemory();
		trackedSessionIds.push(sessionManager.getSessionId());
		const sessionSettings = Settings.isolated();
		const authStorage = emptyAuthStorage();
		const connectServers = vi.fn(async () => ({
			tools: [] as never[],
			errors: new Map<string, string>(),
			connectedServers: [] as string[],
			exaApiKeys: [] as string[],
		}));
		const manager = createMcpManagerStub({ connectServers, getConnectionStatus: () => "disconnected" as const });
		trackedManagers.push(manager);
		const discovery = {
			settings: sessionSettings,
			authStorage,
			modelRegistry: registryFor(authStorage, sessionSettings),
			webSearchActive: true,
			installExaApiKey: (key: string | undefined) => {
				setSessionExaApiKey(sessionManager.getSessionId(), key);
				setManagerExaApiKey(manager, key);
			},
		};
		await applyMcpToggleRuntime({
			name: "exa",
			enabled: true,
			cwd: projectDir,
			manager,
			session: { refreshMCPTools: vi.fn(async () => {}) },
			discovery,
		});
		expect(connectServers).not.toHaveBeenCalled();
		expect(getSessionExaApiKey(sessionManager.getSessionId(), manager)).toBe("key-alpha");

		clearFsCache();
		await writeProjectMcp(projectDir, { exa: { ...KEYED_EXA, enabled: false } });
		await applyMcpToggleRuntime({
			name: "exa",
			enabled: false,
			cwd: projectDir,
			manager,
			session: { refreshMCPTools: vi.fn(async () => {}) },
			discovery,
		});
		expect(getSessionExaApiKey(sessionManager.getSessionId(), manager)).toBeUndefined();
	});
});

describe("MCPManager borrowed-key registration", () => {
	test("discovery registers the key and a project-config reconcile revokes it", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const sessionManager = SessionManager.inMemory();
		trackedSessionIds.push(sessionManager.getSessionId());
		const sessionSettings = Settings.isolated();
		const authStorage = emptyAuthStorage();
		const manager = new RealMCPManager(projectDir);
		trackedManagers.push(manager);
		await manager.discoverAndConnect({
			enableProjectConfig: true,
			settings: sessionSettings,
			modelRegistry: registryFor(authStorage, sessionSettings),
			webSearchActive: () => true,
			installExaApiKey: key => setSessionExaApiKey(sessionManager.getSessionId(), key),
		});
		expect(manager.getAllServerNames()).not.toContain("exa");
		expect(getSessionExaApiKey("other-session", manager)).toBe("key-alpha");
		await manager.reconcileProjectConfig(false);
		expect(getSessionExaApiKey(sessionManager.getSessionId(), manager)).toBeUndefined();
	});
});

describe("transport URL redaction", () => {
	test("HTTP teardown and SSE stream errors log a redacted URL", async () => {
		const http = new HttpUpstream(
			{
				transport: "http",
				url: "https://mcp.exa.ai/mcp?exaApiKey=key-live-secret",
				headers: {},
				timeoutMs: 0,
			},
			"modern",
		);
		http.onClose = () => {
			throw new Error("teardown blew up");
		};
		const debug = vi.spyOn(logger, "debug");
		await http.connect();
		await http.close();

		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);
				const body = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(
							encoder.encode(
								`event: endpoint\ndata: ${url.origin}/messages/?sessionId=x\n\nevent: message\ndata: not-json\n\n`,
							),
						);
						controller.close();
					},
				});
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		trackedServers.push(server);
		const sse = new SseUpstream({
			transport: "sse",
			url: `http://localhost:${server.port}/sse?exaApiKey=key-live-secret`,
			headers: {},
			timeoutMs: 0,
		});
		const onError = Promise.withResolvers<Error>();
		sse.onError = error => onError.resolve(error);
		await sse.connect();
		await Promise.race([
			onError.promise,
			Bun.sleep(5_000).then(() => {
				throw new Error("timed out waiting for the SSE stream error");
			}),
		]);

		const logged = debug.mock.calls
			.filter(
				args =>
					args[0] === "MCP HTTP onClose callback failed during teardown" || args[0] === "Legacy SSE stream error",
			)
			.map(args => (isRecord(args[1]) ? String(args[1].url) : ""));
		expect(logged).toHaveLength(2);
		for (const url of logged) {
			expect(url).not.toContain("key-live-secret");
			expect(url).toContain("%5Bredacted%5D");
		}
	});
});

describe("createAgentSession", () => {
	test("folds a keyed server for that session only and revokes the key on dispose", async () => {
		await writeProjectMcp(projectDir, { exa: KEYED_EXA });
		const authStorage = await AuthStorage.create(":memory:");
		trackedAuthStorages.push(authStorage);
		const { session, mcpManager } = await createAgentSession({
			cwd: projectDir,
			agentDir: projectDir,
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "browser.enabled": false, "disassembler.backend": "none" }),
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
		sessions.push(session);
		if (!mcpManager) throw new Error("expected the session to own an MCP manager");
		const sessionId = session.sessionManager.getSessionId();
		trackedSessionIds.push(sessionId);
		expect(mcpManager.getAllServerNames()).not.toContain("exa");
		expect(getSessionExaApiKey(sessionId, mcpManager)).toBe("key-alpha");
		expect(process.env.EXA_API_KEY).toBeUndefined();
		await session.dispose();
		expect(getSessionExaApiKey(sessionId, mcpManager)).toBeUndefined();
	});
});
