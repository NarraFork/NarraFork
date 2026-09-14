import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
} from "../../db/schema";
import { MAILBOX_LIMITS as L } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";
import type {
	EnqueueResult,
	MailboxClaim,
	MailboxInput,
	MailboxRow,
	RuntimeTx,
} from "../agent-runtime/mailbox-types";
import { createPublicationOutbox } from "../agent-runtime/publication-outbox";

const { db, sqlite } = getTestDb();
const store = createMailboxStore(db);
const time = "2026-09-09T00:00:00.000Z";
function input(
	key = "receipt",
	extra: Partial<Extract<MailboxInput, { kind: "agent_message" }>> = {},
): MailboxInput {
	return {
		kind: "agent_message",
		narratorId: "recipient",
		text: "same text",
		projectedByteSize: 40,
		sourceNarratorId: "sender",
		sourceToolCallId: "tool",
		sourceAttempt: 1,
		sourceKey: key,
		...extra,
	};
}
function accepted(result: EnqueueResult): MailboxRow {
	if (result.status !== "accepted" && result.status !== "duplicate") throw new Error(result.status);
	return result.delivery;
}
function claim(row: MailboxRow): MailboxClaim {
	return {
		id: row.id,
		narratorId: row.narratorId,
		token: row.claimToken as string,
		epoch: row.claimEpoch as string,
	};
}
function persist(tx: RuntimeTx, row: MailboxRow) {
	const messageId = row.recipientMessageId as string;
	tx.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId: row.narratorId,
			role: "user",
			contentText: row.text,
			contentJson: [{ type: "text", text: row.text }],
			createdAt: time,
		})
		.run();
	const refId = `ref-${row.id}`;
	tx.insert(narratorMessageRefs)
		.values({ id: refId, narratorId: row.narratorId, messageId, seq: row.arrivalSeq as number })
		.run();
	return { messageId, refId };
}
function materializeOne() {
	const row = store.claimBatch("recipient", { token: "token", epoch: "epoch" })[0] as MailboxRow;
	return store.materialize(claim(row), persist) as MailboxRow;
}
beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["recipient", "sender", "fork"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
});
afterAll(() => sqlite.close());

