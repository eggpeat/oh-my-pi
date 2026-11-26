import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { generateBranchSummary, prepareBranchEntries } from "../src/compaction/branch-summarization";
import {
	type CompactionDetails,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
} from "../src/compaction/compaction";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/compaction/entries";
import { extractFileOpsFromMessage, indexToolResultDetails, stripReadSelector } from "../src/compaction/utils";
import { Tokenizer } from "../src/tokenizer";
import type { AgentMessage } from "../src/types";
import { createAssistantMessage } from "./helpers";

const MOCK_MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function mockSummaryComplete(): Promise<AssistantMessage> {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Summary body." }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function readCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "read", arguments: { path } };
}

function writeCall(id: string, path: string) {
	return { type: "toolCall" as const, id, name: "write", arguments: { path } };
}

/** Tool-result message recording `readTarget` as the `{ path, sel }` the read tool resolved. */
function readResult(id: string, readTarget: { path: string; sel?: string }): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		details: { readTarget },
		isError: false,
		timestamp: 0,
	};
}

function msgEntry(id: string, parentId: string | null, message: AgentMessage): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message };
}

describe("stripReadSelector", () => {
	it("strips line-range and raw selectors in every supported shape", () => {
		expect(stripReadSelector("src/foo.ts:50")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50-200")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:50+150")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:5-16,960-973")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:2724..2727")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:conflicts")).toBe("src/foo.ts");
		// Compound raw+range, either order.
		expect(stripReadSelector("src/foo.ts:100-170:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:2-4")).toBe("src/foo.ts");
		// Tail, mixed range+tail, per-chunk raw, colon-folded lists, and SVG :img.
		expect(stripReadSelector("src/foo.ts:-60")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:1-12,-15")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:-60:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:raw:-60")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:1-3:raw,9:raw")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:1-30,:-30")).toBe("src/foo.ts");
		expect(stripReadSelector("src/foo.ts:20:40,85:100")).toBe("src/foo.ts");
		expect(stripReadSelector("assets/logo.svg:img")).toBe("assets/logo.svg");
	});

	it("keeps archive member paths, stripping only the trailing selector", () => {
		expect(stripReadSelector("archive.zip:dir/file.ts:50-60")).toBe("archive.zip:dir/file.ts");
		expect(stripReadSelector("archive.zip:dir/file.ts")).toBe("archive.zip:dir/file.ts");
	});

	it("leaves non-selector colons untouched", () => {
		expect(stripReadSelector("db.sqlite:users")).toBe("db.sqlite:users");
		expect(stripReadSelector("local://ctx.md")).toBe("local://ctx.md");
		expect(stripReadSelector("https://example.com/page")).toBe("https://example.com/page");
		expect(stripReadSelector("src/foo.ts")).toBe("src/foo.ts");
	});
});

describe("extractFileOpsFromMessage", () => {
	it("dedupes the same file read through different selectors to one entry", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "docs/compaction.md:100-170:raw"),
			readCall("r2", "docs/compaction.md:8-16,128-139,384-388"),
			readCall("r3", "docs/compaction.md:raw"),
			readCall("r4", "docs/compaction.md"),
		]);
		extractFileOpsFromMessage(message, fileOps);
		expect([...fileOps.read]).toEqual(["docs/compaction.md"]);
	});

	it("matches selector-suffixed reads against modified paths", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/login.ts:30-80"),
			{ type: "toolCall" as const, id: "w1", name: "write", arguments: { path: "src/login.ts" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/login.ts"]);
	});

	it("dedupes tail and :img reads and merges RW status with writes", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/app.ts:-60"),
			readCall("r2", "src/app.ts:-60:raw"),
			readCall("r3", "assets/logo.svg:img"),
			writeCall("w1", "assets/logo.svg"),
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/app.ts"]);
		expect(modifiedFiles).toEqual(["assets/logo.svg"]);
		expect(snapcompact.upsertFileOperations("", readFiles, modifiedFiles, fileOps.read)).toContain("logo.svg (RW)");
	});

	it("skips internal URLs and web URLs so they never enter <files>", () => {
		const fileOps = snapcompact.createFileOps();
		const message = createAssistantMessage([
			readCall("r1", "src/keep.ts"),
			readCall("r3", "local://ctx.md"),
			readCall("r4", "https://example.com/page"),
			writeCall("w1", "conflict://1"),
			writeCall("w2", "conflict://*"),
			// Tolerated `<file>:conflict://N` prefix typo form the write tool accepts.
			writeCall("w3", "src/login.ts:conflict://3"),
			{ type: "toolCall" as const, id: "e1", name: "edit", arguments: { path: "agent://abc" } },
		]);
		extractFileOpsFromMessage(message, fileOps);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual(["src/keep.ts"]);
		expect(modifiedFiles).toEqual([]);
	});

	it("keeps a literal colon-named file, unfolded colon-list base, and shell-escaped file distinct from base reads", () => {
		const fileOps = snapcompact.createFileOps();
		const messages: AgentMessage[] = [
			createAssistantMessage([readCall("r1", "notes.txt:-5")]),
			readResult("r1", { path: "notes.txt:-5" }),
			createAssistantMessage([readCall("r2", "plain.txt:-5")]),
			readResult("r2", { path: "plain.txt", sel: "-5" }),
			createAssistantMessage([readCall("r3", "a:1-30,:-30")]),
			readResult("r3", { path: "a:1-30,", sel: "-30" }),
			createAssistantMessage([readCall("r4", "my\\ file.txt:-5")]),
			readResult("r4", { path: "my file.txt:-5" }),
			createAssistantMessage([
				readCall("r5", "notes.txt"),
				writeCall("w1", "notes.txt:-5"),
				writeCall("w2", "my file.txt:-5"),
			]),
			readResult("r5", { path: "notes.txt" }),
		];
		const resultDetails = indexToolResultDetails(messages);
		for (const message of messages) extractFileOpsFromMessage(message, fileOps, resultDetails);
		expect(fileOps.read.has("notes.txt:-5")).toBe(true);
		expect(fileOps.read.has("plain.txt:-5")).toBe(false);
		expect(fileOps.read.has("a:1-30,")).toBe(true);
		expect(fileOps.read.has("a")).toBe(false);
		expect(fileOps.read.has("my file.txt:-5")).toBe(true);
		const { readFiles, modifiedFiles } = snapcompact.computeFileLists(fileOps);
		expect(readFiles).toEqual(["a:1-30,", "notes.txt", "plain.txt"]);
		expect(modifiedFiles).toEqual(["my file.txt:-5", "notes.txt:-5"]);
		const formatted = snapcompact.upsertFileOperations("", readFiles, modifiedFiles, fileOps.read);
		expect(formatted).toContain("notes.txt:-5 (RW)");
		expect(formatted).toContain("my file.txt:-5 (RW)");
	});
});

