/**
 * Contract for asynchronous AskUserQuestion records.
 *
 * The three properties worth pinning are the ones whose failure modes are silent:
 *
 *  1. **Idempotent creation.** A replayed tool execution must not file a second
 *     question. Without the unique index + read-back, the user's inbox grows a
 *     duplicate every recovery, and nothing in the flow reports it.
 *  2. **First writer wins.** Answer / dismiss / withdraw all end an open question, so
 *     a losing caller must be told `stale` rather than silently reporting success on a
 *     question somebody else already decided.
 *  3. **Answers are delivered as a user-role message.** The whole point of the async
 *     path is that the answer reaches the model later; a decision that persists but
 *     never injects looks fine in the UI and is invisible to the agent.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../../db/schema";

// The shared migrated test database, not a hand-rolled subset.
//
// A local `CREATE TABLE` set was the first attempt and it was actively harmful: this
// mock is process-wide, so those four tables became `db` for all 190 sibling files and
// broke 139 unrelated assertions. `getTestDb()` runs the real migrations, so a leak
// costs nothing structural — and the `afterAll` below re-points the module anyway.
const { db: testDb, sqlite } = getTestDb();

// Snapshot the real module first so `afterAll` can restore it: `mock.restore()` does
// NOT undo `mock.module`, and an FTS-less test db leaking into later real-db suites is
// exactly how this file first broke its neighbours.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db: testDb, sqlite }));

// Delivery and broadcast are deliberately NOT module-mocked. Replacing
// `narrator-injection` / `narrator-ws` here handed those replacements to every later
// file too; the service exposes an explicit seam for this reason, and a seam set and
// restored in one file cannot leak past it.

interface RecordedInjection {
	narratorId: string;
	content: string;
	source: string;
	role?: string;
	schedule?: string;
	body?: unknown;
}

let injections: RecordedInjection[] = [];
let deliveryError: Error | null = null;
let broadcasts: { type: string; change?: string }[] = [];
// Counts `scheduleQuestionAnswerDelivery` calls: the wake-an-idle-loop path an ignore
// must provably never take.
let scheduledDeliveries = 0;
// Attention intents raised / cleared while a question is awaited. Recorded rather than
// asserted through the real event bus so the test does not depend on notification
// consumers being registered.
let attentions: { kind: "raised" | "resolved"; narratorId: string }[] = [];

const {
	answerAsyncQuestion,
	awaitAsyncQuestion,
	countOpenAsyncQuestions,
	createAsyncQuestion: createQuestionRecord,
	resolveAsyncQuestion,
	supplementAsyncQuestion,
	getBoundedQuestionDetail,
	listQuestionSummaries,
	buildPendingQuestionHint,
	getBoundedQuestionReceipt,
	retryQuestionAnswerDelivery,
	notifyQuestionHistoryChanged,
	dismissAsyncQuestion,
	ignoreAsyncQuestion,
	getAsyncQuestion,
	isAsyncQuestionAwaited,
	listAsyncQuestions,
	setQuestionServiceSeam,
	withdrawAsyncQuestions,
} = await import("../narrator-question-service");

const createAsyncQuestion = (args: Parameters<typeof createQuestionRecord>[0]) =>
	createQuestionRecord({
		context: "API cache decision; continue implementation with local cache while waiting.",
		...args,
	});

const NARRATOR_ID = "async-q-narrator";
const OTHER_NARRATOR_ID = "async-q-other-narrator";
const MESSAGE_ID = "async-q-message";

/**
 * Seed the rows a question's foreign keys require.
 *
 * Re-seeded per test rather than once at module scope: `cleanDb` truncates everything
 * between tests, so a module-level insert would survive only the first one.
 */
async function seedParents(): Promise<void> {
	const now = new Date().toISOString();
	await testDb.insert(users).values({
		id: "user-1",
		username: "question-user",
		passwordHash: "unused",
		createdAt: now,
	});
	// Inserted through Drizzle rather than raw SQL so the real schema's NOT NULL columns
	// are supplied by the table definition instead of a literal column list this test
	// would have to keep in step with every migration.
	await testDb.insert(narrators).values([
		{ id: NARRATOR_ID, createdAt: now, updatedAt: now },
		{ id: OTHER_NARRATOR_ID, createdAt: now, updatedAt: now },
	]);
	await testDb.insert(narratorMessages).values({
		id: MESSAGE_ID,
		narratorId: NARRATOR_ID,
		role: "assistant",
		contentJson: [],
		contentText: "",
		createdAt: now,
	});
}

let loopRunning = false;
const { deliverInjection, setInjectionScheduler } = await import("../narrator-injection");
const previousScheduler = setInjectionScheduler({
	requestSoftStop: () => loopRunning,
	wakeIfIdle: async () => ({ started: false }),
});
setQuestionServiceSeam({
	isLoopRunning: () => loopRunning,
	scheduleQuestionAnswerDelivery: async () => {
		scheduledDeliveries += 1;
		return { ready: true, started: false };
	},
	deliverInjection: async (narratorId, options) => {
		injections.push({
			narratorId,
			content: options.content,
			source: options.source,
			role: options.role,
			schedule: options.schedule,
			body: options.body,
		});
		if (deliveryError) throw deliveryError;
		return deliverInjection(narratorId, options);
	},
	broadcastToNarrator: (_id, payload) => {
		broadcasts.push(payload as { type: string; change?: string });
	},
	emitAttention: (narratorId) => attentions.push({ kind: "raised", narratorId }),
	emitAttentionResolved: (narratorId) => attentions.push({ kind: "resolved", narratorId }),
});

