import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, readTestMessageContent } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narratorQuestions,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import type { ActiveNarrator } from "../narrator-session-state";
import { drainRuntimeTestWork, expectRuntimeTestFailure } from "./agent-runtime-test-database";
import { captureWorkerRejectionThrower, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const {
	scheduleQuestionAnswerDelivery,
	drainInjectionsIntoHistory,
	drainAndPersistPendingInjections,
	isQuestionAnswerWakeEligible,
	isQuestionAnswerDeliveryReady,
	interruptNarrator,
	consumeQuestionAnswerModelReceipts,
} = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { MAILBOX_LIMITS } = await import("../agent-runtime/limits");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const time = "2026-10-05T00:00:00.000Z";
const narratorId = "question-runtime";

async function captureQuestionRequests(
	running: ActiveNarrator,
	questionId: string,
	groups: number[] | ((turn: number) => number),
	receipts: { id: string; text: string }[] = [],
	currentText = receipts.map(({ text }) => text).join("\n"),
) {
	const { registerExternalProviderResolver } = await import("../../lib/agent/provider");
	const { agentLoop } = await import("../../lib/agent/loop");
	const { toolRegistry } = await import("../../lib/agent/tool-registry");
	const { questionTool } = await import("../../lib/agent/tools/question");
	const { projectHistory } = await import("../../lib/agent/projection");
	const requests: Array<{ history: unknown[]; content: string; toolResults: unknown[] }> = [];
	const storedOutputs: string[] = [];
	const adopted: string[][] = [];
	const injected: Array<{ text: string; messageId?: string }> = [];
	let turn = 0;
	const adapter = {
		formatTools: (tools: unknown) => tools,
		// The loop's own rows, through the real first projection stage, in a minimal wire shape.
		buildHistory: async (rows: import("../../lib/agent/provider").DbMessage[]) => {
			const { turns } = await projectHistory(rows, { strict: false });
			return {
				history: turns.map((turn) =>
					turn.kind === "input"
						? {
								role: "user",
								content: turn.items.map((item) => ({ type: "text", text: item.text })),
							}
						: turn.kind === "assistant"
							? {
									role: "assistant",
									content: turn.items
										.map((item) => (item.kind === "text" ? item.text : ""))
										.join(""),
									toolUses: turn.items.flatMap((item) =>
										item.kind === "tool_call"
											? [{ toolUseId: item.wireId, name: item.name, input: item.input }]
											: [],
									),
								}
							: {
									role: "user",
									content: turn.results.map((result) => ({
										type: "tool_result",
										tool_use_id: result.wireId,
										content: result.text,
									})),
								},
				),
			};
		},
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
			const count = typeof groups === "function" ? groups(turn++) : groups[turn++];
			if (count)
				yield {
					toolUses: Array.from({ length: count }, (_, index) => ({
						toolUseId: `question-get-${turn}-${index}`,
						name: "Question",
						input: { action: "get", id: questionId },
					})),
				};
			else yield { text: "done" };
		},
		generate: async () => "",
	} as unknown as import("../../lib/agent/provider").ProviderAdapter;
	const unregister = registerExternalProviderResolver({
		resolve: (name) => (name === "questionruntime" ? adapter : null),
		listReadiness: () => [],
	});
	toolRegistry.register(questionTool);
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
				getAfterToolsInjections: async () => {
					const input = await drainInjectionsIntoHistory(running, "en");
					injected.push(...input.parts);
					return input;
				},
				onModelInputConsumed: async (_history, _content, ids) => {
					adopted.push(Array.from(ids ?? []));
					running._questionAnswerAdoptedMessageIds = new Set(ids);
					await consumeQuestionAnswerModelReceipts(
						narratorId,
						running._questionAnswerAdoptedMessageIds,
					);
				},
			},
			currentText,
			{ rows: [] },
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
		return { requests, storedOutputs, adopted, injected };
	} finally {
		unregister();
	}
}

