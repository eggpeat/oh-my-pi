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

		abortController.abort();
		const result = await Promise.race([stream.result(), Bun.sleep(500).then(() => "timeout" as const)]);

		expect(result).not.toBe("timeout");
		if (result === "timeout") {
			throw new Error("Timed out waiting for forwarded caller abort result");
		}
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Request was aborted");
	});

	it("preserves caller abort reason and error classification on forwarded streams", async () => {
		const partialMessage = createAssistantMessage("stop");
		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) =>
				({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: partialMessage } as const;
						const { promise } = Promise.withResolvers<never>();
						options.signal?.addEventListener("abort", () => {}, { once: true });
						await promise;
					},
				}) as unknown as AssistantMessageEventStream,
		});

		// String abort reason: surfaces the caller's text and classifies the caller's own reason.
		const stringAbort = new AbortController();
		const stream = streamBedrock(createModel(), baseContext, {
			signal: stringAbort.signal,
			streamIdleTimeoutMs: 500,
		});
		const iterator = stream[Symbol.asyncIterator]();
		const firstEvent = await iterator.next();
		expect(firstEvent.value?.type).toBe("start");
		stringAbort.abort("Interrupted by user");
		const stringResult = await stream.result();
		expect(stringResult.stopReason).toBe("aborted");
		expect(stringResult.errorMessage).toBe("Interrupted by user");
		expect(stringResult.errorId).toBeUndefined();

		// Explicit AbortError message vs bare AbortError fallback.
		const explicitAbort = new AbortController();
		const explicitStream = streamBedrock(createModel(), baseContext, {
			signal: explicitAbort.signal,
			streamIdleTimeoutMs: 500,
		});
		await explicitStream[Symbol.asyncIterator]().next();
		explicitAbort.abort(new AIError.AbortError("Stopped by operator"));
		const explicitResult = await explicitStream.result();
		expect(explicitResult.stopReason).toBe("aborted");
		expect(explicitResult.errorMessage).toBe("Stopped by operator");
		expect(AIError.is(explicitResult.errorId, AIError.Flag.Abort)).toBe(true);

		const bareAbortError = new AbortController();
		const bareAbortErrorStream = streamBedrock(createModel(), baseContext, {
			signal: bareAbortError.signal,
			streamIdleTimeoutMs: 500,
		});
		await bareAbortErrorStream[Symbol.asyncIterator]().next();
		bareAbortError.abort(new AIError.AbortError());
		const bareAbortErrorResult = await bareAbortErrorStream.result();
		expect(bareAbortErrorResult.stopReason).toBe("aborted");
		expect(bareAbortErrorResult.errorMessage).toBe("Request was aborted");
		expect(AIError.is(bareAbortErrorResult.errorId, AIError.Flag.Abort)).toBe(true);

		// Classified Error and plain-object abort reasons preserve both message and flags.
		const classifiedAbort = new AbortController();
		const classifiedReason = AIError.attach(
			new Error("Cancelled by operator"),
			AIError.create(AIError.Flag.UserInterrupt),
		);
		const classifiedStream = streamBedrock(createModel(), baseContext, {
			signal: classifiedAbort.signal,
			streamIdleTimeoutMs: 500,
		});
		await classifiedStream[Symbol.asyncIterator]().next();
		classifiedAbort.abort(classifiedReason);
		const classifiedResult = await classifiedStream.result();
		expect(classifiedResult.stopReason).toBe("aborted");
		expect(classifiedResult.errorMessage).toBe("Cancelled by operator");
		expect(AIError.is(classifiedResult.errorId, AIError.Flag.UserInterrupt)).toBe(true);

		const objectAbort = new AbortController();
		const objectReason = AIError.attach({ message: "Quiet transition" }, AIError.create(AIError.Flag.SilentAbort));
		const objectStream = streamBedrock(createModel(), baseContext, {
			signal: objectAbort.signal,
			streamIdleTimeoutMs: 500,
		});
		await objectStream[Symbol.asyncIterator]().next();
		objectAbort.abort(objectReason);
		const objectResult = await objectStream.result();
		expect(objectResult.stopReason).toBe("aborted");
		expect(objectResult.errorMessage).toBe("Quiet transition");
		expect(AIError.is(objectResult.errorId, AIError.Flag.SilentAbort)).toBe(true);
		expect(AIError.is(objectResult.errorId, AIError.Flag.Abort)).toBe(false);
	});

	it("shields caller aborts from competing timeout errors and pre-stream throws", async () => {
		// Pre-stream synchronous throw while caller signal is already aborted.
		const preAborted = new AbortController();
		preAborted.abort("Interrupted by user");
		setBedrockProviderModule({
			streamBedrock: () => {
				throw new Error("boom before stream");
			},
		});
		const preAbortedResult = await streamBedrock(createModel(), baseContext, {
			signal: preAborted.signal,
		}).result();
		expect(preAbortedResult.stopReason).toBe("aborted");
		expect(preAbortedResult.errorMessage).toBe("Interrupted by user");
		expect(AIError.is(preAbortedResult.errorId, AIError.Flag.Transient)).toBe(false);

		// A competing provider AbortError caused by a timeout must not taint a string caller abort.
		const racingAbort = new AbortController();
		const partialMessage = createAssistantMessage("stop");
		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) =>
				({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: partialMessage } as const;
						yield { type: "text_delta", contentIndex: 0, delta: "hello", partial: partialMessage } as const;
						const { promise, reject } = Promise.withResolvers<void>();
						options.signal?.addEventListener(
							"abort",
							() => {
								racingAbort.abort("Interrupted by user");
								reject(
									new AIError.AbortError("Provider timed out", {
										cause: new AIError.StreamTimeoutError("Provider stream stalled"),
									}),
								);
							},
							{ once: true },
						);
						await promise;
					},
				}) as unknown as AssistantMessageEventStream,
		});
		const racingResult = await streamBedrock(createModel(), baseContext, {
			signal: racingAbort.signal,
			streamIdleTimeoutMs: 10,
		}).result();
		expect(racingResult.stopReason).toBe("aborted");
		expect(racingResult.errorMessage).toBe("Interrupted by user");
		expect(racingResult.errorId).toBeUndefined();
	});

	it("isolates each stream from mutations to a reused options object while lazy loading", async () => {
		const firstMessage = createAssistantMessage("stop");
		const partialMessage = createAssistantMessage("stop");
		const finishFirst = Promise.withResolvers<void>();
		let callIndex = 0;
		setBedrockProviderModule({
			streamBedrock: (_model, _context, options) => {
				const currentCall = ++callIndex;
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: partialMessage } as const;
						if (currentCall === 1) {
							await finishFirst.promise;
							return;
						}
						const { promise } = Promise.withResolvers<never>();
						options.signal?.addEventListener("abort", () => {}, { once: true });
						await promise;
					},
					result: async () => firstMessage,
				} as unknown as AssistantMessageEventStream;
			},
		});

		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const sharedOptions = { signal: firstAbort.signal, streamIdleTimeoutMs: 500 };

		const firstStream = streamBedrock(createModel(), baseContext, sharedOptions);
		// Mutate the shared options object before `load().then(...)` runs on the microtask queue.
		sharedOptions.signal = secondAbort.signal;
		const secondStream = streamBedrock(createModel(), baseContext, sharedOptions);

		await secondStream[Symbol.asyncIterator]().next();
		secondAbort.abort("Stop second stream");

		const secondResult = await secondStream.result();
		expect(secondResult.stopReason).toBe("aborted");
		expect(secondResult.errorMessage).toBe("Stop second stream");

		finishFirst.resolve();
		const firstResult = await firstStream.result();
		expect(firstResult).toEqual(firstMessage);
	});
});
