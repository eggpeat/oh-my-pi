import { describe, expect, test } from "bun:test";
import { getExtraHelpText } from "../src/cli/help-extra";

describe("root CLI help", () => {
	test("does not advertise an unsupported Anthropic search base URL override", () => {
		const help = getExtraHelpText();
		expect(help).toContain("ANTHROPIC_SEARCH_API_KEY");
		expect(help).not.toContain("ANTHROPIC_SEARCH_BASE_URL");
	});
});
