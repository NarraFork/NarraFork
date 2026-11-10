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

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

/**
 * Stub only the turn starters, not the unified mailbox wake. This keeps the real
 * empty/cancelled, busy/stop and principal guards in the no-user-input path while
 * avoiding a provider request. User-input dispatch keeps its locale-aware contract.
 */
type ResumeCall = { narratorId: string; locale: string; replyInUserLanguage: boolean };
let resumeCalls: ResumeCall[] = [];
let continuationCalls: ResumeCall[] = [];
let resumeError: Error | undefined;
const realNarratorSession = { ...(await import("../narrator-session")) };
mock.module("../narrator-session", () => ({
	...realNarratorSession,
	resumeBufferedMessagesIfIdle: async (
		narratorId: string,
		locale = "en",
		replyInUserLanguage = false,
	) => {
		resumeCalls.push({ narratorId, locale, replyInUserLanguage });
		if (resumeError) throw resumeError;
		return { resumed: true };
	},
	startParentInboundContinuationIfPossible: async (
		narratorId: string,
		locale = "en",
		replyInUserLanguage = false,
	) => {
		continuationCalls.push({ narratorId, locale, replyInUserLanguage });
		return { started: true };
	},
}));

const buffer = await import("../narrator-buffer");
const { getBufferedMessages, pushBufferedMessage } = buffer;
const { compactLocks, activeNarrators } = await import("../narrator-session-state");
const inbox = await import("../agent-runtime/inbox");
const { getExecutionOwner, tryClaimExecution } = await import("../agent-runtime/ownership");
const { drainQueuedMessagesAfterCompact } = await import("../compact-queue-drain");

const NARRATOR_ID = "compact-queue-narrator";
const { narrators, userPreferences } = await import("../../db/schema");
db.insert(narrators)
	.values({
		id: NARRATOR_ID,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	})
	.run();

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

function enqueueTaskNotice(eventKind = "completed", metadata: Record<string, unknown> = {}) {
	const result = inbox.runtimeInbox.enqueue({
		kind: "task_notice",
		noticeKind: "bash",
		narratorId: NARRATOR_ID,
		sourceKey: `compact-task-${eventKind}`,
		text: "watch settled while compacting",
		projectedByteSize: 30,
		metadata: { producerKind: "bash", taskId: "compact-watch", eventKind, ...metadata },
	});
	if (!("delivery" in result)) throw new Error(`Notice admission failed: ${result.status}`);
	return result.delivery;
}

function resetFixture() {
	compactLocks.clear();
	activeNarrators.delete(NARRATOR_ID);
	getExecutionOwner(NARRATOR_ID)?.release();
	sqlite.run("DELETE FROM narrator_buffered_messages");
	sqlite.run("DELETE FROM user_preferences WHERE user_id = ?", ["compact-queue-author"]);
	sqlite.run("UPDATE narrators SET last_stop_reason = NULL WHERE id = ?", [NARRATOR_ID]);
}

beforeEach(() => {
	resumeCalls = [];
	continuationCalls = [];
	resumeError = undefined;
	resetFixture();
});

afterEach(resetFixture);

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

		expect(resumeCalls).toEqual([
			{ narratorId: NARRATOR_ID, locale: "en", replyInUserLanguage: false },
		]);
		expect(continuationCalls).toEqual([]);
	});

	test("user input keeps its author's locale even behind a task notice", async () => {
		db.insert(userPreferences)
			.values({
				id: "compact-author-preferences",
				userId: "compact-queue-author",
				language: "zh-CN",
				replyInUserLanguage: true,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.run();
		const lock = installCompactLock(NARRATOR_ID);
		enqueueTaskNotice();
		await pushBufferedMessage(
			NARRATOR_ID,
			"queued by a Chinese-language user",
			undefined,
			undefined,
			"compact-queue-author",
		);
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(resumeCalls).toEqual([
			{ narratorId: NARRATOR_ID, locale: "zh-CN", replyInUserLanguage: true },
		]);
		expect(continuationCalls).toEqual([]);
	});

	test("an empty queue is a no-op, so an ordinary compact wakes nothing", async () => {
		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(resumeCalls).toEqual([]);
		expect(continuationCalls).toEqual([]);
		expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
	});

	test("a failing consumer is swallowed — a compact must not be reported as broken", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		await pushBufferedMessage(NARRATOR_ID, "queued behind a compact");
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		resumeError = new Error("resume exploded");
		// The drain runs from a `finally`; throwing there would turn a completed
		// compact into a failure the user cannot act on.
		await expect(drainQueuedMessagesAfterCompact(NARRATOR_ID)).resolves.toBeUndefined();
		expect(resumeCalls).toHaveLength(1);
	});

	test("a failing initial queue check is also best-effort", async () => {
		const read = spyOn(buffer, "getBufferedMessages").mockImplementation(() => {
			throw new Error("queue read exploded");
		});
		const { logger } = await import("../../lib/logger");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await expect(drainQueuedMessagesAfterCompact(NARRATOR_ID)).resolves.toBeUndefined();
			expect(warn).toHaveBeenCalledWith("Failed to resume messages queued during compaction", {
				narratorId: NARRATOR_ID,
				error: "queue read exploded",
			});
			expect(resumeCalls).toEqual([]);
			expect(continuationCalls).toEqual([]);
		} finally {
			read.mockRestore();
			warn.mockRestore();
		}
	});

	test("a failing mailbox wake cannot make the compact fail", async () => {
		const wake = spyOn(inbox, "wakeInboxIfEligible").mockRejectedValue(
			new Error("mailbox wake exploded"),
		);
		const { logger } = await import("../../lib/logger");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await expect(drainQueuedMessagesAfterCompact(NARRATOR_ID)).resolves.toBeUndefined();
			expect(wake).toHaveBeenCalledWith(NARRATOR_ID);
			expect(warn).toHaveBeenCalledWith("Failed to resume messages queued during compaction", {
				narratorId: NARRATOR_ID,
				error: "mailbox wake exploded",
			});
		} finally {
			wake.mockRestore();
			warn.mockRestore();
		}
	});
});

