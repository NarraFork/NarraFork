import { describe, expect, test } from "bun:test";
import { providerStreamEventSchema } from "@server/lib/plugins/protocol";
import {
	type ClineStreamChunk,
	classifyClineError,
	consumeStream,
	MAX_SSE_PENDING_CHARS,
	MAX_SSE_TOTAL_BYTES,
	mapFinishReason,
	type PluginStreamEvent,
	parseChunk,
	StreamMapper,
	StreamTooLargeError,
	splitSseLines,
	UsageAccumulator,
} from "../../../../examples/plugins/cline-external/src/event-mapping";

/**
 * OpenAI SSE → plugin stream events.
 *
 * Every emitted event is validated against the host's real `providerStreamEventSchema`, not
 * against a local description of it. That schema is `.strict()` on every variant, so a field
 * this plugin invents — or one the contract later renames — is rejected at the host boundary.
 * Asserting shapes by hand here would pass while production failed.
 */

/** Validate through the real contract and return the event, so assertions read naturally. */
function contractual(event: PluginStreamEvent): PluginStreamEvent {
	const result = providerStreamEventSchema.safeParse(event);
	if (!result.success) {
		throw new Error(
			`event violates providerStreamEventSchema: ${JSON.stringify(event)}\n${JSON.stringify(result.error.issues)}`,
		);
	}
	return event;
}

/** Feed chunks through a mapper, validating every event on the way out. */
function drive(chunks: ClineStreamChunk[]): {
	events: PluginStreamEvent[];
	final: PluginStreamEvent;
	mapper: StreamMapper;
} {
	const usage = new UsageAccumulator();
	const mapper = new StreamMapper(usage);
	const events: PluginStreamEvent[] = [];
	for (const chunk of chunks) {
		for (const event of mapper.map(chunk)) events.push(contractual(event));
		if (mapper.failed()) break;
	}
	const final = contractual(mapper.finalEvent());
	return { events, final, mapper };
}

function textChunk(text: string): ClineStreamChunk {
	return { choices: [{ index: 0, delta: { content: text } }] };
}

