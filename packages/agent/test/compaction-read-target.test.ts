import { describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { extractFileOpsFromMessages } from "../src/compaction/utils";
import { createAssistantMessage } from "./helpers";

function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

function readResult(toolCallId: string, details?: ToolResultMessage["details"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "..." }],
		details,
		isError: false,
		timestamp: Date.now(),
	};
}

describe("extractFileOpsFromMessages — resolved read targets", () => {
	it("a resolved readTarget decides the file over the asked path", () => {
		const fileOps = snapcompact.createFileOps();
		const assistant = createAssistantMessage([readCall("r1", "a.ts:-60")]);
		// `a.ts:-60` turned out to be a real file, recorded by the read tool.
		const result = readResult("r1", { readTarget: { path: "a.ts:-60" } });
		extractFileOpsFromMessages([assistant, result], fileOps);
		expect([...fileOps.read]).toEqual(["a.ts:-60"]);
	});

	it("an unrecorded selector-looking filename survives via meta.source", () => {
		const fileOps = snapcompact.createFileOps();
		const assistant = createAssistantMessage([readCall("r1", "notes.txt:-60")]);
		const result = readResult("r1", { meta: { source: { type: "path", value: "/repo/notes.txt:-60" } } });
		extractFileOpsFromMessages([assistant, result], fileOps);
		expect([...fileOps.read]).toEqual(["/repo/notes.txt:-60"]);
	});

	it("a suffix-resolved read names the matched file, not the asked name", () => {
		const fileOps = snapcompact.createFileOps();
		const assistant = createAssistantMessage([readCall("r1", "notes.txt:5-9")]);
		const result = readResult("r1", { suffixResolution: { from: "notes.txt", to: "docs/notes.txt" } });
		extractFileOpsFromMessages([assistant, result], fileOps);
		expect([...fileOps.read]).toEqual(["docs/notes.txt"]);
	});

	it("an internal-resource read never enters <files> even with a scheme-less path", () => {
		const fileOps = snapcompact.createFileOps();
		const assistant = createAssistantMessage([readCall("r1", "asset:img")]);
		const result = readResult("r1", { meta: { source: { type: "internal", value: "asset" } } });
		extractFileOpsFromMessages([assistant, result], fileOps);
		expect([...fileOps.read]).toEqual([]);
	});

	it("a repeated tool-call id attributes each result to its own call", () => {
		const fileOps = snapcompact.createFileOps();
		// A second read reuses the first call's id: each result must claim its
		// own call's slot, so `b.ts`'s target never lands on `a.ts`'s entry.
		const assistant = createAssistantMessage([readCall("same", "a.ts"), readCall("same", "b.ts")]);
		const resultA = readResult("same", { readTarget: { path: "a.ts" } });
		const resultB = readResult("same", { readTarget: { path: "b.ts" } });
		extractFileOpsFromMessages([assistant, resultA, resultB], fileOps);
		expect([...fileOps.read]).toEqual(["a.ts", "b.ts"]);
	});
});
