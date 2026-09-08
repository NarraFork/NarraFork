/**
 * Upstream error payloads must keep their message no matter which envelope shape
 * they arrive in.
 *
 * The bug this guards: every stream parser gated on a `type === "error"`
 * discriminator (or on `error.message` specifically), but gateways relay several
 * other shapes — a bare `{"error":{...}}` frame with no `type`, a string-valued
 * `error`, or the text under `detail`. Those produced NO event at all, so the
 * upstream explanation was discarded and the turn was later reported by the
 * empty-response guard as "the provider returned no content" — pointing the user
 * at their own base URL/credentials for what was an upstream failure.
 *
 * It was diagnosable only because the provider model-test dialog showed the same
 * error correctly: that path surfaces a thrown error's `message` instead of
 * parsing a stream, so it never depended on the discriminator.
 */
import { describe, expect, test } from "bun:test";
import {
	diagnosticsFromError,
	parseErrorDiagnostics,
	parseUpstreamErrorEnvelope,
} from "@shared/agent-protocol/error-diagnostics";
import { parseCodexWrappedError } from "../codex-websocket";
import { classifyInvalidState } from "../error-handling";
import {
	OpenAIProvider,
	parseResponsesAPIEvent,
	type ResponsesToolAccum,
} from "../openai-provider";
import type { ParsedStreamEvent } from "../provider";

function parseResponses(chunk: unknown) {
	return parseResponsesAPIEvent(chunk as never, new Map(), new Map());
}

/** Shapes observed from gateways and relays, none of which carry `type: "error"`. */
const UNDISCRIMINATED_SHAPES: Array<[string, unknown, string]> = [
	[
		"bare nested error with no type field",
		{ error: { message: "upstream pool exhausted", code: "server_error" } },
		"upstream pool exhausted",
	],
	[
		"flat message plus code",
		{ message: "rate limited by upstream", code: "rate_limit_exceeded" },
		"rate limited by upstream",
	],
	[
		"bare provider-specific insufficient-credits code",
		{ code: "insufficient_credits", message: "Insufficient credits" },
		"Insufficient credits",
	],
	[
		"bare custom provider code with a specific message",
		{ code: "custom_provider_code", message: "request rejected" },
		"request rejected",
	],
	["string-valued error", { error: "backend refused the request" }, "backend refused the request"],
	[
		"message under detail",
		{ error: { detail: "model is not enabled for this key" } },
		"model is not enabled for this key",
	],
];

