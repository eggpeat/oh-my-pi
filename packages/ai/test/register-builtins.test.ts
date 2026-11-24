import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as BedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// The transport override is process-global: put the built-in back so later files stream for real.
afterEach(() => setBedrockProviderModule(BedrockProvider));

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

function createModel(
	overrides: { reasoning?: boolean; compat?: { streamIdleTimeoutMs?: number } } = {},
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "mock-bedrock",
		name: "Mock Bedrock",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://example.invalid",
		reasoning: overrides.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
		compat: overrides.compat,
	});
}

function createAssistantMessage(
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: errorMessage ? `error: ${errorMessage}` : "ok" }],
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
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

const baseContext: Context = { messages: [] };

/**
 * Drive a forwarded Bedrock stream to its first event, abort the caller signal,
 * and return the terminal message. Mirrors a user pressing Esc mid-stream while
 * the lazy watchdog wrapper owns the iterator.
 */
async function abortForwardedStreamAfterStart(reason?: string | Error): Promise<AssistantMessage> {
	const abortController = new AbortController();
	const partialMessage = createAssistantMessage("stop");
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

	const stream = streamBedrock(createModel(), baseContext, {
		signal: abortController.signal,
		streamIdleTimeoutMs: 500,
	});
	const iterator = stream[Symbol.asyncIterator]();
	const firstEvent = await iterator.next();
	expect(firstEvent.value?.type).toBe("start");

	if (reason === undefined) {
		abortController.abort();
	} else {
		abortController.abort(reason);
	}
	const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);
	if (result === "timeout") throw new Error("Timed out waiting for forwarded caller abort result");
	return result;
}

