import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const inbox = await import("../agent-runtime/inbox");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { createPublicationOutbox } = await import("../agent-runtime/publication-outbox");
const { runtimePublication } = await import("../agent-runtime/publication");
runtimePublication.setWake(undefined);
const store = createMailboxStore(db);
const time = "2026-09-09T00:00:00.000Z";
for (const id of ["previous", "live", "legacy", "legacy-live", "barrier", "sender"])
	db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
afterAll(() => {
	for (const id of ["live", "legacy-live", "barrier"]) getExecutionOwner(id)?.release();
	runtimePublication.stop();
	sqlite.close();
});
function enqueue(id: string, text = "accepted bytes") {
	const result = store.enqueue({
		kind: "user_input",
		narratorId: id,
		text,
		projectedByteSize: text.length,
	});
	if (!("delivery" in result)) throw new Error("full");
	return result.delivery;
}
function state(id: string) {
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, id))
		.get();
}

test("cold bootstrap releases only previous-process or proven legacy claims, never hot live claims", async () => {
	const old = enqueue("previous");
	store.claimBatch("previous", { token: "process:dead-process:token", epoch: "old-epoch" });
	const legacy = enqueue("legacy");
	store.claimBatch("legacy", { token: "unprefixed-old", epoch: "old-unprefixed" });
	const current = enqueue("live");
	const owner = tryClaimExecution("live", "primary");
	if (!owner) throw new Error("owner missing");
	inbox.claimInboxHead("live", () => true);
	const legacyLive = enqueue("legacy-live");
	const legacyOwner = tryClaimExecution("legacy-live", "primary");
	if (!legacyOwner) throw new Error("owner missing");
	store.claimBatch("legacy-live", { token: "legacy-still-live", epoch: legacyOwner.epoch });
	expect(await inbox.recoverInboxClaimsOnColdStartup()).toBe(2);
	expect(state(old.id)).toMatchObject({ state: "queued", text: "accepted bytes" });
	expect(state(legacy.id)?.state).toBe("queued");
	expect(state(current.id)).toMatchObject({ state: "claimed", claimEpoch: owner.epoch });
	expect(state(legacyLive.id)?.state).toBe("claimed");
	const hot = await import("../agent-runtime/inbox");
	expect(hot.inboxProcessId).toBe(inbox.inboxProcessId);
	expect(await hot.recoverInboxClaimsOnColdStartup()).toBe(0);
	expect(state(current.id)?.state).toBe("claimed");
});

test("predicate runs against publication-eligible head, never claims a different row than checked", () => {
	const early = store.enqueue({
		kind: "agent_message",
		narratorId: "barrier",
		sourceNarratorId: "sender",
		sourceToolCallId: "tool",
		sourceAttempt: 1,
		sourceKey: "early",
		text: "earlier",
		projectedByteSize: 7,
		metadata: { channel: "buffer" },
	});
	if (!("delivery" in early)) throw new Error("full");
	const outbox = createPublicationOutbox(db);
	const run = {
		producerKind: "agent" as const,
		taskId: "sender",
		recipientId: "barrier",
		logicalRunId: "publication-barrier",
	};
	outbox.reserveRunSlots(run);
	outbox.commitIntent({ ...run, eventKind: "completed", resultRef: "result", summary: "waiting" });
	const user = store.enqueue({
		kind: "user_input",
		narratorId: "barrier",
		text: "priority user later",
		projectedByteSize: 19,
		priority: true,
		seq: -1,
	});
	if (!("delivery" in user)) throw new Error("full");
	tryClaimExecution("barrier", "primary");
	expect(inbox.peekInbox("barrier")?.id).toBe(user.delivery.id);
	expect(
		inbox.claimInboxHead(
			"barrier",
			(row) => row.id === user.delivery.id && row.kind === "user_input",
		),
	).toBeUndefined();
	expect(state(early.delivery.id)?.state).toBe("queued");
	const exact = inbox.claimInboxHead("barrier", (row) => row.id === early.delivery.id);
	expect(exact?.id).toBe(early.delivery.id);
	expect(state(user.delivery.id)?.state).toBe("queued");
});
