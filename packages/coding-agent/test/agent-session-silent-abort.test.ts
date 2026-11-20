/**
 * AgentSession silent-abort marker tests (Phase 6 — A layer).
 *
 * Asserts that `#handleAgentEvent`:
 *   - stamps `SILENT_ABORT_MARKER` on aborted assistant `message_end` events
 *     when the `#planInternalAbortPending` flag is set and consumes the flag
 *     in the process (A1);
 *   - leaves `errorMessage` untouched (and the flag untouched) when the flag
 *     was never set (A2);
 *   - never consumes the flag on non-aborted message_end (A3);
 *   - stamps the marker BEFORE the obfuscator's display-event copy, so both
 *     the persisted message (in-place mutation) and the emitted display event
 *     (deobfuscated spread copy) carry the marker (A4).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolCall } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as BedrockProvider from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { setBedrockProviderModule, streamBedrock } from "@oh-my-pi/pi-ai/providers/register-builtins";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

function makeAbortedAssistantMessage(text = "partial draft"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "aborted",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

function makeStoppedAssistantMessage(text = "done"): AssistantMessage {
	return {
		...makeAbortedAssistantMessage(text),
		stopReason: "stop",
	};
}

interface SessionFixture {
	session: AgentSession;
}

async function createSessionWithObfuscator(
	modelRegistry: ModelRegistry,
	obfuscator?: SecretObfuscator,
): Promise<SessionFixture> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");

	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
	});

	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry,
		obfuscator,
	});

	return { session };
}

describe("AgentSession silent-abort marker stamping", () => {
	let fixture: SessionFixture | undefined;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-silent-abort-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("amazon-bedrock", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterEach(async () => {
		if (fixture) {
			await fixture.session.dispose();
			fixture = undefined;
		}
		setBedrockProviderModule(BedrockProvider);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		fixtureDir.removeSync();
	});

	it("A1: flag set + aborted assistant message_end stamps the marker and clears the flag", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		session.markPlanInternalAbortPending();
		expect(session.isPlanInternalAbortPending).toBe(true);

		const message = makeAbortedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });

		// `#handleAgentEvent` runs synchronously up through the stamp before awaiting
		// `#emitSessionEvent`; flush microtasks so observers see the settled state.
		await Promise.resolve();
		await Promise.resolve();

		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(AIError.is(message.errorId, AIError.Flag.SilentAbort)).toBe(true);
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("A2: flag unset + aborted assistant message_end leaves errorMessage and flag alone", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		expect(session.isPlanInternalAbortPending).toBe(false);

		const message = makeAbortedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message });
		await Promise.resolve();
		await Promise.resolve();

		expect(message.errorMessage).toBeUndefined();
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("A3: flag set + non-aborted message_end does NOT consume the flag", async () => {
		fixture = await createSessionWithObfuscator(modelRegistry);
		const { session } = fixture;
		session.markPlanInternalAbortPending();

		// stop reason "stop" — the marker must NOT be stamped and the flag must stay armed.
		const stopMsg = makeStoppedAssistantMessage();
		session.agent.emitExternalEvent({ type: "message_end", message: stopMsg });
		await Promise.resolve();
		await Promise.resolve();

		expect(stopMsg.errorMessage).toBeUndefined();
		expect(session.isPlanInternalAbortPending).toBe(true);

		// Drive an explicit `error` stopReason next — same expectation.
		const errMsg: AssistantMessage = { ...makeStoppedAssistantMessage("err"), stopReason: "error" };
		session.agent.emitExternalEvent({ type: "message_end", message: errMsg });
		await Promise.resolve();
		await Promise.resolve();

		expect(errMsg.errorMessage).toBeUndefined();
		expect(session.isPlanInternalAbortPending).toBe(true);
	});

	it("A4: marker is stamped on event.message BEFORE the obfuscator's displayEvent copy", async () => {
		// Build a real obfuscator with a `plain` secret so `deobfuscateAssistantContent(content)`
		// returns a NEW content array — that's the only path that triggers the
		// `displayEvent = { ...event, message: { ...message, content } }` spread copy
		// in `#handleAgentEvent`. The marker must be stamped BEFORE that spread so
		// `displayEvent.message.errorMessage` inherits via the spread.
		const obfuscator = new SecretObfuscator([{ type: "plain", content: "SECRET_VALUE" }]);
		const obfuscatedText = obfuscator.obfuscate("hello SECRET_VALUE world");
		// Sanity: obfuscation produced a placeholder embedded in the text.
		expect(obfuscatedText).not.toBe("hello SECRET_VALUE world");

		fixture = await createSessionWithObfuscator(modelRegistry, obfuscator);
		const { session } = fixture;

		// Capture session-emitted events.
		const seen: AgentSessionEvent[] = [];
		session.subscribe(event => {
			seen.push(event);
		});

		session.markPlanInternalAbortPending();

		// Use the obfuscated text as the message content so the deobfuscation walk
		// produces a different content array, exercising the spread-copy branch.
		const message: AssistantMessage = {
			...makeAbortedAssistantMessage(),
			content: [{ type: "text", text: obfuscatedText } as TextContent],
		};
		session.agent.emitExternalEvent({ type: "message_end", message });
		// `#emitSessionEvent` awaits an extension queue + extension dispatch; flush
		// microtasks a few times to settle observers.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		// `event.message` (the persistence-side reference) carries the marker via the
		// in-place stamp.
		expect(message.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(AIError.is(message.errorId, AIError.Flag.SilentAbort)).toBe(true);

		// The emitted display event ALSO carries the marker because the spread copy
		// happened AFTER the stamp.
		const emitted = seen.find(
			(event): event is Extract<AgentSessionEvent, { type: "message_end" }> => event.type === "message_end",
		);
		expect(emitted).toBeDefined();
		if (!emitted) {
			throw new Error("expected a message_end event to be emitted");
		}
		const emittedMessage = emitted.message;
		// `message_end` events are typed against AgentMessage (union over
		// custom/exec/etc. roles too); narrow by asserting `role` so the
		// `errorMessage` / `content` accesses below type-check.
		if (emittedMessage.role !== "assistant") {
			throw new Error("expected emitted message_end to be an assistant message");
		}
		expect(emittedMessage.errorMessage).toBe(SILENT_ABORT_MARKER);
		expect(AIError.is(emittedMessage.errorId, AIError.Flag.SilentAbort)).toBe(true);

		// Prove the obfuscator branch actually ran by asserting the emitted message
		// is a distinct object (post-spread) AND its content was deobfuscated back to
		// the secret text. If the obfuscator branch had been skipped, `emittedMessage`
		// would be `===` to `message` and the content text would still carry the
		// placeholder.
		expect(emittedMessage).not.toBe(message);
		const emittedText = (emittedMessage.content[0] as TextContent).text;
		expect(emittedText).toBe("hello SECRET_VALUE world");

		// Flag is consumed.
		expect(session.isPlanInternalAbortPending).toBe(false);
	});

	it("does not schedule a retry or clear the mark when an empty stream aborts with a quiet or user-interrupt AbortError", async () => {
		mockSchedulerWaitWithClock();
		const bedrockModel = buildModel({
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

		for (const flag of [AIError.Flag.SilentAbort, AIError.Flag.UserInterrupt] as const) {
			let calls = 0;
			const controller = new AbortController();
			// Cause carries Flag.Abort while name === "AbortError" leaves errorMessage
			// as "Request was aborted", exercising both the Flag.Abort and generic-text
			// retry arms in TurnRecovery.
			const reason = new Error("marked cancel", { cause: new AIError.AbortError() });
			reason.name = "AbortError";
			AIError.attach(reason, AIError.create(flag));

			setBedrockProviderModule({
				streamBedrock: (_model, _context, options) => {
					const partial: AssistantMessage = {
						role: "assistant",
						content: [],
						api: bedrockModel.api,
						provider: bedrockModel.provider,
						model: bedrockModel.id,
						stopReason: "stop",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						timestamp: Date.now(),
					};
					return {
						async *[Symbol.asyncIterator]() {
							yield { type: "start", partial } as const;
							controller.abort(reason);
							const { promise, reject } = Promise.withResolvers<never>();
							if (options.signal?.aborted) reject(new Error("Request was aborted"));
							options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted")), {
								once: true,
							});
							await promise;
						},
					} as unknown as AssistantMessageEventStream;
				},
			});

			const agent = new Agent({
				getApiKey: () => "bedrock-test-key",
				initialState: {
					model: bedrockModel,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: (_requestedModel, context) => {
					calls += 1;
					if (calls > 1) {
						const unexpected = new AssistantMessageEventStream();
						const doneMsg: AssistantMessage = {
							...makeStoppedAssistantMessage("unexpected retry"),
							api: bedrockModel.api,
							provider: bedrockModel.provider,
							model: bedrockModel.id,
						};
						queueMicrotask(() => {
							unexpected.push({ type: "done", reason: "stop", message: doneMsg });
							unexpected.end(doneMsg);
						});
						return unexpected;
					}
					return streamBedrock(bedrockModel, context, {
						signal: controller.signal,
						streamFirstEventTimeoutMs: 0,
						streamIdleTimeoutMs: 60_000,
					});
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
			});
			fixture = {
				session: new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry,
				}),
			};
			const retryStarts: AgentSessionEvent[] = [];
			fixture.session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStarts.push(event);
			});

			await fixture.session.prompt("Cancel quietly");
			await fixture.session.waitForIdle();

			expect(calls).toBe(1);
			expect(retryStarts).toHaveLength(0);
			expect(fixture.session.isRetrying).toBe(false);
			const last = fixture.session.agent.state.messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant",
			);
			expect(last?.stopReason).toBe("aborted");
			expect(last?.errorMessage).toBe("Request was aborted");
			expect(AIError.is(last?.errorId, flag)).toBe(true);

			await fixture.session.dispose();
			fixture = undefined;
		}
	});

	it("does not schedule a resolved-tool-turn retry when the aborted turn carries a quiet or user-interrupt mark", async () => {
		mockSchedulerWaitWithClock();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		for (const flag of [AIError.Flag.SilentAbort, AIError.Flag.UserInterrupt] as const) {
			let calls = 0;
			const toolCall: ToolCall = {
				type: "toolCall",
				id: "call_marked_abort",
				name: "bash",
				arguments: { command: "pwd" },
			};
			const agent = new Agent({
				getApiKey: () => "anthropic-test-key",
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
				streamFn: () => {
					calls += 1;
					const stream = new AssistantMessageEventStream();
					if (calls > 1) {
						const doneMsg = makeStoppedAssistantMessage("unexpected retry");
						queueMicrotask(() => {
							stream.push({ type: "done", reason: "stop", message: doneMsg });
							stream.end(doneMsg);
						});
						return stream;
					}
					const partial: AssistantMessage = {
						...makeAbortedAssistantMessage(),
						content: [toolCall],
						stopReason: "toolUse",
					};
					const aborted: AssistantMessage = {
						...partial,
						stopReason: "aborted",
						errorMessage: "Request was aborted",
						errorId: AIError.create(AIError.Flag.Abort, flag),
					};
					queueMicrotask(() => {
						stream.push({ type: "start", partial });
						stream.push({ type: "toolcall_start", contentIndex: 0, partial });
						stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial });
						stream.push({ type: "error", reason: "aborted", error: aborted });
						stream.end(aborted);
					});
					return stream;
				},
			});

			const settings = Settings.isolated({
				"compaction.enabled": false,
				"retry.baseDelayMs": 5,
				"retry.maxDelayMs": 100,
			});
			fixture = {
				session: new AgentSession({
					agent,
					sessionManager: SessionManager.inMemory(),
					settings,
					modelRegistry,
				}),
			};
			const retryStarts: AgentSessionEvent[] = [];
			fixture.session.subscribe(event => {
				if (event.type === "auto_retry_start") retryStarts.push(event);
			});

			await fixture.session.prompt("Run tool then cancel");
			await fixture.session.waitForIdle();

			expect(calls).toBe(1);
			expect(retryStarts).toHaveLength(0);
			expect(fixture.session.isRetrying).toBe(false);
			const last = fixture.session.agent.state.messages.findLast(
				(m): m is AssistantMessage => m.role === "assistant",
			);
			expect(last?.stopReason).toBe("aborted");
			expect(AIError.is(last?.errorId, flag)).toBe(true);

			await fixture.session.dispose();
			fixture = undefined;
		}
	});
});