function finishChunk(reason: string): ClineStreamChunk {
	return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

describe("cline-external events: text", () => {
	test("content deltas become text.delta", () => {
		const { events } = drive([textChunk("Hel"), textChunk("lo")]);
		expect(events).toEqual([
			{ type: "text.delta", text: "Hel" },
			{ type: "text.delta", text: "lo" },
		]);
	});

	test("an empty content delta emits nothing", () => {
		// `text.delta.text` has `min(1)` in the contract, so an empty string would be rejected.
		const { events } = drive([
			textChunk(""),
			{ choices: [{ index: 0, delta: { content: null } }] },
		]);
		expect(events).toEqual([]);
	});

	test("a clean stream ends with done/completed/end_turn", () => {
		const { final } = drive([textChunk("hi"), finishChunk("stop")]);
		expect(final).toMatchObject({ type: "done", status: "completed", stopReason: "end_turn" });
	});
});

describe("cline-external events: tool calls", () => {
	test("a streamed tool call produces start, deltas and end", () => {
		const { events } = drive([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "call-1", function: { name: "Read", arguments: "" } }],
						},
					},
				],
			},
			{
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } },
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] },
					},
				],
			},
		]);
		expect(events).toEqual([
			{ type: "tool_call.start", toolUseId: "call-1", name: "Read" },
			{ type: "tool_call.delta", toolUseId: "call-1", argumentsDelta: '{"pa' },
			{ type: "tool_call.delta", toolUseId: "call-1", argumentsDelta: 'th":"a.ts"}' },
			// Closed as soon as the accumulated text parses, so the host can start executing
			// while the model is still producing later output.
			{ type: "tool_call.end", toolUseId: "call-1" },
		]);
	});

	test("arguments split mid-JSON-escape are reassembled without an early close", () => {
		// A brace inside a string literal must not be mistaken for a complete object. This is a
		// real failure mode: network reads split wherever they like.
		const { events } = drive([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "c", function: { name: "Write", arguments: '{"text":"a\\"' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'b}"}' } }] } },
				],
			},
		]);
		const ends = events.filter((event) => event.type === "tool_call.end");
		expect(ends).toHaveLength(1);
		// The close arrives only after the second fragment, i.e. it is the last event.
		expect(events[events.length - 1]).toEqual({ type: "tool_call.end", toolUseId: "c" });
	});

	test("a tool call whose arguments never parse is closed at finish_reason", () => {
		const { events, final } = drive([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "c", function: { name: "Read", arguments: '{"path"' } }],
						},
					},
				],
			},
			finishChunk("tool_calls"),
		]);
		expect(events.filter((event) => event.type === "tool_call.end")).toEqual([
			{ type: "tool_call.end", toolUseId: "c" },
		]);
		expect(final).toMatchObject({ stopReason: "tool_use" });
	});

	test("a name arriving after the id still produces exactly one start", () => {
		// `tool_call.start` requires a non-empty name, so the start has to wait for it.
		const { events } = drive([
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c" }] } }] },
			{
				choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "Bash" } }] } }],
			},
		]);
		expect(events).toEqual([{ type: "tool_call.start", toolUseId: "c", name: "Bash" }]);
	});

	test("a fragment for an unknown index with no id is dropped", () => {
		// Nothing can be attributed to it, and inventing an id would create a call the host then
		// tries to execute.
		const { events } = drive([
			{
				choices: [
					{ index: 0, delta: { tool_calls: [{ index: 3, function: { arguments: "{}" } }] } },
				],
			},
		]);
		expect(events).toEqual([]);
	});

	test("a call whose name never arrives is not closed", () => {
		// No start was emitted for it, so an end would reference an id the host never opened.
		const { events } = drive([
			{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c" }] } }] },
			finishChunk("stop"),
		]);
		expect(events).toEqual([]);
	});

	test("parallel tool calls are tracked independently", () => {
		const { events } = drive([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{ index: 0, id: "a", function: { name: "Read", arguments: "{}" } },
								{ index: 1, id: "b", function: { name: "Glob", arguments: "{}" } },
							],
						},
					},
				],
			},
		]);
		expect(events).toEqual([
			{ type: "tool_call.start", toolUseId: "a", name: "Read" },
			{ type: "tool_call.delta", toolUseId: "a", argumentsDelta: "{}" },
			{ type: "tool_call.end", toolUseId: "a" },
			{ type: "tool_call.start", toolUseId: "b", name: "Glob" },
			{ type: "tool_call.delta", toolUseId: "b", argumentsDelta: "{}" },
			{ type: "tool_call.end", toolUseId: "b" },
		]);
	});

	test("finish_reason:stop with open tool calls still reports tool_use", () => {
		// Observed from gateways. Reporting end_turn here would have the host finish the
		// narration with tools left unexecuted.
		const { final } = drive([
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "c", function: { name: "Read", arguments: "{}" } }],
						},
					},
				],
			},
			finishChunk("stop"),
		]);
		expect(final).toMatchObject({ stopReason: "tool_use" });
	});
});

describe("cline-external events: usage", () => {
	test("token counts are forwarded as measured", () => {
		const { events } = drive([
			{
				choices: [],
				usage: {
					prompt_tokens: 120,
					completion_tokens: 45,
					completion_tokens_details: { reasoning_tokens: 12 },
					prompt_tokens_details: { cached_tokens: 100 },
				},
			},
		]);
		expect(events).toEqual([
			{
				type: "usage",
				usage: {
					promptTokens: 120,
					completionTokens: 45,
					reasoningTokens: 12,
					cachedInputTokens: 100,
				},
			},
		]);
	});

	test("a usage-only chunk with no choices is handled", () => {
		// The gateway may send usage separately from content; skipping it would lose the numbers.
		const { events } = drive([textChunk("x"), { choices: [], usage: { prompt_tokens: 7 } }]);
		expect(events[1]).toEqual({ type: "usage", usage: { promptTokens: 7 } });
	});

	test("usage embedded in a content chunk is reported alongside the text", () => {
		const { events } = drive([
			{ choices: [{ index: 0, delta: { content: "hi" } }], usage: { prompt_tokens: 3 } },
		]);
		// Usage first, then the content it describes — both present, order is deterministic.
		expect(events.map((event) => event.type)).toEqual(["usage", "text.delta"]);
	});

	test("zero counts are treated as unreported rather than measured", () => {
		// A zero would have the host record a request that consumed nothing, then compute
		// context headroom from a prompt it believes was empty.
		const usage = new UsageAccumulator();
		expect(usage.observe({ usage: { prompt_tokens: 0, completion_tokens: 0 } })).toBe(false);
		expect(usage.snapshot()).toBeUndefined();
	});

	test("a context window alone does not produce a usage event", () => {
		// It is host-supplied metadata, not a measurement; emitting it would report a turn that
		// consumed nothing.
		const usage = new UsageAccumulator();
		usage.setContextWindow(200_000);
		expect(usage.snapshot()).toBeUndefined();
	});

	test("the context window rides along once real usage arrives", () => {
		const usage = new UsageAccumulator();
		usage.setContextWindow(200_000);
		usage.observe({ usage: { prompt_tokens: 10 } });
		expect(usage.snapshot()).toEqual({ promptTokens: 10, contextWindow: 200_000 });
	});

	test("final usage is attached to the done event", () => {
		const { final } = drive([{ choices: [], usage: { prompt_tokens: 5 } }, finishChunk("stop")]);
		expect(final).toMatchObject({ type: "done", usage: { promptTokens: 5 } });
	});

	test("done carries no usage key when nothing was reported", () => {
		// Absent, not an empty object: the contract permits omission and the host distinguishes
		// "not reported" from "reported as nothing".
		const { final } = drive([textChunk("hi"), finishChunk("stop")]);
		expect("usage" in final).toBe(false);
	});
});

