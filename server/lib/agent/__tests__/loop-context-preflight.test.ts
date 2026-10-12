import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { getSearchExecutionScope, withSearchExecutionScope } from "../../search/execution-scope";
import { type AnthropicProviderConfig, DEFAULT_CONTEXT_WINDOW, settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import { estimatePayloadTokens } from "../context-preflight";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

const MODEL_REF = "loop-preflight:claude-test";

const provider = new AnthropicProvider({
	id: "loop-preflight-anthropic",
	name: "Loop Preflight Anthropic",
	prefix: "loop-preflight",
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "claude-test",
} satisfies AnthropicProviderConfig);

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	...realProviderModule,
	getProvider: () => provider as ProviderAdapter,
	resolveProviderAndModel: () => ({
		requestedProvider: "loop-preflight",
		requestedModel: MODEL_REF,
		provider: "loop-preflight",
		adapter: provider as ProviderAdapter,
		model: MODEL_REF,
	}),
}));

const { agentLoop } = await import("../loop");
const originalFetch = globalThis.fetch;

function successfulResponse(text: string): Response {
	return new Response(
		'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_preflight","usage":{"input_tokens":1}}}\n\n' +
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

/** 每个响应只允许被消费一次；多余的调用直接抛错，便于断言"请求根本没发出去"。 */
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
		narratorId: "n-loop-preflight",
		conversationId: "conv-loop-preflight",
		model: MODEL_REF,
		provider: "loop-preflight",
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: () => false,
		maxTransientRetries: 1,
		retryBackoffCeilMs: 0,
		...overrides,
	};
}

async function runLoop(
	history: unknown[],
	overrides: Partial<AgentConfig> = {},
	images?: Array<{ format: string; base64: string }>,
): Promise<AgentEvent[]> {
	const events: AgentEvent[] = [];
	const controller = new AbortController();
	for await (const event of agentLoop(
		makeConfig(controller.signal, overrides),
		"继续",
		history,
		undefined,
		images,
	)) {
		events.push(event);
	}
	return events;
}

const SHORT_HISTORY = [{ role: "user", content: "短历史" }];

/**
 * 120 万 ASCII 字符：即使按 estimate-tokens.ts 里最低的 0.25 token/字符（英文散文）也估到
 * 30 万 token，越过兜底窗口的可用预算（272_000 − 20_000 = 252_000）。刻意留这么宽的余量，
 * 是为了让这条测试不依赖那个共享估算器当前的系数取值。
 */
const OVERSIZED_HISTORY = [{ role: "user", content: "a".repeat(1_200_000) }];

const originalContextPreflightEnabled = settings.agent.contextPreflightEnabled;

afterEach(() => {
	globalThis.fetch = originalFetch;
	settings.agent.contextPreflightEnabled = originalContextPreflightEnabled;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

describe("agentLoop 发送前上下文预检", () => {
	test("超预算：请求根本不发出，直接产出 context_length_exceeded", async () => {
		// 这个 provider/model 在模型目录里不存在，窗口只能走兜底值——同时验证"不 fail-open"。
		const fetchCalls = installResponses([]);

		const events = await runLoop(OVERSIZED_HISTORY);

		// 关键断言：一次 fetch 都没有发生。
		expect(fetchCalls()).toBe(0);
		const overflow = events.filter((event) => event.type === "context_length_exceeded");
		expect(overflow).toHaveLength(1);
		const message = String((overflow[0] as { message: string }).message);
		expect(message).toContain("Preflight estimate");
		expect(message).toContain(String(DEFAULT_CONTEXT_WINDOW));
		// 没有 assistant 输出，也没有把请求标成已发出。
		expect(events.some((event) => event.type === "assistant_message")).toBe(false);
		expect(events.some((event) => event.type === "api_request_start")).toBe(false);
	});

	test("超预算被拦时不消耗搜索执行轮次，真正发出的请求才消耗", async () => {
		const blockedFetch = installResponses([]);
		let remainingWhenBlocked: number | undefined;
		await withSearchExecutionScope(
			{ provider: "loop-preflight", model: MODEL_REF, maxTurns: 3 },
			async () => {
				await runLoop(OVERSIZED_HISTORY);
				remainingWhenBlocked = getSearchExecutionScope()?.remainingTurns;
			},
		);
		expect(blockedFetch()).toBe(0);
		expect(remainingWhenBlocked).toBe(3);

		const sentFetch = installResponses([successfulResponse("ok")]);
		let remainingWhenSent: number | undefined;
		await withSearchExecutionScope(
			{ provider: "loop-preflight", model: MODEL_REF, maxTurns: 3 },
			async () => {
				await runLoop(SHORT_HISTORY);
				remainingWhenSent = getSearchExecutionScope()?.remainingTurns;
			},
		);
		expect(sentFetch()).toBe(1);
		expect(remainingWhenSent).toBe(2);
	});

	test("预算内：正常走到 provider.chat", async () => {
		const fetchCalls = installResponses([successfulResponse("ok")]);

		const events = await runLoop(SHORT_HISTORY);

		expect(fetchCalls()).toBe(1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("开关关闭：即使超预算也照常发出请求", async () => {
		settings.agent.contextPreflightEnabled = false;
		const fetchCalls = installResponses([successfulResponse("ok")]);

		const events = await runLoop(OVERSIZED_HISTORY);

		expect(fetchCalls()).toBe(1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
		expect(events.at(-1)).toEqual({ type: "done" });
	});

	test("同一份超预算历史连续跑多轮，每轮都只产出一个 overflow 事件（循环本身无状态、不累积）", async () => {
		const fetchCalls = installResponses([]);

		for (let pass = 0; pass < 3; pass++) {
			const events = await runLoop(OVERSIZED_HISTORY);
			expect(events.filter((event) => event.type === "context_length_exceeded")).toHaveLength(1);
			// 预检结论对同一份输入是确定性的：不会一会儿放行一会儿拦截。
			expect(estimatePayloadTokens(OVERSIZED_HISTORY).tokens).toBeGreaterThan(
				DEFAULT_CONTEXT_WINDOW - 20_000,
			);
		}
		expect(fetchCalls()).toBe(0);
	});

	test("首轮带图：整段跳过预检，照常发出请求", async () => {
		// 图片是 provider.chat 的独立参数，分片覆盖不到；而图片 token 按分辨率折算、与 base64
		// 长度不成比例，两种折算都会严重失准。因此首轮带图时不做预检，交给错误分类兜底——
		// 同一条超预算历史，不带图会被拦，带图则发出。
		const withImage = installResponses([successfulResponse("ok")]);
		const imageEvents = await runLoop(OVERSIZED_HISTORY, {}, [
			{ format: "png", base64: "a".repeat(64) },
		]);

		expect(withImage()).toBe(1);
		expect(imageEvents.some((event) => event.type === "context_length_exceeded")).toBe(false);

		// 对照：同一份历史不带图时仍然被拦（证明差异来自图片，而不是历史变短了）。
		const withoutImage = installResponses([]);
		const blockedEvents = await runLoop(OVERSIZED_HISTORY);
		expect(withoutImage()).toBe(0);
		expect(blockedEvents.filter((event) => event.type === "context_length_exceeded")).toHaveLength(
			1,
		);
	});
});
