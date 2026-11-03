/**
 * Text-instruction fallback for relays that ignore a native structured-output
 * constraint.
 *
 * Native `json_schema` / `text.format` is the first choice and is left alone
 * wherever it works. This file pins the downgrade: a relay that has already
 * proven it drops the constraint is asked for JSON in the instruction instead,
 * and the reply is parsed with the same tolerant parser — every field survives,
 * only the *guarantee* is gone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAIProvider } from "../openai-provider";
import type { ResponseFormat } from "../provider";
import {
	modelLacksNativeStructuredOutput,
	rememberMissingNativeStructuredOutput,
	renderSchemaInstruction,
	resetStructuredOutputFallbackMemory,
	structuredOutputRelayKey,
	withSchemaInstruction,
} from "../structured-output-fallback";
import { ApiError } from "../types";
import {
	resetUnsupportedParameterMemory,
	withUnsupportedParameterFallback,
} from "../unsupported-parameter-fallback";

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

const WITH_SUMMARY =
	'{"optimizedPrompt":"写一个登录页面。","reasoningSummary":"补充了字段与校验。"}';

/** The relay under test: a known-bad upstream, distinct from other test files. */
const RELAY_MODEL = "geek2api:deepseek-v4.1-flash";

/**
 * Capability is learned per (apiMode, model): the two endpoints carry different
 * fields, and a relay may implement one while dropping the other.
 */
const CHAT_KEY = structuredOutputRelayKey("completions", RELAY_MODEL);
const RESPONSES_KEY = structuredOutputRelayKey("responses", RELAY_MODEL);

type Captured = { url: string; body: Record<string, unknown> };

async function drive<T>(
	provider: OpenAIProvider,
	body: string,
	run: (provider: OpenAIProvider) => Promise<T>,
	contentType = "text/event-stream",
): Promise<{ request: Captured; result: T }> {
	let captured: Captured | undefined;
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		captured = {
			url: String(input),
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		};
		return new Response(body, { status: 200, headers: { "content-type": contentType } });
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

const chatProvider = () =>
	new OpenAIProvider({
		name: "relay",
		prefix: "geek2api",
		apiKey: "sk-test",
		apiMode: "completions",
		baseUrl: "https://relay.test/v1",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

const responsesProvider = () =>
	new OpenAIProvider({
		name: "relay",
		prefix: "geek2api",
		apiKey: "sk-test",
		apiMode: "responses",
		baseUrl: "https://relay.test/v1",
		// biome-ignore lint/suspicious/noExplicitAny: test config subset
	} as any);

const realFetch = globalThis.fetch;

function captureFetch(
	respond: (attempt: number, signal?: AbortSignal | null) => Response | Promise<Response>,
) {
	const requests: Captured[] = [];
	globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
		requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
		return respond(requests.length, init?.signal);
	}) as typeof fetch;
	return requests;
}

const rejection = (message: string, status = 400) =>
	Response.json({ error: { message, type: "invalid_request_error" } }, { status });

beforeEach(() => {
	resetStructuredOutputFallbackMemory();
	resetUnsupportedParameterMemory();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("learned relay memory", () => {
	test("nothing is downgraded before a failure is observed", () => {
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(false);
	});

	test("a failure is remembered per model", () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);
		// Knowledge is per relay/model: a different upstream is untouched.
		expect(
			modelLacksNativeStructuredOutput(structuredOutputRelayKey("completions", "openai:gpt-5")),
		).toBe(false);
	});

	test("remembering the same model twice is idempotent", () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);
	});
});

describe("schema instruction rendering", () => {
	test("serializes the actual schema, not a summary of it", () => {
		const instruction = renderSchemaInstruction(FORMAT);
		// The model must see the real field names and the required list.
		expect(instruction).toContain("optimizedPrompt");
		expect(instruction).toContain("reasoningSummary");
		expect(instruction).toContain('"required"');
		// and it must be told the output shape unambiguously.
		expect(instruction.toLowerCase()).toContain("json only");
		expect(instruction).toContain("no markdown");
	});

	test("appends to the caller's instruction instead of replacing it", () => {
		const merged = withSchemaInstruction("你是提示词优化器。", FORMAT);
		expect(merged.startsWith("你是提示词优化器。")).toBe(true);
		expect(merged).toContain("optimizedPrompt");
	});

	test("works when the caller has no system instruction at all", () => {
		const merged = withSchemaInstruction(undefined, FORMAT);
		expect(merged.startsWith("\n")).toBe(false);
		expect(merged).toContain("optimizedPrompt");
	});
});

