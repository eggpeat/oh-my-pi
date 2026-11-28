/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";
import { escapeHarmonyControlTokens } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { prompt, splitPathAndSel, stringifyJson } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import type { AgentMessage } from "../types";
import summarizationSystemPrompt from "./prompts/summarization-system.md" with { type: "text" };

/** @deprecated Import these from `@oh-my-pi/snapcompact`. */
export {
	computeFileLists,
	createFileOps,
	type FileOperations,
	isUrlSchemePath,
	upsertFileOperations,
} from "@oh-my-pi/snapcompact";

/** @deprecated Use `upsertFileOperations("", readFiles, modifiedFiles, readSet)` from `@oh-my-pi/snapcompact`. */
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	return snapcompact.upsertFileOperations("", readFiles, modifiedFiles, readSet);
}

/** Error text for a summarization call that hit its output limit (`stopReason: "length"`): partial text is never used. */
export function incompleteOutputError(prefix: string): string {
	return `${prefix}: model output ended incomplete (stopReason: length)`;
}

// Read-tool selector grammar is shared with the read tool's own splitter via
// `@oh-my-pi/pi-utils/read-selector`, so a tail (`:-60`), image (`:img`), or
// per-chunk-raw (`:1-3:raw,9:raw`) selector peels here exactly as it did at read
// time. Compaction never probes the filesystem: a real file named `notes.txt:-60`
// stays ambiguous to the splitter, which is why the read tool records its
// resolved target in `ReadToolDetails.readTarget` for these callers.

/**
 * The target a read result says it actually read — recorded by the read tool so
 * pruning keys and file lists can name the resolved file instead of re-parsing
 * the call's `path` argument (a literal `notes.txt:-60` file, a suffix-glob
 * match, an archive member, or a PDF page member all record here). `path` is
 * the resolved file as a display path (member specs included); `sel` is the
 * selector the read applied to it.
 */
export interface ResolvedReadTarget {
	/** Resolved file identity: display path plus member specs (archive member, PDF page). */
	path: string;
	/** Selector the read applied (`50-200`, `raw`, `img`, a video frame), absent for whole reads. */
	sel?: string;
	/** `range` supersede buckets under the base path; `alt` (raw/conflicts/img/other views) beside it. */
	kind?: "range" | "alt";
	/** `?q=` image question the read answered; part of the result's identity, not the file's. */
	question?: string;
}

/** Read `toolResult.details` only as much as this package needs (never typed across packages). */
function readResultDetails(result: ToolResultMessage | undefined): Record<string, unknown> | undefined {
	const details = result?.details;
	return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : undefined;
}

/** Whether a recorded read source is remote — a server resource or web page, not a local file. */
export function isRemoteReadResult(result: ToolResultMessage | undefined): boolean {
	const source = readResultDetails(result)?.meta;
	if (typeof source !== "object" || source === null) return false;
	const src = (source as Record<string, unknown>).source;
	if (typeof src !== "object" || src === null) return false;
	const type = (src as Record<string, unknown>).type;
	return type === "internal" || type === "url";
}

/**
 * Recover the file identity of one read call+result pair. Priority: the
 * read-recorded {@link ResolvedReadTarget}, then a recorded `suffixResolution`
 * recombined with the asked-for remainder (old sessions), then the `path`
 * argument split with the shared selector grammar.
 */
