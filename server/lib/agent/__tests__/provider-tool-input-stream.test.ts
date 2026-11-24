import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "../../net/outbound-fetch";
import { parseAnthropicEvent, parseAnthropicSSEStream } from "../anthropic-provider";
import {
	OpenAIProvider,
	parseResponsesAPIEvent,
	type ResponsesAPIChunk,
	type ResponsesToolAccum,
} from "../openai-provider";
import type { ParsedStreamEvent } from "../provider";
import { ToolInputStream } from "../tool-input-stream";

const config = {
	id: "input-stream",
	name: "Input stream",
	prefix: "input-stream",
	apiKey: "test",
	baseUrl: "https://example.invalid/v1",
	defaultModel: "gpt-5",
};

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
async function collect(stream: AsyncGenerator<ParsedStreamEvent>): Promise<ParsedStreamEvent[]> {
	const events = [];
	for await (const event of stream) events.push(event);
	return events;
}
async function chat(events: unknown[]): Promise<ParsedStreamEvent[]> {
	setOutboundFetchOverrideForTest(async () => sse(events));
	return collect(
		new OpenAIProvider({ ...config, apiMode: "completions" }).chat({
			conversationId: "test",
			content: "test",
			model: "input-stream:gpt-5",
			cwd: process.cwd(),
			history: [],
			tools: [],
			toolResults: [],
			signal: new AbortController().signal,
		}),
	);
}
function responsesParser() {
	const tools = new Map<number, ResponsesToolAccum>();
	const reasoning = new Map();
	return {
		tools,
		parse: (event: ResponsesAPIChunk) => parseResponsesAPIEvent(event, tools, reasoning),
	};
}
afterEach(() => setOutboundFetchOverrideForTest(null));