describe("parseUpstreamErrorEnvelope", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`recovers the message from ${name}`, () => {
			expect(parseUpstreamErrorEnvelope(shape)?.message).toBe(expected);
		});
	}

	test("keeps the machine-readable code when one is supplied", () => {
		const envelope = parseUpstreamErrorEnvelope({
			error: { message: "quota gone", code: "insufficient_quota" },
			status: 429,
		});
		expect(envelope?.code).toBe("insufficient_quota");
		expect(envelope?.statusCode).toBe(429);
	});

	test("does not report a generic `error` discriminator as the code", () => {
		// `type: "error"` says only "this is an error"; treating it as the code would
		// display "error" where a real reason belongs.
		expect(parseUpstreamErrorEnvelope({ type: "error", message: "boom" })?.code).toBeUndefined();
	});

	for (const field of ["status", "status_code", "statusCode"]) {
		for (const nested of [false, true]) {
			test(`normalizes ${nested ? "nested" : "top-level"} ${field}`, () => {
				const detail = { message: "upstream unavailable", [field]: "503" };
				const shape = nested ? { type: "error", error: detail } : { type: "error", ...detail };
				expect(parseUpstreamErrorEnvelope(shape)).toMatchObject({
					message: "upstream unavailable",
					statusCode: 503,
				});
			});
		}
	}

	test("skips lifecycle statuses and preserves an inner failure over outer HTTP 200", () => {
		expect(
			parseUpstreamErrorEnvelope({
				status: 200,
				error: { status: "failed", statusCode: "503", detail: "backend unavailable" },
			}),
		).toMatchObject({ message: "backend unavailable", statusCode: 503 });
		expect(
			parseUpstreamErrorEnvelope({
				status: "failed",
				status_code: "429",
				error: "rate limited",
			}),
		).toMatchObject({ message: "rate limited", statusCode: 429 });
	});

	test("prefers a specific code to generic or categorical type fields", () => {
		expect(
			parseUpstreamErrorEnvelope({
				type: "error",
				code: "previous_response_not_found",
				error: { type: "invalid_request_error", message: "missing response" },
			})?.code,
		).toBe("previous_response_not_found");
		expect(
			parseUpstreamErrorEnvelope({
				type: "response.completed",
				error: { type: "error", message: "failed" },
			})?.code,
		).toBeUndefined();
	});

	for (const [shape, code] of [
		[{ type: "error", code: "unknown_provider_code" }, "unknown_provider_code"],
		[{ error: { code: "cyber_policy" } }, "cyber_policy"],
		[{ error: { code: "custom_provider_code" } }, "custom_provider_code"],
		[{ error: { type: "provider_hard_stop" } }, "provider_hard_stop"],
		[{ error: { type: "server_error" } }, "server_error"],
		[{ code: "rate_limit_exceeded" }, "rate_limit_exceeded"],
		[{ type: "server_error" }, "server_error"],
		[{ code: 503 }, "503"],
	] as const) {
		test(`preserves code-only error ${JSON.stringify(shape)}`, () => {
			const envelope = parseUpstreamErrorEnvelope(shape);
			expect(envelope?.code).toBe(code);
			expect(envelope?.message).toContain(code);
		});
	}

	test("uses an explicit HTTP failure even when no message was supplied", () => {
		expect(parseUpstreamErrorEnvelope({ status_code: "503" })).toMatchObject({
			statusCode: 503,
			message: "Upstream API error (HTTP 503)",
		});
	});

	for (const shape of [
		{ type: "error", error: {} },
		{ type: "failed", error: { message: "" } },
		{ error: { type: "error" } },
		{ error: { statusCode: "503" } },
	]) {
		test(`keeps explicit failures despite missing text: ${JSON.stringify(shape)}`, () => {
			expect(parseUpstreamErrorEnvelope(shape)?.message).toBeTruthy();
		});
	}

	// The counterpart risk of matching on content instead of a discriminator: a
	// content frame misread as a failure would kill a healthy turn. That is strictly
	// worse than the bug being fixed, so these cases are pinned explicitly.
	const CONTENT_FRAMES: Array<[string, unknown]> = [
		["a text delta", { type: "response.output_text.delta", delta: "hi" }],
		["a completed response", { type: "response.completed", response: { id: "resp-1" } }],
		["a usage-only frame", { usage: { input_tokens: 5 } }],
		["an output item", { type: "response.output_item.done", item: { type: "message" } }],
		// Several providers stamp `code: 200` on success frames.
		["a success status code", { code: 200 }],
		["a numeric successful status and message", { status: 200, message: "ok" }],
		["a string successful status and message", { status_code: "200", message: "ok" }],
		["a canonical successful status and message", { statusCode: 200, message: "ok" }],
		["a successful code and message", { code: "200", message: "ok" }],
		["an arbitrary metadata code", { code: "usage", message: "tokens updated" }],
		["an out-of-range status", { status: 999, message: "custom metadata" }],
		["a fractional status", { status: 500.5, message: "custom metadata" }],
		["a false error flag", { error: false, status: 200, message: "ok" }],
		["a null error field", { error: null, message: "ok" }],
		["an empty error object", { error: {} }],
		["an error object with empty text", { error: { message: "", detail: "   " } }],
		["an error object with no meaningful fields", { error: { message: "", code: "", type: "" } }],
		["an error placeholder on HTTP 200", { error: {}, status: 200, message: "ok" }],
		["an error placeholder with successful fields", { error: { statusCode: 200, code: "ok" } }],
		["an informational code without text", { code: "custom_provider_code" }],
		["an informational code with empty text", { code: "custom_provider_code", message: " " }],
		["a known successful word code", { code: "SUCCESS", message: "request accepted" }],
		["an explicit no-error code", { code: "no_error", message: "all checks passed" }],
		[
			"a non-success code with HTTP 200",
			{ code: "custom_provider_code", status: 200, message: "ok" },
		],
		["a non-success code with a success label", { code: "custom_provider_code", message: "ok" }],
		[
			"a custom metadata code with text",
			{ type: "metadata", code: "custom_provider_code", message: "metadata updated", error: {} },
		],
		[
			"an untyped metadata code with text",
			{
				meta: { model: "test" },
				code: "custom_provider_code",
				message: "model selected",
				error: {},
			},
		],
		[
			"an untyped usage code with text",
			{
				usage: { input_tokens: 5 },
				code: "custom_provider_code",
				message: "tokens updated",
				error: {},
			},
		],
		[
			"a usage frame with an empty error message",
			{ type: "usage", usage: { input_tokens: 5 }, error: { message: "" }, statusCode: 200 },
		],
		[
			"metadata containing an old error",
			{ type: "metadata", metadata: { error: { message: "previous error", status: 503 } } },
		],
		[
			"usage with a successful code and message",
			{ type: "usage", code: "ok", status: 200, message: "ok", usage: { input_tokens: 5 } },
		],
		[
			"tool output containing a nested error",
			{
				type: "response.output_item.done",
				item: { type: "function_call_output", output: { error: { message: "tool failed" } } },
			},
		],
		[
			"successful response output mentioning an error",
			{
				type: "response.completed",
				response: {
					status: "completed",
					error: null,
					output: [{ type: "function_call_output", output: { error: "tool failed" } }],
				},
			},
		],
		// A bare `message` is also how some providers label ordinary content, so it
		// needs a corroborating error signal before counting as a failure.
		["a bare message with no error signal", { message: "hello from the model" }],
		["null", null],
		["an array", []],
	];
	for (const [name, frame] of CONTENT_FRAMES) {
		test(`does not treat ${name} as an error`, () => {
			expect(parseUpstreamErrorEnvelope(frame)).toBeNull();
		});
	}
});