describe("the compact exit rechecks the unified mailbox without user input", () => {
	test.each([
		"success",
		"failure",
		"cancellation",
	])("a completed watch notice is eligible after compact %s", async (exit) => {
		const lock = installCompactLock(NARRATOR_ID);
		enqueueTaskNotice();
		expect(getBufferedMessages(NARRATOR_ID)).toEqual([]);
		if (exit === "success") lock.settle();
		else lock.fail(new Error(`compact ${exit}`));
		compactLocks.delete(NARRATOR_ID);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([
			{ narratorId: NARRATOR_ID, locale: "en", replyInUserLanguage: false },
		]);
		expect(resumeCalls).toEqual([]);
	});

	test("a direct agent message also rechecks the notification continuation", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		const result = inbox.runtimeInbox.enqueue({
			kind: "agent_message",
			narratorId: NARRATOR_ID,
			sourceNarratorId: NARRATOR_ID,
			sourceToolCallId: "compact-agent-source-call",
			sourceAttempt: 1,
			sourceKey: "compact-agent-message",
			text: "agent report while compacting",
			projectedByteSize: 30,
		});
		expect(result.status).toBe("accepted");
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([
			{ narratorId: NARRATOR_ID, locale: "en", replyInUserLanguage: false },
		]);
		expect(resumeCalls).toEqual([]);
	});

	test.each([
		"started",
		"cancelled",
	])("a %s-only notice does not authorize a wake", async (kind) => {
		enqueueTaskNotice(kind);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([]);
		expect(resumeCalls).toEqual([]);
		expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
	});

	test("a cancelled mailbox delivery cannot authorize a wake", async () => {
		const notice = enqueueTaskNotice();
		expect(inbox.runtimeInbox.cancel(notice.deliveryId as string, "cancelled")).toBe(true);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([]);
		expect(resumeCalls).toEqual([]);
		expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
	});

	test("a lock that is still held defers a notice until a later recheck", async () => {
		const lock = installCompactLock(NARRATOR_ID);
		enqueueTaskNotice();
		await drainQueuedMessagesAfterCompact(NARRATOR_ID);
		expect(continuationCalls).toEqual([]);
		lock.settle();
		compactLocks.delete(NARRATOR_ID);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toHaveLength(1);
	});

	test("a busy narrator does not start a competing notice continuation", async () => {
		enqueueTaskNotice();
		activeNarrators.set(NARRATOR_ID, {
			alive: true,
			_loopRunning: true,
		} as NonNullable<ReturnType<typeof activeNarrators.get>>);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([]);
		expect(resumeCalls).toEqual([]);
	});

	test("an execution owner is not replaced by the post-compact wake", async () => {
		enqueueTaskNotice();
		const owner = tryClaimExecution(NARRATOR_ID, "run");
		if (!owner) throw new Error("Failed to install the existing execution owner");

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([]);
		expect(resumeCalls).toEqual([]);
		expect(getExecutionOwner(NARRATOR_ID)).toBe(owner);
	});

	test.each([
		"user_interrupt",
		"error",
	])("a %s stop is not overridden by a task notice", async (reason) => {
		enqueueTaskNotice();
		sqlite.run("UPDATE narrators SET last_stop_reason = ? WHERE id = ?", [reason, NARRATOR_ID]);

		await drainQueuedMessagesAfterCompact(NARRATOR_ID);

		expect(continuationCalls).toEqual([]);
		expect(resumeCalls).toEqual([]);
	});

	test("a question answer without its execution principal cannot authorize a wake", async () => {
		enqueueTaskNotice("completed", { questionAnswer: {} });
		const session = await import("../narrator-session");
		const injection = spyOn(session, "startInjectionContinuationIfPossible").mockResolvedValue({
			started: true,
		});
		try {
			await drainQueuedMessagesAfterCompact(NARRATOR_ID);

			expect(injection).not.toHaveBeenCalled();
			expect(continuationCalls).toEqual([]);
			expect(resumeCalls).toEqual([]);
		} finally {
			injection.mockRestore();
		}
	});
});