export function resolveReadTarget(argsPath: string, result: ToolResultMessage | undefined): ResolvedReadTarget {
	const details = readResultDetails(result);
	const recorded = details?.readTarget;
	if (typeof recorded === "object" && recorded !== null) {
		const target = recorded as Record<string, unknown>;
		if (typeof target.path === "string") {
			return {
				path: target.path,
				sel: typeof target.sel === "string" ? target.sel : undefined,
				kind: target.kind === "range" || target.kind === "alt" ? target.kind : undefined,
				question: typeof target.question === "string" ? target.question : undefined,
			};
		}
	}
	// A recorded unique-suffix redirect: rebuild the resolved path as `to` plus
	// whatever member/selector/query text followed `from` in the asked path.
	const resolution = details?.suffixResolution;
	if (typeof resolution === "object" && resolution !== null) {
		const { from, to } = resolution as Record<string, unknown>;
		if (typeof from === "string" && typeof to === "string" && argsPath.startsWith(from)) {
			const rest = argsPath.slice(from.length);
			const restSplit = splitReadSelector(`x${rest}`);
			const combined = restSplit.path === "x" ? to : `${to}${rest}`;
			const split = splitReadSelector(combined);
			return { path: split.path, sel: split.sel };
		}
	}
	// Old sessions recorded no target: a real file named `notes.txt:-60` shows up in
	// `meta.source` as that exact filename, so an unpeelable argument tail means
	// the whole recorded source — not the selector-split path — is the file.
	const argSplit = splitReadSelector(argsPath);
	if (argSplit.sel !== undefined) {
		const meta = details?.meta;
		if (typeof meta === "object" && meta !== null) {
			const source = (meta as Record<string, unknown>).source;
			if (typeof source === "object" && source !== null) {
				const { type, value } = source as Record<string, unknown>;
				if (type === "path" && typeof value === "string" && value.endsWith(`:${argSplit.sel}`)) {
					return { path: value };
				}
			}
		}
	}
	// The asked `?q=` question stayed on the argument path for unrecorded reads;
	// it is part of the answer's identity, not the file's.
	const queryIndex = argSplit.path.indexOf("?");
	if (queryIndex > 0 && argSplit.path.slice(queryIndex).startsWith("?q=")) {
		const question = argSplit.path.slice(queryIndex + 3);
		if (question) {
			return { path: argSplit.path.slice(0, queryIndex), sel: argSplit.sel, question };
		}
	}
	return argSplit;
}

/** Strip a read result's `?q=` image question off a recorded target path. */
function stripImageQuestion(path: string): string {
	const queryIndex = path.indexOf("?");
	return queryIndex > 0 && path.slice(queryIndex).startsWith("?q=") ? path.slice(0, queryIndex) : path;
}

/** Recorded per-part targets of a `;`/`,` list read, aligned entries only. */
function listReadTargets(result: ToolResultMessage | undefined): string[] | undefined {
	const targets = readResultDetails(result)?.displayReadTargets;
	return Array.isArray(targets) ? targets.filter((entry): entry is string => typeof entry === "string") : undefined;
}

/**
 * Split a read-tool path into its base path and trailing selector. Re-exports
 * the read tool's own splitter so file lists and supersede keys peel exactly
 * what the tool peeled: line ranges, tails, `raw`, `conflicts`, `img`, and
 * per-chunk-raw lists.
 */
export const splitReadSelector = splitPathAndSel;

/**
 * Strip a trailing read-tool selector (`:50-200`, `:raw`, `:-60`, `:img`,
 * `:1-50:raw`, `:conflicts`, …) so the same file read with different line
 * ranges dedupes to one `<files>` entry and matches its write/edit path when
 * computing Read/Write/RW markers.
 */
export function stripReadSelector(path: string): string {
	return splitReadSelector(path).path;
}

/**
 * Stateful pairing of read calls with their results so each recorded target is
 * attributed to the call that produced it — tool-call ids can repeat across a
 * summarized range (or within forked branches), and a result must claim only
 * its own call's slot. Backward iteration (branch summarization walks newest →
 * oldest) is handled by matching a call against the result LATEST-seen for its
 * id — the one nearest the call in message order.
 */
class FileOpsExtractor {
	readonly #fileOps: snapcompact.FileOperations;
	// Per tool-call id: read calls waiting for their result, in visit order.
	readonly #pendingCalls = new Map<string, Array<Record<string, unknown>>>();
	// Per tool-call id: read results waiting for their call, in visit order.
	readonly #pendingResults = new Map<string, ToolResultMessage[]>();

	constructor(fileOps: snapcompact.FileOperations) {
		this.#fileOps = fileOps;
	}

	add(message: AgentMessage): void {
		if (message.role === "assistant") {
			this.#addAssistant(message);
		} else if (message.role === "toolResult") {
			this.#addToolResult(message);
		}
	}