describe("structured upstream error diagnostics", () => {
	test("preserves a status carried only by Error.diagnostics", () => {
		const error = Object.assign(new Error("upstream unavailable"), {
			diagnostics: { statusCode: 503, code: "server_error", message: "upstream unavailable" },
		});
		expect(diagnosticsFromError(error)).toMatchObject({
			statusCode: 503,
			code: "server_error",
			message: "upstream unavailable",
		});
	});

	test("skips nonnumeric codes before a valid diagnostic status", () => {
		expect(
			parseErrorDiagnostics({
				diagnostics: { code: "server_error" },
				status: "failed",
				status_code: "503",
			}),
		).toMatchObject({ statusCode: 503, code: "server_error" });
		expect(
			diagnosticsFromError({
				status: "failed",
				diagnostics: { statusCode: 503 },
			}),
		).toMatchObject({ statusCode: 503 });
	});
});

describe("Responses stream parser (SSE and WebSocket share this)", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`surfaces an invalidState for ${name}`, () => {
			const events = parseResponses(shape);
			expect(events).toHaveLength(1);
			expect(events[0]?.invalidState?.message).toBe(expected);
			// The message must also reach diagnostics: that is what the persisted record
			// and the error card read from.
			expect(events[0]?.invalidState?.diagnostics?.message).toBe(expected);
		});
	}

	test("prefers the upstream text over the generic placeholder", () => {
		// A typed error whose text sits under `detail` used to fall through to
		// "Unknown API error", discarding the one useful sentence upstream sent.
		const events = parseResponses({ type: "error", error: { detail: "region not available" } });
		expect(events[0]?.invalidState?.message).toBe("region not available");
	});

	test("still parses the canonical typed error event", () => {
		const events = parseResponses({
			type: "error",
			error: { message: "canonical", code: "server_error" },
		});
		expect(events[0]?.invalidState?.message).toBe("canonical");
		expect(events[0]?.invalidState?.reason).toBe("server_error");
	});

	test("carries cyber_policy from response.failed as the invalidState reason", () => {
		// The Codex cyber-policy hard block arrives as a streamed response.failed
		// whose machine code lives at response.error.code. The reason field is what
		// the classifier and the UI key on, so it must survive verbatim.
		const events = parseResponses({
			type: "response.failed",
			response: {
				id: "resp-1",
				status: "failed",
				error: { code: "cyber_policy", message: "Request blocked by cyber safety policy" },
			},
		});
		expect(events).toHaveLength(1);
		expect(events[0]?.invalidState?.reason).toBe("cyber_policy");
		expect(events[0]?.invalidState?.message).toBe("Request blocked by cyber safety policy");
	});

	test("carries cyber_policy from a bare error event as the invalidState reason", () => {
		const events = parseResponses({
			type: "error",
			error: { code: "cyber_policy", message: "blocked" },
		});
		expect(events[0]?.invalidState?.reason).toBe("cyber_policy");
	});

	test("keeps typed string-valued errors and their HTTP status", () => {
		const events = parseResponses({
			type: "error",
			status: 503,
			error: "upstream pool exhausted; request_id=req-1",
		});
		expect(events[0]?.invalidState).toMatchObject({
			reason: "api_error",
			message: "upstream pool exhausted; request_id=req-1",
			diagnostics: { statusCode: 503, message: "upstream pool exhausted; request_id=req-1" },
		});
	});

	for (const [type, status] of [
		["response.failed", undefined],
		["response.failed", "failed"],
		["response.incomplete", undefined],
		["response.incomplete", "incomplete"],
		["response.completed", undefined],
		["response.completed", "completed"],
		["response.completed", "failed"],
		["response.completed", "incomplete"],
	] as const) {
		for (const [name, error, code, message] of [
			[
				"string error",
				"upstream pool exhausted\nrequest_id=req-1",
				undefined,
				"upstream pool exhausted\nrequest_id=req-1",
			],
			[
				"error.detail",
				{ detail: "model unavailable; request_id=req-2", type: "server_error" },
				"server_error",
				"model unavailable; request_id=req-2",
			],
			[
				"code-only error",
				{ code: "cyber_policy" },
				"cyber_policy",
				"Upstream API error: cyber_policy",
			],
		] as const) {
			for (const withUsage of [false, true]) {
				test(`${type}/${status ?? "no status"} with ${name}${withUsage ? " and usage" : ""} is a failure`, () => {
					const pending = { callId: "call-1", name: "Read", args: "{", emitted: false };
					const toolAccum = new Map<number, ResponsesToolAccum>([[0, pending]]);
					const usage = withUsage ? { input_tokens: 11, output_tokens: 2 } : undefined;
					const events = parseResponsesAPIEvent(
						{ type, response: { id: "resp-1", status, status_code: "503", error, usage } },
						toolAccum,
						new Map(),
					);
					const incomplete = status === "incomplete" || type === "response.incomplete";
					expect(events).toHaveLength(withUsage ? 2 : 1);
					expect(events.find((event) => event.invalidState)?.invalidState).toMatchObject({
						reason: code ?? (incomplete ? "unknown" : "api_error"),
						message,
						diagnostics: {
							message,
							statusCode: 503,
							phase: incomplete ? "response_incomplete" : "response_failed",
						},
					});
					if (code) {
						expect(events.at(-1)?.invalidState?.diagnostics?.code).toBe(code);
					}
					if (withUsage) {
						expect(events.find((event) => event.usage)?.usage).toMatchObject({
							inputTokens: 11,
							completionTokens: 2,
						});
					}
					expect(events.some((event) => event.toolUseChunk || event.responseId)).toBe(false);
					expect(pending.emitted).toBe(false);
				});
			}
		}
	}

	test("recognizes failed status even when the error field is null", () => {
		expect(
			parseResponses({
				type: "response.completed",
				response: { status: "failed", error: null },
			})[0]?.invalidState,
		).toMatchObject({ reason: "api_error", message: "Response failed" });
	});

	test("actual failed status wins over an incorrect outer incomplete label", () => {
		const failure = parseResponses({
			type: "response.incomplete",
			response: {
				status: "failed",
				error: { code: "cyber_policy", message: "blocked by policy" },
			},
		})[0]?.invalidState;
		expect(failure).toMatchObject({
			reason: "cyber_policy",
			diagnostics: { phase: "response_failed" },
		});
	});

	for (const type of ["response.incomplete", "response.completed"]) {
		for (const error of [
			{ code: "cyber_policy" },
			{ code: "CYBER-POLICY" },
			{ type: "cyber policy" },
			{ code: "server_error", type: "cyber_policy" },
		]) {
			test(`${type} policy fields ${JSON.stringify(error)} override a completion-limit reason`, () => {
				const failure = parseResponses({
					type,
					response: {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
						error: { ...error, status: 503, message: "request blocked" },
					},
				})[0]?.invalidState;
				expect(failure).toMatchObject({
					reason: "cyber_policy",
					message: "request blocked",
					diagnostics: { reason: "cyber_policy", statusCode: 503 },
				});
				expect(
					classifyInvalidState(failure?.reason ?? "", failure?.message, failure?.diagnostics),
				).toMatchObject({ category: "content_filter", retryable: false, resumable: false });
			});
		}

		test(`${type} non-transient quota errors do not become completion-limit continuations`, () => {
			const failure = parseResponses({
				type,
				response: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					error: { code: "insufficient_quota", status: 503, message: "quota exhausted" },
				},
			})[0]?.invalidState;
			expect(failure?.reason).toBe("insufficient_quota");
			expect(
				classifyInvalidState(failure?.reason ?? "", failure?.message, failure?.diagnostics),
			).toMatchObject({ category: "non_retryable", retryable: false });
		});

		test(`${type} does not infer a policy block from prose mentioning cyber_policy`, () => {
			const failure = parseResponses({
				type,
				response: {
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
					error: { code: "server_error", status: 503, message: "diagnostics mention cyber_policy" },
				},
			})[0]?.invalidState;
			expect(failure?.reason).toBe("max_output_tokens");
		});

		for (const reason of ["max_output_tokens", "content_filter"]) {
			test(`${type} preserves ${reason} classification over transient error details`, () => {
				const failure = parseResponses({
					type,
					response: {
						status: "incomplete",
						incomplete_details: { reason },
						error: { code: "server_error", status: 503, detail: "upstream stopped generation" },
					},
				})[0]?.invalidState;
				expect(failure).toMatchObject({
					reason,
					message: "upstream stopped generation",
					diagnostics: { reason, code: "server_error", statusCode: 503 },
				});
				expect(
					classifyInvalidState(failure?.reason ?? "", failure?.message, failure?.diagnostics),
				).toMatchObject({
					category: reason === "max_output_tokens" ? "completion_limit" : "content_filter",
					retryable: false,
					resumable: false,
				});
			});

			test(`${type} preserves ${reason} without an error object`, () => {
				expect(
					parseResponses({
						type,
						response: { status: "incomplete", error: null, incomplete_details: { reason } },
					})[0]?.invalidState,
				).toMatchObject({ reason, message: `Response incomplete: ${reason}` });
			});
		}
	}

	for (const error of [null, {}, { message: "" }, { detail: "   " }, { code: "", type: "" }]) {
		test(`normal completed response with error:${JSON.stringify(error)} retains usage and finalizes pending tools`, () => {
			const pending = { callId: "call-1", name: "Read", args: "{}", emitted: false };
			const events = parseResponsesAPIEvent(
				{
					type: "response.completed",
					response: {
						status: "completed",
						error,
						usage: { input_tokens: 11, output_tokens: 2 },
					},
				},
				new Map([[0, pending]]),
				new Map(),
			);
			expect(events).toHaveLength(2);
			expect(events[0]?.usage?.inputTokens).toBe(11);
			expect(events[1]?.toolUseChunk).toMatchObject({ toolUseId: "call-1", stop: true });
			expect(events.some((event) => event.invalidState)).toBe(false);
			expect(pending.emitted).toBe(true);
		});
	}

	for (const shape of [
		{ status: 200, message: "ok" },
		{ status: 200, message: "ok", error: {} },
		{ type: "usage", error: { message: "" }, usage: { input_tokens: 5 } },
		{ code: "custom_provider_code" },
		{ code: "custom_provider_code", statusCode: "200", message: "ok" },
		{ type: "metadata", code: "custom_provider_code", message: "metadata updated", error: {} },
		{ type: "metadata", status_code: "200", message: "ok", metadata: { error: "old failure" } },
		{ type: "usage", statusCode: 200, code: "ok", message: "ok", usage: { input_tokens: 5 } },
		{
			type: "response.completed",
			response: {
				status: "completed",
				error: null,
				output: [{ type: "function_call_output", output: { error: "tool failed" } }],
			},
		},
	]) {
		test(`does not turn normal metadata or tool output into invalidState: ${JSON.stringify(shape)}`, () => {
			expect(parseResponses(shape).some((event) => event.invalidState)).toBe(false);
		});
	}

	test("leaves content frames untouched", () => {
		// Guards the same false-positive risk at the parser level, where a misread
		// would surface as a failed turn rather than a dropped message.
		expect(parseResponses({ type: "response.completed", response: { id: "r" } })).toEqual([]);
	});
});

