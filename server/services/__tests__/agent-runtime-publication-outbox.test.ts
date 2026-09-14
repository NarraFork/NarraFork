import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";
import {
	createPublicationOutbox,
	type PublicationIntent,
	type PublicationRun,
} from "../agent-runtime/publication-outbox";

const { db, sqlite } = getTestDb();
const mailbox = createMailboxStore(db);
const publisher = createPublicationOutbox(db);
const time = "2026-09-09T00:00:00.000Z";
function run(key = "run"): PublicationRun {
	return { producerKind: "agent", taskId: "task", logicalRunId: key, recipientId: "recipient" };
}
function intent(
	key = "run",
	eventKind: PublicationIntent["eventKind"] = "completed",
): PublicationIntent {
	return { ...run(key), eventKind, summary: "done", resultRef: "tool-result:task" };
}
function reserve(key: string) {
	expect(publisher.reserveRunSlots(run(key), { started: true }).status).toBe("reserved");
}
function deleteRecipientForTest() {
	db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "recipient")).run();
	db.delete(narratorMessages).where(eq(narratorMessages.narratorId, "recipient")).run();
	db.delete(narrators).where(eq(narrators.id, "recipient")).run();
}
function fill() {
	for (let i = 0; i < L.noticePending; i++)
		mailbox.enqueue({
			kind: "task_notice",
			noticeKind: "agent",
			narratorId: "recipient",
			sourceKey: `old-${i}`,
			text: "old",
			projectedByteSize: 3,
		});
}
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values([
			{ id: "recipient", createdAt: time, updatedAt: time },
			{ id: "sender", createdAt: time, updatedAt: time },
		])
		.run();
});
afterAll(() => sqlite.close());

