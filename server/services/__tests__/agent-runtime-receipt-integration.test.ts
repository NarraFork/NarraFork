import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { createMailboxStore } from "../agent-runtime/mailbox";
import type { MailboxClaim, MailboxRow } from "../agent-runtime/mailbox-types";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...ws, broadcastToNarrator: () => {} }));
const { narratorPersistence } = await import("../narrator-persistence");
const { narratorMessageQueries: messageService } = await import("../narrator-messages");
const {
	markAgentMessageConsumed,
	agentMessageDeliveryBody,
	trackAgentMessageHistory,
	consumeAgentMessageHistory,
	markMailboxDeliveryConsumed,
} = await import("../agent-message-delivery");
const { loadSendTargetDetails, attachSendTargetDetails } = await import(
	"../send-delivery-resolution"
);
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const store = createMailboxStore(db);
afterEach(() => {
	for (const id of ["recipient", "fork", "sender"]) getExecutionOwner(id)?.release();
});
const time = "2026-09-09T00:00:00.000Z";
let serial = 0;
beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["recipient", "sender", "fork"])
		db.insert(narrators).values({ id, createdAt: time, updatedAt: time }).run();
});
afterAll(() => sqlite.close());

test("SQL materialization failure cannot leave a partial mailbox transition", async () => {
	const { row, claim } = enqueue();
	// Acceptance already created the canonical row/ref. Fail the materialization
	// update so the eager projection must remain visible but unmaterialized.
	sqlite.exec(
		"CREATE TEMP TRIGGER fail_receipt_materialize BEFORE UPDATE OF current_message_id ON narrator_buffered_messages BEGIN SELECT RAISE(ABORT, 'materialization fault'); END",
	);
	try {
		await expect(persist(row, claim)).rejects.toThrow("materialization fault");
	} finally {
		sqlite.exec("DROP TRIGGER fail_receipt_materialize");
	}
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	expect(ref(row.recipientMessageId as string)?.deliveryState).toBe("claimed");
	expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("claimed");
	await persist(row, claim);
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
});

test("adoption bookkeeping failure retries only the receipt, never history input", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	sqlite.exec(
		"CREATE TEMP TRIGGER fail_receipt_ack BEFORE UPDATE OF injection_consumed_at ON narrator_message_refs BEGIN SELECT RAISE(ABORT, 'ack write fault'); END",
	);
	try {
		await markAgentMessageConsumed(delivery(row));
	} finally {
		sqlite.exec("DROP TRIGGER fail_receipt_ack");
	}
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	expect(ref(message.id)?.injectionConsumedAt).toBeNull();
	await markAgentMessageConsumed(delivery(row));
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedRevision).toBe(1);
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
});

test("semantic block deletion keeps original adopted fact and invalidates sender receipt page", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	await markAgentMessageConsumed(delivery(row));
	const adoptedAt = store.getByDelivery(row.deliveryId as string)?.adoptedAt;
	const before =
		db
			.select({ version: narrators.messageVersion })
			.from(narrators)
			.where(eq(narrators.id, "sender"))
			.get()?.version ?? 0;
	await messageService.deleteMessageBlock("recipient", message.id, 0, { skipRevert: true });
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		receiptDisposition: "superseded",
		adoptedAt,
	});
	// Full semantic deletion removes the recipient ref; the mailbox keeps the
	// adopted timestamp and marks the original delivery superseded.
	expect(ref(message.id)).toBeUndefined();
	const [target] = await loadSendTargetDetails(
		[
			{
				id: "recipient",
				deliveryId: row.deliveryId as string,
				deliveryMessageId: message.id,
				revision: 1,
			},
		],
		db,
	);
	expect(target).toMatchObject({
		receiptDisposition: "superseded",
		injectionConsumedAt: adoptedAt,
	});
	expect(
		db
			.select({ version: narrators.messageVersion })
			.from(narrators)
			.where(eq(narrators.id, "sender"))
			.get()?.version,
	).toBeGreaterThan(before);
});