describe("register-builtins lazy streams", () => {
	it("resolves the outer stream result from source.result() when no terminal event is iterated", async () => {
		const finalMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
			result: async () => finalMessage,
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream result");
		}
		expect(result).toEqual(finalMessage);
	});

	it("turns iterator failures into terminal error results", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				throw new Error("bedrock exploded");
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {});
		const result = await Promise.race([stream.result(), Bun.sleep(100).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded error result");
		}
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("bedrock exploded");
	});

	it("turns idle lazy provider streams into retryable terminal errors", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
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

		const stream = streamBedrock(createModel(), baseContext, { streamIdleTimeoutMs: 10 });
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
		// The watchdog's StreamTimeoutError classification must survive onto the
		// message so session-level auto-retry can classify it structurally.
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.retriable(result.errorId)).toBe(true);
	});

	it("honors model.compat.streamIdleTimeoutMs as the lazy watchdog fallback", async () => {
		const partialMessage = createAssistantMessage("stop");
		let providerSignal: AbortSignal | undefined;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
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

		// No per-call option: the catalog compat override must reach the lazy
		// watchdog (a stalled Bedrock stream previously waited the generic 300s
		// default because model.compat was ignored on this path).
		const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 20 } });
		expect(model.compat.streamIdleTimeoutMs).toBe(20);
		const stream = streamBedrock(model, baseContext, {});
		// Real-clock race guard (matching this file's other lazy-stream tests):
		// the lazy watchdog runs on the platform clock, so fake timers cannot
		// drive it; the 20ms compat deadline settles the result long before the
		// bound, which exists only to fail fast instead of hanging the test.
		const result = await Promise.race([stream.result(), Bun.sleep(2_000).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for compat-driven stream stall result");
		}
		expect(providerSignal?.aborted).toBe(true);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider stream stalled while waiting for the next event");
	});

	it("disables the lazy watchdog when model.compat.streamIdleTimeoutMs is 0", async () => {
		vi.useFakeTimers();
		try {
			const partialMessage = createAssistantMessage("stop");
			const abortController = new AbortController();
			let providerSignal: AbortSignal | undefined;
			let steadyState = false;
			const source = {
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial: partialMessage } as const;
					yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
					steadyState = true;
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

			// reasoning:true would floor the watchdog at 600s for this id — the
			// explicit 0 override must disable it entirely through the lazy
			// wrapper, not fall back to any default (e.g. via a `||` regression).
			const model = createModel({ reasoning: true, compat: { streamIdleTimeoutMs: 0 } });
			expect(model.compat.streamIdleTimeoutMs).toBe(0);
			let settled = false;
			// First-event watchdog stays out of this case's scope (mirrors the
			// direct-Anthropic 0-disable test): fake-timer advancement could
			// otherwise outrun the microtask that consumes the first event.
			const resultPromise = streamBedrock(model, baseContext, {
				signal: abortController.signal,
				streamFirstEventTimeoutMs: 0,
			}).result();
			void resultPromise.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);

			await drainMicrotasksUntil(
				() => steadyState,
				"Bedrock mock stream did not reach steady-state idle for the compat-disabled watchdog test",
			);
			// Well past the generic 300s idle budget: the disabled watchdog must
			// not classify the post-first-event silence as a stall.
			vi.advanceTimersByTime(400_000);
			await drainMicrotasksUntil(
				() => vi.getTimerCount() === 0,
				"lazy watchdog timer did not drain after advancing past the idle budget",
			);
			expect(settled).toBe(false);
			expect(providerSignal?.aborted).toBe(false);

			abortController.abort();
			const result = await resultPromise;
			expect(result.stopReason).toBe("aborted");
			expect(result.errorMessage).toBe("Request was aborted");
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves caller aborts while forwarding lazy provider streams", async () => {
		const result = await abortForwardedStreamAfterStart();

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		// A bare cancel carries the generic Abort marker, the shape turn recovery
		// uses to decide a reasonless, output-free abort is safe to retry.
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(true);
	});

	it("reports the caller's labelled abort reason instead of the transport abort text", async () => {
		const result = await abortForwardedStreamAfterStart("Interrupted by user");

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Interrupted by user");
		// A labelled stop must stay outside the generic Abort marker: that marker
		// makes the terminal render "Operation aborted" and lets turn recovery
		// retry an empty turn as a reasonless abort.
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.UserInterrupt)).toBe(false);
	});

	it("classifies the caller's abort reason object instead of dropping its flags", async () => {
		const result = await abortForwardedStreamAfterStart(new AIError.StreamTimeoutError("budget spent"));

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("budget spent");
		// Classification must read the caller's own reason object, not the
		// wrapper's transport abort, so the reason's Timeout/Transient flags survive.
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("uses the same caller signal for the watchdog and the abort reason", async () => {
		const watchdogController = new AbortController();
		const ignoredController = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		let reads = 0;
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
				// Ignore the provider signal: only the wrapper's own abort listener can
				// settle this stream, so a watchdog bound to a later signal read hangs.
				await new Promise<never>(() => {});
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {
			get signal() {
				reads += 1;
				return reads === 1 ? watchdogController.signal : ignoredController.signal;
			},
			// Both watchdogs off so only the abort signal can settle the stream.
			streamIdleTimeoutMs: 0,
			streamFirstEventTimeoutMs: 0,
		});
		const iterator = stream[Symbol.asyncIterator]();
		expect((await iterator.next()).value?.type).toBe("start");

		watchdogController.abort("Interrupted by user");
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);
		expect(result).not.toBe("timeout");
		if (result === "timeout") throw new Error("Timed out waiting for the captured caller signal");
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Interrupted by user");
	});

	it("keeps the timeout marker when the caller's abort reason reads like a plain cancel", async () => {
		const result = await abortForwardedStreamAfterStart(new AIError.StreamTimeoutError("Request was aborted"));

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		// The reason's own classification must win over its text: a timeout that
		// happens to read like a bare cancel keeps its Timeout/Transient flags.
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("keeps the timeout marker when the caller's abort reason has no message", async () => {
		const result = await abortForwardedStreamAfterStart(new AIError.StreamTimeoutError(""));

		expect(result.stopReason).toBe("aborted");
		// The empty label yields no display text, but the reason's own
		// classification must still keep its Timeout/Transient flags.
		expect(result.errorMessage).toBe("Request was aborted");
		expect(AIError.is(result.errorId, AIError.Flag.Timeout)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("still ends the stream when the abort reason cannot be read", async () => {
		const reason = new Error("placeholder");
		Object.defineProperty(reason, "message", {
			get() {
				throw new Error("unreadable abort reason");
			},
		});

		const result = await abortForwardedStreamAfterStart(reason);

		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
		expect(AIError.is(result.errorId, AIError.Flag.Abort)).toBe(true);
	});

	it("turns a throwing signal getter into a stream error instead of a synchronous throw", async () => {
		const partialMessage = createAssistantMessage("stop");
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: partialMessage } as const;
			},
		} as unknown as AssistantMessageEventStream;

		setBedrockProviderModule({
			streamBedrock: () => source,
		});

		const stream = streamBedrock(createModel(), baseContext, {
			get signal(): AbortSignal {
				throw new Error("signal getter exploded");
			},
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("signal getter exploded");
	});
});
