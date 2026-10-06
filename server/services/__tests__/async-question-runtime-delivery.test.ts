import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ActiveNarrator } from "../narrator-session-state";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const {
	scheduleQuestionAnswerDelivery,
	drainInjectionsIntoHistory,
	drainAndPersistPendingInjections,
	isQuestionAnswerWakeEligible,
	isQuestionAnswerDeliveryReady,
	interruptNarrator,
} = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const time = "2026-10-05T00:00:00.000Z";
const narratorId = "question-runtime";

async function captureAwaitRequests(
	running: ActiveNarrator,
	questionId: string,
	groups: number[],
	receipts: { id: string; text: string }[] = [],
	currentText = receipts.map(({ text }) => text).join("\n"),
) {
	const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
	const { agentLoop } = await import("../../lib/agent/loop");
	const { toolRegistry } = await import("../../lib/agent/tool-registry");
	const { awaitTool } = await import("../../lib/agent/tools/await");
	const requests: Array<{ history: unknown[]; content: string; toolResults: unknown[] }> = [];
	const storedOutputs: string[] = [];
	const adopted: string[][] = [];
	let turn = 0;
	const adapter = {
		formatTools: (tools: unknown) => tools,
		buildHistory: async () => ({ history: [], trailingToolResults: [] }),
		injectSystemPrompt: () => {},
		async *chat(params: import("../../lib/agent/provider").ChatParams) {
			params.onRequestStart?.();
			requests.push(
				JSON.parse(
					JSON.stringify({
						history: params.history,
						content: params.content,
						toolResults: params.toolResults,
					}),
				),
			);
			const count = groups[turn++];
			if (count)
				yield {
					toolUses: Array.from({ length: count }, (_, index) => ({
						toolUseId: `await-${turn}-${index}`,
						name: "Await",
						input: { type: "question", id: questionId },
					})),
				};
			else yield { text: "done" };
		},
		formatToolResult: (toolUseId: string, output: string) => ({
			type: "tool_result",
			tool_use_id: toolUseId,
			content: output,
		}),
		pushUserTurn: (
			history: unknown[],
			content: string,
			_model: string,
			results: unknown[] = [],
		) => {
			history.push({
				role: "user",
				content: [...(content ? [{ type: "text", text: content }] : []), ...results],
			});
		},
		pushAssistantTurn: (history: unknown[], text: string, uses: unknown[]) => {
			history.push({ role: "assistant", content: text, toolUses: uses });
		},
		generate: async () => "",
	} as unknown as import("../../lib/agent/provider").ProviderAdapter;
	const unregister = registerExternalProviderResolver((name) =>
		name === "questionruntime" ? adapter : null,
	);
	toolRegistry.register(awaitTool);
	try {
		for await (const event of agentLoop(
			{
				narratorId,
				conversationId: "question-runtime-test",
				model: "questionruntime:model",
				provider: "questionruntime",
				cwd: process.cwd(),
				locale: "en",
				signal: running.abortController.signal,
				permissionHandler: async () => ({ behavior: "allow" }),
				getQuestionModelReceipts: () => [
					...receipts,
					...Array.from(running._questionAnswerModelReceipts ?? [], ([id, text]) => ({ id, text })),
				],
				getAfterToolsInjections: () => drainInjectionsIntoHistory(running, "en"),
				onModelInputConsumed: (_history, _content, ids) => {
					adopted.push(Array.from(ids ?? []));
					running._questionAnswerAdoptedMessageIds = new Set(ids);
				},
			},
			currentText,
			[],
		)) {
			if (event.type === "tool_result") storedOutputs.push(event.output);
			if (event.type === "error") throw new Error(event.message);
		}
		for (const request of requests) {
			const uses: string[] = [];
			const results: string[] = [];
			const visit = (value: unknown) => {
				if (Array.isArray(value)) {
					for (const entry of value) visit(entry);
					return;
				}
				if (!value || typeof value !== "object") return;
				const row = value as Record<string, unknown>;
				if (typeof row.toolUseId === "string") uses.push(row.toolUseId);
				if (row.type === "tool_result" && typeof row.tool_use_id === "string")
					results.push(row.tool_use_id);
				for (const entry of Object.values(row)) visit(entry);
			};
			visit(request);
			expect(results.sort()).toEqual(uses.sort());
		}
		return { requests, storedOutputs, adopted };
	} finally {
		unregister();
	}
}

