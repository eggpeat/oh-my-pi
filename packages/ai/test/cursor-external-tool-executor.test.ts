import { describe, expect, it, vi } from "bun:test";
import * as http2 from "node:http2";
import { AuthGatewaySessionStateStore } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildGrpcRequest, type CursorOptions, streamCursor } from "@oh-my-pi/pi-ai/providers/cursor";
import type {
	AssistantMessage,
	Message,
	Model,
	ProviderSessionState,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	type AgentClientMessage,
	AgentClientMessageSchema,
	type AgentServerMessage,
	AgentServerMessageSchema,
	ConversationStateStructureSchema,
	type ExecServerMessage,
	ExecServerMessageSchema,
	type InteractionUpdate,
	InteractionUpdateSchema,
	KvServerMessageSchema,
	McpArgsSchema,
	type McpResult,
	McpToolCallSchema,
	RequestContextArgsSchema,
	SetBlobArgsSchema,
	TextDeltaUpdateSchema,
	TokenDeltaUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	ToolRequestsListedUpdateSchema,
	TurnEndedUpdateSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, encodeJsonValue, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

// An auth-gateway runs Cursor for a client that owns every tool and is reached
// only through the pi-native wire, which carries no `kCursorExecResolved`
// marker. These drive the real Run transport against a local HTTP/2 Cursor.

function frame(message: AgentServerMessage["message"]): Buffer {
	const data = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
	const framed = Buffer.alloc(5 + data.length);
	framed.writeUInt32BE(data.length, 1);
	framed.set(data, 5);
	return framed;
}

function execFrame(id: number, message: ExecServerMessage["message"]): Buffer {
	return frame({
		case: "execServerMessage",
		value: create(ExecServerMessageSchema, { id, execId: `exec-${id}`, message }),
	});
}

function blobId(record: string): string {
	return new Bun.CryptoHasher("sha256").update(record).digest("hex");
}

function setBlobFrame(id: number, record: string): Buffer {
	return frame({
		case: "kvServerMessage",
		value: create(KvServerMessageSchema, {
			id,
			message: {
				case: "setBlobArgs",
				value: create(SetBlobArgsSchema, {
					blobId: Buffer.from(blobId(record), "hex"),
					blobData: Buffer.from(record),
				}),
			},
		}),
	});
}

function checkpointFrame(records: string[]): Buffer {
	return frame({
		case: "conversationCheckpointUpdate",
		value: create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: records.map(record => Buffer.from(blobId(record), "hex")),
		}),
	});
}

function decodeClientMessages(buffer: Buffer): AgentClientMessage[] {
	const messages: AgentClientMessage[] = [];
	let offset = 0;
	while (buffer.length - offset >= 5) {
		const length = buffer.readUInt32BE(offset + 1);
		if (buffer.length - offset < 5 + length) break;
		messages.push(fromBinary(AgentClientMessageSchema, buffer.subarray(offset + 5, offset + 5 + length)));
		offset += 5 + length;
	}
	return messages;
}

type FixtureStream = (
	stream: http2.ServerHttp2Stream,
	headers: http2.IncomingHttpHeaders,
	received: AgentClientMessage[],
) => void;

/** Serves one Run stream with `handler`, called again on every client frame. */
async function withCursorServer<T>(handler: FixtureStream, run: (baseUrl: string) => Promise<T>): Promise<T> {
	const sessions = new Set<http2.Http2Session>();
	const server = http2.createServer();
	server.on("session", session => {
		sessions.add(session);
		session.on("close", () => sessions.delete(session));
	});
	server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
		let buffered = Buffer.alloc(0);
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			if (!stream.writableEnded) handler(stream, headers, decodeClientMessages(buffered));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("expected HTTP/2 fixture server address");
	try {
		return await run(`http://127.0.0.1:${address.port}`);
	} finally {
		for (const session of sessions) session.destroy();
		server.close();
	}
}

function model(baseUrl = ""): Model<"cursor-agent"> {
	return buildModel({
		id: "composer-2.5",
		name: "composer-2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1,
		maxTokens: 1,
	});
}

