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
import { narratorMessages, narrators, narratorToolCalls, users } from "../../db/schema";

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
// Attention intents raised / cleared while a question is awaited. Recorded rather than
// asserted through the real event bus so the test does not depend on notification
// consumers being registered.
let attentions: { kind: "raised" | "resolved"; narratorId: string }[] = [];

const {
	answerAsyncQuestion,
	awaitAsyncQuestion,
	countOpenAsyncQuestions,
	createAsyncQuestion,
	dismissAsyncQuestion,
	getAsyncQuestion,
	isAsyncQuestionAwaited,
	listAsyncQuestions,
	setQuestionServiceSeam,
	withdrawAsyncQuestions,
} = await import("../narrator-question-service");

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
	test("persists the answer, mirrors it onto the tool call and delivers it as a user turn", async () => {
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

		// Mirrored onto the historical tool call so the answered card renders through the
		// same read-only replay path a synchronous question uses.
		const row = sqlite
			.query<{ input_json: string }, [string]>(
				"SELECT input_json FROM narrator_tool_calls WHERE id = ?",
			)
			.get(toolCallId);
		expect(JSON.parse(row?.input_json ?? "{}").answers).toEqual({ "cache-layer": "Redis" });

		expect(injections).toHaveLength(1);
		const injection = injections[0];
		// `user`, not `sys`: this is the user speaking, and consumers such as
		// taskReflection only recognise a user instruction from a user turn.
		expect(injection?.role).toBe("user");
		expect(injection?.source).toBe("async_question");
		// Idle narrator → wake it, so the answer is acted on now rather than whenever the
		// user happens to send something next.
		expect(injection?.schedule).toBe("wakeIfIdle");
		expect(injection?.content).toContain("Redis");
		expect(injection?.content).toContain(QUESTIONS[0]?.header as string);
		expect(injection?.body).toEqual({
			kind: "asyncQuestionAnswers",
			outcome: "answered",
			items: [{ header: QUESTIONS[0]?.header, answer: "Redis" }],
		});

		expect(broadcasts).toEqual([
			expect.objectContaining({ type: "async_question_changed", change: "answered" }),
		]);
		expect(await countOpenAsyncQuestions(NARRATOR_ID)).toBe(0);
	});

	test("interjects instead of waking when a loop is already running", async () => {
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
		expect(injections[0]?.schedule).toBe("interject");
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
			expect(await answerAsyncQuestion(record.id, { answers: { "cache-layer": "Redis" } })).toEqual(
				{ ok: false, reason: "stale" },
			);
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
		expect(injections[0]?.body).toEqual({
			kind: "asyncQuestionAnswers",
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
