import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	CONTEXT_ASK_MAX_CONCURRENCY,
	CONTEXT_ASK_MAX_OUTPUT_CHARS,
	contextAskService,
} from "../context-ask-service";
import type { ContextAskHistorySnapshot } from "../narrator-messages";
import { narratorService } from "../narrator-service";

const originalGetById = narratorService.getById;
const originalGetSnapshot = narratorService.getContextAskHistorySnapshot;
const originalGenerate = contextAskService._generate;

function makeTarget(contextSummary: string | null = null) {
	return {
		id: "child-1",
		title: "Worker",
		status: "working",
		variant: "explore",
		contextSummary,
	} as Awaited<ReturnType<typeof narratorService.getById>>;
}

function makeSnapshot(
	messages: ContextAskHistorySnapshot["messages"],
	overrides: Partial<ContextAskHistorySnapshot> = {},
): ContextAskHistorySnapshot {
	return {
		messages,
		hasMore: false,
		sourceTruncated: false,
		toolCallsTruncated: false,
		sourceBytes: JSON.stringify(messages).length,
		...overrides,
	};
}

function makeMessage(seq: number, contentText: string) {
	return {
		id: `m-${seq}`,
		seq,
		role: seq % 2 === 0 ? "assistant" : "user",
		contentText,
		contentTruncated: false,
		toolCalls: [],
		omittedToolCalls: 0,
	};
}

afterEach(() => {
	narratorService.getById = originalGetById;
	narratorService.getContextAskHistorySnapshot = originalGetSnapshot;
	contextAskService._generate = originalGenerate;
	mock.restore();
});

