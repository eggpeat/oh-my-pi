import { describe, expect, test } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	prepareBranchEntries,
	pruneSupersededToolResults,
	readToolSupersedeKey,
	type SessionEntry,
	type SessionMessageEntry,
	type SupersedeCompleteFn,
	type SupersedePruneConfig,
} from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { extractFileOpsFromMessage, indexRecordedReadPaths, stripReadSelector } from "../src/compaction/utils";
import { createAssistantMessage } from "./helpers";

/** Key separator for line-selector reads (superseded by a complete bare-path read). */
const SEL_KEY = String.fromCharCode(0);
/** Key separator for alternate-form reads (`raw`, `conflicts`, `img` — same-selector only). */
const ALT_KEY = String.fromCharCode(1);

function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

describe("stripReadSelector — selector shapes the read tool accepts", () => {
	test("strips tail selectors and tail chunks inside comma lists", () => {
		expect(stripReadSelector("src/foo.ts:-60")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:1-12,-15")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:-60")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:-60:raw")).toBe("src/foo.ts");
	});

	test("strips img and per-chunk raw selectors", () => {
		expect(stripReadSelector("logo.svg:img")).toBe("logo.svg");
		expect(stripReadSelector("src/foo.ts:1-3:raw,9:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:5,raw:9-12")).toBe("src/foo.ts");
	});

	test("strips colons folded back into a comma list", () => {
		expect(stripReadSelector("src/foo.ts:1-30,:-30")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:20:40,85:100")).toBe("src/foo.ts");
	});
});

describe("extractFileOpsFromMessage — selector dedupe", () => {
	test("tail, img, and per-chunk raw reads dedupe onto the plain path", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/app.ts:-60"),
			readCall("r2", "src/app.ts"),
			readCall("r3", "src/app.ts:1-3:raw,9:raw"),
			readCall("r4", "logo.svg:img"),
			readCall("r5", "logo.svg"),
		]);
		extractFileOpsFromMessage(message, fileOps);
		expect([...fileOps.read].sort()).toEqual(["logo.svg", "src/app.ts"]);
	});

	test("a selector read merges with a write of the same file", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/app.ts:-60"),
			{ type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "src/app.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/app.ts"]);
	});
});

describe("readToolSupersedeKey — selector shapes the read tool accepts", () => {
	test("tail selectors key under the bare path like other line selectors", () => {
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:-60" })).toBe(`src/foo.ts${SEL_KEY}-60`);
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:1-12,-15" })).toBe(`src/foo.ts${SEL_KEY}1-12,-15`);
	});

	test("img and raw compounds key as alternate forms apart from the bare path", () => {
		expect(readToolSupersedeKey("read", { path: "logo.svg:img" })).toBe(`logo.svg${ALT_KEY}img`);
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:-60:raw" })).toBe(`src/foo.ts${ALT_KEY}-60:raw`);
		expect(readToolSupersedeKey("read", { path: "src/foo.ts:1-3:raw,9:raw" })).toBe(`src/foo.ts${ALT_KEY}1-3,9:raw`);
	});
});

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);
const FILE_CONTENT = "export function alpha() { return 1; }\n".repeat(50);
const tokenizer = new Tokenizer();

let idCounter = 0;
function nextId(): string {
	return `sel-entry-${idCounter++}`;
}

function messageEntry(message: AgentMessage, timestamp: number): SessionMessageEntry {
	return {
		type: "message",
		id: nextId(),
		parentId: null,
		timestamp: new Date(timestamp).toISOString(),
		message,
	};
}

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	};
}

