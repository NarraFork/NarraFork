import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import {
	narratorBufferedMessages,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...ws, broadcastToNarrator: () => {} }));
const takeover = { ...(await import("../subagent-takeover")) };
const taken = new Set<string>();
mock.module("../subagent-takeover", () => ({
	...takeover,
	isTakenOver: (id: string) => taken.has(id),
}));
const { sendSubagentMessageDetailed } = await import("../agent-communication");
const { createMailboxStore } = await import("../agent-runtime/mailbox");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const { getForegroundAbortControllers } = await import("../subagent-detach");
const { registerAgentReplyWait, clearPendingAgentReplyWaits, getPendingAgentReplyCount } =
	await import("../agent-reply-waiter");
const { sendTool } = await import("../../lib/agent/tools/send");
const store = createMailboxStore(db);
const ids = [
	"parent-root",
	"sender-child",
	"sibling-a",
	"sibling-b",
	"foreign-root",
	"foreign-child",
];
const time = "2026-09-09T00:00:00.000Z";
let serial = 0;
beforeEach(() => {
	clearPendingAgentReplyWaits();
	taken.clear();
	for (const id of ids) getExecutionOwner(id)?.release();
	getForegroundAbortControllers().clear();
	cleanDb(sqlite);
	for (const id of ids) {
		const primary = id.endsWith("root");
		db.insert(narrators)
			.values({
				id,
				title: id === "sibling-a" ? "Alpha analyst" : id,
				type: primary ? "primary" : "subagent",
				variant: primary ? "primary" : "subagent:general",
				parentNarratorId: primary ? null : id === "foreign-child" ? "foreign-root" : "parent-root",
				traits: id === "sibling-a" ? ["subagent-alias:alpha"] : [],
				status: "working",
				isBackground: false,
				createdAt: time,
				updatedAt: time,
			})
			.run();
	}
	tryClaimExecution("parent-root", "primary");
});
afterAll(() => {
	clearPendingAgentReplyWaits();
	for (const id of ids) getExecutionOwner(id)?.release();
	getForegroundAbortControllers().clear();
	sqlite.close();
});
function input(
	callerNarratorId = "sender-child",
	targets = ["parent", "sibling-a"],
): Parameters<typeof sendSubagentMessageDetailed>[0] {
	const id = `source-${++serial}`;
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: callerNarratorId,
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	db.insert(narratorToolCalls)
		.values({
			id: `${id}-tool`,
			narratorId: callerNarratorId,
			messageId: id,
			toolUseId: `${id}-use`,
			toolName: "Send",
			executionAttempt: 1,
			executionIdentityVersion: 1,
			status: "running",
			createdAt: time,
		})
		.run();
	return {
		callerNarratorId,
		ids: targets,
		toolUseId: `${id}-use`,
		toolCallBinding: { toolCallId: `${id}-tool`, attempt: 1 },
		message: "same report",
		signal: new AbortController().signal,
		locale: "en",
	};
}
function rows(id?: string) {
	return id
		? db
				.select()
				.from(narratorBufferedMessages)
				.where(eq(narratorBufferedMessages.narratorId, id))
				.all()
		: db.select().from(narratorBufferedMessages).all();
}

test("foreground child sends parent+sibling in one call, all durable, parent owner unchanged", async () => {
	const owner = getExecutionOwner("parent-root");
	const request = input();
	const notices: Array<import("@shared/communication-tool").SendDeliveryTarget> = [];
	let count = 0;
	request.onTargetsResolved = (n) => {
		count = n;
	};
	request.onDeliveryResolved = (notice) => notices.push(notice);
	const result = await sendSubagentMessageDetailed(request);
	expect(result.targets.map((target) => [target.id, target.status])).toEqual([
		["parent-root", "queued"],
		["sibling-a", "queued"],
	]);
	expect(count).toBe(2);
	expect(notices).toHaveLength(2);
	expect(rows()).toHaveLength(2);
	expect(getExecutionOwner("parent-root")).toBe(owner);
	expect(result.output).toContain("safe input boundary");
	for (const target of result.targets)
		expect(target).toMatchObject({
			deliveryId: expect.any(String),
			deliveryMessageId: expect.any(String),
			revision: 1,
		});
	expect(
		rows().every(
			(row) =>
				row.kind === "agent_message" &&
				row.state === "queued" &&
				row.sourceToolCallId === request.toolCallBinding?.toolCallId,
		),
	).toBe(true);
});

test("parent/main/id and sibling alias/title/id deduplicate by actual recipient", async () => {
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["parent", "main", "parent-root", "alpha", "Alpha analyst", "sibling-a"]),
	);
	expect(result.targets.map((target) => target.id)).toEqual(["parent-root", "sibling-a"]);
	expect(rows()).toHaveLength(2);
});

test("whole-call selector authorization rejects foreign or missing targets before any parent enqueue", async () => {
	for (const target of ["foreign-child", "nonexistent"]) {
		await expect(
			sendSubagentMessageDetailed(input("sender-child", ["parent", target])),
		).rejects.toThrow();
		expect(rows()).toHaveLength(0);
	}
});

