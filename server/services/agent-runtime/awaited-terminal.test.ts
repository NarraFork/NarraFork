import { afterAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	runtimeAwaitedTerminalConsumptions as consumptions,
	narratorBufferedMessages as mailboxRows,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	runtimePublicationOutbox as outboxRows,
} from "../../db/schema";
import { createMailboxStore } from "./mailbox";
import { createPublicationOutbox, type PublicationRun } from "./publication-outbox";

const { db, sqlite } = getTestDb();
const mailbox = createMailboxStore(db);
let publisher = createPublicationOutbox(db);
const time = "2026-10-02T00:00:00.000Z";
const run: PublicationRun = {
	producerKind: "agent",
	taskId: "task",
	logicalRunId: "run",
	recipientId: "parent",
};
function commit(source = run, eventKind: "started" | "completed" = "completed") {
	return publisher.commitIntent({
		...source,
		eventKind,
		resultRef: "source:result",
		summary: "result",
	});
}
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values([
			{ id: "parent", createdAt: time, updatedAt: time },
			{ id: "other", createdAt: time, updatedAt: time },
		])
		.run();
	publisher = createPublicationOutbox(db);
});
afterAll(() => sqlite.close());

test("Await before deferred commit is durable across store recreation, reservation retry and mailbox GC", () => {
	publisher.reserveRunSlots(run);
	publisher.consumeAwaitedTerminal(run);
	publisher.consumeAwaitedTerminal(run);
	expect(db.select().from(consumptions).all()).toHaveLength(1);
	expect(db.select().from(outboxRows).all()).toHaveLength(0);
	publisher = createPublicationOutbox(db);
	publisher.reserveRunSlots(run);
	expect(commit()).toEqual({ status: "duplicate", arrivalSeq: null, deliveryId: null });
	expect(publisher.transferNext("parent", "agent").status).toBe("empty");
	db.delete(mailboxRows).run();
	expect(commit().status).toBe("duplicate");
	expect(db.select().from(outboxRows).all()).toHaveLength(0);
});

test.each([
	"agent",
	"bash",
] as const)("Await cancels pending/claimed %s terminal only, preserving started, Send, later run and other recipient", (producerKind) => {
	const source = { ...run, producerKind };
	const later = { ...source, logicalRunId: "later" };
	const other = { ...source, recipientId: "other" };
	publisher.reserveRunSlots(source, { started: true });
	publisher.reserveRunSlots(later);
	publisher.reserveRunSlots(other);
	commit(source, "started");
	commit(source);
	commit(later);
	commit(other);
	publisher.transferNext("parent", producerKind);
	publisher.transferNext("parent", producerKind);
	publisher.transferNext("parent", producerKind);
	publisher.transferNext("other", producerKind);
	mailbox.enqueue({
		kind: "agent_message",
		narratorId: "parent",
		sourceNarratorId: "other",
		sourceToolCallId: "send",
		sourceAttempt: 1,
		sourceKey: "send",
		text: "send",
		projectedByteSize: 4,
	});
	const claims = mailbox.claimBatch("parent", { token: "t", epoch: "e" });
	publisher.consumeAwaitedTerminal(source);
	const rows = db.select().from(mailboxRows).all();
	expect(rows.filter((row) => row.state === "cancelled")).toHaveLength(1);
	const cancelled = rows.find((row) => row.state === "cancelled");
	expect(cancelled?.text).toBe("");
	expect(cancelled?.claimToken).toBeNull();
	expect(cancelled?.byteSize).toBe(0);
	const stale = claims.find((row) => row.id === cancelled?.id);
	if (!stale) throw new Error("terminal should have been claimed");
	let called = false;
	expect(() =>
		mailbox.materialize({ id: stale.id, narratorId: "parent", token: "t", epoch: "e" }, () => {
			called = true;
			throw new Error("must not run");
		}),
	).toThrow("Stale mailbox claim");
	expect(called).toBe(false);
	expect(rows.filter((row) => row.state !== "cancelled")).toHaveLength(4);
});