const tool = (name: string): Tool => ({
	name,
	description: `${name} tool`,
	parameters: { type: "object", properties: { path: { type: "string" } } },
});

const tools = [tool("read"), tool("bash"), tool("edit"), tool("write")];
const user: Message = { role: "user", content: "Fix the bug in calc.py.", timestamp: 1 };

/** What the fixture Cursor saw of one run. */
interface ObservedRun {
	allowedTools?: string;
	advertised?: string[];
	answer?: McpResult;
}

/**
 * One Cursor turn: fetch the request context, call the client's `read` over
 * MCP, and once the frame is answered write the records the server keeps for
 * the turn (its tool-result record holds the answer Cursor got) and end it.
 */
function readTurn(observed: ObservedRun): FixtureStream {
	let step = 0;
	return (stream, headers, received) => {
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		if (step === 0) {
			step = 1;
			const allowed = headers["x-cursor-agent-allowed-tools"];
			observed.allowedTools = Array.isArray(allowed) ? allowed.join(",") : allowed;
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		if (step === 1) {
			const context = replies.find(reply => reply.case === "requestContextResult");
			if (context?.case !== "requestContextResult") return;
			step = 2;
			const result = context.value.result;
			observed.advertised =
				result.case === "success" ? (result.value.requestContext?.tools ?? []).map(def => def.name) : [];
			stream.write(
				execFrame(2, {
					case: "mcpArgs",
					value: create(McpArgsSchema, {
						name: "read",
						toolName: "read",
						toolCallId: "call-read-1",
						providerIdentifier: "pi-agent",
						args: { path: encodeJsonValue("calc.py") },
					}),
				}),
			);
			return;
		}
		const answer = replies.find(reply => reply.case === "mcpResult");
		if (step !== 2 || answer?.case !== "mcpResult") return;
		step = 3;
		observed.answer = answer.value;
		const answerText =
			answer.value.result.case === "success"
				? answer.value.result.value.content.map(item =>
						item.content.case === "text" ? item.content.value.text : "",
					)
				: [answer.value.result.case ?? ""];
		const records = [
			JSON.stringify({
				role: "user",
				content: [{ type: "text", text: "<user_query>\nFix the bug in calc.py.\n</user_query>" }],
				providerOptions: { cursor: { requestId: String(headers["x-request-id"]) } },
			}),
			JSON.stringify({
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call-read-1", toolName: "read", args: { path: "calc.py" } }],
			}),
			JSON.stringify({
				role: "tool",
				content: [
					{ type: "tool-result", toolCallId: "call-read-1", toolName: "read", result: answerText.join("") },
				],
			}),
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Waiting for the file." }] }),
		];
		stream.end(
			Buffer.concat([
				frame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: {
							case: "textDelta",
							value: create(TextDeltaUpdateSchema, { text: "Waiting for the file." }),
						},
					}),
				}),
				...records.map((record, index) => setBlobFrame(10 + index, record)),
				checkpointFrame(records),
				frame({
					case: "interactionUpdate",
					value: create(InteractionUpdateSchema, {
						message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
					}),
				}),
			]),
		);
	};
}

async function runReadTurn(options: Omit<CursorOptions, "apiKey">): Promise<{
	assistant: AssistantMessage;
	observed: ObservedRun;
}> {
	const observed: ObservedRun = {};
	const assistant = await withCursorServer(readTurn(observed), async baseUrl => {
		const response = streamCursor(
			model(baseUrl),
			{ messages: [user], tools },
			{ sessionId: `external-${crypto.randomUUID()}`, ...options, apiKey: "test-token" },
		);
		for await (const _event of response) {
			// drain
		}
		return await response.result();
	});
	return { assistant, observed };
}