describe("end to end through a real SSE stream", () => {
	async function withSSE<T>(
		sseBody: string,
		consume: (provider: OpenAIProvider) => Promise<T>,
	): Promise<T> {
		const provider = new OpenAIProvider({
			id: "test-openai",
			name: "Test OpenAI",
			prefix: "openai",
			apiKey: "test-key",
			baseUrl: "https://example.com/v1",
			defaultModel: "gpt-5",
			apiMode: "responses",
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(sseBody, {
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof fetch;
		try {
			return await consume(provider);
		} finally {
			globalThis.fetch = originalFetch;
		}
	}

	async function failureFor(sseBody: string): Promise<unknown> {
		return withSSE(sseBody, async (provider) => {
			try {
				await provider.generateWithMeta("prompt", "openai:gpt-5");
				return undefined;
			} catch (error) {
				return error;
			}
		});
	}

	async function failureTextFor(sseBody: string): Promise<string> {
		const error = await failureFor(sseBody);
		return error instanceof Error ? error.message : String(error);
	}

	test("a bare error frame reaches the user with the upstream text", async () => {
		const message = await failureTextFor(
			'data: {"error":{"message":"upstream pool exhausted","code":"server_error"}}\n\n',
		);

		expect(message).toContain("upstream pool exhausted");
		// The regression symptom: the frame parsed to nothing, the stream looked like it
		// simply ended, and this generic reason replaced the real explanation.
		expect(message).not.toContain("stream_closed_before_response_completed");
		expect(message).not.toContain("No Responses API events were parsed");
	});

	test("a typed error frame still reaches the user unchanged", async () => {
		const message = await failureTextFor(
			'data: {"type":"error","error":{"message":"canonical failure","code":"server_error"}}\n\n',
		);

		expect(message).toContain("canonical failure");
	});

	test("SSE completion limits cannot turn an explicit policy block into a continuation", async () => {
		const error = await failureFor(
			'data: {"type":"response.completed","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"error":{"code":"CYBER-POLICY","message":"request blocked"}}}\n\n',
		);
		expect(error).toMatchObject({
			reason: "cyber_policy",
			classification: "content_filter",
			retryable: false,
			diagnostics: { code: "CYBER-POLICY", reason: "cyber_policy" },
		});
	});

	test("a bare provider-specific code keeps its message through SSE", async () => {
		const error = await failureFor(
			'data: {"code":"insufficient_credits","message":"Insufficient credits"}\n\n',
		);
		expect(error).toMatchObject({
			reason: "insufficient_credits",
			diagnostics: { code: "insufficient_credits", message: "Insufficient credits" },
		});
	});

	for (const withUsage of [false, true]) {
		test(`completed frame with a failed response reaches SSE consumers${withUsage ? " with usage" : ""}`, async () => {
			const error = await failureFor(
				`data: ${JSON.stringify({
					type: "response.completed",
					response: {
						status: "failed",
						error: { type: "server_error", statusCode: "503", detail: "upstream unavailable" },
						usage: withUsage ? { input_tokens: 11, output_tokens: 2 } : undefined,
					},
				})}\n\n`,
			);
			expect(error).toMatchObject({
				reason: "server_error",
				status: 503,
				classification: "transient",
				diagnostics: {
					statusCode: 503,
					code: "server_error",
					message: "upstream unavailable",
				},
			});
		});
	}

	for (const trailing of [
		"",
		"\n\n",
		'\n\ndata: {"type":"response.output_text.delta","delta":"must not emit"}\n\n',
	]) {
		test(`SSE failure stops without flushing partial tools (suffix ${JSON.stringify(trailing)})`, async () => {
			const events = await withSSE(
				'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call-1","name":"Read"}}\n\n' +
					'data: {"type":"response.completed","response":{"status":"failed","error":"upstream stopped"}}' +
					trailing,
				async (provider) => {
					const events: ParsedStreamEvent[] = [];
					for await (const event of provider.chat({
						conversationId: "test-upstream-failure",
						content: "prompt",
						model: "openai:gpt-5",
						cwd: process.cwd(),
						history: [],
						tools: [],
						toolResults: [],
						signal: new AbortController().signal,
					})) {
						events.push(event);
					}
					return events;
				},
			);
			expect(events).toHaveLength(2);
			expect(events.at(-1)?.invalidState?.message).toBe("upstream stopped");
			expect(events.some((event) => event.toolUseChunk?.stop || event.text)).toBe(false);
		});
	}
});

describe("Codex WebSocket wrapped-error parser", () => {
	for (const [name, shape, expected] of UNDISCRIMINATED_SHAPES) {
		test(`recognizes ${name}`, () => {
			const wrapped = parseCodexWrappedError(JSON.stringify(shape));
			expect(wrapped?.error?.message).toBe(expected);
		});
	}

	test("returns null for a frame that is not an error", () => {
		expect(parseCodexWrappedError(JSON.stringify({ type: "response.created" }))).toBeNull();
	});
});
