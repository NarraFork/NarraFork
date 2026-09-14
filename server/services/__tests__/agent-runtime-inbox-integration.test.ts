import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
let failBroadcast = false;
mock.module("../../websocket/narrator-ws", () => ({
	...ws,
	broadcastToNarrator: () => {
		if (failBroadcast) throw new Error("WS unavailable");
	},
}));
const agent = { ...(await import("../../lib/agent")) };
mock.module("../../lib/agent", () => ({
	...agent,
	buildHistory: async () => ({ history: [], trailingToolResults: [] }),
}));
const inbox = await import("../agent-runtime/inbox");
const { awaitAnyRuntimeEvent } = await import("../agent-runtime/await-coordinator");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { pushParentInboundMessage } = await import("../parent-inbound-queue");
const { drainPendingInjections, projectPendingInjection } = await import(
	"../parent-injection-queue"
);
const { deliverPendingInjection, drainInjectionsIntoHistory } = await import("../narrator-session");
const { deliverTeamMessage, drainTeamInbox, clearTeamInbox } = await import("../subagent-team");
const {
	pushSubagentBufferedMessage,
	consumeNextBufferedSubagentMessage,
	consumeBufferedSubagentMessageInPass,
	getSubagentBufferedMessages,
	updateSubagentBufferedMessage,
} = await import("../subagent-executor");
const { enqueueBufferedMessage, clearBufferedMessages } = await import("../narrator-buffer");
const { createPublicationOutbox } = await import("../agent-runtime/publication-outbox");
const time = "2026-09-09T00:00:00.000Z";
let serial = 0;
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture value");
	return value;
}
beforeEach(() => {
	for (const id of ["parent", "child", "sender"]) getExecutionOwner(id)?.release();
	cleanDb(sqlite);
	failBroadcast = false;
	for (const id of ["parent", "child", "sender"])
		db.insert(narrators)
			.values({
				id,
				type: id === "parent" ? "primary" : "subagent",
				variant: id === "parent" ? "primary" : "subagent:general",
				parentNarratorId: id === "parent" ? null : "parent",
				createdAt: time,
				updatedAt: time,
			})
			.run();
});
afterAll(() => {
	for (const id of ["parent", "child", "sender"]) getExecutionOwner(id)?.release();
	sqlite.close();
});
function delivery(recipient = "child", text = "same words") {
	const id = `source-${++serial}`;
	db.insert(narratorMessages)
		.values({ id, narratorId: "sender", role: "assistant", contentJson: [], createdAt: time })
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-tool`,
			narratorId: "sender",
			messageId: id,
			toolUseId: `${id}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: time,
		})
		.run();
	return createAgentMessageDelivery(
		recipient,
		{ id: "sender", title: "Sender", label: "sender", type: "general", isParent: false },
		`${id}-use`,
		text,
		{ toolCallId: `${id}-tool`, attempt: 1 },
	);
}
function consume() {
	return consumeNextBufferedSubagentMessage({
		narratorId: "child",
		parentNarratorId: "parent",
		toolUseId: "origin",
		model: "test",
		provider: "anthropic",
		cwd: ".",
	});
}
function state(id: string) {
	return db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, id))
		.get();
}
function childMessages() {
	return db.select().from(narratorMessages).where(eq(narratorMessages.narratorId, "child")).all();
}

test("agent mailbox enqueue wakes any-event Await without consuming the row", async () => {
	const waiting = awaitAnyRuntimeEvent({
		narratorId: "parent",
		timeoutMs: 1_000,
		signal: new AbortController().signal,
	});
	const accepted = inbox.enqueueInboxAgent(delivery("parent", "wake me"), "wake me");
	expect(accepted.status).toBe("accepted");
	expect(await waiting).toMatchObject({
		status: "event",
		event: { source: "mailbox_pending", narratorId: "parent", mailboxKind: "agent_message" },
	});
	const rows = inbox.listInboxRows("parent", ["agent_message"]);
	expect(rows).toHaveLength(1);
	expect(rows[0]?.state).toBe("queued");
});

