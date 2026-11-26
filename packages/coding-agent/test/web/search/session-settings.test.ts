import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	findScopedSettings,
	resetSettingsForTest,
	Settings,
	type SettingsMirrorSource,
	type SettingsMirrorState,
} from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import { resetExaSearchThrottleForTest } from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { searchSearXNG } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import {
	cfgExaSearchDelayMs,
	cfgSearxngBasicUsername,
	cfgSearxngEndpoint,
	cfgSearxngToken,
} from "@oh-my-pi/pi-coding-agent/web/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const token = "test-token";

const ISOLATED_ENV_KEYS = [
	"SEARXNG_ENDPOINT",
	"SEARXNG_TOKEN",
	"SEARXNG_BASIC_USERNAME",
	"SEARXNG_BASIC_PASSWORD",
	"EXA_API_KEY",
] as const;

let savedEnv: Map<string, string | undefined> | undefined;

function setEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

function bearer(value: string): string {
	return `Bearer ${value}`;
}

function basic(user: string, pass: string): string {
	return `Basic ${Buffer.from(`${user}:${pass}`, "utf-8").toString("base64")}`;
}

function requestUrl(input: string | URL | Request): URL {
	if (typeof input === "string") return new URL(input);
	if (input instanceof URL) return input;
	return new URL(input.url);
}