function toolResultMessage(toolName: string, toolCallId: string, text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

/** Assistant toolCall entry + paired toolResult entry for one read. */
function readPair(path: string, text: string, timestamp: number): [SessionMessageEntry, SessionMessageEntry] {
	const callId = `sel-call-${idCounter++}`;
	return [
		messageEntry(
			assistantMessage([{ type: "toolCall", id: callId, name: "read", arguments: { path } }], timestamp),
			timestamp,
		),
		messageEntry(toolResultMessage("read", callId, text, timestamp), timestamp),
	];
}

function resultText(entry: SessionEntry): string {
	const message = (entry as SessionMessageEntry).message as ToolResultMessage;
	return (message.content[0] as TextContent).text;
}

/** Every result counts complete here; partial-result mechanics live in supersede-prune.test.ts. */
const testComplete: SupersedeCompleteFn = () => true;

function pruneStale(entries: SessionEntry[], now: number) {
	const config: SupersedePruneConfig = {
		supersedeKey: readToolSupersedeKey,
		supersedeComplete: testComplete,
		protectedTools: [],
		now,
	};
	return pruneSupersededToolResults(entries, tokenizer, config);
}

describe("pruneSupersededToolResults — selector supersession", () => {
	test("a complete plain read supersedes an earlier tail read of the same file", () => {
		const [call1, result1] = readPair("src/foo.ts:-60", FILE_CONTENT, T0);
		const [call2, result2] = readPair("src/foo.ts", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneStale(entries, T0 + 1_000);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("a complete plain read does not supersede an earlier :img read", () => {
		const [call1, result1] = readPair("logo.svg:img", FILE_CONTENT, T0);
		const [call2, result2] = readPair("logo.svg", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneStale(entries, T0 + 1_000);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe(FILE_CONTENT);
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("a newer :img read supersedes the earlier one only through the same selector", () => {
		const [call1, result1] = readPair("logo.svg:img", FILE_CONTENT, T0);
		const [call2, result2] = readPair("logo.svg:img", FILE_CONTENT, T0 + 1_000);
		const entries: SessionEntry[] = [call1, result1, call2, result2];

		const result = pruneStale(entries, T0 + 1_000);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});
});

describe("literal colon filenames", () => {
	test("readToolSupersedeKey uses the path the read opened, not a fresh split of the argument", () => {
		const opened = {
			role: "toolResult",
			toolCallId: "c",
			toolName: "read",
			content: [],
			isError: false,
			timestamp: T0,
			details: { readTarget: { path: "notes.txt:-60" } },
		} as ToolResultMessage;
		expect(readToolSupersedeKey("read", { path: "notes.txt:-60" }, opened)).toBe("notes.txt:-60");
		expect(readToolSupersedeKey("read", { path: "notes.txt:-60" })).toBe(`notes.txt${SEL_KEY}-60`);
	});

	test("a full read does not erase a result the tool opened as a different literal file", () => {
		const [call1, result1] = readPair("notes.txt:-60", "literal file\n", T0);
		(result1.message as ToolResultMessage).details = { readTarget: { path: "notes.txt:-60" } };
		const [call2, result2] = readPair("notes.txt", FILE_CONTENT, T0 + 1_000);
		(result2.message as ToolResultMessage).details = { readTarget: { path: "notes.txt" } };

		const result = pruneStale([call1, result1, call2, result2], T0 + 1_000);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe("literal file\n");
		expect(resultText(result2)).toBe(FILE_CONTENT);
	});

	test("file lists keep the opened literal name beside the plain file", () => {
		const call = createAssistantMessage([readCall("r1", "notes.txt:-60"), readCall("r2", "notes.txt")]);
		const opened = {
			role: "toolResult",
			toolCallId: "r1",
			toolName: "read",
			content: [{ type: "text", text: "literal" }],
			isError: false,
			details: { readTarget: { path: "notes.txt:-60" } },
		} as ToolResultMessage;
		const fileOps = snapcompact.createFileOps();
		extractFileOpsFromMessage(call, fileOps, indexRecordedReadPaths([call, opened]));
		expect([...fileOps.read].sort()).toEqual(["notes.txt", "notes.txt:-60"]);
	});

	test("a saved file list keeps a literal colon name only when it was already resolved", () => {
		const entry = (resolved: boolean | undefined) =>
			({
				type: "branch_summary",
				id: "b1",
				parentId: null,
				timestamp: new Date(T0).toISOString(),
				fromId: "from",
				summary: "sum",
				details: {
					readFiles: ["notes.txt:-60"],
					modifiedFiles: [],
					...(resolved ? { readFilesResolved: true } : {}),
				},
			}) as SessionEntry;
		expect([...prepareBranchEntries([entry(true)], tokenizer).fileOps.read]).toEqual(["notes.txt:-60"]);
		expect([...prepareBranchEntries([entry(undefined)], tokenizer).fileOps.read]).toEqual(["notes.txt"]);
	});
});

describe("results recorded before readTarget (resolvedPath)", () => {
	test("an upgraded session keeps the literal file result when its plain file is re-read", () => {
		// Result details as older versions persisted them: resolvedPath, no readTarget.
		const [call1, result1] = readPair("notes.txt:-60", "literal\n", T0);
		(result1.message as ToolResultMessage).details = { resolvedPath: "/work/notes.txt:-60" };
		const [call2, result2] = readPair("notes.txt", FILE_CONTENT, T0 + 1_000);
		(result2.message as ToolResultMessage).details = { resolvedPath: "/work/notes.txt" };

		const result = pruneStale([call1, result1, call2, result2], T0 + 1_000);

		expect(result.prunedCount).toBe(0);
		expect(resultText(result1)).toBe("literal\n");
	});

	test("an upgraded session still supersedes a real tail read", () => {
		const [call1, result1] = readPair("notes.txt:-5", "tail\n", T0);
		(result1.message as ToolResultMessage).details = { resolvedPath: "/work/notes.txt" };
		const [call2, result2] = readPair("notes.txt", FILE_CONTENT, T0 + 1_000);
		(result2.message as ToolResultMessage).details = { resolvedPath: "/work/notes.txt" };

		const result = pruneStale([call1, result1, call2, result2], T0 + 1_000);

		expect(result.prunedCount).toBe(1);
		expect(resultText(result1)).toBe("[Superseded by a newer read of this file]");
	});

	test("file lists in an upgraded session name the recorded file, not a re-split", () => {
		const call = createAssistantMessage([readCall("r1", "notes.txt:-60"), readCall("r2", "notes.txt")]);
		const opened = {
			role: "toolResult",
			toolCallId: "r1",
			toolName: "read",
			content: [{ type: "text", text: "literal" }],
			isError: false,
			timestamp: T0,
			details: { resolvedPath: "notes.txt:-60" },
		} as ToolResultMessage;
		const fileOps = snapcompact.createFileOps();
		extractFileOpsFromMessage(call, fileOps, indexRecordedReadPaths([call, opened]));
		expect([...fileOps.read].sort()).toEqual(["notes.txt", "notes.txt:-60"]);
	});
});

describe("question, external, and reused-id reads", () => {
	test("different ?q= answers about one image do not supersede each other or a plain read", () => {
		const [call1, result1] = readPair("photo.png?q=what is in the image", "a cat\n", T0);
		(result1.message as ToolResultMessage).details = {
			resolvedPath: "/work/photo.png",
			readTarget: { path: "photo.png", question: "what is in the image" },
		};
		const [call2, result2] = readPair("photo.png?q=how many cats", "two cats\n", T0 + 1_000);
		(result2.message as ToolResultMessage).details = {
			resolvedPath: "/work/photo.png",
			readTarget: { path: "photo.png", question: "how many cats" },
		};
		const [call3, result3] = readPair("photo.png", FILE_CONTENT, T0 + 2_000);
		(result3.message as ToolResultMessage).details = {
			resolvedPath: "/work/photo.png",
			readTarget: { path: "photo.png" },
		};

		const result = pruneStale([call1, result1, call2, result2, call3, result3], T0 + 2_000);

		expect(result.prunedCount).toBe(0);
	});

	test("a served resource read leaves no file in lists and joins no pruning", () => {
		const call = createAssistantMessage([readCall("r1", "asset:img")]);
		const served = {
			role: "toolResult",
			toolCallId: "r1",
			toolName: "read",
			content: [{ type: "text", text: "resource bytes" }],
			isError: false,
			timestamp: T0,
			details: { readTarget: { path: "asset:img", external: true } },
		} as ToolResultMessage;
		const fileOps = snapcompact.createFileOps();
		extractFileOpsFromMessage(call, fileOps, indexRecordedReadPaths([call, served]));
		expect([...fileOps.read]).toEqual([]);
		expect(readToolSupersedeKey("read", { path: "asset:img" }, served)).toBeUndefined();
	});

	test("tool call ids reused across prompts keep each call's own opened path", () => {
		const call1 = createAssistantMessage([readCall("shared", "a.txt")]);
		const result1 = {
			role: "toolResult",
			toolCallId: "shared",
			toolName: "read",
			content: [{ type: "text", text: "a" }],
			isError: false,
			timestamp: T0,
			details: { readTarget: { path: "a.txt" } },
		} as ToolResultMessage;
		const call2 = createAssistantMessage([readCall("shared", "b.txt")]);
		const result2 = {
			...result1,
			details: { readTarget: { path: "b.txt" } },
		} as ToolResultMessage;
		const recorded = indexRecordedReadPaths([call1, result1, call2, result2]);
		const fileOps = snapcompact.createFileOps();
		extractFileOpsFromMessage(call1, fileOps, recorded);
		extractFileOpsFromMessage(call2, fileOps, recorded);
		expect([...fileOps.read].sort()).toEqual(["a.txt", "b.txt"]);
	});
});
