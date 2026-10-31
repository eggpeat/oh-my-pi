import { expect, test } from "bun:test";
import { buildModel } from "../src/build";
import { seedModels } from "../src/compat/providers";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

// Muse subscription attestation rejects exact built-in names; the same
// restriction has not been verified with Meta pay-as-you-go credentials.
test("Muse Code escapes reserved tool names without changing Meta or Anthropic policy", () => {
	const spec = seedModels("muse-code").find(
		model => model.id === "muse-wonder-full-1.0",
	) as ModelSpec<"openai-responses">;
	expect(resolveModelPolicy(spec).compat.escapeBuiltinToolNames).toBe(true);
	expect(buildModel(spec).compat.escapeBuiltinToolNames).toBe(true);
	expect(resolveModelPolicy({ ...spec, provider: "meta" }).compat.escapeBuiltinToolNames).toBe(false);
	expect(
		resolveModelPolicy({ ...spec, compat: { escapeBuiltinToolNames: false } }).compat.escapeBuiltinToolNames,
	).toBe(false);
	const anthropic: ModelSpec<"anthropic-messages"> = {
		name: "Claude Sonnet",
		reasoning: true,
		input: ["text"],
		cost: spec.cost,
		contextWindow: spec.contextWindow,
		maxTokens: spec.maxTokens,
		api: "anthropic-messages",
		id: "claude-sonnet-4-6",
		provider: "umans",
		baseUrl: "https://api.code.umans.ai",
	};
	expect(resolveModelPolicy(anthropic).compat.escapeBuiltinToolNames).toBe(true);
	expect(
		resolveModelPolicy({ ...anthropic, provider: "anthropic", baseUrl: "https://api.anthropic.com" }).compat
			.escapeBuiltinToolNames,
	).toBe(false);
});