	#addAssistant(message: AgentMessage): void {
		if (!("content" in message) || !Array.isArray(message.content)) return;
		for (const block of message.content) {
			if (typeof block !== "object" || block === null) continue;
			if (!("type" in block) || block.type !== "toolCall") continue;
			if (!("arguments" in block) || !("name" in block) || !("id" in block)) continue;

			const args = block.arguments as Record<string, unknown> | undefined;
			if (!args) continue;
			const path = typeof args.path === "string" ? args.path : undefined;
			if (!path) continue;

			// Internal URIs (conflict://, local://, history://, …) and
			// web URLs are not re-groundable files — keep them out of `<files>`.
			if (snapcompact.isUrlSchemePath(path)) continue;

			switch (block.name) {
				case "read": {
					// A queued result wins its own call's slot; without one the call is
					// deferred until flush so a later message's result can claim it.
					const results = this.#pendingResults.get(block.id as string);
					if (results !== undefined && results.length > 0) {
						this.#recordRead(path, results.pop()!);
						if (results.length === 0) this.#pendingResults.delete(block.id as string);
					} else {
						const pending = this.#pendingCalls.get(block.id as string) ?? [];
						pending.push(args);
						this.#pendingCalls.set(block.id as string, pending);
					}
					break;
				}
				case "write":
					this.#fileOps.written.add(path);
					break;
				case "edit":
					this.#fileOps.edited.add(path);
					break;
			}
		}
	}

	#addToolResult(message: ToolResultMessage): void {
		if (message.toolName !== "read") return;
		const calls = this.#pendingCalls.get(message.toolCallId);
		if (calls !== undefined && calls.length > 0) {
			const args = calls.shift()!;
			if (calls.length === 0) this.#pendingCalls.delete(message.toolCallId);
			this.#recordRead(typeof args.path === "string" ? args.path : "", message);
		} else {
			const pending = this.#pendingResults.get(message.toolCallId) ?? [];
			pending.push(message);
			this.#pendingResults.set(message.toolCallId, pending);
		}
	}

	/** One read call/result pair: the recorded target wins; server resources and web pages never count. */
	#recordRead(argsPath: string, result: ToolResultMessage): void {
		if (isRemoteReadResult(result)) return;
		const parts = listReadTargets(result);
		if (parts !== undefined) {
			// A `;`/`,` list read names each part it actually read.
			for (const part of parts) {
				if (!snapcompact.isUrlSchemePath(part)) this.#fileOps.read.add(stripImageQuestion(part));
			}
			return;
		}
		const target = resolveReadTarget(argsPath, result);
		if (snapcompact.isUrlSchemePath(target.path)) return;
		this.#fileOps.read.add(stripImageQuestion(target.path));
	}

	/** Read calls that never got a paired result keep argument-derived tracking, as before. */
	flush(): void {
		for (const args of [...this.#pendingCalls.values()].flat()) {
			const path = typeof args.path === "string" ? args.path : "";
			if (path) this.#fileOps.read.add(stripImageQuestion(stripReadSelector(path)));
		}
		this.#pendingCalls.clear();
		// Results whose calls were never visited still report their recorded targets.
		for (const results of this.#pendingResults.values()) {
			for (const result of results) {
				if (isRemoteReadResult(result)) continue;
				const recorded = readResultDetails(result)?.readTarget;
				if (typeof recorded === "object" && recorded !== null) {
					const target = (recorded as Record<string, unknown>).path;
					if (typeof target === "string" && !snapcompact.isUrlSchemePath(target)) {
						this.#fileOps.read.add(stripImageQuestion(target));
					}
				}
			}
		}
		this.#pendingResults.clear();
	}
}

/**
 * Extract file operations from tool calls (and the results pairing their read
 * targets) across messages. Message order does not matter: every call is
 * matched with the result nearest to it in the visited sequence.
 */
