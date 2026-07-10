import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "retry_fallback_applied",
					from: "primary/bad-runtime-model",
					to: "fallback/working-model",
					role: "subagent:issue-2750",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

function createSimpleYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

describe("subagent runtime model resolution", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("passes ordered subagent candidates as a child retry fallback chain", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({
			"retry.fallbackChains": {
				default: ["global/inherited-model"],
			},
		});
		settings.setModelRole("default", "primary/bad-runtime-model");
		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		let firstFallbackRole: string | undefined;
		let subagentFallbackChain: string[] | undefined;
		let inheritedFallbackChain: string[] | undefined;
		for (const role in childFallbackChains) {
			const chain = childFallbackChains[role];
			if (!firstFallbackRole) {
				firstFallbackRole = role;
			}
			if (role === "subagent:issue-2750") {
				subagentFallbackChain = chain;
			}
			if (role === "default") {
				inheritedFallbackChain = chain;
			}
		}
		expect(firstFallbackRole).toBe("subagent:issue-2750");
		expect(subagentFallbackChain).toEqual(["fallback/working-model"]);
		expect(inheritedFallbackChain).toEqual(["global/inherited-model"]);
		expect(result.modelOverride).toEqual(["primary/bad-runtime-model", "fallback/working-model"]);
		expect(result.resolvedModel).toBe("fallback/working-model");
	});

	it("preserves upstream routing selectors in the child retry fallback chain", async () => {
		const routedModel = model("openrouter", "z-ai/glm-4.7");
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-2750-routed",
			modelOverride: ["openrouter/z-ai/glm-4.7@cerebras", "openrouter/z-ai/glm-4.7@fireworks"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [routedModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childFallbackChains?.["subagent:issue-2750-routed"]).toEqual(["openrouter/z-ai/glm-4.7@fireworks"]);
	});

	it("defers unresolved explicit subagent model selectors instead of picking an available default", async () => {
		const defaultModel = model("zai", "glm-5.2");
		let childModel: Model | undefined;
		let childModelPattern: unknown;
		let childModelPatternAuthFallback: unknown;
		let childModelPatternFallbackRole: unknown;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childModelPattern = options.modelPattern;
			childModelPatternAuthFallback = options.modelPatternAuthFallback;
			childModelPatternFallbackRole = options.modelPatternFallbackRole;
			return { session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} } as never;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "issue-4421",
			modelOverride: ["openai-codex/gpt-5.5:auto"],
			parentActiveModelPattern: "openai-codex/gpt-5.5",
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [defaultModel],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
		});

		expect(childModel).toBeUndefined();
		expect(childModelPattern).toEqual(["openai-codex/gpt-5.5:auto"]);
		expect(childModelPatternAuthFallback).toBe("openai-codex/gpt-5.5");
		expect(childModelPatternFallbackRole).toBe("subagent:issue-4421");
	});

	it("runSubprocess candidate health selection: depleted candidate 0 selects candidate 1 with preserved thinking", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		const tail = model("tail", "tail-model");
		let childModel: Model | undefined;
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated();

		const getModelUsageHealthSpy = vi.fn().mockImplementation(async (provider: string) => {
			if (provider === "primary") return { state: "depleted" };
			return { state: "eligible" };
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "depleted-test",
			modelOverride: ["primary/bad-runtime-model:high", "fallback/working-model:low", "tail/tail-model:medium"],
			modelCandidateRole: "task",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback, tail],
				getApiKey: async () => "test-key",
				hasExplicitProviderApiKey: () => false,
				authStorage: {
					getModelUsageHealth: getModelUsageHealthSpy,
				},
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		// Depleted candidate 0 is skipped. Preserved thinking for candidate 1 is ":low".
		expect(childModel).toBe(fallback);
		expect(result.resolvedModel).toBe("fallback/working-model:low");
		expect(getModelUsageHealthSpy).toHaveBeenCalledTimes(2); // primary + fallback checked

		// Skipped candidate 0 never re-enters the retry/session tail, but candidate 2 is retained.
		expect(childFallbackChains?.["subagent:depleted-test"]).toEqual(["tail/tail-model:medium"]);
	});

	it("runSubprocess candidate health selection: unknown stays candidate 0", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childModel: Model | undefined;
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated();

		const getModelUsageHealthSpy = vi.fn().mockImplementation(async (provider: string) => {
			if (provider === "primary") return { state: "unknown" };
			return { state: "eligible" };
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "unknown-test",
			modelOverride: ["primary/bad-runtime-model:high", "fallback/working-model:low"],
			modelCandidateRole: "task",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
				hasExplicitProviderApiKey: () => false,
				authStorage: {
					getModelUsageHealth: getModelUsageHealthSpy,
				},
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(childModel).toBe(primary);
		expect(result.resolvedModel).toBe("primary/bad-runtime-model:high");
		expect(getModelUsageHealthSpy).toHaveBeenCalledTimes(1); // breaks on first non-depleted (unknown)
		expect(childFallbackChains?.["subagent:unknown-test"]).toEqual(["fallback/working-model:low"]);
	});

	it("runSubprocess candidate health selection: all depleted retains candidate 0", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childModel: Model | undefined;
		let childFallbackChains: Record<string, string[]> | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			childFallbackChains = options.settings?.get("retry.fallbackChains") as Record<string, string[]> | undefined;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated();

		const getModelUsageHealthSpy = vi.fn().mockImplementation(async () => {
			return { state: "depleted" };
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "all-depleted-test",
			modelOverride: ["primary/bad-runtime-model:high", "fallback/working-model:low"],
			modelCandidateRole: "task",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
				hasExplicitProviderApiKey: () => false,
				authStorage: {
					getModelUsageHealth: getModelUsageHealthSpy,
				},
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		// retains both candidates
		expect(childModel).toBe(primary);
		expect(result.resolvedModel).toBe("primary/bad-runtime-model:high");
		expect(getModelUsageHealthSpy).toHaveBeenCalledTimes(2);
		expect(childFallbackChains?.["subagent:all-depleted-test"]).toEqual(["fallback/working-model:low"]);
	});

	it("runSubprocess candidate health selection: explicit provider API key bypasses OAuth health", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childModel: Model | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated();

		const getModelUsageHealthSpy = vi.fn();

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "bypass-test",
			modelOverride: ["primary/bad-runtime-model:high", "fallback/working-model:low"],
			modelCandidateRole: "task",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
				hasExplicitProviderApiKey: (provider: string) => provider === "primary",
				authStorage: {
					getModelUsageHealth: getModelUsageHealthSpy,
				},
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(childModel).toBe(primary);
		expect(getModelUsageHealthSpy).not.toHaveBeenCalled();
	});

	it("runSubprocess subagent retry fallback injection preserves unrelated modelRoles entries, including malformed objects", async () => {
		const primary = model("primary", "bad-runtime-model");
		const fallback = model("fallback", "working-model");
		let childSettings: Settings | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childSettings = options.settings;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated({
			modelRoles: {
				unrelatedRole: "primary/bad-runtime-model",
				malformedRole: { strategy: "invalid-strategy", candidates: [] } as unknown,
			},
		});

		await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "retry-injection-test",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [primary, fallback],
				getApiKey: async () => "test-key",
			} as unknown as ModelRegistry,
			enableLsp: false,
		});

		expect(childSettings).toBeDefined();
		const finalModelRoles = childSettings!.get("modelRoles") as Record<string, unknown>;
		expect(finalModelRoles.unrelatedRole).toBe("primary/bad-runtime-model");
		expect(finalModelRoles.malformedRole).toEqual({ strategy: "invalid-strategy", candidates: [] });
		expect(finalModelRoles["subagent:retry-injection-test"]).toBe("primary/bad-runtime-model");
	});

	it("runSubprocess candidate health selection: unresolved command config with no OAuth stays candidate 0 during health check and falls back on eventual auth", async () => {
		const tempDir = path.join(os.tmpdir(), `pi-test-unresolved-cmd-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		const modelsPath = path.join(tempDir, "models.json");
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "0");

		// Command fails (exit 1) to simulate unresolved status.
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					primary: {
						baseUrl: "https://primary.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
						models: [{ id: "bad-runtime-model", name: "Bad Runtime Model" }],
					},
					fallback: {
						baseUrl: "https://fallback.example.com/v1",
						api: "openai-completions",
						apiKey: "fallback-auth-key",
						models: [{ id: "working-model", name: "Working Model" }],
					},
				},
			}),
		);

		const authStorage = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(authStorage, modelsPath);

		const primary = registry.find("primary", "bad-runtime-model")!;
		const fallback = registry.find("fallback", "working-model")!;
		expect(primary).toBeDefined();
		expect(fallback).toBeDefined();

		// 1. Availability check must include it and NOT execute the command again (only once on eagerness).
		const available = registry.getAvailable();
		expect(available.some(m => m.provider === "primary" && m.id === "bad-runtime-model")).toBe(true);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		let childModel: Model | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected createAgentSession options");
			childModel = options.model;
			return {
				session: createSimpleYieldingSession(),
				extensionsResult: {},
				setToolUIContext: () => {},
			} as unknown as sdkModule.CreateAgentSessionResult;
		});

		const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
		const settings = Settings.isolated();
		const getModelUsageHealthSpy = vi.fn();
		const originalGetModelUsageHealth = authStorage.getModelUsageHealth.bind(authStorage);
		vi.spyOn(authStorage, "getModelUsageHealth").mockImplementation(async (provider, opts) => {
			getModelUsageHealthSpy(provider, opts);
			return originalGetModelUsageHealth(provider, opts);
		});

		const result = await runSubprocess({
			cwd: "/tmp",
			agent,
			task: "work",
			index: 0,
			id: "unresolved-command-test",
			modelOverride: ["primary/bad-runtime-model", "fallback/working-model"],
			modelCandidateRole: "task",
			parentActiveModelPattern: "fallback/working-model",
			settings,
			modelRegistry: registry,
			enableLsp: false,
		});

		// 2. Health is NOT probed (bypassed via hasExplicitProviderApiKey).
		expect(getModelUsageHealthSpy).not.toHaveBeenCalled();

		// 3. Command has still run only once during the selection process.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// 4. Eventual auth fallback redirects it to the parent session's working model.
		expect(childModel).toBeDefined();
		expect(childModel!.id).toBe("working-model");
		expect(result.resolvedModel).toBe("fallback/working-model");

		authStorage.close();
		try {
			removeSyncWithRetries(tempDir);
		} catch {}
	});
});