test("one archived target retains both earlier parent and later sibling successes", async () => {
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "sibling-a")).run();
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["parent", "sibling-a", "sibling-b"]),
	);
	expect(result.targets.map((target) => target.status)).toEqual(["queued", "failed", "queued"]);
	expect(
		rows()
			.map((row) => row.narratorId)
			.sort(),
	).toEqual(["parent-root", "sibling-b"]);
});

test("full parent queue does not prevent sibling delivery and no old entry is evicted", async () => {
	for (let i = 0; i < 50; i++)
		store.enqueue({
			kind: "agent_message",
			narratorId: "parent-root",
			sourceNarratorId: "sender-child",
			sourceToolCallId: `prior-${i}`,
			sourceAttempt: 1,
			sourceKey: "send",
			text: "prior",
			projectedByteSize: 5,
		});
	const result = await sendSubagentMessageDetailed(input());
	expect(result.targets.map((target) => target.status)).toEqual(["failed", "queued"]);
	expect(rows("parent-root")).toHaveLength(50);
	expect(rows("sibling-a")).toHaveLength(1);
});

test("takeover is a per-target result and does not suppress parent or later sibling", async () => {
	taken.add("sibling-a");
	const result = await sendSubagentMessageDetailed(
		input("sender-child", ["sibling-a", "parent", "sibling-b"]),
	);
	expect(result.targets.map((target) => target.status)).toEqual(["taken_over", "queued", "queued"]);
	expect(rows("sibling-a")).toHaveLength(0);
	expect(rows()).toHaveLength(2);
});

test("explicit replyTo mixed fanout rejects the entire call without settling waiter or enqueue", async () => {
	const wait = registerAgentReplyWait({
		requesterId: "parent-root",
		responderId: "sender-child",
		scope: { type: "parent-child", id: "parent-root\u0000sender-child" },
	});
	const result = await sendSubagentMessageDetailed({ ...input(), replyTo: wait.requestId });
	expect(result.targets.every((target) => target.status === "failed")).toBe(true);
	expect(getPendingAgentReplyCount("parent-root", "sender-child", wait.scope)).toBe(1);
	expect(rows()).toHaveLength(0);
	wait.cancel();
});

test.each([
	"parent",
	"sibling",
])("implicit %s reply mixed with ordinary target has zero delivery side effects", async (replyTarget) => {
	const requesterId = replyTarget === "parent" ? "parent-root" : "sibling-a";
	const wait = registerAgentReplyWait({
		requesterId,
		responderId: "sender-child",
		scope:
			replyTarget === "parent"
				? { type: "parent-child", id: "parent-root\u0000sender-child" }
				: { type: "team", id: "parent-root" },
	});
	const result = await sendSubagentMessageDetailed(input());
	expect(result.targets.every((target) => target.status === "failed")).toBe(true);
	expect(getPendingAgentReplyCount(requesterId, "sender-child", wait.scope)).toBe(1);
	expect(rows()).toHaveLength(0);
	wait.cancel();
});

test("later implicit ambiguity rejects the complete batch before the earlier unique waiter settles", async () => {
	const parentWait = registerAgentReplyWait({
		requesterId: "parent-root",
		responderId: "sender-child",
		scope: { type: "parent-child", id: "parent-root\u0000sender-child" },
	});
	const siblingFirst = registerAgentReplyWait({
		requesterId: "sibling-a",
		responderId: "sender-child",
		scope: { type: "team", id: "parent-root" },
	});
	const siblingSecond = registerAgentReplyWait({
		requesterId: "sibling-a",
		responderId: "sender-child",
		scope: { type: "team", id: "parent-root" },
	});
	const result = await sendSubagentMessageDetailed(input());
	expect(result.targets.map((target) => [target.id, target.status])).toEqual([
		["parent-root", "failed"],
		["sibling-a", "failed"],
	]);
	expect(result.output).toContain("Multiple Send reply requests");
	expect(getPendingAgentReplyCount("parent-root", "sender-child", parentWait.scope)).toBe(1);
	expect(getPendingAgentReplyCount("sibling-a", "sender-child", siblingFirst.scope)).toBe(2);
	expect(rows()).toHaveLength(0);
	siblingSecond.cancel();
	const retried = await sendSubagentMessageDetailed(input());
	expect(retried.targets.map((target) => [target.id, target.status])).toEqual([
		["parent-root", "completed"],
		["sibling-a", "completed"],
	]);
	expect((await parentWait.promise).status).toBe("replied");
	expect((await siblingFirst.promise).status).toBe("replied");
	expect(retried.output).toContain(parentWait.requestId);
	expect(retried.output).toContain(siblingFirst.requestId);
	expect(rows()).toHaveLength(0);
});

