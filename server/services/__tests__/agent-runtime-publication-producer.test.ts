import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const { backgroundTaskService: tasks } = await import("../background-task-service");
const { runtimePublication: publisher, createRuntimePublicationService } = await import(
	"../agent-runtime/publication"
);
publisher.stop(); // Tests explicitly step the production worker; no clock races.
tasks.setBroadcastFnForTests(() => {});
const mailbox = createMailboxStore(db);
const time = "2026-09-09T00:00:00.000Z";
function pending(kind: "agent" | "bash") {
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(
			and(
				eq(narratorBufferedMessages.narratorId, "parent"),
				eq(narratorBufferedMessages.noticeKind, kind),
				eq(narratorBufferedMessages.state, "queued"),
			),
		)
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
}
function fill(kind: "agent" | "bash") {
	for (let i = 0; i < L.noticePending; i++)
		mailbox.enqueue({
			kind: "task_notice",
			noticeKind: kind,
			narratorId: "parent",
			sourceKey: `old-${kind}-${i}`,
			text: "old",
			projectedByteSize: 3,
		});
}
async function startBash(id: string) {
	return tasks.createBashTask({ id, parentNarratorId: "parent", command: "true", alias: id });
}
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values([
			{ id: "parent", createdAt: time, updatedAt: time },
			{
				id: "child",
				parentNarratorId: "parent",
				variant: "subagent:general",
				createdAt: time,
				updatedAt: time,
			},
		])
		.run();
});
afterAll(() => {
	publisher.stop();
	sqlite.close();
	mock.restore();
});