async function fillNoticeInbox(prefix: string) {
	const { runtimeInbox } = await import("../agent-runtime/inbox");
	for (let i = 0; i < MAILBOX_LIMITS.noticePending; i++) {
		const result = runtimeInbox.enqueue({
			kind: "task_notice",
			noticeKind: "agent",
			narratorId,
			sourceKey: `${prefix}-${i}`,
			text: "older notice",
			projectedByteSize: 100,
			metadata: {
				producerKind: "agent",
				eventKind: "completed",
				taskId: `${prefix}-task-${i}`,
				logicalRunId: `${prefix}-run-${i}`,
			},
		});
		expect(result.status).toBe("accepted");
	}
}

async function waitForAnswerAdoption(answerId: string) {
	const deadline = Date.now() + 2000;
	while (true) {
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.recipientMessageId, answerId))
			.get();
		if (row?.currentAdoptedAt) return row;
		if (Date.now() >= deadline)
			throw new Error(`Question receipt ${answerId} was not acknowledged`);
		// Receipt writes are deliberately asynchronous and yield between bounded batches.
		await Bun.sleep(1);
	}
}

function providerToolResults(request: { history: unknown[] }) {
	return (request.history as Array<{ content: unknown }>).flatMap((turn) =>
		Array.isArray(turn.content)
			? (turn.content as Array<{ type?: string; tool_use_id?: string; content: string }>).filter(
					(part) => part.type === "tool_result",
				)
			: [],
	);
}