test("parent/team/child producers persist into the same mailbox, read projections do not consume", async () => {
	const parent = delivery("parent");
	pushParentInboundMessage("parent", {
		delivery: parent,
		fromId: "sender",
		fromTitle: "Sender",
		fromType: "general",
		fromToolUseId: parent.fromToolUseId,
		text: parent.text,
		timestamp: time,
	});
	expect(drainPendingInjections("parent")).toHaveLength(1);
	expect(drainPendingInjections("parent")).toHaveLength(1);
	const team = delivery();
	deliverTeamMessage(
		"child",
		{
			delivery: team,
			fromId: "sender",
			fromTitle: "Sender",
			fromType: "general",
			text: team.text,
			timestamp: time,
			isBroadcast: true,
		},
		"parent",
	);
	const buffered = await pushSubagentBufferedMessage("child", "[sender] next", {
		delivery: delivery("child", "next"),
	});
	expect(drainTeamInbox("child")).toHaveLength(2);
	clearTeamInbox("child");
	expect(inbox.listInboxRows("child")).toHaveLength(2);
	expect(state(buffered.id)?.kind).toBe("agent_message");
	expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(3);
});

test("source receipt is mandatory; exact retry returns original navigation and negative tombstone", () => {
	const d = delivery();
	const accepted = inbox.enqueueInboxAgent(d, `[prefix] ${d.text}`);
	inbox.runtimeInbox.cancel(accepted.delivery.deliveryId as string, "cancelled");
	db.delete(narratorToolCalls)
		.where(eq(narratorToolCalls.id, required(d.senderToolCallBinding).toolCallId))
		.run();
	const retry = { ...d, recipientMessageId: "discarded-new-id", text: "x".repeat(300_000) };
	expect(inbox.enqueueInboxAgent(retry, retry.text).status).toBe("duplicate");
	expect(retry.recipientMessageId).toBe(d.recipientMessageId);
	expect(inbox.runtimeInbox.list("child")).toHaveLength(1);
	expect(() => inbox.enqueueInboxAgent({ ...d, senderToolCallBinding: undefined }, d.text)).toThrow(
		"receipt",
	);
});

test("user barrier and editing are shared; agent messages cannot be edited through user UI", async () => {
	const user = await enqueueBufferedMessage(
		"child",
		"user",
		undefined,
		null,
		null,
		null,
		undefined,
		"front",
	);
	const d = delivery();
	const agentInput = await pushSubagentBufferedMessage("child", d.text, { delivery: d });
	const owner = tryClaimExecution("child", "subagent");
	expect(inbox.claimInboxHead("child", (row) => row.kind === "agent_message")).toBeUndefined();
	expect(await updateSubagentBufferedMessage("child", agentInput.id, "forged user")).toBe(false);
	expect(getSubagentBufferedMessages("child").map((m) => m.id)).toEqual([user.id]);
	clearBufferedMessages("child");
	expect(state(user.id)?.state).toBe("cancelled");
	expect(state(agentInput.id)?.state).toBe("queued");
	expect(inbox.claimInboxHead("child", () => true)?.claimEpoch).toBe(owner?.epoch);
});

test("parent real delivery commits history/ref/materialization together and keeps unadopted receipt", async () => {
	const d = delivery("parent");
	inbox.enqueueInboxAgent(d, d.text, { channel: "parent" });
	await inbox.withInboxOwner("parent", async () => {
		const row = required(inbox.claimInboxHead("parent", () => true));
		await deliverPendingInjection("parent", "en", "busy", "onNextTurn", {
			...projectPendingInjection(row),
			mailboxClaim: inbox.inboxClaim(row),
			recipientMessageId: required(row.recipientMessageId),
		});
		expect(state(row.id)).toMatchObject({
			state: "materialized",
			text: "",
			metadataJson: null,
			adoptedAt: null,
		});
		const ref = db
			.select()
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.messageId, d.recipientMessageId))
			.get();
		expect(ref?.injectionConsumedAt).toBeNull();
	});
});

test("child real consumer retains mailbox payload after SQL failure and retries one history row", async () => {
	const d = delivery();
	const accepted = await pushSubagentBufferedMessage("child", `[sender] ${d.text}`, {
		delivery: d,
	});
	sqlite.exec(
		"CREATE TEMP TRIGGER fail_inbox_ref BEFORE INSERT ON narrator_message_refs BEGIN SELECT RAISE(ABORT, 'inbox ref fault'); END",
	);
	try {
		await expect(consume()).rejects.toThrow("inbox ref fault");
	} finally {
		sqlite.exec("DROP TRIGGER fail_inbox_ref");
	}
	expect(state(accepted.id)).toMatchObject({ state: "queued", text: d.text });
	expect(childMessages()).toHaveLength(0);
	await consume();
	expect(state(accepted.id)).toMatchObject({ state: "materialized", text: "", adoptedAt: null });
	expect(childMessages()).toHaveLength(1);
	await consume();
	expect(childMessages()).toHaveLength(1);
});