describe("real task producers use publication outbox", () => {
	test("101st Bash completion is terminal while full mailbox retains its intent and immutable source", async () => {
		fill("bash");
		await startBash("last");
		expect(await tasks.markCompleted("last", "complete result")).toBe(true);
		expect((await tasks.getById("last"))?.status).toBe("completed");
		publisher.flushRecipient("parent");
		expect(pending("bash")).toHaveLength(100);
		const [intent] = db.select().from(runtimePublicationOutbox).all();
		expect(intent.state).toBe("pending");
		expect(intent.resultRef).toBe(
			`background_task:last:${(await tasks.getById("last"))?.logicalRunId}`,
		);
		expect((await tasks.getById("last"))?.output).toBe("complete result");
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
		expect(intent.summary).not.toContain("complete result");
	});

	test("late completion cannot steal the only released slot from earlier intent", async () => {
		fill("bash");
		await startBash("early");
		await tasks.markCompleted("early", "earlier");
		publisher.flushRecipient("parent");
		mailbox.cancel(pending("bash")[0].deliveryId ?? "", "free one slot");
		await startBash("late");
		await tasks.markCompleted("late", "later");
		publisher.flushRecipient("parent");
		const fresh = pending("bash").filter((row) => row.metadataJson);
		expect(fresh).toHaveLength(1);
		expect(JSON.parse(fresh[0].metadataJson ?? "{}").taskId).toBe("early");
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.map((row) => row.taskId),
		).toEqual(["late"]);
	});

	test("result plus publication rollback as one transaction and retry never reruns source task", async () => {
		await startBash("atomic");
		sqlite.exec(
			"CREATE TRIGGER publication_fault BEFORE UPDATE ON runtime_publication_outbox WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'publication fault'); END;",
		);
		try {
			await expect(tasks.markCompleted("atomic", "output")).rejects.toThrow("publication fault");
		} finally {
			sqlite.exec("DROP TRIGGER publication_fault");
		}
		expect((await tasks.getById("atomic"))?.status).toBe("running");
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
		expect(await tasks.markCompleted("atomic", "output")).toBe(true);
		expect(await tasks.markCompleted("atomic", "MUST NOT REPLACE")).toBe(false);
		publisher.flushRecipient("parent");
		publisher.flushRecipient("parent");
		expect(pending("bash")).toHaveLength(1);
		expect((await tasks.getById("atomic"))?.output).toBe("output");
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
	});

	test.each([
		"failed",
		"timeout",
		"cancelled",
	] as const)("actual %s producer retains distinct event identity", async (status) => {
		await startBash(status);
		if (status === "failed") await tasks.markFailed(status, "failure");
		if (status === "timeout") await tasks.markTimedOut(status, "deadline");
		if (status === "cancelled") await tasks.markCancelled(status);
		publisher.flushRecipient("parent");
		expect(JSON.parse(pending("bash")[0].metadataJson ?? "{}").eventKind).toBe(
			status === "timeout" ? "timed_out" : status,
		);
		expect(await tasks.markCompleted(status, "late success")).toBe(false);
	});

	test("new Agent logical runs preserve old source and planned recovery reuses its reservation", async () => {
		const first = publisher.startAgentRun({ narratorId: "child", parentNarratorId: "parent" });
		await tasks.createAgentTask({
			id: "child",
			subagentNarratorId: "child",
			parentNarratorId: "parent",
			subagentType: "general",
		});
		await tasks.markCompleted("child", "first result");
		const oldIntent = db.select().from(runtimePublicationOutbox).all()[0];
		const second = publisher.startAgentRun({
			narratorId: "child",
			parentNarratorId: "parent",
			started: true,
		});
		expect(second.logicalRunId).not.toBe(first.logicalRunId);
		await tasks.createAgentTask({
			id: "child",
			subagentNarratorId: "child",
			parentNarratorId: "parent",
			subagentType: "general",
		});
		db.transaction((tx) =>
			publisher.commit(
				{
					...second,
					eventKind: "started",
					resultRef: `narrator:child:${second.logicalRunId}`,
					summary: "restarted",
				},
				tx,
			),
		);
		const restored = publisher.startAgentRun({
			narratorId: "child",
			parentNarratorId: "parent",
			resumeRunId: second.logicalRunId,
			started: true,
		});
		expect(restored).toEqual(second);
		await tasks.markCompleted("child", "second result");
		publisher.flushRecipient("parent");
		expect(pending("agent").map((row) => JSON.parse(row.metadataJson ?? "{}").eventKind)).toEqual([
			"completed",
			"started",
			"completed",
		]);
		expect(
			db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.id, oldIntent.resultRef?.slice(17) ?? ""))
				.get()?.contentText,
		).toBe("first result");
	});

	test("collapsed process scheduling recovers committed intents using a fresh worker without new tasks", async () => {
		await startBash("recovered");
		await tasks.markCompleted("recovered", "durable");
		const restartedWorker = createRuntimePublicationService(db);
		expect(restartedWorker.flushPage()).toBe(true);
		expect(restartedWorker.flushPage()).toBe(false);
		expect(pending("bash")).toHaveLength(1);
		expect(db.select().from(backgroundTasks).all()).toHaveLength(1);
		restartedWorker.stop();
	});

	test("Bash points to its normalized output and does not duplicate raw stdout", async () => {
		await startBash("large");
		await tasks.markCompleted("large", "x".repeat(2 * 1024 * 1024));
		const task = await tasks.getById("large");
		expect(Buffer.byteLength(task?.output ?? "")).toBeLessThan(5120);
		expect(task?.output).toContain("toolcall_");
		expect(task?.outputTruncated).toBe(true);
		expect(task?.output).toContain("No Await is needed");
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
	});

	test("Agent retains full source and stores only a bounded immutable display receipt", async () => {
		publisher.startAgentRun({ narratorId: "child", parentNarratorId: "parent" });
		await tasks.createAgentTask({
			id: "child",
			subagentNarratorId: "child",
			parentNarratorId: "parent",
			subagentType: "general",
		});
		const text = "result".repeat(150000);
		db.insert(narratorMessages)
			.values({
				id: "assistant-result",
				narratorId: "child",
				role: "assistant",
				contentJson: [{ type: "text", text }],
				contentText: text,
				createdAt: time,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: "assistant-ref", narratorId: "child", messageId: "assistant-result", seq: 1 })
			.run();
		await tasks.markCompleted("child", text);
		expect(db.select().from(narratorMessages).all()).toHaveLength(2);
		const pointer = db.select().from(runtimePublicationOutbox).all()[0].resultRef ?? "";
		expect(pointer).toStartWith("message-original:publication-result:");
		const receipt = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, pointer.slice(17)))
			.get();
		expect(receipt?.contentText?.length).toBe(12001);
		expect(
			(receipt?.contentJson as Array<{ publicationResult: unknown }>)[0].publicationResult,
		).toMatchObject({ sourceResultRef: "message:assistant-result", truncated: true });
	});

	test("Agent with no result message has a UTF8 bounded explicit fallback", async () => {
		publisher.startAgentRun({ narratorId: "child", parentNarratorId: "parent" });
		await tasks.createAgentTask({
			id: "child",
			subagentNarratorId: "child",
			parentNarratorId: "parent",
			subagentType: "general",
		});
		const text = "故障".repeat(50000);
		await tasks.markFailed("child", text);
		const fallback = db.select().from(narratorMessages).all()[0];
		expect(Buffer.byteLength(fallback.contentText ?? "")).toBeLessThanOrEqual(64 * 1024);
		expect(fallback.contentText).not.toContain("�");
		expect(
			(fallback.contentJson as Array<{ publicationResult: unknown }>)[0].publicationResult,
		).toMatchObject({ truncated: true, originalBytes: Buffer.byteLength(text) });
	});

	test("Bash result retention does not reap an outbox or unadopted mailbox source", async () => {
		await startBash("retained");
		await tasks.markCompleted("retained", "result");
		db.update(backgroundTasks)
			.set({ completedAt: time })
			.where(eq(backgroundTasks.id, "retained"))
			.run();
		expect(await tasks.cleanupCompleted(0)).toBe(0);
		publisher.flushRecipient("parent");
		expect(await tasks.cleanupCompleted(0)).toBe(0);
		db.update(narratorBufferedMessages)
			.set({ state: "materialized", adoptedAt: new Date().toISOString() })
			.run();
		expect(await tasks.cleanupCompleted(0)).toBe(1);
	});

	test("quota rejection happens before creating a new task or consuming arrival sequence", async () => {
		for (let i = 0; i < L.publicationRecipientSlots; i++) await startBash(`reserved-${i}`);
		expect(
			db
				.select({ inboxSequence: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, "parent"))
				.get()?.inboxSequence,
		).toBe(0);
		await expect(startBash("rejected")).rejects.toThrow("publication capacity");
		expect(await tasks.getById("rejected")).toBeNull();
	});
});
