import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";

function session(extra: Partial<ToolSession> = {}): ToolSession {
	const evalTool = { docTopics: () => ({ browser: "line 1\nline 2" }) } as unknown as Tool;
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getToolByName: name => (name === "eval" ? evalTool : undefined),
		...extra,
	};
}

async function thirdRead(tool: ReadTool, path: string): Promise<string> {
	await tool.execute("first", { path });
	await tool.execute("second", { path });
	const result = await tool.execute("third", { path });
	return result.content.map(entry => (entry.type === "text" ? entry.text : "")).join("\n");
}

// Topic docs page with :A-B, so a repeated full read can point at that selector.
it("suggests a line selector on a repeated xd:// topic read", async () => {
	const text = await thirdRead(new ReadTool(session()), "xd://eval/browser");
	expect(text).toContain("identical output 3 times");
	expect(text).toContain("path:A-B");
});

// A bare device URL still treats the tail as its name, so the hint must not recommend one.
it("does not suggest a line selector on a repeated xd:// device read", async () => {
	const xdev: XdevState = {
		tools: new Map(),
		mountedNames: new Set(),
		builtInNames: new Set(),
		isActive: () => false,
	};
	const text = await thirdRead(new ReadTool(session({ xdev })), "xd://");
	expect(text).toContain("identical output 3 times");
	expect(text).not.toContain("path:A-B");
});
