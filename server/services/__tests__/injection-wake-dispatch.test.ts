/**
 * injection-wake-dispatch.test.ts — which ENGINE a `wakeIfIdle` injection starts.
 *
 * `startInjectionContinuationIfPossible` is the wake half of `deliverInjection`'s
 * `schedule: "wakeIfIdle"`, and it ran `runAgentLoop` unconditionally. For a primary
 * narrator that is correct and is what the other continuation entries do. For a
 * SUBAGENT it is not merely a different path — it bypasses everything that makes a
 * subagent run legitimate: the resume lock, the origin `tool_use` id, and the
 * conclusion publication that writes the result back into the parent's still-open
 * Agent tool call. `sendMessage` / `continueNarrator` / `retryLastMessage` all refuse a
 * subagent outright for that reason; this entry had no such guard, and
 * `async_question` already reaches it with `wakeIfIdle` whenever its target is idle.
 *
 * The failure mode is why this is tested at the dispatch rather than at the outcome:
 * running a subagent through the primary loop does not throw. It produces a turn whose
 * result never reaches the parent's tool call, which looks like "the subagent answered
 * but the parent never noticed" — indistinguishable from a dozen other things.
 *
 * So the assertions are about WHO is asked to run the turn, and about the refusals
 * being refusals rather than exceptions: the injected row is already durable by then,
 * so "not started" costs immediacy while a throw would fail the producer that was only
 * trying to notify somebody.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: () => {},
}));

/**
 * Stand in for the resume machinery. The real `resumeSubagent` pulls in the whole
 * subagent runner; what matters here is only that the dispatch reaches it with the
 * right intent and actor — its own admission rules are tested in `subagent-resume`.
 */
interface ResumeCall {
	subagentId: string;
	intent: string;
	actor: string;
	prompt?: string;
}
const resumeCalls: ResumeCall[] = [];
const resumePrincipals: unknown[] = [];
let resumeStarted = true;
let resumeThrows: Error | null = null;
let activeResumeRuns = new Set<string>();
const realSubagentResume = { ...(await import("../subagent-resume")) };
mock.module("../subagent-resume", () => ({
	...realSubagentResume,
	hasActiveSubagentResumeRun: (id: string) => activeResumeRuns.has(id),
	// biome-ignore lint/suspicious/noExplicitAny: only the asserted fields are used
	resumeSubagent: async (input: any) => {
		resumePrincipals.push(input.executionPrincipal);
		resumeCalls.push({
			subagentId: input.subagentId,
			intent: input.intent,
			actor: input.actor,
			prompt: input.prompt,
		});
		if (resumeThrows) throw resumeThrows;
		return { started: resumeStarted, resumedSuspendedRunner: false, originToolUseId: "toolu_x" };
	},
}));

const { startInjectionContinuationIfPossible, drainAndPersistPendingInjections } = await import(
	"../narrator-session"
);
const { pushParentInboundMessage } = await import("../parent-inbound-queue");
const { pushBgCompletionNotification } = await import("../bg-completion-queue");
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const { announceResumedBackgroundTask } = await import("../subagent-runner");

const now = "2026-07-28T10:00:00.000Z";
const PARENT_ID = "wake-parent";
const SUB_ID = "wake-sub";

beforeEach(() => {
	cleanDb(sqlite);
	resumeCalls.length = 0;
	resumePrincipals.length = 0;
	activeResumeRuns.clear();
	resumeStarted = true;
	resumeThrows = null;
});
afterEach(() => {
	cleanDb(sqlite);
});