function active(): ActiveNarrator {
	return {
		narratorId,
		locale: "en",
		_tasksReminderInterval: -1,
		_fenceInterval: -1,
		_todoReminderCompletedToolCount: 0,
	} as ActiveNarrator;
}
function persistAnswer(id = "answer", text = "receipt contains the selected original option") {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId,
			role: "user",
			origin: "user",
			contentText: text,
			contentJson: [{ type: "text", text }],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId, messageId: id, seq: 1 })
		.run();
	return text;
}
async function seedQuestion() {
	db.insert(narratorMessages)
		.values({
			id: "ask",
			narratorId,
			role: "assistant",
			contentJson: [
				{ type: "tool_use", id: "question-tool", name: "AskUserQuestion", input: { async: true } },
			],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: "ref-ask", narratorId, messageId: "ask", seq: 1 })
		.run();
	db.update(narrators).set({ nextSeq: 1 }).where(eq(narrators.id, narratorId)).run();
	db.insert(narratorToolCalls)
		.values({
			id: "question-call",
			messageId: "ask",
			narratorId,
			toolUseId: "question-tool",
			toolName: "AskUserQuestion",
			inputJson: { async: true },
			status: "success",
			createdAt: time,
		})
		.run();
	const { createAsyncQuestion } = await import("../narrator-question-service");
	return (
		await createAsyncQuestion({
			narratorId,
			toolCallId: "question-call",
			toolUseId: "question-tool",
			questions: [
				{
					id: "choice",
					header: "Pick a cache",
					options: [{ header: "Memory" }, { header: "Redis" }],
				},
			],
			context: "Cache decision; continue local investigation while waiting.",
			executionPrincipal: { version: 1, userId: null },
		})
	).record;
}

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values({
			id: narratorId,
			status: "working",
			lastStopReason: "normal",
			createdAt: time,
			updatedAt: time,
		})
		.run();
});
afterEach(() => activeNarrators.delete(narratorId));
afterAll(() => sqlite.close());