test("result publication callback and tool terminal result share one real transaction", async () => {
	db.insert(narratorMessages)
		.values({
			id: "source",
			narratorId: "sender",
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "source-tool",
			messageId: "source",
			narratorId: "sender",
			toolUseId: "tool-use",
			toolName: "Agent",
			status: "running",
			createdAt: time,
		})
		.run();
	await expect(
		narratorPersistence.updateToolCallResult(
			"tool-use",
			{
				status: "success",
				output: { done: true },
				onPersist: () => {
					throw new Error("publication intent fault");
				},
			},
			"source",
			"source-tool",
		),
	).rejects.toThrow("publication intent fault");
	expect(
		db.select().from(narratorToolCalls).where(eq(narratorToolCalls.id, "source-tool")).get(),
	).toMatchObject({ status: "running", outputJson: null });
	let sawCommittedResult = false;
	await narratorPersistence.updateToolCallResult(
		"tool-use",
		{
			status: "success",
			output: { done: true },
			onPersist: (tx) => {
				sawCommittedResult =
					tx
						.select({ status: narratorToolCalls.status })
						.from(narratorToolCalls)
						.where(eq(narratorToolCalls.id, "source-tool"))
						.get()?.status === "success";
			},
		},
		"source",
		"source-tool",
	);
	expect(sawCommittedResult).toBe(true);
});
function enqueue(user = false) {
	const key = `receipt-${++serial}`;
	const result = store.enqueue(
		user
			? {
					kind: "user_input",
					narratorId: "recipient",
					text: "original",
					projectedByteSize: 8,
					requestKey: key,
				}
			: {
					kind: "agent_message",
					narratorId: "recipient",
					text: "original",
					projectedByteSize: 8,
					sourceNarratorId: "sender",
					sourceToolCallId: "tool",
					sourceAttempt: 1,
					sourceKey: key,
				},
	);
	if (result.status !== "accepted") throw new Error(result.status);
	const owner = getExecutionOwner("recipient") ?? tryClaimExecution("recipient", "primary");
	if (!owner) throw new Error("Test execution owner unavailable");
	const row = store.claimBatch("recipient", { token: key, epoch: owner.epoch })[0] as MailboxRow;
	const claim: MailboxClaim = {
		id: row.id,
		narratorId: row.narratorId,
		token: row.claimToken as string,
		epoch: row.claimEpoch as string,
	};
	return { row, claim };
}
function delivery(row: MailboxRow) {
	return {
		recipientNarratorId: "recipient",
		recipientMessageId: row.recipientMessageId as string,
		deliveryId: row.deliveryId as string,
		revision: 1,
		fromToolUseId: "send",
		senderNarratorId: "sender",
		sender: { id: "sender", label: "sender", title: null, type: "primary", isParent: false },
		text: "original",
	};
}
async function persist(row: MailboxRow, claim: MailboxClaim) {
	const d = delivery(row);
	const body = agentMessageDeliveryBody(d);
	return narratorPersistence.persistUserMessage(
		"recipient",
		"original",
		[
			{ type: "text", text: "original" },
			{ type: "system_injection", body },
		],
		undefined,
		undefined,
		{ origin: "assistant" },
		{ mailboxClaim: claim },
	);
}
function ref(id: string) {
	return db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, id)).get();
}

