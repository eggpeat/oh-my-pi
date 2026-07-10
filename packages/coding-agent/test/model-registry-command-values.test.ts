import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function stdoutCommand(value: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

describe("ModelRegistry command-resolved models.yml values", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-values-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("provider apiKey and headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						headers: { "X-Api-Key": `!${stdoutCommand("cmd-header")}` },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const models = registry.getAll().filter(model => model.provider === "anthropic");

		expect(models.length).toBeGreaterThan(1);
		for (const model of models) {
			expect(model.headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(model.headers?.["X-Api-Key"]).toBe("cmd-header");
		}
		expect(await registry.getApiKey(models[0])).toBe("cmd-api-key");
	});

	test("modelOverrides headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "X-Model-Key": `!${stdoutCommand("cmd-model-header")}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");

		expect(model).toBeDefined();
		expect(model?.headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(model?.headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("resolveCommandConfig caches failed executions so they do not retry", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "0");

		// Command increments a counter and then fails (exit 1).
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Init triggers the first command resolution.
		const registry = new ModelRegistry(authStorage, modelsPath);

		const dummyModel: Model<Api> = buildModel({
			id: "foo",
			name: "foo",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "a",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});

		// Trigger the fallback resolver which also calls resolveConfigValue.
		await registry.getApiKey(dummyModel);

		// Another call to ensure it hits cache multiple times.
		await registry.getApiKey(dummyModel);

		// The command should have only run once.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("hasExplicitProviderApiKey returns true for literal and unresolved command provider keys without executing the command during check", async () => {
		const counterFile = path.join(tempDir, "bypass_counter.txt");
		fs.writeFileSync(counterFile, "0");
		// Command increments a counter and then fails (exit 1) to simulate unresolved status.
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"literal-provider": {
						baseUrl: "https://literal.example.com",
						apiKey: "literal-key",
					},
					"command-provider": {
						baseUrl: "https://command.example.com",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Eager load executes the command once on initialization.
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// Querying hasExplicitProviderApiKey must be synchronous and NOT execute the command.
		expect(registry.hasExplicitProviderApiKey("literal-provider")).toBe(true);
		expect(registry.hasExplicitProviderApiKey("command-provider")).toBe(true);
		expect(registry.hasExplicitProviderApiKey("non-existent-provider")).toBe(false);

		// The command execution count remains 1.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("unresolved command key model is available in getAvailable without re-execution, and disabledProvider excludes it", async () => {
		const counterFile = path.join(tempDir, "regression_counter.txt");
		fs.writeFileSync(counterFile, "0");
		// Command fails (exit 1) to simulate unresolved status.
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"command-provider": {
						baseUrl: "https://command.example.com",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
						models: [{ id: "bad-model", name: "Bad Model" }],
					},
				},
			}),
		);

		// Eager load executes the command once on initialization.
		const registry = new ModelRegistry(authStorage, modelsPath);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// 1. Model is available in getAvailable, and checking it did NOT re-execute the command.
		const availableBefore = registry.getAvailable();
		expect(availableBefore.some(m => m.provider === "command-provider" && m.id === "bad-model")).toBe(true);
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");

		// 2. Disabled provider still excludes it.
		const originalDisabled = settings.get("disabledProviders");
		try {
			settings.override("disabledProviders", ["command-provider"]);
			const availableAfter = registry.getAvailable();
			expect(availableAfter.some(m => m.provider === "command-provider" && m.id === "bad-model")).toBe(false);
		} finally {
			// Restore settings
			settings.override("disabledProviders", originalDisabled);
		}

		// Check count remains 1 at the end.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});

	test("getAvailable memoizes configured-auth lookup once per provider when multiple models share a provider", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"shared-provider": {
						baseUrl: "https://shared.example.com",
						api: "openai-completions",
						apiKey: "dummy-key",
						models: [
							{ id: "model-1", name: "Model 1" },
							{ id: "model-2", name: "Model 2" },
							{ id: "model-3", name: "Model 3" },
						],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const hasAuthSpy = vi.spyOn(authStorage, "hasAuth").mockReturnValue(true);

		const available = registry.getAvailable();

		// Assert availability of all three models under the shared provider
		const sharedModels = available.filter(m => m.provider === "shared-provider");
		expect(sharedModels.length).toBe(3);
		expect(sharedModels.map(m => m.id).sort()).toEqual(["model-1", "model-2", "model-3"]);

		// Assert hasAuth was called exactly ONCE for "shared-provider" due to provider-level memoization
		const callsForShared = hasAuthSpy.mock.calls.filter(args => args[0] === "shared-provider");
		expect(callsForShared.length).toBe(1);

		hasAuthSpy.mockRestore();
	});
});