describe("async question receipt runtime adoption", () => {
	test("scheduling needs a persisted user event and never creates a queue-only answer", async () => {
		await expect(
			scheduleQuestionAnswerDelivery(narratorId, "missing", "answer", undefined),
		).rejects.toThrow("persisted");
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(0);
	});
	test("retries share one durable inbox identity and do not interrupt the current run", async () => {
		const text = persistAnswer();
		const first = await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		const retry = await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		expect(first).toEqual({ ready: true, started: false });
		expect(retry).toEqual(first);
		const rows = db.select().from(narratorBufferedMessages).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.recipientMessageId).toBe("answer");
		expect(rows[0]?.state).toBe("queued");
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	});
	test("safe tool boundary supplies the receipt once, preserving human origin", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		const first = await drainInjectionsIntoHistory(active(), "en");
		expect(first.text).toContain(text);
		expect(first.text).toContain('kind="human"');
		const second = await drainInjectionsIntoHistory(active(), "en");
		expect(second.text).not.toContain(text);
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
		expect(db.select().from(narratorBufferedMessages).get()?.state).toBe("materialized");
	});
	test("answer received during final generation is materialized for a fresh history pass", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		expect(await drainAndPersistPendingInjections(active())).toContain(text);
		expect(await drainAndPersistPendingInjections(active())).toBeNull();
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	});
	test("receipt landing between the pre-pass drain and history read is not supplied twice", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		const running = active();
		running._questionAnswerAdoptedMessageIds = new Set(["answer"]);
		expect((await drainInjectionsIntoHistory(running, "en")).text).not.toContain(text);
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	});
	test("Await drops answer bodies only after reliable receipt scheduling", async () => {
		const { formatQuestionResult } = await import("../../lib/agent/tools/await");
		const text = persistAnswer();
		const record = {
			questions: [{ header: "choice" }],
			answers: { choice: "sensitive answer" },
			answerMessageId: "answer",
		};
		expect(isQuestionAnswerDeliveryReady(narratorId, "answer")).toBe(false);
		expect(formatQuestionResult("question", "answered", record, false)).toContain(
			"sensitive answer",
		);
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		expect(isQuestionAnswerDeliveryReady(narratorId, "answer")).toBe(true);
		expect(formatQuestionResult("question", "answered", record, false)).toContain(
			"Question action=get",
		);
		const skipped = formatQuestionResult("question", "dismissed", record);
		expect(skipped).toContain("No answer was selected");
		expect(skipped).not.toContain("best judgement");
		expect(skipped).not.toContain("do not ask again");
		const reference = formatQuestionResult("question", "answered", record, true);
		expect(reference).toContain("Answer event: answer");
		expect(reference).not.toContain("sensitive answer");
		db.update(narratorBufferedMessages)
			.set({ state: "materialized", adoptedAt: time, currentAdoptedAt: time })
			.where(eq(narratorBufferedMessages.recipientMessageId, "answer"))
			.run();
		expect(isQuestionAnswerDeliveryReady(narratorId, "answer")).toBe(false);
	});
	test("deleting an answer through ordinary history mutation reopens its question and cancels delivery", async () => {
		const question = await seedQuestion();
		const { answerAsyncQuestion } = await import("../narrator-question-service");
		const answer = await answerAsyncQuestion(question.id, { answers: { choice: "Memory" } });
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		const { narratorMessageQueries } = await import("../narrator-messages");
		await narratorMessageQueries.deleteMessage(narratorId, answer.record.answerMessageId, {
			skipRevert: true,
		});
		const restored = db
			.select()
			.from(narratorQuestions)
			.where(eq(narratorQuestions.id, question.id))
			.get();
		expect(restored?.status).toBe("open");
		expect(restored?.answerMessageId).toBeNull();
		expect(isQuestionAnswerDeliveryReady(narratorId, answer.record.answerMessageId)).toBe(false);
	});
	test("unlinking the original shared request withdraws it while a fork retains its background row", async () => {
		const question = await seedQuestion();
		db.insert(narrators).values({ id: "fork", createdAt: time, updatedAt: time }).run();
		db.insert(narratorMessageRefs)
			.values({ id: "fork-ask", narratorId: "fork", messageId: "ask", seq: 1 })
			.run();
		const { narratorMessageQueries } = await import("../narrator-messages");
		await narratorMessageQueries.deleteMessage(narratorId, "ask", { skipRevert: true });
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, "ask")).get(),
		).toBeDefined();
		expect(
			db.select().from(narratorQuestions).where(eq(narratorQuestions.id, question.id)).get()
				?.status,
		).toBe("withdrawn");
	});
	test("a fork deleting inherited background does not withdraw the original actor's live question", async () => {
		const question = await seedQuestion();
		db.insert(narrators).values({ id: "fork", createdAt: time, updatedAt: time }).run();
		db.insert(narratorMessageRefs)
			.values({ id: "fork-ask", narratorId: "fork", messageId: "ask", seq: 1 })
			.run();
		const { narratorMessageQueries } = await import("../narrator-messages");
		await narratorMessageQueries.deleteMessage("fork", "ask", { skipRevert: true });
		expect(
			db.select().from(narratorQuestions).where(eq(narratorQuestions.id, question.id)).get()
				?.status,
		).toBe("open");
	});
	test("a full inbox still releases Await with the complete receipt and retries after a safe drain", async () => {
		const question = await seedQuestion();
		const { runtimeInbox } = await import("../agent-runtime/inbox");
		for (let i = 0; i < 100; i++)
			runtimeInbox.enqueue({
				kind: "task_notice",
				noticeKind: "agent",
				narratorId,
				sourceKey: `full-${i}`,
				text: "older notice",
				projectedByteSize: 100,
				metadata: {
					producerKind: "agent",
					eventKind: "completed",
					taskId: `old-${i}`,
					logicalRunId: `run-${i}`,
				},
			});
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		const { awaitTool } = await import("../../lib/agent/tools/await");
		const wait = awaitTool.execute(
			{ type: "question", id: question.id, timeout: 2000 },
			{
				narratorId,
				cwd: process.cwd(),
				signal: running.abortController.signal,
				locale: "en",
				requestPermission: async () => ({ behavior: "allow" as const }),
			},
		);
		const { answerAsyncQuestion } = await import("../narrator-question-service");
		const answer = await answerAsyncQuestion(question.id, {
			answers: { choice: "All except Redis" },
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		expect(isQuestionAnswerDeliveryReady(narratorId, answer.record.answerMessageId)).toBe(false);
		const result = await wait;
		expect(result.output).toContain("Cache decision; continue local investigation while waiting.");
		expect(result.output).toContain("Memory");
		expect(result.output).toContain("Redis");
		expect(result.output).toContain("All except Redis");
		expect(result.output).toContain("question_answer_fallback");
		await drainInjectionsIntoHistory(running, "en");
		expect(isQuestionAnswerDeliveryReady(narratorId, answer.record.answerMessageId)).toBe(true);
		const { projectQuestionFallbackToolResults } = await import("../agent-runtime/history");
		const row = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, answer.record.answerMessageId))
			.get();
		if (!row) throw new Error("receipt missing");
		const replay = [
			{
				...row,
				toolCalls: [
					{
						toolUseId: "await",
						toolName: "Await",
						inputJson: { type: "question" },
						outputJson: result.output,
						status: "success",
					},
				],
			},
		];
		projectQuestionFallbackToolResults(replay);
		expect(replay[0].toolCalls[0].outputJson).not.toContain("All except Redis");
		expect(replay[0].toolCalls[0].outputJson).toContain(answer.record.answerMessageId);
	});
	test("actual provider input keeps one full fallback for parallel Await with a full inbox, including a later Await", async () => {
		const question = await seedQuestion();
		const { runtimeInbox } = await import("../agent-runtime/inbox");
		for (let i = 0; i < 100; i++)
			runtimeInbox.enqueue({
				kind: "task_notice",
				noticeKind: "agent",
				narratorId,
				sourceKey: `model-full-${i}`,
				text: "older notice",
				projectedByteSize: 100,
				metadata: {
					producerKind: "agent",
					eventKind: "completed",
					taskId: `model-${i}`,
					logicalRunId: `model-run-${i}`,
				},
			});
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		const { answerAsyncQuestion } = await import("../narrator-question-service");
		const answer = await answerAsyncQuestion(question.id, {
			answers: { choice: "UNIQUE_MODEL_ANSWER" },
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		const evidence = await captureAwaitRequests(running, question.id, [2, 1]);
		expect(evidence.requests).toHaveLength(3);
		for (const request of evidence.requests.slice(1)) {
			expect(JSON.stringify(request).split("UNIQUE_MODEL_ANSWER")).toHaveLength(2);
			expect(JSON.stringify(request)).toContain('kind=\\"human\\"');
		}
		const secondResults = evidence.requests[1].toolResults as Array<{ tool_use_id: string }>;
		expect(secondResults.map((result) => result.tool_use_id)).toEqual(["await-1-0", "await-1-1"]);
		expect(
			(evidence.requests[2].toolResults as Array<{ tool_use_id: string }>).map(
				(result) => result.tool_use_id,
			),
		).toEqual(["await-2-0"]);
		expect(evidence.storedOutputs[0]).toContain("UNIQUE_MODEL_ANSWER");
		expect(evidence.storedOutputs[1]).toContain("UNIQUE_MODEL_ANSWER");
		expect(evidence.adopted[0]).not.toContain(answer.record.answerMessageId);
		expect(evidence.adopted[1]).toContain(answer.record.answerMessageId);
	});
	test("actual provider request does not repeat a previously consumed user receipt in Await results", async () => {
		const question = await seedQuestion();
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		const { answerAsyncQuestion } = await import("../narrator-question-service");
		const answer = await answerAsyncQuestion(question.id, {
			answers: { choice: "PREVIOUSLY_CONSUMED_ANSWER" },
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		const row = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, answer.record.answerMessageId))
			.get();
		if (!row) throw new Error("receipt missing");
		const { questionModelReceipts } = await import("../agent-runtime/history");
		const receipts = questionModelReceipts([row]);
		const evidence = await captureAwaitRequests(running, question.id, [1, 1], receipts);
		expect(evidence.requests).toHaveLength(3);
		for (const request of evidence.requests) {
			expect(JSON.stringify(request).split("PREVIOUSLY_CONSUMED_ANSWER")).toHaveLength(2);
			expect(JSON.stringify(request)).toContain('kind=\\"human\\"');
		}
		for (const request of evidence.requests.slice(1))
			expect(JSON.stringify(request.toolResults)).not.toContain("PREVIOUSLY_CONSUMED_ANSWER");
		expect(
			evidence.adopted.every((ids) => ids.includes(answer.record.answerMessageId as string)),
		).toBe(true);
	});
	test("provider adoption never confirms a candidate absent from actual input, even with identical answer prose", async () => {
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		const first = {
			id: "event-sent",
			text: '<sender kind="human" />\n{"answerMessageId":"event-sent","answer":"same answer"}',
		};
		const missing = {
			id: "event-unsent",
			text: '<sender kind="human" />\n{"answerMessageId":"event-unsent","answer":"same answer"}',
		};
		const evidence = await captureAwaitRequests(
			running,
			"unused",
			[],
			[first, missing],
			first.text,
		);
		expect(evidence.requests).toHaveLength(1);
		expect(evidence.adopted).toEqual([["event-sent"]]);
		expect(JSON.stringify(evidence.requests[0])).not.toContain("event-unsent");
	});
	test("explicit stop remains durable even after its live runtime is gone", () => {
		interruptNarrator(narratorId);
		expect(
			db.select().from(narrators).where(eq(narrators.id, narratorId)).get()?.lastStopReason,
		).toBe("user_interrupt");
	});
	test("only normal idle sessions wake; stopped, unknown, errors and permission states remain parked", () => {
		expect(isQuestionAnswerWakeEligible({ status: "idle", lastStopReason: "normal" })).toBe(true);
		for (const reason of [null, "user_interrupt", "error"])
			expect(isQuestionAnswerWakeEligible({ status: "idle", lastStopReason: reason })).toBe(false);
		for (const status of ["archived", "waiting", "working"])
			expect(isQuestionAnswerWakeEligible({ status, lastStopReason: "normal" })).toBe(false);
		expect(
			isQuestionAnswerWakeEligible({
				status: "idle",
				lastStopReason: "normal",
				substatus: '["waiting_permission"]',
			}),
		).toBe(false);
	});
});
