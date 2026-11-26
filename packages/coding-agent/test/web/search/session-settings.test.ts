import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSearchQuery, webSearchCustomTool } from "@oh-my-pi/pi-coding-agent/web/search";
import { resetExaSearchThrottleForTest } from "@oh-my-pi/pi-coding-agent/web/search/providers/exa";
import { searchSearXNG } from "@oh-my-pi/pi-coding-agent/web/search/providers/searxng";
import {
	cfgExaSearchDelayMs,
	cfgSearxngBasicUsername,
	cfgSearxngEndpoint,
	cfgSearxngToken,
} from "@oh-my-pi/pi-coding-agent/web/settings";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const token = "test-token";

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
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

async function loadLayers(files: {
	globalYaml: string;
	projectYaml?: string;
	overlayYaml?: string;
}): Promise<{ settings: Settings; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-search-"));
	const cleanup = () => rm(root, { recursive: true, force: true });
	try {
		const agentDir = path.join(root, "agent");
		const projectDir = path.join(root, "project");
		await mkdir(agentDir, { recursive: true });
		await mkdir(projectDir, { recursive: true });
		await writeFile(path.join(agentDir, "config.yml"), files.globalYaml);
		if (files.projectYaml !== undefined) {
			const omp = path.join(projectDir, ".omp");
			await mkdir(omp);
			await writeFile(path.join(omp, "config.yml"), files.projectYaml);
		}
		const configFiles: string[] = [];
		if (files.overlayYaml !== undefined) {
			const overlay = path.join(root, "overlay.yml");
			await writeFile(overlay, files.overlayYaml);
			configFiles.push(overlay);
		}
		// A harness config file turns project discovery off. Suspend it so this temp project is read.
		const savedConfigFiles = process.env.PI_CONFIG_FILES;
		delete process.env.PI_CONFIG_FILES;
		delete Bun.env.PI_CONFIG_FILES;
		try {
			const settings = await Settings.loadReadOnly({
				agentDir,
				cwd: projectDir,
				configFiles: configFiles.length > 0 ? configFiles : undefined,
			});
			return { settings, cleanup };
		} finally {
			if (savedConfigFiles === undefined) {
				delete process.env.PI_CONFIG_FILES;
				delete Bun.env.PI_CONFIG_FILES;
			} else {
				process.env.PI_CONFIG_FILES = savedConfigFiles;
				Bun.env.PI_CONFIG_FILES = savedConfigFiles;
			}
		}
	} catch (error) {
		await cleanup();
		throw error;
	}
}

async function initProcess(
	overrides: Record<string, unknown>,
): Promise<{ settings: Settings; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(path.join(tmpdir(), "omp-search-"));
	const cleanup = () => rm(root, { recursive: true, force: true });
	try {
		const settings = await Settings.init({
			inMemory: true,
			cwd: root,
			agentDir: path.join(root, "agent"),
			overrides,
		});
		return { settings, cleanup };
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

async function withFrozenClock(run: (delays: number[]) => Promise<void>): Promise<void> {
	const delays: number[] = [];
	const originalNow = Date.now;
	const originalTimeout = globalThis.setTimeout;
	const now = 1_700_000_000_000;
	Date.now = () => now;
	globalThis.setTimeout = ((handler: () => void, timeout?: number) => {
		delays.push(timeout ?? 0);
		return originalTimeout(handler, 0);
	}) as typeof setTimeout;
	try {
		await run(delays);
	} finally {
		Date.now = originalNow;
		globalThis.setTimeout = originalTimeout;
	}
}

beforeEach(() => {
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
});

afterEach(() => {
	resetSettingsForTest();
	resetExaSearchThrottleForTest();
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
						sessionManager: SessionManager.inMemory(tmpdir()),
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
			overlayYaml: `searxng:\n  endpoint: "https://overlay.example"\n`,
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

	it("does not send an environment token to a child server when the parent names the server", async () => {
		await withEnv({ SEARXNG_TOKEN: token, SEARXNG_ENDPOINT: undefined }, async () => {
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
		await withEnv(
			{ SEARXNG_BASIC_USERNAME: "env-user", SEARXNG_BASIC_PASSWORD: "env-pass", SEARXNG_ENDPOINT: undefined },
			async () => {
				const parent = Settings.isolated();
				cfgSearxngEndpoint.set(parent, "https://trusted.example");
				const child = parent.overlay();
				cfgSearxngEndpoint.set(child, "https://other.example");
				expect(cfgSearxngBasicUsername.provenance(child)).toBe("env");
				const seen = await runSearxng(child);
				expect(seen.url.host).toBe("other.example");
				expect(seen.authorization).toBeNull();
			},
		);
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
		await withEnv({ SEARXNG_TOKEN: token, SEARXNG_ENDPOINT: undefined }, async () => {
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
});
