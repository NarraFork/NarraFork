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

import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTestDb } from "../../../tests/setup";
import { users as pgUsers } from "../../db/postgres-schema";
import { narratorBufferedMessages, narrators, users } from "../../db/schema";
import { MAILBOX_LIMITS } from "../agent-runtime/limits";
import type { PostgresRuntimeQueue } from "../agent-runtime/postgres-runtime-queue";
import { bindRuntimeQueue } from "../agent-runtime/runtime-queue-port";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const {
	getBufferedMessages,
	getBufferedMessagesAsync,
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

describe("queued user identity", () => {
	const author = {
		id: "buffer-author",
		username: "queue-author",
		avatarColor: "teal",
		avatarImageId: "author-avatar",
	};
	db.insert(users)
		.values({ ...author, passwordHash: "private-hash", createdAt: new Date().toISOString() })
		.run();

	test("explicit primary snapshot survives canonical profile changes", async () => {
		const snapshot = { ...author, username: "snapshot-name", avatarColor: "pink" };
		const result = await enqueueBufferedMessage(
			NARRATOR_ID,
			"primary",
			undefined,
			undefined,
			author.id,
			snapshot,
		);
		const [message] = await getBufferedMessagesAsync(NARRATOR_ID);
		expect(message.createdBy).toBe(author.id);
		expect(message.creator).toEqual(snapshot);
		expect(toBufferSummary([message])[0].creator).toEqual(snapshot);
		expect(
			JSON.parse(
				db
					.select()
					.from(narratorBufferedMessages)
					.where(eq(narratorBufferedMessages.id, result.id))
					.get()?.creatorJson ?? "null",
			),
		).toEqual(snapshot);
	});

	test("child-like createdBy-only admission persists the public canonical author", async () => {
		const result = await enqueueBufferedMessage(
			NARRATOR_ID,
			"child",
			undefined,
			undefined,
			author.id,
			null,
		);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, result.id))
			.get();
		expect(row?.createdBy).toBe(author.id);
		expect(JSON.parse(row?.creatorJson ?? "null")).toEqual(author);
		const [message] = await getBufferedMessagesAsync(NARRATOR_ID);
		expect(toBufferSummary([message])[0].creator).toEqual(author);
	});

	test("legacy pending authors hydrate with one bounded public-field query and no payload reads", async () => {
		for (const text of ["legacy-one", "legacy-two"]) {
			const result = await enqueueBufferedMessage(
				NARRATOR_ID,
				text,
				undefined,
				undefined,
				author.id,
				author,
			);
			db.update(narratorBufferedMessages)
				.set({
					creatorJson: null,
					payloadRefJson: JSON.stringify({ path: "/missing-identity-test-payload" }),
					textFilePathsJson: JSON.stringify([
						{ path: "/missing-identity-test-attachment", filename: "missing.txt", size: 1 },
					]),
				})
				.where(eq(narratorBufferedMessages.id, result.id))
				.run();
		}
		const select = spyOn(db, "select");
		try {
			const messages = await getBufferedMessagesAsync(NARRATOR_ID);
			expect(messages.map((message) => message.creator)).toEqual([author, author]);
			expect(messages.map((message) => message.createdBy)).toEqual([author.id, author.id]);
			expect(select).toHaveBeenCalledTimes(2);
			expect(Object.keys(select.mock.calls[1][0] ?? {})).toEqual([
				"id",
				"username",
				"avatarColor",
				"avatarImageId",
			]);
			// The projection keeps lazy payload getters instead of spreading the message.
			expect(() => messages[0].text).toThrow();
			expect(typeof Object.getOwnPropertyDescriptor(messages[0], "textFiles")?.get).toBe(
				"function",
			);
		} finally {
			select.mockRestore();
		}
	});

	test("PG listing uses the canonical async runtime, never the unavailable SQLite handle", async () => {
		const result = await enqueueBufferedMessage(
			NARRATOR_ID,
			"pg legacy",
			undefined,
			undefined,
			author.id,
			author,
		);
		const row = db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, result.id))
			.get();
		if (!row) throw new Error("Expected fixture mailbox row");
		const select = mock((fields: Record<string, unknown>) => {
			expect(fields).toEqual({
				id: pgUsers.id,
				username: pgUsers.username,
				avatarColor: pgUsers.avatarColor,
				avatarImageId: pgUsers.avatarImageId,
			});
			return {
				from(table: unknown) {
					expect(table).toBe(pgUsers);
					return {
						where() {
							return {
								limit(limit: number) {
									expect(limit).toBe(1);
									return Promise.resolve([author]);
								},
							};
						},
					};
				},
			};
		});
		const listPending = mock(async (_id: string, options: { kinds: string[]; limit: number }) => {
			expect(options.kinds).toEqual(["user_input"]);
			expect(options.limit).toBe(MAILBOX_LIMITS.userPending);
			return [{ ...row, creatorJson: null }];
		});
		bindRuntimeQueue({
			backend: "postgres",
			queue: { mailbox: { listPending } } as unknown as PostgresRuntimeQueue,
		});
		mock.module("../../db", () => ({
			...realDbModule,
			sqlite,
			db: new Proxy(
				{},
				{
					get() {
						throw new Error("Forbidden SQLite access during PG identity lookup");
					},
				},
			),
			postgresRuntime: { client: { db: { select } } },
		}));
		try {
			const messages = await getBufferedMessagesAsync(NARRATOR_ID);
			expect(messages[0].creator).toEqual(author);
			expect(toBufferSummary(messages)[0].creator).toEqual(author);
			expect(select).toHaveBeenCalledTimes(1);
			expect(listPending).toHaveBeenCalledTimes(1);
		} finally {
			bindRuntimeQueue(undefined);
			mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
		}
	});

	test("machine mailbox rows are not presented as queued human messages", async () => {
		const result = await enqueueBufferedMessage(
			NARRATOR_ID,
			"machine",
			undefined,
			undefined,
			author.id,
			author,
		);
		db.update(narratorBufferedMessages)
			.set({ kind: "agent_message", creatorJson: null })
			.where(eq(narratorBufferedMessages.id, result.id))
			.run();
		const select = spyOn(db, "select");
		try {
			expect(await getBufferedMessagesAsync(NARRATOR_ID)).toEqual([]);
			expect(select).toHaveBeenCalledTimes(1);
		} finally {
			select.mockRestore();
		}
	});

	test("missing, deleted and absent user IDs stay anonymous rather than guess an author", async () => {
		for (const createdBy of ["nonexistent-user", null]) {
			await enqueueBufferedMessage(NARRATOR_ID, "unknown", undefined, undefined, createdBy);
		}
		const deletedId = "buffer-deleted-author";
		db.insert(users)
			.values({
				id: deletedId,
				username: deletedId,
				passwordHash: "private",
				createdAt: new Date().toISOString(),
			})
			.run();
		const deleted = await enqueueBufferedMessage(
			NARRATOR_ID,
			"deleted",
			undefined,
			undefined,
			deletedId,
		);
		db.update(narratorBufferedMessages)
			.set({ creatorJson: null })
			.where(eq(narratorBufferedMessages.id, deleted.id))
			.run();
		db.delete(users).where(eq(users.id, deletedId)).run();
		const messages = await getBufferedMessagesAsync(NARRATOR_ID);
		expect(messages.map((message) => message.creator)).toEqual([null, null, null]);
		expect(toBufferSummary(messages).map((message) => message.creator)).toEqual([null, null, null]);
	});
});

