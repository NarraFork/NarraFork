import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narratorMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
mock.module("../../db", () => ({ db, sqlite }));
const ws = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../websocket/narrator-ws", () => ({ ...ws, broadcastToNarrator: () => {} }));
const { resumeNextBufferedMessage } = await import("../narrator-session");
const { enqueueBufferedMessage, getBufferedMessages } = await import("../narrator-buffer");
const { runtimeInbox } = await import("../agent-runtime/inbox");
const { specVfsService } = await import("../spec-vfs-service");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { activeNarrators } = await import("../narrator-session-state");
const { narratorService } = await import("../narrator-service");
const time = "2026-09-09T00:00:00.000Z";
beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators)
		.values({ id: "recipient", status: "working", createdAt: time, updatedAt: time })
		.run();
});
afterAll(() => {
	getExecutionOwner("recipient")?.release();
	sqlite.close();
});
const active = { narratorId: "recipient", locale: "en", _replyInUserLanguage: false } as Parameters<
	typeof resumeNextBufferedMessage
>[0];
async function failedHead() {
	const failed = await enqueueBufferedMessage("recipient", "failed remains visible");
	db.update(narratorBufferedMessages)
		.set({ state: "failed", lastError: "previous preparation failed" })
		.where(eq(narratorBufferedMessages.id, failed.id))
		.run();
	return failed;
}

test("real session resume ignores failed UI head and executes the next claimed queued command", async () => {
	const failed = await failedHead();
	const queued = await enqueueBufferedMessage(
		"recipient",
		"/goal queued work",
		undefined,
		"/goal queued work",
	);
	const append = spyOn(specVfsService, "appendProtectedSpecTask").mockResolvedValue({
		added: false,
		written: {},
	} as never);
	try {
		await resumeNextBufferedMessage(active, "en");
		expect(append).toHaveBeenCalledWith("recipient", "queued work");
	} finally {
		append.mockRestore();
	}
	const rows = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, "recipient"))
		.all();
	expect(rows.filter((row) => row.role === "user").map((row) => row.contentText)).toEqual([
		"failed remains visible",
		"/goal queued work",
	]);
	expect(
		db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, queued.id))
			.get()?.state,
	).toBe("materialized");
	expect(getBufferedMessages("recipient").map((row) => ({ id: row.id, state: row.state }))).toEqual(
		[{ id: failed.id, state: "failed" }],
	);
	expect(getExecutionOwner("recipient")).toBeUndefined();
});

test("real ordinary feed reuses the claimed queued input and cannot enqueue it twice", async () => {
	const failed = await failedHead();
	const queued = await enqueueBufferedMessage("recipient", "ordinary queued text");
	const expectedId = db
		.select()
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.id, queued.id))
		.get()?.recipientMessageId;
	const session = {
		...active,
		alive: true,
		abortController: new AbortController(),
		cwd: ".",
	} as Parameters<typeof resumeNextBufferedMessage>[0];
	activeNarrators.set("recipient", session);
	// Stop strictly after the real user+ref+mailbox transaction, without invoking a provider.
	const status = spyOn(narratorService, "updateStatus")
		.mockRejectedValueOnce(new Error("post-commit dispatch fault"))
		.mockResolvedValue(undefined as never);
	try {
		await resumeNextBufferedMessage(session, "en");
	} finally {
		status.mockRestore();
		activeNarrators.delete("recipient");
	}
	const messages = db
		.select()
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, "recipient"))
		.all();
	expect(messages.find((row) => row.id === expectedId)).toMatchObject({
		contentText: "ordinary queued text",
		createdBy: null,
	});
	expect(db.select().from(narratorBufferedMessages).all()).toHaveLength(2);
	expect(getBufferedMessages("recipient").map((row) => row.id)).toEqual([failed.id]);
});

test("real session resume does not cross an earlier agent message to reach a user command", async () => {
	await failedHead();
	db.insert(narrators).values({ id: "sender", createdAt: time, updatedAt: time }).run();
	runtimeInbox.enqueue({
		kind: "agent_message",
		narratorId: "recipient",
		sourceNarratorId: "sender",
		sourceToolCallId: "tool",
		sourceAttempt: 1,
		sourceKey: "send",
		text: "earlier agent",
		projectedByteSize: 13,
	});
	const queued = await enqueueBufferedMessage("recipient", "/goal must wait");
	const append = spyOn(specVfsService, "appendProtectedSpecTask");
	try {
		await resumeNextBufferedMessage(active, "en");
	} finally {
		append.mockRestore();
	}
	expect(append).not.toHaveBeenCalled();
	expect(
		db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, queued.id))
			.get()?.state,
	).toBe("queued");
	// Failed, agent, and queued user inputs are all visible canonical history rows;
	// only the queued user input remains unmaterialized for execution.
	expect(db.select().from(narratorMessages).all()).toHaveLength(3);
});