describe("Cursor runs whose tools an external executor owns", () => {
	it.each<{ mode: string; options: CursorOptions; allowedTools: string | undefined; advertised: string[] }>([
		{
			// The gateway can answer no native exec frame: Cursor's own Shell/Read/
			// StrReplace were told "Tool not available" while the client ran the
			// call anyway, in Cursor's argument shape. Every client tool is an MCP
			// tool instead, under its own name and schema.
			mode: "an external executor",
			options: { externalToolExecutor: true },
			allowedTools: "mcp_tool_call,get_mcp_tools_tool_call",
			advertised: ["read", "bash", "edit", "write"],
		},
		{
			// A local bridge answers native frames, so Cursor keeps its native
			// tools and the bridged ones are not offered twice.
			mode: "a local bridge",
			options: {},
			allowedTools: undefined,
			advertised: ["edit", "write"],
		},
	])("limits Cursor's toolset and MCP catalog for a run with $mode", async ({ options, allowedTools, advertised }) => {
		const { observed } = await runReadTurn(options);

		expect(observed.allowedTools).toBe(allowedTools);
		expect(observed.advertised).toEqual(advertised);
	});

	it("hands an MCP call to the client and stops the turn for it", async () => {
		const { assistant, observed } = await runReadTurn({ externalToolExecutor: true });
		// What the client receives over pi-native: plain JSON, no symbol markers.
		const received = JSON.parse(JSON.stringify(assistant)) as AssistantMessage;
		const calls = received.content.filter((block): block is ToolCall => block.type === "toolCall");

		// Cursor is told the call was handed off, not that the tool is missing.
		expect(observed.answer?.result.case).toBe("success");
		expect(calls).toEqual([{ type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "calc.py" } }]);
		// The model wound up after the handoff, but the client still owes the result.
		expect(received.stopReason).toBe("toolUse");
	});

	it("sends the client's result for a handed-off call on the next request", async () => {
		const { assistant } = await runReadTurn({ externalToolExecutor: true });
		const handedOff = JSON.parse(JSON.stringify(assistant)) as AssistantMessage;
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-read-1",
			toolName: "read",
			content: [{ type: "text", text: "1|def add(a, b):\n2|    return a - b" }],
			isError: false,
			timestamp: 3,
		};
		const blobStore = new Map<string, Uint8Array>();

		const { conversationState } = await buildGrpcRequest(
			model(),
			{ messages: [user, handedOff, result], tools },
			{ externalToolExecutor: true },
			{ conversationId: `external-${crypto.randomUUID()}`, blobStore },
		);
		const records = conversationState.rootPromptMessagesJson.map(id =>
			new TextDecoder().decode(blobStore.get(Buffer.from(id).toString("hex"))),
		);
		const toolRecords = records.filter(record => record.includes('"tool-result"'));

		// The server's own records answer the call with the handoff text; the
		// model must see what the client's tool returned instead.
		expect(toolRecords).toHaveLength(1);
		expect(JSON.parse(toolRecords[0])).toMatchObject({
			role: "tool",
			content: [{ type: "tool-result", toolCallId: "call-read-1", result: "1|def add(a, b):\n2|    return a - b" }],
		});
	});
});

// With a session to park in (the gateway's `providerSessionState`), a run keeps
// the client's calls open across its requests instead of handing them off.

function interactionFrame(message: InteractionUpdate["message"]): Buffer {
	return frame({ case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) });
}

function mcpText(answer: McpResult): string {
	return answer.result.case === "success"
		? answer.result.value.content.map(item => (item.content.case === "text" ? item.content.value.text : "")).join("")
		: `<${answer.result.case}>`;
}

/** One Run stream the relaying fixture Cursor served. */
interface ServedRun {
	/** The run request's action: a turn opens on `userMessageAction`, a rebuilt one resumes. */
	action: string | undefined;
	/** MCP answers the client wrote on the stream. */
	answers: McpResult[];
	/** The client closed the stream before Cursor ended it. */
	cancelled: boolean;
	closed: Promise<void>;
}

/**
 * Cursor handing the client one `read` call the way it does on the wire: the
 * call's start, its MCP exec frame, then the step's listing. Once the call is
 * answered the model finishes (or, with `finish: false`, keeps talking). A turn
 * rebuilt from history (`resumeAction`) finishes at once.
 */
