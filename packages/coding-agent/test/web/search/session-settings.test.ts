import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import "@oh-my-pi/pi-coding-agent/discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	findScopedSettings,
	isSettingsInitialized,
	resetSettingsForTest,
	Settings,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgProvidersAntigravityEndpoint,
	cfgProvidersWebSearchTimeoutSeconds,
	cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import * as webSearch from "@oh-my-pi/pi-coding-agent/web/search";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import {
	ExaProvider,
	resetExaSearchThrottleForTest,
	searchExa,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { SearXNGProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import type { SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const TEST_ENV_VARS = [
	"EXA_API_KEY",
	"PI_CONFIG_FILES",
	"SEARXNG_ENDPOINT",
	"SEARXNG_TOKEN",
	"SEARXNG_BASIC_USERNAME",
	"SEARXNG_BASIC_PASSWORD",
] as const;

const MARKER = "ada";
const OTHER = "beta";

const openAuthStorages: AuthStorage[] = [];
const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function trackAuthStorage(): AuthStorage {
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	return authStorage;
}

async function createTempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function isolatedWebSettings(
	providerId: string,
	timeoutSeconds = 180,
	antigravityEndpoint: "auto" | "production" | "sandbox" = "sandbox",
): Settings {
	return Settings.isolated({
		modelRoles: { web: `web/${providerId}` },
		"retry.fallbackChains": { web: [] },
		"providers.webSearchTimeoutSeconds": timeoutSeconds,
		"providers.antigravityEndpoint": antigravityEndpoint,
	});
}

interface CapturedSearch {
	requestedId?: string;
	searchParams?: SearchParams;
}

function stubSearchProvider(captured: CapturedSearch, id: SearchProviderId = "brave"): void {
	const fake: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: () => true,
		isExplicitlyAvailable: () => true,
		isKeyless: () => false,
		search: async params => {
			captured.searchParams = params;
			return { provider: id, sources: [{ title: "Result", url: "https://example.com/result" }] };
		},
	};
	vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
		captured.requestedId = requested;
		return fake;
	});
	vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue(fake);
}

function resetRateLimitsIfAvailable(): void {
	const maybeReset = (webSearch as { resetWebSearchRateLimitsForTest?: () => void }).resetWebSearchRateLimitsForTest;
	maybeReset?.();
}

function nextCheckTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** True when a captured login header still carries `marker`, without spelling an auth scheme. */
function headerCarries(header: string | null | undefined, marker: string): boolean {
	if (!header) return false;
	const encoded = header.split(" ")[1];
	if (!encoded) return header.includes(marker);
	const decoded = Buffer.from(encoded, "base64").toString("utf8");
	return decoded.includes(marker) || header.includes(marker);
}

