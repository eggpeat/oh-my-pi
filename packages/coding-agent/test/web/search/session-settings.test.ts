import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import {
	ExaProvider,
	resetExaSearchThrottleForTest,
	searchExa,
} from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { SearXNGProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

/** Records each attempted `provider/id` and fails so the chain keeps walking. */
class RecordingProvider extends SearchProvider {
	readonly id = "openai";
	readonly label = "Recording";

	constructor(private readonly attempted: string[]) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		this.attempted.push(`${params.model.provider}/${params.model.id}`);
		throw new Error("try next");
	}
}

describe("web search session settings", () => {
	/** Environment values that would make a provider look configured; restored after each test. */
	const ENGINE_ENV = [
		"SEARXNG_ENDPOINT",
		"SEARXNG_TOKEN",
		"SEARXNG_BASIC_USERNAME",
		"SEARXNG_BASIC_PASSWORD",
		"EXA_API_KEY",
	];
	let savedEnv: Map<string, string | undefined>;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let attempted: string[];

	beforeEach(() => {
		resetSettingsForTest();
		savedEnv = new Map();
		for (const name of ENGINE_ENV) {
			savedEnv.set(name, process.env[name]);
			delete process.env[name];
		}
		authStorage = createInMemoryAuthStorage();
		modelRegistry = new ModelRegistry(authStorage, undefined, { settings: Settings.isolated() });
		attempted = [];
		const recorder = new RecordingProvider(attempted);
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(recorder);
		vi.spyOn(provider, "getGroundedSearchProvider").mockResolvedValue(recorder);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		resetExaSearchThrottleForTest();
		authStorage.close();
		for (const [name, value] of savedEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("resolves default settings for a one-shot search without an initialized global", async () => {
		const result = await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry });

		expect(attempted.length).toBeGreaterThan(0);
		expect(result.content[0]?.text ?? "").not.toContain("Settings not initialized");
	});

	it("runs the custom tool with the session's settings", async () => {
		const session = Settings.isolated({
			modelRoles: { web: "web/tavily" },
			"retry.fallbackChains": { web: ["web/exa"] },
		});
		const context = {
			sessionManager: { getSessionId: () => "session-1" },
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: session,
		} as unknown as CustomToolContext;

		await webSearchCustomTool.execute("call-1", { query: "anything" }, undefined, context);

		expect(attempted).toEqual(["web/tavily", "web/exa"]);
	});

	it("passes the session's settings to provider availability and search", async () => {
		const session = Settings.isolated({ modelRoles: { web: "web/searxng" } });
		let availabilitySettings: Settings | undefined;
		let searchParamsSettings: Settings | undefined;
		const engine: SearchProvider = {
			id: "searxng",
			label: "SearXNG",
			isAvailable: (_authStorage, _model, settings) => {
				availabilitySettings = settings;
				return true;
			},
			isExplicitlyAvailable: (_authStorage, _model, settings) => {
				availabilitySettings = settings;
				return true;
			},
			isKeyless: () => false,
			search: async params => {
				searchParamsSettings = params.settings;
				return { provider: "searxng", sources: [{ title: "Result", url: "https://result.example" }] };
			},
		};
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(engine);

		await runSearchQuery(
			{ query: "anything", model: "web/searxng" },
			{ authStorage, modelRegistry, settings: session },
		);

		expect(availabilitySettings).toBe(session);
		expect(searchParamsSettings).toBe(session);
	});

	it("reads the SearXNG endpoint and token from the caller's settings", async () => {
		await Settings.init({
			inMemory: true,
			overrides: {
				"searxng.endpoint": "https://global.example.org",
				"searxng.token": "global-token",
			},
		});
		const session = Settings.isolated({
			"searxng.endpoint": "https://session.example.org",
			"searxng.token": "session-token",
		});
		let seenUrl: string | undefined;
		let seenAuthorization: string | null | undefined;
		const fetchImpl: FetchImpl = async (input, init) => {
			seenUrl = String(input);
			seenAuthorization = new Headers(init?.headers as Record<string, string> | undefined).get("Authorization");
			return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://result.example" }] }), {
				status: 200,
			});
		};
		const model = modelRegistry.find("web", "searxng") as Model<Api>;

		await new SearXNGProvider().search({
			query: "anything",
			systemPrompt: "",
			authStorage,
			model,
			modelRegistry,
			settings: session,
			fetch: fetchImpl,
		});

		expect(seenUrl).toStartWith("https://session.example.org/search");
		expect(seenAuthorization).toContain("session-token");
	});

	it("reports SearXNG available from the caller's endpoint", async () => {
		await Settings.init({ inMemory: true });
		const session = Settings.isolated({ "searxng.endpoint": "https://session.example.org" });

		expect(new SearXNGProvider().isAvailable(authStorage, undefined, session)).toBe(true);
	});

	it("honors the caller's exa.enabled setting", async () => {
		await Settings.init({ inMemory: true, overrides: { "exa.enabled": true } });
		const exa = new ExaProvider();

		expect(exa.isAvailable(authStorage, undefined, Settings.isolated({ "exa.enabled": false }))).toBe(false);
		expect(exa.isAvailable(authStorage, undefined, Settings.isolated({ "exa.enabled": true }))).toBe(true);
	});

	it("paces Exa requests from the caller's settings", async () => {
		await Settings.init({ inMemory: true, overrides: { "exa.searchDelayMs": 1_000 } });
		resetExaSearchThrottleForTest();
		process.env.EXA_API_KEY = "test-key";
		const session = Settings.isolated({ "exa.searchDelayMs": 0 });
		// An aborted signal: a zero delay lets the request through without waiting,
		// while the global one-second delay would reject in the wait slot first.
		const controller = new AbortController();
		controller.abort();
		let fetched = false;
		const fetchImpl: FetchImpl = async () => {
			fetched = true;
			return new Response(JSON.stringify({ results: [{ title: "Result", url: "https://result.example" }] }), {
				status: 200,
			});
		};

		await searchExa({ query: "anything", settings: session, signal: controller.signal, fetch: fetchImpl });

		expect(fetched).toBe(true);
	});
});