describe("durable mailbox storage against generated migrations", () => {
	test("atomic head predicate sees the eligible head, never a priority input beyond pending publication", () => {
		const publisher = createPublicationOutbox(db);
		for (let i = 0; i < L.noticePending; i++)
			store.enqueue({
				kind: "task_notice",
				noticeKind: "agent",
				narratorId: "recipient",
				sourceKey: `old-notice-${i}`,
				text: "older completion",
				projectedByteSize: 16,
			});
		const run = {
			producerKind: "agent" as const,
			taskId: "finished-task",
			logicalRunId: "run",
			recipientId: "recipient",
		};
		publisher.reserveRunSlots(run);
		publisher.commitIntent({
			...run,
			eventKind: "completed",
			summary: "pending",
			resultRef: "task:finished",
		});
		expect(publisher.transferNext("recipient", "agent").status).toBe("full");
		const priority = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				text: "new principal input",
				projectedByteSize: 19,
				priority: true,
			}),
		);
		let validatedId: string | undefined;
		const rejected = store.claimEligibleHead(
			"recipient",
			{ token: "process:here:1", epoch: "owner" },
			(head) => {
				validatedId = head.id;
				return head.kind === "user_input";
			},
		);
		expect(rejected).toBeUndefined();
		expect(validatedId).not.toBe(priority.id);
		expect(store.getByDelivery(priority.deliveryId as string)?.state).toBe("queued");
		const claimed = store.claimEligibleHead(
			"recipient",
			{ token: "process:here:1", epoch: "owner" },
			(head) => {
				validatedId = head.id;
				return head.kind === "task_notice";
			},
		);
		expect(claimed?.id).toBe(validatedId as string);
		expect(claimed?.kind).toBe("task_notice");
		expect(claimed?.text).toBe("older completion");
	});
	test("failed display row does not block eligible queued input or permit skipping another kind", () => {
		const first = accepted(store.enqueue(input("failed-head")));
		for (let i = 0; i < L.claimMaxAttempts; i++) {
			const claimed = store.claimEligibleHead("recipient", {
				token: "token",
				epoch: "owner",
			}) as MailboxRow;
			store.failClaim(claim(claimed), "broken attachment");
		}
		expect(store.list("recipient")[0]).toMatchObject({ id: first.id, state: "failed" });
		const next = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				text: "next input",
				projectedByteSize: 10,
			}),
		);
		expect(
			store.claimEligibleHead(
				"recipient",
				{ token: "t", epoch: "e" },
				(head) => head.kind === "user_input",
			)?.id,
		).toBe(next.id);
		expect(store.getByDelivery(first.deliveryId as string)?.state).toBe("failed");
	});
	test("cold recovery restores foreign-process claims but never hot/current or unproven legacy owners", () => {
		for (const key of ["old", "current", "legacy"]) store.enqueue(input(key));
		const old = store.claimEligibleHead("recipient", {
			token: "process:old-instance:1",
			epoch: "old-owner",
		}) as MailboxRow;
		const current = store.claimEligibleHead("recipient", {
			token: "process:current-instance:1",
			epoch: "current-owner",
		}) as MailboxRow;
		const legacy = store.claimEligibleHead("recipient", {
			token: "old-unprefixed-token",
			epoch: "legacy-owner",
		}) as MailboxRow;
		const cold = createMailboxStore(db);
		expect(cold.recoverForeignProcessClaims("current-instance").recovered).toBe(1);
		expect(cold.getByDelivery(old.deliveryId as string)?.state).toBe("queued");
		expect(cold.getByDelivery(current.deliveryId as string)?.state).toBe("claimed");
		expect(cold.getByDelivery(legacy.deliveryId as string)?.state).toBe("claimed");
		expect(
			createMailboxStore(db).recoverForeignProcessClaims("current-instance", {
				legacyOwnerTerminated: () => false,
			}).recovered,
		).toBe(0);
		expect(
			cold.recoverForeignProcessClaims("current-instance", {
				legacyOwnerTerminated: (row) => row.claimEpoch === "legacy-owner",
			}).recovered,
		).toBe(1);
		const fresh = cold.claimEligibleHead("recipient", {
			token: "process:current-instance:2",
			epoch: "fresh-owner",
		}) as MailboxRow;
		expect(() => cold.materialize(claim(old), persist)).toThrow("Stale");
		expect(cold.getByDelivery(fresh.deliveryId as string)?.claimEpoch).toBe("fresh-owner");
		expect(() => cold.recoverForeignProcessClaims("current%instance")).toThrow("process identity");
	});
	test("claim recovery pages use claimed state/id index and exact cursor without reading payload", () => {
		for (let i = 0; i < L.pageSize + 1; i++)
			db.insert(narratorBufferedMessages)
				.values({
					id: `recovery-${String(i).padStart(3, "0")}`,
					narratorId: "recipient",
					text: "legacy",
					seq: i,
					bufferedAt: time,
					state: "claimed",
					claimToken: "process:previous:token",
					claimEpoch: "previous-epoch",
				})
				.run();
		const first = store.recoverForeignProcessClaims("here");
		expect(first.recovered).toBe(L.pageSize);
		expect(first.nextAfterId).toBeDefined();
		const second = store.recoverForeignProcessClaims("here", { afterId: first.nextAfterId });
		expect(second).toEqual({ recovered: 1, nextAfterId: undefined });
		const queryPlan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT id, claim_token FROM narrator_buffered_messages WHERE state='claimed' AND id > 'recovery-000' ORDER BY id LIMIT 101",
			)
			.all() as Array<{ detail: string }>;
		expect(queryPlan.some((row) => row.detail.includes("idx_nbm_claim_recovery"))).toBe(true);
	});
	test.each([
		"queued",
		"materialized",
		"cancelled",
	] as const)("same receipt wins over oversized retry payload and deleted sender (%s)", (state) => {
		const first = accepted(store.enqueue(input()));
		if (state === "materialized") materializeOne();
		if (state === "cancelled") store.cancel(first.deliveryId as string, "cancelled");
		db.delete(narrators).where(eq(narrators.id, "sender")).run();
		const retry = store.enqueue(
			input("receipt", {
				text: "x".repeat(L.agentBodyBytes + 1),
				projectedByteSize: L.agentProjectedBytes + 1,
				metadata: { wrapping: "x".repeat(L.metadataBytes + 1) },
			}),
		);
		expect(retry.status).toBe("duplicate");
		expect(accepted(retry)).toMatchObject({ deliveryId: first.deliveryId, state });
		expect(store.list("recipient")).toHaveLength(1);
		expect(() => store.enqueue(input("receipt", { sourceAttempt: 0 }))).toThrow("attempt");
		expect(() => store.enqueue(input("", { projectedByteSize: 0 }))).toThrow("identity");
	});
	test("first acceptance requires a source narrator and rejection does not reserve quota or sequence", () => {
		expect(() => store.enqueue(input("missing", { sourceNarratorId: "missing" }))).toThrow(
			"source narrator does not exist",
		);
		db.delete(narrators).where(eq(narrators.id, "sender")).run();
		expect(() => store.enqueue(input())).toThrow("source narrator does not exist");
		expect(store.list("recipient")).toHaveLength(0);
		expect(
			db
				.select({ seq: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, "recipient"))
				.get()?.seq,
		).toBe(0);
		db.transaction((tx) => {
			tx.insert(narrators).values({ id: "sender", createdAt: time, updatedAt: time }).run();
			expect(store.enqueue(input(), tx).status).toBe("accepted");
		});
	});
	test("exact receipt+attempt dedupe survives materialization and never compares text", () => {
		const first = accepted(store.enqueue(input()));
		expect(store.enqueue(input()).status).toBe("duplicate");
		expect(accepted(store.enqueue(input("other"))).deliveryId).not.toBe(first.deliveryId);
		expect(store.enqueue(input("receipt", { sourceAttempt: 2 })).status).toBe("accepted");
		const rows = store.claimBatch("recipient", { token: "token", epoch: "epoch" });
		for (const row of rows) store.materialize(claim(row), persist);
		expect(store.enqueue(input()).status).toBe("duplicate");
		expect(store.getByDelivery(first.deliveryId as string)?.text).toBe("");
		expect(db.select().from(narratorMessages).all()).toHaveLength(3);
	});
	test("enqueue returns a visible canonical TreeMessage and duplicate reuses every identity", () => {
		const history = {
			role: "user" as const,
			parentToolUseId: "parent-tool",
			contentJson: [{ type: "text", text: "canonical" }],
			contentText: "canonical",
			origin: "assistant" as const,
		};
		const firstResult = store.enqueue(input("tree", { history, text: "transport" }));
		expect(firstResult.status).toBe("accepted");
		if (firstResult.status !== "accepted") throw new Error("expected acceptance");
		expect(firstResult.message).toMatchObject({
			id: firstResult.delivery.currentMessageId,
			seq: expect.any(Number),
			deliveryId: firstResult.delivery.deliveryId,
			deliveryKind: "agent_message",
			deliveryState: "queued",
			role: "user",
			parentToolUseId: "parent-tool",
			children: [],
			toolCalls: [],
		});
		const duplicate = store.enqueue(input("tree", { history, text: "different transport" }));
		expect(duplicate.status).toBe("duplicate");
		if (duplicate.status !== "duplicate") throw new Error("expected duplicate");
		expect(duplicate.message?.id).toBe(firstResult.message?.id);
		expect(duplicate.message?.seq).toEqual(firstResult.message?.seq);
		expect(duplicate.message?.deliveryId).toBe(firstResult.delivery.deliveryId);
		expect(duplicate.message?.contentText).toBe("canonical");
	});
	test("queued user edit uses COW for a fork-shared message and keeps the recipient ref", () => {
		const row = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				requestKey: "cow-user",
				text: "before",
				projectedByteSize: 6,
			}),
		);
		db.insert(narratorMessageRefs)
			.values({
				id: "fork-ref",
				narratorId: "fork",
				messageId: row.currentMessageId as string,
				seq: 0,
			})
			.run();
		expect(store.editUser(row.deliveryId as string, { text: "after", projectedByteSize: 5 })).toBe(
			true,
		);
		const recipient = store.getByDelivery(row.deliveryId as string);
		expect(recipient?.currentMessageId).not.toBe(row.currentMessageId);
		expect(
			db
				.select({ contentText: narratorMessages.contentText })
				.from(narratorMessages)
				.where(eq(narratorMessages.id, row.currentMessageId as string))
				.get()?.contentText,
		).toBe("before");
		expect(
			db
				.select({ contentText: narratorMessages.contentText })
				.from(narratorMessages)
				.where(eq(narratorMessages.id, recipient?.currentMessageId as string))
				.get()?.contentText,
		).toBe("after");
		expect(
			db
				.select({ messageId: narratorMessageRefs.messageId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, "fork-ref"))
				.get()?.messageId,
		).toBe(row.currentMessageId as string);
	});
	test("queued COW materializes the current message identity", () => {
		const row = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				requestKey: "cow-materialize",
				text: "before",
				projectedByteSize: 6,
			}),
		);
		db.insert(narratorMessageRefs)
			.values({
				id: "fork-materialize-ref",
				narratorId: "fork",
				messageId: row.currentMessageId as string,
				seq: 0,
			})
			.run();
		expect(store.editUser(row.deliveryId as string, { text: "after", projectedByteSize: 5 })).toBe(
			true,
		);
		const edited = store.getByDelivery(row.deliveryId as string);
		if (!edited?.currentMessageId || !edited.recipientRefId)
			throw new Error("queued COW did not retain its current identity");
		const [claimed] = store.claimBatch("recipient", { token: "cow-token", epoch: "cow-epoch" });
		if (!claimed) throw new Error("queued COW was not claimable");
		const materialized = store.materialize(claim(claimed), () => {
			throw new Error("eager COW projection should not invoke the legacy materializer");
		});
		expect(materialized.state).toBe("materialized");
		expect(materialized.recipientMessageId).toBe(row.recipientMessageId);
		expect(materialized.currentMessageId).toBe(edited.currentMessageId);
		expect(
			db
				.select({ deliveryState: narratorMessageRefs.deliveryState })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, edited.recipientRefId))
				.get()?.deliveryState,
		).toBe("materialized");
	});
	test("cancelling a queued user removes its recipient ref but keeps the dedupe tombstone", () => {
		const row = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				requestKey: "cancel-user",
				text: "remove",
				projectedByteSize: 6,
			}),
		);
		expect(store.cancel(row.deliveryId as string, "removed")).toBe(true);
		expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({ state: "cancelled" });
		expect(db.select().from(narratorMessageRefs).all()).toHaveLength(0);
		expect(db.select().from(narratorMessages).all()).toHaveLength(0);
		expect(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				requestKey: "cancel-user",
				text: "different",
				projectedByteSize: 9,
			}).status,
		).toBe("duplicate");
	});
	test("acceptance rollback rolls counter and row back", () => {
		expect(() =>
			db.transaction((tx) => {
				store.enqueue(input(), tx);
				throw new Error("commit failed");
			}),
		).toThrow("commit failed");
		expect(store.list("recipient")).toHaveLength(0);
		expect(
			db
				.select({ seq: narrators.inboxSequence })
				.from(narrators)
				.where(eq(narrators.id, "recipient"))
				.get()?.seq,
		).toBe(0);
		expect(store.enqueue(input()).status).toBe("accepted");
	});
	test("eager projection is atomic and materialize never rewrites content", () => {
		const acceptedRow = accepted(store.enqueue(input()));
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
		expect(db.select().from(narratorMessageRefs).all()).toHaveLength(1);
		const row = store.claimBatch("recipient", { token: "token", epoch: "epoch" })[0] as MailboxRow;
		let callbackCalled = false;
		const before = db.select().from(narratorMessages).all()[0];
		const materialized = store.materialize(claim(row), () => {
			callbackCalled = true;
			throw new Error("materializer must not run for an eager projection");
		});
		expect(callbackCalled).toBe(false);
		expect(materialized.state).toBe("materialized");
		expect(db.select().from(narratorMessages).all()).toEqual([before]);
		expect(store.getByDelivery(acceptedRow.deliveryId as string)?.currentMessageId).toBe(
			acceptedRow.currentMessageId,
		);
	});
	test("existing persistence binding adopts the eager ref without inserting a second row", () => {
		store.enqueue(input());
		const row = store.claimBatch("recipient", { token: "token", epoch: "epoch" })[0] as MailboxRow;
		db.transaction((tx) => {
			store.materializeInTransaction(tx, claim(row), {
				messageId: row.recipientMessageId as string,
				refId: row.recipientRefId as string,
			});
		});
		expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("materialized");
		expect(db.select().from(narratorMessages).all()).toHaveLength(1);
		expect(db.select().from(narratorMessageRefs).all()).toHaveLength(1);
	});
	test("only terminated execution epoch can recover claims; stale owner cannot commit or clear", () => {
		store.enqueue(input());
		const old = store.claimBatch("recipient", {
			token: "old",
			epoch: "old-epoch",
		})[0] as MailboxRow;
		expect(store.recoverClaims("recipient", "other-epoch", { ownerTerminated: true })).toBe(0);
		expect(store.recoverClaims("recipient", "old-epoch", { ownerTerminated: true })).toBe(1);
		const current = store.claimBatch("recipient", {
			token: "new",
			epoch: "new-epoch",
		})[0] as MailboxRow;
		expect(() => store.materialize(claim(old), persist)).toThrow("Stale");
		expect(() => store.failClaim(claim(old), "stale finally")).toThrow("Stale");
		expect(store.recoverClaims("recipient", "old-epoch", { ownerTerminated: true })).toBe(0);
		expect(store.materialize(claim(current), persist)?.state).toBe("materialized");
	});
	test("failed agent retry preserves canonical identity and failed content", () => {
		const row = accepted(store.enqueue(input("failed-retry", { text: "failure body" })));
		const beforeMessageCount = db.select().from(narratorMessages).all().length;
		for (let retry = 0; retry < L.claimMaxAttempts; retry++) {
			const claimed = store.claimBatch(
				"recipient",
				{ token: "retry-token", epoch: `retry-${retry}` },
				{ count: 1 },
			)[0] as MailboxRow;
			store.failClaim(claim(claimed), "failed delivery");
		}
		const failed = store.getByDelivery(row.deliveryId as string);
		expect(failed).toMatchObject({ state: "failed", currentMessageId: row.currentMessageId });
		expect(
			db
				.select({ state: narratorMessageRefs.deliveryState })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.get()?.state,
		).toBe("failed");
		expect(store.retryFailed(row.deliveryId as string)).toBe(true);
		expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
			state: "queued",
			currentMessageId: row.currentMessageId,
		});
		expect(db.select().from(narratorMessages).all()).toHaveLength(beforeMessageCount);
		expect(db.select().from(narratorMessageRefs).all()).toHaveLength(1);
	});
	test("failed payloads retain quota, explicit cancellation keeps a negative receipt", () => {
		for (let i = 0; i < L.agentPending; i++) store.enqueue(input(`key-${i}`));
		for (let retry = 0; retry < L.claimMaxAttempts; retry++) {
			const row = store.claimBatch(
				"recipient",
				{ token: "token", epoch: "epoch" },
				{ count: 1 },
			)[0] as MailboxRow;
			store.failClaim(claim(row), "attachment failed");
		}
		expect(store.list("recipient", { state: "failed" })).toHaveLength(1);
		expect(store.enqueue(input("full")).status).toBe("full");
		const failed = store.list("recipient", { state: "failed" })[0];
		expect(store.cancel(failed?.deliveryId as string, "user abandoned")).toBe(true);
		expect(store.enqueue(input("key-0")).status).toBe("duplicate");
		expect(store.enqueue(input("full")).status).toBe("accepted");
	});
	test("ref delete leaves tombstone and cannot rematerialize old attempt", () => {
		store.enqueue(input());
		const row = materializeOne();
		db.transaction((tx) => {
			tx.delete(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.run();
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, { kind: "deleted" });
		});
		const duplicate = accepted(store.enqueue(input()));
		expect(duplicate.receiptDisposition).toBe("recipient_deleted");
		expect(duplicate.currentMessageId).toBeNull();
		expect(store.claimBatch("recipient", { token: "again", epoch: "new" })).toHaveLength(0);
		expect(store.collectTombstones([row.id], () => false)).toBe(0);
		expect(store.collectTombstones([row.id], () => true)).toBe(1);
	});
	test("stable COW ref preserves consumption; semantic edit cannot acknowledge the old revision", () => {
		store.enqueue(input());
		const row = materializeOne();
		expect(row.adoptedAt).toBeNull();
		expect(
			store.ackAdopted(row.deliveryId as string, "fork", row.recipientRefId as string, 1),
		).toBe(false);
		expect(
			store.ackAdopted(row.deliveryId as string, "recipient", row.recipientRefId as string, 2),
		).toBe(false);
		expect(
			store.ackAdopted(
				row.deliveryId as string,
				"recipient",
				row.recipientRefId as string,
				1,
				time,
			),
		).toBe(true);
		db.transaction((tx) => {
			tx.insert(narratorMessages)
				.values({
					id: "cow",
					narratorId: "recipient",
					role: "user",
					contentText: "same text",
					contentJson: [{ type: "text", text: "same text" }],
					createdAt: time,
				})
				.run();
			tx.update(narratorMessageRefs)
				.set({ messageId: "cow" })
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.run();
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, {
				kind: "cow",
				messageId: "cow",
			});
		});
		expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
			currentMessageId: "cow",
			adoptedAt: time,
			receiptDisposition: "active",
		});
		db.transaction((tx) =>
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, {
				kind: "semantic_edit",
				messageId: "cow",
			}),
		);
		expect(
			store.ackAdopted(row.deliveryId as string, "recipient", row.recipientRefId as string, 1),
		).toBe(false);
		expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBe(time);
		expect(
			db
				.select({ consumed: narratorMessageRefs.injectionConsumedAt })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.get()?.consumed,
		).toBeNull();
	});
	test.each([
		false,
		true,
	])("edited revision has independent durable adoption without rewriting original Send (adopted=%s)", (originalAdopted) => {
		store.enqueue(input());
		const row = materializeOne();
		const deliveryId = row.deliveryId as string;
		const refId = row.recipientRefId as string;
		if (originalAdopted)
			expect(store.ackAdopted(deliveryId, "recipient", refId, 1, time)).toBe(true);
		db.transaction((tx) =>
			store.updateRecipientRef(tx, "recipient", refId, {
				kind: "semantic_edit",
				messageId: row.currentMessageId as string,
			}),
		);
		expect(store.getByDelivery(deliveryId)).toMatchObject({
			contentRevision: 1,
			currentRevision: 2,
			currentAdoptedRevision: null,
			currentAdoptedAt: null,
			adoptedAt: originalAdopted ? time : null,
		});
		expect(store.ackCurrentRevision(deliveryId, "recipient", refId, 1)).toBe(false);
		expect(store.ackCurrentRevision(deliveryId, "fork", refId, 2)).toBe(false);
		expect(store.ackCurrentRevision(deliveryId, "recipient", "fork-ref", 2)).toBe(false);
		const coldStore = createMailboxStore(db);
		const editedAt = "2026-09-09T00:01:00.000Z";
		expect(coldStore.ackCurrentRevision(deliveryId, "recipient", refId, 2, editedAt)).toBe(true);
		expect(coldStore.getByDelivery(deliveryId)).toMatchObject({
			contentRevision: 1,
			receiptDisposition: "superseded",
			adoptedRevision: originalAdopted ? 1 : null,
			adoptedAt: originalAdopted ? time : null,
			currentRevision: 2,
			currentAdoptedRevision: 2,
			currentAdoptedAt: editedAt,
		});
		expect(
			db
				.select({ consumed: narratorMessageRefs.injectionConsumedAt })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, refId))
				.get()
				?.consumed?.toISOString(),
		).toBe(editedAt);
		expect(coldStore.ackAdopted(deliveryId, "recipient", refId, 1)).toBe(false);
		db.transaction((tx) =>
			store.updateRecipientRef(tx, "recipient", refId, {
				kind: "semantic_edit",
				messageId: row.currentMessageId as string,
			}),
		);
		expect(coldStore.ackCurrentRevision(deliveryId, "recipient", refId, 2)).toBe(false);
		expect(coldStore.getByDelivery(deliveryId)).toMatchObject({
			currentRevision: 3,
			currentAdoptedAt: null,
			adoptedAt: originalAdopted ? time : null,
		});
	});
	test("old reserved address resolves after COW via covering lookup and remains a deleted tombstone", () => {
		store.enqueue(input());
		const row = materializeOne();
		db.transaction((tx) => {
			tx.insert(narratorMessages)
				.values({
					id: "new-address",
					narratorId: "recipient",
					role: "user",
					contentJson: [],
					createdAt: time,
				})
				.run();
			tx.update(narratorMessageRefs)
				.set({ messageId: "new-address" })
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.run();
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, {
				kind: "cow",
				messageId: "new-address",
			});
		});
		expect(
			store.resolveReservedMessage("recipient", row.recipientMessageId as string),
		).toMatchObject({
			deliveryId: row.deliveryId,
			currentMessageId: "new-address",
			currentRevision: 1,
		});
		expect(store.resolveReservedMessage("fork", row.recipientMessageId as string)).toBeUndefined();
		const plan = sqlite
			.query(
				"EXPLAIN QUERY PLAN SELECT delivery_id FROM narrator_buffered_messages WHERE narrator_id = ? AND recipient_message_id = ? LIMIT 1",
			)
			.all("recipient", row.recipientMessageId as string) as Array<{ detail: string }>;
		expect(plan.some((part) => part.detail.includes("idx_nbm_reserved"))).toBe(true);
		db.transaction((tx) => {
			tx.delete(narratorMessageRefs)
				.where(eq(narratorMessageRefs.id, row.recipientRefId as string))
				.run();
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, { kind: "deleted" });
		});
		expect(
			store.resolveReservedMessage("recipient", row.recipientMessageId as string),
		).toMatchObject({ receiptDisposition: "recipient_deleted", currentMessageId: null });
		expect(
			store.ackCurrentRevision(
				row.deliveryId as string,
				"recipient",
				row.recipientRefId as string,
				1,
			),
		).toBe(false);
	});
	test("legal maximum body plus locale/reply prefix gets a single large batch, then notice progresses", () => {
		const text = "x".repeat(L.agentBodyBytes);
		for (const prefix of ["[来自代理] 回复：", "[From agent] Reply:"]) {
			const first = accepted(
				store.enqueue(input(prefix, { text, projectedByteSize: Buffer.byteLength(prefix + text) })),
			);
			store.enqueue({
				kind: "task_notice",
				noticeKind: "bash",
				narratorId: "recipient",
				sourceKey: prefix,
				text: "done",
				projectedByteSize: 20,
			});
			const batch = store.claimBatch("recipient", { token: "t", epoch: "e" });
			expect(batch).toHaveLength(1);
			expect(batch[0]?.deliveryId).toBe(first.deliveryId);
			store.materialize(claim(batch[0] as MailboxRow), persist);
			const next = store.claimBatch("recipient", { token: "t", epoch: "e" });
			expect(next[0]?.kind).toBe("task_notice");
			store.materialize(claim(next[0] as MailboxRow), persist);
		}
	});
	test("legacy user kind defaults and summary listing avoid body hydration", () => {
		db.insert(narratorBufferedMessages)
			.values({
				id: "old-second",
				narratorId: "recipient",
				text: "z".repeat(1_000_000),
				seq: 9,
				bufferedAt: time,
			})
			.run();
		db.insert(narratorBufferedMessages)
			.values({ id: "old-first", narratorId: "recipient", text: "first", seq: 2, bufferedAt: time })
			.run();
		expect(store.initializeLegacy("recipient")).toBe(true);
		const rows = store.list("recipient");
		expect(rows.map((row) => row.id)).toEqual(["old-first", "old-second"]);
		expect(rows.every((row) => row.kind === "user_input" && !("text" in row))).toBe(true);
		expect(store.claimBatch("recipient", { token: "t", epoch: "e" })).toHaveLength(1);
	});
	test("legacy repair preserves the stored role and parent binding within one bounded page", () => {
		db.insert(narratorBufferedMessages)
			.values({
				id: "legacy-agent",
				narratorId: "recipient",
				kind: "agent_message",
				text: "body",
				seq: 1,
				bufferedAt: time,
				metadataJson: JSON.stringify({
					history: {
						role: "user",
						parentToolUseId: "send-tool",
						contentJson: [{ type: "text", text: "body" }],
						contentText: "body",
					},
				}),
			})
			.run();
		expect(store.repairLegacyProjections("recipient")).toBe(1);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, "legacy-agent"))
			.get();
		const message = db
			.select()
			.from(narratorMessages)
			.where(eq(narratorMessages.id, row?.currentMessageId as string))
			.get();
		expect(message).toMatchObject({ role: "user", parentToolUseId: "send-tool" });
		expect(db.select().from(narratorMessageRefs).all()).toHaveLength(1);
	});
	test("large user payload uses references, cancellation never unlinks shared files", () => {
		const row = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				text: "",
				projectedByteSize: 2_000_000,
				requestKey: "large",
				payloadRef: {
					storage: "upload",
					path: "/shared/immutable.txt",
					byteSize: 2_000_000,
					ownership: "shared",
				},
			}),
		);
		expect(store.list("recipient")[0]?.byteSize).toBe(2_000_000);
		expect(store.cancel(row.deliveryId as string, "cancel")).toBe(true);
		expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
			payloadRefJson: null,
			byteSize: 0,
			state: "cancelled",
		});
		expect(store.collectTombstones([row.id], () => true)).toBe(0);
	});
	test("kind quotas, immutable nonuser order, user edit and principal barriers", () => {
		for (let i = 0; i < 50; i++) store.enqueue(input(`full-${i}`));
		expect(
			store.enqueue({
				kind: "task_notice",
				noticeKind: "agent",
				narratorId: "recipient",
				sourceKey: "completion",
				text: "done",
				projectedByteSize: 4,
			}).status,
		).toBe("accepted");
		const user = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				requestKey: "user",
				text: "hi",
				projectedByteSize: 2,
				priority: true,
			}),
		);
		const agent = store.list("recipient", { kind: "agent_message" })[0];
		expect(
			store.editUser(agent?.deliveryId as string, { text: "forged", projectedByteSize: 6 }),
		).toBe(false);
		expect(
			store.editUser(user.deliveryId as string, { text: "edit", projectedByteSize: 4, seq: -2 }),
		).toBe(true);
		const batch = store.claimBatch("recipient", { token: "t", epoch: "e" });
		expect(batch).toHaveLength(1);
		expect(batch[0]?.kind).toBe("user_input");
		expect(store.editUser(user.deliveryId as string, { text: "late", projectedByteSize: 4 })).toBe(
			false,
		);
		expect(store.cancel(user.deliveryId as string, "late")).toBe(false);
	});
	test("legacy clear never deletes another kind or a materialized receipt", () => {
		db.insert(narratorBufferedMessages)
			.values({ id: "legacy", narratorId: "recipient", text: "old", seq: 1, bufferedAt: time })
			.run();
		const agent = accepted(store.enqueue(input()));
		store.enqueue({
			kind: "task_notice",
			noticeKind: "bash",
			narratorId: "recipient",
			sourceKey: "notice",
			text: "done",
			projectedByteSize: 4,
		});
		expect(store.cancelUserPage("recipient", "clear user projection")).toEqual([{ id: "legacy" }]);
		expect(store.getByDelivery(agent.deliveryId as string)?.state).toBe("queued");
		expect(store.list("recipient", { kind: "task_notice" })[0]?.state).toBe("queued");
		expect(store.list("recipient", { kind: "user_input" })[0]?.state).toBe("cancelled");
	});
	test("claim cancellation is epoch guarded and preserves negative acceptance", () => {
		store.enqueue(input());
		const row = store.claimBatch("recipient", { token: "owner", epoch: "epoch" })[0] as MailboxRow;
		expect(() => store.cancelClaim({ ...claim(row), epoch: "wrong" }, "stale")).toThrow("Stale");
		expect(store.cancelClaim(claim(row), "revert cancelled")).toBe(true);
		expect(() => store.materialize(claim(row), persist)).toThrow("Stale");
		expect(accepted(store.enqueue(input()))).toMatchObject({
			state: "cancelled",
			text: "",
			claimEpoch: null,
		});
	});
	test("semantic edit before original adoption cannot create an adopted fact", () => {
		store.enqueue(input());
		const row = materializeOne();
		db.transaction((tx) =>
			store.updateRecipientRef(tx, "recipient", row.recipientRefId as string, {
				kind: "semantic_edit",
				messageId: row.currentMessageId as string,
			}),
		);
		expect(
			store.ackAdopted(row.deliveryId as string, "recipient", row.recipientRefId as string, 1),
		).toBe(false);
		expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	});
	test("edited user input materializes its content revision rather than resetting it", () => {
		const row = accepted(
			store.enqueue({
				kind: "user_input",
				narratorId: "recipient",
				text: "old",
				projectedByteSize: 3,
			}),
		);
		store.editUser(row.deliveryId as string, { text: "new", projectedByteSize: 3 });
		expect(materializeOne().contentRevision).toBe(2);
	});
	test("oversized input, metadata and inaccurate projected sizes fail explicitly", () => {
		expect(() =>
			store.enqueue(
				input("large", {
					text: "x".repeat(L.agentBodyBytes + 1),
					projectedByteSize: L.agentBodyBytes + 1,
				}),
			),
		).toThrow();
		expect(() =>
			store.enqueue(input("meta", { metadata: { content: "x".repeat(L.metadataBytes) } })),
		).toThrow("Metadata");
		expect(() =>
			store.enqueue(input("projection", { projectedByteSize: L.agentProjectedBytes + 1 })),
		).toThrow("projection");
		expect(() => store.enqueue(input("inaccurate", { projectedByteSize: 1 }))).toThrow("size");
		expect(store.list("recipient")).toHaveLength(0);
	});
});
