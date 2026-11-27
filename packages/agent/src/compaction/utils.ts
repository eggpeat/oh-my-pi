/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message, ToolCall } from "@oh-my-pi/pi-ai";
import { type Dialect, getDialectDefinition } from "@oh-my-pi/pi-ai/dialect";
import { escapeHarmonyControlTokens } from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { prompt, stringifyJson } from "@oh-my-pi/pi-utils";
import { splitPathAndSel } from "@oh-my-pi/pi-utils/read-selector";
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

/**
 * Strip a trailing read-tool selector (`:50-200`, `:-60`, `:img`, `:raw`,
 * `:1-50:raw`, `:conflicts`, …) so the same file read with different selectors
 * dedupes to one `<files>` entry and matches its write/edit path when computing
 * Read/Write/RW markers.
 */
export function stripReadSelector(path: string): string {
	return splitPathAndSel(path).path;
}

/** Path a read result says it opened — `null` when a resource server (not a file) answered. */
export function recordedReadPath(message: AgentMessage): { toolCallId: string; path: string | null } | undefined {
	if (message.role !== "toolResult" || message.toolName !== "read") return undefined;
	const details = message.details;
	if (!details || typeof details !== "object") return undefined;
	const target = (details as { readTarget?: unknown }).readTarget;
	if (target && typeof target === "object") {
		const t = target as { path?: unknown; external?: unknown };
		if (t.external === true) return { toolCallId: message.toolCallId, path: null };
		if (typeof t.path === "string" && t.path.length > 0) return { toolCallId: message.toolCallId, path: t.path };
	}
	// Results written before `readTarget` recorded the opened file as `resolvedPath`.
	const resolved = (details as { resolvedPath?: unknown }).resolvedPath;
	if (typeof resolved === "string" && resolved.length > 0 && !resolved.includes("://")) {
		return { toolCallId: message.toolCallId, path: resolved };
	}
	return undefined;
}

/**
 * Map each read call block to the path its result recorded, pairing the k-th
 * result for a tool call id with the k-th call in message order, so ids reused
 * across prompts keep their own paths. `null` marks a served resource (no file
 * produced it); an absent entry means the result recorded nothing.
 */
export function indexRecordedReadPaths(messages: Iterable<AgentMessage>): ReadonlyMap<object, string | null> {
	const callsById = new Map<string, object[]>();
	const resultsById = new Map<string, Array<string | null>>();
	for (const message of messages) {
		if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (typeof block !== "object" || block === null) continue;
				if (!("type" in block) || block.type !== "toolCall" || !("name" in block)) continue;
				if (block.name !== "read") continue;
				const id = (block as { id?: unknown }).id;
				if (typeof id !== "string" || id.length === 0) continue;
				const list = callsById.get(id) ?? [];
				if (list.length === 0) callsById.set(id, list);
				list.push(block);
			}
			continue;
		}
		const hit = recordedReadPath(message);
		if (!hit) continue;
		const list = resultsById.get(hit.toolCallId) ?? [];
		if (list.length === 0) resultsById.set(hit.toolCallId, list);
		list.push(hit.path);
	}
	const recorded = new Map<object, string | null>();
	for (const [id, calls] of callsById) {
		const results = resultsById.get(id);
		if (!results) continue;
		for (let i = 0; i < Math.min(calls.length, results.length); i++) {
			recorded.set(calls[i], results[i]);
		}
	}
	return recorded;
}

/**
 * Add paths from a prior compaction or branch summary. `resolved` means they
 * are already the paths reads opened (including literal colon filenames) and
 * must not be split again. Older entries omit the flag; their selector tails
 * are still stripped so lists written before that choice self-heal.
 */
export function addPriorReadFiles(
	fileOps: snapcompact.FileOperations,
	readFiles: readonly string[] | undefined,
	resolved: boolean | undefined,
): void {
	if (!readFiles) return;
	for (const file of readFiles) fileOps.read.add(resolved ? file : stripReadSelector(file));
}

/**
 * Extract file operations from tool calls in an assistant message.
 * `recordedReads` maps each read call block to the path its result recorded
 * (`null` for a served resource, which adds nothing to the list).
 */
export function extractFileOpsFromMessage(
	message: AgentMessage,
	fileOps: snapcompact.FileOperations,
	recordedReads?: ReadonlyMap<object, string | null>,
): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		// Internal URIs (conflict://, local://, history://, …) and
		// web URLs are not re-groundable files — keep them out of `<files>`.
		if (snapcompact.isUrlSchemePath(path)) continue;

		switch (block.name) {
			case "read": {
				const recorded = recordedReads?.get(block);
				if (recorded === null) break;
				fileOps.read.add(recorded ?? stripReadSelector(path));
				break;
			}
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
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