describe("provider incremental tool arguments", () => {
	test("Responses feeds only new characters and eager-stops once at a valid root", () => {
		const { tools, parse } = responsesParser();
		const raw = JSON.stringify({ file_path: "x", content: '😀\\"}\r\n'.repeat(1000) });
		parse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", call_id: "call", name: "Write" },
		});
		const events = [];
		for (let i = 0; i < raw.length; i++) {
			events.push(
				...parse({
					type: "response.function_call_arguments.delta",
					output_index: 0,
					delta: raw[i],
				}),
			);
			if (i < raw.length - 1) expect(tools.get(0)?.inputStream?.stats.parseAttempts).toBe(0);
		}
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		expect(events.flatMap((event) => event.toolUseChunk?.input ?? []).join("")).toBe(raw);
		expect(tools.get(0)?.inputStream?.stats).toEqual({
			scannedChars: raw.length,
			parseAttempts: 1,
			rawMaterializations: 1,
			fieldMaterializations: 0,
		});
		expect(
			parse({ type: "response.function_call_arguments.done", output_index: 0, arguments: raw }),
		).toEqual([]);
	});

	test("Responses authoritative done snapshot is not a fake append; done-only and initial inputs survive", () => {
		const { parse } = responsesParser();
		parse({
			type: "response.output_item.added",
			output_index: 0,
			item: {
				type: "function_call",
				call_id: "call",
				name: "Write",
				arguments: '{"content":"draft',
			},
		});
		const raw = '{"file_path":"x","content":"final"}';
		const done = parse({
			type: "response.function_call_arguments.done",
			output_index: 0,
			arguments: raw,
		});
		expect(done[0]?.toolUseChunk).toMatchObject({ toolUseId: "call", stop: true, finalInput: raw });
		expect(done[0]?.toolUseChunk?.input).toBeUndefined();
		const onlyDone = responsesParser().parse({
			type: "response.output_item.done",
			output_index: 2,
			item: { type: "function_call", call_id: "only", name: "Write", arguments: raw },
		});
		expect(onlyDone[0]?.toolUseChunk).toMatchObject({
			toolUseId: "only",
			name: "Write",
			stop: true,
			finalInput: raw,
		});
		const initial = responsesParser().parse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", call_id: "initial", name: "Write", arguments: raw },
		});
		expect(initial[0]?.toolUseChunk).toMatchObject({ input: raw, stop: true });
		const completed = responsesParser().parse({
			type: "response.completed",
			response: {
				output: [{ type: "function_call", call_id: "final-only", name: "Write", arguments: raw }],
			},
		});
		expect(completed[0]?.toolUseChunk).toMatchObject({
			toolUseId: "final-only",
			finalInput: raw,
			stop: true,
		});
	});

	test("Responses invalid JSON requires native stop instead of bracket balance eager completion", () => {
		const { tools, parse } = responsesParser();
		parse({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "function_call", call_id: "bad", name: "Write" },
		});
		const raw = '{"content":"bad\\q"}';
		const events = parse({
			type: "response.function_call_arguments.delta",
			output_index: 0,
			delta: raw,
		});
		expect(events.some((event) => event.toolUseChunk?.stop)).toBe(false);
		expect(tools.get(0)?.inputStream?.finish()).toEqual({ _raw: raw });
		expect(
			parse({ type: "response.function_call_arguments.done", output_index: 0 })[0]?.toolUseChunk
				?.stop,
		).toBe(true);
	});

	test("Anthropic scanner keeps eager/native stop and EOF fallback", async () => {
		const tools = new Map();
		const reasoning = new Map();
		const redacted = new Map();
		const serverTools = new Map();
		const usage = {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheCreation5mTokens: 0,
			cacheCreation1hTokens: 0,
			cacheReported: false,
		};
		parseAnthropicEvent(
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call", name: "Write" },
			},
			tools,
			reasoning,
			redacted,
			serverTools,
			usage,
		);
		const raw = '{"content":"\\ud83d\\ude00\\r\\n"}';
		const events = [];
		for (const ch of raw)
			events.push(
				...parseAnthropicEvent(
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: ch },
					},
					tools,
					reasoning,
					redacted,
					serverTools,
					usage,
				),
			);
		expect(tools.get(0).inputStream.stats).toEqual({
			scannedChars: raw.length,
			parseAttempts: 1,
			rawMaterializations: 1,
			fieldMaterializations: 0,
		});
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		expect(
			parseAnthropicEvent(
				{ type: "content_block_stop", index: 0 },
				tools,
				reasoning,
				redacted,
				serverTools,
				usage,
			),
		).toEqual([]);
		const eof = await collect(
			parseAnthropicSSEStream(
				sse([
					{ type: "message_start", message: { id: "msg" } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "incomplete", name: "Write" },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"content":"unfinished' },
					},
				]).body as ReadableStream<Uint8Array>,
			),
		);
		expect(eof.at(-1)?.toolUseChunk).toMatchObject({ toolUseId: "incomplete", stop: true });
	});

	test.each([
		['{"file_path":"x","content":"hi"}', { file_path: "x", content: "hi" }],
		['{"content":}', { _raw: '{"content":}' }],
		["", {}],
	])("Anthropic short input survives native stop: %s", async (raw, expected) => {
		const events = await collect(
			parseAnthropicSSEStream(
				sse([
					{ type: "message_start", message: { id: "msg-short" } },
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: "short-call", name: "Write", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: raw },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" } },
					{ type: "message_stop" },
				]).body as ReadableStream<Uint8Array>,
			),
		);
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		const stream = new ToolInputStream();
		for (const event of events) {
			if (event.toolUseChunk?.input) stream.feed(event.toolUseChunk.input);
		}
		expect(stream.finish()).toEqual(expected);
	});

	test.each([
		"block",
		"message",
	])("Anthropic initial tool input survives zero-delta %s stop exactly once", async (termination) => {
		const input = { file_path: "x", content: "初始内容", options: { recursive: true } };
		const events = await collect(
			parseAnthropicSSEStream(
				sse([
					{ type: "message_start", message: { id: "msg-initial" } },
					{
						type: "content_block_start",
						index: 2,
						content_block: { type: "tool_use", id: "initial", name: "Write", input },
					},
					...(termination === "block" ? [{ type: "content_block_stop", index: 2 }] : []),
					{ type: "message_delta", delta: { stop_reason: "tool_use" } },
					{ type: "message_stop" },
				]).body as ReadableStream<Uint8Array>,
			),
		);
		const chunks = events.flatMap((event) => (event.toolUseChunk ? [event.toolUseChunk] : []));
		expect(chunks[0]).toMatchObject({ toolUseId: "initial", stop: false });
		expect(chunks[0].input).toBeUndefined();
		expect(chunks[0].finalInput).toBeUndefined();
		expect(chunks.filter((chunk) => chunk.stop)).toEqual([
			{
				toolUseId: "initial",
				name: "Write",
				stop: true,
				outputIndex: 2,
				finalInput: JSON.stringify(input),
			},
		]);
	});

	test.each([
		"eof",
		"usage-only",
		"max_tokens",
		"refusal",
	])("Anthropic initial snapshot cannot turn %s truncation into a completed call", async (termination) => {
		const events = await collect(
			parseAnthropicSSEStream(
				sse([
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "truncated-initial",
							name: "Write",
							input: { file_path: "x", content: "not yet authorized" },
						},
					},
					...(termination === "eof"
						? []
						: [
								{
									type: "message_delta",
									delta: termination === "usage-only" ? {} : { stop_reason: termination },
									usage: { output_tokens: 2 },
								},
							]),
				]).body as ReadableStream<Uint8Array>,
			),
		);
		expect(events.some((event) => event.toolUseChunk?.stop)).toBe(false);
		expect(events.some((event) => event.toolUseChunk?.finalInput !== undefined)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("incomplete_tool_input");
	});

	test.each([
		'{"content":"streamed"}',
		'{"content":"partial',
		'{"content":}',
		"",
	])("Anthropic input delta wins over the initial snapshot, including malformed input: %s", async (raw) => {
		const events = await collect(
			parseAnthropicSSEStream(
				sse([
					{
						type: "content_block_start",
						index: 0,
						content_block: {
							type: "tool_use",
							id: "delta-wins",
							name: "Write",
							input: { content: "must not mask the delta" },
						},
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: raw },
					},
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" } },
				]).body as ReadableStream<Uint8Array>,
			),
		);
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		expect(events.some((event) => event.toolUseChunk?.finalInput !== undefined)).toBe(false);
		expect(events.map((event) => event.toolUseChunk?.input ?? "").join("")).toBe(raw);
	});

	test("Chat eager completion, malformed native stop and EOF full-input fallback", async () => {
		const raw = '{"file_path":"x","content":"hi"}';
		const eager = await chat([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "call", function: { name: "Write", arguments: raw.slice(0, -1) } },
							],
						},
					},
				],
			},
			{ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }] },
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);
		expect(eager.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		const invalid = await chat([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "bad", function: { name: "Write", arguments: '{"x":}' } },
							],
						},
					},
				],
			},
			{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		]);
		expect(invalid.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		const eof = await chat([
			{
				choices: [
					{
						delta: {
							tool_calls: [
								{ index: 0, id: "eof", function: { name: "Write", arguments: '{"x":' } },
							],
						},
					},
				],
			},
		]);
		expect(eof.at(-1)?.toolUses?.[0].input).toEqual({ _raw: '{"x":' });
		const emptyEof = await chat([
			{
				choices: [
					{ delta: { tool_calls: [{ index: 0, id: "empty", function: { name: "Write" } }] } },
				],
			},
		]);
		expect(emptyEof.at(-1)?.toolUses?.[0].input).toEqual({ _raw: "" });
	});

	function chatDelta(calls: unknown[], text?: string) {
		return {
			choices: [{ index: 0, delta: { ...(text ? { content: text } : {}), tool_calls: calls } }],
		};
	}
	const chatFinish = { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] };

	test("Chat identity: arguments survive arriving before id and name", async () => {
		const raw = '{"file_path":"x","content":"late identity"}';
		const events = await chat([
			chatDelta([{ index: 0, function: { arguments: raw } }], "preamble"),
			chatDelta([{ index: 0, id: "late" }]),
			chatDelta([{ index: 0, function: { name: "Write" } }]),
			chatFinish,
		]);
		const chunks = events.flatMap((event) => (event.toolUseChunk ? [event.toolUseChunk] : []));
		expect(chunks.every((chunk) => chunk.toolUseId === "late" && chunk.name === "Write")).toBe(
			true,
		);
		expect(chunks.filter((chunk) => chunk.stop)).toHaveLength(1);
		const input = new ToolInputStream();
		for (const chunk of chunks) if (chunk.input) input.feed(chunk.input);
		expect(input.finish()).toEqual(JSON.parse(raw));
		expect(events[0].text).toBe("preamble");
	});

	test("Chat identity: a name-first call is independent of interleaved call indices", async () => {
		const events = await chat([
			chatDelta([{ index: 1, function: { name: "Read", arguments: '{"path":"one"}' } }]),
			chatDelta([{ index: 0, id: "zero", function: { arguments: '{"path":"' } }]),
			chatDelta([{ index: 1, id: "one" }]),
			chatDelta([{ index: 0, function: { name: "Read", arguments: 'zero"}' } }]),
			chatFinish,
		]);
		const calls = new Map<string, ToolInputStream>();
		for (const event of events) {
			const chunk = event.toolUseChunk;
			if (!chunk) continue;
			const input = calls.get(chunk.toolUseId) ?? new ToolInputStream();
			calls.set(chunk.toolUseId, input);
			if (chunk.input) input.feed(chunk.input);
		}
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(2);
		expect(calls.get("zero")?.finish()).toEqual({ path: "zero" });
		expect(calls.get("one")?.finish()).toEqual({ path: "one" });
	});

	test.each([
		"id",
		"name",
	] as const)("Chat identity: missing %s is a terminal diagnostic, never an executable call", async (missing) => {
		const events = await chat([
			chatDelta([
				{
					index: 0,
					...(missing === "id" ? {} : { id: "call" }),
					function: { ...(missing === "name" ? {} : { name: "Write" }), arguments: '{"x":1}' },
				},
			]),
			chatFinish,
		]);
		expect(events.some((event) => event.toolUses?.length || event.toolUseChunk)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test("Chat identity: repeated name snapshots, argument deltas and finish events complete once", async () => {
		const call = { index: 0, id: "call", function: { name: "Write", arguments: '{"x":' } };
		const events = await chat([
			chatDelta([call]),
			chatDelta([{ index: 0, id: "call", function: { name: "Write", arguments: "1}" } }]),
			chatFinish,
			chatFinish,
			chatDelta([{ index: 0, id: "call", function: { name: "Write", arguments: '{"x":1}' } }]),
			chatFinish,
		]);
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		expect(
			events.some((event) => event.invalidState || event.toolUseChunk?.name === "WriteWrite"),
		).toBe(false);
	});

	test("Chat identity: changing an announced name cannot retarget buffered arguments", async () => {
		const events = await chat([
			chatDelta([
				{ index: 0, id: "call", function: { name: "Read", arguments: '{"file_path":"' } },
			]),
			chatDelta([{ index: 0, function: { name: "Write", arguments: 'x"}' } }]),
			chatFinish,
		]);
		expect(events.some((event) => event.toolUseChunk?.stop)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test.each([
		-1,
		128,
		0.5,
		"0",
	])("Chat identity: an invalid index %s is not an executable call", async (index) => {
		const events = await chat([
			chatDelta([{ index, id: "call", function: { name: "Write", arguments: "{}" } }]),
			chatFinish,
		]);
		expect(events.some((event) => event.toolUseChunk || event.toolUses?.length)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test.each([
		false,
		true,
	])("Chat identity: changing an established ID is rejected, published=%s", async (published) => {
		const events = await chat([
			chatDelta([
				{
					index: 0,
					id: "original",
					function: { ...(published ? { name: "Read" } : {}), arguments: '{"path":"' },
				},
			]),
			chatDelta([{ index: 0, id: "replacement", function: { name: "Read", arguments: 'x"}' } }]),
			chatFinish,
		]);
		expect(events.some((event) => event.toolUseChunk?.stop)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test("Chat identity: an ID duplicated at another index does not create another execution", async () => {
		const events = await chat([
			chatDelta([{ index: 0, id: "same", function: { arguments: '{"path":"' } }]),
			chatDelta([{ index: 1, id: "same", function: { name: "Read", arguments: '{"path":"x"}' } }]),
		]);
		expect(events.some((event) => event.toolUseChunk?.stop || event.toolUses?.length)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test.each([
		"id",
		"name",
	] as const)("Chat identity: oversized %s is rejected, never truncated into another identity", async (field) => {
		const events = await chat([
			chatDelta([
				{
					index: 0,
					id: field === "id" ? "x".repeat(1025) : "call",
					function: { name: field === "name" ? "x".repeat(65) : "Read", arguments: "{}" },
				},
			]),
		]);
		expect(events.some((event) => event.toolUseChunk || event.toolUses?.length)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test("Chat identity: a compatible final snapshot can finish a name-less Chat buffer", async () => {
		const raw = '{"file_path":"x","content":"final snapshot"}';
		const events = await chat([
			chatDelta([{ index: 0, id: "late-name", function: { arguments: '{"file_path":"draft' } }]),
			{ item: { call_id: "late-name", name: "Write", status: "completed", arguments: raw } },
			chatFinish,
		]);
		expect(events.filter((event) => event.toolUseChunk?.stop)).toHaveLength(1);
		expect(events.find((event) => event.toolUseChunk?.stop)?.toolUseChunk).toMatchObject({
			toolUseId: "late-name",
			name: "Write",
			finalInput: raw,
		});
		expect(events.some((event) => event.invalidState)).toBe(false);
	});

	test.each([
		"length",
		"content_filter",
	])("Chat identity: %s does not turn metadata-only input into an empty executable call", async (finishReason) => {
		const events = await chat([
			chatDelta([{ index: 0, id: "not-finished", function: { name: "Write" } }]),
			{ choices: [{ delta: {}, finish_reason: finishReason }] },
		]);
		expect(events.some((event) => event.toolUseChunk?.stop || event.toolUses?.length)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe(
			finishReason === "length" ? "max_tokens" : "content_filter",
		);
	});

	test("Chat identity: EOF without identity is an explicit failure, not a silent empty answer", async () => {
		const events = await chat([chatDelta([{ index: 0, function: { arguments: "{}" } }])]);
		expect(events.some((event) => event.toolUses?.length || event.toolUseChunk)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test.each([
		"id",
		"name",
	] as const)("Chat identity: compatible response completion cannot supply a missing %s", async (missing) => {
		const events = await chat([
			chatDelta([
				{
					index: 0,
					...(missing === "id" ? {} : { id: "call" }),
					function: { ...(missing === "name" ? {} : { name: "Write" }), arguments: "{}" },
				},
			]),
			{ response: { status: "completed", output: [] } },
		]);
		expect(events.some((event) => event.toolUseChunk || event.toolUses?.length)).toBe(false);
		expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
	});

	test("Chat identity: a pending argument budget fails closed before publishing identity", async () => {
		const originalFeed = ToolInputStream.prototype.feed;
		const feed = spyOn(ToolInputStream.prototype, "feed").mockImplementation(function (
			this: ToolInputStream,
			text: string,
		) {
			originalFeed.call(this, text);
			// Fault-inject the bookkeeping budget instead of allocating a 32 MiB fixture.
			this.totalChars = 32 * 1024 * 1024;
		});
		try {
			const events = await chat([
				chatDelta([{ index: 0, function: { arguments: "{" } }]),
				chatDelta([{ index: 0, function: { arguments: "}" } }]),
			]);
			expect(events.some((event) => event.toolUseChunk || event.toolUses?.length)).toBe(false);
			expect(events.at(-1)?.invalidState?.reason).toBe("invalid_tool_call");
		} finally {
			feed.mockRestore();
		}
	});

	test("compatibility Responses forwards initial and done-only snapshots without appending", async () => {
		const raw = '{"file_path":"x","content":"final"}';
		const events = await chat([
			{
				item: {
					call_id: "call",
					name: "Write",
					status: "in_progress",
					arguments: '{"content":"draft',
				},
			},
			{ item: { call_id: "call", name: "Write", status: "completed", arguments: raw } },
			{ item: { call_id: "only", name: "Write", status: "completed", arguments: raw } },
			{
				response: {
					status: "completed",
					output: [{ type: "function_call", call_id: "snapshot", name: "Write", arguments: raw }],
				},
			},
		]);
		expect(events[0].toolUseChunk?.input).toBe('{"content":"draft');
		expect(
			events.filter((event) => event.toolUseChunk?.stop).map((event) => event.toolUseChunk),
		).toEqual([
			{ toolUseId: "call", name: "Write", stop: true, finalInput: raw, outputIndex: undefined },
			{ toolUseId: "only", name: "Write", stop: true, finalInput: raw, outputIndex: undefined },
			{ toolUseId: "snapshot", name: "Write", stop: true, finalInput: raw, outputIndex: 0 },
		]);
	});
});