describe("cline-external events: failures and stop reasons", () => {
	test("an in-stream error emits error then done/failed", () => {
		const { events, final, mapper } = drive([
			textChunk("partial"),
			{ error: { message: "upstream exploded", code: "server_error" } },
		]);
		expect(mapper.failed()).toBe(true);
		expect(events[1]).toMatchObject({
			type: "error",
			error: { classification: "api", code: "server_error", message: "upstream exploded" },
		});
		expect(final).toMatchObject({ type: "done", status: "failed", stopReason: "error" });
	});

	test("finish_reason maps onto the contract's closed stopReason enum", () => {
		// `done.stopReason` is `z.enum([...])`, so an unmapped value fails validation.
		for (const [reason, expected] of [
			["stop", "end_turn"],
			["tool_calls", "tool_use"],
			["function_call", "tool_use"],
			["length", "max_output_tokens"],
			["content_filter", "content_filter"],
			["something_new", "unknown"],
		] as const) {
			expect(mapFinishReason(reason, false)).toBe(expected);
			const { final } = drive([textChunk("x"), finishChunk(reason)]);
			expect(final).toMatchObject({ stopReason: expected });
		}
	});

	test("the response id is carried onto done when the gateway supplies one", () => {
		const { final } = drive([{ id: "resp-1", ...textChunk("hi") }, finishChunk("stop")]);
		expect(final).toMatchObject({ responseId: "resp-1" });
	});
});

describe("cline-external events: SSE framing", () => {
	test("complete data lines are extracted and the partial tail is retained", () => {
		const { payloads, rest } = splitSseLines('data: {"a":1}\ndata: {"b":2}\ndata: {"c":');
		expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
		expect(rest).toBe('data: {"c":');
	});

	test("[DONE] and blank lines are skipped", () => {
		const { payloads } = splitSseLines('data: [DONE]\n\ndata: {"a":1}\n');
		expect(payloads).toEqual(['{"a":1}']);
	});

	test("non-data lines are ignored", () => {
		// Gateways send comment/keep-alive lines; treating them as payloads would spam parse
		// failures.
		const { payloads } = splitSseLines(': keep-alive\nevent: ping\ndata: {"a":1}\n');
		expect(payloads).toEqual(['{"a":1}']);
	});

	test("a payload that is not JSON is skipped rather than throwing", () => {
		expect(parseChunk("not json")).toBeUndefined();
		expect(parseChunk('{"a":1}')).toEqual({ a: 1 } as ClineStreamChunk);
	});

	test("a JSON object split across two reads is parsed once complete", () => {
		const first = splitSseLines('data: {"choices":[{"index":0,"delta":{"content":"he');
		expect(first.payloads).toEqual([]);
		const second = splitSseLines(`${first.rest}llo"}}]}\n`);
		expect(second.payloads).toHaveLength(1);
		expect(parseChunk(second.payloads[0])?.choices?.[0].delta?.content).toBe("hello");
	});
});

