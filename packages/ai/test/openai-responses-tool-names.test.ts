import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamAzureOpenAIResponses } from "@oh-my-pi/pi-ai/providers/azure-openai-responses";
import { buildTransformedCodexRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { buildParams } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ResponseStreamEvent } from "@oh-my-pi/pi-ai/providers/openai-responses-wire";
import {
	buildResponsesInput,
	createInitialResponsesAssistantMessage,
	processResponsesStream,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { createOpenAIResponsesHistoryPayload } from "@oh-my-pi/pi-ai/utils";
import type { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";

function model(provider = "muse-code", compat?: OpenAICompat) {
	return buildModel({
		id: "muse-wonder-full-1.0",
		name: "Muse Wonder Full",
		api: "openai-responses",
		provider,
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
		compat,
	});
}

const tools: Tool[] = ["bash", "web_search", "read", "_private"].map(name => ({
	name,
	description: name,
	parameters: type({ command: "string" }),
}));

function assistant(names: string[]): AssistantMessage {
	return {
		...createInitialResponsesAssistantMessage("openai-responses", "muse-code", "muse-wonder-full-1.0"),
		stopReason: "toolUse",
		content: names.map((name, index) => ({
			type: "toolCall",
			id: `call_${index}`,
			name,
			arguments: { command: "echo muse-ok" },
		})),
	};
}

function requestNames(context: Context, provider = "muse-code") {
	const { params } = buildParams(model(provider), context, undefined, undefined);
	return {
		tools: params.tools?.filter(tool => tool.type === "function").map(tool => tool.name),
		calls: params.input?.filter(item => item.type === "function_call").map(item => item.name),
	};
}

function alternateResponsesModel(
	api: "azure-openai-responses" | "openai-codex-responses",
	escapeBuiltinToolNames: boolean,
) {
	const spec = {
		id: "gpt-5.5",
		name: "GPT-5.5",
		reasoning: true,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 8192,
		compat: { escapeBuiltinToolNames },
	};
	return api === "openai-codex-responses"
		? buildModel<"openai-codex-responses">({
				...spec,
				api: "openai-codex-responses",
				provider: "openai-codex",
				baseUrl: "https://chatgpt.com/backend-api/codex",
			})
		: buildModel<"azure-openai-responses">({
				...spec,
				api: "azure-openai-responses",
				provider: "azure",
				baseUrl: "https://example.openai.azure.com/openai/v1",
			});
}

describe("Responses escaped function tool names", () => {
	test("Muse requests escape every declaration and reconstructed call without changing Meta requests", () => {
		const context: Context = { tools, messages: [assistant(tools.map(tool => tool.name))] };
		expect(requestNames(context, "meta")).toEqual({
			tools: ["bash", "web_search", "read", "_private"],
			calls: ["bash", "web_search", "read", "_private"],
		});
		const codex = buildModel({ ...model("openai-codex"), api: "openai-codex-responses", compat: undefined });
		const input = buildResponsesInput({
			model: codex,
			context: { messages: [assistant(["bash", "_private"])] },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
		});
		expect(input.filter(item => item.type === "function_call").map(item => item.name)).toEqual(["bash", "_private"]);
		expect(requestNames(context)).toEqual({
			tools: ["_bash", "_web_search", "_read", "__private"],
			calls: ["_bash", "_web_search", "_read", "__private"],
		});
	});

	test.each([
		{ label: "only the literal-prefixed tool", roster: ["_x"] },
		{ label: "both colliding tool names", roster: ["x", "_x"] },
	])("keeps native call identity when offering $label", ({ roster }) => {
		for (const delta of [true, false]) {
			const previous = assistant(["x", "_x"]);
			for (const [index, block] of previous.content.entries()) {
				if (block.type === "toolCall") block.id = `call_${index}|fc_${index}`;
			}
			previous.content.reverse();
			previous.providerPayload = createOpenAIResponsesHistoryPayload(
				"muse-code",
				[0, 1].map(index => ({
					type: "function_call",
					id: `fc_${index}`,
					call_id: `call_${index}`,
					name: "_x",
					arguments: '{"command":"echo muse-ok"}',
				})),
				delta,
			);
			const context: Context = {
				tools: roster.map(name => ({ ...tools[0], name })),
				messages: [previous],
			};
			expect(requestNames(context).calls).toEqual(["_x", "__x"]);
		}
	});

	test("keeps native wire names when a snapshot reuses a call id", () => {
		const wireNames = ["_read", "_bash"];
		const previous = assistant(["bash"]);
		for (const block of previous.content) {
			if (block.type === "toolCall") block.id = "call_reused|fc_current";
		}
		const items: Record<string, unknown>[] = [];
		for (const [index, name] of wireNames.entries()) {
			items.push({
				type: "function_call",
				id: `fc_${index}`,
				call_id: "call_reused",
				name,
				arguments: '{"command":"echo muse-ok"}',
			});
			if (index < wireNames.length - 1)
				items.push({ type: "function_call_output", call_id: "call_reused", output: "earlier result" });
		}
		previous.providerPayload = createOpenAIResponsesHistoryPayload("muse-code", items, false);
		expect(requestNames({ tools, messages: [previous] }).calls).toEqual(wireNames);
	});

	test("escapes OpenRouter Responses tool names without changing the flag-off path", async () => {
		for (const escape of [false, true]) {
			const target = buildModel<"openrouter">({
				id: "openai/gpt-5.5",
				name: "GPT-5.5 via OpenRouter",
				api: "openrouter",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 8192,
				compat: { escapeBuiltinToolNames: escape, supportsToolChoice: true, supportsNamedToolChoice: true },
			});
			const previous: AssistantMessage = {
				...assistant(["bash"]),
				api: target.api,
				provider: target.provider,
				model: target.id,
			};
			// The Responses dispatcher forwards OpenRouter models without changing their API.
			const { params } = buildParams(
				target as unknown as Model<"openai-responses">,
				{ tools: [tools[0]], messages: [previous] },
				{ toolChoice: { type: "tool", name: "bash" } },
				undefined,
			);
			const wireName = escape ? "_bash" : "bash";
			expect(params.tools?.filter(tool => tool.type === "function").map(tool => tool.name)).toEqual([wireName]);
			expect(params.input?.filter(item => item.type === "function_call").map(item => item.name)).toEqual([wireName]);
			expect(params.tool_choice).toEqual({ type: "function", name: wireName });
			const output = createInitialResponsesAssistantMessage(target.api, target.provider, target.id);
			async function* source() {
				const item = {
					type: "function_call",
					id: "fc_reply",
					call_id: "call_reply",
					name: "_bash",
					arguments: '{"command":"echo muse-ok"}',
				};
				yield { type: "response.output_item.added", output_index: 0, item } as ResponseStreamEvent;
				yield { type: "response.output_item.done", output_index: 0, item } as ResponseStreamEvent;
				yield {
					type: "response.completed",
					response: { id: "resp_router", status: "completed" },
				} as ResponseStreamEvent;
			}
			const stream = { push() {}, end() {} } as unknown as AssistantMessageEventStream;
			await processResponsesStream(source(), output, stream, target);
			expect(output.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual([
				escape ? "bash" : "_bash",
			]);
		}
	});

	test.each(["azure-openai-responses", "openai-codex-responses"] as const)(
		"ignores the escape axis in %s requests",
		async api => {
			const bodies: string[] = [];
			for (const escape of [false, true]) {
				const target = alternateResponsesModel(api, escape);
				const previous: AssistantMessage = {
					...assistant(["_x"]),
					api: target.api,
					provider: target.provider,
					model: target.id,
					providerPayload: createOpenAIResponsesHistoryPayload(target.provider, [
						{ type: "function_call", call_id: "call_0", name: "_x", arguments: '{"command":"echo muse-ok"}' },
					]),
				};
				const reconstructed: AssistantMessage = {
					...previous,
					providerPayload: undefined,
					content: [{ type: "toolCall", id: "call_next", name: "_x", arguments: { command: "echo muse-ok" } }],
				};
				const context: Context = { tools: [{ ...tools[0], name: "_x" }], messages: [previous, reconstructed] };
				const toolChoice = { type: "tool", name: "_x" } as const;
				if (target.api === "openai-codex-responses") {
					bodies.push(JSON.stringify(await buildTransformedCodexRequestBody(target, context, { toolChoice })));
				} else {
					const capture = Promise.withResolvers<string>();
					const stream = streamAzureOpenAIResponses(target, context, {
						apiKey: "test-key",
						azureBaseUrl: target.baseUrl,
						signal: AbortSignal.abort(),
						toolChoice,
						onPayload: payload => capture.resolve(JSON.stringify(payload)),
					});
					bodies.push(await capture.promise);
					await stream.result();
				}
			}
			const unescaped = JSON.parse(bodies[0]);
			expect(unescaped.tools.map((tool: { name: string }) => tool.name)).toEqual(["_x"]);
			expect(unescaped.tool_choice).toEqual({ type: "function", name: "_x" });
			expect(
				unescaped.input
					.filter((item: { type: string }) => item.type === "function_call")
					.map((item: { name: string }) => item.name),
			).toEqual(["_x", "_x"]);
			expect(bodies[1]).toBe(bodies[0]);
		},
	);

	test.each(["azure-openai-responses", "openai-codex-responses"] as const)(
		"ignores the escape axis in %s streams",
		async api => {
			const results = [];
			for (const escape of [false, true]) {
				const target = alternateResponsesModel(api, escape);
				const output = createInitialResponsesAssistantMessage(target.api, target.provider, target.id);
				const starts: string[] = [];
				const ends: string[] = [];
				const stream = {
					push(event: AssistantMessageEvent) {
						if (event.type === "toolcall_start") {
							const block = event.partial.content[event.contentIndex];
							if (block.type === "toolCall") starts.push(block.name);
						}
						if (event.type === "toolcall_end") ends.push(event.toolCall.name);
					},
					end() {},
				} as AssistantMessageEventStream;
				async function* source() {
					for (const [output_index, name] of ["_x", "_y"].entries()) {
						const item = {
							type: "function_call",
							id: `fc_${output_index}`,
							call_id: `call_${output_index}`,
							name,
							arguments: '{"command":"echo muse-ok"}',
						};
						if (output_index === 0)
							yield { type: "response.output_item.added", output_index, item } as ResponseStreamEvent;
						yield { type: "response.output_item.done", output_index, item } as ResponseStreamEvent;
					}
					yield {
						type: "response.completed",
						response: { id: "resp_unescaped", status: "completed" },
					} as ResponseStreamEvent;
				}
				await processResponsesStream(source(), output, stream, target);
				results.push({ content: output.content, starts, ends });
			}
			expect(results[0].starts).toEqual(["_x"]);
			expect(results[0].ends).toEqual(["_x", "_y"]);
			expect(results[1]).toEqual(results[0]);
		},
	);

	test.each(["assistant delta", "assistant snapshot", "user snapshot"] as const)(
		"escapes legacy names without double-prefixing native %s replay",
		replay => {
			const names = ["_bash", "web_search", replay === "user snapshot" ? "__private" : "_private"];
			const items = names.map((name, index) => ({
				type: "function_call",
				call_id: `call_${index}`,
				name,
				arguments: '{"command":"echo muse-ok"}',
			}));
			const payload = createOpenAIResponsesHistoryPayload("muse-code", items, replay === "assistant delta");
			const context: Context = {
				tools,
				messages: [
					replay === "user snapshot"
						? { role: "user", content: "compacted history", timestamp: 0, providerPayload: payload }
						: { ...assistant(["bash", "web_search", "_private"]), providerPayload: payload },
				],
			};
			expect(requestNames(context).calls).toEqual(["_bash", "_web_search", "__private"]);
			expect(items.map(item => item.name)).toEqual(names);
		},
	);

	test("uses escaped forced choices after schema quarantine and string-only tool-choice filtering", () => {
		const badTool: Tool = {
			name: "invalid",
			description: "Invalid schema",
			parameters: {
				type: "object",
				properties: { choice: { type: "null", enum: ["A"] } },
			} as unknown as Tool["parameters"],
		};
		const context: Context = { tools: [...tools, badTool], messages: [] };
		for (const supportsNamedToolChoice of [true, false]) {
			const { params } = buildParams(
				model("muse-code", { supportsToolChoice: true, supportsNamedToolChoice }),
				context,
				{ toolChoice: { type: "tool", name: "bash" } },
				undefined,
			);
			expect(params.tool_choice).toEqual(supportsNamedToolChoice ? { type: "function", name: "_bash" } : "required");
			expect(params.tools?.filter(tool => tool.type === "function").map(tool => tool.name)).toEqual(
				supportsNamedToolChoice ? ["_bash", "_web_search", "_read", "__private"] : ["_bash"],
			);
		}
	});

	test("escapes downgraded custom calls but preserves supported freeform wire names", () => {
		const edit: Tool = {
			name: "edit",
			customWireName: "apply_patch",
			description: "Apply a patch",
			parameters: type({ input: "string" }),
			customFormat: { syntax: "lark", definition: 'start: "patch"' },
		};
		const message = assistant(["apply_patch"]);
		message.content = [
			{
				type: "toolCall",
				id: "call_patch",
				name: "apply_patch",
				customWireName: "apply_patch",
				arguments: { input: "patch" },
			},
		];
		const context: Context = { tools: [edit], messages: [message] };
		const freeformModel = { ...model(), applyPatchToolType: "freeform" as const };
		const { params: freeform } = buildParams(freeformModel, context, undefined, undefined);
		expect(freeform.tools).toEqual([expect.objectContaining({ type: "custom", name: "apply_patch" })]);
		expect(freeform.input).toContainEqual(expect.objectContaining({ type: "custom_tool_call", name: "apply_patch" }));
		expect(requestNames(context)).toEqual({ tools: ["_edit"], calls: ["_edit"] });
		message.providerPayload = createOpenAIResponsesHistoryPayload("muse-code", [
			{ type: "custom_tool_call", id: "ctc_patch", call_id: "call_patch", name: "apply_patch", input: "patch" },
		]);
		expect(requestNames(context)).toEqual({ tools: ["_edit"], calls: ["_edit"] });
	});

	test("escapes function-backed computer choices without changing native computer tools", () => {
		const computer: Tool = {
			name: "computer",
			description: "Control the desktop",
			parameters: type({}),
			native: { type: "computer" },
		};
		const context: Context = { tools: [computer], messages: [] };
		const target = model("muse-code", { supportsToolChoice: true });
		for (const choice of [{ type: "computer" }, { type: "tool", name: "computer" }] as const) {
			const { params } = buildParams(target, context, { toolChoice: choice }, undefined);
			expect(params.tool_choice).toEqual({ type: "function", name: "_computer" });
			expect(params.tools).toEqual([expect.objectContaining({ type: "function", name: "_computer" })]);
		}
		const { params } = buildParams(
			{ ...target, supportsComputerUse: true },
			context,
			{ toolChoice: { type: "computer" } },
			undefined,
		);
		expect(params.tools).toEqual([{ type: "computer" }]);
		expect(params.tool_choice).toEqual({ type: "computer" });
	});

	test.each(["streamed", "done-only"] as const)(
		"decodes %s calls for dispatch, accepting prefixed and plain names",
		async path => {
			const names = ["_bash", "bash", "__private"];
			const events: ResponseStreamEvent[] = [];
			for (const [output_index, name] of names.entries()) {
				const item = {
					type: "function_call" as const,
					id: `fc_${output_index}`,
					call_id: `call_${output_index}`,
					name,
					arguments: '{"command":"echo muse-ok"}',
				};
				if (path === "streamed")
					events.push({ type: "response.output_item.added", output_index, item } as ResponseStreamEvent);
				events.push({ type: "response.output_item.done", output_index, item } as ResponseStreamEvent);
			}
			const custom = {
				type: "custom_tool_call",
				id: "ctc_patch",
				call_id: "call_patch",
				name: "_apply_patch",
				input: "patch",
			};
			if (path === "streamed")
				events.push({ type: "response.output_item.added", output_index: 3, item: custom } as ResponseStreamEvent);
			events.push({ type: "response.output_item.done", output_index: 3, item: custom } as ResponseStreamEvent);
			events.push({
				type: "response.completed",
				response: { id: "resp_names", status: "completed" },
			} as ResponseStreamEvent);
			async function* source() {
				yield* events;
			}
			const output = createInitialResponsesAssistantMessage("openai-responses", "muse-code", "muse-wonder-full-1.0");
			const starts: string[] = [];
			const ends: string[] = [];
			const stream = {
				push(event: AssistantMessageEvent) {
					if (event.type === "toolcall_start") {
						const block = event.partial.content[event.contentIndex];
						if (block.type === "toolCall") starts.push(block.name);
					}
					if (event.type === "toolcall_end") ends.push(event.toolCall.name);
				},
				end() {},
			} as AssistantMessageEventStream;
			await processResponsesStream(source(), output, stream, model());
			expect(output.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual([
				"bash",
				"bash",
				"_private",
				"_apply_patch",
			]);
			expect(ends).toEqual(["bash", "bash", "_private", "_apply_patch"]);
			expect(starts).toEqual(path === "streamed" ? ["bash", "bash", "_private", "_apply_patch"] : []);
			const unescaped = createInitialResponsesAssistantMessage("openai-responses", "meta", "muse-wonder-full-1.0");
			await processResponsesStream(source(), unescaped, stream, model("meta"));
			expect(unescaped.content.filter(block => block.type === "toolCall").map(block => block.name)).toEqual([
				...names,
				"_apply_patch",
			]);
		},
	);
});