let nextCallSeq = 0;
async function seedToolCall(
	narratorId = NARRATOR_ID,
): Promise<{ toolCallId: string; toolUseId: string }> {
	nextCallSeq += 1;
	const toolCallId = `call-${nextCallSeq}`;
	const toolUseId = `tu-${nextCallSeq}`;
	await testDb.insert(narratorToolCalls).values({
		id: toolCallId,
		narratorId,
		messageId: MESSAGE_ID,
		toolUseId,
		toolName: "AskUserQuestion",
		inputJson: { questions: [], async: true },
		status: "success",
		createdAt: new Date().toISOString(),
	});
	return { toolCallId, toolUseId };
}

describe("question lifecycle closure", () => {
	test("canonical IDs preserve answers and notes when another title names that ID", async () => {
		for (const partial of [false, true]) {
			const call = await seedToolCall();
			const { record } = await createAsyncQuestion({
				narratorId: NARRATOR_ID,
				...call,
				questions: [
					{ id: "q1", header: "q2", options: [{ header: "A" }] },
					{ id: "q2", header: "Second", options: [{ header: "B" }] },
				],
			});
			const result = await answerAsyncQuestion(record.id, {
				answers: partial ? { q2: "B" } : { q1: "A", q2: "B" },
				annotations: { q2: { notes: "Second question only" } },
			});
			expect(result.ok).toBe(true);
			const body = injections.at(-1)?.body as {
				items: { questionId: string; answer: string; answerProvided: boolean; notes?: string }[];
			};
			expect(body.items[0]).toMatchObject({
				questionId: "q1",
				answer: partial ? "" : "A",
				answerProvided: !partial,
			});
			expect(body.items[0].notes).toBeUndefined();
			expect(body.items[1]).toMatchObject({
				questionId: "q2",
				answer: "B",
				notes: "Second question only",
			});
		}
	});
	test("new async requires context, user-deferred remains compatible, and UTF-8 budgets apply", async () => {
		const call = await seedToolCall();
		await expect(
			createQuestionRecord({ narratorId: NARRATOR_ID, ...call, questions: QUESTIONS }),
		).rejects.toThrow("context");
		await expect(
			createQuestionRecord({
				narratorId: NARRATOR_ID,
				...call,
				questions: QUESTIONS,
				context: "中".repeat(700),
			}),
		).rejects.toThrow("2048");
		const result = await createQuestionRecord({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
			origin: "user_deferred",
		});
		expect(result.record.context).toBeNull();
	});
	test("a partial batch answer keeps every original topic and identifies omitted answers", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: [
				{ id: "one", header: "First", options: [{ header: "A", description: "First meaning" }] },
				{
					id: "two",
					header: "Second",
					options: [{ header: "B", description: "Second meaning after compression" }],
				},
			],
		});
		expect((await answerAsyncQuestion(record.id, { answers: { one: "A" } })).ok).toBe(true);
		const body = injections[0].body as { items: { questionId: string; answerProvided: boolean }[] };
		expect(body.items.map((item) => [item.questionId, item.answerProvided])).toEqual([
			["one", true],
			["two", false],
		]);
		expect(injections[0].content).toContain("Second meaning after compression");
	});
	test("a fork sharing the asked prefix never receives a late answer via original SDK/tool input", async () => {
		const call = await seedToolCall();
		const input = { async: true, context: "Cache choice before the fork", questions: QUESTIONS };
		const sdk = JSON.stringify([
			{ type: "tool_use", id: call.toolUseId, name: "AskUserQuestion", input },
		]);
		const originalInput = JSON.stringify(input);
		sqlite.query("UPDATE narrator_messages SET content_json = ? WHERE id = ?").run(sdk, MESSAGE_ID);
		sqlite
			.query("UPDATE narrator_tool_calls SET input_json = ? WHERE id = ?")
			.run(originalInput, call.toolCallId);
		await testDb.insert(narratorMessageRefs).values([
			{ id: "original-prefix-ref", narratorId: NARRATOR_ID, messageId: MESSAGE_ID, seq: 1 },
			{ id: "fork-prefix-ref", narratorId: OTHER_NARRATOR_ID, messageId: MESSAGE_ID, seq: 1 },
		]);
		sqlite
			.query("UPDATE narrators SET next_seq = 2 WHERE id IN (?, ?)")
			.run(NARRATOR_ID, OTHER_NARRATOR_ID);
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
			context: input.context,
		});
		const answer = await answerAsyncQuestion(record.id, {
			answers: { "cache-layer": "LATE_PRIVATE_ANSWER" },
			userId: "user-1",
		});
		expect(answer.ok).toBe(true);
		const sharedInput = sqlite
			.query<{ input_json: string }, [string]>(
				"SELECT input_json FROM narrator_tool_calls WHERE id = ?",
			)
			.get(call.toolCallId);
		expect(sharedInput?.input_json).toBe(originalInput);
		const forkHistory = sqlite
			.query<{ content_json: string; role: string }, [string]>(
				"SELECT m.content_json, m.role FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? ORDER BY r.seq",
			)
			.all(OTHER_NARRATOR_ID);
		expect(forkHistory).toHaveLength(1);
		expect(forkHistory[0].content_json).toBe(sdk);
		expect(JSON.stringify(forkHistory)).not.toContain("LATE_PRIVATE_ANSWER");
		expect(
			sqlite
				.query<{ n: number }, [string]>(
					"SELECT count(*) AS n FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? AND m.role='user'",
				)
				.get(NARRATOR_ID)?.n,
		).toBe(1);
	});
	test("prototype-looking frozen IDs preserve answers and notes across storage", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: [{ id: "__proto__", header: "Prototype-looking ID", options: [] }],
		});
		const answered = await answerAsyncQuestion(record.id, {
			answers: { "Prototype-looking ID": "Safe answer" },
			annotations: { "Prototype-looking ID": { notes: "Safe notes" } },
		});
		expect(answered.ok).toBe(true);
		const stored = await getAsyncQuestion(record.id);
		expect(Object.hasOwn(stored?.answers ?? {}, "__proto__")).toBe(true);
		expect(stored?.answers?.["__proto__"]).toBe("Safe answer");
		expect(stored?.annotations?.["__proto__"]?.notes).toBe("Safe notes");
	});
	test("history notification processes beyond 200 IDs and releases a physically deleted waiter", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
		});
		const waiting = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 1000,
		});
		await Bun.sleep(5);
		sqlite.query("DELETE FROM narrator_questions WHERE id = ?").run(record.id);
		broadcasts = [];
		await notifyQuestionHistoryChanged(NARRATOR_ID, [
			...Array.from({ length: 205 }, (_, index) => `removed-${index}`),
			record.id,
		]);
		const result = await waiting;
		expect(result.status).toBe("withdrawn");
		expect(broadcasts.filter((event) => event.change === "withdrawn")).toHaveLength(206);
		expect(isAsyncQuestionAwaited(record.id)).toBe(false);
	});
	test("supplement backfills a legacy original event and its processing note", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
		});
		const answer = await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
		if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
		sqlite.query("DELETE FROM narrator_question_events WHERE question_id = ?").run(record.id);
		await resolveAsyncQuestion({
			id: record.id,
			narratorId: NARRATOR_ID,
			answerMessageId: answer.record.answerMessageId,
			note: "Original legacy handling",
		});
		expect((await supplementAsyncQuestion(record.id, { text: "Actually memory" })).ok).toBe(true);
		const detail = await getBoundedQuestionDetail(record.id);
		expect(detail.events.map((event) => event.kind)).toEqual(["answer", "supplement"]);
		expect(detail.events[0].messageId).toBe(answer.record.answerMessageId);
		expect(detail.events[0].resolution?.note).toBe("Original legacy handling");
		expect(detail.record?.answers).toEqual({ "cache-layer": "Redis" });
	});
	test("full inbox releases Await with a bounded receipt fallback and retry never duplicates messages", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
		});
		let ready = false;
		let attempts = 0;
		const previous = setQuestionServiceSeam({
			isLoopRunning: () => true,
			broadcastToNarrator: () => {},
			deliverInjection,
			scheduleQuestionAnswerDelivery: async () => {
				attempts++;
				return { ready, started: false };
			},
		});
		try {
			const waiting = awaitAsyncQuestion({
				questionId: record.id,
				narratorId: NARRATOR_ID,
				timeoutMs: 500,
			});
			await Bun.sleep(5);
			const answer = await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
			const result = await waiting;
			if (result.status === "not_found") throw new Error("Question waiter lost its own record.");
			expect(result.status).toBe("answered");
			expect(result.record?.receiptReady).toBe(false);
			if (!answer.ok || !answer.record.answerMessageId) throw new Error("answer failed");
			expect(await getBoundedQuestionReceipt(answer.record.answerMessageId, NARRATOR_ID)).toContain(
				"Redis",
			);
			ready = true;
			expect((await retryQuestionAnswerDelivery(NARRATOR_ID, record.id)).ready).toBe(true);
			expect(attempts).toBe(2);
			expect(
				sqlite.query("SELECT count(*) AS n FROM narrator_messages WHERE role='user'").get(),
			).toEqual({ n: 1 });
		} finally {
			setQuestionServiceSeam(previous);
		}
	});
	test("oversized snapshots and answers reject before changing state; legacy detail stays bounded", async () => {
		const call = await seedToolCall();
		await expect(
			createAsyncQuestion({
				narratorId: NARRATOR_ID,
				...call,
				questions: [
					{
						id: "q",
						header: "Question",
						options: [{ header: "Artifact", preview: "x".repeat(64 * 1024) }],
					},
				],
			}),
		).rejects.toThrow("snapshot");
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: QUESTIONS,
		});
		await expect(
			answerAsyncQuestion(record.id, { answers: { "cache-layer": "x".repeat(16 * 1024) } }),
		).rejects.toThrow("answers");
		expect((await getAsyncQuestion(record.id))?.status).toBe("open");
		sqlite
			.query("UPDATE narrator_questions SET questions_json = ? WHERE id = ?")
			.run(
				JSON.stringify([{ id: "historical question id with spaces", header: "Legacy" }]),
				record.id,
			);
		expect((await getBoundedQuestionDetail(record.id)).record?.questions[0].id).toBe(
			"historical question id with spaces",
		);
		sqlite.query("UPDATE narrator_questions SET questions_json = ? WHERE id = ?").run(
			JSON.stringify([
				{ id: "a", header: "Same" },
				{ id: "b", header: "Same" },
			]),
			record.id,
		);
		await expect(
			answerAsyncQuestion(record.id, { answers: { Same: "ambiguous" } }),
		).rejects.toThrow("ambiguous");
		sqlite.query("UPDATE narrator_questions SET questions_json = ? WHERE id = ?").run(
			JSON.stringify([
				{
					id: "cache-layer",
					header: "Legacy",
					options: [{ header: "Artifact", preview: "x".repeat(100 * 1024) }],
				},
			]),
			record.id,
		);
		const detail = await getBoundedQuestionDetail(record.id);
		expect(detail.tooLarge).toBe(true);
		expect(detail.record).toBeNull();
		const summaries = await listQuestionSummaries({ narratorId: NARRATOR_ID, filter: "open" });
		expect(JSON.stringify(summaries)).not.toContain("x".repeat(1000));
		expect(Object.hasOwn(summaries.items[0], "answers")).toBe(false);
		const legacyList = await listAsyncQuestions({ narratorId: NARRATOR_ID, status: "open" });
		expect(legacyList.items[0].detailTooLarge).toBe(true);
		expect(legacyList.items[0].questions).toEqual([]);
	});
	test("stable IDs, self-contained receipt, CAS, supplement history and summary bounds", async () => {
		const call = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			...call,
			questions: [
				{
					id: "cache-layer",
					header: "Cache",
					description: "Choose the cache",
					options: [
						{ header: "Redis", description: "Shared service", preview: "x".repeat(1000) },
						{ header: "Memory", description: "Process-local cache" },
					],
				},
			],
		});
		const answered = await answerAsyncQuestion(record.id, {
			answers: { Cache: "All except Redis" },
			userId: "user-1",
		});
		if (!answered.ok || !answered.record.answerMessageId) throw new Error("answer failed");
		expect(answered.record.answers).toEqual({ "cache-layer": "All except Redis" });
		expect(injections[0].content).toContain("Shared service");
		expect(injections[0].content).toContain("Process-local cache");
		expect(injections[0].content).toContain("Preview");
		expect(injections[0].content).not.toContain("x".repeat(1000));
		expect(
			(await listQuestionSummaries({ narratorId: NARRATOR_ID, filter: "pending" })).items,
		).toHaveLength(1);
		expect(await buildPendingQuestionHint(NARRATOR_ID)).toContain(record.id);
		const resolution = {
			id: record.id,
			narratorId: NARRATOR_ID,
			answerMessageId: answered.record.answerMessageId,
			note: "Keep local caching while waiting.",
		};
		expect((await resolveAsyncQuestion(resolution)).ok).toBe(true);
		expect((await resolveAsyncQuestion(resolution)).ok).toBe(true);
		expect((await resolveAsyncQuestion({ ...resolution, narratorId: OTHER_NARRATOR_ID })).ok).toBe(
			false,
		);
		const supplemented = await supplementAsyncQuestion(record.id, {
			text: "  Use Redis after all.  ",
			userId: "user-1",
			expectedAnswerMessageId: resolution.answerMessageId,
		});
		if (!supplemented.ok) throw new Error("supplement failed");
		expect(supplemented.record.answers).toEqual(answered.record.answers);
		expect(supplemented.record.resolution).toBeNull();
		expect(supplemented.record.answerMessageId).not.toBe(resolution.answerMessageId);
		expect(injections[1].content).toContain("originalQuestionsAndFirstAnswers");
		expect(injections[1].content).toContain("historical background, not a re-submission");
		expect(injections[1].content).toContain("Read earlier supplement events");
		expect((await resolveAsyncQuestion(resolution)).ok).toBe(false);
		// Equal millisecond timestamps must still preserve durable insertion order.
		sqlite
			.query("UPDATE narrator_question_events SET created_at = ? WHERE question_id = ?")
			.run("2020-01-01T00:00:00.000Z", record.id);
		const detail = await getBoundedQuestionDetail(record.id, { limit: 1 });
		expect(detail.events).toHaveLength(1);
		expect(detail.events[0].resolution?.note).toBe(resolution.note);
		expect(detail.nextCursor).not.toBeNull();
		const next = await getBoundedQuestionDetail(record.id, {
			cursor: detail.nextCursor ?? undefined,
		});
		expect(next.events[0].text).toBe("  Use Redis after all.  ");
		expect(
			(await getBoundedQuestionDetail(record.id, { narratorId: OTHER_NARRATOR_ID })).record,
		).toBeNull();
		expect((await getBoundedQuestionDetail(record.id, { narratorId: "" })).record).toBeNull();
	});
});

