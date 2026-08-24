/**
 * compact-queue-drain.test.ts — a message typed while the context is compacting must
 * be QUEUED, and the queue must be consumed when the compact settles.
 *
 * The window this covers is peculiar: the narrator is `idle`, no agent loop exists and
 * `isNarratorRuntimeBusy` is false, yet starting a turn is unsafe because the compact
 * is about to replace the history the turn would run against (a compact resets the
 * upstream session). So the message takes the queue path even though nothing is
 * "running" — and that makes the queue owner-less, which is the risk this file pins:
 *
 * - admission: `pushBufferedMessage` must accept a compacting narrator, or the route
 *   reads the refusal as "not active" and falls through to the very concurrent send
 *   the queue exists to avoid;
 * - consumption: the ONLY consumer is the compact's lock-release path. If it ran just
 *   on success, a failed / cancelled / timed-out compact would strand the user's
 *   message with no loop, no card owner and no error — it would simply never be
 *   answered. So every exit is asserted separately.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/**
 * Stand in for the resumed-turn machinery.
 *
 * `resumeBufferedMessagesIfIdle` is the real consumer, and it pulls in the whole agent
 * loop. What matters here is only that the compact exit CALLS it, once, for the right
 * narrator — the conditions under which it declines are its own tested contract.
 */
let resumeCalls: Array<{ narratorId: string; locale: string; replyInUserLanguage: boolean }> = [];
const realNarratorSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realNarratorSession,
	resumeBufferedMessagesIfIdle: async (
		narratorId: string,
		locale = "en",
		replyInUserLanguage = false,
	) => {
		resumeCalls.push({ narratorId, locale, replyInUserLanguage });
		return { resumed: true };
	},
}));

const { getBufferedMessages, pushBufferedMessage } = await import("../narrator-buffer");
const { bufferedMessages, compactLocks } = await import("../narrator-session-state");
const { drainQueuedMessagesAfterCompact } = await import("../compact-queue-drain");

const NARRATOR_ID = "compact-queue-narrator";

/**
 * Install a compact lock the way `runCustomCompact` does, and hand back its settle
 * function so a test can end the compact on the exit it cares about.
 *
 * Deliberately mirrors the real lock shape (including `abortController`) rather than
 * calling `runCustomCompact`: the point of these tests is the admission + drain
 * contract around the lock, not the summary pipeline.
 */
function installCompactLock(narratorId: string): {
	settle: () => void;
	fail: (error: Error) => void;
} {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<{ kind: "history"; compacted: boolean }>((res, rej) => {
		resolve = () => res({ kind: "history", compacted: true });
		reject = rej;
	});
	compactLocks.set(narratorId, {
		kind: "history",
		promise,
		mode: "background",
		abortController: new AbortController(),
	} as unknown as NonNullable<ReturnType<typeof compactLocks.get>>);
	// Nothing awaits the rejection in these tests; swallow it so Bun does not report
	// an unhandled rejection for a promise whose only purpose is the lock's identity.
	promise.catch(() => {});
	return { settle: resolve, fail: reject };
}

beforeEach(() => {
	resumeCalls = [];
	compactLocks.clear();
	bufferedMessages.clear();
	sqlite.run("DELETE FROM narrator_buffered_messages");
});

afterEach(() => {
	compactLocks.clear();
	bufferedMessages.clear();
	sqlite.run("DELETE FROM narrator_buffered_messages");
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../narrator-session", () => realNarratorSession);
	mock.restore();
});

describe("queue admission during compaction", () => {
	test("a compacting narrator can hold a queued message even with no loop or runtime claim", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		try {
			const result = await pushBufferedMessage(NARRATOR_ID, "typed while compacting");

			expect(result.ok).toBe(true);
			expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual([
				"typed while compacting",
			]);
		} finally {
			lock.settle();
		}
	});

	test("once the compact lock is gone, admission goes back to refusing an idle narrator", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		expect((await pushBufferedMessage(NARRATOR_ID, "during")).ok).toBe(true);
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		// This refusal is load-bearing elsewhere: the route uses it to let a zombie
		// `working` row fall through to a normal send.
		const result = await pushBufferedMessage(NARRATOR_ID, "after");
		expect(result.ok).toBe(false);
		expect(result.full).toBeUndefined();
		// The message queued while the compact was live is untouched by the refusal.
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual(["during"]);
	});

	test("a compact on ANOTHER narrator does not admit this one", async () => {
		const lock = installCompactLock("some-other-narrator");
		try {
			expect((await pushBufferedMessage(NARRATOR_ID, "wrong narrator")).ok).toBe(false);
		} finally {
			lock.settle();
		}
	});
});

describe("the compact exit consumes the queue", () => {
	test("delivers a message queued during the compact", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "queued behind the compact");
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(resumeCalls).toHaveLength(1);
		expect(resumeCalls[0]?.narratorId).toBe(NARRATOR_ID);
	});

	test("an empty queue is a no-op, so an ordinary compact wakes nothing", async () => {
		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(resumeCalls).toEqual([]);
	});

	test("a failing consumer is swallowed — a compact must not be reported as broken", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "queued behind a compact");
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		mock.module("../narrator-session", () => ({
			...realNarratorSession,
			resumeBufferedMessagesIfIdle: async () => {
				throw new Error("resume exploded");
			},
		}));
		try {
			// The drain runs from a `finally`; throwing there would turn a completed
			// compact into a failure the user cannot act on.
			await expect(drainQueuedMessagesAfterCompact(NARRATOR_ID)).resolves.toBeUndefined();
		} finally {
			mock.module("../narrator-session", () => ({
				...realNarratorSession,
				resumeBufferedMessagesIfIdle: async (
					narratorId: string,
					locale = "en",
					replyInUserLanguage = false,
				) => {
					resumeCalls.push({ narratorId, locale, replyInUserLanguage });
					return { resumed: true };
				},
			}));
		}
	});
});
