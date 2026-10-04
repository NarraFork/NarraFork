/**
 * Who may hold a queued message.
 *
 * The regression pinned here reached users as: after a planned update restarted the
 * server, the primary narrator "sent messages without queueing them, then kept going
 * and completely ignored the subagent that was still running".
 *
 * The chain was:
 * 1. planned-update recovery re-drove a foreground subagent. That stage runs with NO
 *    `activeNarrators` entry (there is no agent loop yet) and instead claims the
 *    narrator's runtime, keeping its DB status at `working`.
 * 2. a user message saw `status === "working"` and took the queue path.
 * 3. `pushBufferedMessage` gated on `activeNarrators.has()` alone, so it refused.
 * 4. the route reads a non-`full` refusal as "narrator not active in memory" and fell
 *    through to a normal send, which built a fresh session — whose `_loopRunning` is
 *    false, so `feedMessage`'s last-resort guard waved it through too.
 *
 * Two properties close it, and both are asserted here:
 * - queue admission follows `isNarratorRuntimeBusy`, not the presence of a session, so
 *   messages sent during recovery are queued instead of bypassing the queue;
 * - a genuinely ownerless narrator is still refused, because that refusal is what
 *   legitimately lets a zombie `working` row fall through to a normal send.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { narratorBufferedMessages, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	getBufferedMessages,
	pushBufferedMessage,
	enqueueBufferedMessage,
	updateBufferedMessageMode,
	reorderBufferedMessages,
	toBufferSummary,
} = await import("../narrator-buffer");
const { activeNarrators, claimNarratorRuntime, pendingDangerReflections, pendingPermissions } =
	await import("../narrator-session-state");

const NARRATOR_ID = "buffer-admission-narrator";
const OTHER_ID = "buffer-admission-other";
for (const id of [NARRATOR_ID, OTHER_ID]) {
	db.insert(narrators)
		.values({ id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
		.run();
}

/** Register a live agent loop the way runAgentLoop does. */
function registerLiveLoop(narratorId: string): void {
	activeNarrators.set(narratorId, {
		narratorId,
		alive: true,
		_loopRunning: true,
	} as unknown as NonNullable<ReturnType<typeof activeNarrators.get>>);
}

async function readPersistedTexts(narratorId: string): Promise<string[]> {
	const rows = await db
		.select({ text: narratorBufferedMessages.text, seq: narratorBufferedMessages.seq })
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId));
	return rows.sort((a, b) => a.seq - b.seq).map((row) => row.text);
}