test("source COW copy cannot authorize a new Send execution or duplicate its original delivery", async () => {
	const { row, claim } = enqueue();
	await persist(row, claim);
	db.insert(narratorMessages)
		.values({
			id: "send-source",
			narratorId: "sender",
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values([
			{ id: "sender-source-ref", narratorId: "sender", messageId: "send-source", seq: 0 },
			{ id: "fork-source-ref", narratorId: "fork", messageId: "send-source", seq: 0 },
		])
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: "tool",
			narratorId: "sender",
			messageId: "send-source",
			toolUseId: "send",
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			createdAt: time,
		})
		.run();
	const copy = await narratorPersistence.copyOnWriteMessage("sender", "send-source");
	const copiedTool = db
		.select()
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.messageId, copy))
		.get();
	expect(copiedTool?.executionOriginToolCallId).toBe("tool");
	const { enqueueInboxAgent } = await import("../agent-runtime/inbox");
	expect(() =>
		enqueueInboxAgent(
			{
				...delivery(row),
				senderToolCallBinding: { toolCallId: copiedTool?.id as string, attempt: 1 },
			},
			"original",
		),
	).toThrow();
	expect(store.list("recipient")).toHaveLength(1);
	expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("materialized");
});

test("legacy ref-only consumption upgrades mailbox adoption using its original timestamp", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	const original = new Date("2026-09-08T00:00:00.123Z");
	db.update(narratorMessageRefs)
		.set({ injectionConsumedAt: original })
		.where(eq(narratorMessageRefs.messageId, message.id))
		.run();
	await markAgentMessageConsumed(delivery(row));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		adoptedRevision: 1,
		adoptedAt: original.toISOString(),
	});
	expect(ref(message.id)?.injectionConsumedAt).toEqual(original);
});

test("wrong source attempt and content revision cannot acknowledge a stable delivery", async () => {
	const { row, claim } = enqueue();
	await persist(row, claim);
	await markAgentMessageConsumed({ ...delivery(row), revision: 2 });
	await markAgentMessageConsumed({
		...delivery(row),
		senderToolCallBinding: { toolCallId: "tool", attempt: 2 },
	});
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	await markAgentMessageConsumed({
		...delivery(row),
		senderToolCallBinding: { toolCallId: "tool", attempt: 1 },
	});
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedRevision).toBe(1);
});

test("child user_input without agent envelope materializes through the real subagent writer", async () => {
	const { row, claim } = enqueue(true);
	const { narratorService } = await import("../narrator-service");
	const message = await narratorService.persistSubagentUserMessage(
		"recipient",
		"human child input",
		"origin",
		{ mailboxClaim: claim },
	);
	expect(message.parentToolUseId).toBe("origin");
	expect(message.id).toBe(row.recipientMessageId as string);
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		state: "materialized",
		recipientRefId: ref(message.id)?.id,
	});
});

test("clearContext hides old history without acknowledging, deleting or requeueing its delivery", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	const before = store.getByDelivery(row.deliveryId as string);
	await narratorPersistence.clearContext("recipient");
	expect(store.getByDelivery(row.deliveryId as string)).toEqual(before);
	expect(ref(message.id)?.injectionConsumedAt).toBeNull();
	const postCompact = await messageService._getPostCompactTopLevelRefs("recipient");
	expect(postCompact.some((item) => item.messageId === message.id)).toBe(false);
	expect(store.claimBatch("recipient", { token: "later", epoch: claim.epoch })).toHaveLength(0);
});

