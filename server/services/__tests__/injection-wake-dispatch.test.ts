/**
 * injection-wake-dispatch.test.ts — how a `wakeIfIdle` injection starts a turn.
 *
 * `startInjectionContinuationIfPossible` is the wake half of `deliverInjection`'s
 * `schedule: "wakeIfIdle"`. There is one run entry for every session: a delegated
 * session is woken exactly like an ordinary one, and its result still reaches the tool
 * call its run registered (the registration, not the wake path, carries that).
 *
 * The assertions are about WHAT the one entry is asked to run — no new relationships,
 * empty text because the row is already in history, no borrowed principal — and about
 * refusals being refusals rather than exceptions: the injected row is already durable,
 * so "not started" costs immediacy while a throw would fail the producer that was only
 * trying to notify somebody.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
afterAll(() => fixture.close());
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	broadcastToNarrator: () => {},
}));

/**
 * Stand in for the run entry. Every wake — whatever created the session — starts its
 * turn through `startNarratorRun`; what matters here is only that the dispatch reaches
 * it with the right request and execution principal.
 */
interface RunCall {
	narratorId: string;
	text: string;
	binding: unknown;
	principal: unknown;
	sessionUser: string | null | undefined;
}
const runCalls: RunCall[] = [];
let runThrows: Error | null = null;
const runModule = await import("../agent-runtime/run");
const idle = Promise.resolve({
	started: true,
	output: "",
	finalText: "",
	hasError: false,
	interrupted: false,
	timedOut: false,
});
spyOn(runModule, "startNarratorRun").mockImplementation(async (request) => {
	runCalls.push({
		narratorId: request.narratorId,
		text: request.text,
		binding: request.binding,
		principal: request.principal,
		sessionUser: request.active?._currentUserId,
	});
	if (runThrows) throw runThrows;
	return { started: true, foreground: idle, terminal: idle, completion: idle };
});
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");

const { startInjectionContinuationIfPossible } = await import("../narrator-session");
// Preserve collaborator initialization order without unused/shadowed local bindings.
await import("../parent-inbound-queue");
await import("../bg-completion-queue");
await import("../agent-communication");
await import("../subagent-runner");
const { activeNarrators } = await import("../narrator-session-state");

const now = "2026-07-28T10:00:00.000Z";
const PARENT_ID = "wake-parent";
const SUB_ID = "wake-sub";

beforeEach(() => {
	cleanDb(sqlite);
	runCalls.length = 0;
	runThrows = null;
});
afterEach(() => {
	for (const id of [PARENT_ID, SUB_ID]) {
		getExecutionOwner(id)?.release();
		activeNarrators.delete(id);
	}
	cleanDb(sqlite);
});
afterAll(() => mock.restore());

