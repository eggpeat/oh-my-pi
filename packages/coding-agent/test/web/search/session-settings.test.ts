import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { SearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { ExaProvider } from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { SearXNGProvider, searchSearXNG } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import type { SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

/** Records the model and settings scope each candidate was attempted under, then fails. */
class RecordingProvider extends SearchProvider {
	readonly id = "exa";
	readonly label = "Recording";

	constructor(private readonly seen: { model: string; settings: Settings | undefined }[]) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		this.seen.push({ model: `${params.model.provider}/${params.model.id}`, settings: params.settings });
		throw new Error("try next");
	}
}

function searxngResult(): Response {
	return new Response(
		JSON.stringify({
			results: [{ title: "SearXNG", url: "https://example.com/result", content: "Metasearch result" }],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("web search session settings", () => {
	let authStorage: AuthStorage;

	beforeEach(() => {
		resetSettingsForTest();
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		authStorage.close();
	});

	it("runs runSearchQuery without an initialized global settings singleton", async () => {
		// SDK embedders supplying per-session settings never call Settings.init(); the
		// global `settings` proxy throws on read, so the search must not touch it.
		const seen: { model: string; settings: Settings | undefined }[] = [];
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(new RecordingProvider(seen));

		await runSearchQuery({ query: "anything", model: "web/exa" }, { authStorage });

		expect(seen).toHaveLength(1);
		expect(seen[0]!.settings).toBeInstanceOf(Settings);
	});

	it("walks the session's web role for runSearchQuery's settings option", async () => {
		// The initialized global prefers web/exa; the session's own role must win.
		const globalSettings = await Settings.init({ inMemory: true });
		globalSettings.setModelRole("web", "web/exa");
		cfgRetryFallbackChains.set(globalSettings, { web: ["web/duckduckgo"] });
		const session = Settings.isolated({
			modelRoles: { web: "web/tavily" },
			"retry.fallbackChains": { web: ["web/kagi"] },
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: globalSettings });
		const seen: { model: string; settings: Settings | undefined }[] = [];
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(new RecordingProvider(seen));

		await runSearchQuery({ query: "anything" }, { authStorage, modelRegistry, settings: session });

		expect(seen.map(entry => entry.model)).toEqual(["web/tavily", "web/kagi"]);
		expect(seen[0]!.settings).toBe(session);
	});

	it("forwards the custom-tool context's settings instead of the global singleton", async () => {
		const globalSettings = await Settings.init({ inMemory: true });
		globalSettings.setModelRole("web", "web/exa");
		cfgRetryFallbackChains.set(globalSettings, { web: ["web/duckduckgo"] });
		const session = Settings.isolated({
			modelRoles: { web: "web/tavily" },
			"retry.fallbackChains": { web: ["web/kagi"] },
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: globalSettings });
		const seen: { model: string; settings: Settings | undefined }[] = [];
		vi.spyOn(provider, "getSearchProvider").mockResolvedValue(new RecordingProvider(seen));

		const ctx = {
			sessionManager: { getSessionId: () => "session-id" },
			modelRegistry,
			model: undefined,
			settings: session,
		} as unknown as CustomToolContext;

		await webSearchCustomTool.execute("call-1", { query: "anything" }, undefined, ctx);

		expect(seen.map(entry => entry.model)).toEqual(["web/tavily", "web/kagi"]);
		expect(seen[0]!.settings).toBe(session);
	});

	it("reads the SearXNG endpoint and filters from the session's settings, not the global's", async () => {
		const globalSettings = await Settings.init({ inMemory: true });
		cfgSearxngEndpoint.set(globalSettings, "https://searx.global.example");
		const session = Settings.isolated({
			"searxng.endpoint": "https://searx.session.example",
			"searxng.language": "de",
		});
		const captured: { url?: URL } = {};
		const fetchMock: FetchImpl = (input, _init) => {
			captured.url = new URL(input.toString());
			return Promise.resolve(searxngResult());
		};

		await searchSearXNG({ query: "session scoped", settings: session, fetch: fetchMock });

		expect(captured.url?.origin).toBe("https://searx.session.example");
		expect(captured.url?.pathname).toBe("/search");
		expect(captured.url?.searchParams.get("language")).toBe("de");
	});

	it("resolves endpoint env fallbacks without an initialized global settings singleton", async () => {
		process.env.SEARXNG_ENDPOINT = "https://searx.env.example";
		try {
			const captured: { url?: URL } = {};
			const fetchMock: FetchImpl = (input, _init) => {
				captured.url = new URL(input.toString());
				return Promise.resolve(searxngResult());
			};

			await searchSearXNG({ query: "env scoped", fetch: fetchMock });

			expect(captured.url?.origin).toBe("https://searx.env.example");
		} finally {
			delete process.env.SEARXNG_ENDPOINT;
		}
	});

	it("reports availability from the caller's settings scope", () => {
		const bare = Settings.isolated();
		const configured = Settings.isolated({ "searxng.endpoint": "https://searx.example.org" });
		const exaOff = Settings.isolated({ "exa.enabled": false });

		expect(new SearXNGProvider().isAvailable(authStorage, undefined, configured)).toBe(true);
		expect(new SearXNGProvider().isAvailable(authStorage, undefined, bare)).toBe(false);
		expect(new ExaProvider().isAvailable(authStorage, undefined, exaOff)).toBe(false);
		expect(new ExaProvider().isAvailable(authStorage, undefined, bare)).toBe(true);
	});
});