const QUESTIONS = [
	{
		id: "cache-layer",
		header: "Which cache layer should the API use?",
		options: [{ header: "Redis", description: "Shared, needs a service" }],
	},
];

beforeEach(async () => {
	injections = [];
	broadcasts = [];
	attentions = [];
	scheduledDeliveries = 0;
	deliveryError = null;
	loopRunning = false;
	cleanDb(sqlite);
	await seedParents();
});

afterAll(() => {
	setQuestionServiceSeam(null);
	setInjectionScheduler(previousScheduler);
	// Re-point the module at the real database. `mock.restore()` does not undo
	// `mock.module`, so without this the migrated-but-empty test db would be `db` for
	// every suite that runs after this file in the same process.
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("own question wait capability", () => {
	test("Await(question) still reads an existing own answer but rejects another session's question", async () => {
		const { awaitTool } = await import("../../lib/agent/tools/await");
		const { resolveToolFilter } = await import("../subagent-tools");
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		const answer = await answerAsyncQuestion(record.id, {
			answers: { "cache-layer": "Redis" },
			userId: "user-1",
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		const filter = resolveToolFilter("general");
		// Asking is gone for subagents, but waiting on a question that already exists
		// (e.g. filed by the primary before delegation) stays available.
		expect(filter?.({ ...awaitTool, name: "AskUserQuestion" })).toBe(false);
		expect(filter?.(awaitTool)).toBe(true);
		const context = {
			narratorId: NARRATOR_ID,
			parentNarratorId: "legacy-parent",
			currentToolUseId: "legacy-question-wait",
			signal: new AbortController().signal,
		} as import("../../lib/agent/types").ToolContext;
		const own = await awaitTool.execute({ type: "question", id: record.id }, context);
		expect(own.isError).not.toBe(true);
		expect(own.output).toContain("Redis");
		expect(own.metadata?.status).toBe("answered");
		const foreign = await awaitTool.execute(
			{ type: "question", id: record.id },
			{
				...context,
				narratorId: OTHER_NARRATOR_ID,
			},
		);
		expect(foreign.isError).toBe(true);
		expect(foreign.output).toContain("not an async question belonging to this session");
	});
});

describe("createAsyncQuestion", () => {
	test("records one open question and announces it", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record, created } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		expect(created).toBe(true);
		expect(record.status).toBe("open");
		expect(record.origin).toBe("agent_async");
		expect(record.questions).toHaveLength(1);
		expect(record.questions[0]?.header).toBe(QUESTIONS[0]?.header);
		expect(record.answers).toBeNull();
		expect(broadcasts).toEqual([
			expect.objectContaining({ type: "async_question_changed", change: "opened" }),
		]);
		// Filing a question must NOT talk to the model: the acknowledgement is the tool's
		// return value, and an injection here would be a second, contradictory delivery.
		expect(injections).toHaveLength(0);
	});

	test("a replayed tool execution returns the existing row instead of a duplicate", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const first = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];

		const second = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		expect(second.created).toBe(false);
		expect(second.record.id).toBe(first.record.id);
		expect(await countOpenAsyncQuestions(NARRATOR_ID)).toBe(1);
		// No second "opened" event: the UI already shows this question.
		expect(broadcasts).toHaveLength(0);
	});
});