function seedNarrator(
	id: string,
	options: { variant?: string; parent?: string; status?: string; traits?: string } = {},
) {
	sqlite
		.prepare(
			`INSERT INTO narrators (id, variant, parent_narrator_id, status, traits, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			id,
			options.variant ?? "primary",
			options.parent ?? null,
			options.status ?? "idle",
			options.traits ?? "[]",
			now,
			now,
		);
}

describe("parent injection initiating user", () => {
	test("pending injection userId comes from the producing pass metadata", async () => {
		const { recordTaskNoticeUser, takePendingInjectionBatch } = await import(
			"../parent-injection-queue"
		);
		const { createMailboxStore } = await import("../agent-runtime/mailbox");
		const { announceResumedBackgroundTask } = await import("../subagent-runner");
		seedNarrator(PARENT_ID, { status: "working" });
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		await announceResumedBackgroundTask({
			subagentId: SUB_ID,
			parentNarratorId: PARENT_ID,
			userId: "A",
			status: "completed",
			wakeParent: true,
			locale: "en",
		});
		const store = createMailboxStore(db);
		store.enqueue({
			kind: "task_notice",
			noticeKind: "agent",
			narratorId: PARENT_ID,
			text: "[System] pointer to original Agent tool result",
			projectedByteSize: 128,
			sourceKey: `wake-notice:${SUB_ID}:completed`,
			metadata: {
				producerKind: "agent",
				taskId: SUB_ID,
				logicalRunId: "wake-run",
				eventKind: "completed",
			},
		});
		expect(await takePendingInjectionBatch(PARENT_ID, "B")).toBeNull();
		const batch = await takePendingInjectionBatch(PARENT_ID);
		expect(batch?.userId).toBe("A");
		recordTaskNoticeUser(SUB_ID, null);
	});

	test("Send(parent) metadata carries the sending pass user", async () => {
		const { pushParentInboundMessage } = await import("../parent-inbound-queue");
		const { takePendingInjectionBatch } = await import("../parent-injection-queue");
		const { createAgentMessageDelivery } = await import("../agent-message-delivery");
		seedNarrator(PARENT_ID, { status: "working" });
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		const toolCallId = `${SUB_ID}-send-tool`;
		const messageId = `${SUB_ID}-send-msg`;
		sqlite
			.prepare(
				`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at) VALUES (?, ?, 'assistant', '[]', ?)`,
			)
			.run(messageId, SUB_ID, now);
		sqlite
			.prepare(
				`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, execution_attempt, execution_identity_version, status, created_at)
				 VALUES (?, ?, ?, 'send', 'Send', 1, 1, 'running', ?)`,
			)
			.run(toolCallId, SUB_ID, messageId, now);
		const delivery = createAgentMessageDelivery(
			PARENT_ID,
			{ id: SUB_ID, title: null, label: "child", type: "general", isParent: false },
			"send",
			"A report",
			{ toolCallId, attempt: 1 },
		);
		await pushParentInboundMessage(PARENT_ID, {
			delivery,
			userId: "A",
			fromId: SUB_ID,
			fromTitle: null,
			fromType: "general",
			fromToolUseId: "send",
			text: "A report",
			timestamp: now,
		});
		expect(await takePendingInjectionBatch(PARENT_ID, "B")).toBeNull();
		expect((await takePendingInjectionBatch(PARENT_ID))?.userId).toBe("A");
	});
});


describe("an idle SUBAGENT recipient", () => {
	test("an async question answer persists to the child before dispatching its original resume path", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		const { narratorMessages, narratorToolCalls, users } = await import("../../db/schema");
		const questions = await import("../narrator-question-service");
		await db.insert(users).values({
			id: "wake-original-user",
			username: "wake-original-user",
			passwordHash: "unused",
			createdAt: now,
		});
		await db.insert(users).values({
			id: "wake-answer-user",
			username: "wake-answer-user",
			passwordHash: "unused",
			createdAt: now,
		});
		await db.insert(narratorMessages).values({
			id: "wake-q-message",
			narratorId: SUB_ID,
			role: "assistant",
			contentJson: [],
			createdAt: now,
		});
		await db.insert(narratorToolCalls).values({
			id: "wake-q-call",
			narratorId: SUB_ID,
			messageId: "wake-q-message",
			toolUseId: "wake-q-use",
			toolName: "AskUserQuestion",
			inputJson: { async: true },
			status: "success",
			createdAt: now,
		});
		const { record } = await questions.createAsyncQuestion({
			narratorId: SUB_ID,
			toolCallId: "wake-q-call",
			toolUseId: "wake-q-use",
			executionPrincipal: { version: 1, userId: "wake-original-user" },
			questions: [{ question: "direction", header: "Which direction?", options: [] }],
		});
		const answer = await questions.answerAsyncQuestion(record.id, {
			answers: { direction: "keep compatibility" },
			userId: "wake-answer-user",
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) throw new Error("answer failed");
		expect(answer.record.answerMessageId).not.toBeNull();
		expect(resumePrincipals).toEqual([{ version: 1, userId: "wake-original-user" }]);
		expect(resumeCalls).toEqual([
			{
				subagentId: SUB_ID,
				intent: "continue_tool_results",
				actor: "parent_agent",
				prompt: undefined,
			},
		]);
		const row = sqlite
			.query(
				"SELECT narrator_id, role, created_by, content_text FROM narrator_messages WHERE id = ?",
			)
			.get(answer.record.answerMessageId ?? "");
		expect(row).toMatchObject({
			narrator_id: SUB_ID,
			role: "user",
			created_by: "wake-answer-user",
			content_text: expect.stringContaining("keep compatibility"),
		});
	});

	test("is resumed rather than run through the primary loop", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");

		expect(result.started).toBe(true);
		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0].subagentId).toBe(SUB_ID);
	});

	test("uses the intent that means 'the content is already in history'", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });

		await startInjectionContinuationIfPossible(SUB_ID, "en");

		// `continue_tool_results` rebuilds history from the rows and replays trailing tool
		// results — the resume counterpart of `runAgentLoop(active, "")`. `follow_up` would
		// be wrong: it demands a prompt and would persist a SECOND row saying "continue",
		// displacing the injection from the trailing position the history builders lift.
		expect(resumeCalls[0].intent).toBe("continue_tool_results");
		expect(resumeCalls[0].prompt).toBeUndefined();
	});

	test("is attributed to the agent side, because nobody typed this", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });

		await startInjectionContinuationIfPossible(SUB_ID, "en");

		expect(resumeCalls[0].actor).toBe("parent_agent");
	});

	test("reports not started when the resume itself declines", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		resumeStarted = false;

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
		expect(result.started).toBe(false);
	});
});

describe("a subagent that must not be woken", () => {
	test("plan mode is respected, mirroring the primary rule", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, {
			variant: "subagent:general",
			parent: PARENT_ID,
			traits: JSON.stringify(["plan"]),
		});

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
		expect(result.started).toBe(false);
		expect(resumeCalls).toEqual([]);
	});

	test("a resume already in flight is left to consume the row", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		activeResumeRuns.add(SUB_ID);

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
		expect(result.started).toBe(false);
		// Not merely "no second run": asking for one would be the race `resumeSubagent`
		// rejects, surfacing as a ValidationError in a producer that only sent a notice.
		expect(resumeCalls).toEqual([]);
	});

	test("a parentless subagent is not resumable, and says so instead of throwing", async () => {
		seedNarrator(SUB_ID, { variant: "subagent:general" });

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
		expect(result.started).toBe(false);
		expect(resumeCalls).toEqual([]);
	});

	test("a resume that throws is reported as not started, never propagated", async () => {
		// The row is already persisted when this runs. A producer notifying a subagent
		// must not fail because the subagent could not be woken — the content simply
		// waits for the next request.
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		resumeThrows = new Error("Archived subagents cannot be resumed");

		const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
		expect(result.started).toBe(false);
	});
});

describe("a primary narrator recipient", () => {
	test("never reaches the resume path", async () => {
		seedNarrator(PARENT_ID);

		// Whether the loop actually starts depends on runtime state this test does not
		// build; what must hold is that the subagent engine is not involved.
		await startInjectionContinuationIfPossible(PARENT_ID, "en").catch(() => undefined);

		expect(resumeCalls).toEqual([]);
	});
});