test("post-commit WS failure never requeues the committed child delivery", async () => {
	const accepted = await pushSubagentBufferedMessage("child", "plain user");
	failBroadcast = true;
	expect(await consume()).not.toBeNull();
	failBroadcast = false;
	expect(state(accepted.id)?.state).toBe("materialized");
	await consume();
	expect(childMessages()).toHaveLength(1);
});

test("after-tools consumer preserves principal barrier and only materializes on adoption preparation", async () => {
	const accepted = await pushSubagentBufferedMessage("child", "new principal", { createdBy: null });
	await inbox.withInboxOwner("child", async () => {
		const result = await consumeBufferedSubagentMessageInPass({
			narratorId: "child",
			parentNarratorId: "parent",
			toolUseId: "origin",
			cwd: ".",
			currentUserId: "other",
		});
		expect(result?.text).toBe("new principal");
		expect(state(accepted.id)?.adoptedAt).toBeNull();
	});
});

test("completion outbox notices share the ordered consumer and restore only bounded immutable result", async () => {
	const first = delivery("child", "report before completion");
	await pushSubagentBufferedMessage("child", first.text, { delivery: first });
	const store = createPublicationOutbox(db);
	const run = {
		producerKind: "agent" as const,
		taskId: "sender",
		recipientId: "child",
		logicalRunId: "logical-notice",
	};
	store.reserveRunSlots(run);
	db.insert(narratorMessages)
		.values({
			id: "notice-result",
			narratorId: "sender",
			role: "disp",
			contentText: "z".repeat(15000),
			contentJson: [],
			createdAt: time,
		})
		.run();
	store.commitIntent({
		...run,
		eventKind: "completed",
		summary: "done preview",
		resultRef: "message:notice-result",
	});
	store.transferNext("child", "agent");
	const rows = inbox.listInboxRows("child");
	expect(rows.map((r) => r.kind)).toEqual(["agent_message", "task_notice"]);
	const notice = projectPendingInjection(required(rows[1]));
	if (notice.kind !== "bg_agent") throw new Error("wrong notice projection");
	expect(notice.task.result?.length).toBe(12000);
	expect(notice.task.resultTruncated).toBe(true);
	await consume();
	await consume();
	expect(childMessages()).toHaveLength(2);
	expect(inbox.listInboxRows("child")).toHaveLength(0);
	expect(childMessages()[1]?.parentToolUseId).toBe("origin");
});

test("accepted maximum Send body is stored once and a new clone provenance cannot send", () => {
	const text = "x".repeat(256 * 1024);
	const d = delivery("child", text);
	const accepted = inbox.enqueueInboxAgent(d, `[sender] ${text}`);
	expect(accepted.delivery.text.length).toBe(text.length);
	expect(accepted.delivery.metadataJson?.length).toBeLessThan(4096);
	const clone = delivery();
	db.update(narratorToolCalls)
		.set({ executionOriginToolCallId: d.senderToolCallBinding?.toolCallId })
		.where(eq(narratorToolCalls.id, required(clone.senderToolCallBinding).toolCallId))
		.run();
	expect(() => inbox.enqueueInboxAgent(clone, clone.text)).toThrow("receipt");
});

test("failed agent payloads still fill their quota without preventing user acceptance", async () => {
	for (let index = 0; index < 50; index++) inbox.enqueueInboxAgent(delivery(), "same words");
	const owner = tryClaimExecution("child", "subagent");
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = required(inbox.claimInboxHead("child", () => true));
		inbox.releaseInboxClaim(row, "preparation failed");
	}
	expect(() => inbox.enqueueInboxAgent(delivery(), "same words")).toThrow("full");
	expect((await enqueueBufferedMessage("child", "user quota remains available")).ok).toBe(true);
	owner?.release();
});

