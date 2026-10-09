import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
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
const { createMailboxStore } = await import("../agent-runtime/mailbox");
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

test("consumed Send recovers its own durable source receipt, not another wake trigger", async () => {
	const first = delivery("child", "first");
	const expected = bindDeliverySource(first);
	const second = delivery("child", "second");
	bindDeliverySource(second);
	await inbox.enqueueInboxAgent(first, first.text);
	await inbox.enqueueInboxAgent(second, second.text);
	const consumed = required(await consume());
	expect(consumed.executionBinding).toEqual(expected);
	expect(consumed.executionBinding?.bindingNarratorId).toBe("sender");
});

test("eligible queue wake restores a verified sender call rather than child creation", async () => {
	const value = delivery("child", "queued followup");
	const expected = bindDeliverySource(value);
	await inbox.enqueueInboxAgent(value, value.text);
	const resume = await import("../subagent-resume");
	const captured: Record<string, unknown>[] = [];
	const spy = spyOn(resume, "resumeSubagent").mockImplementation(async (input) => {
		captured.push(input as unknown as Record<string, unknown>);
		return { started: true, resumedSuspendedRunner: false, originToolUseId: "creation-slot" };
	});
	try {
		expect(await inbox.wakeInboxIfEligible("child")).toBe(true);
		expect(captured[0]).toMatchObject({ ...expected, mailboxInput: true });
	} finally {
		spy.mockRestore();
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
	expect((await consume())?.executionBinding).toBeNull();
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
	expect((await consume())?.executionBinding?.toolCallBinding.toolCallId).toBe(
		value.senderToolCallBinding?.toolCallId,
	);
});

test("real Send idle entry forwards its own verified binding and sending actor", async () => {
	const value = delivery("child", "from Send");
	const expected = bindDeliverySource(value);
	const resume = await import("../subagent-resume");
	const captured: Record<string, unknown>[] = [];
	const spy = spyOn(resume, "resumeSubagent").mockImplementation(async (input) => {
		captured.push(input as unknown as Record<string, unknown>);
		return { started: true, resumedSuspendedRunner: false, originToolUseId: "creation-slot" };
	});
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
		});
		expect(captured[0]).toMatchObject({ ...expected, mailboxInput: true });
	} finally {
		spy.mockRestore();
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
	const teamOwner = required(tryClaimExecution("child", "subagent"));
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
	const buffered = await pushSubagentBufferedMessage("child", "[sender] next", {
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
	const flush = spyOn(runtimePublication, "flushRecipient").mockImplementation((id) => {
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
	const owner = required(tryClaimExecution("child", "subagent"));
	try {
		expect(await consume()).toBeDefined();
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
	expect(inbox.runtimeInbox.list("child")).toHaveLength(1);
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
	const agentInput = await pushSubagentBufferedMessage("child", d.text, { delivery: d });
	const owner = tryClaimExecution("child", "subagent");
	expect(
		await inbox.claimInboxHead("child", (row) => row.kind === "agent_message"),
	).toBeUndefined();
	expect(await updateSubagentBufferedMessage("child", agentInput.id, "forged user")).toBe(false);
	expect(getSubagentBufferedMessages("child").map((m) => m.id)).toEqual([user.id]);
	clearBufferedMessages("child");
	expect(state(user.id)?.state).toBe("cancelled");
	expect(state(agentInput.id)?.state).toBe("queued");
	expect((await inbox.claimInboxHead("child", () => true))?.claimEpoch).toBe(owner?.epoch);
});

test("parent real delivery commits history/ref/materialization together and keeps unadopted receipt", async () => {
	const d = delivery("parent");
	await inbox.enqueueInboxAgent(d, d.text, { channel: "parent" });
	await inbox.withInboxOwner("parent", async () => {
		const row = required(await inbox.claimInboxHead("parent", () => true));
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
	// In-pass adoption is an agent-delivery path; explicit user queue modes intentionally
	// restart a pass. Keep this fixture on the path the assertion is testing.
	const value = delivery("child", "new principal");
	const accepted = await pushSubagentBufferedMessage("child", "new principal", {
		createdBy: null,
		delivery: value,
	});
	await inbox.withInboxOwner("child", async () => {
		const result = await consumeBufferedSubagentMessageInPass({
			narratorId: "child",
			parentNarratorId: "parent",
			toolUseId: "origin",
			cwd: ".",
			currentUserId: "other",
		});
		expect(result?.text).toBe('<sender kind="agent" id="sender" name="Sender" />\nnew principal');
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
	const owner = tryClaimExecution("child", "subagent");
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
	expect(state(row.id)).toMatchObject({ state: "materialized", adoptedAt: null });
	projected.onConsumed();
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(state(row.id)?.adoptedAt).not.toBeNull();
	expect(state(row.id)?.adoptedRevision).toBe(1);
});

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
			const seed = (id: string, parentNarratorId: string, backgroundKind: "task" | "service") =>
				db
					.insert(backgroundTasks)
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

			// A different session's task and this session's long-lived service do not block it.
			db.insert(narrators)
				.values({ id: "unrelated", variant: "primary", createdAt: time, updatedAt: time })
				.run();
			seed("other-task", "unrelated", "task");
			seed("dev-server", "parent", "service");
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
			expect(await deliver()).not.toContain(hint);
			db.update(backgroundTasks)
				.set({ status: "completed" })
				.where(eq(backgroundTasks.id, "remaining-task"))
				.run();
			expect((await deliver())?.endsWith(hint)).toBe(true);
			// A still-running subagent blocks the hint too, including legacy agents without task rows.
			db.update(narrators)
				.set({ status: "working", isBackground: true, backgroundStatus: "running" })
				.where(eq(narrators.id, "child"))
				.run();
			expect(await deliver()).not.toContain(hint);
			db.update(narrators)
				.set({ status: "idle", backgroundStatus: "completed" })
				.where(eq(narrators.id, "child"))
				.run();
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
				}
				for (const status of ["idle", "working", "waiting"] as const) {
					db.update(narrators)
						.set({ status, isBackground: false, substatus: JSON.stringify(["taken_over"]) })
						.where(eq(narrators.id, "child"))
						.run();
					expect(await deliver()).not.toContain(hint);
				}
				// Releasing takeover and returning the result finally exhausts the work.
				db.update(narrators)
					.set({ status: "idle", substatus: "[]", backgroundStatus: "completed" })
					.where(eq(narrators.id, "child"))
					.run();
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
		expect(await deliverPendingInjection("parent", "en", "busy", "onNextTurn", projected)).toBe("");
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
	const oldOwner = tryClaimExecution("parent", "primary");
	const row = await inbox.claimInboxHead("parent", () => true);
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
