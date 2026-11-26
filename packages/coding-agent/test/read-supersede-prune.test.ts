import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentToolResult, Tokenizer } from "@oh-my-pi/pi-agent-core";
import {
	type CompactionDetails,
	type CompactionEntry,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	pruneSupersededToolResults,
	readToolSupersedeKey,
	type SessionEntry,
} from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
	// Both a base file and literal files whose names end in or contain selector syntax.
	await Bun.write(path.join(cwd, "notes2.txt"), "alpha\nbeta\ngamma\n");
	await Bun.write(path.join(cwd, "notes2.txt:-5"), "literal colon file\n");
	await Bun.write(path.join(cwd, "a"), "plain base a\n");
	await Bun.write(
		path.join(cwd, "a:1-30,"),
		Array.from({ length: 40 }, (_, i) => `colon-comma line ${i + 1}`).join("\n"),
	);
	await Bun.write(path.join(cwd, "my file.txt"), "spaced base\n");
	await Bun.write(path.join(cwd, "my file.txt:-5"), "spaced literal colon\n");
	await Bun.write(path.join(cwd, "spaced only.txt"), Array.from({ length: 15 }, (_, i) => `s ${i + 1}`).join("\n"));
	await Bun.write(
		path.join(cwd, "logo.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>\n',
	);
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
		{ name: "a complete bare read replaces an earlier tail", older: "notes.txt:-5", newer: "notes.txt", pruned: 1 },
		{
			name: "a complete bare SVG text read keeps an earlier rasterized :img read",
			older: "logo.svg:img",
			newer: "logo.svg",
			pruned: 0,
		},
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
		{
			name: "a complete bare read keeps a literal colon-named file read",
			older: "notes2.txt:-5",
			newer: "notes2.txt",
			pruned: 0,
		},
		{
			name: "a repeat literal read of a colon-named file supersedes the earlier one",
			older: "notes2.txt:-5",
			newer: "notes2.txt:-5",
			pruned: 1,
		},
		{
			name: "a full read of `a` keeps an earlier tail read of existing `a:1-30,`",
			older: "a:1-30,:-30",
			newer: "a",
			pruned: 0,
		},
		{
			name: "a full read of `a:1-30,` replaces an earlier tail read of `a:1-30,`",
			older: "a:1-30,:-30",
			newer: "a:1-30,",
			pruned: 1,
		},
		{
			name: "a full read of `my file.txt` keeps a shell-escaped literal `my\\ file.txt:-5` read",
			older: "my\\ file.txt:-5",
			newer: "my file.txt",
			pruned: 0,
		},
		{
			name: "an unescaped `my file.txt:-5` read supersedes an earlier shell-escaped read of the same file",
			older: "my\\ file.txt:-5",
			newer: "my file.txt:-5",
			pruned: 1,
		},
		{
			name: "a full read of `spaced only.txt` supersedes a shell-escaped tail read of that file",
			older: "spaced\\ only.txt:-5",
			newer: "spaced only.txt",
			pruned: 1,
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

	test("real ReadTool targets survive two successive compactions even when turns reuse a call id", async () => {
		const tokenizer = new Tokenizer();
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 50 };
		const model = buildModel({
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
		const completeImpl = async () => ({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Compacted." }],
			api: "mock" as const,
			provider: "mock" as const,
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 1,
		});
		const tail = "padding ".repeat(80);

		const litColon = await reader.execute("reused", { path: "notes2.txt:-5" });
		const unfoldedTail = await reader.execute("u-tail", { path: "a:1-30,:-30" });
		const escapedLit = await reader.execute("esc", { path: "my\\ file.txt:-5" });
		const selectorTail = await reader.execute("reused", { path: "notes.txt:-5" });

		const [litCall, litRes] = readEntries("reused", "notes2.txt:-5", litColon);
		litCall.id = "e1";
		litRes.id = "e2";
		const [unfoldCall, unfoldRes] = readEntries("u-tail", "a:1-30,:-30", unfoldedTail);
		unfoldCall.id = "e3";
		unfoldRes.id = "e4";
		const [escCall, escRes] = readEntries("esc", "my\\ file.txt:-5", escapedLit);
		escCall.id = "e5";
		escRes.id = "e6";
		const [selCall, selRes] = readEntries("reused", "notes.txt:-5", selectorTail);
		selCall.id = "e8";
		selRes.id = "e9";

		const entries1: SessionEntry[] = [
			litCall,
			litRes,
			unfoldCall,
			unfoldRes,
			escCall,
			escRes,
			{
				type: "message",
				id: "e7",
				parentId: "e6",
				timestamp: "1970-01-01T00:00:01.000Z",
				message: { role: "user", content: "next turn", timestamp: 1 },
			},
			selCall,
			selRes,
			{
				type: "message",
				id: "e10",
				parentId: "e9",
				timestamp: "1970-01-01T00:00:02.000Z",
				message: { role: "user", content: tail, timestamp: 2 },
			},
		];

		const prep1 = prepareCompaction(entries1, settings, undefined, tokenizer)!;
		const res1 = await compact(prep1, model, () => undefined, undefined, undefined, {
			completeImpl,
			oneshotRetry: false,
		});
		expect((res1.details as CompactionDetails).readFiles).toEqual([
			"a:1-30,",
			"my file.txt:-5",
			"notes.txt",
			"notes2.txt:-5",
		]);

		const compaction1: CompactionEntry = {
			type: "compaction",
			id: "c1",
			parentId: "e10",
			timestamp: "1970-01-01T00:00:03.000Z",
			summary: res1.summary,
			firstKeptEntryId: res1.firstKeptEntryId,
			tokensBefore: res1.tokensBefore,
			details: res1.details,
		};
		const nextRead = await reader.execute("reused", { path: "notes2.txt" });
		const [nextCall, nextRes] = readEntries("reused", "notes2.txt", nextRead);
		nextCall.id = "e11";
		nextRes.id = "e12";
		const entries2: SessionEntry[] = [
			...entries1,
			compaction1,
			nextCall,
			nextRes,
			{
				type: "message",
				id: "e13",
				parentId: "e12",
				timestamp: "1970-01-01T00:00:04.000Z",
				message: { role: "user", content: tail, timestamp: 4 },
			},
		];

		const prep2 = prepareCompaction(entries2, settings, undefined, tokenizer)!;
		const res2 = await compact(prep2, model, () => undefined, undefined, undefined, {
			completeImpl,
			oneshotRetry: false,
		});
		expect((res2.details as CompactionDetails).readFiles).toEqual([
			"a:1-30,",
			"my file.txt:-5",
			"notes.txt",
			"notes2.txt",
			"notes2.txt:-5",
		]);
	});
});