describe("answerAsyncQuestion", () => {
	test("persists the answer without mutating the original tool input and delivers it as a user turn", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];

		const result = await answerAsyncQuestion(record.id, {
			answers: { "cache-layer": "Redis" },
			userId: "user-1",
			locale: "en",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.status).toBe("answered");
		expect(result.record.answers).toEqual({ "cache-layer": "Redis" });
		expect(result.record.decidedBy).toBe("user-1");
		expect(result.record.answerMessageId).toEqual(expect.any(String));
		const message = sqlite
			.query("SELECT role, content_text FROM narrator_messages WHERE id = ?")
			.get(result.record.answerMessageId as string) as { role: string; content_text: string };
		expect(message.role).toBe("user");
		expect(message.content_text).toContain("Redis");

		// The original tool input is a frozen historical/shared-prefix snapshot.
		// Late answers belong only to the question row and appended user events.
		const row = sqlite
			.query<{ input_json: string }, [string]>(
				"SELECT input_json FROM narrator_tool_calls WHERE id = ?",
			)
			.get(toolCallId);
		expect(JSON.parse(row?.input_json ?? "{}").answers).toBeUndefined();

		expect(injections).toHaveLength(1);
		const injection = injections[0];
		// `user`, not `sys`: this is the user speaking, and consumers such as
		// taskReflection only recognise a user instruction from a user turn.
		expect(injection?.role).toBe("user");
		expect(injection?.source).toBe("async_question");
		// Idle narrator → wake it, so the answer is acted on now rather than whenever the
		// user happens to send something next.
		expect(injection?.schedule).toBe("none");
		expect(injection?.content).toContain("Redis");
		expect(injection?.content).toContain(QUESTIONS[0]?.header as string);
		expect(injection?.body).toMatchObject({
			kind: "asyncQuestionAnswers",
			questionId: record.id,
			answerMessageId: result.record.answerMessageId,
			context: record.context,
			outcome: "answered",
			items: [
				{
					questionId: "cache-layer",
					header: QUESTIONS[0]?.header,
					answer: "Redis",
					options: [{ header: "Redis", description: "Shared, needs a service", hasPreview: false }],
				},
			],
		});

		expect(broadcasts).toEqual([
			expect.objectContaining({ type: "async_question_changed", change: "answered" }),
		]);
		expect(await countOpenAsyncQuestions(NARRATOR_ID)).toBe(0);
	});

	test("persists without interrupting a running loop, then hands off to the safe-turn scheduler", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		loopRunning = true;

		await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });

		// A running loop rebuilds its history only at pass start, so the answer has to ask
		// for a stop at the next tool boundary to be taken up promptly.
		expect(injections[0]?.schedule).toBe("none");
	});

	test("answering twice reports the second attempt as stale", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		const first = await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
		const second = await answerAsyncQuestion(record.id, {
			answers: { "cache-layer": "In-memory" },
		});

		expect(first.ok).toBe(true);
		expect(second).toEqual({ ok: false, reason: "stale" });
		// The losing answer must not reach the model, or the agent would receive two
		// contradictory decisions for one question.
		expect(injections).toHaveLength(1);
	});

	test("an unknown id is not found rather than stale", async () => {
		expect(await answerAsyncQuestion("no-such-question", { answers: { a: "b" } })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	test("failed message delivery leaves the question open and a retry delivers once", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];
		deliveryError = new Error("injected persistence failure");
		await expect(
			answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } }),
		).rejects.toThrow("injected persistence failure");
		expect((await getAsyncQuestion(record.id))?.status).toBe("open");
		expect((await getAsyncQuestion(record.id))?.answers).toBeNull();
		expect(broadcasts).toEqual([]);
		expect(
			sqlite.query("SELECT count(*) AS n FROM narrator_messages WHERE role = 'user'").get(),
		).toEqual({ n: 0 });
		const input = sqlite
			.query("SELECT input_json FROM narrator_tool_calls WHERE id = ?")
			.get(toolCallId) as { input_json: string };
		expect(JSON.parse(input.input_json).answers).toBeUndefined();

		deliveryError = null;
		const retried = await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
		expect(retried.ok).toBe(true);
		expect(
			sqlite.query("SELECT count(*) AS n FROM narrator_messages WHERE role = 'user'").get(),
		).toEqual({ n: 1 });
	});

	test("question update and message insert roll back together on a database failure", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		sqlite.run(`CREATE TEMP TRIGGER reject_question_message BEFORE INSERT ON narrator_messages
			WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'injected message insert failure'); END`);
		try {
			await expect(
				answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } }),
			).rejects.toThrow("injected message insert failure");
			expect((await getAsyncQuestion(record.id))?.status).toBe("open");
			expect((await getAsyncQuestion(record.id))?.answerMessageId).toBeNull();
		} finally {
			sqlite.run("DROP TRIGGER reject_question_message");
		}
		expect((await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } })).ok).toBe(
			true,
		);
	});

	test("a failed question update rolls back the already-inserted message and history ref", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		sqlite.run(`CREATE TEMP TRIGGER reject_question_update BEFORE UPDATE OF status ON narrator_questions
			BEGIN SELECT RAISE(ABORT, 'injected question update failure'); END`);
		try {
			await expect(
				answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } }),
			).rejects.toThrow("injected question update failure");
			expect((await getAsyncQuestion(record.id))?.status).toBe("open");
			expect(
				sqlite.query("SELECT count(*) AS n FROM narrator_messages WHERE role = 'user'").get(),
			).toEqual({ n: 0 });
			expect(sqlite.query("SELECT count(*) AS n FROM narrator_message_refs").get()).toEqual({
				n: 0,
			});
		} finally {
			sqlite.run("DROP TRIGGER reject_question_update");
		}
	});

	test("an error after message commit does not reopen or duplicate the decided question", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		const previous = setQuestionServiceSeam({
			isLoopRunning: () => false,
			broadcastToNarrator: () => {},
			deliverInjection: async (narratorId, options) => {
				await deliverInjection(narratorId, options);
				throw new Error("injected post-commit failure");
			},
		});
		try {
			expect(
				(await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } })).ok,
			).toBe(true);
			expect(
				(await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } })).ok,
			).toBe(true);
			expect(
				sqlite.query("SELECT count(*) AS n FROM narrator_messages WHERE role = 'user'").get(),
			).toEqual({ n: 1 });
		} finally {
			setQuestionServiceSeam(previous);
		}
	});

	test("concurrent answers commit one message and never deliver the losing decision", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		const results = await Promise.all([
			answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } }),
			answerAsyncQuestion(record.id, { answers: { "cache-layer": "In-memory" } }),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "stale" });
		const messages = sqlite
			.query("SELECT content_text FROM narrator_messages WHERE role = 'user'")
			.all() as { content_text: string }[];
		expect(messages).toHaveLength(1);
		const winner = await getAsyncQuestion(record.id);
		expect(messages[0]?.content_text).toContain(winner?.answers?.["cache-layer"] as string);
	});
});