describe("chat completions downgrade", () => {
	test("a known-bad relay gets the schema in the system message, not response_format", async () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { request, result } = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);

		expect(request.body).not.toHaveProperty("response_format");
		const messages = request.body.messages as Array<{ role: string; content: string }>;
		expect(messages[0].role).toBe("system");
		expect(messages[0].content).toContain("optimizedPrompt");
		// The caller's own instruction survives the merge.
		expect(messages[0].content.startsWith("sys")).toBe(true);

		// And the reply is still parsed into the same fields.
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
		expect(result.reasoningSummary).toBe("补充了字段与校验。");
		// Nothing was reported as degraded: the text path honoured the contract.
		expect(result.responseFormatDegraded).toBeUndefined();
	});

	test("a relay that ignores the instruction still degrades honestly", async () => {
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { result } = await drive(chatProvider(), chatSse("Here is your prompt."), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(result.structured).toBeUndefined();
		expect(result.reasoningSummary).toBeUndefined();
		expect(result.responseFormatDegraded).toContain("OpenAI");
	});

	test("a supported upstream keeps the native constraint", async () => {
		const { request } = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.response_format).toEqual({
			type: "json_schema",
			json_schema: { name: "prompt_optimize_result", schema: FORMAT.schema, strict: true },
		});
		const messages = request.body.messages as Array<{ role: string; content: string }>;
		// The system instruction is left exactly as the caller wrote it.
		expect(messages[0].content).toBe("sys");
	});
});