async function waitUntil(predicate: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for the wake dispatch");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

function seedNarrator(
	id: string,
	options: {
		variant?: string;
		parent?: string;
		status?: string;
		traits?: string;
		/** The session's run delivers its result to this narrator's tool call. */
		deliverTo?: string;
	} = {},
) {
	sqlite
		.prepare(
			`INSERT INTO narrators (id, variant, parent_narrator_id, status, traits, cwd, runtime_registration_json, created_at, updated_at, last_stop_reason)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'normal')`,
		)
		.run(
			id,
			options.variant ?? "primary",
			options.parent ?? null,
			options.status ?? "idle",
			options.traits ?? "[]",
			process.env.HOME ?? "/",
			options.deliverTo
				? JSON.stringify({
						version: 1,
						run: {
							logicalRunId: `${id}-run`,
							deliverTo: { narratorId: options.deliverTo, toolUseId: "toolu_x" },
						},
					})
				: null,
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
		seedNarrator(PARENT_ID, { status: "working" });
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID });
		// The run finalizer attributes a detached result notice to the run's principal.
		recordTaskNoticeUser(SUB_ID, "A");
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

describe("an async question answer", () => {
	test("persists to the recipient and wakes it as the question's own principal", async () => {
		seedNarrator(PARENT_ID);
		seedNarrator(SUB_ID, { variant: "subagent:general", parent: PARENT_ID, deliverTo: PARENT_ID });
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
		// Seed the open question row directly: this suite is about WAKE DISPATCH after
		// an answer, not about whether a subagent may call AskUserQuestion (runtime
		// policy currently disables that capability for subagents).
		const { narratorQuestions } = await import("../../db/schema");
		const questionId = "wake-q-record";
		await db.insert(narratorQuestions).values({
			id: questionId,
			narratorId: SUB_ID,
			toolCallId: "wake-q-call",
			toolUseId: "wake-q-use",
			// Stored shape is the coerced advertised form; answers are keyed by header.
			questionsJson: [{ id: "direction", header: "Which direction?", options: [] }],
			executionPrincipalJson: { version: 1, userId: "wake-original-user" },
			status: "open",
			origin: "agent_async",
			createdAt: now,
		});
		const answer = await questions.answerAsyncQuestion(questionId, {
			// Model-facing answers are keyed by question header.
			answers: { "Which direction?": "keep compatibility" },
			userId: "wake-answer-user",
			locale: "en",
		});
		expect(answer.ok).toBe(true);
		if (!answer.ok) throw new Error("answer failed");
		expect(answer.record.answerMessageId).not.toBeNull();
		await waitUntil(() => runCalls.length > 0);
		// The run executes as the principal that asked, never as the answering user, and
		// starts with empty text because the answer is already in history.
		expect(runCalls).toEqual([
			expect.objectContaining({ narratorId: SUB_ID, text: "", sessionUser: "wake-original-user" }),
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
});

/*
 * A delegated session is an ordinary session whose run delivers to a tool call. Its
 * wake goes through the one run entry like any other session's; the registration (not
 * the parent link or variant) carries where the result goes. Both shapes run below.
 */
const shapes = [
	{
		name: "delegated",
		seed: () =>
			seedNarrator(SUB_ID, {
				variant: "subagent:general",
				parent: PARENT_ID,
				deliverTo: PARENT_ID,
			}),
	},
	{ name: "unrelated", seed: () => seedNarrator(SUB_ID, { deliverTo: PARENT_ID }) },
] as const;

for (const shape of shapes) {
	describe(`an idle ${shape.name} recipient`, () => {
		test("is woken through the one run entry and keeps its registered destination", async () => {
			seedNarrator(PARENT_ID);
			shape.seed();

			const result = await startInjectionContinuationIfPossible(SUB_ID, "en");

			expect(result.started).toBe(true);
			await waitUntil(() => runCalls.length > 0);
			expect(runCalls).toHaveLength(1);
			expect(runCalls[0].narratorId).toBe(SUB_ID);
			// No new relationships: the run still owes its result to the registered call.
			expect(runCalls[0].binding).toBeUndefined();
		});

		test("starts with empty text, because the content is already in history", async () => {
			seedNarrator(PARENT_ID);
			shape.seed();

			await startInjectionContinuationIfPossible(SUB_ID, "en");
			await waitUntil(() => runCalls.length > 0);

			// A synthetic "continue" row would displace the injection from the trailing
			// position the history builders lift.
			expect(runCalls[0].text).toBe("");
		});

		test("does not borrow the related session's principal, because nobody typed this", async () => {
			seedNarrator(PARENT_ID);
			shape.seed();
			activeNarrators.set(PARENT_ID, { _currentUserId: "parent-user" } as never);

			await startInjectionContinuationIfPossible(SUB_ID, "en");
			await waitUntil(() => runCalls.length > 0);

			expect(runCalls[0].principal).toBeUndefined();
			expect(runCalls[0].sessionUser).not.toBe("parent-user");
		});

		test("a run already owning the session is left to consume the row", async () => {
			seedNarrator(PARENT_ID);
			shape.seed();
			tryClaimExecution(SUB_ID, "run");

			const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
			expect(result.started).toBe(false);
			// Not merely "no second run": asking for one would race the current owner.
			expect(runCalls).toEqual([]);
		});

		test("plan mode is respected, the same rule for every session", async () => {
			seedNarrator(PARENT_ID);
			shape.seed();
			sqlite.run("UPDATE narrators SET traits = ? WHERE id = ?", [
				JSON.stringify(["plan"]),
				SUB_ID,
			]);

			const result = await startInjectionContinuationIfPossible(SUB_ID, "en");
			expect(result.started).toBe(false);
			expect(runCalls).toEqual([]);
		});

		test("a run start that throws is reported, never propagated to the producer", async () => {
			// The row is already persisted when this runs. A producer notifying a session
			// must not fail because the session could not be woken.
			seedNarrator(PARENT_ID);
			shape.seed();
			runThrows = new Error("Archived narrators cannot run");

			await expect(await startInjectionContinuationIfPossible(SUB_ID, "en")).toBeDefined();
			await waitUntil(() => runCalls.length > 0);
			await waitUntil(() =>
				String(
					(
						sqlite.query("SELECT substatus FROM narrators WHERE id = ?").get(SUB_ID) as {
							substatus: string | null;
						} | null
					)?.substatus,
				).includes("error"),
			);
		});
	});
}

describe("a session with no relationship at all", () => {
	test("is woken through the same entry", async () => {
		seedNarrator(PARENT_ID);

		const result = await startInjectionContinuationIfPossible(PARENT_ID, "en");
		expect(result.started).toBe(true);
		await waitUntil(() => runCalls.length > 0);
		expect(runCalls[0]).toMatchObject({ narratorId: PARENT_ID, text: "" });
	});
});