describe("turn-scoped call pairing and successive summaries", () => {
	it("matches each read to its own turn's result in both compaction and branch summarization when turns share a call id", () => {
		const tokenizer = new Tokenizer();
		const pad = "word ".repeat(200);
		// Turn 1 reads literal `notes.txt:-5` under id `shared-call`; Turn 2 reuses
		// `shared-call` for a `:-5` tail read of `notes.txt`; Turn 0 had an
		// unanswered `shared-call` for `aborted.txt:-5` that must not steal Turn 1's result.
		const entries: SessionEntry[] = [
			msgEntry("u0", null, { role: "user", content: "turn 0", timestamp: 0 }),
			msgEntry("a0", "u0", createAssistantMessage([readCall("shared-call", "aborted.txt:-5")])),
			msgEntry("u1", "a0", { role: "user", content: "turn 1", timestamp: 1 }),
			msgEntry("a1", "u1", createAssistantMessage([readCall("shared-call", "notes.txt:-5")])),
			msgEntry("tr1", "a1", readResult("shared-call", { path: "notes.txt:-5" })),
			msgEntry("u2", "tr1", { role: "user", content: "turn 2", timestamp: 2 }),
			msgEntry("a2", "u2", createAssistantMessage([readCall("shared-call", "notes.txt:-5")])),
			msgEntry("tr2", "a2", readResult("shared-call", { path: "notes.txt", sel: "-5" })),
			msgEntry("u3", "tr2", { role: "user", content: pad, timestamp: 3 }),
			msgEntry("a3", "u3", createAssistantMessage([{ type: "text", text: pad }])),
		];

		const compactionPrep = prepareCompaction(
			entries,
			{ ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 100 },
			undefined,
			tokenizer,
		);
		expect(compactionPrep).toBeDefined();
		expect(snapcompact.computeFileLists(compactionPrep!.fileOps).readFiles).toEqual([
			"aborted.txt",
			"notes.txt",
			"notes.txt:-5",
		]);

		const branchPrep = prepareBranchEntries(entries, tokenizer);
		expect(snapcompact.computeFileLists(branchPrep.fileOps).readFiles).toEqual([
			"aborted.txt",
			"notes.txt",
			"notes.txt:-5",
		]);
	});

	it("preserves resolved colon-named files across two successive compactions while cleaning legacy lists", async () => {
		const tokenizer = new Tokenizer();
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 50 };
		const tailText = "recent context ".repeat(80);

		const legacyCompaction: CompactionEntry = {
			type: "compaction",
			id: "c0",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			summary: "Legacy summary.",
			firstKeptEntryId: "u1",
			tokensBefore: 1_000,
			details: { readFiles: ["legacy.txt:-5"], modifiedFiles: [] },
		};
		const firstEntries: SessionEntry[] = [
			legacyCompaction,
			msgEntry("u1", "c0", { role: "user", content: "inspect colon file", timestamp: 1 }),
			msgEntry("a1", "u1", createAssistantMessage([readCall("r1", "notes.txt:-5")])),
			msgEntry("tr1", "a1", readResult("r1", { path: "notes.txt:-5" })),
			msgEntry("u2", "tr1", { role: "user", content: tailText, timestamp: 2 }),
			msgEntry("a2", "u2", createAssistantMessage([{ type: "text", text: tailText }])),
		];

		const prep1 = prepareCompaction(firstEntries, settings, undefined, tokenizer)!;
		const res1 = await compact(prep1, MOCK_MODEL, () => undefined, undefined, undefined, {
			completeImpl: mockSummaryComplete,
			oneshotRetry: false,
		});
		const details1 = res1.details as CompactionDetails;
		expect(details1).toEqual({
			readFiles: ["legacy.txt", "notes.txt:-5"],
			modifiedFiles: [],
			readFilesResolved: true,
		});
		expect(res1.summary).toContain("notes.txt:-5 (Read)");

		const secondCompactionSeed: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "a2",
			timestamp: new Date(3).toISOString(),
			summary: res1.summary,
			firstKeptEntryId: res1.firstKeptEntryId,
			tokensBefore: res1.tokensBefore,
			details: details1,
		};
		const secondEntries: SessionEntry[] = [
			...firstEntries,
			secondCompactionSeed,
			msgEntry("u3", "c1", { role: "user", content: "read another file", timestamp: 4 }),
			msgEntry("a3", "u3", createAssistantMessage([readCall("r2", "second.txt:1-10")])),
			msgEntry("tr2", "a3", readResult("r2", { path: "second.txt", sel: "1-10" })),
			msgEntry("u4", "tr2", { role: "user", content: tailText, timestamp: 5 }),
			msgEntry("a4", "u4", createAssistantMessage([{ type: "text", text: tailText }])),
		];

		const prep2 = prepareCompaction(secondEntries, settings, undefined, tokenizer)!;
		const res2 = await compact(prep2, MOCK_MODEL, () => undefined, undefined, undefined, {
			completeImpl: mockSummaryComplete,
			oneshotRetry: false,
		});
		expect(res2.details).toEqual({
			readFiles: ["legacy.txt", "notes.txt:-5", "second.txt"],
			modifiedFiles: [],
			readFilesResolved: true,
		});
		expect(res2.summary).toContain("notes.txt:-5 (Read)");
	});

	it("preserves resolved colon-named files across two successive branch summaries while cleaning legacy lists", async () => {
		const legacyBranch: BranchSummaryEntry = {
			type: "branch_summary",
			id: "bs0",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			fromId: "leaf-0",
			summary: "Legacy branch.",
			details: { readFiles: ["legacy.txt:-5"], modifiedFiles: [] },
		};
		const firstEntries: SessionEntry[] = [
			legacyBranch,
			msgEntry("u1", "bs0", { role: "user", content: "inspect colon file", timestamp: 1 }),
			msgEntry("a1", "u1", createAssistantMessage([readCall("r1", "notes.txt:-5")])),
			msgEntry("tr1", "a1", readResult("r1", { path: "notes.txt:-5" })),
		];

		const res1 = await generateBranchSummary(firstEntries, {
			model: MOCK_MODEL,
			apiKey: () => undefined,
			signal: new AbortController().signal,
			completeImpl: mockSummaryComplete,
		});
		expect(res1.readFiles).toEqual(["legacy.txt", "notes.txt:-5"]);
		expect(res1.readFilesResolved).toBe(true);

		const savedBranch1: BranchSummaryEntry = {
			type: "branch_summary",
			id: "bs1",
			parentId: "tr1",
			timestamp: new Date(2).toISOString(),
			fromId: "leaf-1",
			summary: res1.summary!,
			details: {
				readFiles: res1.readFiles!,
				modifiedFiles: res1.modifiedFiles!,
				readFilesResolved: res1.readFilesResolved,
			},
		};
		const secondEntries: SessionEntry[] = [
			savedBranch1,
			msgEntry("u2", "bs1", { role: "user", content: "read another file", timestamp: 3 }),
			msgEntry("a2", "u2", createAssistantMessage([readCall("r2", "second.txt:-5")])),
			msgEntry("tr2", "a2", readResult("r2", { path: "second.txt", sel: "-5" })),
		];

		const res2 = await generateBranchSummary(secondEntries, {
			model: MOCK_MODEL,
			apiKey: () => undefined,
			signal: new AbortController().signal,
			completeImpl: mockSummaryComplete,
		});
		expect(res2.readFiles).toEqual(["legacy.txt", "notes.txt:-5", "second.txt"]);
		expect(res2.summary).toContain("notes.txt:-5 (Read)");
	});
});
