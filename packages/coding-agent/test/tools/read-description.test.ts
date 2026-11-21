import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { cfgReadLineNumbers } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function textOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("\n");
}

function makeSession(
	cwd: string,
	options: {
		editMode?: "hashline" | "replace" | "patch";
		readLineNumbers?: boolean;
		hasEditTool?: boolean;
		activeModel?: string;
	} = {},
): ToolSession {
	const settings = Settings.isolated({
		"edit.mode": options.editMode ?? "hashline",
		readLineNumbers: options.readLineNumbers ?? false,
		"read.summarize.enabled": false,
	});
	return {
		cwd,
		hasUI: false,
		hasEditTool: options.hasEditTool,
		getActiveModelString: options.activeModel ? () => options.activeModel : undefined,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

describe("ReadTool.description matches active line-prefix mode", () => {
	let testDir: string;
	let filePath: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-description-"));
		filePath = path.join(testDir, "example.py");
		await Bun.write(filePath, "alpha = 1\nbeta = 2\n");
	});

	afterEach(async () => {
		await removeWithRetries(testDir);
	});

	it("describes anchors and prefixes only in hashline mode", async () => {
		const tool = new ReadTool(makeSession(testDir, { editMode: "hashline", hasEditTool: true }));
		expect(tool.description).toContain("- :raw verbatim without anchors/prefixes;");
		expect(tool.description).toContain("Selected file: `[foo.ts#1A2B]`");

		const body = textOutput(await tool.execute("read-hl", { path: filePath }));
		expect(body).toMatch(/^\[\S+#[0-9A-Z]+\]\n1:alpha = 1\n2:beta = 2$/);
	});

	it.each([
		{ label: "read-only session", hasEditTool: false, editMode: "hashline" as const },
		{ label: "replace edit mode", hasEditTool: true, editMode: "replace" as const },
	])(
		"describes line prefixes without anchors when only readLineNumbers is enabled ($label)",
		async ({ hasEditTool, editMode }) => {
			const tool = new ReadTool(makeSession(testDir, { editMode, hasEditTool, readLineNumbers: true }));
			expect(tool.description).toContain("- :raw verbatim without line prefixes;");
			expect(tool.description).not.toContain("anchors/prefixes");
			expect(tool.description).not.toContain("Selected file:");

			const body = textOutput(await tool.execute("read-ln", { path: filePath }));
			expect(body).toBe("1|alpha = 1\n2|beta = 2");
		},
	);

	it.each([
		{ label: "read-only session", hasEditTool: false, editMode: "hashline" as const, activeModel: undefined },
		{ label: "replace edit mode", hasEditTool: true, editMode: "replace" as const, activeModel: undefined },
		{
			label: "model auto-switched to replace",
			hasEditTool: true,
			editMode: "hashline" as const,
			activeModel: "moonshot/kimi-k2.5",
		},
	])(
		"omits anchors/prefixes wording when neither hashlines nor line numbers are active ($label)",
		async ({ hasEditTool, editMode, activeModel }) => {
			const tool = new ReadTool(
				makeSession(testDir, { editMode, hasEditTool, readLineNumbers: false, activeModel }),
			);
			expect(tool.description).not.toContain("anchors/prefixes");
			expect(tool.description).not.toContain("line prefixes");
			expect(tool.description).not.toContain("Selected file:");
			expect(tool.description).toContain(
				"skips folding and the display-width limit, but the byte limit still applies",
			);

			const body = textOutput(await tool.execute("read-plain", { path: filePath }));
			expect(body).toBe("alpha = 1\nbeta = 2");
		},
	);

	it("updates description dynamically when display settings change", () => {
		const settings = Settings.isolated({ "read.summarize.enabled": false });
		cfgEditMode.set(settings, "replace");
		cfgReadLineNumbers.set(settings, false);
		const tool = new ReadTool({
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings,
		});

		expect(tool.description).not.toContain("line prefixes");
		expect(tool.description).not.toContain("anchors/prefixes");

		cfgReadLineNumbers.set(settings, true);
		expect(tool.description).toContain("- :raw verbatim without line prefixes;");

		cfgEditMode.set(settings, "hashline");
		expect(tool.description).toContain("- :raw verbatim without anchors/prefixes;");
		expect(tool.description).toContain("Selected file: `[foo.ts#1A2B]`");
	});
});