/**
 * `consumeStream` reads a body this process does not control, so its bounds are the part
 * worth testing: an upstream that never terminates a line, or never ends, must fail loudly
 * instead of growing a string or holding the operation open forever.
 *
 * The limits are large, so these tests inject small ones via a fabricated body rather than
 * actually producing 128MB. What is asserted is the mechanism (which axis trips, that the
 * body gets cancelled, that the error classifies as non-retryable), not the constant.
 */
describe("cline-external events: stream bounds", () => {
	/** A body yielding `chunks`, recording whether the consumer cancelled it. */
	function trackedBody(chunks: string[]): {
		body: ReadableStream<Uint8Array>;
		cancelled: () => boolean;
		delivered: () => number;
	} {
		let wasCancelled = false;
		let delivered = 0;
		let index = 0;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index >= chunks.length) {
					controller.close();
					return;
				}
				delivered++;
				controller.enqueue(encoder.encode(chunks[index++]));
			},
			cancel() {
				wasCancelled = true;
			},
		});
		return { body, cancelled: () => wasCancelled, delivered: () => delivered };
	}

	function collector(): { events: PluginStreamEvent[]; onEvent: (e: PluginStreamEvent) => void } {
		const events: PluginStreamEvent[] = [];
		return { events, onEvent: (event) => events.push(contractual(event)) };
	}

	test("a well-formed stream is consumed to completion and the body is released", async () => {
		const { body, cancelled } = trackedBody([
			'data: {"choices":[{"index":0,"delta":{"content":"he"}}]}\n',
			'data: {"choices":[{"index":0,"delta":{"content":"llo"}}]}\ndata: [DONE]\n',
		]);
		const mapper = new StreamMapper(new UsageAccumulator());
		const { events, onEvent } = collector();

		await consumeStream(body, mapper, onEvent, new AbortController().signal);

		expect(events.filter((e) => e.type === "text.delta")).toEqual([
			{ type: "text.delta", text: "he" },
			{ type: "text.delta", text: "llo" },
		]);
		// A stream that reached `done` is already closed, so the unconditional `cancel()` on
		// the way out does not reach the source. Cancellation is only observable on the
		// bail-out paths, which the bound/abort tests below assert.
		expect(cancelled()).toBe(false);
	});

	test("a line that never terminates trips the pending-tail bound", async () => {
		// One giant `data:` line with no newline: every read grows the retained tail.
		const { body } = trackedBody(["data: ", "x".repeat(64), "x".repeat(64), "x".repeat(64)]);
		const mapper = new StreamMapper(new UsageAccumulator());
		const { onEvent } = collector();

		await expect(
			consumeStream(body, mapper, onEvent, new AbortController().signal, {
				maxPendingChars: 100,
			}),
		).rejects.toBeInstanceOf(StreamTooLargeError);
	});

	test("the pending-tail bound stops reading rather than draining the whole stream", async () => {
		const chunks = Array.from({ length: 50 }, () => "x".repeat(64));
		const { body, delivered } = trackedBody(["data: ", ...chunks]);
		const mapper = new StreamMapper(new UsageAccumulator());
		const { onEvent } = collector();

		await expect(
			consumeStream(body, mapper, onEvent, new AbortController().signal, {
				maxPendingChars: 100,
			}),
		).rejects.toBeInstanceOf(StreamTooLargeError);
		// It gave up early instead of consuming all 51 chunks first.
		expect(delivered()).toBeLessThan(chunks.length);
	});

	test("an endless stream of valid lines trips the total-bytes bound", async () => {
		// Each line is complete, so the tail stays empty and only the total can stop this.
		const line = `data: {"choices":[{"index":0,"delta":{"content":"${"a".repeat(50)}"}}]}\n`;
		const { body, cancelled } = trackedBody(Array.from({ length: 200 }, () => line));
		const mapper = new StreamMapper(new UsageAccumulator());
		const { onEvent } = collector();

		await expect(
			consumeStream(body, mapper, onEvent, new AbortController().signal, {
				maxTotalBytes: line.length * 5,
			}),
		).rejects.toBeInstanceOf(StreamTooLargeError);
		expect(cancelled()).toBe(true);
	});

	test("an over-long stream is reported as non-retryable, so the host does not replay it", () => {
		const classified = classifyClineError(new StreamTooLargeError("too big"));
		expect(classified).toMatchObject({
			classification: "transport",
			code: "RESPONSE_TOO_LARGE",
			retryable: false,
		});
		contractual({ type: "error", error: classified });
	});

	test("a request timeout is retryable transport, NOT a cancellation", async () => {
		// The distinction matters: `cancelled` tells the host the user stopped the turn, so a
		// stalled upstream classified that way would silently drop work instead of retrying.
		const { RequestTimeoutError } = await import(
			"../../../../examples/plugins/cline-external/src/fetch"
		);
		const classified = classifyClineError(
			new RequestTimeoutError("https://api.example.com/v1/users/me?token=secret", 60_000),
		);
		expect(classified).toMatchObject({
			classification: "transport",
			code: "REQUEST_TIMEOUT",
			retryable: true,
		});
		// The message reaches logs, so it must not carry the query string.
		expect(classified.message).toContain("https://api.example.com/v1/users/me");
		expect(classified.message).not.toContain("secret");
		contractual({ type: "error", error: classified });
	});

	test("the production bounds leave room for a realistic completion", () => {
		// A regression guard on the constants themselves: shrinking either below a plausible
		// response would turn a working stream into a failure.
		expect(MAX_SSE_PENDING_CHARS).toBeGreaterThanOrEqual(1024 * 1024);
		expect(MAX_SSE_TOTAL_BYTES).toBeGreaterThanOrEqual(16 * 1024 * 1024);
	});

	test("an abort mid-stream returns without consuming the rest", async () => {
		const line = 'data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n';
		const { body, cancelled, delivered } = trackedBody(Array.from({ length: 20 }, () => line));
		const mapper = new StreamMapper(new UsageAccumulator());
		const controller = new AbortController();
		const events: PluginStreamEvent[] = [];

		await consumeStream(
			body,
			mapper,
			(event) => {
				events.push(contractual(event));
				controller.abort();
			},
			controller.signal,
		);

		expect(delivered()).toBeLessThan(20);
		expect(cancelled()).toBe(true);
	});
});

