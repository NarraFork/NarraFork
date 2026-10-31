/**
 * Native structured-output mapping, per adapter.
 *
 * The shared helpers are unit-tested elsewhere; this file pins what actually
 * reaches each provider's request, and that a payload which cannot satisfy the
 * schema is *reported* rather than passed off as structure.
 */
import { describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../anthropic-provider";
import { GeminiProvider } from "../gemini-provider";
import { generateWithFirstTokenTimeout } from "../generate-first-token-timeout";
import { OpenAIProvider } from "../openai-provider";
import type { ResponseFormat } from "../provider";

const FORMAT: ResponseFormat = {
	type: "json_schema",
	name: "prompt_optimize_result",
	schema: {
		type: "object",
		properties: {
			optimizedPrompt: { type: "string" },
			reasoningSummary: { type: "string" },
		},
		required: ["optimizedPrompt", "reasoningSummary"],
		additionalProperties: false,
	},
	strict: true,
	summaryField: "reasoningSummary",
};

/** A payload satisfying FORMAT, with the rationale included. */
const WITH_SUMMARY =
	'{"optimizedPrompt":"写一个登录页面。","reasoningSummary":"补充了字段与校验。"}';

type Captured = { url: string; body: Record<string, unknown> };

/** Drive a provider with fetch stubbed, capturing the request and returning the result. */
async function drive<P, T>(
	provider: P,
	body: string,
	run: (provider: P) => Promise<T>,
	contentType = "text/event-stream",
): Promise<{ request: Captured; result: T }> {
	let captured: Captured | undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		captured = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		};
		return new Response(body, {
			status: 200,
			headers: { "content-type": contentType },
		});
		// biome-ignore lint/suspicious/noExplicitAny: fetch stub
	}) as any;
	try {
		const result = await run(provider);
		return { request: captured as Captured, result };
	} finally {
		globalThis.fetch = realFetch;
	}
}

const chatSse = (content: string) =>
	[
		`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
		`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
		"data: [DONE]\n\n",
	].join("");