afterEach(() => {
	activeNarrators.clear();
	pendingPermissions.clear();
	pendingDangerReflections.clear();
	sqlite.run("DELETE FROM narrator_buffered_messages");
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("durable queue modes", () => {
	async function enqueue(text: string, mode: "turn" | "tool" | "interrupt") {
		return enqueueBufferedMessage(
			NARRATOR_ID,
			text,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			mode === "turn" ? "back" : "front",
			undefined,
			undefined,
			"stack",
			undefined,
			mode,
		);
	}
	test("guidance is FIFO, persisted and authoritative in summaries", async () => {
		await enqueue("ordinary", "turn");
		await enqueue("first guide", "tool");
		await enqueue("second guide", "interrupt");
		const messages = getBufferedMessages(NARRATOR_ID);
		expect(messages.map((m) => m.text)).toEqual(["first guide", "second guide", "ordinary"]);
		expect(toBufferSummary(messages).map((m) => m.queueMode)).toEqual([
			"tool",
			"interrupt",
			"turn",
		]);
	});
	test("mode changes append to destination and retain failed payload", async () => {
		const first = await enqueue("first", "turn");
		const second = await enqueue("second", "tool");
		await enqueue("third", "turn");
		db.update(narratorBufferedMessages)
			.set({ state: "failed", lastError: "test failure" })
			.where(eq(narratorBufferedMessages.id, first.id))
			.run();
		expect(await updateBufferedMessageMode(NARRATOR_ID, first.id, "interrupt")).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual([
			"second",
			"first",
			"third",
		]);
		const failed = getBufferedMessages(NARRATOR_ID).find((m) => m.id === first.id);
		expect(failed?.state).toBe("failed");
		expect(failed?.error).toBe("test failure");
		expect(await updateBufferedMessageMode(NARRATOR_ID, second.id, "turn")).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual([
			"first",
			"third",
			"second",
		]);
	});
	test("only ordinary rows reorder; claimed messages reject mode mutations", async () => {
		const guide = await enqueue("guide", "tool");
		const a = await enqueue("a", "turn");
		const b = await enqueue("b", "turn");
		expect(await reorderBufferedMessages(NARRATOR_ID, [b.id, guide.id, a.id])).toBe(false);
		expect(await reorderBufferedMessages(NARRATOR_ID, [guide.id, b.id, a.id])).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual(["guide", "b", "a"]);
		expect(await reorderBufferedMessages(NARRATOR_ID, [a.id, b.id])).toBe(true);
		db.update(narratorBufferedMessages)
			.set({ state: "claimed" })
			.where(eq(narratorBufferedMessages.id, guide.id))
			.run();
		expect(await updateBufferedMessageMode(NARRATOR_ID, guide.id, "turn")).toBe(false);
	});
});

describe("pushBufferedMessage — loop-less runtime owners can hold a queue", () => {
	test("accepts a message for a narrator held only by a recovery runtime claim", async () => {
		// Exactly the post-update-restart shape: recovery is driving the narrator, so
		// there is no session object, yet the narrator is genuinely busy.
		expect(activeNarrators.has(NARRATOR_ID)).toBe(false);
		const release = claimNarratorRuntime(NARRATOR_ID, "planned-update-recovery");

		try {
			const result = await pushBufferedMessage(NARRATOR_ID, "queued during recovery");

			expect(result.ok).toBe(true);
			expect(getBufferedMessages(NARRATOR_ID).map((msg) => msg.text)).toEqual([
				"queued during recovery",
			]);
			// Persisted too, so the queue survives another restart mid-recovery.
			expect(await readPersistedTexts(NARRATOR_ID)).toEqual(["queued during recovery"]);
		} finally {
			release();
		}
	});

	test("accepts a message while a pending permission holds the narrator", async () => {
		pendingPermissions.set("pending-permission", {
			narratorId: NARRATOR_ID,
		} as unknown as NonNullable<ReturnType<typeof pendingPermissions.get>>);

		expect((await pushBufferedMessage(NARRATOR_ID, "queued at the gate")).ok).toBe(true);
	});

	test("accepts a message while a danger reflection holds the narrator", async () => {
		pendingDangerReflections.set("pending-reflection", {
			narratorId: NARRATOR_ID,
		} as unknown as NonNullable<ReturnType<typeof pendingDangerReflections.get>>);

		expect((await pushBufferedMessage(NARRATOR_ID, "queued at the reflection")).ok).toBe(true);
	});

	test("still accepts a message for an ordinary live loop", async () => {
		registerLiveLoop(NARRATOR_ID);

		expect((await pushBufferedMessage(NARRATOR_ID, "queued behind a loop")).ok).toBe(true);
	});

	test("keeps FIFO order and front-insertion across a claim-only narrator", async () => {
		const release = claimNarratorRuntime(NARRATOR_ID, "recovery-await-batch");

		try {
			await pushBufferedMessage(NARRATOR_ID, "first");
			await pushBufferedMessage(NARRATOR_ID, "second");
			await pushBufferedMessage(
				NARRATOR_ID,
				"cut in",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"front",
			);

			expect(getBufferedMessages(NARRATOR_ID).map((msg) => msg.text)).toEqual([
				"cut in",
				"first",
				"second",
			]);
			// The persisted seq order has to agree, or a restart would replay them wrongly.
			expect(await readPersistedTexts(NARRATOR_ID)).toEqual(["cut in", "first", "second"]);
		} finally {
			release();
		}
	});
});

describe("pushBufferedMessage — an ownerless narrator is refused", () => {
	test("refuses when nothing owns the narrator, without reporting a full queue", async () => {
		// This refusal is load-bearing: the route uses it to let a zombie `working`
		// status fall through to a normal send. Reporting `full` here would instead
		// surface a bogus "Message queue is full" error to the user.
		const result = await pushBufferedMessage(NARRATOR_ID, "nobody is listening");

		expect(result.ok).toBe(false);
		expect(result.full).toBeUndefined();
		expect(getBufferedMessages(NARRATOR_ID)).toEqual([]);
		expect(await readPersistedTexts(NARRATOR_ID)).toEqual([]);
	});

	test("a claim on ANOTHER narrator does not admit this one", async () => {
		const release = claimNarratorRuntime(OTHER_ID, "unrelated-recovery");

		try {
			expect((await pushBufferedMessage(NARRATOR_ID, "wrong narrator")).ok).toBe(false);
		} finally {
			release();
		}
	});

	test("a released claim stops admitting new messages", async () => {
		const release = claimNarratorRuntime(NARRATOR_ID, "recovery-stage");
		expect((await pushBufferedMessage(NARRATOR_ID, "during")).ok).toBe(true);

		release();

		expect((await pushBufferedMessage(NARRATOR_ID, "after")).ok).toBe(false);
		// The message queued while the claim was live is untouched by the refusal.
		expect(getBufferedMessages(NARRATOR_ID).map((msg) => msg.text)).toEqual(["during"]);
	});
});
