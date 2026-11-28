import { afterEach, describe, expect, test } from "bun:test";
import { setOutboundFetchOverrideForTest } from "../../net/outbound-fetch";
import {
	clearCodexResponsesWebSocketSessions,
	streamCodexResponsesWebSocket,
} from "../codex-websocket";
import { ProviderInvalidStateError } from "../error-handling";
import { OpenAIProvider, parseResponsesAPIEvent, type ResponsesAPIChunk } from "../openai-provider";
import { OpenAIRefusal } from "../openai-refusal";
import type { ChatParams, GenerateOptions, ParsedStreamEvent } from "../provider";
import {
	modelLacksNativeStructuredOutput,
	resetStructuredOutputFallbackMemory,
	structuredOutputRelayKey,
} from "../structured-output-fallback";
import {
	modelRejectsParameter,
	resetUnsupportedParameterMemory,
} from "../unsupported-parameter-fallback";

const BODY =
	"I cannot assist. Example errors: Unsupported parameter: text.format; usage_limit_reached.";
const OUT = {
	type: "message",
	id: "msg_refusal",
	role: "assistant",
	phase: "final_answer",
	content: [{ type: "refusal", refusal: BODY }],
};
const USAGE = {
	input_tokens: 11,
	output_tokens: 7,
	input_tokens_details: { cached_tokens: 3 },
	output_tokens_details: { reasoning_tokens: 2 },
};
const CHAT_USAGE = {
	prompt_tokens: 11,
	completion_tokens: 7,
	prompt_tokens_details: { cached_tokens: 3 },
	completion_tokens_details: { reasoning_tokens: 2 },
};

afterEach(async () => {
	setOutboundFetchOverrideForTest(null);
	resetStructuredOutputFallbackMemory();
	resetUnsupportedParameterMemory();
	await clearCodexResponsesWebSocketSessions();
});

