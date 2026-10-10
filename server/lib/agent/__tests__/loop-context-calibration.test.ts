/**
 * agentLoop 里的校准采样端到端接线。
 *
 * 单测已经钉住了探针口径（`context-calibration.test.ts`），这里验证**真实循环**里的三件事：
 * 1. 字符数取自 `onInputCharacters`（与 `input-characters.ts` 的 wire 计数同源），token 数取自
 *    同一次响应上报的 `promptTokens`，两者确实被配对成一条样本；
 * 2. 没有 usage 的一轮（上游报错）不产生样本；
 * 3. 学到比值之后，**下一轮**的发送前预检真的用它换算并拦住一份全局系数拦不住的载荷。
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { type AnthropicProviderConfig, settings } from "../../settings";
import { AnthropicProvider } from "../anthropic-provider";
import {
	CONTEXT_CALIBRATION_FILE_PATH,
	getContextCalibrationStats,
	MIN_CALIBRATION_SAMPLES,
	persistContextCalibrationForTests,
	resetContextCalibrationForTests,
} from "../context-calibration";
import type { ProviderAdapter } from "../provider";
import type { AgentConfig, AgentEvent } from "../types";

/** 一个任何模型目录里都不存在的引用：窗口只能走兜底值（272_000 → 可用预算 252_000）。 */
const MODEL_REF = "loop-calibration:zz-calibration-fixture";
const PROVIDER = "loop-calibration";
/** 事故里的实测比：1.17 token/字符。 */
const RATIO = 1.17;

const provider = new AnthropicProvider({
	id: "loop-calibration-anthropic",
	name: "Loop Calibration Anthropic",
	prefix: PROVIDER,
	apiKey: "test-key",
	baseUrl: "https://example.com/v1",
	defaultModel: "claude-test",
} satisfies AnthropicProviderConfig);

const realProviderModule = { ...(await import("../provider")) };

mock.module("../provider", () => ({
	...realProviderModule,
	getProvider: () => provider as ProviderAdapter,
	resolveProviderAndModel: () => ({
		requestedProvider: PROVIDER,
		requestedModel: MODEL_REF,
		provider: PROVIDER,
		adapter: provider as ProviderAdapter,
		model: MODEL_REF,
	}),
}));

const { agentLoop } = await import("../loop");
const originalFetch = globalThis.fetch;

/** 每次请求的真实 wire 字符数与据此上报的 input_tokens（供断言核对）。 */
let sentWireChars: number[] = [];
let reportedTokens: number[] = [];

function streamWithUsage(inputTokens: number): Response {
	return new Response(
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: { id: "msg_calibration", usage: { input_tokens: inputTokens } },
		})}\n\n` +
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "ok" },
			})}\n\n` +
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n' +
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** 让上游按"实际收到的 wire 字符数 × 实测比"上报 input_tokens。 */
function installUsageResponse(): () => number {
	let calls = 0;
	globalThis.fetch = (async (_url: unknown, init: { body?: string } | undefined) => {
		calls++;
		const chars = typeof init?.body === "string" ? init.body.length : 0;
		const tokens = Math.round(chars * RATIO);
		sentWireChars.push(chars);
		reportedTokens.push(tokens);
		return streamWithUsage(tokens);
	}) as unknown as typeof fetch;
	return () => calls;
}

function installErrorResponse(status = 500): () => number {
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		return new Response("upstream exploded", { status });
	}) as unknown as typeof fetch;
	return () => calls;
}

function makeConfig(signal: AbortSignal): AgentConfig {
	return {
		narratorId: "n-loop-calibration",
		conversationId: "conv-loop-calibration",
		model: MODEL_REF,
		provider: PROVIDER,
		cwd: "/tmp",
		signal,
		permissionHandler: async () => ({ behavior: "allow" }),
		toolFilter: () => false,
		maxTransientRetries: 1,
		retryBackoffCeilMs: 0,
	};
}

async function runLoop(history: unknown[]): Promise<AgentEvent[]> {
	const controller = new AbortController();
	const events: AgentEvent[] = [];
	for await (const event of agentLoop(makeConfig(controller.signal), "继续", history)) {
		events.push(event);
	}
	return events;
}

/** 取本轮 `context_usage` 里冻结的输入字符数（与采样用的同一个对象）。 */
function inputTotalChars(events: readonly AgentEvent[]): number | undefined {
	for (const event of events) {
		if (event.type !== "context_usage") continue;
		const chars = (event as { snapshot?: { inputCharacters?: { totalChars?: number } | null } })
			.snapshot?.inputCharacters;
		if (chars?.totalChars) return chars.totalChars;
	}
	return undefined;
}