test("real parent after-tools notice callback is the adoption boundary, including after WS failure", async () => {
	const store = createPublicationOutbox(db);
	const run = {
		producerKind: "agent" as const,
		taskId: "sender",
		recipientId: "parent",
		logicalRunId: "adoption-notice",
	};
	store.reserveRunSlots(run);
	store.commitIntent({
		...run,
		eventKind: "completed",
		summary: "ready",
		resultRef: "narrator:sender:adoption-notice",
	});
	store.transferNext("parent", "agent");
	const row = required(inbox.listInboxRows("parent")[0]);
	failBroadcast = true;
	const projected = await drainInjectionsIntoHistory(
		{
			narratorId: "parent",
			_todoReminderCompletedToolCount: 0,
			_tasksReminderInterval: -1,
			_fenceInterval: -1,
		} as Parameters<typeof drainInjectionsIntoHistory>[0],
		"en",
	);
	failBroadcast = false;
	expect(projected.text).toContain("ready");
	expect(state(row.id)).toMatchObject({ state: "materialized", adoptedAt: null });
	projected.onConsumed();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(state(row.id)?.adoptedAt).not.toBeNull();
	expect(state(row.id)?.adoptedRevision).toBe(1);
});

test("immutable bounded notice snapshot ignores later edits and never parses oversized originals", () => {
	const store = createPublicationOutbox(db);
	const run = {
		producerKind: "agent" as const,
		taskId: "sender",
		recipientId: "parent",
		logicalRunId: "snapshot-run",
	};
	store.reserveRunSlots(run);
	db.insert(narratorMessages)
		.values({
			id: "bounded-snapshot",
			narratorId: "sender",
			role: "disp",
			contentText: "edited result",
			contentJson: [{ type: "text", text: "edited result" }],
			originalContentJson: [{ type: "text", text: "original result" }],
			createdAt: time,
		})
		.run();
	store.commitIntent({
		...run,
		eventKind: "completed",
		summary: "safe summary",
		resultRef: "message-original:bounded-snapshot",
	});
	store.transferNext("parent", "agent");
	const row = inbox.listInboxRows("parent")[0];
	if (!row) throw new Error("missing notice");
	let projected = projectPendingInjection(row);
	if (projected.kind !== "bg_agent") throw new Error("wrong kind");
	expect(projected.task.result).toBe("original result");
	db.update(narratorMessages)
		.set({ originalContentJson: [{ type: "text", text: "x".repeat(100000) }] })
		.where(eq(narratorMessages.id, "bounded-snapshot"))
		.run();
	projected = projectPendingInjection(row);
	if (projected.kind !== "bg_agent") throw new Error("wrong kind");
	expect(projected.task.result).toBeUndefined();
	expect(projected.task.resultPreview).toBe("safe summary");
});

test("late claim callback cannot materialize after shared owner replacement", async () => {
	const d = delivery("parent");
	inbox.enqueueInboxAgent(d, d.text, { channel: "parent" });
	const oldOwner = tryClaimExecution("parent", "primary");
	const row = inbox.claimInboxHead("parent", () => true);
	if (!row || !oldOwner) throw new Error("missing fixture claim");
	oldOwner.release();
	tryClaimExecution("parent", "primary");
	await expect(
		deliverPendingInjection("parent", "en", "busy", "onNextTurn", {
			...projectPendingInjection(row),
			mailboxClaim: inbox.inboxClaim(row),
			recipientMessageId: row.recipientMessageId ?? undefined,
		}),
	).rejects.toThrow("Stale mailbox execution owner");
	expect(state(row.id)?.state).toBe("claimed");
	expect(
		db.select().from(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, "parent")).all(),
	).toHaveLength(0);
	inbox.runtimeInbox.recoverClaims("parent", oldOwner.epoch, { ownerTerminated: true });
	expect(state(row.id)?.state).toBe("queued");
});

test("pre-prompt command stays queued at after-tools until a new pass can execute it", async () => {
	const accepted = await pushSubagentBufferedMessage("child", "after command", {
		prePromptBashCommand: "pwd",
	});
	await inbox.withInboxOwner("child", async () => {
		const result = await consumeBufferedSubagentMessageInPass({
			narratorId: "child",
			parentNarratorId: "parent",
			toolUseId: "origin",
			cwd: ".",
		});
		expect(result).toBeNull();
		expect(state(accepted.id)?.state).toBe("queued");
	});
});