export function extractFileOpsFromMessages(
	messages: Iterable<AgentMessage>,
	fileOps: snapcompact.FileOperations,
): void {
	const extractor = new FileOpsExtractor(fileOps);
	for (const message of messages) extractor.add(message);
	extractor.flush();
}

/** Extract file operations from tool calls in a single message. */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: snapcompact.FileOperations): void {
	extractFileOpsFromMessages([message], fileOps);
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate tool results to the same representation used in summarization prompts.
 */
export function truncateToolResultForSummary(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	const truncatedChars = text.length - TOOL_RESULT_MAX_CHARS;
	return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${truncatedChars} more characters truncated]`;
}

const SUMMARY_BOUNDARY_TAG_RE = /<\s*\/?\s*(?:conversation|previous-summary)\s*>/gi;

/** Keep untrusted summary input from closing or impersonating harness-owned boundaries. */
export function escapeSummaryBoundaryTags(text: string): string {
	return text.replace(SUMMARY_BOUNDARY_TAG_RE, tag => `&lt;${tag.slice(1)}`);
}

/**
 * Serialize LLM messages as plain summary input without provider control tokens.
 * `dropThinking` is the summarizer's resolved `classifier-cot-extraction` policy.
 */
export function serializeConversationForSummary(messages: Message[], dialect?: Dialect, dropThinking = false): string {
	const conversation = serializeConversation(messages, dialect, dropThinking);
	const escaped = dialect === "harmony" ? escapeHarmonyControlTokens(conversation) : conversation;
	return escapeSummaryBoundaryTags(escaped);
}

/**
 * Serialize LLM messages to transcript text.
 * Call convertToLlm() first to handle custom message types.
 * `dropThinking` omits assistant reasoning from dialect transcripts: set it from
 * the reader's resolved `classifier-cot-extraction` catalog policy (Claude's
 * classifier refuses inputs that reproduce the model's own reasoning as text,
 * "reasoning_extraction"). Reasoning is ephemeral and low-signal for a summary.
 */
export function serializeConversation(messages: Message[], dialect?: Dialect, dropThinking = false): string {
	// Tool results flagged contextually useless (and their paired calls) are
	// dropped from the serialized text: the source region is discarded after
	// summarization anyway, so excluding them costs nothing and keeps garbage
	// out of the summary input.
	const uselessCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.useless === true && msg.isError !== true) {
			uselessCallIds.add(msg.toolCallId);
		}
	}
	if (dialect) {
		const processed: Message[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content.filter(
					block =>
						(block.type !== "toolCall" || !uselessCallIds.has(block.id)) &&
						(!dropThinking || block.type !== "thinking"),
				);
				if (content.length > 0) processed.push(content.length === msg.content.length ? msg : { ...msg, content });
				continue;
			}
			if (msg.role === "toolResult") {
				if (uselessCallIds.has(msg.toolCallId)) continue;
				const text = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("");
				if (!text) continue;
				processed.push({
					...msg,
					content: [{ type: "text", text: truncateToolResultForSummary(text) }],
				});
				continue;
			}
			processed.push(msg);
		}
		return getDialectDefinition(dialect).renderTranscript(processed);
	}

	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: ToolCall[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					if (uselessCallIds.has(block.id)) continue;
					toolCalls.push(block);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Think]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Tool Call]: ${renderToolCalls(toolCalls)}`);
			}
		} else if (msg.role === "toolResult") {
			if (uselessCallIds.has(msg.toolCallId)) continue;
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			if (content) {
				const text = truncateToolResultForSummary(content);
				parts.push(`[Tool Result]: ${text}`);
			}
		}
	}

	return parts.join("\n\n");
}

/**
 * Render an assistant turn's tool calls as a compact `name(args)` list for the
 * legacy serializer.
 */
function renderToolCalls(calls: ToolCall[]): string {
	return calls
		.map(call => {
			const argsStr = Object.entries(call.arguments as Record<string, unknown>)
				.map(([k, v]) => `${k}=${stringifyJson(v) ?? "null"}`)
				.join(", ");
			return `${call.name}(${argsStr})`;
		})
		.join("; ");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(summarizationSystemPrompt);
