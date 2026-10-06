import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorMessageRefs, narrators } from "../../db/schema";
import type {
	AgentReplyWaitRunSnapshot,
	SendAwaitDeliveryCoordinates,
} from "../agent-reply-waiter";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...ws, broadcastToNarrator: () => {} }));
const waiter = await import("../agent-reply-waiter");
const { sendAwaitSnapshotFromPayload } = await import("../update-recovery-service");
const { formatSendAwaitSnapshotWithFallback, restoreSendAwaitFromSnapshot } = await import(
	"../agent-communication"
);
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { narratorPersistence } = await import("../narrator-persistence");
const { loadSendTargetDetails } = await import("../send-delivery-resolution");
const store = createMailboxStore(db);
const time = "2026-09-09T00:00:00.000Z";
const binding = { toolCallId: "source-tool", attempt: 3 };
function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture");
	return value;
}
function snapshot(coords: SendAwaitDeliveryCoordinates = {}): AgentReplyWaitRunSnapshot {
	return {
		toolUseId: "send",
		requesterId: "sender",
		requesterToolCallBinding: binding,
		doInterrupt: true,
		waiters: [
			{
				...coords,
				toolUseId: "send",
				requesterId: "sender",
				responderId: "recipient",
				requestId: "request",
				requesterMessageId: "request-message",
				requesterToolCallBinding: binding,
				scope: { type: "parent-child", id: "sender:recipient" },
				deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				deliveryNote: "sent",
				deliveryMessageId: "reserved",
			},
		],
		prefixSections: [],
		prefixTargets: [],
	};
}
beforeEach(() => {
	waiter.clearPendingAgentReplyWaits();
	getExecutionOwner("recipient")?.release();
	cleanDb(sqlite);
	for (const id of ["sender", "recipient", "fork"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
});
afterAll(() => {
	waiter.clearPendingAgentReplyWaits();
	getExecutionOwner("recipient")?.release();
	sqlite.close();
});

test("old checkpoint remains valid and does not guess original revision", () => {
	const old = snapshot();
	expect(sendAwaitSnapshotFromPayload({ sendAwait: old })).toEqual(old);
	const output = formatSendAwaitSnapshotWithFallback(old, { status: "timeout" });
	expect(output.targets[0]?.deliveryMessageId).toBe("reserved");
	expect(output.targets[0]?.deliveryId).toBeUndefined();
	expect(output.targets[0]?.revision).toBeUndefined();
});

test("checkpoint validator preserves optional stable coordinates and rejects malformed supplied coordinates", () => {
	const valid = snapshot({ deliveryId: "delivery", recipientRefId: "ref", revision: 1 });
	expect(sendAwaitSnapshotFromPayload({ sendAwait: valid })).toEqual(valid);
	for (const invalid of [
		{ deliveryId: "" },
		{ deliveryId: "d", revision: 0 },
		{ deliveryId: "d", revision: 1.2 },
		{ recipientRefId: "ref" },
		{ deliveryId: "d", recipientRefId: 7 },
		{ deliveryId: "x".repeat(513) },
	]) {
		expect(
			sendAwaitSnapshotFromPayload({
				sendAwait: {
					...valid,
					waiters: [
						{
							...valid.waiters[0],
							...invalid,
							...(invalid.deliveryId === undefined ? { deliveryId: undefined } : {}),
						},
					],
				},
			}),
		).toBeNull();
	}
	const noRevision = snapshot({ deliveryId: "delivery" });
	expect(
		sendAwaitSnapshotFromPayload({ sendAwait: noRevision })?.waiters[0]?.revision,
	).toBeUndefined();
});

test("waiter updates, clones, active projection and restore preserve deadline, attempt and accepted revision", async () => {
	const run = waiter.beginAgentReplyWaitRun({
		requesterId: "sender",
		toolUseId: "send",
		requesterToolCallBinding: binding,
		doInterrupt: true,
	});
	const before = snapshot().waiters[0];
	if (!before) throw new Error("missing fixture");
	const handle = waiter.registerAgentReplyWait({ ...before, run });
	handle.updateSnapshot({ deliveryId: "delivery", recipientRefId: "ref", revision: 1 });
	run.markStable({
		prefixTargets: [{ id: "other", status: "queued", deliveryId: "other-delivery", revision: 2 }],
	});
	const saved = waiter.getRunningAgentReplyWaitRunSnapshot("send");
	if (!saved) throw new Error("missing snapshot");
	expect(saved.waiters[0]).toMatchObject({
		deliveryId: "delivery",
		recipientRefId: "ref",
		revision: 1,
		deadlineAt: before.deadlineAt,
		requesterToolCallBinding: binding,
	});
	expect(waiter.getActiveSendDeliveryTargets("sender", "send", binding)[0]).toMatchObject({
		deliveryId: "delivery",
		revision: 1,
	});
	required(saved.waiters[0]).revision = 99;
	expect(waiter.getRunningAgentReplyWaitRunSnapshot("send")?.waiters[0]?.revision).toBe(1);
	required(saved.waiters[0]).revision = 1;
	run.complete();
	handle.cancel();
	const restored = waiter.beginAgentReplyWaitRun({
		requesterId: "sender",
		toolUseId: "send",
		requesterToolCallBinding: binding,
		doInterrupt: true,
	});
	const recovered = waiter.registerAgentReplyWaitFromSnapshot(restored, required(saved.waiters[0]));
	restored.markStable();
	expect(recovered?.deadlineAt).toBe(before.deadlineAt);
	expect(waiter.getActiveSendDeliveryTargets("sender", "send", binding)[0]).toMatchObject({
		deliveryId: "delivery",
		recipientRefId: "ref",
		revision: 1,
	});
	recovered?.cancel();
	restored.complete();
});

test("COW-restored Send navigates by stable delivery while retaining captured original revision", async () => {
	const accepted = store.enqueue({
		kind: "agent_message",
		narratorId: "recipient",
		sourceNarratorId: "sender",
		sourceToolCallId: "source-tool",
		sourceAttempt: 3,
		sourceKey: "send",
		text: "original",
		projectedByteSize: 8,
	});
	if (!("delivery" in accepted)) throw new Error("full");
	const owner = tryClaimExecution("recipient", "primary");
	if (!owner) throw new Error("owner missing");
	const row = store.claimBatch("recipient", { token: "claim", epoch: owner.epoch })[0];
	if (!row) throw new Error("claim missing");
	const message = await narratorPersistence.persistUserMessage(
		"recipient",
		"original",
		[{ type: "text", text: "original" }],
		undefined,
		undefined,
		undefined,
		{
			mailboxClaim: { id: row.id, narratorId: row.narratorId, token: "claim", epoch: owner.epoch },
		},
	);
	const exactRef = db
		.select()
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.messageId, message.id))
		.get();
	const saved = snapshot({
		deliveryId: row.deliveryId ?? undefined,
		recipientRefId: exactRef?.id,
		revision: 1,
	});
	required(saved.waiters[0]).deliveryMessageId = message.id;
	db.insert(narratorMessageRefs)
		.values({ id: "fork-ref", narratorId: "fork", messageId: message.id, seq: 1 })
		.run();
	const moved = await narratorPersistence.copyOnWriteMessage("recipient", message.id);
	expect(moved).not.toBe(message.id);
	await narratorPersistence.copyOnWriteMessage("recipient", moved, {
		contentText: "edited",
		contentJson: [{ type: "text", text: "edited" }],
	});
	required(saved.waiters[0]).result = { status: "replied", message: "answer", receivedAt: time };
	const result = await restoreSendAwaitFromSnapshot(saved, new AbortController().signal);
	expect(result.targets[0]).toMatchObject({
		deliveryId: row.deliveryId,
		recipientRefId: exactRef?.id,
		revision: 1,
	});
	const details = await loadSendTargetDetails(result.targets, db);
	expect(details[0]).toMatchObject({
		deliveryMessageId: moved,
		deliveryId: row.deliveryId,
		recipientRefId: exactRef?.id,
	});
	expect(result.targets[0]?.revision).toBe(1);
	expect(store.list("recipient")).toHaveLength(1);
});