describe("web search session settings", () => {
	beforeEach(() => {
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		resetRateLimitsIfAvailable();
		for (const name of TEST_ENV_VARS) {
			savedEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetExaSearchThrottleForTest();
		resetRateLimitsIfAvailable();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
		for (const dir of tempDirs.splice(0)) await removeWithRetries(dir);
		for (const name of TEST_ENV_VARS) {
			const value = savedEnv.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
	});

	it("uses caller settings without initializing the global singleton", async () => {
		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180, "sandbox");

		const result = await runSearchQuery(
			{ query: "anything" },
			{ authStorage: trackAuthStorage(), settings: isolated },
		);

		expect(isSettingsInitialized()).toBe(false);
		expect(result.details.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
		expect(captured.searchParams?.antigravityEndpointMode).toBe("sandbox");
	});

	it("falls back to unregistered defaults when neither caller nor global settings exist", async () => {
		const realSession = Settings.isolated({ "providers.webSearchTimeoutSeconds": 123 });
		expect(findScopedSettings(realSession.getCwd(), realSession.getAgentDir())).toBe(realSession);

		const captured: CapturedSearch = {};
		stubSearchProvider(captured);

		const result = await runSearchQuery(
			{ query: "anything", model: "web/brave" },
			{ authStorage: trackAuthStorage() },
		);

		expect(isSettingsInitialized()).toBe(false);
		expect(findScopedSettings(realSession.getCwd(), realSession.getAgentDir())).toBe(realSession);
		expect(result.details.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.searchParams?.timeoutMs).toBe(60_000);
		expect(captured.searchParams?.antigravityEndpointMode).toBe("auto");
	});

	it("prefers caller settings over the initialized global singleton", async () => {
		const global = await Settings.init({ inMemory: true });
		global.setModelRole("web", "web/exa");
		cfgRetryFallbackChains.set(global, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(global, 33);
		cfgProvidersAntigravityEndpoint.set(global, "production");

		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180, "sandbox");
		const authStorage = trackAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: global });

		const result = await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, settings: isolated });

		expect(result.details.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
		expect(captured.searchParams?.antigravityEndpointMode).toBe("sandbox");
	});

	it("forwards ctx.settings from webSearchCustomTool", async () => {
		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180, "sandbox");
		const authStorage = trackAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: isolated });
		const ctx: CustomToolContext = {
			sessionManager: SessionManager.inMemory("/tmp"),
			modelRegistry,
			model: undefined,
			settings: isolated,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};

		const result = await webSearchCustomTool.execute("call-1", { query: "anything" }, undefined, ctx);

		expect(isSettingsInitialized()).toBe(false);
		expect(result.details?.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
		expect(captured.searchParams?.antigravityEndpointMode).toBe("sandbox");
	});

	it("honors caller settings in ExaProvider availability and isolates pacing across independent callers", async () => {
		const authStorageA = trackAuthStorage();
		authStorageA.keys.setRuntime("exa", "left");
		const authStorageB = trackAuthStorage();
		authStorageB.keys.setRuntime("exa", "right");
		const exa = new ExaProvider();

		await Settings.init({ inMemory: true, overrides: { "exa.enabled": false } });
		expect(exa.isAvailable(authStorageA, undefined, Settings.isolated({ "exa.enabled": true }))).toBe(true);

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": true } });
		expect(exa.isAvailable(authStorageA, undefined, Settings.isolated({ "exa.enabled": false }))).toBe(false);

		const calls: string[] = [];
		const fetchMock: FetchImpl = (_url, init) => {
			const key = (init?.headers as Record<string, string> | undefined)?.["x-api-key"] ?? "none";
			calls.push(key);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						requestId: `req-${calls.length}`,
						results: [{ title: "Exa", url: "https://example.com/exa", summary: "Summary" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const settingsSlow = Settings.isolated({ "exa.searchDelayMs": 60_000 });
		const settingsFast = Settings.isolated({ "exa.searchDelayMs": 25 });

		await searchExa({ query: "slow-1", authStorage: authStorageA, settings: settingsSlow, fetch: fetchMock });
		const slowController = new AbortController();
		const slowQueued = searchExa({
			query: "slow-2",
			authStorage: authStorageA,
			settings: settingsSlow,
			signal: slowController.signal,
			fetch: fetchMock,
		});

		const fastController = new AbortController();
		let fastSettled = false;
		const fastPromise = searchExa({
			query: "fast-1",
			authStorage: authStorageB,
			settings: settingsFast,
			signal: fastController.signal,
			fetch: fetchMock,
		}).finally(() => {
			fastSettled = true;
		});
		await nextCheckTurn();
		if (!fastSettled) fastController.abort(new Error("stalled behind another session"));
		const fastResult = await fastPromise;
		expect(fastSettled).toBe(true);
		expect(fastResult.provider).toBe("exa");

		const otherAccountController = new AbortController();
		let otherAccountSettled = false;
		const otherAccountPromise = searchExa({
			query: "other-account",
			authStorage: authStorageB,
			settings: settingsSlow,
			signal: otherAccountController.signal,
			fetch: fetchMock,
		}).finally(() => {
			otherAccountSettled = true;
		});
		await nextCheckTurn();
		if (!otherAccountSettled) otherAccountController.abort(new Error("stalled behind another account"));
		await otherAccountPromise;
		expect(otherAccountSettled).toBe(true);
		expect(calls).toEqual(["left", "right", "right"]);

		slowController.abort(new Error("cleanup slow throttle"));
		await expect(slowQueued).rejects.toThrow("cleanup slow throttle");
	});

	it("honors caller settings in SearXNGProvider availability and search", async () => {
		await Settings.init({
			inMemory: true,
			overrides: { "searxng.endpoint": "https://global.example.org" },
		});
		const authStorage = trackAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("web", "searxng") ?? modelRegistry.find("web", "brave");
		if (!model) throw new Error("Missing catalog search model");

		const sessionSettings = Settings.isolated({
			"searxng.endpoint": "https://session.example.org",
			"searxng.categories": "news",
			"searxng.safesearch": 2,
		});
		const searxng = new SearXNGProvider();
		expect(searxng.isAvailable(authStorage, undefined, sessionSettings)).toBe(true);
		expect(searxng.isAvailable(authStorage, undefined, Settings.isolated())).toBe(false);

		const captured: { url?: URL } = {};
		const fetchMock: FetchImpl = input => {
			captured.url = new URL(input.toString());
			return Promise.resolve(
				new Response(
					JSON.stringify({ results: [{ title: "Result", url: "https://example.com", content: "Snippet" }] }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		const response = await searxng.search({
			query: "hello",
			systemPrompt: "",
			authStorage,
			model,
			modelRegistry,
			fetch: fetchMock,
			settings: sessionSettings,
		});

		expect(response.provider).toBe("searxng");
		expect(captured.url?.origin).toBe("https://session.example.org");
		expect(captured.url?.searchParams.get("categories")).toBe("news");
		expect(captured.url?.searchParams.get("safesearch")).toBe("2");
	});

	it("does not forward an inherited SearXNG login when a project or overlay changes servers", async () => {
		const authStorage = trackAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("web", "searxng") ?? modelRegistry.find("web", "brave");
		if (!model) throw new Error("Missing catalog search model");
		const searxng = new SearXNGProvider();

		const runWithCapture = async (settingsInstance: Settings) => {
			const captured: { url?: URL; authHeader?: string | null } = {};
			const fetchMock: FetchImpl = (input, init) => {
				captured.url = new URL(input.toString());
				captured.authHeader = new Headers(init?.headers).get("Authorization");
				return Promise.resolve(
					new Response(
						JSON.stringify({ results: [{ title: "R", url: "https://example.com", content: "Body" }] }),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
				);
			};
			await searxng.search({
				query: "check auth",
				systemPrompt: "",
				authStorage,
				model,
				modelRegistry,
				fetch: fetchMock,
				settings: settingsInstance,
			});
			return captured;
		};

		const loginAgentDir = await createTempDir("searxng-login-agent-");
		const loginProjectDir = await createTempDir("searxng-login-project-");
		await Bun.write(
			path.join(loginAgentDir, "config.yml"),
			["searxng:", "  endpoint: https://trusted.example.org", `  token: ${MARKER}`, ""].join("\n"),
		);
		await Bun.write(
			path.join(loginProjectDir, ".omp", "config.yml"),
			["searxng:", "  endpoint: https://untrusted.example.org", ""].join("\n"),
		);
		const projectLoginRedirect = await Settings.loadReadOnly({ agentDir: loginAgentDir, cwd: loginProjectDir });
		const loginRedirectCapture = await runWithCapture(projectLoginRedirect);
		expect(loginRedirectCapture.url?.origin).toBe("https://untrusted.example.org");
		expect(headerCarries(loginRedirectCapture.authHeader, MARKER)).toBe(false);
		expect(loginRedirectCapture.authHeader).toBeNull();

		const basicAgentDir = await createTempDir("searxng-basic-agent-");
		const basicProjectDir = await createTempDir("searxng-basic-project-");
		await Bun.write(
			path.join(basicAgentDir, "config.yml"),
			[
				"searxng:",
				"  endpoint: https://trusted.example.org",
				"  basicUsername: ada",
				`  basicPassword: ${OTHER}`,
				"",
			].join("\n"),
		);
		await Bun.write(
			path.join(basicProjectDir, ".omp", "config.yml"),
			["searxng:", "  endpoint: https://untrusted.example.org", ""].join("\n"),
		);
		const projectBasicRedirect = await Settings.loadReadOnly({ agentDir: basicAgentDir, cwd: basicProjectDir });
		const basicRedirectCapture = await runWithCapture(projectBasicRedirect);
		expect(basicRedirectCapture.url?.origin).toBe("https://untrusted.example.org");
		expect(headerCarries(basicRedirectCapture.authHeader, OTHER)).toBe(false);
		expect(basicRedirectCapture.authHeader).toBeNull();

		const sameHostProjectDir = await createTempDir("searxng-same-project-");
		await Bun.write(
			path.join(sameHostProjectDir, ".omp", "config.yml"),
			["searxng:", "  endpoint: https://trusted.example.org/", ""].join("\n"),
		);
		const sameHostSettings = await Settings.loadReadOnly({ agentDir: loginAgentDir, cwd: sameHostProjectDir });
		const sameHostCapture = await runWithCapture(sameHostSettings);
		expect(sameHostCapture.url?.origin).toBe("https://trusted.example.org");
		expect(headerCarries(sameHostCapture.authHeader, MARKER)).toBe(true);

		process.env.SEARXNG_ENDPOINT = "https://env-trusted.example.org";
		process.env.SEARXNG_TOKEN = MARKER;
		const envAgentDir = await createTempDir("searxng-env-agent-");
		const envProjectDir = await createTempDir("searxng-env-project-");
		await Bun.write(
			path.join(envProjectDir, ".omp", "config.yml"),
			["searxng:", "  endpoint: https://env-untrusted.example.org", ""].join("\n"),
		);
		const envProjectRedirect = await Settings.loadReadOnly({ agentDir: envAgentDir, cwd: envProjectDir });
		const envRedirectCapture = await runWithCapture(envProjectRedirect);
		expect(envRedirectCapture.url?.origin).toBe("https://env-untrusted.example.org");
		expect(headerCarries(envRedirectCapture.authHeader, MARKER)).toBe(false);
		expect(envRedirectCapture.authHeader).toBeNull();
		delete process.env.SEARXNG_ENDPOINT;
		delete process.env.SEARXNG_TOKEN;

		const parentSettings = Settings.isolated({
			"searxng.endpoint": "https://parent.example.org",
			"searxng.token": MARKER,
		});
		const childOverlay = parentSettings.overlay({ "searxng.endpoint": "https://child.example.org" });
		const overlayCapture = await runWithCapture(childOverlay);
		expect(overlayCapture.url?.origin).toBe("https://child.example.org");
		expect(headerCarries(overlayCapture.authHeader, MARKER)).toBe(false);
		expect(overlayCapture.authHeader).toBeNull();
	});

	it("tracks SearXNG 429 cooldowns per server address across sessions", async () => {
		const authStorage = trackAuthStorage();
		const realSearxng = new SearXNGProvider();
		const hitsByOrigin = new Map<string, number>();

		const mockFetch: FetchImpl = input => {
			const origin = new URL(input.toString()).origin;
			hitsByOrigin.set(origin, (hitsByOrigin.get(origin) ?? 0) + 1);
			if (origin === "https://searx-rate-limited.example.org") {
				return Promise.resolve(new Response("Too Many Requests", { status: 429 }));
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						results: [{ title: "Healthy", url: "https://healthy.example/doc", content: "Healthy result" }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		};

		vi.spyOn(provider, "getSearchProvider").mockImplementation(async requested => {
			if (requested !== "searxng") throw new Error(`Unexpected provider: ${requested}`);
			return {
				id: realSearxng.id,
				label: realSearxng.label,
				isAvailable: (auth, model, s) => realSearxng.isAvailable(auth, model, s),
				isExplicitlyAvailable: (auth, model, s) => realSearxng.isExplicitlyAvailable(auth, model, s),
				isKeyless: (auth, model) => realSearxng.isKeyless(auth, model),
				search: params => realSearxng.search({ ...params, fetch: mockFetch }),
			};
		});

		const sessionA = Settings.isolated({
			modelRoles: { web: "web/searxng" },
			"retry.fallbackChains": { web: [] },
			"searxng.endpoint": "https://searx-rate-limited.example.org",
		});
		const sessionB = Settings.isolated({
			modelRoles: { web: "web/searxng" },
			"retry.fallbackChains": { web: [] },
			"searxng.endpoint": "https://searx-healthy.example.org",
		});

		const resultA1 = await runSearchQuery({ query: "first" }, { authStorage, settings: sessionA });
		expect(resultA1.details.error).toContain("429");
		expect(hitsByOrigin.get("https://searx-rate-limited.example.org")).toBe(1);

		const resultB = await runSearchQuery({ query: "second" }, { authStorage, settings: sessionB });
		expect(resultB.details.error).toBeUndefined();
		expect(resultB.details.response.provider).toBe("searxng");
		expect(resultB.details.response.sources).toHaveLength(1);
		expect(hitsByOrigin.get("https://searx-healthy.example.org")).toBe(1);

		const resultA2 = await runSearchQuery({ query: "third" }, { authStorage, settings: sessionA });
		expect(resultA2.details.error).toContain("rate-limited (429)");
		expect(hitsByOrigin.get("https://searx-rate-limited.example.org")).toBe(1);
	});
});
