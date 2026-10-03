import { afterEach, describe, expect, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "../../net/outbound-fetch";
import { parseAnthropicEvent, parseAnthropicSSEStream } from "../anthropic-provider";
import {
	OpenAIProvider,
	parseResponsesAPIEvent,
	type ResponsesAPIChunk,
	type ResponsesToolAccum,
} from "../openai-provider";
import type { ParsedStreamEvent } from "../provider";

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
