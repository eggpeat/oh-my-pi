import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentToolResult, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	pruneSupersededToolResults,
	readToolSupersedeKey,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { extractFileOpsFromMessage, indexRecordedReadPaths } from "@oh-my-pi/pi-agent-core/compaction/utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { isCompleteReadResult } from "@oh-my-pi/pi-coding-agent/tools/read-supersede";
import type { ReadToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// Real `ReadTool` results through the supersede pass with `isCompleteReadResult`,
// so each completeness signal it relies on is exercised end to end.

// 40 functions with 6-line bodies: far above the summary thresholds pinned below.
const codeFile = Array.from({ length: 40 }, (_, i) => {
	const body = Array.from({ length: 6 }, (_, j) => `\tconst v${j} = value + ${i * 10 + j};`).join("\n");
	return `export function step${i}(value: number): number {\n${body}\n\treturn v5 * 2;\n}`;
}).join("\n\n");

let cwd: string;
let reader: ReadTool;

beforeAll(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-supersede-prune-"));
	await Bun.write(path.join(cwd, "code.ts"), `${codeFile}\n`);
	await Bun.write(path.join(cwd, "notes.txt"), Array.from({ length: 20 }, (_, i) => `note ${i + 1}`).join("\n"));
	await Bun.write(path.join(cwd, "long.txt"), Array.from({ length: 1_000 }, (_, i) => `row ${i + 1}`).join("\n"));
	await Bun.write(path.join(cwd, "wide.txt"), ["short", "x".repeat(5_000), "short"].join("\n"));
	await Bun.write(
		path.join(cwd, "huge.log"),
		Array.from({ length: 200_000 }, (_, i) => `log line ${i + 1} ${"z".repeat(20)}`).join("\n"),
	);
	// A macOS `sample` report: a bare read shows a generated summary, a range reads the file.
	await Bun.write(
		path.join(cwd, "demo.sample.txt"),
		[
			"Analysis of sampling demo (pid 42) every 1 millisecond",
			"Process:         demo [42]",
			"----",
			"",
			"Call graph:",
			"    100 Thread_1: main",
			"    + 100 start  (in dyld) + 8  [0x100]",
			"    +   100 run  (in demo) + 24  [0x200]",
			"    +     70 layout  (in demo) + 8  [0x300]",
			"    +     30 alloc  (in demo) + 8  [0x500]",
			"",
			"Binary Images:",
			"",
		].join("\n"),
	);
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"lsp.enabled": false,
			"read.summarize.enabled": true,
			"read.summarize.minBodyLines": 4,
			"read.summarize.minTotalLines": 100,
			"read.summarize.unfoldUntil": 0,
			"read.summarize.unfoldLimit": 0,
		}),
	};
	reader = new ReadTool(session);
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

function readEntries(id: string, readPath: string, result: AgentToolResult<ReadToolDetails>): SessionEntry[] {
	const timestamp = Date.now();
	return [
		{
			type: "message",
			id: `${id}-call`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id, name: "read", arguments: { path: readPath } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp,
			},
		},
		{
			type: "message",
			id: `${id}-result`,
			parentId: null,
			timestamp: new Date(timestamp).toISOString(),
			message: {
				role: "toolResult",
				toolCallId: id,
				toolName: "read",
				content: result.content,
				details: result.details,
				isError: false,
				timestamp,
			},
		},
	];
}

describe("real read results through the supersede pass", () => {
	test.each([
		{
			name: "a code summary keeps an earlier range",
			older: "code.ts:10-40",
			newer: "code.ts",
			pruned: 0,
			summary: true,
		},
		{ name: "a complete bare read replaces an earlier range", older: "notes.txt:2-5", newer: "notes.txt", pruned: 1 },
		{
			name: "a profile summary keeps an earlier range of the report",
			older: "demo.sample.txt:6-8",
			newer: "demo.sample.txt",
			pruned: 0,
		},
		{
			name: "a line-limited bare page keeps an earlier range",
			older: "long.txt:900-950",
			newer: "long.txt",
			pruned: 0,
		},
		{
			name: "a column-limited bare read keeps an earlier range",
			older: "wide.txt:1-3",
			newer: "wide.txt",
			pruned: 0,
		},
		{
			name: "an unscanned bare page keeps an earlier range",
			older: "huge.log:150000-150010",
			newer: "huge.log",
			pruned: 0,
		},
	])("$name", async ({ older, newer, pruned, summary }) => {
		const olderResult = await reader.execute("older", { path: older });
		const newerResult = await reader.execute("newer", { path: newer });
		if (summary) expect(newerResult.details?.summary).toBeDefined();
		const entries = [...readEntries("older", older, olderResult), ...readEntries("newer", newer, newerResult)];

		const result = pruneSupersededToolResults(entries, new Tokenizer(), {
			supersedeKey: readToolSupersedeKey,
			supersedeComplete: isCompleteReadResult,
			protectedTools: [],
			now: Date.now(),
		});

		expect(result.prunedCount).toBe(pruned);
	});
});

describe("literal colon filename beside the file it looks like a selector of", () => {
	test.skipIf(process.platform === "win32")(
		"a full read of notes.txt does not erase the result of reading the real file notes.txt:-60",
		async () => {
			const literalName = "notes.txt:-60";
			const literalText = "contents of the colon file\n";
			await Bun.write(path.join(cwd, literalName), literalText);
			try {
				const literal = await reader.execute("literal", { path: literalName });
				const plain = await reader.execute("plain", { path: "notes.txt" });
				expect(literal.details?.readTarget).toEqual({ path: literalName });
				expect(plain.details?.readTarget).toEqual({ path: "notes.txt" });
				expect(
					literal.content.some(block => block.type === "text" && block.text.includes(literalText.trim())),
				).toBe(true);

				const entries = [
					...readEntries("literal", literalName, literal),
					...readEntries("plain", "notes.txt", plain),
				];
				const pruned = pruneSupersededToolResults(entries, new Tokenizer(), {
					supersedeKey: readToolSupersedeKey,
					supersedeComplete: isCompleteReadResult,
					protectedTools: [],
					now: Date.now(),
				});
				expect(pruned.prunedCount).toBe(0);
				const literalResult = entries[1];
				if (literalResult.type !== "message" || literalResult.message.role !== "toolResult") {
					throw new Error("expected a tool result");
				}
				expect(
					literalResult.message.content.some(block => block.type === "text" && block.text.includes("colon file")),
				).toBe(true);

				const messages = entries.flatMap(entry => (entry.type === "message" ? [entry.message] : []));
				const fileOps = snapcompact.createFileOps();
				const recorded = indexRecordedReadPaths(messages);
				for (const message of messages) extractFileOpsFromMessage(message, fileOps, recorded);
				expect([...fileOps.read].sort()).toEqual(["notes.txt", literalName]);
			} finally {
				await fs.rm(path.join(cwd, literalName), { force: true });
			}
		},
	);

	test("a tail read of a file that has no literal colon sibling is still superseded by a full read", async () => {
		const older = await reader.execute("tail", { path: "notes.txt:-5" });
		const newer = await reader.execute("whole", { path: "notes.txt" });
		expect(older.details?.readTarget).toEqual({ path: "notes.txt", sel: "-5" });
		const entries = [...readEntries("tail", "notes.txt:-5", older), ...readEntries("whole", "notes.txt", newer)];
		const pruned = pruneSupersededToolResults(entries, new Tokenizer(), {
			supersedeKey: readToolSupersedeKey,
			supersedeComplete: isCompleteReadResult,
			protectedTools: [],
			now: Date.now(),
		});
		expect(pruned.prunedCount).toBe(1);
	});
});