test("single parent reply still settles the independent waiter without mailbox entry", async () => {
	const wait = registerAgentReplyWait({
		requesterId: "parent-root",
		responderId: "sender-child",
		scope: { type: "parent-child", id: "parent-root\u0000sender-child" },
	});
	const result = await sendSubagentMessageDetailed({
		...input("sender-child", ["parent", "main"]),
		replyTo: wait.requestId,
	});
	expect(result.targets[0]?.status).toBe("completed");
	expect((await wait.promise).status).toBe("replied");
	expect(rows()).toHaveLength(0);
});

test("child await/interrupt and primary foreign interrupt fail whole-call before enqueue", async () => {
	await expect(sendSubagentMessageDetailed({ ...input(), shouldAwait: true })).rejects.toThrow();
	await expect(sendSubagentMessageDetailed({ ...input(), doInterrupt: true })).rejects.toThrow();
	await expect(
		sendSubagentMessageDetailed({
			...input("parent-root", ["sibling-a", "foreign-child"]),
			doInterrupt: true,
		}),
	).rejects.toThrow();
	expect(rows()).toHaveLength(0);
});

test("same attempt fanout retry reuses each delivery and never re-interrupts child", async () => {
	const mixed = input();
	const first = await sendSubagentMessageDetailed(mixed);
	const repeated = await sendSubagentMessageDetailed(mixed);
	expect(repeated.targets.map((target) => target.deliveryId)).toEqual(
		first.targets.map((target) => target.deliveryId),
	);
	expect(rows()).toHaveLength(2);
	const controller = new AbortController();
	getForegroundAbortControllers().set("sibling-b", controller);
	const primary = { ...input("parent-root", ["sibling-b"]), doInterrupt: true };
	await sendSubagentMessageDetailed(primary);
	expect(controller.signal.aborted).toBe(true);
	const replacement = new AbortController();
	getForegroundAbortControllers().set("sibling-b", replacement);
	await sendSubagentMessageDetailed(primary);
	expect(replacement.signal.aborted).toBe(false);
});

test("database failure at one recipient preserves before/after recipient successes", async () => {
	sqlite.exec(
		"CREATE TEMP TRIGGER reject_mixed_recipient BEFORE INSERT ON narrator_buffered_messages WHEN NEW.narrator_id = 'sibling-a' BEGIN SELECT RAISE(ABORT, 'recipient disk fault'); END",
	);
	try {
		const result = await sendSubagentMessageDetailed(
			input("sender-child", ["parent", "sibling-a", "sibling-b"]),
		);
		expect(result.targets.map((target) => target.status)).toEqual(["queued", "failed", "queued"]);
		expect(result.targets[1]?.error).toContain("recipient disk fault");
	} finally {
		sqlite.exec("DROP TRIGGER reject_mixed_recipient");
	}
	expect(rows()).toHaveLength(2);
});

test("retry after one archived recipient becomes eligible preserves previous successes", async () => {
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "sibling-a")).run();
	const request = input();
	const first = await sendSubagentMessageDetailed(request);
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "sibling-a")).run();
	const second = await sendSubagentMessageDetailed(request);
	expect(first.targets.map((target) => target.status)).toEqual(["queued", "failed"]);
	expect(second.targets.map((target) => target.status)).toEqual(["queued", "queued"]);
	expect(second.targets[0]?.deliveryId).toBe(first.targets[0]?.deliveryId);
	expect(rows("parent-root")).toHaveLength(1);
	expect(rows("sibling-a")).toHaveLength(1);
});

test("a valid reply target plus unauthorized selector cannot settle the reply early", async () => {
	const wait = registerAgentReplyWait({
		requesterId: "parent-root",
		responderId: "sender-child",
		scope: { type: "parent-child", id: "parent-root\u0000sender-child" },
	});
	await expect(
		sendSubagentMessageDetailed(input("sender-child", ["parent", "foreign-child"])),
	).rejects.toThrow();
	expect(getPendingAgentReplyCount("parent-root", "sender-child", wait.scope)).toBe(1);
	expect(rows()).toHaveLength(0);
	wait.cancel();
});

test("parent aliases cannot be captured by a sibling title", async () => {
	db.update(narrators).set({ title: "parent" }).where(eq(narrators.id, "sibling-b")).run();
	const result = await sendSubagentMessageDetailed(input("sender-child", ["parent", "sibling-b"]));
	expect(result.targets.map((target) => target.id)).toEqual(["parent-root", "sibling-b"]);
	expect(rows()).toHaveLength(2);
});

test("missing or stale exact receipt never falls back to text/provider tool-use identity", async () => {
	const request = input();
	await sendSubagentMessageDetailed({ ...request, toolCallBinding: undefined });
	expect(rows()).toHaveLength(0);
	const stale = await sendSubagentMessageDetailed({
		...request,
		toolCallBinding: { toolCallId: request.toolCallBinding?.toolCallId ?? "missing", attempt: 2 },
	});
	expect(stale.targets.every((target) => target.status === "failed")).toBe(true);
	expect(rows()).toHaveLength(0);
});

test("tool instructions expose mixed async destinations and deferred foreground parent semantics", () => {
	expect(sendTool.description).toContain("mix parent and sibling");
	expect(sendTool.description).toContain("do not start a second parent loop");
});
