import { afterAll, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { narratorBufferedMessages, narrators } from "../../db/schema";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
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
afterAll(async () => {
	for (const id of ["live", "legacy-live", "barrier"]) getExecutionOwner(id)?.release();
	runtimePublication.stop();
	await closeRuntimeTestDb(sqlite);
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
	const owner = tryClaimExecution("live", "run");
	if (!owner) throw new Error("owner missing");
	await inbox.claimInboxHead("live", () => true);
	const legacyLive = enqueue("legacy-live");
	const legacyOwner = tryClaimExecution("legacy-live", "run");
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

test("predicate runs against publication-eligible head, never claims a different row than checked", async () => {
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
	tryClaimExecution("barrier", "run");
	expect((await inbox.peekInbox("barrier"))?.id).toBe(user.delivery.id);
	expect(
		await inbox.claimInboxHead(
			"barrier",
			(row) => row.id === user.delivery.id && row.kind === "user_input",
		),
	).toBeUndefined();
	expect(state(early.delivery.id)?.state).toBe("queued");
	const exact = await inbox.claimInboxHead("barrier", (row) => row.id === early.delivery.id);
	expect(exact?.id).toBe(early.delivery.id);
	expect(state(user.delivery.id)?.state).toBe("queued");
});

test("a held user queue still delivers preceding non-user work and leaves other narrators alone", async () => {
	const { beginBufferedMessageEdit } = await import("../narrator-buffer");
	const { bufferEditHolds } = await import("../buffer-edit-hold");
	const previous = bufferEditHolds.setListener(undefined);
	for (const id of ["edit-agent-head", "edit-unrelated"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
	const agent = store.enqueue({
		kind: "agent_message",
		narratorId: "edit-agent-head",
		sourceNarratorId: "sender",
		sourceToolCallId: "edit-call",
		sourceAttempt: 1,
		sourceKey: "edit-agent",
		text: "report",
		projectedByteSize: 6,
	});
	if (!("delivery" in agent)) throw new Error("full");
	const user = enqueue("edit-agent-head");
	const unrelated = enqueue("edit-unrelated");
	const owner = tryClaimExecution("edit-agent-head", "run");
	const otherOwner = tryClaimExecution("edit-unrelated", "run");
	try {
		await beginBufferedMessageEdit("edit-agent-head", user.id, "user", "edit");
		expect(await inbox.hasInboxKind("edit-agent-head", ["user_input", "agent_message"])).toBe(true);
		expect((await inbox.claimInboxHead("edit-agent-head", () => true))?.id).toBe(agent.delivery.id);
		expect((await inbox.claimInboxHead("edit-unrelated", () => true))?.id).toBe(unrelated.id);
		expect(await inbox.claimInboxHead("edit-agent-head", () => true)).toBeUndefined();
	} finally {
		owner?.release();
		otherOwner?.release();
		await bufferEditHolds.release("edit-agent-head", {
			messageId: user.id,
			userId: "user",
			token: "edit",
		});
		bufferEditHolds.setListener(previous);
	}
});

test("held failed input allows broadcast→direct prefix wake, but a queued user barrier still blocks it", async () => {
	const { beginBufferedMessageEdit } = await import("../narrator-buffer");
	const { bufferEditHolds } = await import("../buffer-edit-hold");
	const previous = bufferEditHolds.setListener(undefined);
	const id = "edit-broadcast-prefix";
	db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
	for (const isBroadcast of [true, false]) {
		store.enqueue({
			kind: "agent_message",
			narratorId: id,
			sourceNarratorId: "sender",
			sourceToolCallId: `prefix-${isBroadcast}`,
			sourceAttempt: 1,
			sourceKey: `prefix-${isBroadcast}`,
			text: "report",
			projectedByteSize: 6,
			metadata: { isBroadcast },
		});
	}
	const failed = enqueue(id);
	db.update(narratorBufferedMessages)
		.set({ state: "failed" })
		.where(eq(narratorBufferedMessages.id, failed.id))
		.run();
	try {
		await beginBufferedMessageEdit(id, failed.id, "user", "edit");
		expect(await inbox.hasWakeEligibleInboxInput(id)).toBe(true);
		const barrier = enqueue(id);
		db.update(narratorBufferedMessages)
			.set({ priority: true, seq: -100 })
			.where(eq(narratorBufferedMessages.id, barrier.id))
			.run();
		expect(await inbox.hasWakeEligibleInboxInput(id)).toBe(false);
	} finally {
		await bufferEditHolds.release(id, { messageId: failed.id, userId: "user", token: "edit" });
		bufferEditHolds.setListener(previous);
	}
});

test("edit begin and asynchronous PostgreSQL claim are mutually exclusive in both race orders", async () => {
	const { bufferEditHolds } = await import("../buffer-edit-hold");
	const { beginBufferedMessageEdit } = await import("../narrator-buffer");
	const { bindRuntimeQueue } = await import("../agent-runtime/runtime-queue-port");
	type Port = import("../agent-runtime/postgres-runtime-queue").PostgresRuntimeQueue;
	const id = "pg-edit-race";
	db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
	const user = enqueue(id);
	const row = state(user.id);
	if (!row) throw new Error("row missing");
	const owner = tryClaimExecution(id, "run");
	if (!owner) throw new Error("owner missing");
	const previous = bufferEditHolds.setListener(undefined);
	let claimed = false;
	let release!: () => void;
	let started!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	bindRuntimeQueue({
		backend: "postgres",
		queue: {
			mailbox: {
				getById: async () => ({ ...row, state: claimed ? "claimed" : "queued" }),
				claimEligibleHead: async (
					_id: string,
					_owner: unknown,
					accepts: (row: typeof user) => boolean,
				) => {
					started();
					await blocked;
					if (!accepts(row)) return undefined;
					claimed = true;
					return { ...row, state: "claimed" };
				},
			},
		} as unknown as Port,
	});
	try {
		const claiming = inbox.claimInboxHead(id, () => true);
		await entered;
		const editing = beginBufferedMessageEdit(id, user.id, "user", "token");
		release();
		expect((await claiming)?.id).toBe(user.id);
		await expect(editing).rejects.toThrow("being edited");
		claimed = false;
		await beginBufferedMessageEdit(id, user.id, "user", "token");
		expect(await inbox.claimInboxHead(id, () => true)).toBeUndefined();
		expect(claimed).toBe(false);
		await bufferEditHolds.release(id, { messageId: user.id, userId: "user", token: "token" });
		expect((await inbox.claimInboxHead(id, () => true))?.id).toBe(user.id);
	} finally {
		bindRuntimeQueue(undefined);
		owner.release();
		await bufferEditHolds.release(id, { messageId: user.id, userId: "user", token: "token" });
		bufferEditHolds.setListener(previous);
	}
});