describe("dismissAsyncQuestion", () => {
	test("a failed dismissal remains open and can be retried", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		deliveryError = new Error("injected dismissal failure");
		await expect(dismissAsyncQuestion(record.id)).rejects.toThrow("injected dismissal failure");
		expect((await getAsyncQuestion(record.id))?.status).toBe("open");
		deliveryError = null;
		const result = await dismissAsyncQuestion(record.id);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.record.answerMessageId).toEqual(expect.any(String));
	});

	test("tells the agent to decide for itself", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];

		const result = await dismissAsyncQuestion(record.id, { userId: "user-1", locale: "en" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.status).toBe("dismissed");
		// A silent dismissal would leave the agent waiting for an answer that never comes.
		expect(injections).toHaveLength(1);
		expect(injections[0]?.body).toMatchObject({
			kind: "asyncQuestionAnswers",
			questionId: record.id,
			outcome: "dismissed",
			items: [{ header: QUESTIONS[0]?.header, answer: "" }],
		});
		// The dismissal still names the question, so the agent knows WHICH decision came
		// back to it.
		expect(injections[0]?.content).toContain(QUESTIONS[0]?.header as string);
		expect(broadcasts).toEqual([
			expect.objectContaining({ type: "async_question_changed", change: "dismissed" }),
		]);
	});

	test("cannot dismiss an already answered question", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });

		expect(await dismissAsyncQuestion(record.id)).toEqual({ ok: false, reason: "stale" });
	});
});