describe("OpenAI Responses downgrade", () => {
	test("a known-bad relay gets the schema in instructions, not text.format", async () => {
		rememberMissingNativeStructuredOutput(RESPONSES_KEY);
		const { request, result } = await drive(
			responsesProvider(),
			responsesSse([WITH_SUMMARY]),
			(provider) =>
				provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);

		// This is the case observed against the geek2api relay: it accepted
		// `text.format`, answered in prose, and the summary silently vanished.
		expect(request.body).not.toHaveProperty("text");
		expect(request.body).not.toHaveProperty("response_format");
		expect(String(request.body.instructions)).toContain("optimizedPrompt");
		expect(String(request.body.instructions).startsWith("sys")).toBe(true);

		expect(result.reasoningSummary).toBe("补充了字段与校验。");
		expect(result.structured).toEqual({
			optimizedPrompt: "写一个登录页面。",
			reasoningSummary: "补充了字段与校验。",
		});
	});

	test("a supported upstream keeps text.format", async () => {
		const { request } = await drive(responsesProvider(), responsesSse([WITH_SUMMARY]), (provider) =>
			provider.generateWithMeta("draft", "openai:gpt-5", "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.text).toEqual({
			format: {
				type: "json_schema",
				name: "prompt_optimize_result",
				schema: FORMAT.schema,
				strict: true,
			},
		});
		expect(request.body.instructions).toBe("sys");
	});

	test("a chat-only failure does not downgrade the Responses endpoint", async () => {
		// The same relay, but only the chat endpoint has been observed dropping
		// the constraint. `text.format` is a different field on a different
		// endpoint, so this request must still carry the native constraint.
		rememberMissingNativeStructuredOutput(CHAT_KEY);
		const { request } = await drive(responsesProvider(), responsesSse([WITH_SUMMARY]), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(request.body).toHaveProperty("text");
		expect(request.body.instructions).toBe("sys");
	});
});

describe("explicit structured-output rejection", () => {
	for (const mode of ["completions", "responses"] as const) {
		const create = mode === "completions" ? chatProvider : responsesProvider;
		const parameter = mode === "completions" ? "response_format" : "text.format";
		const key = structuredOutputRelayKey(mode, RELAY_MODEL);
		const success = () =>
			new Response(mode === "completions" ? chatSse(WITH_SUMMARY) : responsesSse([WITH_SUMMARY]), {
				headers: { "content-type": "text/event-stream" },
			});
		const instructionOf = (body: Record<string, unknown>) =>
			mode === "responses"
				? String(body.instructions)
				: (body.messages as Array<{ content: string }>)[0].content;
		const nativeOf = (body: Record<string, unknown>) =>
			mode === "responses"
				? (body.text as { format?: unknown } | undefined)?.format
				: body.response_format;

		for (const message of [
			`${parameter} is not supported`,
			`Unsupported parameter: ${parameter}`,
			`Invalid parameter: '${parameter}' of type 'json_schema' is not supported with this model.`,
		]) {
			test(`${mode}: ${message} retries once with the schema instruction, then remembers`, async () => {
				const requests = captureFetch((attempt) =>
					attempt === 1 ? rejection(message) : success(),
				);
				const provider = create();
				const result = await provider.generateWithMeta("draft", RELAY_MODEL, "sys", {
					responseFormat: FORMAT,
				});
				expect(requests).toHaveLength(2);
				expect(nativeOf(requests[0].body)).toBeDefined();
				expect(instructionOf(requests[0].body)).toBe("sys");
				expect(nativeOf(requests[1].body)).toBeUndefined();
				expect(instructionOf(requests[1].body)).toBe(withSchemaInstruction("sys", FORMAT));
				expect(result.structured).toEqual(JSON.parse(WITH_SUMMARY));
				expect(result.reasoningSummary).toBe("补充了字段与校验。");
				expect(modelLacksNativeStructuredOutput(key)).toBe(true);
				await provider.generateWithMeta("draft again", RELAY_MODEL, "sys", {
					responseFormat: FORMAT,
				});
				expect(requests).toHaveLength(3);
				expect(nativeOf(requests[2].body)).toBeUndefined();
				expect(instructionOf(requests[2].body)).toBe(withSchemaInstruction("sys", FORMAT));
			});
		}

		for (const message of [
			"Invalid input",
			`Invalid schema for ${parameter}: property not supported`,
		]) {
			test(`${mode}: unrelated 400 does not retry or learn (${message})`, async () => {
				const requests = captureFetch(() => rejection(message));
				await expect(
					create().generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
				).rejects.toMatchObject({ name: "ApiError", status: 400 });
				expect(requests).toHaveLength(1);
				expect(modelLacksNativeStructuredOutput(key)).toBe(false);
			});
		}

		for (const status of [401, 500]) {
			test(`${mode}: format wording in HTTP ${status} does not downgrade`, async () => {
				const requests = captureFetch(() =>
					rejection(`Unsupported parameter: ${parameter}`, status),
				);
				await expect(
					create().generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
				).rejects.toMatchObject({ name: "ApiError", status });
				expect(requests).toHaveLength(1);
				expect(modelLacksNativeStructuredOutput(key)).toBe(false);
			});
		}

		for (const schemaFirst of [true, false]) {
			test(`${mode}: schema and generic parameter fallback cooperate (schema first: ${schemaFirst})`, async () => {
				const limit = mode === "completions" ? "max_tokens" : "max_output_tokens";
				const rejected = schemaFirst ? [parameter, limit] : [limit, parameter];
				const requests = captureFetch((attempt) =>
					attempt <= 2 ? rejection(`Unsupported parameter: ${rejected[attempt - 1]}`) : success(),
				);
				const result = await create().generateWithMeta("draft", RELAY_MODEL, "sys", {
					responseFormat: FORMAT,
					maxOutputTokens: 1024,
				});
				expect(requests).toHaveLength(3);
				expect(requests[0].body[limit]).toBe(1024);
				expect(nativeOf(requests[0].body)).toBeDefined();
				expect(requests[2].body[limit]).toBeUndefined();
				expect(nativeOf(requests[2].body)).toBeUndefined();
				expect(instructionOf(requests[2].body)).toBe(withSchemaInstruction("sys", FORMAT));
				expect(result.structured).toEqual(JSON.parse(WITH_SUMMARY));
			});
		}

		test(`${mode}: callback failure is not mistaken for a rejected API parameter`, async () => {
			const error = new Error(`Unsupported parameter: ${parameter}`);
			const requests = captureFetch(success);
			await expect(
				create().generateWithMeta("draft", RELAY_MODEL, "sys", {
					responseFormat: FORMAT,
					onTextDelta: () => {
						throw error;
					},
				}),
			).rejects.toBe(error);
			expect(requests).toHaveLength(1);
			expect(modelLacksNativeStructuredOutput(key)).toBe(false);
		});

		test(`${mode}: a failed text fallback is not retried again`, async () => {
			const requests = captureFetch(() => rejection(`Unsupported parameter: ${parameter}`));
			await expect(
				create().generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
			).rejects.toMatchObject({ name: "ApiError", status: 400 });
			expect(requests).toHaveLength(2);
		});

		for (const cancelOnAttempt of [1, 2]) {
			test(`${mode}: cancellation on attempt ${cancelOnAttempt} stops fallback`, async () => {
				const controller = new AbortController();
				const reason = new DOMException("Cancelled", "AbortError");
				const requests = captureFetch((attempt, signal) => {
					expect(signal).toBe(controller.signal);
					if (attempt === cancelOnAttempt) controller.abort(reason);
					if (attempt === 1) return rejection(`${parameter} is not supported`);
					signal?.throwIfAborted();
					return success();
				});
				await expect(
					create().generateWithMeta("draft", RELAY_MODEL, "sys", {
						responseFormat: FORMAT,
						signal: controller.signal,
					}),
				).rejects.toBe(reason);
				expect(requests).toHaveLength(cancelOnAttempt);
				if (cancelOnAttempt === 1) expect(modelLacksNativeStructuredOutput(key)).toBe(false);
			});
		}

		test(`${mode}: truncated JSON does not teach a permanent capability failure`, async () => {
			const partial = '{"optimizedPrompt":"';
			const truncated =
				mode === "completions"
					? `data: ${JSON.stringify({ choices: [{ delta: { content: partial }, finish_reason: "length" }] })}\n\ndata: [DONE]\n\n`
					: `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: partial })}\n\nevent: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })}\n\n`;
			const requests = captureFetch((attempt) =>
				attempt === 1
					? new Response(truncated, { headers: { "content-type": "text/event-stream" } })
					: success(),
			);
			const provider = create();
			const result = await provider.generateWithMeta("draft", RELAY_MODEL, "sys", {
				responseFormat: FORMAT,
			});
			expect(result.outputTruncated).toBe(true);
			expect(result.responseFormatDegraded).toBeDefined();
			expect(modelLacksNativeStructuredOutput(key)).toBe(false);
			await provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT });
			expect(nativeOf(requests[1].body)).toBeDefined();
		});
	}

	test("a response_format removed by the generic fallback still becomes an instruction", async () => {
		let attempts = 0;
		await withUnsupportedParameterFallback(RELAY_MODEL, { response_format: {} }, async () => {
			if (++attempts === 1) throw new ApiError(400, "Unsupported parameter: response_format");
		});
		const { request, result } = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(request.body.response_format).toBeUndefined();
		expect((request.body.messages as Array<{ content: string }>)[0].content).toBe(
			withSchemaInstruction("sys", FORMAT),
		);
		expect(result.structured).toEqual(JSON.parse(WITH_SUMMARY));
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);
	});
});

describe("learning happens from a real failure", () => {
	test("a prose reply teaches the provider to stop sending the native constraint", async () => {
		// First call: native constraint requested, relay answers in prose.
		const first = await drive(chatProvider(), chatSse("Here is your prompt."), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(first.request.body).toHaveProperty("response_format");
		expect(first.result.responseFormatDegraded).toContain("OpenAI");
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(true);

		// Second call: the same relay is asked in text instead.
		const second = await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(second.request.body).not.toHaveProperty("response_format");
		expect(second.result.reasoningSummary).toBe("补充了字段与校验。");
	});

	test("a successful native call teaches nothing", async () => {
		await drive(chatProvider(), chatSse(WITH_SUMMARY), (provider) =>
			provider.generateWithMeta("draft", RELAY_MODEL, "sys", { responseFormat: FORMAT }),
		);
		expect(modelLacksNativeStructuredOutput(CHAT_KEY)).toBe(false);
	});
});