function searxngResponse(): Response {
	return new Response(JSON.stringify({ results: [{ title: "r", url: "https://example.com/hit" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function exaResponse(): Response {
	return new Response(JSON.stringify({ results: [{ title: "t", url: "https://example.com/a", summary: "s" }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

interface SeenRequest {
	url: URL;
	authorization: string | null;
}

async function runSearxng(settings?: Settings): Promise<SeenRequest> {
	let seen: SeenRequest | undefined;
	const fetchImpl: FetchImpl = async (input, init) => {
		const url = requestUrl(input as string | URL | Request);
		seen = { url, authorization: new Headers(init?.headers).get("authorization") };
		return searxngResponse();
	};
	await searchSearXNG({ query: "query", settings, fetch: fetchImpl });
	if (!seen) throw new Error("search made no request");
	return seen;
}

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		setEnvValue(key, value);
	}
	try {
		await run();
	} finally {
		for (const [key, value] of previous) {
			setEnvValue(key, value);
		}
	}
}

async function loadLayers(files: {
	globalYaml: string;
	projectJson?: string;
	projectYaml?: string;
	overlayYamls?: readonly string[];
}): Promise<{ settings: Settings; cleanup: () => Promise<void> }> {
	const root = TempDir.createSync("@omp-search-");
	const cleanup = () => root.remove();
	try {
		const agentDir = root.join("agent");
		const projectDir = root.join("project");
		await Bun.write(path.join(agentDir, "config.yml"), files.globalYaml);
		if (files.projectJson !== undefined) {
			await Bun.write(path.join(projectDir, ".omp", "settings.json"), files.projectJson);
		}
		if (files.projectYaml !== undefined) {
			await Bun.write(path.join(projectDir, ".omp", "config.yml"), files.projectYaml);
		}
		if (files.projectJson === undefined && files.projectYaml === undefined) {
			await Bun.write(path.join(projectDir, ".keep"), "");
		}
		const configFiles: string[] = [];
		for (const [index, overlayYaml] of (files.overlayYamls ?? []).entries()) {
			const overlay = root.join(`overlay-${index}.yml`);
			await Bun.write(overlay, overlayYaml);
			configFiles.push(overlay);
		}
		// A harness config file turns project discovery off. Suspend it so this temp project is read.
		const savedConfigFiles = process.env.PI_CONFIG_FILES;
		setEnvValue("PI_CONFIG_FILES", undefined);
		try {
			const settings = await Settings.loadReadOnly({
				agentDir,
				cwd: projectDir,
				configFiles: configFiles.length > 0 ? configFiles : undefined,
			});
			return { settings, cleanup };
		} finally {
			setEnvValue("PI_CONFIG_FILES", savedConfigFiles);
		}
	} catch (error) {
		await cleanup();
		throw error;
	}
}

async function initProcess(
	overrides: Record<string, unknown>,
): Promise<{ settings: Settings; cwd: string; cleanup: () => Promise<void> }> {
	const root = TempDir.createSync("@omp-search-");
	const cleanup = () => root.remove();
	try {
		const settings = await Settings.init({
			inMemory: true,
			cwd: root.path(),
			agentDir: root.join("agent"),
			overrides,
		});
		return { settings, cwd: root.path(), cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

async function withFetch(
	handler: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
	run: () => Promise<void>,
): Promise<void> {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
		handler(input, init)) as typeof fetch;
	try {
		await run();
	} finally {
		globalThis.fetch = original;
	}
}

async function withFrozenClock(run: (delays: number[], advance: (ms: number) => void) => Promise<void>): Promise<void> {
	const delays: number[] = [];
	const originalNow = Date.now;
	const originalTimeout = globalThis.setTimeout;
	let now = 1_700_000_000_000;
	Date.now = () => now;
	globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
		delays.push(timeout ?? 0);
		return originalTimeout(handler, 0);
	}) as typeof setTimeout;
	try {
		await run(delays, ms => {
			now += ms;
		});
	} finally {
		Date.now = originalNow;
		globalThis.setTimeout = originalTimeout;
	}
}

beforeEach(() => {
	savedEnv = new Map();
	for (const key of ISOLATED_ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		setEnvValue(key, undefined);
	}
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
});

afterEach(() => {
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
	if (savedEnv) {
		for (const [key, value] of savedEnv) {
			setEnvValue(key, value);
		}
		savedEnv = undefined;
	}
});

describe("web search session settings", () => {
	it("searches a session server before process settings exist", async () => {
		const session = Settings.isolated({ "searxng.endpoint": "https://session.example" });
		const authStorage = createInMemoryAuthStorage();
		let host: string | undefined;
		try {
			await withFetch(
				input => {
					host = requestUrl(input).host;
					return searxngResponse();
				},
				async () => {
					const result = await runSearchQuery(
						{ query: "query", model: "web/searxng" },
						{ authStorage, settings: session },
					);
					expect(result.details.error).toBeUndefined();
				},
			);
		} finally {
			authStorage.close();
		}
		expect(host).toBe("session.example");
	});

	it("keeps default search settings out of live session lookup", async () => {
		const sdk = Settings.isolated();
		const authStorage = createInMemoryAuthStorage();
		try {
			await withEnv({ SEARXNG_ENDPOINT: "https://env.example" }, () =>
				withFetch(
					() => searxngResponse(),
					async () => {
						const result = await runSearchQuery({ query: "query", model: "web/searxng" }, { authStorage });
						expect(result.details.error).toBeUndefined();
					},
				),
			);
		} finally {
			authStorage.close();
		}
		expect(findScopedSettings(sdk.getCwd(), sdk.getAgentDir())).toBe(sdk);
	});

	it("uses the session server when process settings name a different one", async () => {
		const processSettings = await initProcess({ "searxng.endpoint": "https://global.example" });
		const session = Settings.isolated({ "searxng.endpoint": "https://session.example" });
		const authStorage = createInMemoryAuthStorage();
		let host: string | undefined;
		try {
			await withFetch(
				input => {
					host = requestUrl(input).host;
					return searxngResponse();
				},
				async () => {
					const result = await runSearchQuery(
						{ query: "query", model: "web/searxng" },
						{ authStorage, settings: session },
					);
					expect(result.details.error).toBeUndefined();
				},
			);
		} finally {
			authStorage.close();
			await processSettings.cleanup();
		}
		expect(host).toBe("session.example");
		expect(cfgSearxngEndpoint.get(processSettings.settings)).toBe("https://global.example");
	});

	it("uses the caller's settings from the custom web search tool", async () => {
		const processSettings = await initProcess({
			modelRoles: { web: "web/searxng" },
			"searxng.endpoint": "https://global.example",
		});
		const session = Settings.isolated({
			modelRoles: { web: "web/searxng" },
			"searxng.endpoint": "https://session.example",
		});
		const authStorage = createInMemoryAuthStorage();
		const registry = new ModelRegistry(authStorage, undefined, { settings: session });
		let host: string | undefined;
		try {
			await withFetch(
				input => {
					host = requestUrl(input).host;
					return searxngResponse();
				},
				async () => {
					const context: CustomToolContext = {
						sessionManager: SessionManager.inMemory(processSettings.cwd),
						modelRegistry: registry,
						model: undefined,
						settings: session,
						isIdle: () => true,
						hasQueuedMessages: () => false,
						abort: () => {},
					};
					const result = await webSearchCustomTool.execute("call-1", { query: "query" }, undefined, context);
					expect(result.details?.error).toBeUndefined();
				},
			);
		} finally {
			authStorage.close();
			await processSettings.cleanup();
		}
		expect(host).toBe("session.example");
	});

	it("waits the default interval between Exa searches that pass no settings", async () => {
		const authStorage = createInMemoryAuthStorage();
		try {
			await withEnv({ EXA_API_KEY: "test-key" }, () =>
				withFrozenClock(async delays => {
					await withFetch(
						() => exaResponse(),
						async () => {
							const first = await runSearchQuery({ query: "one", model: "web/exa" }, { authStorage });
							const second = await runSearchQuery({ query: "two", model: "web/exa" }, { authStorage });
							expect(first.details.error).toBeUndefined();
							expect(second.details.error).toBeUndefined();
							expect(delays).toContain(cfgExaSearchDelayMs.default);
						},
					);
				}),
			);
		} finally {
			authStorage.close();
		}
	});

	it("waits the interval from the settings passed with the Exa search", async () => {
		const session = Settings.isolated({ "exa.searchDelayMs": 2_500 });
		const authStorage = createInMemoryAuthStorage();
		try {
			await withEnv({ EXA_API_KEY: "test-key" }, () =>
				withFrozenClock(async delays => {
					await withFetch(
						() => exaResponse(),
						async () => {
							const first = await runSearchQuery(
								{ query: "one", model: "web/exa" },
								{ authStorage, settings: session },
							);
							const second = await runSearchQuery(
								{ query: "two", model: "web/exa" },
								{ authStorage, settings: session },
							);
							expect(first.details.error).toBeUndefined();
							expect(second.details.error).toBeUndefined();
							expect(delays).toContain(2_500);
						},
					);
				}),
			);
		} finally {
			authStorage.close();
		}
	});

	it("shares the Exa pacing queue across sessions that share an account", async () => {
		const sessionA = Settings.isolated({ "exa.searchDelayMs": 1_500 });
		const sessionB = Settings.isolated({ "exa.searchDelayMs": 1_500 });
		const authStorage = createInMemoryAuthStorage();
		try {
			await withEnv({ EXA_API_KEY: "shared-key" }, () =>
				withFrozenClock(async delays => {
					await withFetch(
						() => exaResponse(),
						async () => {
							const first = await runSearchQuery(
								{ query: "one", model: "web/exa" },
								{ authStorage, settings: sessionA },
							);
							const second = await runSearchQuery(
								{ query: "two", model: "web/exa" },
								{ authStorage, settings: sessionB },
							);
							expect(first.details.error).toBeUndefined();
							expect(second.details.error).toBeUndefined();
							expect(delays).toContain(1_500);
						},
					);
				}),
			);
		} finally {
			authStorage.close();
		}
	});

	it("keeps recent Exa send times across traffic on other accounts", async () => {
		const shortSession = Settings.isolated({ "exa.searchDelayMs": 1_000 });
		const longSession = Settings.isolated({ "exa.searchDelayMs": 5_000 });
		const authStorage = createInMemoryAuthStorage();
		try {
			await withFrozenClock(async (delays, advance) => {
				await withFetch(
					() => exaResponse(),
					async () => {
						await withEnv({ EXA_API_KEY: "account-a" }, async () => {
							const first = await runSearchQuery(
								{ query: "a-1", model: "web/exa" },
								{ authStorage, settings: shortSession },
							);
							expect(first.details.error).toBeUndefined();
						});
						advance(1_500);
						await withEnv({ EXA_API_KEY: "account-b" }, async () => {
							const other = await runSearchQuery(
								{ query: "b-1", model: "web/exa" },
								{ authStorage, settings: shortSession },
							);
							expect(other.details.error).toBeUndefined();
						});
						advance(500);
						await withEnv({ EXA_API_KEY: "account-a" }, async () => {
							const second = await runSearchQuery(
								{ query: "a-2", model: "web/exa" },
								{ authStorage, settings: longSession },
							);
							expect(second.details.error).toBeUndefined();
						});
						expect(delays).toContain(3_000);
					},
				);
			});
		} finally {
			authStorage.close();
		}
	});

	it("does not call Exa when the session turns it off", async () => {
		const processSettings = await initProcess({ "exa.enabled": true });
		const session = Settings.isolated({ "exa.enabled": false });
		const authStorage = createInMemoryAuthStorage();
		let calls = 0;
		try {
			await withEnv({ EXA_API_KEY: "test-key" }, () =>
				withFetch(
					() => {
						calls += 1;
						return exaResponse();
					},
					async () => {
						const result = await runSearchQuery(
							{ query: "query", model: "web/exa" },
							{ authStorage, settings: session },
						);
						expect(result.details.error).toContain("unavailable");
					},
				),
			);
		} finally {
			authStorage.close();
			await processSettings.cleanup();
		}
		expect(calls).toBe(0);
	});

	it("scopes SearXNG 429 cooldowns to each server destination", async () => {
		const limitedSession = Settings.isolated({
			modelRoles: { web: "web/searxng" },
			"providers.webKeyless": false,
			"searxng.endpoint": "https://limited-cooldown.example",
		});
		const healthySession = Settings.isolated({
			modelRoles: { web: "web/searxng" },
			"providers.webKeyless": false,
			"searxng.endpoint": "https://healthy-cooldown.example",
		});
		const authStorage = createInMemoryAuthStorage();
		const seenHosts: string[] = [];
		try {
			await withFetch(
				input => {
					const host = requestUrl(input).host;
					seenHosts.push(host);
					if (host === "limited-cooldown.example") {
						return new Response("too many requests", { status: 429 });
					}
					return searxngResponse();
				},
				async () => {
					const first = await runSearchQuery(
						{ query: "one", model: "web/searxng" },
						{ authStorage, settings: limitedSession },
					);
					expect(first.details.error).toBeDefined();

					const healthy = await runSearchQuery({ query: "two" }, { authStorage, settings: healthySession });
					expect(healthy.details.error).toBeUndefined();

					const cooled = await runSearchQuery({ query: "three" }, { authStorage, settings: limitedSession });
					expect(cooled.details.error).toContain("rate-limited (429)");
				},
			);
		} finally {
			authStorage.close();
		}
		expect(seenHosts).toEqual(["limited-cooldown.example", "healthy-cooldown.example"]);
	});
});

describe("SearXNG login stays with its server", () => {
	it("sends a login saved on the same server", async () => {
		const settings = Settings.isolated({
			"searxng.endpoint": "https://trusted.example",
			"searxng.token": token,
		});
		const seen = await runSearxng(settings);
		expect(seen.url.host).toBe("trusted.example");
		expect(seen.url.pathname.endsWith("/search")).toBe(true);
		expect(seen.authorization).toBe(bearer(token));
	});

	it("sends basic auth ahead of a token saved on the same server", async () => {
		const settings = Settings.isolated({
			"searxng.endpoint": "https://trusted.example",
			"searxng.basicUsername": "env-user",
			"searxng.basicPassword": "env-pass",
			"searxng.token": token,
		});
		const seen = await runSearxng(settings);
		expect(seen.authorization).toBe(basic("env-user", "env-pass"));
	});

	it("does not send a user-file token when a project file only changes the server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  token: "${token}"\n`,
			projectYaml: `searxng:\n  endpoint: "https://other.example"\n`,
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("global");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send a user-file basic login when a project file only changes the server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  basicUsername: "old-user"\n  basicPassword: "old-pass"\n`,
			projectYaml: `searxng:\n  endpoint: "https://other.example"\n`,
		});
		try {
			expect(cfgSearxngBasicUsername.provenance(loaded.settings)).toBe("global");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("sends the project login when the project file replaces the server and the login", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  basicUsername: "old-user"\n  basicPassword: "old-pass"\n`,
			projectYaml: `searxng:\n  endpoint: "https://other.example"\n  basicUsername: "new-user"\n  basicPassword: "new-pass"\n`,
		});
		try {
			expect(cfgSearxngBasicUsername.provenance(loaded.settings)).toBe("project");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBe(basic("new-user", "new-pass"));
		} finally {
			await loaded.cleanup();
		}
	});

	it("sends a project token to the user-file server when the project names no server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n`,
			projectYaml: `searxng:\n  token: "${token}"\n`,
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("project");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("global");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("trusted.example");
			expect(seen.authorization).toBe(bearer(token));
		} finally {
			await loaded.cleanup();
		}
	});

	it("keeps the user-file login when a project file only changes categories", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  token: "${token}"\n`,
			projectYaml: "searxng:\n  categories: general\n",
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("trusted.example");
			expect(seen.url.searchParams.get("categories")).toBe("general");
			expect(seen.authorization).toBe(bearer(token));
		} finally {
			await loaded.cleanup();
		}
	});

	it("keeps the login when the project file only respells the same server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  token: "${token}"\n`,
			projectYaml: `searxng:\n  endpoint: "https://Trusted.example:443/"\n`,
		});
		try {
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("trusted.example");
			expect(seen.url.pathname.endsWith("/search")).toBe(true);
			expect(seen.authorization).toBe(bearer(token));
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send the login when the project server adds a query", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://searx.example/base"\n  token: "${token}"\n`,
			projectYaml: `searxng:\n  endpoint: "https://searx.example/base?x=1"\n`,
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.href).toContain("x=1");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send the login when the project server adds a fragment", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://searx.example/base"\n  token: "${token}"\n`,
			projectYaml: `searxng:\n  endpoint: "https://searx.example/base#section"\n`,
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.hash).toContain("section");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send the user-file login when a config file only changes the server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  token: "${token}"\n`,
			overlayYamls: [`searxng:\n  endpoint: "https://overlay.example"\n`],
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("global");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("overlay");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("overlay.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send a config-file login to a server named only by a later config file", async () => {
		const loaded = await loadLayers({
			globalYaml: "",
			overlayYamls: [
				`searxng:\n  endpoint: "https://first.example"\n  token: "${token}"\n`,
				`searxng:\n  endpoint: "https://second.example"\n`,
			],
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("overlay");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("overlay");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("second.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send a project-file login to a server named only by a later project file", async () => {
		const loaded = await loadLayers({
			globalYaml: "",
			projectJson: JSON.stringify({
				searxng: { endpoint: "https://first.example", token },
			}),
			projectYaml: `searxng:\n  endpoint: "https://second.example"\n`,
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("project");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("second.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not send a config-file or startup login to a repository server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n`,
			projectYaml: `searxng:\n  endpoint: "https://repo.example"\n`,
			overlayYamls: [`searxng:\n  token: "${token}"\n`],
		});
		try {
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("overlay");
			expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
			const fromOverlay = await runSearxng(loaded.settings);
			expect(fromOverlay.url.host).toBe("repo.example");
			expect(fromOverlay.authorization).toBeNull();

			cfgSearxngToken.override(loaded.settings, "startup-token");
			expect(cfgSearxngToken.provenance(loaded.settings)).toBe("runtime");
			const fromStartup = await runSearxng(loaded.settings);
			expect(fromStartup.url.host).toBe("repo.example");
			expect(fromStartup.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("sends a project token instead of a user-file basic login for a different server", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  basicUsername: "old-user"\n  basicPassword: "old-pass"\n`,
			projectYaml: `searxng:\n  endpoint: "https://other.example"\n  token: "${token}"\n`,
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBe(bearer(token));
		} finally {
			await loaded.cleanup();
		}
	});

	it("ignores an incomplete basic login for the old server when a different server has a bearer token", async () => {
		const loaded = await loadLayers({
			globalYaml: `searxng:\n  endpoint: "https://trusted.example"\n  basicUsername: "old-user"\n`,
			projectYaml: `searxng:\n  endpoint: "https://other.example"\n  token: "${token}"\n`,
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBe(bearer(token));
		} finally {
			await loaded.cleanup();
		}
	});

	it("sends a user-file login when only SEARXNG_ENDPOINT names the server, but not to a project override", async () => {
		await withEnv({ SEARXNG_ENDPOINT: "https://env.example" }, async () => {
			const matching = await loadLayers({
				globalYaml: `searxng:\n  token: "${token}"\n`,
			});
			try {
				expect(cfgSearxngToken.provenance(matching.settings)).toBe("global");
				expect(cfgSearxngEndpoint.provenance(matching.settings)).toBe("env");
				const seen = await runSearxng(matching.settings);
				expect(seen.url.host).toBe("env.example");
				expect(seen.authorization).toBe(bearer(token));
			} finally {
				await matching.cleanup();
			}

			const overridden = await loadLayers({
				globalYaml: `searxng:\n  token: "${token}"\n`,
				projectYaml: `searxng:\n  endpoint: "https://repo.example"\n`,
			});
			try {
				const seen = await runSearxng(overridden.settings);
				expect(seen.url.host).toBe("repo.example");
				expect(seen.authorization).toBeNull();
			} finally {
				await overridden.cleanup();
			}
		});
	});

	it("does not send an environment login to a server named only by the repository", async () => {
		await withEnv({ SEARXNG_TOKEN: token }, async () => {
			const loaded = await loadLayers({
				globalYaml: "",
				projectYaml: `searxng:\n  endpoint: "https://repo.example"\n`,
			});
			try {
				expect(cfgSearxngToken.provenance(loaded.settings)).toBe("env");
				expect(cfgSearxngEndpoint.provenance(loaded.settings)).toBe("project");
				const seen = await runSearxng(loaded.settings);
				expect(seen.url.host).toBe("repo.example");
				expect(seen.authorization).toBeNull();
			} finally {
				await loaded.cleanup();
			}
		});
	});

	it("sends a child login saved with Setting.set to the parent's startup server", async () => {
		const parent = Settings.isolated({ "searxng.endpoint": "https://trusted.example" });
		const child = parent.overlay();
		cfgSearxngToken.set(child, token);
		expect(cfgSearxngToken.provenance(child)).toBe("global");
		expect(cfgSearxngEndpoint.provenance(child)).toBe("runtime");
		const seen = await runSearxng(child);
		expect(seen.url.host).toBe("trusted.example");
		expect(seen.authorization).toBe(bearer(token));
	});

	it("does not send an environment token to a child server when the parent names the server", async () => {
		await withEnv({ SEARXNG_TOKEN: token }, async () => {
			const parent = Settings.isolated();
			cfgSearxngEndpoint.set(parent, "https://trusted.example");
			const child = parent.overlay({ "searxng.endpoint": "https://other.example" });
			expect(cfgSearxngToken.provenance(child)).toBe("env");
			expect(cfgSearxngEndpoint.provenance(child)).toBe("runtime");
			const seen = await runSearxng(child);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBeNull();
		});
	});

	it("does not send an environment basic login to a child that only replaces the server", async () => {
		await withEnv({ SEARXNG_BASIC_USERNAME: "env-user", SEARXNG_BASIC_PASSWORD: "env-pass" }, async () => {
			const parent = Settings.isolated();
			cfgSearxngEndpoint.set(parent, "https://trusted.example");
			const child = parent.overlay();
			cfgSearxngEndpoint.set(child, "https://other.example");
			expect(cfgSearxngBasicUsername.provenance(child)).toBe("env");
			const seen = await runSearxng(child);
			expect(seen.url.host).toBe("other.example");
			expect(seen.authorization).toBeNull();
		});
	});

	it("does not send a parent login to a child that only replaces the server", async () => {
		const parent = Settings.isolated();
		cfgSearxngEndpoint.set(parent, "https://trusted.example");
		cfgSearxngToken.set(parent, token);
		const child = parent.overlay();
		cfgSearxngEndpoint.set(child, "https://other.example");
		expect(cfgSearxngToken.provenance(child)).toBe("global");
		expect(cfgSearxngEndpoint.provenance(child)).toBe("global");
		const seen = await runSearxng(child);
		expect(seen.url.host).toBe("other.example");
		expect(seen.authorization).toBeNull();
	});

	it("sends an environment login to the parent server", async () => {
		await withEnv({ SEARXNG_TOKEN: token }, async () => {
			const parent = Settings.isolated();
			cfgSearxngEndpoint.set(parent, "https://trusted.example");
			const seen = await runSearxng(parent);
			expect(seen.url.host).toBe("trusted.example");
			expect(seen.authorization).toBe(bearer(token));
		});
	});

	it("does not send an environment login when the environment names a different server", async () => {
		await withEnv({ SEARXNG_TOKEN: token, SEARXNG_ENDPOINT: "https://env.example" }, async () => {
			const settings = Settings.isolated();
			cfgSearxngEndpoint.set(settings, "https://file.example");
			const seen = await runSearxng(settings);
			expect(seen.url.host).toBe("file.example");
			expect(seen.authorization).toBeNull();
		});
	});

	it("sends an environment login when the environment names that server", async () => {
		await withEnv({ SEARXNG_TOKEN: token, SEARXNG_ENDPOINT: "https://env.example" }, async () => {
			const seen = await runSearxng();
			expect(seen.url.host).toBe("env.example");
			expect(seen.authorization).toBe(bearer(token));
		});
	});

	it("still rejects a basic login that is only half set", async () => {
		const settings = Settings.isolated({
			"searxng.endpoint": "https://trusted.example",
			"searxng.basicUsername": "only-user",
			"searxng.token": token,
		});
		await expect(runSearxng(settings)).rejects.toThrow(/both/);
	});

	it("still rejects a basic username that contains a colon", async () => {
		const settings = Settings.isolated({
			"searxng.endpoint": "https://trusted.example",
			"searxng.basicUsername": "bad:user",
			"searxng.basicPassword": "test-pass",
		});
		await expect(runSearxng(settings)).rejects.toThrow(/cannot contain ':'/);
	});

	it("does not run unrelated migrations on unmerged project files before config.yml replaces them", async () => {
		const loaded = await loadLayers({
			globalYaml: "",
			projectJson: JSON.stringify({
				statusLine: { segmentOptions: "legacy-text" },
				searxng: { endpoint: "https://first.example", token },
			}),
			projectYaml: `statusLine:\n  segmentOptions: {}\nsearxng:\n  endpoint: "https://second.example"\n`,
		});
		try {
			const seen = await runSearxng(loaded.settings);
			expect(seen.url.host).toBe("second.example");
			expect(seen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("does not copy superseded passwords into worker mirror snapshots", async () => {
		const loaded = await loadLayers({
			globalYaml: "",
			projectJson: JSON.stringify({
				searxng: {
					endpoint: "https://proj-a.example",
					basicUsername: "proj-old-user",
					basicPassword: "proj-old-secret",
				},
			}),
			projectYaml: `searxng:\n  endpoint: "https://proj-b.example"\n  basicUsername: "proj-new-user"\n  basicPassword: "proj-new-secret"\n`,
			overlayYamls: [
				`searxng:\n  endpoint: "https://ovr-a.example"\n  basicUsername: "ovr-old-user"\n  basicPassword: "ovr-old-secret"\n`,
				`searxng:\n  endpoint: "https://ovr-b.example"\n  basicUsername: "ovr-new-user"\n  basicPassword: "ovr-new-secret"\n`,
			],
		});
		try {
			const snapshot = JSON.stringify(loaded.settings.mirrorState());
			expect(snapshot).not.toContain("proj-old-secret");
			expect(snapshot).not.toContain("ovr-old-secret");
			expect(snapshot).toContain("ovr-new-secret");
		} finally {
			await loaded.cleanup();
		}
	});

	it("withholds logins on worker mirrors when binding metadata is absent and enforces it when present", async () => {
		const loaded = await loadLayers({
			globalYaml: "",
			overlayYamls: [
				`searxng:\n  endpoint: "https://first.example"\n  token: "${token}"\n`,
				`searxng:\n  endpoint: "https://second.example"\n`,
			],
		});
		try {
			const fullState = loaded.settings.mirrorState();
			const stubSource = (state: SettingsMirrorState): SettingsMirrorSource => ({
				write: () => state,
				refresh: async () => state,
				cloneForCwd: async () => loaded.settings,
			});
			const faithfulMirror = Settings.mirror(stubSource(fullState), fullState);
			const faithfulSeen = await runSearxng(faithfulMirror);
			expect(faithfulSeen.url.host).toBe("second.example");
			expect(faithfulSeen.authorization).toBeNull();

			const strippedState: SettingsMirrorState = {
				generation: fullState.generation,
				cwd: fullState.cwd,
				agentDir: fullState.agentDir,
				configFiles: fullState.configFiles,
				global: fullState.global,
				project: fullState.project,
				configOverlay: { searxng: { endpoint: "https://first.example", token } },
				overrides: fullState.overrides,
				derived: fullState.derived,
				projectShellPathSource: fullState.projectShellPathSource,
				overlayShellPathSource: fullState.overlayShellPathSource,
			};
			const strippedMirror = Settings.mirror(stubSource(strippedState), strippedState);
			const strippedSeen = await runSearxng(strippedMirror);
			expect(strippedSeen.url.host).toBe("first.example");
			expect(strippedSeen.authorization).toBeNull();
		} finally {
			await loaded.cleanup();
		}
	});

	it("keeps the original trusted server when a live reload retains an old login over a wrongly typed edit", async () => {
		const root = TempDir.createSync("@omp-search-reload-");
		const agentDir = root.join("agent");
		const projectDir = root.join("project");
		const overlay0 = root.join("overlay-0.yml");
		const overlay1 = root.join("overlay-1.yml");
		await Bun.write(path.join(agentDir, "config.yml"), "");
		await Bun.write(path.join(projectDir, ".keep"), "");
		await Bun.write(overlay0, `searxng:\n  endpoint: "https://old.example"\n  token: "${token}"\n`);
		await Bun.write(overlay1, "{}\n");
		const savedConfigFiles = process.env.PI_CONFIG_FILES;
		setEnvValue("PI_CONFIG_FILES", undefined);
		let settings: Settings | undefined;
		try {
			settings = await Settings.init({ agentDir, cwd: projectDir, configFiles: [overlay0, overlay1] });
			const before = await runSearxng(settings);
			expect(before.url.host).toBe("old.example");
			expect(before.authorization).toBe(bearer(token));

			await Bun.write(overlay1, `searxng:\n  endpoint: "https://evil.example"\n  token: 12345\n`);
			const reloaded = Promise.withResolvers<void>();
			const unlisten = cfgSearxngEndpoint.listen(settings, value => {
				if (value === "https://evil.example") reloaded.resolve();
			});
			settings.startWatching();
			try {
				await reloaded.promise;
			} finally {
				unlisten();
				settings.stopWatching();
			}
			expect(cfgSearxngToken.get(settings)).toBe(token);
			const after = await runSearxng(settings);
			expect(after.url.host).toBe("evil.example");
			expect(after.authorization).toBeNull();
		} finally {
			settings?.cancelPendingSaves();
			resetSettingsForTest();
			AgentStorage.close();
			setEnvValue("PI_CONFIG_FILES", savedConfigFiles);
			await root.remove();
		}
	});

	it("keeps the original trusted server when a global save merge retains an old login over a wrongly typed edit", async () => {
		const root = TempDir.createSync("@omp-search-save-");
		const agentDir = root.join("agent");
		const projectDir = root.join("project");
		const globalPath = path.join(agentDir, "config.yml");
		await Bun.write(globalPath, `searxng:\n  endpoint: "https://old.example"\n  token: "${token}"\n`);
		await Bun.write(path.join(projectDir, ".keep"), "");
		const savedConfigFiles = process.env.PI_CONFIG_FILES;
		setEnvValue("PI_CONFIG_FILES", undefined);
		let settings: Settings | undefined;
		try {
			settings = await Settings.loadIsolated({ agentDir, cwd: projectDir });
			await Bun.write(globalPath, `searxng:\n  endpoint: "https://evil.example"\n  token: 12345\n`);
			cfgTemperature.set(settings, 0.4);
			await settings.flush();
			expect(cfgSearxngToken.get(settings)).toBe(token);
			const after = await runSearxng(settings);
			expect(after.url.host).toBe("evil.example");
			expect(after.authorization).toBeNull();
		} finally {
			settings?.cancelPendingSaves();
			AgentStorage.close();
			setEnvValue("PI_CONFIG_FILES", savedConfigFiles);
			await root.remove();
		}
	});
});