describe("cline-external events: error classification", () => {
	test("an abort is cancelled, not a failure", () => {
		const error = new Error("aborted");
		error.name = "AbortError";
		expect(classifyClineError(error)).toMatchObject({
			classification: "cancelled",
			code: "CANCELLED",
		});
	});

	test("a missing credential is invalid_state and not retryable", () => {
		const error = new Error("Cline is not signed in");
		error.name = "MissingCredentialError";
		expect(classifyClineError(error)).toMatchObject({
			classification: "invalid_state",
			code: "NOT_CONFIGURED",
			retryable: false,
		});
	});

	test("statuses map to codes with the right retryability", () => {
		// `retryable` is the field that matters: retrying a revoked credential or an exhausted
		// balance only burns time, while a 429 or a 5xx is worth another attempt.
		const cases: Array<[number, string, boolean]> = [
			[400, "BAD_REQUEST", false],
			[401, "AUTH_FAILED", false],
			[403, "AUTH_FAILED", false],
			[402, "QUOTA_EXHAUSTED", false],
			[429, "THROTTLED", true],
			[408, "UPSTREAM_ERROR", true],
			[500, "UPSTREAM_ERROR", true],
			[503, "UPSTREAM_ERROR", true],
			[404, "UPSTREAM_ERROR", false],
		];
		for (const [status, code, retryable] of cases) {
			const error = Object.assign(new Error(`boom ${status}`), { statusCode: status });
			expect(classifyClineError(error), `status ${status}`).toMatchObject({ code, retryable });
		}
	});

	test("a 400 naming the context window is separated from a malformed request", () => {
		// The host compacts and retries on context overflow but treats a bad request as terminal;
		// conflating them would either loop on a broken payload or discard a recoverable turn.
		const overflow = Object.assign(
			new Error("This model's maximum context length is 200000 tokens"),
			{ statusCode: 400 },
		);
		expect(classifyClineError(overflow)).toMatchObject({
			code: "CONTEXT_LENGTH_EXCEEDED",
			retryable: false,
		});
	});

	test("a failure with no status is transport and retryable", () => {
		expect(classifyClineError(new Error("socket hang up"))).toMatchObject({
			classification: "transport",
			code: "REQUEST_FAILED",
			retryable: true,
		});
	});

	test("every classification is accepted by the contract's error event", () => {
		// The `classification` and `phase` fields are closed enums in the schema.
		const errors = [
			classifyClineError(Object.assign(new Error("x"), { statusCode: 429 })),
			classifyClineError(new Error("y")),
		];
		for (const error of errors) contractual({ type: "error", error });
	});
});
