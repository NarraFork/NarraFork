import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));

const { eventBus } = await import("../../lib/event-bus");
const { awaitTool } = await import("../../lib/agent/tools/await");
const { awaitAnyRuntimeEvent, formatAwaitWakeResult } = await import(
	"../agent-runtime/await-coordinator"
);
const { notifyAwaitWake } = await import("../agent-runtime/await-wake");
const { listInboxRows, runtimeInbox } = await import("../agent-runtime/inbox");

const PARENT = "await-coordinator-parent";
const SOURCE = "await-coordinator-source";

function waitForAny(timeoutMs = 1_000) {
	const controller = new AbortController();
	return {
		controller,
		promise: awaitAnyRuntimeEvent({
			narratorId: PARENT,
			timeoutMs,
			signal: controller.signal,
		}),
	};
}

async function seedMailbox(): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: PARENT, variant: "primary", createdAt: now, updatedAt: now },
		{
			id: SOURCE,
			variant: "subagent:general",
			parentNarratorId: PARENT,
			createdAt: now,
			updatedAt: now,
		},
	]);
	runtimeInbox.enqueue({
		kind: "agent_message",
		narratorId: PARENT,
		text: "durable message",
		projectedByteSize: Buffer.byteLength("durable message"),
		sourceNarratorId: SOURCE,
		sourceToolCallId: "source-call",
		sourceAttempt: 1,
		sourceKey: "send",
	});
}

afterAll(() => {
	mock.module("../../db", () => realDb);
	mock.restore();
});

afterEach(() => cleanDb(sqlite));

describe("awaitAnyRuntimeEvent", () => {
	test("the Await tool defaults to any-event mode without resolving its selector", async () => {
		const signal = new AbortController().signal;
		const waiting = awaitTool.execute({ type: "bash", id: "not-a-real-task" }, {
			narratorId: PARENT,
			signal,
			currentToolUseId: "await-tool-any",
		} as never);
		eventBus.emit({
			type: "background_task:completed",
			taskId: "task-any",
			parentNarratorId: PARENT,
			taskType: "bash",
			output: "ignored from the bounded summary",
		});
		const result = await waiting;
		expect(result.metadata).toMatchObject({
			kind: "await",
			awaitMode: "any",
			eventSource: "background_task_terminal",
			taskId: "task-any",
		});
		expect(result.output).toContain("background_task_terminal");
		expect(result.output).not.toContain("ignored from the bounded summary");
	});

	test("releases on a child completion event in the caller's team", async () => {
		const { promise } = waitForAny();
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: "child-1",
			parentNarratorId: PARENT,
			toolUseId: "tool-1",
		});
		expect(await promise).toEqual({
			status: "event",
			event: { source: "subagent_completed", narratorId: PARENT, targetId: "child-1" },
		});
	});

	test("releases on a caller-owned background task terminal event", async () => {
		const { promise } = waitForAny();
		eventBus.emit({
			type: "background_task:failed",
			taskId: "task-1",
			parentNarratorId: PARENT,
			taskType: "bash",
			error: "boom",
			status: "failed",
		});
		expect(await promise).toMatchObject({
			status: "event",
			event: {
				source: "background_task_terminal",
				narratorId: PARENT,
				taskId: "task-1",
				taskType: "bash",
			},
		});
	});

	test("ignores unrelated events and intermediate output until abort", async () => {
		const { promise } = waitForAny(500);
		eventBus.emit({
			type: "background_task:output",
			taskId: "task-1",
			parentNarratorId: PARENT,
			chunk: "still running",
		});
		eventBus.emit({
			type: "narrator:subagent_completed",
			narratorId: "other-child",
			parentNarratorId: "other-parent",
			toolUseId: "tool-other",
		});
		const result = await promise;
		expect(result.status).toBe("timeout");
	});

	test("rechecks durable mailbox state after listeners are installed", async () => {
		await seedMailbox();
		const { promise } = waitForAny();
		expect(await promise).toEqual({
			status: "event",
			event: { source: "mailbox_pending", narratorId: PARENT, mailboxKind: "agent_message" },
		});
	});

	test("mailbox wake only releases the wait and leaves the row queued", async () => {
		await seedMailbox();
		const { promise } = waitForAny();
		notifyAwaitWake(PARENT, "agent_message");
		expect(await promise).toMatchObject({
			status: "event",
			event: { source: "mailbox_pending", mailboxKind: "agent_message" },
		});
		expect(listInboxRows(PARENT, ["agent_message"])).toHaveLength(1);
	});
});

describe("formatAwaitWakeResult", () => {
	test("uses bounded event summaries without copying notification bodies", () => {
		const text = formatAwaitWakeResult({
			status: "event",
			event: {
				source: "mailbox_pending",
				narratorId: PARENT,
				mailboxKind: "task_notice",
			},
		});
		expect(text).toContain("mailbox_pending");
		expect(text).toContain("next safe input boundary");
		expect(text).not.toContain("durable message");
	});
});