describe("withdrawAsyncQuestions", () => {
	test("withdraws the narrator's own open questions and reports the rest as skipped", async () => {
		const own = await seedToolCall();
		const alsoOwn = await seedToolCall();
		const foreign = await seedToolCall(OTHER_NARRATOR_ID);
		const a = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId: own.toolCallId,
			toolUseId: own.toolUseId,
			questions: QUESTIONS,
		});
		const b = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId: alsoOwn.toolCallId,
			toolUseId: alsoOwn.toolUseId,
			questions: QUESTIONS,
		});
		const other = await createAsyncQuestion({
			narratorId: OTHER_NARRATOR_ID,
			toolCallId: foreign.toolCallId,
			toolUseId: foreign.toolUseId,
			questions: QUESTIONS,
		});
		await answerAsyncQuestion(b.record.id, { answers: { "cache-layer": "Redis" } });
		injections = [];

		const result = await withdrawAsyncQuestions(NARRATOR_ID, [
			a.record.id,
			b.record.id,
			other.record.id,
			"ghost-id",
		]);

		expect(result.withdrawn).toEqual([a.record.id]);
		// Already answered, another narrator's, and nonexistent all fall into "skipped" —
		// the tool names them back so the agent can tell why.
		expect(result.skipped.sort()).toEqual([b.record.id, "ghost-id", other.record.id].sort());
		// A withdraw is the agent tidying up; the user needs no message about a question
		// they had not answered.
		expect(injections).toHaveLength(0);
		// The other narrator's question is untouched.
		expect(await countOpenAsyncQuestions(OTHER_NARRATOR_ID)).toBe(1);
	});

	test("an empty id list is a no-op", async () => {
		expect(await withdrawAsyncQuestions(NARRATOR_ID, [])).toEqual({
			withdrawn: [],
			skipped: [],
		});
	});
});