test("receipt identity is the exact four-tuple and suppresses every terminal outcome", () => {
	publisher.reserveRunSlots(run);
	publisher.consumeAwaitedTerminal(run);
	for (const eventKind of ["completed", "failed", "timed_out", "cancelled"] as const) {
		expect(
			publisher.commitIntent({ ...run, eventKind, resultRef: "result", summary: "done" }).status,
		).toBe("duplicate");
	}
	for (const other of [
		{ ...run, producerKind: "bash" as const },
		{ ...run, taskId: "other-task" },
		{ ...run, logicalRunId: "other-run" },
		{ ...run, recipientId: "other" },
	]) {
		publisher.reserveRunSlots(other);
		expect(commit(other).status).toBe("committed");
	}
});

test("pending outbox terminal is removed without touching started publication", () => {
	publisher.reserveRunSlots(run, { started: true });
	commit(run, "started");
	commit();
	publisher.consumeAwaitedTerminal(run);
	expect(
		db
			.select()
			.from(outboxRows)
			.all()
			.map((row) => row.eventKind),
	).toEqual(["started"]);
	publisher.transferNext("parent", "agent");
	expect(db.select().from(mailboxRows).all()).toHaveLength(1);
});

test("Await consumption does not alter the producer's durable result", () => {
	const text = "complete producer result";
	db.insert(narratorMessages)
		.values({
			id: "result-source",
			narratorId: "other",
			role: "assistant",
			contentText: text,
			contentJson: [{ type: "text", text }],
			createdAt: time,
		})
		.run();
	publisher.reserveRunSlots(run);
	publisher.commitIntent({
		...run,
		eventKind: "completed",
		resultRef: "message:result-source",
		summary: "short summary",
	});
	const before = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.id, "result-source"))
		.get();
	publisher.consumeAwaitedTerminal(run);
	expect(
		db.select().from(narratorMessages).where(eq(narratorMessages.id, "result-source")).get(),
	).toEqual(before);
});

test("materialized UI history and its receipt survive Await", () => {
	publisher.reserveRunSlots(run);
	commit();
	publisher.transferNext("parent", "agent");
	const claimed = mailbox.claimBatch("parent", { token: "t", epoch: "e" })[0];
	if (!claimed) throw new Error("missing claim");
	mailbox.materialize(
		{ id: claimed.id, narratorId: "parent", token: "t", epoch: "e" },
		(tx, row) => {
			const messageId = row.recipientMessageId as string;
			tx.insert(narratorMessages)
				.values({
					id: messageId,
					narratorId: "parent",
					role: "user",
					contentJson: [],
					createdAt: time,
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: "ref", narratorId: "parent", messageId, seq: 0 })
				.run();
			return { messageId, refId: "ref" };
		},
	);
	const before = db.select().from(mailboxRows).all();
	publisher.consumeAwaitedTerminal(run);
	expect(db.select().from(mailboxRows).all()).toEqual(before);
	expect(db.select().from(narratorMessageRefs).all()).toHaveLength(1);
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
});

test("consumption rolls back atomically and cleanup follows only recipient lifetime", () => {
	publisher.reserveRunSlots(run);
	expect(() =>
		db.transaction((tx) => {
			publisher.consumeAwaitedTerminal(run, tx);
			throw new Error("rollback");
		}),
	).toThrow("rollback");
	expect(db.select().from(consumptions).all()).toHaveLength(0);
	expect(commit().status).toBe("committed");
	publisher.consumeAwaitedTerminal(run);
	publisher.releaseUnusedRunSlots(run);
	expect(db.select().from(consumptions).all()).toHaveLength(1);
	db.delete(narrators).where(eq(narrators.id, "parent")).run();
	expect(db.select().from(consumptions).all()).toHaveLength(0);
	expect(() => publisher.consumeAwaitedTerminal(run)).not.toThrow();
	expect(commit().status).toBe("duplicate");
});