describe("contextAskService", () => {
	test("answers ordered questions from compact context and persisted messages", async () => {
		narratorService.getById = mock(async () => makeTarget("Earlier compact findings"));
		narratorService.getContextAskHistorySnapshot = mock(async () =>
			makeSnapshot([makeMessage(3, "Changed server/a.ts")]),
		);
		const calls: Array<{
			payload: Record<string, unknown>;
			tracking: Record<string, unknown> | undefined;
			maxOutputTokens: number | undefined;
		}> = [];
		contextAskService._generate = mock(
			async (
				text,
				_systemPrompt,
				tracking,
				_signal,
				_onTextDelta,
				_modelOverride,
				maxOutputTokens,
			) => {
				calls.push({ payload: JSON.parse(text), tracking, maxOutputTokens });
				return { text: "1. server/a.ts\n2. No blocker", contextPercent: 12 };
			},
		);

		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
			questions: ["Which files changed?", "What is blocked?"],
			locale: "en",
		});

		expect(result.answer).toContain("server/a.ts");
		expect(result.questions).toEqual(["Which files changed?", "What is blocked?"]);
		expect(result.chunkCount).toBe(1);
		expect(result.contextPercent).toBe(12);
		expect(calls).toHaveLength(1);
		expect(calls[0].payload).toMatchObject({
			phase: "source",
			requestedLocale: "en",
			questions: ["Which files changed?", "What is blocked?"],
			accumulatedKind: "persisted_context_summary",
			accumulatedContextOrAnswer: "Earlier compact findings",
		});
		expect(calls[0].payload.sourceChunk).toMatchObject({
			index: 1,
			total: 1,
			messages: [expect.stringContaining("Changed server/a.ts")],
		});
		expect(calls[0].tracking).toEqual({ narratorId: "parent-1", kind: "context_ask" });
		expect(calls[0].maxOutputTokens).toBe(64_000);
	});

	test("returns a deterministic localized result without calling the model for empty context", async () => {
		narratorService.getById = mock(async () => makeTarget());
		narratorService.getContextAskHistorySnapshot = mock(async () => makeSnapshot([]));
		const generate = mock(async () => ({ text: "should not run" }));
		contextAskService._generate = generate;

		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
			locale: "zh-CN",
		});

		expect(result.answer).toContain("没有可供 ContextAsk 读取的持久化上下文");
		expect(result.chunkCount).toBe(0);
		expect(generate).not.toHaveBeenCalled();
	});

	test("maps long context concurrently and reduces partial answers in source order", async () => {
		narratorService.getById = mock(async () => makeTarget());
		const messages = Array.from({ length: 72 }, (_, index) =>
			makeMessage(index + 1, `MARKER_${index + 1} ${"x".repeat(6_000)}`),
		);
		narratorService.getContextAskHistorySnapshot = mock(async () => makeSnapshot(messages));
		const payloads: Array<Record<string, unknown>> = [];
		const maxOutputTokens: Array<number | undefined> = [];
		let activeSourceCalls = 0;
		let maxActiveSourceCalls = 0;
		contextAskService._generate = mock(
			async (
				text,
				_systemPrompt,
				_tracking,
				_signal,
				_onTextDelta,
				_modelOverride,
				outputTokens,
			) => {
				const payload = JSON.parse(text) as Record<string, unknown>;
				payloads.push(payload);
				maxOutputTokens.push(outputTokens);
				const sourceChunk = payload.sourceChunk as { index: number; messages: string[] };
				if (payload.phase === "source") {
					activeSourceCalls++;
					maxActiveSourceCalls = Math.max(maxActiveSourceCalls, activeSourceCalls);
					await Bun.sleep(5);
					activeSourceCalls--;
					return { text: `partial-${sourceChunk.index}`, contextPercent: sourceChunk.index };
				}
				return {
					text: "final-answer",
					contextPercent: 99,
				};
			},
		);

		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
			questions: ["Summarize all markers"],
		});

		const sourcePayloads = payloads.filter((payload) => payload.phase === "source");
		const reducePayloads = payloads.filter((payload) => payload.phase === "reduce");
		expect(result.chunkCount).toBeGreaterThan(1);
		expect(sourcePayloads).toHaveLength(result.chunkCount);
		expect(reducePayloads).toHaveLength(1);
		expect(maxActiveSourceCalls).toBeGreaterThan(1);
		expect(maxActiveSourceCalls).toBeLessThanOrEqual(CONTEXT_ASK_MAX_CONCURRENCY);
		expect(maxOutputTokens.every((value) => value === 64_000)).toBe(true);
		const reduceMessages = (
			(reducePayloads[0].sourceChunk as { messages: string[] }).messages ?? []
		).join("\n");
		expect(reduceMessages.indexOf("partial-1")).toBeLessThan(
			reduceMessages.indexOf(`partial-${result.chunkCount}`),
		);
		expect(result.answer).toBe("final-answer");
		expect(result.contextPercent).toBe(99);
	});

	test("caps model output and rejects empty output", async () => {
		narratorService.getById = mock(async () => makeTarget());
		narratorService.getContextAskHistorySnapshot = mock(async () =>
			makeSnapshot([makeMessage(1, "context")]),
		);
		contextAskService._generate = mock(async () => ({ text: "z".repeat(20_000) }));

		const capped = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
		});
		expect(capped.answer.length).toBeLessThanOrEqual(CONTEXT_ASK_MAX_OUTPUT_CHARS);
		expect(capped.answer).toContain("ContextAsk content truncated");

		contextAskService._generate = mock(async () => ({ text: "" }));
		await expect(
			contextAskService.ask({
				callerNarratorId: "parent-1",
				targetNarratorId: "child-1",
			}),
		).rejects.toThrow("returned empty output");
	});

	test("reports cumulative streamed character count across map and reduce requests", async () => {
		narratorService.getById = mock(async () => makeTarget());
		const messages = Array.from({ length: 72 }, (_, index) =>
			makeMessage(index + 1, `MARKER_${index + 1} ${"x".repeat(6_000)}`),
		);
		narratorService.getContextAskHistorySnapshot = mock(async () => makeSnapshot(messages));
		contextAskService._generate = mock(
			async (text, _systemPrompt, _tracking, _signal, onTextDelta) => {
				const payload = JSON.parse(text) as { phase?: string };
				// Emit two deltas per request so we exercise incremental accumulation.
				await onTextDelta?.("ab");
				await onTextDelta?.("cde");
				return {
					text: payload.phase === "source" ? "partial" : "final-answer",
					contextPercent: 50,
				};
			},
		);

		const progress: number[] = [];
		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
			questions: ["Summarize"],
			onProgress: (chars) => progress.push(chars),
		});

		// map chunks (chunkCount) + one reduce request, each emitting 2 deltas (2 + 3 chars).
		const requestCount = result.chunkCount + 1;
		expect(result.chunkCount).toBeGreaterThan(1);
		expect(progress).toHaveLength(requestCount * 2);
		// Monotonically non-decreasing cumulative counter.
		for (let i = 1; i < progress.length; i++) {
			expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
		}
		// Final value equals total characters streamed: 5 chars per request.
		expect(progress.at(-1)).toBe(requestCount * 5);
	});

	test("omits progress reporting when onProgress is not provided", async () => {
		narratorService.getById = mock(async () => makeTarget());
		narratorService.getContextAskHistorySnapshot = mock(async () =>
			makeSnapshot([makeMessage(1, "context")]),
		);
		let deltaHandlerReceived: unknown;
		contextAskService._generate = mock(
			async (_text, _systemPrompt, _tracking, _signal, onTextDelta) => {
				deltaHandlerReceived = onTextDelta;
				return { text: "answer", contextPercent: 10 };
			},
		);

		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
		});

		expect(result.answer).toBe("answer");
		// Without onProgress, no onTextDelta handler is wired (stays undefined).
		expect(deltaHandlerReceived).toBeUndefined();
	});
});
