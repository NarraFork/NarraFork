import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { ComposerDocument } from "@shared/composer-document";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	backgroundTasks,
	fileChangeExecutionSegments,
	narratorBufferedMessages,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";
import { projectMessageSenderText } from "../../lib/agent/sender-projection";
import { delegationRegistration } from "../../lib/validators/runtime-registration";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));
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
const { activeNarrators } = await import("../narrator-session-state");
const { tryClaimExecution, getExecutionOwner } = await import("../agent-runtime/ownership");
const { createAgentMessageDelivery } = await import("../agent-message-delivery");
const { pushParentInboundMessage } = await import("../parent-inbound-queue");
const { drainPendingInjections, projectPendingInjection } = await import(
	"../parent-injection-queue"
);
const { closeNarrator, deliverPendingInjection, drainInjectionsIntoHistory } = await import(
	"../narrator-session"
);
const { deliverTeamMessage, drainTeamInbox, clearTeamInbox } = await import("../subagent-team");
/** Queue an agent message on the agent lane, the way Send does. */
async function pushAgentMessage(
	_narratorId: string,
	text: string,
	options: { delivery: import("../agent-message-delivery").AgentMessageDelivery; createdBy?: null },
) {
	const { enqueueInboxAgent } = await import("../agent-runtime/inbox");
	return (await enqueueInboxAgent(options.delivery, text, { createdBy: options.createdBy }))
		.delivery;
}
const {
	enqueueBufferedMessage,
	clearBufferedMessages,
	getBufferedMessages,
	getBufferedMessagesAsync,
	toBufferSummary,
	updateBufferedMessage,
} = await import("../narrator-buffer");
/** Queue user input on the session's mailbox, the way the HTTP admission does. */
function queueUserInput(
	narratorId: string,
	text: string,
	options: {
		textFiles?: File[];
		commandText?: string;
		fileReferences?: Parameters<typeof enqueueBufferedMessage>[9];
		composerDocument?: ComposerDocument;
	} = {},
) {
	return enqueueBufferedMessage(
		narratorId,
		text,
		undefined,
		options.commandText,
		undefined,
		null,
		options.textFiles,
		"back",
		undefined,
		options.fileReferences,
		"fifo",
		undefined,
		undefined,
		options.composerDocument,
	);
}
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { createPublicationOutbox } = await import("../agent-runtime/publication-outbox");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");
const time = "2026-09-09T00:00:00.000Z";
let serial = 0;
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Missing test fixture value");
	return value;
}
beforeEach(async () => {
	for (const id of ["parent", "child", "sender"]) {
		getExecutionOwner(id)?.release();
		// A wake builds an in-memory session; it would read as live work later.
		closeNarrator(id);
		activeNarrators.delete(id);
	}
	backgroundOccupancyStore.resetForTests();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	failBroadcast = false;
	for (const id of ["parent", "child", "sender"])
		db.insert(narrators)
			.values({
				id,
				type: id === "parent" ? "primary" : "subagent",
				variant: id === "parent" ? "primary" : "subagent:general",
				parentNarratorId: id === "parent" ? null : "parent",
				policySourceNarratorId: id === "parent" ? null : "parent",
				runtimeRegistrationJson:
					id === "parent" ? null : delegationRegistration("parent", "general"),
				createdAt: time,
				updatedAt: time,
			})
			.run();
	backgroundOccupancyStore.refreshNarrators(["parent", "child", "sender"]);
	await backgroundOccupancyStore.flush();
});
afterEach(async () => {
	await backgroundOccupancyStore.flush();
});
afterAll(() => {
	for (const id of ["parent", "child", "sender"]) getExecutionOwner(id)?.release();
	backgroundOccupancyStore.resetForTests();
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
function bindDeliverySource(value: ReturnType<typeof delivery>) {
	const call = required(
		db
			.select()
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, value.senderToolCallBinding?.toolCallId ?? ""))
			.get(),
	);
	const segmentId = `segment-${call.id}`;
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${call.id}`,
			narratorId: call.narratorId,
			messageId: call.messageId,
			seq: serial,
		})
		.run();
	db.insert(fileChangeExecutionSegments)
		.values({
			id: segmentId,
			narratorId: call.narratorId,
			sourceToolCallId: call.id,
			sourceExecutionAttempt: call.executionAttempt,
			createdAt: time,
		})
		.run();
	db.update(narratorToolCalls)
		.set({ executionSegmentId: segmentId })
		.where(eq(narratorToolCalls.id, call.id))
		.run();
	return {
		toolCallBinding: {
			toolCallId: call.id,
			attempt: call.executionAttempt,
			executionSegmentId: segmentId,
		},
		bindingToolUseId: call.toolUseId,
		bindingNarratorId: call.narratorId,
	};
}
/** The running session "child" whose run delivers to the parent's "origin" call. */
function childSession(currentUserId?: string | null) {
	return {
		narratorId: "child",
		cwd: ".",
		locale: "en",
		_currentUserId: currentUserId,
		_tasksReminderInterval: -1,
		_fenceInterval: -1,
	} as Parameters<typeof drainInjectionsIntoHistory>[0];
}
/** The one consumer a running pass uses at its tool boundary, as the run's owner. */
function consume(session = childSession()) {
	return inbox.withInboxOwner("child", () =>
		drainInjectionsIntoHistory(session, "en", {
			parentNarratorId: "parent",
			parentToolUseId: "origin",
		}),
	);
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

test("child list and summary never materialize the full staging document", async () => {
	const document: ComposerDocument = {
		version: 1,
		paragraphs: [{ children: [{ type: "text", text: "rich" }] }],
		assets: [],
	};
	const accepted = await queueUserInput("child", "rich", {
		composerDocument: document,
	});
	const path = JSON.parse(required(state(accepted.id)?.metadataJson)).composerDocumentPath;
	const original = await Bun.file(path).text();
	await Bun.write(path, "must not parse this full document in a summary");
	try {
		for (const messages of [
			await getBufferedMessages("child"),
			await getBufferedMessagesAsync("child"),
		]) {
			expect(toBufferSummary(messages)[0]?.hasComposerDocument).toBe(true);
			expect(JSON.stringify(toBufferSummary(messages))).not.toContain("paragraphs");
		}
	} finally {
		await Bun.write(path, original);
		await clearBufferedMessages("child");
	}
});

test("consumed Send recovers its own durable source receipt, not another wake trigger", async () => {
	const first = delivery("child", "first");
	const expected = bindDeliverySource(first);
	const second = delivery("child", "second");
	bindDeliverySource(second);
	const acceptedFirst = await inbox.enqueueInboxAgent(first, first.text);
	await inbox.enqueueInboxAgent(second, second.text);
	// The receipt resolves to the message's own sending call, never another trigger.
	expect(await inbox.resolveInboxExecutionBinding(acceptedFirst.delivery)).toEqual(expected);
	expect(expected.bindingNarratorId).toBe("sender");
	// Both are adopted, in arrival order, by the one consumer.
	const consumed = await consume();
	expect(consumed.text.indexOf("first")).toBeLessThan(consumed.text.indexOf("second"));
	expect(childMessages()).toHaveLength(2);
});

/** Observe run starts without executing a model pass. */
async function observeRunStarts() {
	const runModule = await import("../agent-runtime/run");
	const calls: Array<Record<string, unknown>> = [];
	const idle = Promise.resolve({
		started: true,
		output: "",
		finalText: "",
		hasError: false,
		interrupted: false,
		timedOut: false,
	});
	const spy = spyOn(runModule, "startNarratorRun").mockImplementation(async (request) => {
		calls.push({ ...request, sessionUser: request.active?._currentUserId });
		return { started: true, foreground: idle, terminal: idle, completion: idle };
	});
	return { calls, restore: () => spy.mockRestore() };
}

test("an eligible queue wake starts the session's ordinary run; the Send changes no identity", async () => {
	const value = delivery("child", "queued followup");
	bindDeliverySource(value);
	db.update(narrators)
		.set({
			status: "idle",
			cwd: process.env.HOME,
			runtimeRegistrationJson: {
				version: 1,
				run: { logicalRunId: "anonymous-wake-run", principal: { userId: null } },
			},
		})
		.where(eq(narrators.id, "child"))
		.run();
	await inbox.enqueueInboxAgent(value, value.text, { createdBy: null, userId: null });
	const runs = await observeRunStarts();
	try {
		expect(await inbox.wakeInboxIfEligible("child")).toBe(true);
		// The message is already in history; the run starts with no new relationships
		// and does not execute as the sender.
		expect(runs.calls).toHaveLength(1);
		expect(runs.calls[0]).toMatchObject({ narratorId: "child", text: "" });
		expect(runs.calls[0].binding).toBeUndefined();
		expect(runs.calls[0].principal).toBeNull();
		expect(
			childMessages().some((message) => message.contentText?.includes("queued followup")),
		).toBe(true);
	} finally {
		runs.restore();
	}
});

test("retired mailbox attempt remains unattributed instead of adopting creation or a newer attempt", async () => {
	const value = delivery("child", "old queued followup");
	bindDeliverySource(value);
	const accepted = await inbox.enqueueInboxAgent(value, value.text);
	db.update(narratorToolCalls)
		.set({ executionAttempt: 2 })
		.where(eq(narratorToolCalls.id, value.senderToolCallBinding?.toolCallId ?? ""))
		.run();
	expect(await inbox.resolveInboxExecutionBinding(accepted.delivery)).toBeNull();
	// An unattributed message is still adopted; it just borrows no execution identity.
	expect((await consume()).text).toContain("old queued followup");
});

test("receipt lookup failure cannot discard an already durable message", async () => {
	const value = delivery("child", "keep this input");
	bindDeliverySource(value);
	const accepted = await inbox.enqueueInboxAgent(value, value.text);
	const lookup = spyOn(db.query.narratorToolCalls, "findFirst").mockImplementation(() => {
		throw new Error("receipt lookup unavailable");
	});
	try {
		expect(await inbox.resolveInboxExecutionBinding(accepted.delivery)).toBeNull();
		expect(state(accepted.delivery.id)?.state).toBe("queued");
	} finally {
		lookup.mockRestore();
	}
	expect(await inbox.resolveInboxExecutionBinding(accepted.delivery)).toEqual(
		expect.objectContaining({
			toolCallBinding: expect.objectContaining({
				toolCallId: value.senderToolCallBinding?.toolCallId,
			}),
		}),
	);
	expect((await consume()).text).toContain("keep this input");
});

test("real Send to an idle session wakes its ordinary run as its own principal", async () => {
	const value = delivery("child", "from Send");
	const expected = bindDeliverySource(value);
	db.update(narrators)
		.set({
			status: "idle",
			cwd: process.env.HOME,
			ownerUserId: null,
			runtimeRegistrationJson: {
				version: 1,
				run: {
					logicalRunId: "child-run",
					deliverTo: { narratorId: "parent", toolUseId: "origin" },
					principal: { userId: null },
				},
			},
		})
		.where(eq(narrators.id, "child"))
		.run();
	const runs = await observeRunStarts();
	try {
		const { sendSubagentMessageDetailed } = await import("../agent-communication");
		await sendSubagentMessageDetailed({
			callerNarratorId: "sender",
			id: "child",
			toolUseId: expected.bindingToolUseId,
			toolCallBinding: expected.toolCallBinding,
			message: "from Send",
			signal: new AbortController().signal,
			locale: "en",
			userId: "sender-user",
		});
		expect(runs.calls).toHaveLength(1);
		expect(runs.calls[0]).toMatchObject({ narratorId: "child", text: "" });
		// The sender's user is the message author only: never the run's principal.
		expect(runs.calls[0].principal).toBeNull();
		expect(runs.calls[0].sessionUser).not.toBe("sender-user");
	} finally {
		runs.restore();
	}
});

test("Send queued while the target's run ends re-wakes it instead of stranding the message", async () => {
	const value = delivery("child", "late correction");
	const expected = bindDeliverySource(value);
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "child")).run();
	const owner = required(tryClaimExecution("child", "run"));
	activeNarrators.set("child", {} as never);
	const enqueue = inbox.enqueueInboxAgent;
	// The run finishes in the window between Send reading `working` and the enqueue.
	const enqueueSpy = spyOn(inbox, "enqueueInboxAgent").mockImplementation(async (...args) => {
		const accepted = await enqueue(...args);
		activeNarrators.delete("child");
		owner.release();
		return accepted;
	});
	const woken: string[] = [];
	const wakeSpy = spyOn(inbox, "wakeInboxIfEligible").mockImplementation(async (id) => {
		woken.push(id);
		return true;
	});
	try {
		const { sendSubagentMessageDetailed } = await import("../agent-communication");
		const result = await sendSubagentMessageDetailed({
			callerNarratorId: "sender",
			id: "child",
			toolUseId: expected.bindingToolUseId,
			toolCallBinding: expected.toolCallBinding,
			message: "late correction",
			signal: new AbortController().signal,
			locale: "en",
		});
		expect(result.targets[0]?.status).toBe("queued");
		await Promise.resolve();
		expect(woken).toEqual(["child"]);
	} finally {
		enqueueSpy.mockRestore();
		wakeSpy.mockRestore();
		activeNarrators.delete("child");
		owner.release();
	}
});

test("idle injection claim stops at an earlier user input", async () => {
	const store = createMailboxStore(db);
	const earlier = store.enqueue({
		kind: "user_input",
		narratorId: "parent",
		text: "earlier user input",
		projectedByteSize: 20,
	});
	const later = store.enqueue({
		kind: "task_notice",
		noticeKind: "agent",
		narratorId: "parent",
		sourceKey: "later-cancelled-notice",
		text: "cancelled task",
		projectedByteSize: 16,
		metadata: {
			producerKind: "agent",
			taskId: "cancelled-task",
			logicalRunId: "cancelled-run",
			eventKind: "cancelled",
		},
	});
	if (!("delivery" in earlier) || !("delivery" in later)) throw new Error("failed to seed mailbox");
	const owner = tryClaimExecution("parent", "tool-replay");
	if (!owner) throw new Error("missing execution owner");
	try {
		expect(
			await inbox.claimInboxHead("parent", (candidate) => candidate.kind !== "user_input"),
		).toBeUndefined();
		expect(state(later.delivery.id)?.state).toBe("queued");
	} finally {
		owner.release();
	}
});

test("parent/team/child producers persist into the same mailbox, read projections do not consume", async () => {
	const parent = delivery("parent");
	await pushParentInboundMessage("parent", {
		delivery: parent,
		fromId: "sender",
		fromTitle: "Sender",
		fromType: "general",
		fromToolUseId: parent.fromToolUseId,
		text: parent.text,
		timestamp: time,
	});
	expect(await drainPendingInjections("parent")).toHaveLength(1);
	expect(await drainPendingInjections("parent")).toHaveLength(1);
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "child")).run();
	backgroundOccupancyStore.refreshNarrator("child");
	await backgroundOccupancyStore.flush();
	const teamOwner = required(tryClaimExecution("child", "run"));
	const team = delivery();
	await deliverTeamMessage(
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
	const buffered = await pushAgentMessage("child", "[sender] next", {
		delivery: delivery("child", "next"),
	});
	expect(await drainTeamInbox("child")).toHaveLength(2);
	clearTeamInbox("child");
	expect(await inbox.listInboxRows("child")).toHaveLength(2);
	expect(state(buffered.id)?.kind).toBe("agent_message");
	expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(3);
	teamOwner.release();
});

test("broadcast-only inbox never authorizes a wake, regardless of persisted recipient status", async () => {
	for (const status of ["idle", "working", "waiting"] as const) {
		for (const id of ["parent", "child"]) {
			db.update(narrators).set({ status }).where(eq(narrators.id, id)).run();
			backgroundOccupancyStore.refreshNarrator(id);
			await backgroundOccupancyStore.flush();
			const d = delivery(id);
			await inbox.enqueueInboxAgent(d, d.text, { isBroadcast: true });
			expect(await inbox.hasWakeEligibleInboxInput(id)).toBe(false);
			expect(await inbox.wakeInboxIfEligible(id)).toBe(false);
			expect(getExecutionOwner(id)).toBeUndefined();
		}
	}
	expect(await inbox.listInboxRows("child")).toHaveLength(3);
});

test("explicit Send and user input behind a broadcast still authorize the correct wake", async () => {
	const session = await import("../narrator-session");
	const continuation = spyOn(session, "startParentInboundContinuationIfPossible").mockResolvedValue(
		{
			started: true,
		},
	);
	const buffered = spyOn(session, "resumeBufferedMessagesIfIdle").mockResolvedValue({
		resumed: true,
	});
	try {
		const broadcast = delivery("parent");
		await inbox.enqueueInboxAgent(broadcast, broadcast.text, { isBroadcast: true });
		expect(await inbox.wakeInboxIfEligible("parent")).toBe(false);
		expect(continuation).not.toHaveBeenCalled();
		const direct = delivery("parent");
		await inbox.enqueueInboxAgent(direct, direct.text);
		expect(await inbox.hasWakeEligibleInboxInput("parent")).toBe(true);
		expect(await inbox.wakeInboxIfEligible("parent")).toBe(true);
		expect(continuation).toHaveBeenCalledTimes(1);
		await enqueueBufferedMessage("parent", "explicit user");
		expect(await inbox.wakeInboxIfEligible("parent")).toBe(true);
		expect(buffered).toHaveBeenCalledTimes(1);
	} finally {
		continuation.mockRestore();
		buffered.mockRestore();
	}
});

test("broadcast arriving during the publication barrier cannot authorize a deferred wake", async () => {
	const { runtimePublication } = await import("../agent-runtime/publication");
	let publication: ReturnType<typeof inbox.enqueueInboxAgent> | undefined;
	const flush = spyOn(runtimePublication, "flushRecipient").mockImplementation(async (id) => {
		const d = delivery(id);
		// SQLite admission commits synchronously; the facade wraps that result in a Promise.
		publication = inbox.enqueueInboxAgent(d, d.text, { isBroadcast: true });
		return 0;
	});
	try {
		expect(await inbox.wakeInboxIfEligible("child")).toBe(false);
		expect(flush).toHaveBeenCalled();
		await publication;
		expect(await inbox.listInboxRows("child")).toHaveLength(1);
		expect(getExecutionOwner("child")).toBeUndefined();
	} finally {
		flush.mockRestore();
	}
});

test("live runner consumes broadcast without granting a future wake", async () => {
	const d = delivery();
	const accepted = await inbox.enqueueInboxAgent(d, d.text, { isBroadcast: true, channel: "team" });
	const owner = required(tryClaimExecution("child", "run"));
	try {
		expect((await consume()).text).toContain(d.text);
		expect(state(accepted.delivery.id)?.state).toBe("materialized");
	} finally {
		owner.release();
	}
	expect(await inbox.wakeInboxIfEligible("child")).toBe(false);
});

test("foreign-process broadcast claim recovery requeues without waking historical work", async () => {
	const d = delivery();
	const accepted = await inbox.enqueueInboxAgent(d, d.text, { isBroadcast: true });
	db.update(narratorBufferedMessages)
		.set({ state: "claimed", claimToken: "process:dead-broadcast:token", claimEpoch: "old" })
		.where(eq(narratorBufferedMessages.id, accepted.delivery.id))
		.run();
	expect(await inbox.recoverInboxClaimsOnColdStartup()).toBe(1);
	expect(state(accepted.delivery.id)?.state).toBe("queued");
	expect(await inbox.wakeInboxIfEligible("child")).toBe(false);
});

test("source receipt is mandatory; exact retry returns original navigation and negative tombstone", async () => {
	const d = delivery();
	const accepted = await inbox.enqueueInboxAgent(d, `[prefix] ${d.text}`);
	inbox.runtimeInbox.cancel(accepted.delivery.deliveryId as string, "cancelled");
	db.delete(narratorToolCalls)
		.where(eq(narratorToolCalls.id, required(d.senderToolCallBinding).toolCallId))
		.run();
	const retry = { ...d, recipientMessageId: "discarded-new-id", text: "x".repeat(300_000) };
	expect((await inbox.enqueueInboxAgent(retry, retry.text)).status).toBe("duplicate");
	expect(retry.recipientMessageId).toBe(d.recipientMessageId);
	expect(await inbox.runtimeInbox.list("child")).toHaveLength(1);
	await expect(
		inbox.enqueueInboxAgent({ ...d, senderToolCallBinding: undefined }, d.text),
	).rejects.toThrow("receipt");
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
	const agentInput = await pushAgentMessage("child", d.text, { delivery: d });
	const owner = tryClaimExecution("child", "run");
	expect(
		await inbox.claimInboxHead("child", (row) => row.kind === "agent_message"),
	).toBeUndefined();
	expect(await updateBufferedMessage("child", agentInput.id, "forged user")).toBe(false);
	expect((await getBufferedMessages("child")).map((m) => m.id)).toEqual([user.id]);
	await clearBufferedMessages("child");
	expect(state(user.id)?.state).toBe("cancelled");
	expect(state(agentInput.id)?.state).toBe("queued");
	expect((await inbox.claimInboxHead("child", () => true))?.claimEpoch).toBe(owner?.epoch);
});

test("parent real delivery commits history/ref/materialization together and keeps unadopted receipt", async () => {
	const d = delivery("parent");
	await inbox.enqueueInboxAgent(d, d.text, { channel: "parent" });
	await inbox.withInboxOwner("parent", async () => {
		const row = required(await inbox.claimInboxHead("parent", () => true));
		const deliveredParts: Array<{ text: string; messageId?: string }> = [];
		const text = await deliverPendingInjection(
			"parent",
			"en",
			"busy",
			"onNextTurn",
			{
				...projectPendingInjection(row),
				mailboxClaim: inbox.inboxClaim(row),
				recipientMessageId: required(row.recipientMessageId),
			},
			undefined,
			(part) => deliveredParts.push(part),
		);
		expect(deliveredParts).toEqual([
			{ text: required(text), messageId: required(state(row.id)?.currentMessageId) },
		]);
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
	const accepted = await pushAgentMessage("child", `[sender] ${d.text}`, {
		delivery: d,
	});
	sqlite.exec(
		"CREATE TEMP TRIGGER fail_inbox_ref BEFORE INSERT ON narrator_message_refs BEGIN SELECT RAISE(ABORT, 'inbox ref fault'); END",
	);
	try {
		// A failed row is released, not dropped: nothing is adopted this boundary.
		expect((await consume()).text).not.toContain(d.text);
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
	const value = delivery("child", "plain agent words");
	const accepted = await pushAgentMessage("child", value.text, { delivery: value });
	failBroadcast = true;
	expect((await consume()).text).toContain(value.text);
	failBroadcast = false;
	expect(state(accepted.id)?.state).toBe("materialized");
	await consume();
	expect(childMessages()).toHaveLength(1);
});

test("after-tools consumer preserves principal barrier and only materializes on adoption preparation", async () => {
	// In-pass adoption is an agent-delivery path; explicit user queue modes intentionally
	// restart a pass. Keep this fixture on the path the assertion is testing.
	const value = delivery("child", "new principal");
	const accepted = await pushAgentMessage("child", "new principal", {
		createdBy: null,
		delivery: value,
	});
	// The session runs as another user: an agent Send is still adopted mid-pass and
	// does not become the run's principal.
	const result = await consume(childSession("other"));
	expect(result.text).toContain("new principal");
	expect(result.parts.map((part) => part.messageId)).toEqual([required(childMessages()[0]?.id)]);
	expect(result.parts[0]?.messageId).not.toBe(accepted.id);
	expect(state(accepted.id)?.adoptedAt).toBeNull();
});

// Knowledge hints are produced by the pass itself (orchestrator), not by the drain; the
// end-to-end hint is covered in subagent-knowledge-injection. Here: the drained part is the
// durable input row, and every provider replays exactly that row.
test("tool-boundary drain parts are the durable buffered input and replay as such", async () => {
	// cleanDb clears the installation marker, not the shipped revision triggers. Restore
	// this private fixture row so replay uses the real loader's trusted source contract.
	const { MODEL_HISTORY_REVISION_CONTRACT } = await import(
		"../agent-runtime/model-history-revision-sql"
	);
	const { readSqliteModelHistorySignature } = await import(
		"../agent-runtime/model-history-revision"
	);
	sqlite
		.query(
			"INSERT INTO model_history_revision_contracts (id, installed_version) VALUES ('model-history', ?)",
		)
		.run(MODEL_HISTORY_REVISION_CONTRACT);
	expect(readSqliteModelHistorySignature(sqlite, "child").trusted).toBe(true);
	const value = delivery("child", "buffered message");
	const accepted = await pushAgentMessage("child", value.text, { delivery: value });
	const projected = await consume();
	// An agent Send is materialized as one injection row of the recipient's history.
	const rows = childMessages();
	expect(rows).toHaveLength(1);
	const userMessage = required(rows[0]);
	expect(projected.parts).toEqual([
		{
			text: projectMessageSenderText(userMessage, userMessage.contentText ?? ""),
			messageId: userMessage.id,
		},
	]);
	expect(projected.parts.map((part) => part.text).join("\n\n")).toBe(projected.text);
	expect(projected.parts[0]?.messageId).not.toBe(accepted.id);
	expect(userMessage.parentToolUseId).toBe("origin");
	expect(state(accepted.id)?.adoptedAt).toBeNull();

	const { settings } = await import("../../lib/settings");
	const originalProviders = settings.openaiProviders;
	const agentModule = await import("../../lib/agent");
	const realBuilder = spyOn(agentModule, "buildHistory").mockImplementation(agent.buildHistory);
	try {
		settings.openaiProviders = (["responses", "completions"] as const).map((apiMode) => ({
			id: `buffered-replay-${apiMode}`,
			name: "Buffered replay fixture",
			prefix: `buffered-replay-${apiMode}`,
			apiKey: "isolated-test-no-network",
			baseUrl: "https://example.invalid/v1",
			defaultModel: "gpt-5",
			apiMode,
		}));
		const { buildRuntimeHistory } = await import("../agent-runtime/history");
		for (const apiMode of ["responses", "completions"] as const) {
			const rebuilt = await buildRuntimeHistory({
				narratorId: "child",
				ownTurnPlacement: "origin",
				model: "gpt-5",
				provider: `buffered-replay-${apiMode}`,
			});
			expect(JSON.stringify(rebuilt.history)).toContain(value.text);
			expect(rebuilt.replayedInjectionMessageIds).toEqual([userMessage.id]);
		}
	} finally {
		realBuilder.mockRestore();
		settings.openaiProviders = originalProviders;
	}
});

test("completion outbox notices share the ordered consumer and restore only bounded immutable result", async () => {
	const first = delivery("child", "report before completion");
	await pushAgentMessage("child", first.text, { delivery: first });
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
	const rows = await inbox.listInboxRows("child");
	expect(rows.map((r) => r.kind)).toEqual(["agent_message", "task_notice"]);
	const notice = projectPendingInjection(required(rows[1]));
	if (notice.kind !== "bg_agent") throw new Error("wrong notice projection");
	expect(notice.task.result?.length).toBe(12000);
	expect(notice.task.resultTruncated).toBe(true);
	await consume();
	await consume();
	expect(childMessages()).toHaveLength(2);
	expect(await inbox.listInboxRows("child")).toHaveLength(0);
	expect(childMessages()[1]?.parentToolUseId).toBe("origin");
});

test("accepted maximum Send body is stored once and a new clone provenance cannot send", async () => {
	const text = "x".repeat(256 * 1024);
	const d = delivery("child", text);
	const accepted = await inbox.enqueueInboxAgent(d, `[sender] ${text}`);
	expect(accepted.delivery.text.length).toBe(text.length);
	expect(accepted.delivery.metadataJson?.length).toBeLessThan(4096);
	const clone = delivery();
	db.update(narratorToolCalls)
		.set({ executionOriginToolCallId: d.senderToolCallBinding?.toolCallId })
		.where(eq(narratorToolCalls.id, required(clone.senderToolCallBinding).toolCallId))
		.run();
	await expect(inbox.enqueueInboxAgent(clone, clone.text)).rejects.toThrow("receipt");
});

test("failed agent payloads still fill their quota without preventing user acceptance", async () => {
	for (let index = 0; index < 50; index++) await inbox.enqueueInboxAgent(delivery(), "same words");
	const owner = tryClaimExecution("child", "run");
	for (let attempt = 0; attempt < 3; attempt++) {
		const row = required(await inbox.claimInboxHead("child", () => true));
		await inbox.releaseInboxClaim(row, "preparation failed");
	}
	await expect(inbox.enqueueInboxAgent(delivery(), "same words")).rejects.toThrow("full");
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
	const row = required((await inbox.listInboxRows("parent"))[0]);
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
	expect(projected.text).toContain("This notice could not load the result.");
	expect(projected.text).toContain("Await(");
	expect(projected.parts).toEqual([
		{ text: projected.text, messageId: required(state(row.id)?.currentMessageId) },
	]);
	expect(projected.parts.map((part) => part.text).join("\n\n")).toBe(projected.text);
	expect(state(row.id)).toMatchObject({ state: "materialized", adoptedAt: null });
	projected.onConsumed();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(state(row.id)?.adoptedAt).not.toBeNull();
	expect(state(row.id)?.adoptedRevision).toBe(1);
});

test("after-tools parts keep equal Send bodies as distinct ordered durable messages", async () => {
	const first = delivery("parent", "identical reports");
	const second = delivery("parent", "identical reports");
	await inbox.enqueueInboxAgent(first, first.text, { channel: "parent" });
	await inbox.enqueueInboxAgent(second, second.text, { channel: "parent" });
	const rows = await inbox.listInboxRows("parent");
	const projected = await drainInjectionsIntoHistory(
		{
			narratorId: "parent",
			_tasksReminderInterval: -1,
			_fenceInterval: -1,
		} as Parameters<typeof drainInjectionsIntoHistory>[0],
		"en",
	);
	expect(projected.parts).toHaveLength(2);
	expect(projected.parts.map((part) => part.text).join("\n\n")).toBe(projected.text);
	expect(projected.parts.map((part) => part.messageId)).toEqual(
		rows.map((row) => required(state(row.id)?.currentMessageId)),
	);
	expect(projected.parts[0]?.messageId).not.toBe(projected.parts[1]?.messageId);
	expect(projected.parts[0]?.text).toBe(projected.parts[1]?.text);
	for (const row of rows) expect(state(row.id)?.adoptedAt).toBeNull();
});

for (const narratorId of ["parent", "child"] as const) {
	test(`${narratorId} task, fence and spec-update parts retain each persisted source`, async () => {
		const { specVfsService } = await import("../spec-vfs-service");
		const { pushSpecUpdateForNarrator } = await import("../spec-update-queue");
		await specVfsService.writeSpecFile(
			narratorId,
			"spec://tasks.json",
			JSON.stringify({ tasks: [{ text: "current fixture task", status: "doing" }] }),
		);
		await specVfsService.writeSpecFile(narratorId, "spec://behavior_fence", "fixture constraint", {
			actor: "user",
		});
		pushSpecUpdateForNarrator(narratorId, {
			uri: "spec://notes.txt",
			path: "notes.txt",
			revisionId: null,
			updatedBy: "user",
			preview: "updated fixture note",
			taskSummary: null,
			timestamp: time,
		});
		const subagent =
			narratorId === "child"
				? { parentNarratorId: "parent", parentToolUseId: "origin" }
				: undefined;
		const projected = await drainInjectionsIntoHistory(
			{
				narratorId,
				cwd: ".",
				_todoReminderCompletedToolCount: 1,
				_lastTasksReminderCompletedToolCount: 0,
				_lastFenceCompletedToolCount: 0,
				_tasksReminderInterval: 1,
				_fenceInterval: 1,
			} as Parameters<typeof drainInjectionsIntoHistory>[0],
			"en",
			subagent,
		);
		expect(projected.parts).toHaveLength(3);
		expect(projected.parts.map((part) => part.text).join("\n\n")).toBe(projected.text);
		const sources = projected.parts.map((part) => {
			const message = required(
				db
					.select()
					.from(narratorMessages)
					.where(eq(narratorMessages.id, required(part.messageId)))
					.get(),
			);
			expect(message.narratorId).toBe(narratorId);
			expect(message.parentToolUseId).toBe(subagent?.parentToolUseId ?? null);
			expect(part.text).toBe(projectMessageSenderText(message, message.contentText ?? ""));
			return (message.contentJson as Array<{ type: string; source?: string }>).find(
				(block) => block.type === "system_injection",
			)?.source;
		});
		expect(sources).toEqual(["living_work_spec", "behavior_fence", "spec_update"]);
	});
}

for (const kind of ["bg_agent", "bg_bash"] as const) {
	for (const mode of ["busy", "idle"] as const) {
		test(`${kind} ${mode} completion hints only when task work is exhausted`, async () => {
			const { t } = await import("../../lib/i18n");
			const hint = t("sidecar.noActiveBackgroundTasks", "en");
			const entry = {
				kind,
				task: {
					id: "finished",
					type: "bash" as const,
					alias: "finished",
					title: "Finished work",
					status: "completed",
					result: "saved result",
					resultPreview: "saved result",
					outputPreview: "saved result",
				},
			};
			const deliver = (locale: "en" | "zh-CN" = "en") =>
				deliverPendingInjection("parent", locale, mode, "none", entry);
			const seed = (id: string, parentNarratorId: string, backgroundKind: "task" | "service") => {
				db.insert(backgroundTasks)
					.values({
						id,
						parentNarratorId,
						backgroundKind,
						type: "bash",
						status: "running",
						startedAt: time,
						createdAt: time,
						updatedAt: time,
					})
					.run();
				backgroundOccupancyStore.refreshTask(id);
			};

			// A different session's task and this session's long-lived service do not block it.
			db.insert(narrators)
				.values({ id: "unrelated", variant: "primary", createdAt: time, updatedAt: time })
				.run();
			backgroundOccupancyStore.refreshNarrator("unrelated");
			seed("other-task", "unrelated", "task");
			seed("dev-server", "parent", "service");
			await backgroundOccupancyStore.flush();
			expect((await deliver())?.endsWith(hint)).toBe(true);
			expect(
				(await deliver("zh-CN"))?.endsWith(t("sidecar.noActiveBackgroundTasks", "zh-CN")),
			).toBe(true);
			const persisted = db
				.select()
				.from(narratorMessages)
				.where(eq(narratorMessages.narratorId, "parent"))
				.all();
			expect(persisted.some((row) => row.contentText?.endsWith(hint))).toBe(true);

			seed("remaining-task", "parent", "task");
			await backgroundOccupancyStore.flush();
			expect(await deliver()).not.toContain(hint);
			db.update(backgroundTasks)
				.set({ status: "completed" })
				.where(eq(backgroundTasks.id, "remaining-task"))
				.run();
			backgroundOccupancyStore.refreshTask("remaining-task");
			await backgroundOccupancyStore.flush();
			expect((await deliver())?.endsWith(hint)).toBe(true);
			// A still-running subagent blocks the hint too, including legacy agents without task rows.
			db.update(narrators)
				.set({ status: "working", isBackground: true, backgroundStatus: "running" })
				.where(eq(narrators.id, "child"))
				.run();
			backgroundOccupancyStore.refreshNarrator("child");
			await backgroundOccupancyStore.flush();
			expect(await deliver()).not.toContain(hint);
			db.update(narrators)
				.set({ status: "idle", backgroundStatus: "completed" })
				.where(eq(narrators.id, "child"))
				.run();
			backgroundOccupancyStore.refreshNarrator("child");
			await backgroundOccupancyStore.flush();
			expect((await deliver())?.endsWith(hint)).toBe(true);
			// Taken-over agents remain outstanding even when parked idle and their
			// historical task row is terminal. Cover legacy and registered agents.
			for (const registered of [false, true]) {
				if (registered) {
					db.insert(backgroundTasks)
						.values({
							id: "child-task",
							parentNarratorId: "parent",
							type: "agent",
							subagentNarratorId: "child",
							status: "completed",
							startedAt: time,
							createdAt: time,
							updatedAt: time,
						})
						.run();
					backgroundOccupancyStore.refreshTask("child-task");
					await backgroundOccupancyStore.flush();
				}
				for (const status of ["idle", "working", "waiting"] as const) {
					db.update(narrators)
						.set({ status, isBackground: false, substatus: JSON.stringify(["taken_over"]) })
						.where(eq(narrators.id, "child"))
						.run();
					backgroundOccupancyStore.refreshNarrator("child");
					await backgroundOccupancyStore.flush();
					expect(await deliver()).not.toContain(hint);
				}
				// Releasing takeover and returning the result finally exhausts the work.
				db.update(narrators)
					.set({ status: "idle", substatus: "[]", backgroundStatus: "completed" })
					.where(eq(narrators.id, "child"))
					.run();
				backgroundOccupancyStore.refreshNarrator("child");
				await backgroundOccupancyStore.flush();
				expect((await deliver())?.endsWith(hint)).toBe(true);
			}
			for (const status of ["started", "running", "failed", "cancelled", "timeout"]) {
				entry.task.status = status;
				expect(await deliver()).not.toContain(hint);
			}
		});
	}
}

test("immutable bounded notice snapshot ignores later edits and never parses oversized originals", async () => {
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
	const row = (await inbox.listInboxRows("parent"))[0];
	if (!row) throw new Error("missing notice");
	let projected = projectPendingInjection(row);
	if (projected.kind !== "bg_agent") throw new Error("wrong kind");
	expect(projected.task.result).toBe("original result");
	for (const mode of ["busy", "idle"] as const) {
		const text = await deliverPendingInjection("parent", "en", mode, "none", projected);
		expect(text).toContain("Result:\noriginal result");
		expect(text).not.toContain("Await(");
	}

	db.update(narratorMessages)
		.set({ originalContentJson: [{ type: "text", text: "x".repeat(100000) }] })
		.where(eq(narratorMessages.id, "bounded-snapshot"))
		.run();
	projected = projectPendingInjection(row);
	if (projected.kind !== "bg_agent") throw new Error("wrong kind");
	expect(projected.task.result).toBeUndefined();
	expect(projected.task.resultPreview).toBe("safe summary");
});

test("Await-revoked terminal claim is a benign empty projection and does not block following Send", async () => {
	const store = createPublicationOutbox(db);
	const run = {
		producerKind: "agent" as const,
		taskId: "sender",
		recipientId: "parent",
		logicalRunId: "await-revoked",
	};
	store.reserveRunSlots(run);
	store.commitIntent({
		...run,
		eventKind: "completed",
		summary: "duplicate terminal",
		resultRef: "narrator:sender:await-revoked",
	});
	store.transferNext("parent", "agent");
	await inbox.withInboxOwner("parent", async () => {
		const row = required(await inbox.claimInboxHead("parent", () => true));
		const projected = {
			...projectPendingInjection(row),
			mailboxClaim: inbox.inboxClaim(row),
			recipientMessageId: row.recipientMessageId ?? undefined,
		};
		store.consumeAwaitedTerminal(run);
		const deliveredParts: Array<{ text: string; messageId?: string }> = [];
		expect(
			await deliverPendingInjection(
				"parent",
				"en",
				"busy",
				"onNextTurn",
				projected,
				undefined,
				(part) => deliveredParts.push(part),
			),
		).toBe("");
		expect(deliveredParts).toEqual([{ text: "", messageId: undefined }]);
		expect(state(row.id)?.state).toBe("cancelled");
		expect(
			db
				.select()
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, "parent"))
				.all(),
		).toHaveLength(0);
		const next = delivery("parent", "following Send is retained");
		await inbox.enqueueInboxAgent(next, next.text, { channel: "parent" });
		const send = required(await inbox.claimInboxHead("parent", () => true));
		const text = await deliverPendingInjection("parent", "en", "busy", "onNextTurn", {
			...projectPendingInjection(send),
			mailboxClaim: inbox.inboxClaim(send),
			recipientMessageId: send.recipientMessageId ?? undefined,
		});
		expect(text).toContain("following Send is retained");
		expect(state(send.id)?.state).toBe("materialized");
	});
});

test("late claim callback cannot materialize after shared owner replacement", async () => {
	const d = delivery("parent");
	await inbox.enqueueInboxAgent(d, d.text, { channel: "parent" });
	const oldOwner = tryClaimExecution("parent", "run");
	const row = await inbox.claimInboxHead("parent", () => true);
	if (!row || !oldOwner) throw new Error("missing fixture claim");
	oldOwner.release();
	tryClaimExecution("parent", "run");
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
	const accepted = await enqueueBufferedMessage(
		"child",
		"after command",
		undefined,
		null,
		null,
		null,
		undefined,
		"back",
		"pwd",
	);
	const result = await consume();
	expect(result.text).not.toContain("after command");
	expect(state(accepted.id)?.state).toBe("queued");
});

// A Send that arrives while the recipient's run is executing: adopted at the next tool
// boundary of that same run (never a new run), withheld while its materialization fails,
// and delivered exactly once afterwards. Real run service and orchestrator; only the
// model pass is scripted. The sender's identity never becomes the run's principal.
for (const shape of ["delegated", "unrelated"] as const) {
	test(`running ${shape} session adopts a Send at its tool boundary once, as its own principal`, async () => {
		const narratorExecutor = await import("../narrator-executor");
		const { settings } = await import("../../lib/settings");
		const { startNarratorRun } = await import("../agent-runtime/run");
		const previous = settings.anthropicProviders;
		settings.anthropicProviders = [
			{
				id: "boundary-provider",
				name: "Boundary test",
				prefix: "boundary-test",
				apiKey: "test-only",
				baseUrl: "https://example.invalid/v1",
				defaultModel: "claude-sonnet-4",
				officialApi: false,
			},
		];
		db.update(narrators)
			.set({
				status: "idle",
				cwd: process.env.HOME,
				model: "boundary-test:claude-sonnet-4",
				autoContinuationOverride: "off",
				// Same registered destination either way; only the parent link differs.
				...(shape === "unrelated"
					? { parentNarratorId: null, type: "primary", variant: "primary" }
					: {}),
				runtimeRegistrationJson: {
					version: 1,
					run: {
						logicalRunId: "boundary-run",
						deliverTo: { narratorId: "parent", toolUseId: "origin" },
					},
				},
			})
			.where(eq(narrators.id, "child"))
			.run();
		const texts: Array<string | undefined> = [];
		let queuedAfterFailure = 0;
		let principalDuringPass: string | null | undefined;
		const text = (
			value:
				| Awaited<
						ReturnType<
							NonNullable<import("../../lib/agent/types").AgentConfig["getAfterToolsInjections"]>
						>
				  >
				| undefined,
		) => (typeof value === "string" ? value : value?.text);
		const executor = spyOn(narratorExecutor, "executeAgentLoop").mockImplementation(
			async (input) => {
				// The Send arrives mid-pass, as the sender's user.
				const value = delivery("child", "mid-run report");
				bindDeliverySource(value);
				await inbox.enqueueInboxAgent(value, value.text, {
					createdBy: null,
					userId: "sender-user",
				});
				sqlite.run(`CREATE TEMP TRIGGER fail_boundary_ref BEFORE INSERT ON narrator_message_refs
					WHEN NEW.narrator_id = 'child'
					BEGIN SELECT RAISE(ABORT, 'boundary persistence rejected'); END`);
				try {
					texts.push(text(await input.config.getAfterToolsInjections?.()));
				} finally {
					sqlite.run("DROP TRIGGER fail_boundary_ref");
				}
				queuedAfterFailure = (await inbox.listInboxRows("child", ["agent_message"])).length;
				const prepared = await input.config.getAfterToolsInjections?.();
				texts.push(text(prepared));
				if (typeof prepared !== "string") prepared?.onConsumed?.();
				texts.push(text(await input.config.getAfterToolsInjections?.()));
				principalDuringPass = input.config.userId;
				return { finalText: "done", hasError: false, shouldUpdateTitle: false };
			},
		);
		try {
			const handle = await startNarratorRun({
				narratorId: "child",
				locale: "en",
				text: "initial turn",
				principal: null,
				deliver: false,
			});
			expect(handle.started).toBe(true);
			await handle.terminal;
			// One run, one pass: the Send never started another run.
			expect(executor).toHaveBeenCalledTimes(1);
			expect(texts[0] ?? "").not.toContain("mid-run report");
			expect(queuedAfterFailure).toBe(1);
			expect(texts[1]).toContain("mid-run report");
			expect(texts[2] ?? "").not.toContain("mid-run report");
			expect(
				childMessages().filter((message) => message.contentText?.includes("mid-run report")),
			).toHaveLength(1);
			expect(await inbox.listInboxRows("child", ["agent_message"])).toHaveLength(0);
			expect(principalDuringPass ?? null).toBeNull();
		} finally {
			executor.mockRestore();
			settings.anthropicProviders = previous;
		}
	});
}