describe("ignoreAsyncQuestion", () => {
	test("closes the question without delivering a message or scheduling a wake", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];

		const result = await ignoreAsyncQuestion(record.id, { userId: "user-1", locale: "en" });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.record.status).toBe("withdrawn");
		expect(result.record.decidedBy).toBe("user-1");
		expect(result.record.withdrawReason).toContain("Ignored by the user");
		// The whole point of the action: the narrator learns nothing and is not woken.
		expect(injections).toHaveLength(0);
		expect(scheduledDeliveries).toBe(0);
		expect(result.record.answerMessageId).toBeNull();
		// ...but the inbox still hears about it, so the question disappears from the UI.
		expect(broadcasts).toEqual([
			expect.objectContaining({ type: "async_question_changed", change: "withdrawn" }),
		]);
		expect(await countOpenAsyncQuestions(NARRATOR_ID)).toBe(0);
	});

	test("a blocked Await is released as withdrawn, not left parked", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		const wait = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 60_000,
		});
		// Let the wait register its listener before the decision lands.
		await new Promise((resolve) => setImmediate(resolve));
		await ignoreAsyncQuestion(record.id, { userId: "user-1" });

		const awaited = await wait;
		expect(awaited.status).toBe("withdrawn");
		// Releasing an already-running waiter is not a wake.
		expect(injections).toHaveLength(0);
		expect(scheduledDeliveries).toBe(0);
	});

	test("ignoring twice reports the second attempt as stale; an unknown id is not found", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		expect((await ignoreAsyncQuestion(record.id)).ok).toBe(true);
		expect(await ignoreAsyncQuestion(record.id)).toEqual({ ok: false, reason: "stale" });
		expect(await ignoreAsyncQuestion("ghost-id")).toEqual({ ok: false, reason: "not_found" });
	});
});

/**
 * Awaiting a question is where its meaning changes: an unawaited one is explicitly not
 * urgent, while an awaited one has stopped the session. The properties pinned here are
 * the ones whose failure is silent — a wait that never wakes (the agent hangs until its
 * timeout), or an attention that is raised and never cleared (a permanent "waiting"
 * badge nobody can dismiss).
 */