describe("transactional publication outbox", () => {
	test.each([
		"pending",
		"queued",
		"materialized",
		"cancelled",
	] as const)("existing publication identity wins over regenerated oversized summary (%s)", (state) => {
		reserve("dedupe-first");
		const first = publisher.commitIntent(intent("dedupe-first"));
		if (state !== "pending") publisher.transferNext("recipient", "agent");
		if (state === "cancelled") mailbox.cancel(first.deliveryId as string, "cancelled");
		if (state === "materialized") {
			const row = mailbox.claimBatch("recipient", { token: "t", epoch: "e" })[0];
			if (!row) throw new Error("Expected claimed notification");
			mailbox.materialize(
				{ id: row.id, narratorId: "recipient", token: "t", epoch: "e" },
				(tx, claimed) => {
					const messageId = claimed.recipientMessageId as string;
					tx.insert(narratorMessages)
						.values({
							id: messageId,
							narratorId: "recipient",
							role: "user",
							contentJson: [],
							createdAt: time,
						})
						.run();
					tx.insert(narratorMessageRefs)
						.values({ id: "notice-ref", narratorId: "recipient", messageId, seq: 1 })
						.run();
					return { messageId, refId: "notice-ref" };
				},
			);
		}
		const duplicate = publisher.commitIntent({
			...intent("dedupe-first"),
			summary: "x".repeat(L.publicationBytes + 1),
			resultRef: "x".repeat(1024),
		});
		expect(duplicate).toEqual({ ...first, status: "duplicate" });
		expect(() => publisher.commitIntent({ ...intent("dedupe-first"), logicalRunId: "" })).toThrow(
			"publication pointer",
		);
		expect(() =>
			publisher.commitIntent({
				...intent("dedupe-first"),
				eventKind: "" as PublicationIntent["eventKind"],
			}),
		).toThrow("event identity");
	});
	test("releaseUnusedRunSlots removes only matching reserved slots and participates in caller transaction", () => {
		reserve("release");
		reserve("other");
		publisher.commitIntent(intent("release", "started"));
		expect(() =>
			db.transaction((tx) => {
				expect(publisher.releaseUnusedRunSlots(run("release"), tx)).toBe(1);
				throw new Error("rollback");
			}),
		).toThrow("rollback");
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.filter((row) => row.logicalRunId === "release"),
		).toHaveLength(2);
		expect(publisher.releaseUnusedRunSlots(run("release"))).toBe(1);
		expect(publisher.listPending()).toHaveLength(1);
		expect(publisher.releaseUnusedRunSlots(run("release"))).toBe(0);
		publisher.failRecipient("recipient", "gone");
		expect(publisher.releaseUnusedRunSlots(run("release"))).toBe(0);
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.find((row) => row.logicalRunId === "release")?.state,
		).toBe("failed");
		expect(publisher.releaseUnusedRunSlots(run("other"))).toBe(2);
	});
	test("startup reserves capacity but not arrival order; actual event increments sequence", () => {
		reserve("unfinished");
		expect(db.select({ seq: narrators.inboxSequence }).from(narrators).get()?.seq).toBe(0);
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.every((row) => row.arrivalSeq === null),
		).toBe(true);
		mailbox.enqueue({
			kind: "agent_message",
			narratorId: "recipient",
			text: "report",
			projectedByteSize: 6,
			sourceNarratorId: "sender",
			sourceToolCallId: "tool",
			sourceAttempt: 1,
			sourceKey: "receipt",
		});
		reserve("finished");
		expect(publisher.commitIntent(intent("finished")).arrivalSeq).toBe(2);
		expect(publisher.transferNext("recipient", "agent").status).toBe("transferred");
		expect(
			mailbox.claimBatch("recipient", { token: "t", epoch: "e" }).map((row) => row.kind),
		).toEqual(["agent_message", "task_notice"]);
	});
	test("result+intent transaction failure leaves neither result nor event", () => {
		reserve("atomic");
		expect(() =>
			db.transaction((tx) => {
				tx.update(narrators)
					.set({ title: "durable-result" })
					.where(eq(narrators.id, "recipient"))
					.run();
				publisher.commitIntent(intent("atomic"), tx);
				throw new Error("atomic failure");
			}),
		).toThrow("atomic failure");
		expect(
			db.select({ title: narrators.title, seq: narrators.inboxSequence }).from(narrators).get(),
		).toEqual({ title: null, seq: 0 });
		expect(publisher.listPending()).toHaveLength(0);
		db.transaction((tx) => {
			tx.update(narrators)
				.set({ title: "durable-result" })
				.where(eq(narrators.id, "recipient"))
				.run();
			publisher.commitIntent(intent("atomic"), tx);
		});
		expect(publisher.listPending()).toHaveLength(1);
	});
	test("101st completion commits terminal result with a full inbox, then recovers without task rerun", () => {
		fill();
		reserve("blocked");
		let taskExecutions = 1;
		db.transaction((tx) => {
			tx.update(narrators)
				.set({ title: "terminal result" })
				.where(eq(narrators.id, "recipient"))
				.run();
			publisher.commitIntent(intent("blocked"), tx);
		});
		expect(publisher.transferNext("recipient", "agent").status).toBe("full");
		expect(db.select({ title: narrators.title }).from(narrators).get()?.title).toBe(
			"terminal result",
		);
		const restarted = createPublicationOutbox(db);
		expect(restarted.listPending()).toHaveLength(1);
		mailbox.cancel(mailbox.list("recipient")[0]?.deliveryId as string, "free capacity");
		expect(restarted.transferNext("recipient", "agent").status).toBe("transferred");
		expect(restarted.commitIntent(intent("blocked")).status).toBe("duplicate");
		expect(restarted.listPending()).toHaveLength(0);
		expect(taskExecutions).toBe(1);
		taskExecutions = 0;
	});
	test("earliest kind gets atomic capacity even when late publisher calls the fast path first", () => {
		fill();
		reserve("early");
		reserve("late");
		const early = publisher.commitIntent(intent("early"));
		const late = publisher.commitIntent(intent("late"));
		mailbox.cancel(mailbox.list("recipient")[0]?.deliveryId as string, "free one slot");
		// A late notification cannot bypass the outbox through ordinary mailbox enqueue.
		expect(
			mailbox.enqueue({
				kind: "task_notice",
				noticeKind: "agent",
				narratorId: "recipient",
				sourceKey: "bypass",
				text: "late",
				projectedByteSize: 4,
			}).status,
		).toBe("publication_pending");
		const transferred = publisher.transferNext("recipient", "agent");
		expect(transferred).toMatchObject({ status: "transferred", deliveryId: early.deliveryId });
		expect(publisher.transferNext("recipient", "agent").status).toBe("full");
		expect(mailbox.getByDelivery(late.deliveryId as string)).toBeUndefined();
		expect(mailbox.claimBatch("recipient", { token: "t", epoch: "e" }).length).toBeGreaterThan(0);
	});
	test("pending early event blocks later ordinary input but does not block older in-box events", () => {
		fill();
		reserve("early");
		publisher.commitIntent(intent("early"));
		mailbox.enqueue({
			kind: "agent_message",
			narratorId: "recipient",
			text: "late report",
			projectedByteSize: 11,
			sourceNarratorId: "sender",
			sourceToolCallId: "tool",
			sourceAttempt: 1,
			sourceKey: "receipt",
		});
		const batch = mailbox.claimBatch("recipient", { token: "t", epoch: "e" });
		expect(batch).toHaveLength(L.batchCount);
		expect(batch.every((row) => row.kind === "task_notice")).toBe(true);
	});
	test("started/completed distinguish events, new logical run distinguishes restart, recovery reuses run", () => {
		const logicalRunId = publisher.persistLogicalRun("recipient");
		expect(publisher.persistLogicalRun("recipient", { resumeRunId: logicalRunId })).toBe(
			logicalRunId,
		);
		reserve(logicalRunId);
		const started = publisher.commitIntent(intent(logicalRunId, "started"));
		const completed = publisher.commitIntent(intent(logicalRunId));
		expect(started.deliveryId).not.toBe(completed.deliveryId);
		expect(publisher.transferNext("recipient", "agent").deliveryId).toBe(
			started.deliveryId as string,
		);
		expect(publisher.transferNext("recipient", "agent").deliveryId).toBe(
			completed.deliveryId as string,
		);
		expect(publisher.commitIntent(intent(logicalRunId)).status).toBe("duplicate");
		const nextRun = publisher.persistLogicalRun("recipient");
		expect(nextRun).not.toBe(logicalRunId);
		expect(() => publisher.persistLogicalRun("recipient", { resumeRunId: logicalRunId })).toThrow(
			"Stale",
		);
		reserve(nextRun);
		expect(publisher.commitIntent(intent(nextRun)).status).toBe("committed");
	});
	test("cancelled transferred delivery remains duplicate after lost confirmation", () => {
		reserve("receipt");
		const result = publisher.commitIntent(intent("receipt"));
		publisher.transferNext("recipient", "agent");
		mailbox.cancel(result.deliveryId as string, "recipient discarded");
		expect(publisher.commitIntent(intent("receipt")).status).toBe("duplicate");
		expect(mailbox.getByDelivery(result.deliveryId as string)?.state).toBe("cancelled");
		expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(1);
	});
	test("recipient slot cap rejects new starts but reserved terminal still commits", () => {
		for (let i = 0; i < L.publicationRecipientSlots; i++)
			expect(publisher.reserveRunSlots(run(`capacity-${i}`)).status).toBe("reserved");
		expect(publisher.reserveRunSlots(run("overflow")).status).toBe("full");
		expect(publisher.commitIntent(intent("capacity-0")).status).toBe("committed");
		expect(publisher.transferNext("recipient", "agent").status).toBe("transferred");
		expect(publisher.reserveRunSlots(run("overflow")).status).toBe("reserved");
	});
	test("lost transfer acknowledgement and same-run reservation recovery cannot allocate new slots", () => {
		reserve("delivered");
		const committed = publisher.commitIntent(intent("delivered"));
		expect(() =>
			db.transaction((tx) => {
				publisher.transferNext("recipient", "agent", tx);
				throw new Error("commit lost");
			}),
		).toThrow("commit lost");
		expect(mailbox.getByDelivery(committed.deliveryId as string)).toBeUndefined();
		expect(publisher.listPending()).toHaveLength(1);
		publisher.transferNext("recipient", "agent");
		const before = db.select().from(runtimePublicationOutbox).all().length;
		reserve("delivered");
		expect(db.select().from(runtimePublicationOutbox).all()).toHaveLength(before);
	});
	test("recipient deleted before terminal commit still records a permanent failed intent", () => {
		reserve("deleted");
		deleteRecipientForTest();
		expect(publisher.commitIntent(intent("deleted"))).toMatchObject({
			status: "committed",
			arrivalSeq: null,
		});
		expect(publisher.listPending()).toHaveLength(0);
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.some((row) => row.eventKind === "completed" && row.state === "failed"),
		).toBe(true);
	});
	test.each([
		false,
		true,
	])("failRecipient preserves terminal reservation and atomically commits source result (deleted=%s)", (deleted) => {
		db.insert(narrators).values({ id: "source", createdAt: time, updatedAt: time }).run();
		reserve("running");
		publisher.commitIntent(intent("running", "started"));
		if (deleted) deleteRecipientForTest();
		expect(publisher.failRecipient("recipient", "recipient permanently unavailable")).toBe(2);
		const slots = db.select().from(runtimePublicationOutbox).all();
		expect(slots.find((row) => row.eventKind === "started")?.state).toBe("failed");
		expect(slots.find((row) => row.eventKind === "terminal")).toMatchObject({
			state: "reserved",
			arrivalSeq: null,
			lastError: "recipient permanently unavailable",
		});
		expect(publisher.failRecipient("recipient", "repeat")).toBe(0);
		db.transaction((tx) => {
			tx.update(narrators)
				.set({ title: "source terminal result" })
				.where(eq(narrators.id, "source"))
				.run();
			expect(publisher.commitIntent(intent("running"), tx)).toMatchObject({
				status: "committed",
				arrivalSeq: null,
			});
		});
		expect(
			db.select({ result: narrators.title }).from(narrators).where(eq(narrators.id, "source")).get()
				?.result,
		).toBe("source terminal result");
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.find((row) => row.eventKind === "completed"),
		).toMatchObject({
			state: "failed",
			summary: "done",
			resultRef: "tool-result:task",
			lastError: "recipient permanently unavailable",
		});
		expect(publisher.commitIntent(intent("running")).status).toBe("duplicate");
		expect(publisher.listPending()).toHaveLength(0);
	});
	test("failRecipient marks reserved pages without repeatedly selecting the first page", () => {
		for (let i = 0; i < L.pageSize + 1; i++) publisher.reserveRunSlots(run(`page-${i}`));
		expect(publisher.failRecipient("recipient", "gone")).toBe(L.pageSize);
		expect(publisher.failRecipient("recipient", "gone")).toBe(1);
		expect(publisher.failRecipient("recipient", "gone")).toBe(0);
		expect(publisher.commitIntent(intent(`page-${L.pageSize}`))).toMatchObject({
			status: "committed",
			arrivalSeq: null,
		});
	});
	test("global slot cap is bounded across recipients and does not read results", () => {
		const insert = sqlite.prepare(
			"INSERT INTO runtime_publication_outbox (id, producer_kind, task_id, logical_run_id, event_kind, recipient_id, delivery_id, dedupe_key, created_at, updated_at) VALUES (?, 'agent', 'task', ?, 'terminal', ?, ?, ?, ?, ?)",
		);
		sqlite.transaction(() => {
			for (let i = 0; i < L.publicationGlobalSlots; i++)
				insert.run(
					`slot-${i}`,
					`run-${i}`,
					`recipient-${i % 20}`,
					`delivery-${i}`,
					`dedupe-${i}`,
					time,
					time,
				);
		})();
		expect(publisher.reserveRunSlots(run("global-full")).status).toBe("full");
		const plan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id FROM narrator_buffered_messages WHERE narrator_id = 'recipient' AND kind = 'agent_message' AND state IN ('queued','claimed','failed') LIMIT 50",
			)
			.all() as Array<{ detail: string }>;
		expect(plan.some((row) => row.detail.includes("idx_nbm_quota"))).toBe(true);
	});
	test("outbox remains pointers only, bounded pages and permanent recipient failures are visible", () => {
		reserve("invalid");
		expect(() =>
			publisher.commitIntent({ ...intent("invalid"), summary: "x".repeat(L.publicationBytes) }),
		).toThrow("Metadata");
		expect(publisher.listPending()).toHaveLength(0);
		publisher.commitIntent(intent("invalid"));
		deleteRecipientForTest();
		expect(publisher.transferNext("recipient", "agent").status).toBe("recipient_failed");
		expect(publisher.listPending()).toHaveLength(0);
		expect(
			db
				.select()
				.from(runtimePublicationOutbox)
				.all()
				.some((row) => row.state === "failed" && row.lastError?.includes("deleted")),
		).toBe(true);
	});
});