test.each([
	"user_input",
	"task_notice",
] as const)("generic %s adoption survives a cold history build, while prepare/abort does not acknowledge", async (kind) => {
	const owner = tryClaimExecution("recipient", "primary");
	if (!owner) throw new Error("Missing test owner");
	const input = { narratorId: "recipient", text: "durable input", projectedByteSize: 13 };
	const accepted = store.enqueue(
		kind === "user_input"
			? { ...input, kind, requestKey: `generic-${++serial}` }
			: { ...input, kind, noticeKind: "agent", sourceKey: `notice-${++serial}` },
	);
	if (accepted.status !== "accepted") throw new Error(accepted.status);
	const row = store.claimBatch("recipient", { token: "generic", epoch: owner.epoch })[0];
	const claim = {
		id: row.id,
		narratorId: row.narratorId,
		token: row.claimToken as string,
		epoch: row.claimEpoch as string,
	};
	const message =
		kind === "user_input"
			? await narratorPersistence.persistUserMessage(
					"recipient",
					input.text,
					undefined,
					undefined,
					undefined,
					undefined,
					{ mailboxClaim: claim },
				)
			: await narratorPersistence.persistSystemMessage(
					"recipient",
					input.text,
					undefined,
					undefined,
					undefined,
					{ mailboxClaim: claim },
				);
	const candidates = [
		{
			id: message.id,
			narratorId: "recipient",
			role: message.role,
			contentJson: message.contentJson,
		},
	];
	const abortedHistory: unknown[] = [];
	trackAgentMessageHistory(
		"recipient",
		abortedHistory,
		candidates,
		kind === "task_notice" ? input.text : undefined,
	);
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	consumeAgentMessageHistory(abortedHistory, "unrelated replacement input");
	await Promise.resolve();
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	const coldHistory: unknown[] = [];
	trackAgentMessageHistory(
		"recipient",
		coldHistory,
		candidates,
		kind === "task_notice" ? input.text : undefined,
	);
	consumeAgentMessageHistory(coldHistory, input.text);
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeString();
	await markMailboxDeliveryConsumed({
		deliveryId: row.deliveryId as string,
		recipientNarratorId: "recipient",
		revision: row.contentRevision,
	});
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		adoptedRevision: row.contentRevision,
		state: "materialized",
	});
	expect(ref(message.id)?.injectionConsumedAt).toBeInstanceOf(Date);
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
});

test("legacy reserved address resolves indexed COW and later deletion through actual Send page hydration", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	db.insert(narratorMessageRefs)
		.values({ id: "legacy-fork", narratorId: "fork", messageId: message.id, seq: 0 })
		.run();
	const current = await narratorPersistence.copyOnWriteMessage("recipient", message.id);
	const tree = [
		{
			contentJson: [
				{
					type: "tool_use",
					name: "Send",
					outputJson: {
						_metadata: { targets: [{ id: "recipient", deliveryMessageId: message.id }] },
					},
				},
			],
		},
	];
	const hydrated = await attachSendTargetDetails(tree, (targets) =>
		loadSendTargetDetails(targets, db),
	);
	expect(hydrated[0].contentJson[0]._sendDeliveryTargets[0]).toMatchObject({
		deliveryId: row.deliveryId,
		deliveryMessageId: current,
		revision: 1,
	});
	const plan = sqlite
		.query(
			"EXPLAIN QUERY PLAN SELECT delivery_id FROM narrator_buffered_messages WHERE narrator_id = ? AND recipient_message_id = ?",
		)
		.all("recipient", message.id);
	expect(JSON.stringify(plan)).toContain("idx_nbm_reserved");
	await messageService.deleteMessage("recipient", current, { skipRevert: true });
	const deleted = await attachSendTargetDetails(tree, (targets) =>
		loadSendTargetDetails(targets, db),
	);
	expect(deleted[0].contentJson[0]._sendDeliveryTargets[0]).toMatchObject({
		deliveryId: row.deliveryId,
		receiptDisposition: "recipient_deleted",
	});
});

test.each([
	false,
	true,
])("semantic current revisions adopt independently of original Send (original adopted=%s)", async (adopted) => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	if (adopted) await markAgentMessageConsumed(delivery(row));
	const originalAt = store.getByDelivery(row.deliveryId as string)?.adoptedAt;
	await narratorPersistence.copyOnWriteMessage("recipient", message.id, {
		contentText: "edited second",
		contentJson: [{ type: "text", text: "edited second" }],
	});
	const history2: unknown[] = [];
	trackAgentMessageHistory("recipient", history2, [
		{
			id: message.id,
			narratorId: "recipient",
			role: "user",
			contentJson: [{ type: "text", text: "edited second" }],
		},
	]);
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		currentRevision: 2,
		currentAdoptedAt: null,
	});
	await narratorPersistence.copyOnWriteMessage("recipient", message.id, {
		contentText: "edited third",
		contentJson: [{ type: "text", text: "edited third" }],
	});
	consumeAgentMessageHistory(history2, "edited second");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		currentRevision: 3,
		currentAdoptedAt: null,
		adoptedAt: originalAt,
	});
	const history3: unknown[] = [];
	trackAgentMessageHistory("recipient", history3, [
		{
			id: message.id,
			narratorId: "recipient",
			role: "user",
			contentJson: [{ type: "text", text: "edited third" }],
		},
	]);
	consumeAgentMessageHistory(history3, "edited third");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		contentRevision: 1,
		currentRevision: 3,
		currentAdoptedRevision: 3,
		adoptedAt: originalAt,
		receiptDisposition: "superseded",
	});
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeString();
	expect(ref(message.id)?.injectionConsumedAt).toBeInstanceOf(Date);
	const [receipt] = await loadSendTargetDetails(
		[{ id: "recipient", deliveryMessageId: message.id }],
		db,
	);
	expect(receipt.revision).toBe(1);
	expect(receipt.injectionConsumedAt ?? null).toBe(originalAt ?? null);
});