describe("durable queue modes", () => {
	test("PostgreSQL admission receives hard-front interrupt but FIFO tool ordering", async () => {
		const admissions: Array<{ mode: string; frontOrder: string }> = [];
		const admitUserBuffered = async (
			input: { metadata: { queueMode: string } },
			ordering: { frontOrder: string },
		) => {
			admissions.push({ mode: input.metadata.queueMode, frontOrder: ordering.frontOrder });
			return { status: "accepted", delivery: { id: `pg-${admissions.length}`, bufferedAt: "now" } };
		};
		bindRuntimeQueue({
			backend: "postgres",
			queue: { mailbox: { admitUserBuffered } } as unknown as PostgresRuntimeQueue,
		});
		const transaction = spyOn(db, "transaction").mockImplementation(() => {
			throw new Error("Forbidden SQLite admission under PostgreSQL");
		});
		try {
			await enqueue("older tool", "tool");
			await enqueue("new urgent", "interrupt");
			await enqueue("later tool", "tool");
			expect(admissions).toEqual([
				{ mode: "tool", frontOrder: "fifo" },
				{ mode: "interrupt", frontOrder: "stack" },
				{ mode: "tool", frontOrder: "fifo" },
			]);
			expect(transaction).not.toHaveBeenCalled();
		} finally {
			transaction.mockRestore();
			bindRuntimeQueue(undefined);
		}
	});
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
	test("urgent admission is hard-front while tool guidance remains FIFO", async () => {
		await enqueue("ordinary", "turn");
		await enqueue("first guide", "tool");
		await enqueue("second guide", "interrupt");
		const messages = getBufferedMessages(NARRATOR_ID);
		expect(messages.map((m) => m.text)).toEqual(["second guide", "first guide", "ordinary"]);
		expect(toBufferSummary(messages).map((m) => m.queueMode)).toEqual([
			"interrupt",
			"tool",
			"turn",
		]);
	});
	test("urgent mode promotes ahead of guidance without retrying failed payload", async () => {
		const first = await enqueue("first", "turn");
		const second = await enqueue("second", "tool");
		await enqueue("third", "turn");
		db.update(narratorBufferedMessages)
			.set({ state: "failed", lastError: "test failure" })
			.where(eq(narratorBufferedMessages.id, first.id))
			.run();
		expect(await updateBufferedMessageMode(NARRATOR_ID, first.id, "interrupt")).toBe(true);
		expect(getBufferedMessages(NARRATOR_ID).map((m) => m.text)).toEqual([
			"first",
			"second",
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
