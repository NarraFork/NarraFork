import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import type { AnthropicProviderConfig } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

const provider = new AnthropicProvider({
	id: "loop-invalid-state-anthropic",
	name: "Loop Invalid State Anthropic",
	prefix: "loop-invalid-state",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "claude-test",
} satisfies AnthropicProviderConfig);

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	...realProviderModule,
	getProvider: () => provider as ProviderAdapter,
	resolveProviderAndModel: () => ({
		requestedProvider: "loop-invalid-state",
		requestedModel: "loop-invalid-state:claude-test",
		provider: "loop-invalid-state",
		adapter: provider as ProviderAdapter,
		model: "loop-invalid-state:claude-test",
	}),
}));

const { agentLoop } = await import("../loop");
const originalFetch = globalThis.fetch;

function responseFailed(
	message: string,
	options: { code?: string; diagnosticsCode?: string; statusCode?: number } = {},
): Response {
	const data = options.code
		? {
				type: "error",
				error: { type: options.code, message },
				diagnostics: { statusCode: options.statusCode, code: options.diagnosticsCode },
			}
		: {
				type: "error",
				message,
				diagnostics: { statusCode: options.statusCode, code: options.diagnosticsCode },
			};
	return new Response(`event: error\ndata: ${JSON.stringify(data)}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function structuredInvalidStateResponse(options: {
	reason: string;
	message: string;
	text?: string;
	reasoning?: string;
	completionTokens?: number;
	diagnosticsCode?: string;
}): Response {
	const events = [
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_limited","usage":{"input_tokens":3}}}\n\n',
	];
	if (options.reasoning) {
		events.push(
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: options.reasoning },
			})}\n\n`,
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
		);
	}
	if (options.text) {
		events.push(
			'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 1,
				delta: { type: "text_delta", text: options.text },
			})}\n\n`,
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
		);
	}
	events.push(
		`event: error\ndata: ${JSON.stringify({
			type: "error",
			error: { type: options.reason, message: options.message },
			diagnostics: { code: options.diagnosticsCode },
		})}\n\n`,
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: options.completionTokens ?? 7 },
		})}\n\n`,
		'event: message_stop\ndata: {"type":"message_stop"}\n\n',
	);
	return new Response(events.join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function successfulResponse(text: string): Response {
	return new Response(
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_recovered","usage":{"input_tokens":1}}}\n\n' +
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			})}\n\n` +
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function installResponses(responses: Response[]): () => number {
	let calls = 0;
	globalThis.fetch = (async () => {
		const response = responses[calls++];
		if (!response) throw new Error(`Unexpected fetch call ${calls}`);
		return response;
	}) as unknown as typeof fetch;
	return () => calls;
}

function makeConfig(signal: AbortSignal, overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		narratorId: "n-loop-invalid-state",
		conversationId: "conv-loop-invalid-state",
		model: "loop-invalid-state:claude-test",
		provider: "loop-invalid-state",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: () => false,
		maxTransientRetries: 1,
		retryBackoffCeilMs: 0,
		...overrides,
	};
}

async function runLoop(overrides: Partial<AgentConfig> = {}): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const controller = new AbortController();
	for await (const event of agentLoop(makeConfig(controller.signal, overrides), "answer", {
		rows: [],
	})) {
		events.push(event);
	}
	return events;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

describe("agentLoop provider invalidState classification", () => {
	test("HTTP 200 SSE api_error 会按 diagnostics.statusCode=503 重试", async () => {
		const fetchCalls = installResponses([
			responseFailed("Opaque upstream failure", { statusCode: 503 }),
			successfulResponse("recovered"),
		]);

		const events = await runLoop();

		expect(fetchCalls()).toBe(2);
		expect(events.find((event) => event.type === "retrying")).toMatchObject({
			type: "retrying",
			message: "Opaque upstream failure",
			diagnostics: { reason: "api_error", statusCode: 503 },
		});
		expect(events.find((event) => event.type === "stream_text")).toMatchObject({
			type: "stream_text",
			text: "recovered",
		});
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("503 的 unable to respond 文本不会被宽泛拒绝启发式拦截", async () => {
		const fetchCalls = installResponses([
			responseFailed("Service temporarily unable to respond", { statusCode: 503 }),
			successfulResponse("recovered after 503"),
		]);

		const events = await runLoop();

		expect(fetchCalls()).toBe(2);
		expect(events.find((event) => event.type === "retrying")).toMatchObject({
			type: "retrying",
			message: "Service temporarily unable to respond",
			diagnostics: { reason: "api_error", statusCode: 503 },
		});
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("结构化 refusal 即使携带 503 也保持不可重试", async () => {
		const fetchCalls = installResponses([
			responseFailed("I cannot assist with that request", {
				code: "refusal",
				statusCode: 503,
			}),
		]);

		const events = await runLoop();

		expect(fetchCalls()).toBe(1);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.at(-1)).toMatchObject({
			type: "invalid_state",
			reason: "refusal",
			message: "I cannot assist with that request",
			diagnostics: { statusCode: 503 },
		});
		const end = events.find((event) => event.type === "api_request_end");
		const terminal = events.at(-1);
		if (!end || terminal?.type !== "invalid_state") throw new Error("missing error events");
		expect(terminal.diagnostics).toBe(end.diagnostics);
		expect(terminal.diagnostics?.recordingRequestId).toBe(end.requestId);
		if (!end.diagnostics) throw new Error("missing diagnostics");
		end.diagnostics.apiRequestId = "refusal-durable-row";
		expect(terminal.diagnostics?.apiRequestId).toBe("refusal-durable-row");
	});

	test("max_tokens 含部分文本时保留截断终态并继续消费 usage", async () => {
		const message = "The response exceeds the maximum number of tokens allowed.";
		const fetchCalls = installResponses([
			structuredInvalidStateResponse({
				reason: "max_tokens",
				message,
				text: "partial answer",
				completionTokens: 17,
			}),
		]);

		const events = await runLoop();
		const requestEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "api_request_end" }> =>
				event.type === "api_request_end",
		);

		expect(fetchCalls()).toBe(1);
		expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(requestEnd?.usage?.completionTokens).toBe(17);
		expect(
			events.some((event) => event.type === "assistant_message" && event.text === "partial answer"),
		).toBe(true);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("max_tokens 无文本或工具时不进入 empty-response 重试", async () => {
		const fetchCalls = installResponses([
			structuredInvalidStateResponse({
				reason: "max_tokens",
				message: "The response exceeds the maximum number of tokens allowed.",
				completionTokens: 11,
			}),
		]);

		const events = await runLoop();
		const requestEnd = events.find(
			(event): event is Extract<AgentEvent, { type: "api_request_end" }> =>
				event.type === "api_request_end",
		);

		expect(fetchCalls()).toBe(1);
		expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.some((event) => event.type === "invalid_state")).toBe(false);
		expect(requestEnd?.usage?.completionTokens).toBe(11);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("max_tokens 仅含 reasoning 时不触发 reasoning-only compact 或重试", async () => {
		let compactCalls = 0;
		const fetchCalls = installResponses([
			structuredInvalidStateResponse({
				reason: "max_tokens",
				message: "The response exceeds the maximum number of tokens allowed.",
				reasoning: "unfinished reasoning",
			}),
		]);

		const events = await runLoop({
			getContextUsagePercentage: () => 96,
			onReasoningOnlyHighContext: async () => {
				compactCalls++;
				return null;
			},
		});

		expect(fetchCalls()).toBe(1);
		expect(compactCalls).toBe(0);
		expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
		expect(events.some((event) => event.type === "stream_reset")).toBe(false);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test.each([
		"http",
		"sse",
	])("%s generic reason + diagnostics.code 保留原错且不普通重试", async (transport) => {
		const message = "Opaque original upstream failure";
		const diagnostics = { code: "CONTEXT_LENGTH_EXCEEDED", requestId: "upstream-overflow-id" };
		const response =
			transport === "http"
				? new Response(JSON.stringify({ error: { type: "api_error", message }, diagnostics }), {
						status: 400,
					})
				: new Response(
						`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message }, diagnostics })}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
		const calls = installResponses([response]);
		const events = await runLoop();
		expect(calls()).toBe(1);
		expect(events.filter((event) => event.type === "context_length_exceeded")).toHaveLength(1);
		expect(
			events.some((event) => event.type === "retrying" || event.type === "retryable_error"),
		).toBe(false);
		const end = events.find((event) => event.type === "api_request_end");
		expect(end?.diagnostics).toMatchObject({
			...diagnostics,
			message: expect.stringContaining(message),
		});
		expect(events.at(-1)).toMatchObject({
			type: "context_length_exceeded",
			message: expect.stringContaining(message),
		});
	});

	test.each([
		"http",
		"sse",
	])("%s 接受已证实中文提示词溢出，不扩大到模糊内容过长", async (transport) => {
		for (const [message, overflow] of [
			["请求提示词超出模型上限", true],
			["内容过长", false],
		] as const) {
			const response =
				transport === "http"
					? new Response(JSON.stringify({ error: { type: "api_error", message } }), { status: 400 })
					: responseFailed(message, { code: "api_error", statusCode: 400 });
			const calls = installResponses([response]);
			const events = await runLoop();
			expect(calls()).toBe(1);
			expect(events.some((event) => event.type === "context_length_exceeded")).toBe(overflow);
		}
	});

	test.each([
		"max_tokens",
		"max_output_tokens",
		"length",
	])("%s 与 context code 冲突时保持输出截断", async (reason) => {
		const calls = installResponses([
			structuredInvalidStateResponse({
				reason,
				message: "input exceeds the context window",
				diagnosticsCode: "CONTEXT_LENGTH_EXCEEDED",
				text: "partial answer",
			}),
		]);
		const events = await runLoop();
		expect(calls()).toBe(1);
		expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
		expect(
			events.some((event) => event.type === "context_length_exceeded" || event.type === "retrying"),
		).toBe(false);
	});

	test("SSE context reason 不能覆盖 diagnostics.code 的显式输出限制", async () => {
		const calls = installResponses([
			structuredInvalidStateResponse({
				reason: "model_context_window_exceeded",
				message: "context window exceeded",
				diagnosticsCode: "max_output_tokens",
				text: "partial",
			}),
		]);
		const events = await runLoop();
		expect(calls()).toBe(1);
		expect(events.filter((event) => event.type === "output_truncated")).toHaveLength(1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
	});

	test("HTTP throw 的 CONTEXT_LENGTH_EXCEEDED 特例不能绕过 completion-limit 优先级", async () => {
		let calls = 0;
		globalThis.fetch = (async () => {
			calls++;
			throw Object.assign(new Error("input exceeds the context window"), {
				code: "CONTEXT_LENGTH_EXCEEDED",
				reason: "max_tokens",
			});
		}) as unknown as typeof fetch;
		const events = await runLoop({ maxTransientRetries: 0 });
		expect(calls).toBe(1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});

	test("真正的 context overflow 仍进入 context_length_exceeded", async () => {
		const message = "The input token count exceeds the maximum number of tokens allowed.";
		const fetchCalls = installResponses([
			structuredInvalidStateResponse({
				reason: "model_context_window_exceeded",
				message,
			}),
		]);

		const events = await runLoop();

		expect(fetchCalls()).toBe(1);
		expect(events.some((event) => event.type === "output_truncated")).toBe(false);
		expect(events.some((event) => event.type === "retrying")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "context_length_exceeded", message });
	});
});