test("edited revision cannot be adopted through a fork COW or after recipient deletion", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	await narratorPersistence.copyOnWriteMessage("recipient", message.id, {
		contentText: "edited",
		contentJson: [{ type: "text", text: "edited" }],
	});
	db.insert(narratorMessageRefs)
		.values({ id: "edited-fork-ref", narratorId: "fork", messageId: message.id, seq: 0 })
		.run();
	const forkMessageId = await narratorPersistence.copyOnWriteMessage("fork", message.id);
	const forkHistory: unknown[] = [];
	trackAgentMessageHistory("fork", forkHistory, [
		{
			id: forkMessageId,
			narratorId: "fork",
			role: "user",
			contentJson: [{ type: "text", text: "edited" }],
		},
	]);
	consumeAgentMessageHistory(forkHistory, "edited");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)?.currentAdoptedAt).toBeNull();
	const recipientHistory: unknown[] = [];
	trackAgentMessageHistory("recipient", recipientHistory, [
		{
			id: message.id,
			narratorId: "recipient",
			role: "user",
			contentJson: [{ type: "text", text: "edited" }],
		},
	]);
	await messageService.deleteMessage("recipient", message.id, { skipRevert: true });
	consumeAgentMessageHistory(recipientHistory, "edited");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		receiptDisposition: "recipient_deleted",
		currentAdoptedAt: null,
		adoptedAt: null,
	});
});

test("ordinary user input materializes with message/ref in the real persistence transaction", async () => {
	const { row, claim } = enqueue(true);
	const message = await narratorPersistence.persistUserMessage(
		"recipient",
		"original",
		undefined,
		undefined,
		undefined,
		undefined,
		{ mailboxClaim: claim },
	);
	expect(message.id).toBe(row.recipientMessageId as string);
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		state: "materialized",
		text: "",
		recipientRefId: ref(message.id)?.id,
	});
});

test("fault after mailbox materialization rolls message/ref/mailbox back together", async () => {
	const { row, claim } = enqueue(true);
	await expect(
		narratorPersistence.persistUserMessage(
			"recipient",
			"original",
			undefined,
			undefined,
			undefined,
			undefined,
			{
				mailboxClaim: claim,
				onPersist: () => {
					throw new Error("injected transaction failure");
				},
			},
		),
	).rejects.toThrow("injected transaction failure");
	// Canonical history was admitted eagerly; the failed adoption must leave it
	// visible and the mailbox/ref projection claimed for a retry.
	expect(ref(row.recipientMessageId as string)?.deliveryState).toBe("claimed");
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
	expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("claimed");
	await narratorPersistence.persistUserMessage(
		"recipient",
		"original",
		undefined,
		undefined,
		undefined,
		undefined,
		{ mailboxClaim: claim },
	);
	expect(db.select().from(narratorMessages).all()).toHaveLength(1);
});