function relayingCursor(runs: ServedRun[], finish = true): FixtureStream {
	const served = new WeakMap<http2.ServerHttp2Stream, { run: ServedRun; step: number; end(data: Buffer): void }>();
	const finished = (text: string): Buffer =>
		Buffer.concat([
			interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) }),
			interactionFrame({ case: "turnEnded", value: create(TurnEndedUpdateSchema, { outputTokens: 12n }) }),
		]);
	return (stream, _headers, received) => {
		const entry = served.get(stream);
		if (!entry) {
			const request = received.find(message => message.message.case === "runRequest");
			if (request?.message.case !== "runRequest") return;
			const closed = Promise.withResolvers<void>();
			const run: ServedRun = {
				action: request.message.value.action?.action.case,
				answers: [],
				cancelled: false,
				closed: closed.promise,
			};
			let ended = false;
			stream.on("close", () => {
				run.cancelled = !ended;
				closed.resolve();
			});
			served.set(stream, {
				run,
				step: 0,
				end: data => {
					ended = true;
					stream.end(data);
				},
			});
			runs.push(run);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		entry.run.answers = replies.flatMap(reply => (reply.case === "mcpResult" ? [reply.value] : []));
		if (entry.step === 0 && replies.some(reply => reply.case === "requestContextResult")) {
			entry.step = 1;
			if (entry.run.action === "resumeAction") {
				entry.end(finished("Rebuilt."));
				return;
			}
			const args = create(McpArgsSchema, {
				name: "read",
				toolName: "read",
				toolCallId: "call-read-1",
				providerIdentifier: "pi-agent",
				args: { path: encodeJsonValue("calc.py") },
			});
			stream.write(
				Buffer.concat([
					interactionFrame({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 5 }) }),
					interactionFrame({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, {
							callId: "call-read-1",
							toolCall: create(ToolCallSchema, {
								tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
							}),
						}),
					}),
					execFrame(2, { case: "mcpArgs", value: args }),
					interactionFrame({
						case: "toolRequestsListed",
						value: create(ToolRequestsListedUpdateSchema, { callCount: 1 }),
					}),
				]),
			);
			return;
		}
		if (entry.step === 1 && entry.run.answers.length > 0) {
			entry.step = 2;
			if (finish) {
				entry.end(finished("Fixed."));
			} else {
				stream.write(
					interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "Fix" }) }),
				);
			}
		}
	};
}

const readResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "call-read-1",
	toolName: "read",
	content: [{ type: "text", text: "1|def add(a, b):\n2|    return a - b" }],
	isError: false,
	timestamp: 3,
};

function relayOptions(
	states: Map<string, ProviderSessionState>,
	extra?: Omit<CursorOptions, "providerSessionState">,
): CursorOptions {
	return {
		externalToolExecutor: true,
		sessionId: "relay-session",
		providerSessionState: states,
		apiKey: "test-token",
		...extra,
	};
}

/** One gateway request, as its client receives the reply over pi-native: plain JSON. */
async function respond(baseUrl: string, messages: Message[], options: CursorOptions): Promise<AssistantMessage> {
	const response = streamCursor(model(baseUrl), { messages, tools }, options);
	for await (const _event of response) {
		// drain
	}
	return JSON.parse(JSON.stringify(await response.result())) as AssistantMessage;
}

function text(message: AssistantMessage): string {
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

function readCall(n: number): Buffer {
	const args = create(McpArgsSchema, {
		name: "read",
		toolName: "read",
		toolCallId: `call-read-${n}`,
		providerIdentifier: "pi-agent",
		args: { path: encodeJsonValue(`file${n}.py`) },
	});
	return Buffer.concat([
		interactionFrame({
			case: "toolCallStarted",
			value: create(ToolCallStartedUpdateSchema, {
				callId: `call-read-${n}`,
				toolCall: create(ToolCallSchema, {
					tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args }) },
				}),
			}),
		}),
		execFrame(n + 1, { case: "mcpArgs", value: args }),
	]);
}

