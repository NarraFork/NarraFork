import { afterEach, describe, expect, mock, test } from "bun:test";
import { CONTEXT_ASK_MAX_OUTPUT_CHARS, contextAskService } from "../context-ask-service";
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
		}> = [];
		contextAskService._generate = mock(async (text, _systemPrompt, tracking) => {
			calls.push({ payload: JSON.parse(text), tracking });
			return { text: "1. server/a.ts\n2. No blocker", contextPercent: 12 };
		});

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

	test("folds long context through multiple summary calls", async () => {
		narratorService.getById = mock(async () => makeTarget());
		const messages = Array.from({ length: 36 }, (_, index) =>
			makeMessage(index + 1, `MARKER_${index + 1} ${"x".repeat(6_000)}`),
		);
		narratorService.getContextAskHistorySnapshot = mock(async () => makeSnapshot(messages));
		const payloads: Array<Record<string, unknown>> = [];
		contextAskService._generate = mock(async (text) => {
			const payload = JSON.parse(text) as Record<string, unknown>;
			payloads.push(payload);
			const sourceChunk = payload.sourceChunk as { index: number };
			return { text: `answer-through-chunk-${sourceChunk.index}` };
		});

		const result = await contextAskService.ask({
			callerNarratorId: "parent-1",
			targetNarratorId: "child-1",
			questions: ["Summarize all markers"],
		});

		expect(result.chunkCount).toBeGreaterThan(1);
		expect(payloads).toHaveLength(result.chunkCount);
		expect(payloads[1]).toMatchObject({
			accumulatedKind: "directed_answer",
			accumulatedContextOrAnswer: "answer-through-chunk-1",
		});
		expect(result.answer).toBe(`answer-through-chunk-${result.chunkCount}`);
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
});
