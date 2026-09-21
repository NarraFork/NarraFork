import { afterEach, describe, expect, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "../../net/outbound-fetch";
import { AnthropicProvider, parseAnthropicSSEStream } from "../anthropic-provider";
import { CodexProvider } from "../codex-provider";
import { GeminiInteractionsProvider } from "../gemini-interactions-provider";
import { GeminiProvider } from "../gemini-provider";
import { NugProvider } from "../nug-provider";
import {
	OpenAIProvider,
	parseResponsesAPIEvent,
	type ResponsesAPIChunk,
	type ResponsesReasoningAccum,
	type ResponsesToolAccum,
} from "../openai-provider";
import type { ChatParams, ParsedStreamEvent, ProviderAdapter } from "../provider";
import type { ContentBlock } from "../types";

const config = {
	id: "boundaries",
	name: "Boundaries",
	prefix: "boundaries",
	apiKey: "test-key",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "gpt-5",
};

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function collect(stream: AsyncGenerator<ParsedStreamEvent>): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function chatParams(model = "boundaries:gpt-5"): ChatParams {
	return {
		conversationId: "boundary-test",
		content: "hello",
		model,
		cwd: process.cwd(),
		history: [],
		tools: [],
		toolResults: [],
		signal: new AbortController().signal,
	};
}

function responsesParser() {
	const tools = new Map<number, ResponsesToolAccum>();
	const reasoning = new Map<number, ResponsesReasoningAccum>();
	return (chunk: ResponsesAPIChunk) => parseResponsesAPIEvent(chunk, tools, reasoning);
}

function replay(provider: ProviderAdapter, blocks: ContentBlock[]): unknown[] {
	const history: unknown[] = [];
	provider.pushAssistantTurn(
		history,
		"ignored flat text",
		[],
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		blocks,
	);
	return history;
}

afterEach(() => setOutboundFetchOverrideForTest(null));

describe("native content boundaries", () => {
	test("Anthropic completes signed and unsigned thinking and text at their native stops", async () => {
		const events = await collect(
			parseAnthropicSSEStream(
				sse([
					{ type: "message_start", message: { id: "msg_1" } },
					{ type: "content_block_start", index: 0, content_block: { type: "thinking" } },
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "thinking_delta", thinking: "signed" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "signature_delta", signature: "sig-1" },
					},
					{ type: "content_block_stop", index: 0 },
					{
						type: "content_block_start",
						index: 1,
						content_block: { type: "thinking", thinking: "unsigned" },
					},
					{ type: "content_block_stop", index: 1 },
					{ type: "content_block_start", index: 2, content_block: { type: "text", text: "start" } },
					{ type: "content_block_delta", index: 2, delta: { type: "text_delta", text: " end" } },
					{ type: "content_block_stop", index: 2 },
					{ type: "message_stop" },
				]).body as ReadableStream<Uint8Array>,
			),
		);
		const complete = events.filter((event) => event.contentBoundary?.phase === "complete");
		expect(complete.map((event) => event.contentBoundary)).toEqual([
			{ kind: "reasoning", phase: "complete", blockId: "anthropic:0", outputIndex: 0 },
			{ kind: "reasoning", phase: "complete", blockId: "anthropic:1", outputIndex: 1 },
			{ kind: "text", phase: "complete", blockId: "anthropic:2", outputIndex: 2 },
		]);
		const signatureIndex = events.findIndex(
			(event) => event.reasoningMetadata?.anthropic?.signature === "sig-1",
		);
		expect(events[signatureIndex + 1]).toBe(complete[0]);
		expect(
			events.filter((event) => event.reasoning).map((event) => event.reasoningBlockId),
		).toEqual(["anthropic:0", "anthropic:1"]);
		expect(events.map((event) => event.text ?? "").join("")).toBe("start end");
	});

	test("Responses summary done checkpoints one native item until final encrypted metadata", () => {
		const parse = responsesParser();
		parse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "rs_1", encrypted_content: "draft" },
		});
		const first = parse({
			type: "response.reasoning_summary_text.delta",
			output_index: 0,
			item_id: "rs_1",
			summary_index: 0,
			delta: "first",
		});
		const checkpoint = parse({
			type: "response.reasoning_summary_text.done",
			output_index: 0,
			item_id: "rs_1",
			summary_index: 0,
			text: "first",
		});
		const second = parse({
			type: "response.reasoning_summary_text.done",
			output_index: 0,
			item_id: "rs_1",
			summary_index: 1,
			text: "second",
		});
		const done = parse({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "reasoning",
				id: "rs_1",
				encrypted_content: "final",
				summary: [
					{ type: "summary_text", text: "first" },
					{ type: "summary_text", text: "second" },
				],
			},
		});
		expect(checkpoint.at(-1)?.contentBoundary?.phase).toBe("checkpoint");
		expect(second.find((event) => event.reasoning)?.reasoning).toBe("\n\nsecond");
		expect(first[0].reasoningBlockId).toBe(second[0].reasoningBlockId);
		expect(done.some((event) => event.reasoning)).toBe(false);
		expect(done.at(-2)?.reasoningMetadata?.openai?.reasoningEncryptedContent).toBe("final");
		expect(done.at(-1)?.contentBoundary).toEqual({
			kind: "reasoning",
			phase: "complete",
			blockId: first[0].reasoningBlockId,
			outputIndex: 0,
		});
		const another = parse({
			type: "response.reasoning_text.delta",
			output_index: 1,
			item_id: "rs_2",
			delta: "next",
		});
		expect(another[0].reasoningBlockId).not.toBe(first[0].reasoningBlockId);
	});

	test("Responses text items and content_index have distinct identities and citations precede complete", () => {
		const parse = responsesParser();
		const first = parse({
			type: "response.output_text.delta",
			output_index: 2,
			item_id: "msg_1",
			content_index: 0,
			delta: "before",
		})[0];
		const second = parse({
			type: "response.output_text.delta",
			output_index: 2,
			item_id: "msg_1",
			content_index: 1,
			delta: "after",
		})[0];
		expect(first.textBlockId).not.toBe(second.textBlockId);
		const checkpoint = parse({
			type: "response.output_text.done",
			output_index: 2,
			item_id: "msg_1",
			content_index: 1,
			text: "after",
		});
		expect(checkpoint.some((event) => event.text)).toBe(false);
		expect(checkpoint.at(-1)?.contentBoundary?.phase).toBe("checkpoint");
		const done = parse({
			type: "response.output_item.done",
			output_index: 2,
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				content: [
					{ type: "output_text", text: "before" },
					{
						type: "output_text",
						text: "after",
						annotations: [{ type: "url_citation", end_index: 5, url: "https://example.test" }],
					},
				],
			},
		});
		const citationIndex = done.findIndex((event) => event.textCitations);
		expect(done[citationIndex].textBlockId).toBe(second.textBlockId);
		expect(done[citationIndex + 1].contentBoundary?.blockId).toBe(second.textBlockId);
		expect(done[citationIndex + 1].contentBoundary?.phase).toBe("complete");
		expect(done.some((event) => event.text)).toBe(false);
		const standalone = parse({
			type: "response.output_item.done",
			output_index: 3,
			item: { type: "output_text", id: "text_3", text: "standalone" },
		});
		expect(standalone[0].text).toBe("standalone");
		expect(standalone[0].textBlockId).not.toBe(first.textBlockId);
		expect(standalone.at(-1)?.contentBoundary?.phase).toBe("complete");
	});

	test("Responses item_id-only deltas and index-only finals resolve the same lanes", () => {
		const parse = responsesParser();
		const start = parse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "reasoning", id: "rs_alias" },
		});
		const delta = parse({
			type: "response.reasoning_text.delta",
			item_id: "rs_alias",
			delta: "thought",
		});
		const done = parse({
			type: "response.output_item.done",
			output_index: 0,
			item: { type: "reasoning", id: "rs_alias", encrypted_content: "final" },
		});
		expect(delta[0].reasoningBlockId).toBe(start[0].contentBoundary?.blockId);
		expect(done.at(-1)?.contentBoundary?.blockId).toBe(delta[0].reasoningBlockId);
		parse({
			type: "response.output_item.added",
			output_index: 1,
			item: { type: "message", role: "assistant", id: "msg_alias" },
		});
		const text = parse({
			type: "response.output_text.delta",
			item_id: "msg_alias",
			content_index: 2,
			delta: "answer",
		})[0];
		expect(text.textBlockId).toBe("responses:1:text:2");
		expect(text.textOutputIndex).toBe(1);
		const textDone = parse({
			type: "response.output_text.done",
			output_index: 1,
			content_index: 2,
			text: "answer",
		});
		expect(textDone.at(-1)?.contentBoundary?.blockId).toBe(text.textBlockId);
	});

	test("Responses repeated done events and completed snapshots emit content completion only once", () => {
		const parse = responsesParser();
		const reasoning = {
			type: "reasoning",
			id: "rs_repeat",
			encrypted_content: "final",
			summary: [{ type: "summary_text", text: "thought" }],
		};
		const text = {
			type: "message",
			role: "assistant",
			id: "msg_repeat",
			content: [
				{
					type: "output_text",
					text: "answer",
					annotations: [{ type: "url_citation", end_index: 6, url: "https://example.test" }],
				},
			],
		};
		const first = [
			...parse({ type: "response.output_item.done", output_index: 0, item: reasoning }),
			...parse({ type: "response.output_item.done", output_index: 1, item: text }),
		];
		const repeated = [
			...parse({ type: "response.output_item.done", output_index: 0, item: reasoning }),
			...parse({ type: "response.output_item.done", output_index: 1, item: text }),
			...parse({ type: "response.completed", response: { output: [reasoning, text] } }),
		];
		expect(first.filter((event) => event.contentBoundary?.phase === "complete")).toHaveLength(2);
		expect(
			repeated.filter(
				(event) =>
					event.contentBoundary ||
					event.text ||
					event.reasoning ||
					event.reasoningMetadata ||
					event.textCitations,
			),
		).toHaveLength(0);
		const fallback = responsesParser()({
			type: "response.completed",
			response: { output: [reasoning, text] },
		});
		const citationIndex = fallback.findIndex((event) => event.textCitations);
		expect(fallback[citationIndex + 1].contentBoundary?.phase).toBe("complete");
	});

	test("Responses tool chunks retain their native output index", () => {
		const parse = responsesParser();
		const events = [
			...parse({
				type: "response.output_item.added",
				output_index: 7,
				item: { type: "function_call", call_id: "call_1", name: "Read" },
			}),
			...parse({ type: "response.function_call_arguments.delta", output_index: 7, delta: "{}" }),
		];
		expect(
			events.filter((event) => event.toolUseChunk).map((event) => event.toolUseChunk?.outputIndex),
		).toEqual([7, 7, 7]);
	});

	test("Chat emits same-chunk reasoning and text before tools", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sse([
				{
					choices: [
						{
							delta: {
								reasoning_content: "think",
								content: "answer",
								tool_calls: [
									{ index: 0, id: "call_1", function: { name: "Read", arguments: "{}" } },
								],
							},
							finish_reason: "tool_calls",
						},
					],
				},
			]),
		);
		const events = await collect(
			new OpenAIProvider({ ...config, apiMode: "completions" }).chat(chatParams()),
		);
		expect(events[0].reasoning).toBe("think");
		expect(events[1].text).toBe("answer");
		expect(events[2].toolUseChunk?.toolUseId).toBe("call_1");
	});

	test("Gemini generateContent merges same-lane deltas, not distinct parts or tools", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sse([
				{ candidates: [{ index: 0, content: { parts: [{ thought: true, text: "a" }] } }] },
				{
					candidates: [
						{
							index: 0,
							content: { parts: [{ thought: true, text: "b" }, { text: "one" }, { text: "two" }] },
						},
					],
				},
				{ candidates: [{ index: 0, content: { parts: [{ text: "tail" }] } }] },
				{
					candidates: [
						{
							index: 0,
							content: { parts: [{ functionCall: { name: "Read", args: {} } }, { text: "after" }] },
							finishReason: "STOP",
						},
					],
				},
			]),
		);
		const events = await collect(
			new GeminiProvider({ ...config, defaultModel: "gemini-2.5-flash" }).chat(
				chatParams("boundaries:gemini-2.5-flash"),
			),
		);
		const reasoning = events.filter((event) => event.reasoning);
		expect(reasoning[0].reasoningBlockId).toBe(reasoning[1].reasoningBlockId);
		const text = events.filter((event) => event.text);
		expect(text[0].textBlockId).not.toBe(text[1].textBlockId);
		expect(text[1].textBlockId).toBe(text[2].textBlockId);
		expect(text[2].textBlockId).not.toBe(text[3].textBlockId);
		expect(events.find((event) => event.toolUseChunk)?.toolUseChunk?.outputIndex).toBe(3);
		expect(text[3].textOutputIndex).toBe(4);
	});

	test("Gemini Interactions distinguishes native step IDs when optional indices are omitted", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sse([
				{
					event_type: "step.start",
					step: { type: "model_output", id: "step_a", content: "first" },
				},
				{ event_type: "step.stop" },
				{
					event_type: "step.start",
					step: { type: "model_output", id: "step_b", content: "second" },
				},
				{ event_type: "step.stop" },
				{ event_type: "interaction.completed", interaction: { status: "completed" } },
			]),
		);
		const events = await collect(
			new GeminiInteractionsProvider({ ...config, geminiTransport: "interactions" }).chat(
				chatParams("boundaries:gemini-3-flash-preview"),
			),
		);
		const texts = events.filter((event) => event.text);
		expect(texts.map((event) => event.textBlockId)).toEqual([
			"gemini:step:step_a",
			"gemini:step:step_b",
		]);
		expect(
			events
				.filter((event) => event.contentBoundary)
				.map((event) => event.contentBoundary?.blockId),
		).toEqual(texts.map((event) => event.textBlockId));
	});

	test("Gemini Interactions recovers stop-only final text before completion without duplicating prefixes", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sse([
				{ event_type: "step.start", index: 0, step: { type: "thought", id: "thought_final" } },
				{
					event_type: "step.stop",
					index: 0,
					step: {
						type: "thought",
						summary: [{ type: "text", text: "final thought" }],
						signature: "final-signature",
					},
				},
				{ event_type: "step.start", index: 1, step: { type: "model_output", content: "hel" } },
				{ event_type: "step.stop", index: 1, step: { type: "model_output", content: "hello" } },
				{ event_type: "interaction.completed", interaction: { status: "completed" } },
			]),
		);
		const events = await collect(
			new GeminiInteractionsProvider({ ...config, geminiTransport: "interactions" }).chat(
				chatParams("boundaries:gemini-3-flash-preview"),
			),
		);
		expect(events.map((event) => event.reasoning ?? "").join("")).toBe("final thought");
		expect(events.map((event) => event.text ?? "").join("")).toBe("hello");
		const textComplete = events.findIndex((event) => event.contentBoundary?.kind === "text");
		expect(events[textComplete - 1].text).toBe("lo");
		const thoughtComplete = events.findIndex(
			(event) => event.contentBoundary?.kind === "reasoning",
		);
		expect(events[thoughtComplete - 1].reasoningMetadata?.gemini?.thoughtSignature).toBe(
			"final-signature",
		);
	});

	test("Gemini Interactions completes text/thought steps after final metadata, even unsigned", async () => {
		setOutboundFetchOverrideForTest(async () =>
			sse([
				{ event_type: "step.start", index: 0, step: { type: "thought", id: "th_1" } },
				{ event_type: "step.delta", index: 0, delta: { type: "text", text: "thought" } },
				{ event_type: "step.stop", index: 0, step: { type: "thought", signature: "final" } },
				{
					event_type: "step.start",
					index: 1,
					step: { type: "thought", id: "th_2", summary: [{ type: "text", text: "unsigned" }] },
				},
				{ event_type: "step.stop", index: 1 },
				{ event_type: "step.start", index: 2, step: { type: "model_output", content: "hello" } },
				{ event_type: "step.stop", index: 2 },
				{ event_type: "interaction.completed", interaction: { status: "completed" } },
			]),
		);
		const provider = new GeminiInteractionsProvider({
			...config,
			defaultModel: "gemini-3-flash-preview",
			geminiTransport: "interactions",
		});
		const events = await collect(provider.chat(chatParams("boundaries:gemini-3-flash-preview")));
		const signatureIndex = events.findIndex(
			(event) => event.reasoningMetadata?.gemini?.thoughtSignature === "final",
		);
		expect(events[signatureIndex + 1].contentBoundary).toEqual({
			kind: "reasoning",
			phase: "complete",
			blockId: "gemini:step:th_1",
			outputIndex: 0,
		});
		expect(
			events
				.filter((event) => event.contentBoundary?.phase === "complete")
				.map((event) => event.contentBoundary?.blockId),
		).toEqual(["gemini:step:th_1", "gemini:step:th_2", "gemini:step:2"]);
	});
});