function listed(callCount: number): Buffer {
	return interactionFrame({
		case: "toolRequestsListed",
		value: create(ToolRequestsListedUpdateSchema, { callCount }),
	});
}

/**
 * Cursor running a step's two `read` calls one at a time, as it does for Grok:
 * a call it serves itself (listed on its own) comes first, then `call-read-1`
 * with no listing; only once that is answered does it stream `call-read-2`
 * and list the step's two calls.
 */
function serializingCursor(runs: ServedRun[]): FixtureStream {
	const served = new WeakMap<http2.ServerHttp2Stream, { run: ServedRun; answered: number }>();
	return (stream, _headers, received) => {
		const entry = served.get(stream);
		if (!entry) {
			const request = received.find(message => message.message.case === "runRequest");
			if (request?.message.case !== "runRequest") return;
			const run: ServedRun = {
				action: request.message.value.action?.action.case,
				answers: [],
				cancelled: false,
				closed: Promise.resolve(),
			};
			served.set(stream, { run, answered: -1 });
			runs.push(run);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.write(execFrame(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
			return;
		}
		const replies = received.flatMap(message =>
			message.message.case === "execClientMessage" ? [message.message.value.message] : [],
		);
		entry.run.answers = replies.flatMap(reply => (reply.case === "mcpResult" ? [reply.value] : []));
		if (entry.answered === -1 && replies.some(reply => reply.case === "requestContextResult")) {
			entry.answered = 0;
			stream.write(
				Buffer.concat([
					interactionFrame({
						case: "toolCallStarted",
						value: create(ToolCallStartedUpdateSchema, {
							callId: "server-call",
							toolCall: create(ToolCallSchema, {}),
						}),
					}),
					listed(1),
					readCall(1),
				]),
			);
		} else if (entry.answered >= 0 && entry.run.answers.length > entry.answered) {
			entry.answered = entry.run.answers.length;
			stream.write(
				entry.answered === 1
					? Buffer.concat([readCall(2), listed(2)])
					: Buffer.concat([
							interactionFrame({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "Fixed." }) }),
							interactionFrame({
								case: "turnEnded",
								value: create(TurnEndedUpdateSchema, { outputTokens: 12n }),
							}),
						]),
			);
			if (entry.answered === 2) stream.end();
		}
	};
}

const fileResult = (n: number): ToolResultMessage => ({
	role: "toolResult",
	toolCallId: `call-read-${n}`,
	toolName: "read",
	content: [{ type: "text", text: `file ${n}` }],
	isError: false,
	timestamp: 3 + n,
});