test("released owner cannot materialize even while its persistent claim token remains valid", async () => {
	const { row, claim } = enqueue();
	getExecutionOwner("recipient")?.release();
	const successor = tryClaimExecution("recipient", "primary");
	expect(successor?.epoch).not.toBe(claim.epoch);
	await expect(persist(row, claim)).rejects.toThrow("Stale mailbox claim execution owner");
	expect(ref(row.recipientMessageId as string)?.deliveryState).toBe("claimed");
	expect(store.getByDelivery(row.deliveryId as string)?.state).toBe("claimed");
});

test("stale claim cannot materialize a pre-projected recipient history row", async () => {
	const { row, claim } = enqueue();
	await expect(persist(row, { ...claim, epoch: "obsolete" })).rejects.toThrow(
		"Stale mailbox claim",
	);
	expect(ref(row.recipientMessageId as string)?.deliveryState).toBe("claimed");
});

test("structural recipient COW resolves stable navigation and adopts the original revision", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	const originalRef = ref(message.id);
	db.insert(narratorMessageRefs)
		.values({ id: "fork-ref", narratorId: "fork", messageId: message.id, seq: 0 })
		.run();
	const current = await narratorPersistence.copyOnWriteMessage("recipient", message.id);
	expect(current).not.toBe(message.id);
	await markAgentMessageConsumed(delivery(row));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		recipientRefId: originalRef?.id,
		currentMessageId: current,
		adoptedRevision: 1,
	});
	expect(ref(message.id)?.injectionConsumedAt).toBeNull();
	const [target] = await loadSendTargetDetails(
		[
			{
				id: "recipient",
				deliveryId: row.deliveryId as string,
				deliveryMessageId: message.id,
				revision: 1,
			},
		],
		db,
	);
	expect(target).toMatchObject({
		deliveryMessageId: current,
		recipientRefId: originalRef?.id,
		revision: 1,
	});
	expect(target.injectionConsumedAt).toBeString();
});

test("semantic edit supersedes an unadopted Send; edited text is never old consumption", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	await narratorPersistence.copyOnWriteMessage("recipient", message.id, {
		contentText: "edited",
		contentJson: [{ type: "text", text: "edited" }],
	});
	await markAgentMessageConsumed(delivery(row));
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		receiptDisposition: "superseded",
		adoptedAt: null,
	});
	expect(ref(message.id)?.injectionConsumedAt).toBeNull();
});

test("fork COW cannot acknowledge another recipient even with the same envelope", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	db.insert(narratorMessageRefs)
		.values({ id: "fork-ref", narratorId: "fork", messageId: message.id, seq: 0 })
		.run();
	const current = await narratorPersistence.copyOnWriteMessage("fork", message.id);
	const content = db.select().from(narratorMessages).where(eq(narratorMessages.id, current)).get();
	const history: unknown[] = [];
	trackAgentMessageHistory("fork", history, [
		{ id: current, narratorId: "fork", role: "user", contentJson: content?.contentJson },
	]);
	consumeAgentMessageHistory(history, "original");
	await markAgentMessageConsumed({
		...delivery(row),
		recipientNarratorId: "fork",
		recipientMessageId: current,
	});
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
	expect(ref(current)?.injectionConsumedAt).toBeNull();
});

test("real deleteMessage leaves a negative receipt and does not delete a shared fork", async () => {
	const { row, claim } = enqueue();
	const message = await persist(row, claim);
	db.insert(narratorMessageRefs)
		.values({ id: "fork-ref", narratorId: "fork", messageId: message.id, seq: 0 })
		.run();
	await messageService.deleteMessage("recipient", message.id, { skipRevert: true });
	expect(store.getByDelivery(row.deliveryId as string)).toMatchObject({
		state: "materialized",
		receiptDisposition: "recipient_deleted",
		currentMessageId: null,
	});
	expect(ref(message.id)?.narratorId).toBe("fork");
	await markAgentMessageConsumed(delivery(row));
	expect(store.getByDelivery(row.deliveryId as string)?.adoptedAt).toBeNull();
});
