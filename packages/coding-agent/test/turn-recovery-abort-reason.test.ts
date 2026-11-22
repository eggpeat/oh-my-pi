import { afterEach, describe, expect, it } from "bun:test";
import type { AgentMessage, SyntheticToolResultDetails } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model, ToolResultMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as BedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

afterEach(() => setBedrockProviderModule(BedrockProvider));

function createModel(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createPartialMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: "mock-bedrock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createRecovery(messages: readonly AgentMessage[] = []): TurnRecovery {
	return new TurnRecovery(
		{
			abortInProgress: () => false,
			isDisposed: () => false,
			streamingEditAbortTriggered: () => false,
			model: () => undefined,
			agent: { state: { messages } },
		} as unknown as TurnRecoveryHost,
		{ deferFallbackChainValidation: true },
	);
}

async function abortBedrockAfterStart(abort: (controller: AbortController) => void): Promise<AssistantMessage> {
	const abortController = new AbortController();
	const partialMessage = createPartialMessage();
	let providerSignal: AbortSignal | undefined;
	const source = {
		async *[Symbol.asyncIterator]() {
			yield { type: "start", partial: partialMessage } as const;
			const { promise, reject } = Promise.withResolvers<never>();
			if (providerSignal?.aborted) {
				reject(new Error("Request was aborted"));
			}
			providerSignal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
				once: true,
			});
			await promise;
		},
	} as unknown as AssistantMessageEventStream;

	setBedrockProviderModule({
		streamBedrock: (_model, _context, options) => {
			providerSignal = options.signal;
			return source;
		},
	});

	const context: Context = { messages: [] };
	const stream = streamBedrock(createModel(), context, {
		signal: abortController.signal,
		streamIdleTimeoutMs: 60_000,
		streamFirstEventTimeoutMs: 60_000,
	});
	const firstEvent = await stream[Symbol.asyncIterator]().next();
	expect(firstEvent.value?.type).toBe("start");
	abort(abortController);
	return stream.result();
}

