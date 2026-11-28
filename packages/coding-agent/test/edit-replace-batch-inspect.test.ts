import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
		settings: Settings.isolated({}),
	} as unknown as ToolSession;
}

beforeEach(() => {
	resetSettingsForTest();
});

afterEach(() => {
	resetSettingsForTest();
});

describe("replace batch inspection", () => {
	test("exposes every batch new_string, including a deletion, and not the removed text", () => {
		const tool = new EditTool(makeSession(), "replace");
		expect(tool.matcherEntries({ path: "secret.ts", old_string: "old", new_string: "replacement" })).toEqual([
			{ path: "secret.ts", digest: "replacement" },
		]);
		expect(tool.matcherDigest({ path: "secret.ts", old_string: "old", new_string: "replacement" })).toBe(
			"replacement",
		);

		const deleted = {
			path: "secret.ts",
			edits: [{ old_string: "FORBIDDEN_PATTERN", new_string: "" }],
		};
		expect(tool.matcherEntries(deleted)).toEqual([{ path: "secret.ts", digest: "" }]);

		const batch = {
			path: "secret.ts",
			new_string: "ignored top-level",
			edits: [
				{ old_string: "FORBIDDEN_PATTERN", new_string: "" },
				{ old_string: "also forbidden", new_string: "line two\nstill safe" },
				{ old_string: "pending" },
			],
		};
		expect(tool.matcherEntries(batch)).toEqual([{ path: "secret.ts", digest: "\nline two\nstill safe" }]);
		expect(tool.matcherDigest(batch)).toBe("\nline two\nstill safe");
		expect(tool.matcherPaths(batch)).toEqual(["secret.ts"]);
	});
});