describe("ordered assistant replay", () => {
	const blocks: ContentBlock[] = [
		{ type: "text", text: "before", outputIndex: 9 },
		{ type: "tool_use", toolUseId: "call_1", name: "Read", input: {}, outputIndex: 0 },
		{ type: "text", text: "after", outputIndex: 1 },
	];

	test("Anthropic preserves encounter order and whole signed thinking items", () => {
		const history = replay(new AnthropicProvider(config), [
			{
				type: "reasoning",
				text: "one\n\ntwo",
				providerMetadata: { anthropic: { signature: "sig1" } },
			},
			...blocks,
			{ type: "reasoning", text: "three", providerMetadata: { anthropic: { signature: "sig2" } } },
			{ type: "redacted_thinking", data: "opaque" },
		]) as Array<{ content: Array<Record<string, unknown>> }>;
		expect(history[0].content.map((block) => block.type)).toEqual([
			"thinking",
			"text",
			"tool_use",
			"text",
			"thinking",
			"redacted_thinking",
		]);
		expect(history[0].content[0]).toEqual({
			type: "thinking",
			thinking: "one\n\ntwo",
			signature: "sig1",
		});
		expect(history[0].content[4].signature).toBe("sig2");
	});

	test("Responses replays text-tool-text, independent text items, and opaque native reasoning once", () => {
		const provider = new OpenAIProvider({ ...config, apiMode: "responses" });
		const reasoning = (itemId: string, text: string): ContentBlock => ({
			type: "reasoning",
			text,
			providerMetadata: {
				signatureSource: provider.getActiveReasoningSource(),
				openai: { itemId, reasoningEncryptedContent: `encrypted-${itemId}` },
			},
		});
		const history = replay(provider, [
			reasoning("rs_1", "one\n\ntwo"),
			...blocks,
			{ type: "text", text: "separate" },
			reasoning("rs_2", "three"),
		]) as Array<Record<string, unknown>>;
		expect(history.map((item) => item.type ?? item.role)).toEqual([
			"reasoning",
			"assistant",
			"function_call",
			"assistant",
			"assistant",
			"reasoning",
		]);
		expect(history[0]).toMatchObject({
			id: "rs_1",
			encrypted_content: "encrypted-rs_1",
			summary: [{ type: "summary_text", text: "one\n\ntwo" }],
		});
		expect(history.at(-1)).toMatchObject({ id: "rs_2", encrypted_content: "encrypted-rs_2" });
		const foreign = replay(provider, [
			{
				type: "reasoning",
				text: "foreign",
				providerMetadata: {
					signatureSource: "another",
					openai: { itemId: "rs_other", reasoningEncryptedContent: "secret" },
				},
			},
			...blocks,
		]);
		expect(JSON.stringify(foreign)).not.toContain("secret");
	});

	test("NUG forwards ordered content to its active delegate", () => {
		const provider = Object.create(NugProvider.prototype) as NugProvider;
		(provider as unknown as { activeDelegate: ProviderAdapter }).activeDelegate =
			new OpenAIProvider({ ...config, apiMode: "responses" });
		const history = replay(provider, blocks) as Array<Record<string, unknown>>;
		expect(history.map((item) => item.type ?? item.role)).toEqual([
			"assistant",
			"function_call",
			"assistant",
		]);
		expect(JSON.stringify(history)).not.toContain("ignored flat text");
	});

	test("Codex forwards ordered content instead of falling back to flat text", () => {
		const history = replay(new CodexProvider({}), blocks) as Array<Record<string, unknown>>;
		expect(history.map((item) => item.type ?? item.role)).toEqual([
			"assistant",
			"function_call",
			"assistant",
		]);
		expect(JSON.stringify(history)).not.toContain("ignored flat text");
	});

	test("Gemini transports preserve text-tool-text and signed whole thought parts", () => {
		const generate = new GeminiProvider(config);
		const interactions = new GeminiInteractionsProvider({
			...config,
			geminiTransport: "interactions",
		});
		for (const provider of [generate, interactions]) {
			const thought: ContentBlock = {
				type: "reasoning",
				text: "one\n\ntwo",
				providerMetadata: {
					signatureSource: provider.getActiveReasoningSource(),
					gemini: { stepId: "thought_1", thoughtSignature: "sig" },
				},
			};
			const history = replay(provider, [thought, ...blocks]) as Array<Record<string, unknown>>;
			if (provider === generate) {
				expect(history[0].parts).toEqual([
					{ text: "one\n\ntwo", thought: true, thoughtSignature: "sig" },
					{ text: "before" },
					{ functionCall: { name: "Read", args: {} } },
					{ text: "after" },
				]);
			} else {
				expect(history.map((item) => item.type)).toEqual([
					"thought",
					"model_output",
					"function_call",
					"model_output",
				]);
				expect(history[0]).toMatchObject({
					signature: "sig",
					summary: [{ type: "text", text: "one\n\ntwo" }],
				});
			}
		}
	});
});