describe("TurnRecovery abort-reason and specific-flag handling", () => {
	it("retries bare caller aborts and skips labelled aborts including labelled AbortErrors", async () => {
		const bare = await abortBedrockAfterStart(controller => controller.abort());
		expect(createRecovery().isRetryableReasonlessAbort(bare)).toBe(true);
		expect(AIError.is(bare.errorId, AIError.Flag.Abort)).toBe(true);

		const labelledCases: Array<[() => unknown, string]> = [
			[() => "Interrupted by user", "Interrupted by user"],
			[() => new DOMException("Aborted", "AbortError"), "Aborted"],
			[() => new DOMException("Interrupted by user", "AbortError"), "Interrupted by user"],
			[() => new AIError.AbortError("Interrupted by user"), "Interrupted by user"],
			[() => "Request was aborted", "Request was aborted"],
		];
		for (const [makeReason, expectedMessage] of labelledCases) {
			const result = await abortBedrockAfterStart(controller => controller.abort(makeReason()));
			expect(result.errorMessage).toBe(expectedMessage);
			expect(createRecovery().isRetryableReasonlessAbort(result)).toBe(false);
		}
	});

	it("preserves Timeout and skips reasonless retry even when a StreamTimeoutError has generic abort text", async () => {
		const timeoutReasons = [
			new AIError.StreamTimeoutError("budget spent"),
			new AIError.StreamTimeoutError(""),
			new AIError.StreamTimeoutError("Request was aborted"),
		];
		for (const reason of timeoutReasons) {
			const result = await abortBedrockAfterStart(controller => controller.abort(reason));
			expect(createRecovery().isRetryableReasonlessAbort(result)).toBe(false);
			expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
			expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
			expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
		}
	});

	it("does not replace Timeout with Abort or classify resolved tool turns as reasonless aborts", () => {
		const toolCallBlock: AssistantMessage["content"][number] = {
			type: "toolCall",
			id: "call_1",
			name: "bash",
			arguments: { command: "pwd" },
		};
		const syntheticResult: ToolResultMessage<SyntheticToolResultDetails> = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "Tool call was not executed." }],
			isError: true,
			details: { __synthetic: true, source: "assistant_stop_error", executed: false },
			timestamp: Date.now(),
		};

		const timeoutWithGenericText: AssistantMessage = {
			...createPartialMessage(),
			content: [toolCallBlock],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			errorId: AIError.create(AIError.Flag.Transient, AIError.Flag.Timeout),
		};
		expect(
			createRecovery([timeoutWithGenericText, syntheticResult]).classifyResolvedInterruptedToolTurn(
				timeoutWithGenericText,
			),
		).toBeUndefined();
		expect(AIError.is(timeoutWithGenericText.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(timeoutWithGenericText.errorId, AIError.Flag.Abort)).toBe(false);

		const labelledAbortError: AssistantMessage = {
			...createPartialMessage(),
			content: [toolCallBlock],
			stopReason: "aborted",
			errorMessage: "Interrupted by user",
			errorId: AIError.create(AIError.Flag.Abort),
		};
		expect(
			createRecovery([labelledAbortError, syntheticResult]).classifyResolvedInterruptedToolTurn(labelledAbortError),
		).toBeUndefined();

		const reasonlessGeneric: AssistantMessage = {
			...createPartialMessage(),
			content: [toolCallBlock],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		};
		expect(
			createRecovery([reasonlessGeneric, syntheticResult]).classifyResolvedInterruptedToolTurn(reasonlessGeneric),
		).toBe("reasonless-abort");
		expect(AIError.is(reasonlessGeneric.errorId, AIError.Flag.Abort)).toBe(true);
	});

	it("keeps status 404 and explicit caller intent across both retry checks without overwriting status", async () => {
		const toolCallBlock: AssistantMessage["content"][number] = {
			type: "toolCall",
			id: "call_1",
			name: "bash",
			arguments: { command: "pwd" },
		};
		const syntheticResult: ToolResultMessage<SyntheticToolResultDetails> = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "Tool call was not executed." }],
			isError: true,
			details: { __synthetic: true, source: "assistant_stop_error", executed: false },
			timestamp: Date.now(),
		};

		const statusStreamResult = await abortBedrockAfterStart(controller =>
			controller.abort(Object.assign(new Error("Request was aborted"), { status: 404 })),
		);
		expect(createRecovery().isRetryableReasonlessAbort(statusStreamResult)).toBe(false);
		expect(statusStreamResult.errorId).toBe(404);
		expect(statusStreamResult.errorStatus).toBe(404);

		const statusIdOnlyEmpty: AssistantMessage = {
			...createPartialMessage(),
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			errorId: 404,
		};
		expect(createRecovery().isRetryableReasonlessAbort(statusIdOnlyEmpty)).toBe(false);
		expect(statusIdOnlyEmpty.errorId).toBe(404);

		const statusToolTurn: AssistantMessage = {
			...createPartialMessage(),
			content: [toolCallBlock],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			errorId: 404,
		};
		expect(
			createRecovery([statusToolTurn, syntheticResult]).classifyResolvedInterruptedToolTurn(statusToolTurn),
		).toBeUndefined();
		expect(statusToolTurn.errorId).toBe(404);

		const explicitSentinelStreamResult = await abortBedrockAfterStart(controller =>
			controller.abort("Request was aborted"),
		);
		expect(createRecovery().isRetryableReasonlessAbort(explicitSentinelStreamResult)).toBe(false);
		expect(AIError.is(explicitSentinelStreamResult.errorId, AIError.Flag.CallerAbort)).toBe(true);
		expect(AIError.is(explicitSentinelStreamResult.errorId, AIError.Flag.Abort)).toBe(false);

		const explicitSentinelToolTurn: AssistantMessage = {
			...explicitSentinelStreamResult,
			content: [toolCallBlock],
		};
		expect(
			createRecovery([explicitSentinelToolTurn, syntheticResult]).classifyResolvedInterruptedToolTurn(
				explicitSentinelToolTurn,
			),
		).toBeUndefined();
		expect(AIError.is(explicitSentinelToolTurn.errorId, AIError.Flag.CallerAbort)).toBe(true);
		expect(AIError.is(explicitSentinelToolTurn.errorId, AIError.Flag.Abort)).toBe(false);
	});
});
