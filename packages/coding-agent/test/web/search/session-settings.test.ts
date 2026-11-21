import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	cfgProvidersWebSearchTimeoutSeconds,
	cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { ExaProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { SearXNGProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import type { SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const SEARXNG_ENV = ["SEARXNG_ENDPOINT", "SEARXNG_TOKEN", "SEARXNG_BASIC_USERNAME", "SEARXNG_BASIC_PASSWORD"] as const;

const openAuthStorages: AuthStorage[] = [];
const savedEnv = new Map<string, string | undefined>();

function trackAuthStorage(): AuthStorage {
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	return authStorage;
}

function isolatedWebSettings(providerId: string, timeoutSeconds = 180): Settings {
	return Settings.isolated({
		modelRoles: { web: `web/${providerId}` },
		"retry.fallbackChains": { web: [] },
		"providers.webSearchTimeoutSeconds": timeoutSeconds,
	});
}

interface CapturedSearch {
	requestedId?: string;
	availabilitySettings?: Settings;
	searchParams?: SearchParams;
}

function stubSearchProvider(captured: CapturedSearch, id: SearchProviderId = "brave"): void {
	const fake: provider.SearchProvider = {
		id,
		label: id,
		isAvailable: (_authStorage, _model, settingsArg) => {
			captured.availabilitySettings = settingsArg;
			return true;
		},
		isExplicitlyAvailable: (_authStorage, _model, settingsArg) => {
			captured.availabilitySettings = settingsArg;
			return true;
		},
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

describe("web search session settings", () => {
	beforeEach(() => {
		resetSettingsForTest();
		for (const name of SEARXNG_ENV) {
			savedEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
		for (const name of SEARXNG_ENV) {
			const value = savedEnv.get(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		savedEnv.clear();
	});

	it("uses caller settings without initializing the global singleton", async () => {
		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180);

		const result = await runSearchQuery(
			{ query: "anything" },
			{ authStorage: trackAuthStorage(), settings: isolated },
		);

		expect(result.details.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.availabilitySettings).toBe(isolated);
		expect(captured.searchParams?.settings).toBe(isolated);
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
	});

	it("falls back to isolated defaults when neither caller nor global settings exist", async () => {
		const captured: CapturedSearch = {};
		stubSearchProvider(captured);

		const result = await runSearchQuery(
			{ query: "anything", model: "web/brave" },
			{ authStorage: trackAuthStorage() },
		);

		expect(result.details.response.provider).toBe("brave");
		expect(captured.searchParams?.timeoutMs).toBe(60_000);
		expect(captured.searchParams?.settings).toBeInstanceOf(Settings);
		expect(captured.availabilitySettings).toBe(captured.searchParams?.settings);
	});

	it("prefers caller settings over the initialized global singleton", async () => {
		const global = await Settings.init({ inMemory: true });
		global.setModelRole("web", "web/exa");
		cfgRetryFallbackChains.set(global, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(global, 33);

		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180);
		const authStorage = trackAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: global });

		const result = await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, settings: isolated });

		expect(result.details.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.availabilitySettings).toBe(isolated);
		expect(captured.searchParams?.settings).toBe(isolated);
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
	});

	it("forwards ctx.settings from webSearchCustomTool", async () => {
		const captured: CapturedSearch = {};
		stubSearchProvider(captured);
		const isolated = isolatedWebSettings("brave", 180);
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

		expect(result.details?.response.provider).toBe("brave");
		expect(captured.requestedId).toBe("brave");
		expect(captured.searchParams?.settings).toBe(isolated);
		expect(captured.searchParams?.timeoutMs).toBe(180_000);
	});

	it("honors caller settings in ExaProvider availability", async () => {
		const authStorage = trackAuthStorage();
		const exa = new ExaProvider();

		await Settings.init({ inMemory: true, overrides: { "exa.enabled": false } });
		expect(exa.isAvailable(authStorage, undefined, Settings.isolated({ "exa.enabled": true }))).toBe(true);

		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": true } });
		expect(exa.isAvailable(authStorage, undefined, Settings.isolated({ "exa.enabled": false }))).toBe(false);
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
});
