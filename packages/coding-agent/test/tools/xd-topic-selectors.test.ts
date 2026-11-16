import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";

const DOC_LINES = Array.from({ length: 12 }, (_, index) => `doc-line-${index + 1}`);
const DOC = DOC_LINES.join("\n");

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(entry => (entry.type === "text" ? (entry.text ?? "") : "")).join("\n");
}

function session(): ToolSession {
	const evalTool = { docTopics: () => ({ browser: DOC }) } as unknown as Tool;
	const xdev: XdevState = {
		tools: new Map(),
		mountedNames: new Set(),
		builtInNames: new Set(),
		isActive: () => false,
	};
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
		xdev,
	};
}

describe("xd:// topic line selectors", () => {
	it("returns the selected documentation lines, verbatim when :raw is set", async () => {
		const tool = new ReadTool(session());
		const ranged = textOf(await tool.execute("range", { path: "xd://eval/browser:1-5" }));
		expect(ranged).toContain("doc-line-1");
		expect(ranged).toContain("doc-line-5");
		expect(ranged).not.toContain("doc-line-12");
		expect(ranged).not.toContain("Unknown topic");

		const raw = textOf(await tool.execute("raw", { path: "xd://eval/browser:1-5:raw" }));
		expect(raw).toBe(DOC_LINES.slice(0, 5).join("\n"));

		const rawFirst = textOf(await tool.execute("raw-first", { path: "xd://eval/browser:raw:1-5" }));
		expect(rawFirst).toBe(DOC_LINES.slice(0, 5).join("\n"));

		const commas = textOf(await tool.execute("commas", { path: "xd://eval/browser:1-2,4-4:raw" }));
		expect(commas).toBe([DOC_LINES[0], DOC_LINES[1], DOC_LINES[3]].join("\n"));
	});

	it("keeps a :raw or :conflicts suffix on a device name", async () => {
		const tool = new ReadTool(session());
		await expect(tool.execute("device-raw", { path: "xd://ast_edit:raw" })).rejects.toThrow("xd://ast_edit:raw");
		await expect(tool.execute("device-conflicts", { path: "xd://ast_edit:conflicts" })).rejects.toThrow(
			"xd://ast_edit:conflicts",
		);
		await expect(tool.execute("device-range", { path: "xd://ast_edit:1-5" })).rejects.toThrow("xd://ast_edit:1-5");
		const router = InternalUrlRouter.instance();
		expect(() => router.peelWriteSelector("xd://ast_edit:raw", "write")).toThrow(
			/does not accept the trailing selector ":raw"/,
		);
		expect(() => router.peelWriteSelector("xd://ast_edit:conflicts", "write")).toThrow(
			/does not accept the trailing selector ":conflicts"/,
		);
		expect(() => router.peelWriteSelector("xd://ast_edit:1-5", "write")).toThrow(
			/does not accept the trailing selector ":1-5"/,
		);
	});
});