describe("OpenAI chat completions", () => {
	const create = () =>
		new OpenAIProvider({
			name: "test",
			prefix: "openai",
			apiKey: "sk-test",
			apiMode: "completions",
			baseUrl: "https://api.openai.test/v1",
			// biome-ignore lint/suspicious/noExplicitAny: test config subset
		} as any);

	test("sends response_format.json_schema and parses the payload", async () => {
		const { request, result } = await drive(
			create(),
			chatSse(WITH_SUMMARY),
			(provider: OpenAIProvider) =>
				provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.response_format).toEqual({
			type: "json_schema",
			json_schema: { name: "prompt_optimize_result", schema: FORMAT.schema, strict: true },
		});
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		expect(result.responseFormatDegraded).toBeUndefined();
	});

	test("the schema carries reasoningSummary in required", async () => {
		const { request } = await drive(create(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		const jsonSchema = (request.body.response_format as { json_schema: Record<string, unknown> })
			.json_schema;
		expect(jsonSchema.schema).toMatchObject({
			required: ["optimizedPrompt", "reasoningSummary"],
			additionalProperties: false,
		});
	});

	test("lifts the summary as a separate field, never appended to the text", async () => {
		const { result } = await drive(create(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
		// `text` stays the raw provider output (the JSON payload itself); the
		// summary is reported beside it, not concatenated onto it. Deciding what
		// reaches the composer is the route's job, not the adapter's.
		expect(result.text).toBe(WITH_SUMMARY);
	});

	test("no summary field means no reasoningSummary", async () => {
		const { result } = await drive(
			create(),
			chatSse('{"optimizedPrompt":"写一个登录页面。"}'),
			(provider) =>
				provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(result.structured).toBeDefined();
		expect(result.reasoningSummary).toBeUndefined();
	});

	test("reports degradation when the reply is prose", async () => {
		const { result } = await drive(create(), chatSse("Here is your prompt."), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(result.structured).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("OpenAI");
	});

	test("omits response_format entirely when no format is requested", async () => {
		const { request } = await drive(create(), chatSse("plain"), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys"),
		);
		expect(request.body).not.toHaveProperty("response_format");
	});
});

describe("OpenAI Responses", () => {
	const create = () =>
		new OpenAIProvider({
			name: "test",
			prefix: "openai",
			apiKey: "sk-test",
			apiMode: "responses",
			baseUrl: "https://api.openai.test/v1",
			// biome-ignore lint/suspicious/noExplicitAny: test config subset
		} as any);

	/** Responses SSE: text deltas, then a completion event (required by the parser). */
	const responsesSse = (chunks: string[]) =>
		[
			...chunks.map(
				(delta) =>
					`event: response.output_text.delta\ndata: ${JSON.stringify({
						type: "response.output_text.delta",
						delta,
					})}\n\n`,
			),
			`event: response.completed\ndata: ${JSON.stringify({
				type: "response.completed",
				response: { status: "completed", output: [] },
			})}\n\n`,
		].join("");

	test("sends the constraint as text.format and parses the payload", async () => {
		const { request, result } = await drive(create(), responsesSse([WITH_SUMMARY]), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);

		// The Responses API expresses the constraint at `text.format`, NOT
		// `response_format` — sending the chat shape here is silently ignored.
		expect(request.url).toContain("/responses");
		expect(request.body).not.toHaveProperty("response_format");
		expect(request.body.text).toEqual({
			format: {
				type: "json_schema",
				name: "prompt_optimize_result",
				schema: FORMAT.schema,
				strict: true,
			},
		});

		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("lifts the summary when the payload is split across deltas", async () => {
		// Deliberately split mid-token: this is how a real stream arrives, and the
		// JSON must only be parsed once the whole payload has accumulated.
		const split = [WITH_SUMMARY.slice(0, 20), WITH_SUMMARY.slice(20, 45), WITH_SUMMARY.slice(45)];
		const { result } = await drive(create(), responsesSse(split), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("lifts the summary from a non-streaming JSON body", async () => {
		const json = {
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: WITH_SUMMARY }],
				},
			],
		};
		// A relay that ignores stream=true answers with JSON. Serve it as JSON, or
		// the SSE parser will (correctly) report a truncated stream.
		const { result } = await drive(
			create(),
			JSON.stringify(json),
			(provider) =>
				provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
			"application/json",
		);
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("a prose reply degrades and reports no summary", async () => {
		const { result } = await drive(create(), responsesSse(["Here is your prompt."]), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(result.structured).toBeUndefined();
		expect(result.reasoningSummary).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("OpenAI");
	});

	test("omits text entirely when no format is requested", async () => {
		const { request } = await drive(create(), responsesSse(["plain"]), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys"),
		);
		expect(request.body).not.toHaveProperty("text");
	});
});

describe("Anthropic forced-tool mode", () => {
	const create = () =>
		new AnthropicProvider({
			name: "test",
			prefix: "anthropic",
			apiKey: "sk-test",
			baseUrl: "https://api.anthropic.test/v1",
			// biome-ignore lint/suspicious/noExplicitAny: test config subset
		} as any);

	const toolSse = (args: string) =>
		[
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"prompt_optimize_result"}}\n\n',
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } })}\n\n`,
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");

	for (const scenario of ["complete", "empty", "cancel"] as const) {
		test(`tool arguments count as first output, never text or reasoning (${scenario})`, async () => {
			const realFetch = globalThis.fetch;
			const request = new AbortController();
			const encoder = new TextEncoder();
			const textDeltas: string[] = [];
			const reasoningDeltas: string[] = [];
			let progress = 0;
			let completed = false;
			globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
				const signal = init?.signal;
				const firstInput = scenario === "empty" ? "" : WITH_SUMMARY.slice(0, 20);
				const sse = toolSse(firstInput);
				const stop = sse.indexOf("event: content_block_stop");
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(encoder.encode(sse.slice(0, stop)));
						const timer = setTimeout(() => {
							signal?.removeEventListener("abort", onAbort);
							const rest = `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: WITH_SUMMARY.slice(firstInput.length) } })}\n\n`;
							controller.enqueue(encoder.encode(rest + sse.slice(stop)));
							completed = true;
							controller.close();
						}, 60);
						const onAbort = () => {
							clearTimeout(timer);
							controller.error(signal?.reason);
						};
						signal?.addEventListener("abort", onAbort, { once: true });
					},
				});
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			}) as typeof fetch;
			try {
				const pending = generateWithFirstTokenTimeout(
					(options) =>
						create().generateWithMeta("draft", "anthropic:claude-opus-4-5", "sys", {
							...options,
							responseFormat: FORMAT,
							reasoningEffort: "none",
							onTextDelta: (delta) => {
								textDeltas.push(delta);
								return options.onTextDelta?.(delta);
							},
							onReasoningDelta: (delta) => {
								reasoningDeltas.push(delta);
								return options.onReasoningDelta?.(delta);
							},
							onGenerationProgress: async () => {
								progress++;
								await options.onGenerationProgress?.();
								if (scenario === "cancel") request.abort();
							},
						}),
					20,
					request.signal,
				);
				if (scenario === "complete") {
					const result = await pending;
					expect(result.structured).toEqual(JSON.parse(WITH_SUMMARY));
					expect(result.text).toBe("");
					expect(progress).toBeGreaterThan(0);
					expect(completed).toBe(true);
				} else {
					await expect(pending).rejects.toMatchObject({
						name: scenario === "empty" ? "TimeoutError" : "AbortError",
					});
					expect(completed).toBe(false);
					if (scenario === "empty") expect(progress).toBe(0);
				}
				expect(textDeltas).toEqual([]);
				expect(reasoningDeltas).toEqual([]);
			} finally {
				globalThis.fetch = realFetch;
			}
		});
	}

	test("declares the schema as a forced tool and parses its arguments", async () => {
		const { request, result } = await drive(
			create(),
			toolSse(WITH_SUMMARY),
			(provider: AnthropicProvider) =>
				provider.generateWithMeta("draft", "anthropic:claude-opus-4-5", "sys", {
					responseFormat: FORMAT,
					// Forced tool_choice is only legal without extended thinking.
					reasoningEffort: "none",
				}),
		);
		expect(request.body.tools).toEqual([
			{
				name: "prompt_optimize_result",
				description: expect.any(String),
				input_schema: FORMAT.schema,
			},
		]);
		expect(request.body.tool_choice).toEqual({
			type: "tool",
			name: "prompt_optimize_result",
		});
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		// The tool input_schema is the same shared schema, so it carries the field.
		const inputSchema = (request.body.tools as Array<{ input_schema: Record<string, unknown> }>)[0]
			.input_schema;
		expect(inputSchema.required).toEqual(["optimizedPrompt", "reasoningSummary"]);
		// Anthropic lifts the summary through the same rule as every other adapter.
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("declines explicitly while extended thinking is active", async () => {
		// Sonnet 5.5 cannot turn reasoning off, so `none` is promoted to a real
		// level. Forcing a tool is illegal alongside thinking, so the adapter must
		// report the degradation instead of attaching a tool_choice the upstream
		// would reject.
		const { request, result } = await drive(create(), toolSse("{}"), (provider) =>
			provider.generateWithMeta("draft", "anthropic:claude-sonnet-5-5", "sys", {
				responseFormat: FORMAT,
				reasoningEffort: "none",
			}),
		);
		expect(request.body.thinking).toBeDefined();
		expect(request.body.tools).toBeUndefined();
		expect(request.body.tool_choice).toBeUndefined();
		expect(result.structured).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("thinking");
	});

	test("omits tools entirely when no format is requested", async () => {
		const { request } = await drive(create(), toolSse("{}"), (provider) =>
			provider.generateWithMeta("draft", "anthropic:claude-opus-4-5", "sys", {
				reasoningEffort: "none",
			}),
		);
		expect(request.body).not.toHaveProperty("tools");
		expect(request.body).not.toHaveProperty("tool_choice");
	});

	test("no tool call means a reported degradation, not silent success", async () => {
		const plainSse = [
			'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"prose"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		const { result } = await drive(create(), plainSse, (provider) =>
			provider.generateWithMeta("draft", "anthropic:claude-sonnet-5-5", "sys", {
				responseFormat: FORMAT,
				reasoningEffort: "none",
			}),
		);
		expect(result.structured).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("Anthropic");
	});
});

describe("Gemini responseSchema", () => {
	const create = () =>
		new GeminiProvider({
			name: "test",
			prefix: "gemini",
			apiKey: "gm-test",
			baseUrl: "https://generativelanguage.test/v1beta",
			// biome-ignore lint/suspicious/noExplicitAny: test config subset
		} as any);

	const geminiSse = (text: string) =>
		`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;

	test("sends responseMimeType plus a projected responseSchema", async () => {
		const { request, result } = await drive(
			create(),
			geminiSse(WITH_SUMMARY),
			(provider: GeminiProvider) =>
				provider.generateWithMeta("draft", "gemini:gemini-3-pro", "sys", {
					responseFormat: FORMAT,
				}),
		);
		const config = request.body.generationConfig as Record<string, unknown>;
		expect(config.responseMimeType).toBe("application/json");
		// additionalProperties is not part of Gemini's schema dialect, but the
		// summary field survives the projection.
		expect(config.responseSchema).not.toHaveProperty("additionalProperties");
		expect(config.responseSchema).toMatchObject({
			required: ["optimizedPrompt", "reasoningSummary"],
		});
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
	});
});