describe("Cursor runs relayed across an external executor's requests", () => {
	it("answers the parked call in-band with the next request's result and streams on in the same run", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));

			expect(handedOff.stopReason).toBe("toolUse");
			expect(handedOff.content.filter(block => block.type === "toolCall")).toEqual([
				{ type: "toolCall", id: "call-read-1", name: "read", arguments: { path: "calc.py" } },
			]);
			// Cursor still waits on the call: nothing, no handoff text, answered it.
			expect(runs.map(run => run.answers)).toEqual([[]]);

			const resumed = await respond(baseUrl, [user, handedOff, readResult], relayOptions(states));

			expect(runs).toHaveLength(1);
			expect(runs[0].answers.map(mcpText)).toEqual(["1|def add(a, b):\n2|    return a - b"]);
			expect(resumed.stopReason).toBe("stop");
			expect(text(resumed)).toBe("Fixed.");
			// The turn-end count spans both responses; each reports only its share.
			expect(handedOff.usage.output + resumed.usage.output).toBe(12);
			expect(states.size).toBe(0);
		});
	});

	it("hands off a call Cursor waits on before listing its step, and counts it toward the listing", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(serializingCursor(runs), async baseUrl => {
			const first = await respond(baseUrl, [user], relayOptions(states));
			expect(first.stopReason).toBe("toolUse");
			expect(first.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))).toEqual(["call-read-1"]);

			const second = await respond(baseUrl, [user, first, fileResult(1)], relayOptions(states));
			expect(second.stopReason).toBe("toolUse");
			expect(second.content.flatMap(block => (block.type === "toolCall" ? [block.id] : []))).toEqual([
				"call-read-2",
			]);

			const third = await respond(
				baseUrl,
				[user, first, fileResult(1), second, fileResult(2)],
				relayOptions(states),
			);
			expect(third.stopReason).toBe("stop");
			expect(text(third)).toBe("Fixed.");
			expect(runs).toHaveLength(1);
			expect(runs[0].answers.map(mcpText)).toEqual(["file 1", "file 2"]);
			expect(states.size).toBe(0);
		});
	});

	it("cancels the parked run and rebuilds the turn when the next request does not continue it", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));
			const stray: ToolResultMessage = { ...readResult, toolCallId: "call-read-2" };

			const rebuilt = await respond(baseUrl, [user, handedOff, stray], relayOptions(states));
			await runs[0].closed;

			expect(runs.map(run => [run.action, run.answers.length, run.cancelled])).toEqual([
				["userMessageAction", 0, true],
				["resumeAction", 0, false],
			]);
			expect(text(rebuilt)).toBe("Rebuilt.");
			expect(states.size).toBe(0);
		});
	});

	it.each<{ cause: string; session: () => { states: Map<string, ProviderSessionState>; giveUp(): void } }>([
		{
			cause: "its idle timeout",
			session: () => {
				vi.useFakeTimers();
				const states = new Map<string, ProviderSessionState>();
				return {
					states,
					giveUp: () => {
						vi.advanceTimersByTime(119_999);
						expect(states.size).toBe(1);
						vi.advanceTimersByTime(1);
					},
				};
			},
		},
		{
			cause: "the gateway evicting its session",
			session: () => {
				const store = new AuthGatewaySessionStateStore(1);
				const session = (clientKey: string) =>
					store.acquire({ clientKey, model: model(), context: { messages: [user], tools }, account: "key:test" });
				const lease = session("relay-a");
				return {
					states: lease.states,
					giveUp: () => {
						lease.release();
						session("relay-b").release();
					},
				};
			},
		},
	])("cancels a parked run on $cause, and the late request rebuilds the turn", async ({ session }) => {
		const runs: ServedRun[] = [];
		try {
			await withCursorServer(relayingCursor(runs), async baseUrl => {
				const { states, giveUp } = session();
				const handedOff = await respond(baseUrl, [user], relayOptions(states));
				expect(runs.map(run => [run.answers.length, run.cancelled])).toEqual([[0, false]]);

				giveUp();
				await runs[0].closed;
				vi.useRealTimers();
				const rebuilt = await respond(baseUrl, [user, handedOff, readResult], relayOptions(states));

				expect(runs.map(run => [run.action, run.answers.length, run.cancelled])).toEqual([
					["userMessageAction", 0, true],
					["resumeAction", 0, false],
				]);
				expect(text(rebuilt)).toBe("Rebuilt.");
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the run when the request it was resumed into is aborted", async () => {
		const runs: ServedRun[] = [];
		const states = new Map<string, ProviderSessionState>();
		await withCursorServer(relayingCursor(runs, false), async baseUrl => {
			const handedOff = await respond(baseUrl, [user], relayOptions(states));
			const controller = new AbortController();
			const response = streamCursor(
				model(baseUrl),
				{ messages: [user, handedOff, readResult], tools },
				relayOptions(states, { signal: controller.signal }),
			);
			for await (const event of response) {
				if (event.type === "text_delta") controller.abort();
			}
			const aborted = await response.result();
			await runs[0].closed;

			expect(aborted.stopReason).toBe("aborted");
			expect(runs.map(run => [run.answers.length, run.cancelled])).toEqual([[1, true]]);
			expect(states.size).toBe(0);
		});
	});
});
