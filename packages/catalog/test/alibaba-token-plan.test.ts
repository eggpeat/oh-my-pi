import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	ALIBABA_TOKEN_PLAN_BASE_URL,
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	alibabaTokenPlanModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { serializeAlibabaTokenPlanCredential } from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

describe("QwenCloud Token Plan provider", () => {
	test("ships the documented Individual text-model allowlist", () => {
		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.map(model => model.id)).toEqual([
			"qwen3.8-max-preview",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.6-flash",
			"glm-5.2",
			"deepseek-v4-pro",
		]);

		const preview = ALIBABA_TOKEN_PLAN_STATIC_MODELS[0];
		expect(preview).toMatchObject({
			provider: "alibaba-token-plan",
			baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
			contextWindow: 983_616,
			maxTokens: 131_072,
			input: ["text", "image"],
			thinking: {
				efforts: [Effort.Low, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
			compat: {
				supportsDeveloperRole: false,
				thinkingFormat: "openai",
				reasoningDisableMode: "lowest-effort",
				supportsReasoningEffort: true,
			},
		});

		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === "glm-5.2")?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);

		for (const id of ["glm-5.2", "deepseek-v4-pro"]) {
			expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === id)?.compat).toMatchObject({
				thinkingFormat: "openai",
				reasoningDisableMode: "lowest-effort",
				supportsReasoningEffort: true,
			});
		}
	});

	test("discovers the subscribed allowlist from the native models endpoint", async () => {
		let requestedUrl = "";
		let authorization = "";
		const fetchMock: FetchImpl = (input, init) => {
			requestedUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				Response.json({
					data: [
						{
							id: "qwen3.7-plus",
							name: "server metadata must not replace curated metadata",
							owned_by: "qwencloud",
							context_length: 262_144,
							max_completion_tokens: 16_384,
						},
						{ id: "wan2.7-image", owned_by: "qwencloud" },
					],
				}),
			);
		};

		const apiKey = `  ${serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test")}  `;
		const options = alibabaTokenPlanModelManagerOptions({ apiKey, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe(`${ALIBABA_TOKEN_PLAN_BASE_URL}/models`);
		expect(authorization).toBe("Bearer sk-sp-test");
		expect(models).toHaveLength(1);
		expect(models?.[0]).toMatchObject({
			id: "qwen3.7-plus",
			provider: "alibaba-token-plan",
			name: "Qwen3.7 Plus",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});

	test("isolates authoritative discovery by API credential", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-alibaba-token-plan-"));
		const cacheDbPath = path.join(tempDir, "models.db");
		try {
			let firstFetches = 0;
			const firstOptions = alibabaTokenPlanModelManagerOptions({
				apiKey: "sk-sp-first",
				fetch: () => {
					firstFetches++;
					return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus" }] }));
				},
			});
			const firstResult = await resolveProviderModels({ ...firstOptions, cacheDbPath }, "online-if-uncached");

			let secondFetches = 0;
			const secondOptions = alibabaTokenPlanModelManagerOptions({
				apiKey: "sk-sp-second",
				fetch: () => {
					secondFetches++;
					return Promise.resolve(Response.json({ data: [{ id: "qwen3.6-flash" }] }));
				},
			});
			const secondResult = await resolveProviderModels({ ...secondOptions, cacheDbPath }, "online-if-uncached");

			expect(firstOptions.cacheProviderId).not.toBe(secondOptions.cacheProviderId);
			expect(firstResult.models.map(model => model.id)).toEqual(["qwen3.7-plus"]);
			expect(secondResult.models.map(model => model.id)).toEqual(["qwen3.6-flash"]);
			expect([firstFetches, secondFetches]).toEqual([1, 1]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("rejects malformed compound credentials before model discovery", () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({ data: [] }));
		};

		const options = alibabaTokenPlanModelManagerOptions({
			apiKey: '  {"token":"sk-sp-test","cookie":"session=secret"',
			fetch: fetchMock,
		});
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(fetched).toBe(false);
	});

	test("uses Token Plan-specific environment keys and authoritative discovery", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "alibaba-token-plan");
		expect(descriptor).toMatchObject({
			defaultModel: "qwen3.7-plus",
			envVars: ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"],
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "QwenCloud Token Plan" },
		});
	});
});