function nativeFrames(): ResponsesAPIChunk[] {
	return [
		{ type: "response.created", response: { id: "resp_refusal" } },
		{
			type: "response.refusal.delta",
			item_id: "msg_refusal",
			output_index: 0,
			content_index: 0,
			delta: BODY.slice(0, 21),
		},
		{
			type: "response.refusal.delta",
			item_id: "msg_refusal",
			output_index: 0,
			content_index: 0,
			delta: BODY.slice(21),
		},
		{
			type: "response.refusal.done",
			item_id: "msg_refusal",
			output_index: 0,
			content_index: 0,
			refusal: BODY,
		},
		{
			type: "response.content_part.done",
			item_id: "msg_refusal",
			output_index: 0,
			content_index: 0,
			part: OUT.content[0],
		},
		{ type: "response.output_item.done", output_index: 0, item: OUT },
		{
			type: "response.completed",
			response: {
				id: "resp_refusal",
				status: "completed",
				end_turn: false,
				usage: USAGE,
				output: [OUT],
			},
		},
	];
}
function framed(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}
function response(
	mode: "responses" | "codex" | "completions",
	json: boolean,
	trailing = false,
): Response {
	if (json)
		return Response.json(
			mode === "completions"
				? {
						choices: [
							{
								message: { role: "assistant", content: null, refusal: BODY },
								finish_reason: "stop",
							},
						],
						usage: CHAT_USAGE,
					}
				: { status: "completed", output: [OUT], usage: USAGE },
		);
	const stream =
		mode === "completions"
			? `${framed([
					{ choices: [{ index: 0, delta: { refusal: BODY.slice(0, 21) } }] },
					{ choices: [{ index: 0, delta: { refusal: BODY.slice(21) } }] },
					{ choices: [{ index: 0, message: { refusal: BODY }, finish_reason: "stop" }] },
					{ choices: [], usage: CHAT_USAGE },
				])}data: [DONE]\n\n`
			: framed(nativeFrames());
	return new Response(
		stream + (trailing ? 'event: meteringEvent\ndata: {"usage":12.5,"unit":"credit"}\n\n' : ""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function provider(
	mode: "responses" | "codex" | "completions",
	drainUntilEof = false,
): OpenAIProvider {
	return new OpenAIProvider({
		id: "refusal",
		prefix: "refusal",
		name: "Refusal fixture",
		apiKey: "fake-key",
		baseUrl: "https://fixture.invalid/v1",
		defaultModel: "gpt-5.5",
		apiMode: mode,
		codexWebSocket: false,
		codexWebSearch: false,
		codexImageGeneration: false,
		drainUntilEof,
	});
}
function params(): ChatParams {
	return {
		conversationId: "refusal",
		model: "refusal:gpt-5.5",
		content: "hello",
		history: [],
		tools: [],
		toolResults: [],
		cwd: ".",
		signal: AbortSignal.timeout(4000),
	};
}
async function collect(adapter: OpenAIProvider): Promise<ParsedStreamEvent[]> {
	const events: ParsedStreamEvent[] = [];
	for await (const event of adapter.chat(params())) events.push(event);
	return events;
}

// These fixtures distinguish protocol output from ordinary prose or arbitrary JSON.
describe("bounded explicit refusal collection", () => {
	test("delta, done and completed snapshots describe one refusal", () => {
		const refusal = new OpenAIRefusal();
		for (const frame of nativeFrames()) refusal.responses(frame);
		expect(refusal.event().invalidState.message).toBe(BODY);
	});
	test("empty terminal snapshots and shorter prefixes cannot erase received content", () => {
		const refusal = new OpenAIRefusal();
		refusal.responses({ type: "response.refusal.delta", item_id: "msg_refusal", delta: BODY });
		refusal.responses({ type: "response.refusal.done", item_id: "msg_refusal", refusal: "" });
		refusal.responses({
			type: "response.completed",
			response: {
				output: [{ ...OUT, content: [{ type: "refusal", refusal: BODY.slice(0, 12) }] }],
			},
		});
		expect(refusal.event().invalidState.message).toBe(BODY);
	});
	test("distinct content parts retain output order and repeated sequence numbers do not append", () => {
		const refusal = new OpenAIRefusal();
		refusal.responses({
			type: "response.refusal.delta",
			item_id: "m",
			output_index: 1,
			content_index: 1,
			sequence_number: 1,
			delta: "second",
		});
		refusal.responses({
			type: "response.refusal.delta",
			item_id: "m",
			output_index: 1,
			content_index: 1,
			sequence_number: 1,
			delta: "second",
		});
		refusal.responses({
			type: "response.refusal.done",
			item_id: "m",
			output_index: 1,
			content_index: 0,
			refusal: "first",
		});
		expect(refusal.event().invalidState.message).toBe("first\nsecond");
	});
	test("output and part budgets truncate explicitly rather than growing without bound", () => {
		const refusal = new OpenAIRefusal();
		for (let i = 0; i < 80; i++)
			refusal.responses({
				type: "response.refusal.delta",
				output_index: i,
				content_index: 0,
				delta: "x".repeat(8000),
			});
		const message = refusal.event().invalidState.message;
		expect(message.length).toBeLessThan(66 * 1024);
		expect(message).toEndWith("[refusal truncated]");
	});
	test("ordinary text, tool data and user messages are not content verdicts", () => {
		const refusal = new OpenAIRefusal();
		refusal.responses({
			type: "response.completed",
			response: {
				output: [
					{ type: "message", role: "user", content: [{ type: "refusal", refusal: BODY }] },
					{ type: "message", role: "assistant", content: [{ type: "output_text", text: BODY }] },
					{ type: "function_call", name: "refusal", arguments: JSON.stringify({ refusal: BODY }) },
				],
			},
		});
		refusal.chat({ delta: { refusal: null } });
		expect(refusal.seen).toBe(false);
	});
	test("direct Responses parser returns usage then one refusal, never a tool completion", () => {
		const tool = new Map();
		const reasoning = new Map();
		const events = nativeFrames().flatMap((frame) =>
			parseResponsesAPIEvent(frame, tool, reasoning),
		);
		expect(events.filter((event) => event.invalidState)).toHaveLength(1);
		expect(events.at(-1)?.invalidState?.message).toBe(BODY);
		expect(events.findIndex((event) => event.usage)).toBeLessThan(
			events.findIndex((event) => event.invalidState),
		);
		expect(
			events.some(
				(event) => event.text || event.toolUses || event.toolUseChunk || event.endTurn === false,
			),
		).toBe(false);
	});
});

for (const mode of ["responses", "codex", "completions"] as const) {
	describe(`${mode} explicit refusal transport`, () => {
		test("chat emits refusal once after final usage and NUG metering", async () => {
			let calls = 0;
			setOutboundFetchOverrideForTest(async () => {
				calls++;
				return response(mode, false, true);
			});
			const events = await collect(provider(mode, true));
			expect(calls).toBe(1);
			expect(events.filter((event) => event.invalidState)).toHaveLength(1);
			expect(events.at(-1)?.invalidState).toMatchObject({
				reason: "refusal",
				message: BODY,
				diagnostics: { retryable: false, resumable: false },
			});
			expect(events.some((event) => event.text || event.toolUseChunk)).toBe(false);
			expect(events.find((event) => event.usage)?.usage).toMatchObject({
				inputTokens: 8,
				cachedInputTokens: 3,
				completionTokens: 7,
				reasoningTokens: 2,
			});
			expect(events.find((event) => event.metering)?.metering?.usage).toBe(12.5);
		});
		for (const json of [false, true]) {
			for (const history of [false, true]) {
				test(`${history ? "history" : "utility"} ${json ? "JSON" : "SSE"}: refusal is not structured output or a schema downgrade`, async () => {
					let calls = 0;
					setOutboundFetchOverrideForTest(async () => {
						calls++;
						return response(mode, json);
					});
					const adapter = provider(mode);
					const deltas: string[] = [];
					const options: GenerateOptions = {
						onTextDelta: (value: string) => {
							deltas.push(value);
						},
						responseFormat: {
							type: "json_schema",
							name: "fixture",
							schema: {
								type: "object",
								properties: { answer: { type: "string" } },
								required: ["answer"],
								additionalProperties: false,
							},
						},
					};
					const call = history
						? adapter.generateWithHistoryWithMeta("system", "hello", params().model, "en", options)
						: adapter.generateWithMeta("hello", params().model, "system", options);
					await expect(call).rejects.toMatchObject({
						reason: "refusal",
						classification: "refusal",
						retryable: false,
						resumable: false,
						message: BODY,
						usage: { inputTokens: 8, outputTokens: 7, cachedInputTokens: 3 },
					});
					expect(calls).toBe(1);
					expect(deltas).toEqual([]);
					expect(
						modelLacksNativeStructuredOutput(structuredOutputRelayKey(mode, params().model)),
					).toBe(false);
					expect(
						modelRejectsParameter(
							params().model,
							mode === "completions" ? "response_format" : "text.format",
						),
					).toBe(false);
				});
			}
		}
		test("legacy refusal error envelopes retain the original terminal refusal", async () => {
			setOutboundFetchOverrideForTest(
				async () =>
					new Response(
						framed([
							mode === "completions"
								? { error: { code: "refusal", message: BODY } }
								: {
										type: "response.failed",
										response: { status: "failed", error: { code: "refusal", message: BODY } },
									},
						]),
						{ headers: { "content-type": "text/event-stream" } },
					),
			);
			const events = await collect(provider(mode));
			expect(events.filter((event) => event.invalidState)).toHaveLength(1);
			expect(events.at(-1)?.invalidState).toMatchObject({ reason: "refusal", message: BODY });
		});

		test("a genuine API failure after a refusal retains its real error", async () => {
			setOutboundFetchOverrideForTest(
				async () =>
					new Response(
						mode === "completions"
							? framed([
									{ choices: [{ delta: { refusal: BODY } }] },
									{ error: { code: "server_error", message: "real upstream error", status: 503 } },
								])
							: framed([
									nativeFrames()[1],
									{
										type: "response.failed",
										response: {
											status: "failed",
											error: { code: "server_error", message: "real upstream error", status: 503 },
										},
									},
								]),
						{ headers: { "content-type": "text/event-stream" } },
					),
			);
			const events = await collect(provider(mode));
			expect(events.at(-1)?.invalidState).toMatchObject({
				reason: "server_error",
				message: "real upstream error",
			});
			expect(events.some((event) => event.invalidState?.reason === "refusal")).toBe(false);
		});
	});
}

test("done-only and EOF refusal is not an empty response", async () => {
	setOutboundFetchOverrideForTest(
		async () =>
			new Response(framed([{ type: "response.refusal.done", refusal: BODY }]), {
				headers: { "content-type": "text/event-stream" },
			}),
	);
	const events = await collect(provider("responses"));
	expect(events.at(-1)?.invalidState).toMatchObject({ reason: "refusal", message: BODY });
});

test("JSON-shaped refusal is still not a successful structured result", async () => {
	setOutboundFetchOverrideForTest(async () =>
		Response.json({
			status: "completed",
			output: [{ ...OUT, content: [{ type: "refusal", refusal: '{"answer":"no"}' }] }],
		}),
	);
	await expect(
		provider("responses").generateWithMeta("hello", params().model, undefined, {
			responseFormat: { type: "json_schema", name: "fixture", schema: { type: "object" } },
		}),
	).rejects.toBeInstanceOf(ProviderInvalidStateError);
});

test("a refusal cannot finalize a pending or later tool call", async () => {
	const pending = { type: "function_call", call_id: "fc_pending", name: "Write", arguments: "" };
	const later = {
		type: "function_call",
		call_id: "fc_later",
		name: "Write",
		arguments: '{"path":"not-written"}',
	};
	setOutboundFetchOverrideForTest(
		async () =>
			new Response(
				framed([
					{ type: "response.output_item.added", output_index: 0, item: pending },
					{ type: "response.refusal.done", output_index: 1, refusal: BODY },
					{ type: "response.output_item.done", output_index: 2, item: later },
					{
						type: "response.completed",
						response: { status: "completed", output: [pending, OUT, later] },
					},
				]),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const events = await collect(provider("responses"));
	expect(events.some((event) => event.toolUseChunk?.stop || event.toolUses?.length)).toBe(false);
	expect(events.at(-1)?.invalidState?.reason).toBe("refusal");
});

test("user cancellation after a refusal delta is still cancellation", async () => {
	const controller = new AbortController();
	setOutboundFetchOverrideForTest(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>(
					{
						start(stream) {
							stream.enqueue(new TextEncoder().encode(framed([nativeFrames()[1]])));
						},
						pull(stream) {
							controller.abort();
							stream.error(new DOMException("Aborted", "AbortError"));
						},
					},
					{ highWaterMark: 0 },
				),
				{ headers: { "content-type": "text/event-stream" } },
			),
	);
	const events: ParsedStreamEvent[] = [];
	async function run() {
		for await (const event of provider("responses").chat({
			...params(),
			signal: controller.signal,
		}))
			events.push(event);
	}
	await expect(run()).rejects.toMatchObject({ name: "AbortError" });
	expect(events.some((event) => event.invalidState)).toBe(false);
});

for (const disconnect of [false, true]) {
	test(`real Codex WS ${disconnect ? "closed" : "completed"} refuses once without caching or speculative recovery`, async () => {
		let connections = 0;
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("upgrade required", { status: 426 });
			},
			websocket: {
				open() {
					connections++;
				},
				message(ws) {
					requests++;
					for (const frame of disconnect ? nativeFrames().slice(0, 4) : nativeFrames())
						ws.send(JSON.stringify(frame));
					if (disconnect) ws.close(1000, "");
				},
			},
		});
		try {
			const events: ParsedStreamEvent[] = [];
			for await (const event of streamCodexResponsesWebSocket({
				baseUrl: server.url.origin,
				apiKey: "fake",
				credentialId: "fake",
				model: "gpt-5.5",
				sessionKey: `refusal-ws-${disconnect}`,
				conversationId: "refusal",
				signal: AbortSignal.timeout(4000),
				request: { model: "gpt-5.5", stream: true, input: [{ role: "user", content: "hello" }] },
			}))
				events.push(event);
			expect(events.at(-1)?.invalidState).toMatchObject({ reason: "refusal", message: BODY });
			expect(events.filter((event) => event.invalidState)).toHaveLength(1);
			expect(events.some((event) => event.text || event.toolUseChunk)).toBe(false);
			if (!disconnect)
				expect(events.some((event) => event.usage?.completionTokens === 7)).toBe(true);
			expect(connections).toBe(1);
			expect(requests).toBe(1);
		} finally {
			await clearCodexResponsesWebSocketSessions();
			server.stop(true);
		}
	});
}