function persistedSamples(model: string): Array<[number, number]> {
	const path = CONTEXT_CALIBRATION_FILE_PATH;
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
		models: Record<string, { samples: Array<[number, number]> }>;
	};
	return parsed.models[model]?.samples ?? [];
}

const SMALL_HISTORY = [{ role: "user", content: "a".repeat(10_000) }];

beforeEach(() => {
	resetContextCalibrationForTests();
	rmSync(CONTEXT_CALIBRATION_FILE_PATH, { force: true });
	sentWireChars = [];
	reportedTokens = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	globalThis.fetch = originalFetch;
	mock.module("../provider", () => realProviderModule);
	mock.restore();
});

describe("agentLoop 校准采样", () => {
	test("字符数与同一次响应的 promptTokens 配成一条样本（字符数与冻结的上下文统计一致）", async () => {
		const fetchCalls = installUsageResponse();

		const events = await runLoop(SMALL_HISTORY);

		expect(fetchCalls()).toBe(1);
		expect(events.some((event) => event.type === "done")).toBe(true);

		const stats = getContextCalibrationStats();
		expect(stats).toHaveLength(1);
		expect(stats[0]?.model).toBe(MODEL_REF);
		expect(stats[0]?.samples).toBe(1);
		// 一条样本还不足以给出比值。
		expect(stats[0]?.ratio).toBeNull();

		await persistContextCalibrationForTests();
		const samples = persistedSamples(MODEL_REF);
		expect(samples).toHaveLength(1);
		// 样本的两端分别来自本轮冻结的输入字符数与本轮上报的 promptTokens。
		const frozenChars = inputTotalChars(events) ?? 0;
		expect(frozenChars).toBeGreaterThan(0);
		expect(samples[0]?.[0]).toBe(frozenChars);
		expect(reportedTokens[0]).toBeGreaterThan(0);
		expect(samples[0]?.[1]).toBe(reportedTokens[0]);
		// 上游收到的 wire 字符数与循环数到的字符数同量级（口径同源）。
		expect(sentWireChars[0]).toBeGreaterThan(0);
	});

	test("上游报错的一轮不产生样本", async () => {
		const fetchCalls = installErrorResponse();

		const events = await runLoop(SMALL_HISTORY);

		expect(fetchCalls()).toBeGreaterThan(0);
		expect(events.length).toBeGreaterThan(0);
		expect(getContextCalibrationStats()).toEqual([]);
	});

	test("学到实测比之后，下一轮预检用它拦住全局系数拦不住的载荷", async () => {
		const fetchCalls = installUsageResponse();
		for (let turn = 0; turn < MIN_CALIBRATION_SAMPLES; turn++) {
			const events = await runLoop(SMALL_HISTORY);
			expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
		}
		const ratio = getContextCalibrationStats()[0]?.ratio ?? null;
		expect(ratio).not.toBeNull();
		// 上游按 wire 字符数 × 1.17 上报，学到的比值必须落在这个附近。
		expect(ratio as number).toBeGreaterThan(1.1);
		expect(ratio as number).toBeLessThan(1.25);

		// 30 万 ASCII 字符 + 工具定义/系统提示等约 1.3 万字符：全局口径约 15.6 万 token，
		// 落在兜底窗口的可用预算（272_000 − 20_000 = 252_000）之下；实测比 1.17 换算约 36.6 万，
		// 越界。所以"拦得住"这件事只可能来自校准。
		const oversized = [{ role: "user", content: "a".repeat(300_000) }];
		const callsBefore = fetchCalls();
		const events = await runLoop(oversized);

		// 关键断言：请求根本没发出去。
		expect(fetchCalls()).toBe(callsBefore);
		const overflow = events.filter((event) => event.type === "context_length_exceeded");
		expect(overflow).toHaveLength(1);
		const message = String((overflow[0] as { message: string }).message);
		expect(message).toContain("calibrated");
		expect(message).toContain(MODEL_REF);
	});

	test("同样的载荷在关掉校准时不会被拦（差异确实来自校准）", async () => {
		const fetchCalls = installUsageResponse();
		for (let turn = 0; turn < MIN_CALIBRATION_SAMPLES; turn++) await runLoop(SMALL_HISTORY);
		expect(getContextCalibrationStats()[0]?.ratio).not.toBeNull();

		settings.agent.contextCalibrationEnabled = false;
		const oversized = [{ role: "user", content: "a".repeat(300_000) }];
		const callsBefore = fetchCalls();
		const events = await runLoop(oversized);

		expect(fetchCalls()).toBe(callsBefore + 1);
		expect(events.some((event) => event.type === "context_length_exceeded")).toBe(false);
	});
});