function providerUserText(request: { history: unknown[]; content: string }) {
	return [
		...(request.history as Array<{ role?: string; content: unknown }>).flatMap((turn) =>
			turn.role === "user" && Array.isArray(turn.content)
				? (turn.content as Array<{ type?: string; text: string }>)
						.filter((part) => part.type === "text")
						.map((part) => part.text)
				: [],
		),
		request.content,
	].join("\n");
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
	backgroundOccupancyStore.refreshNarrator(narratorId);
	await backgroundOccupancyStore.flush();
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

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	db.insert(narrators)
		.values({
			id: narratorId,
			status: "working",
			lastStopReason: "normal",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	// Receipt bookkeeping is detached and CAS-checked; the next cleanDb must not land mid-write.
	await drainRuntimeTestWork();
	activeNarrators.delete(narratorId);
	backgroundOccupancyStore.setRuntimeLive(narratorId, false);
	await backgroundOccupancyStore.flush();
});
afterAll(async () => {
	backgroundOccupancyStore.resetForTests();
	await fixture.close();
});

describe("async question receipt runtime adoption", () => {
	test("receipt completion does not precede the durable adoption write", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		await drainInjectionsIntoHistory(active(), "en");
		await consumeQuestionAnswerModelReceipts(narratorId, new Set(["answer"]));
		expect(db.select().from(narratorBufferedMessages).get()?.currentAdoptedRevision).toBe(1);
	});
	test("an absent receipt completes without creating an adoption", async () => {
		await consumeQuestionAnswerModelReceipts(narratorId, new Set(["missing"]));
		expect(db.select().from(narratorBufferedMessages).all()).toEqual([]);
	});
	test("a concurrent receipt revision rejects acknowledgement without adopting stale input", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		await drainInjectionsIntoHistory(active(), "en");
		const reads = await import("../../db/worker-read");
		const original = reads.readQueryFirst;
		let injected = false;
		const probe = spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const row = await original(query, options);
			if (!injected && row && typeof row === "object" && "deliveryId" in row) {
				injected = true;
				db.update(narratorBufferedMessages).set({ currentRevision: 2 }).run();
			}
			return row;
		});
		try {
			const error = await expectRuntimeTestFailure(
				() =>
					consumeQuestionAnswerModelReceipts(narratorId, new Set(["answer"])).catch(
						(error) => error,
					),
				{ kind: "marker", caller: "agent-message-delivery.ts" },
			);
			expect(injected).toBe(true);
			expect(error).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
			expect(db.select().from(narratorBufferedMessages).get()?.currentAdoptedAt).toBeNull();
		} finally {
			probe.mockRestore();
		}
	});

	test("scheduling needs a persisted user event and never creates a queue-only answer", async () => {
		await expect(
			await captureWorkerRejectionThrower(
				scheduleQuestionAnswerDelivery(narratorId, "missing", "answer", undefined),
			),
		).toThrow("persisted");
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
	test("超长回答降级成摘要与指针后仍能入箱", async () => {
		// 回执正文上限 80KB，但通知预算只有 4KB：直接塞全文会让这次投递永远失败。
		const text = persistAnswer("answer", "长".repeat(3000));
		const result = await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		expect(result).toEqual({ ready: true, started: false });
		const row = db.select().from(narratorBufferedMessages).get();
		expect(row?.state).toBe("queued");
		expect(Buffer.byteLength(row?.text ?? "", "utf8")).toBeLessThanOrEqual(
			MAILBOX_LIMITS.publicationBytes,
		);
		expect(row?.text).toContain("完整回答见消息 answer");
	});
	test("safe tool boundary supplies the receipt once, preserving human origin", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		const first = await drainInjectionsIntoHistory(active(), "en");
		expect(first.text).toContain(text);
		expect(first.text).toContain('kind="human"');
		expect(first.parts).toEqual([{ text: first.text, messageId: "answer" }]);
		expect(first.parts.map((part) => part.text).join("\n\n")).toBe(first.text);
		const second = await drainInjectionsIntoHistory(active(), "en");
		expect(second.text).not.toContain(text);
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
		expect(db.select().from(narratorBufferedMessages).get()?.state).toBe("materialized");
	});
	test("pending questions are not re-sent at tool boundaries; the system prompt lists them", async () => {
		await seedQuestion();
		const projected = await drainInjectionsIntoHistory(active(), "en");
		expect(projected.text).not.toContain("Pick a cache");
		expect(projected.parts).toEqual([]);
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	});
	test("answer received during final generation is materialized for a fresh history pass", async () => {
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		expect(await drainAndPersistPendingInjections(active())).toContain(text);
		expect(await drainAndPersistPendingInjections(active())).toBeNull();
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	});
	test("a person's answer taken up marks the run as a person's (outline P2 PR 10c-2); other drains do not", async () => {
		const idle = active();
		expect(await drainAndPersistPendingInjections(idle)).toBeNull();
		expect(idle._runPersonActed).toBeUndefined();
		const text = persistAnswer();
		await scheduleQuestionAnswerDelivery(narratorId, "answer", text, undefined);
		const running = active();
		expect(await drainAndPersistPendingInjections(running)).toContain(text);
		expect(running._runPersonActed).toBe(true);
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
		backgroundOccupancyStore.refreshNarrator("fork");
		await backgroundOccupancyStore.flush();
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
		backgroundOccupancyStore.refreshNarrator("fork");
		await backgroundOccupancyStore.flush();
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
	test("a full inbox leaves Question queries repeatable and retries the automatic receipt after a safe drain", async () => {
		const question = await seedQuestion();
		await fillNoticeInbox("full");
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		backgroundOccupancyStore.setRuntimeLive(narratorId, true);
		const { questionTool } = await import("../../lib/agent/tools/question");
		const { answerAsyncQuestion, retryQuestionAnswerDelivery, isAsyncQuestionAwaited } =
			await import("../narrator-question-service");
		const answer = await answerAsyncQuestion(question.id, {
			answers: { choice: "All except Redis" },
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		const answerId = answer.record.answerMessageId;
		const delivery = () =>
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.sourceKey, `question-answer:${answerId}`))
				.all();
		const context = {
			narratorId,
			cwd: process.cwd(),
			signal: running.abortController.signal,
			locale: "en",
		} as import("../../lib/agent/types").ToolContext;
		const query = () => questionTool.execute({ action: "get", id: question.id }, context);
		expect(isQuestionAnswerDeliveryReady(narratorId, answerId)).toBe(false);
		expect(delivery()).toEqual([]);
		const [first, parallel] = await Promise.all([query(), query()]);
		expect(first.isError).not.toBe(true);
		expect(parallel).toEqual(first);
		expect(JSON.parse(first.output)).toMatchObject({
			record: {
				id: question.id,
				context: "Cache decision; continue local investigation while waiting.",
				questions: [{ options: [{ header: "Memory" }, { header: "Redis" }] }],
				answers: { choice: "All except Redis" },
				answerMessageId: answerId,
				resolution: null,
			},
			events: [{ messageId: answerId, kind: "answer" }],
		});
		expect(first.output).not.toContain("question_answer_fallback");
		expect(delivery()).toEqual([]);
		expect(isAsyncQuestionAwaited(question.id)).toBe(false);
		expect(running._runPersonActed).not.toBe(true);

		const freed = await drainInjectionsIntoHistory(running, "en");
		expect(freed.text).not.toContain("All except Redis");
		await freed.onConsumed();
		expect(isQuestionAnswerDeliveryReady(narratorId, answerId)).toBe(true);
		const accepted = delivery();
		expect(accepted).toHaveLength(1);
		expect(accepted[0]).toMatchObject({ state: "queued", currentAdoptedAt: null });
		// Querying the now-scheduled answer does not claim or consume its automatic delivery.
		expect(await query()).toEqual(first);
		expect(delivery()).toEqual(accepted);
		const answerParts: Array<{ text: string; messageId?: string }> = [];
		for (let boundary = 0; boundary < MAILBOX_LIMITS.noticePending + 2; boundary++) {
			const drained = await drainInjectionsIntoHistory(running, "en");
			answerParts.push(...drained.parts.filter((part) => part.messageId === answerId));
			await drained.onConsumed();
			if (answerParts.length) break;
		}
		expect(answerParts).toHaveLength(1);
		expect(answerParts[0]?.text).toContain('kind="human"');
		expect(answerParts[0]?.text).toContain("All except Redis");
		expect(answerParts[0]?.text).toContain(
			"Cache decision; continue local investigation while waiting.",
		);
		expect(answerParts[0]?.text).toContain("Memory");
		expect(answerParts[0]?.text).toContain("Redis");
		expect(running._runPersonActed).toBe(true);
		expect(await waitForAnswerAdoption(answerId)).toMatchObject({
			deliveryId: accepted[0]?.deliveryId,
			state: "materialized",
			currentAdoptedAt: expect.any(String),
		});
		await retryQuestionAnswerDelivery(narratorId, question.id);
		await retryQuestionAnswerDelivery(narratorId, question.id);
		expect((await drainInjectionsIntoHistory(running, "en")).parts).toEqual([]);
		expect(delivery()).toHaveLength(1);
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, answerId)).all(),
		).toHaveLength(1);
		expect(await query()).toEqual(first);
	}, 15_000);
	test("actual provider input adopts one automatic receipt after a full inbox without consuming parallel or later Question queries", async () => {
		const question = await seedQuestion();
		await fillNoticeInbox("model-full");
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		backgroundOccupancyStore.setRuntimeLive(narratorId, true);
		const { answerAsyncQuestion, retryQuestionAnswerDelivery } = await import(
			"../narrator-question-service"
		);
		const answer = await answerAsyncQuestion(question.id, {
			answers: { choice: "UNIQUE_MODEL_ANSWER" },
		});
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		const answerId = answer.record.answerMessageId;
		expect(isQuestionAnswerDeliveryReady(narratorId, answerId)).toBe(false);
		let queriedAfterAdoption = false;
		const evidence = await captureQuestionRequests(running, question.id, (turn) => {
			if (turn > MAILBOX_LIMITS.noticePending + 2)
				throw new Error(
					"Automatic question receipt did not reach the provider within bounded drains",
				);
			if (running._questionAnswerAdoptedMessageIds?.has(answerId)) {
				if (queriedAfterAdoption) return 0;
				queriedAfterAdoption = true;
			}
			return turn === 0 ? 2 : 1;
		});
		expect(queriedAfterAdoption).toBe(true);
		const adoptedAt = evidence.adopted.findIndex((ids) => ids.includes(answerId));
		// Queries return the answer immediately, but only actual user input can adopt it.
		expect(adoptedAt).toBeGreaterThan(1);
		expect(evidence.adopted[0]).not.toContain(answerId);
		expect(evidence.adopted[1]).not.toContain(answerId);
		for (const [index, request] of evidence.requests.entries()) {
			const userText = providerUserText(request);
			expect(userText.split("UNIQUE_MODEL_ANSWER")).toHaveLength(index < adoptedAt ? 1 : 2);
			if (index >= adoptedAt) {
				expect(userText).toContain('kind="human"');
				expect(userText).toContain(answerId);
			}
			const results = providerToolResults(request);
			expect(results).toHaveLength(index === 0 ? 0 : index + 1);
			for (const result of results) {
				expect(JSON.parse(result.content)).toMatchObject({
					record: {
						id: question.id,
						answers: { choice: "UNIQUE_MODEL_ANSWER" },
						answerMessageId: answerId,
						resolution: null,
					},
				});
				expect(result.content).not.toContain("question_answer_fallback");
			}
			// Explicit read-only query output is retained, independently of the one user receipt.
			expect(JSON.stringify(request).split("UNIQUE_MODEL_ANSWER")).toHaveLength(
				results.length + (index < adoptedAt ? 0 : 1) + 1,
			);
		}
		expect(providerToolResults(evidence.requests[1]).map((result) => result.tool_use_id)).toEqual([
			"question-get-1-0",
			"question-get-1-1",
		]);
		expect(providerToolResults(evidence.requests[2]).at(-1)?.tool_use_id).toBe("question-get-2-0");
		expect(evidence.storedOutputs).toHaveLength(evidence.requests.length);
		for (const output of evidence.storedOutputs) expect(output).toBe(evidence.storedOutputs[0]);
		expect(evidence.injected.filter((part) => part.messageId === answerId)).toHaveLength(1);
		await waitForAnswerAdoption(answerId);
		const beforeRetry = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.recipientMessageId, answerId))
			.all();
		expect(beforeRetry).toHaveLength(1);
		expect(beforeRetry[0]).toMatchObject({
			state: "materialized",
			currentAdoptedAt: expect.any(String),
		});
		await retryQuestionAnswerDelivery(narratorId, question.id);
		expect((await drainInjectionsIntoHistory(running, "en")).parts).toEqual([]);
		expect(
			db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.recipientMessageId, answerId))
				.all(),
		).toEqual(beforeRetry);
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, answerId)).all(),
		).toHaveLength(1);
	}, 15_000);
	test("actual provider input keeps consumed user receipts once while repeated Question reads retain the answer", async () => {
		const question = await seedQuestion();
		const running = {
			...active(),
			alive: true,
			_loopRunning: true,
			abortController: new AbortController(),
		} as ActiveNarrator;
		activeNarrators.set(narratorId, running);
		backgroundOccupancyStore.setRuntimeLive(narratorId, true);
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
		row.contentJson = readTestMessageContent(sqlite, row.id);
		const { questionModelReceipts } = await import("../agent-runtime/history");
		const receipts = questionModelReceipts([row]);
		const evidence = await captureQuestionRequests(running, question.id, [1, 1], receipts);
		expect(evidence.requests).toHaveLength(3);
		for (const [index, request] of evidence.requests.entries()) {
			const userText = providerUserText(request);
			expect(userText.split("PREVIOUSLY_CONSUMED_ANSWER")).toHaveLength(2);
			expect(userText).toContain('kind="human"');
			const results = providerToolResults(request);
			expect(results).toHaveLength(index);
			for (const result of results)
				expect(JSON.parse(result.content)).toMatchObject({
					record: {
						id: question.id,
						answerMessageId: answer.record.answerMessageId,
						answers: { choice: "PREVIOUSLY_CONSUMED_ANSWER" },
						resolution: null,
					},
				});
			expect(JSON.stringify(request).split("PREVIOUSLY_CONSUMED_ANSWER")).toHaveLength(index + 2);
		}
		expect(evidence.storedOutputs).toHaveLength(2);
		expect(evidence.storedOutputs[1]).toBe(evidence.storedOutputs[0]);
		expect(
			evidence.injected.filter((part) => part.messageId === answer.record.answerMessageId),
		).toEqual([]);
		expect((await drainInjectionsIntoHistory(running, "en")).parts).toEqual([]);
		await waitForAnswerAdoption(answer.record.answerMessageId);
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
		backgroundOccupancyStore.setRuntimeLive(narratorId, true);
		const first = {
			id: "event-sent",
			text: '<sender kind="human" />\n{"answerMessageId":"event-sent","answer":"same answer"}',
		};
		const missing = {
			id: "event-unsent",
			text: '<sender kind="human" />\n{"answerMessageId":"event-unsent","answer":"same answer"}',
		};
		const evidence = await captureQuestionRequests(
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
