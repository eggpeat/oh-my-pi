import { describe, expect, spyOn, test } from "bun:test";
import { type CommandMetadata, renderRootHelp } from "@oh-my-pi/pi-utils/cli";
import { getExtraHelpText } from "../src/cli/help-extra";
import { commands } from "../src/cli-commands";

/** Names advertised as "NAME - description" lines in root help. */
function advertisedEnvVars(help: string): string[] {
	return [...help.matchAll(/^\s{2}([A-Z][A-Z0-9_]+)\s+-\s/gm)].map(match => match[1]);
}

describe("root CLI help", () => {
	test("omits the unsupported Anthropic search base URL and keeps the search API key", () => {
		const help = getExtraHelpText();
		expect(help).not.toContain("ANTHROPIC_SEARCH_BASE_URL");
		expect(advertisedEnvVars(help)).toContain("ANTHROPIC_SEARCH_API_KEY");
	});

	test("lists each launch flag the argv parser accepts exactly once", () => {
		const metadata = new Map<string, CommandMetadata>();
		for (const entry of commands) if (entry.help) metadata.set(entry.name, entry.help);
		const chunks: string[] = [];
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(chunk => {
			chunks.push(String(chunk));
			return true;
		});
		try {
			renderRootHelp({ bin: "omp", version: "test", commands: metadata });
		} finally {
			stdoutSpy.mockRestore();
		}
		const help = `${chunks.join("")}\n${getExtraHelpText()}`;
		for (const flag of [
			"fork",
			"session",
			"plugin-dir",
			"trusted-extension",
			"provider-session-id",
			"prompt-cache-key",
		]) {
			const listed = help.match(new RegExp(`^\\s+--${flag}\\b(?!-)`, "gm")) ?? [];
			expect(listed, `--${flag}`).toHaveLength(1);
		}
	});
});
