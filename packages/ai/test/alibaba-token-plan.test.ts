import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { resolveOpenAIRequestSetup } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { loginAlibabaTokenPlan } from "@oh-my-pi/pi-ai/registry/alibaba-token-plan";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ALIBABA_TOKEN_PLAN_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { withEnv } from "./helpers";

function chatSse(): Response {
	return new Response(
		[
			`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, index: 0 }] })}`,
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}`,
			"data: [DONE]",
			"",
		].join("\n\n"),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("QwenCloud Token Plan login", () => {
	test("opens the Individual subscription page and validates without inference", async () => {
		const authRequests: { url: string; instructions?: string }[] = [];
		let requestedUrl = "";
		let authorization = "";
		const apiKey = await loginAlibabaTokenPlan({
			onAuth: request => authRequests.push(request),
			onPrompt: async prompt => (prompt.allowEmpty ? "" : " sk-sp-test "),
			fetch: (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("Authorization") ?? "";
				return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus" }] }));
			},
		});

		expect(apiKey).toBe("sk-sp-test");
		expect(authRequests).toEqual([
			{
				url: "https://home.qwencloud.com/billing/subscription/token-plan-individual",
				instructions: "Subscribe to Token Plan Individual and copy its dedicated API key",
			},
		]);
		expect(requestedUrl).toBe("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models");
		expect(authorization).toBe("Bearer sk-sp-test");
	});

	test("stores an optional console Cookie while sending only the API key to inference", async () => {
		const prompts = ["sk-sp-test", "session_id=test; login_aliyunid_csrf=csrf-token"];
		const credential = await loginAlibabaTokenPlan({
			onAuth: () => {},
			onPrompt: async () => prompts.shift() ?? "",
			fetch: () => Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus" }] })),
		});
		expect(JSON.parse(credential)).toEqual({
			token: "sk-sp-test",
			cookie: "session_id=test; login_aliyunid_csrf=csrf-token",
		});

		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");
		const setup = resolveOpenAIRequestSetup(model, {
			apiKey: credential,
			messages: [],
		});
		expect(setup.headers.Authorization).toBe("Bearer sk-sp-test");
		expect(JSON.stringify(setup)).not.toContain("session_id=test");
	});

	test("rejects malformed compound credentials before inference setup", () => {
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");

		for (const apiKey of [
			'  {"token":"sk-sp-test","cookie":"session=secret"',
			'"token":"sk-sp-test","cookie":"session=secret"}',
		]) {
			expect(() => resolveOpenAIRequestSetup(model, { apiKey, messages: [] })).toThrow(
				"Invalid QwenCloud Token Plan credential",
			);
		}
	});

	test("does not use OPENAI_API_KEY as Token Plan authentication", async () => {
		const model = getBundledModel<"openai-completions">("alibaba-token-plan", "qwen3.7-plus");
		if (!model) throw new Error("expected bundled QwenCloud Token Plan model");

		await withEnv({ OPENAI_API_KEY: "sk-openai-placeholder" }, () => {
			expect(() => resolveOpenAIRequestSetup(model, { messages: [] })).toThrow(
				"QwenCloud Token Plan API key is required",
			);
		});
	});

	test("sends reasoning_effort for every effort-controlled Token Plan model", async () => {
		const context: Context = {
			systemPrompt: [],
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};

		for (const [id, effort] of [
			["qwen3.8-max-preview", "xhigh"],
			["glm-5.2", "max"],
			["deepseek-v4-pro", "max"],
		] as const) {
			const spec = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(candidate => candidate.id === id);
			if (!spec) throw new Error(`expected curated ${id} model`);
			const model = buildModel(spec);
			let body = "";
			const fetchMock: FetchImpl = async (_input, init) => {
				body = typeof init?.body === "string" ? init.body : "";
				return chatSse();
			};

			const stream = streamOpenAICompletions(model as Model<"openai-completions">, context, {
				apiKey: "sk-sp-placeholder",
				reasoning: effort,
				fetch: fetchMock,
			});
			for await (const _event of stream) {
				/* drain */
			}

			const payload = JSON.parse(body) as { reasoning_effort?: unknown; enable_thinking?: unknown };
			expect(payload.reasoning_effort).toBe(effort);
			expect(payload.enable_thinking).toBeUndefined();
		}
	});

	test("registers Token Plan separately from the legacy Alibaba Coding Plan", () => {
		const providers = getOAuthProviders();
		expect(providers.find(provider => provider.id === "alibaba-token-plan")).toMatchObject({
			name: "QwenCloud Token Plan",
			available: true,
		});
		expect(providers.some(provider => provider.id === "alibaba-coding-plan")).toBe(true);
	});
});