describe("awaitAsyncQuestion", () => {
	test("resolves as soon as the question is answered, and flags it as awaited meanwhile", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		broadcasts = [];
		attentions = [];

		const waiting = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
		});
		// Let the wait register before answering.
		await Bun.sleep(10);

		expect(isAsyncQuestionAwaited(record.id)).toBe(true);
		// The session is now blocked on the user, so it must raise the same attention a
		// permission prompt does — that is what drives notifications.
		expect(attentions).toEqual([{ kind: "raised", narratorId: NARRATOR_ID }]);
		expect(broadcasts.some((b) => b.change === "awaited")).toBe(true);

		await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
		const result = await waiting;

		expect(result.status).toBe("answered");
		if (result.status === "not_found") return;
		expect(result.record.answers).toEqual({ "cache-layer": "Redis" });
		// Cleared on the way out, or the badge would never go away.
		expect(isAsyncQuestionAwaited(record.id)).toBe(false);
		expect(attentions).toEqual([
			{ kind: "raised", narratorId: NARRATOR_ID },
			{ kind: "resolved", narratorId: NARRATOR_ID },
		]);
	});

	test("a dismissal and a withdrawal also end the wait", async () => {
		for (const decide of ["dismiss", "withdraw"] as const) {
			cleanDb(sqlite);
			await seedParents();
			const { toolCallId, toolUseId } = await seedToolCall();
			const { record } = await createAsyncQuestion({
				narratorId: NARRATOR_ID,
				toolCallId,
				toolUseId,
				questions: QUESTIONS,
			});

			const waiting = awaitAsyncQuestion({
				questionId: record.id,
				narratorId: NARRATOR_ID,
				timeoutMs: 0,
			});
			await Bun.sleep(10);
			if (decide === "dismiss") await dismissAsyncQuestion(record.id);
			else await withdrawAsyncQuestions(NARRATOR_ID, [record.id]);

			const result = await waiting;
			expect(result.status).toBe(decide === "dismiss" ? "dismissed" : "withdrawn");
		}
	});

	test("an already-decided question returns immediately without raising attention", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });
		attentions = [];

		const result = await awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
		});

		expect(result.status).toBe("answered");
		// No wait happened, so alerting the user would be a notification about nothing.
		expect(attentions).toEqual([]);
	});

	test("a timeout ends the wait but leaves the question open", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		const controller = new AbortController();
		const waiting = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
			timeoutSignal: controller.signal,
		});
		await Bun.sleep(10);
		controller.abort();
		const result = await waiting;

		expect(result.status).toBe("timeout");
		// The row must survive: the user can still answer, and the agent may await again.
		expect((await getAsyncQuestion(record.id))?.status).toBe("open");
		expect(isAsyncQuestionAwaited(record.id)).toBe(false);
		expect(await countOpenAsyncQuestions(NARRATOR_ID)).toBe(1);
	});

	test("a parent interrupt is reported as aborted, not as a timeout", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		const parent = new AbortController();
		const timeout = new AbortController();
		const waiting = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
			signal: parent.signal,
			timeoutSignal: timeout.signal,
		});
		await Bun.sleep(10);
		parent.abort();

		// The distinction matters to the agent: after a timeout it should keep waiting,
		// after an interrupt it must not.
		expect((await waiting).status).toBe("aborted");
	});

	for (const kind of ["parent", "timeout"] as const) {
		test(`an already-aborted ${kind} signal does not start a wait`, async () => {
			const { toolCallId, toolUseId } = await seedToolCall();
			const { record } = await createAsyncQuestion({
				narratorId: NARRATOR_ID,
				toolCallId,
				toolUseId,
				questions: QUESTIONS,
			});
			const controller = new AbortController();
			controller.abort();
			const waiting = awaitAsyncQuestion({
				questionId: record.id,
				narratorId: NARRATOR_ID,
				timeoutMs: 0,
				...(kind === "parent"
					? { signal: controller.signal }
					: { timeoutSignal: controller.signal }),
			});
			try {
				const status = await Promise.race([
					waiting.then((r) => r.status),
					Bun.sleep(50).then(() => "still_waiting"),
				]);
				expect(status).toBe(kind === "parent" ? "aborted" : "timeout");
				expect(isAsyncQuestionAwaited(record.id)).toBe(false);
				expect(attentions).toEqual([]);
			} finally {
				await withdrawAsyncQuestions(NARRATOR_ID, [record.id]);
				await waiting;
			}
		});
	}

	test("an abort during awaited broadcast cannot fall into the listener-registration gap", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});
		const controller = new AbortController();
		const previous = setQuestionServiceSeam({
			isLoopRunning: () => false,
			broadcastToNarrator: (_id, event) => {
				if (event.type === "async_question_changed" && event.change === "awaited")
					controller.abort();
			},
			emitAttention: () => {},
			emitAttentionResolved: () => {},
		});
		const waiting = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
			signal: controller.signal,
		});
		try {
			expect(
				await Promise.race([
					waiting.then((r) => r.status),
					Bun.sleep(50).then(() => "still_waiting"),
				]),
			).toBe("aborted");
			expect(isAsyncQuestionAwaited(record.id)).toBe(false);
		} finally {
			await withdrawAsyncQuestions(NARRATOR_ID, [record.id]);
			await waiting;
			setQuestionServiceSeam(previous);
		}
	});

	test("another narrator's question is not awaitable", async () => {
		const foreign = await seedToolCall(OTHER_NARRATOR_ID);
		const { record } = await createAsyncQuestion({
			narratorId: OTHER_NARRATOR_ID,
			toolCallId: foreign.toolCallId,
			toolUseId: foreign.toolUseId,
			questions: QUESTIONS,
		});

		expect(
			await awaitAsyncQuestion({
				questionId: record.id,
				narratorId: NARRATOR_ID,
				timeoutMs: 0,
			}),
		).toEqual({ status: "not_found" });
	});

	test("two concurrent waits on one question both resolve", async () => {
		const { toolCallId, toolUseId } = await seedToolCall();
		const { record } = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId,
			toolUseId,
			questions: QUESTIONS,
		});

		const first = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
		});
		const second = awaitAsyncQuestion({
			questionId: record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
		});
		await Bun.sleep(10);
		await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } });

		expect((await first).status).toBe("answered");
		expect((await second).status).toBe("answered");
		// Refcounted, so the first waiter finishing does not clear the flag for the second.
		expect(isAsyncQuestionAwaited(record.id)).toBe(false);
	});

	test("an awaited question sorts ahead of a newer unawaited one", async () => {
		const older = await seedToolCall();
		const newer = await seedToolCall();
		const a = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId: older.toolCallId,
			toolUseId: older.toolUseId,
			questions: QUESTIONS,
		});
		const b = await createAsyncQuestion({
			narratorId: NARRATOR_ID,
			toolCallId: newer.toolCallId,
			toolUseId: newer.toolUseId,
			questions: QUESTIONS,
		});
		sqlite.run("UPDATE narrator_questions SET created_at = ? WHERE id = ?", [
			"2026-01-01T00:00:00.000Z",
			a.record.id,
		]);
		sqlite.run("UPDATE narrator_questions SET created_at = ? WHERE id = ?", [
			"2026-01-02T00:00:00.000Z",
			b.record.id,
		]);

		const controller = new AbortController();
		const waiting = awaitAsyncQuestion({
			questionId: a.record.id,
			narratorId: NARRATOR_ID,
			timeoutMs: 0,
			timeoutSignal: controller.signal,
		});
		await Bun.sleep(10);

		// The blocked question comes first even though it is older: an agent is stopped on
		// it, which is what makes it the one worth answering next.
		const page = await listAsyncQuestions({ narratorId: NARRATOR_ID, status: "open" });
		expect(page.items.map((q) => q.id)).toEqual([a.record.id, b.record.id]);
		expect(page.items[0]?.awaited).toBe(true);
		expect(page.items[1]?.awaited).toBe(false);

		controller.abort();
		await waiting;
	});
});

describe("listAsyncQuestions", () => {
	test("returns only the requested status, newest first, with a keyset cursor", async () => {
		const created: string[] = [];
		for (let i = 0; i < 3; i++) {
			const { toolCallId, toolUseId } = await seedToolCall();
			const { record } = await createAsyncQuestion({
				narratorId: NARRATOR_ID,
				toolCallId,
				toolUseId,
				questions: QUESTIONS,
			});
			created.push(record.id);
			// Distinct createdAt values so the ordering is deterministic rather than
			// tie-broken by id.
			sqlite.run("UPDATE narrator_questions SET created_at = ? WHERE id = ?", [
				`2026-01-0${i + 1}T00:00:00.000Z`,
				record.id,
			]);
		}
		await dismissAsyncQuestion(created[0] as string);

		const open = await listAsyncQuestions({ narratorId: NARRATOR_ID, status: "open" });
		expect(open.items.map((q) => q.id)).toEqual([created[2], created[1]]);
		expect(open.nextCursor).toBeNull();

		const firstPage = await listAsyncQuestions({
			narratorId: NARRATOR_ID,
			status: "open",
			limit: 1,
		});
		expect(firstPage.items.map((q) => q.id)).toEqual([created[2]]);
		expect(firstPage.nextCursor).not.toBeNull();

		const secondPage = await listAsyncQuestions({
			narratorId: NARRATOR_ID,
			status: "open",
			limit: 1,
			cursor: firstPage.nextCursor ?? undefined,
		});
		expect(secondPage.items.map((q) => q.id)).toEqual([created[1]]);
		expect(secondPage.nextCursor).toBeNull();
	});
});
