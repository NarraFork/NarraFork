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
import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import { users as pgUsers } from "../../db/postgres-schema";
import { narratorBufferedMessages, narrators, users } from "../../db/schema";
import { logger } from "../../lib/logger";
import { MAILBOX_LIMITS } from "../agent-runtime/limits";
import { createMailboxStore } from "../agent-runtime/mailbox";
import { getExecutionOwner, tryClaimExecution } from "../agent-runtime/ownership";
import type { PostgresRuntimeQueue } from "../agent-runtime/postgres-runtime-queue";
import { RuntimeReadConflictError } from "../agent-runtime/read-conflict";
import { bindRuntimeQueue } from "../agent-runtime/runtime-queue-port";
import { bufferEditHolds, isBufferConsumptionHeld } from "../buffer-edit-hold";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
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
	takeBufferedMessageForIndependentCommand,
	runIndependentBufferedCommand,
	updateBufferedMessage,
	removeBufferedMessage,
	retryBufferedMessage,
	canEditBufferedMessage,
	persistAdditionalBufferedTextFiles,
	clearBufferedMessages,
	cleanupBufferedTextFilesAsync,
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

afterAll(async () => {
	await fixture.close();
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
		const messages = await getBufferedMessages(NARRATOR_ID);
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
		expect((await getBufferedMessages(NARRATOR_ID)).map((m) => m.text)).toEqual([
			"first",
			"second",
			"third",
		]);
		const failed = (await getBufferedMessages(NARRATOR_ID)).find((m) => m.id === first.id);
		expect(failed?.state).toBe("failed");
		expect(failed?.error).toBe("test failure");
		expect(await updateBufferedMessageMode(NARRATOR_ID, second.id, "turn")).toBe(true);
		expect((await getBufferedMessages(NARRATOR_ID)).map((m) => m.text)).toEqual([
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
		expect((await getBufferedMessages(NARRATOR_ID)).map((m) => m.text)).toEqual([
			"guide",
			"b",
			"a",
		]);
		expect(await reorderBufferedMessages(NARRATOR_ID, [a.id, b.id])).toBe(true);
		db.update(narratorBufferedMessages)
			.set({ state: "claimed" })
			.where(eq(narratorBufferedMessages.id, guide.id))
			.run();
		expect(await updateBufferedMessageMode(NARRATOR_ID, guide.id, "turn")).toBe(false);
	});
});

describe("takeBufferedMessageForIndependentCommand", () => {
	function readRow(id: string) {
		return db
			.select()
			.from(narratorBufferedMessages)
			.where(eq(narratorBufferedMessages.id, id))
			.get();
	}

	test("takes the selected non-head row without changing other rows or their order", async () => {
		const first = await enqueueBufferedMessage(NARRATOR_ID, "older ordinary input");
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new independent task");
		const last = await enqueueBufferedMessage(NARRATOR_ID, "later ordinary input");
		const other = await enqueueBufferedMessage(OTHER_ID, "/new another narrator");
		const untouched = [first, last, other].map(({ id }) => readRow(id));
		const accepts = mock((message: { id: string; text: string }) => {
			expect(message.id).toBe(selected.id);
			expect(message.text).toBe("/new independent task");
			return true;
		});

		const message = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			accepts,
		);

		expect(message?.id).toBe(selected.id);
		expect(message?.text).toBe("/new independent task");
		expect(message?._mailboxClaim).toBeUndefined();
		expect(accepts).toHaveBeenCalledTimes(1);
		expect(message?._independentNewNarratorId).toBeString();
		expect(readRow(selected.id)).toMatchObject({
			state: "failed",
			lastError: "Independent /new dispatch incomplete; explicitly retry to finish",
			text: "/new independent task",
		});
		expect([first, last, other].map(({ id }) => readRow(id))).toEqual(untouched);
		expect((await getBufferedMessagesAsync(NARRATOR_ID)).map((row) => row.id)).toEqual([
			first.id,
			selected.id,
			last.id,
		]);
	});

	test("does not register an execution owner even while accepting an ownerless command", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new ownerless");
		expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
		expect(activeNarrators.has(NARRATOR_ID)).toBe(false);
		const accepts = mock(() => {
			expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
			expect(activeNarrators.has(NARRATOR_ID)).toBe(false);
			return true;
		});
		expect(
			await takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
		).toBeDefined();
		expect(accepts).toHaveBeenCalledTimes(1);
		expect(getExecutionOwner(NARRATOR_ID)).toBeUndefined();
		expect(activeNarrators.has(NARRATOR_ID)).toBe(false);
	});

	test("leaves the existing execution owner and live loop untouched", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new while running");
		registerLiveLoop(NARRATOR_ID);
		const session = activeNarrators.get(NARRATOR_ID);
		if (!session) throw new Error("Expected fixture live session");
		const owner = tryClaimExecution(NARRATOR_ID, "run");
		if (!owner) throw new Error("Expected fixture execution owner");
		const sessionBefore = { ...session };
		try {
			const message = await takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				() => {
					expect(getExecutionOwner(NARRATOR_ID)).toBe(owner);
					return true;
				},
			);
			expect(message?.id).toBe(selected.id);
			expect(getExecutionOwner(NARRATOR_ID)).toBe(owner);
			expect(owner.isCurrent()).toBe(true);
			expect(activeNarrators.get(NARRATOR_ID)).toBe(session);
			expect(session).toEqual(sessionBefore);
		} finally {
			owner.release();
		}
	});

	test("concurrent takes succeed once and never automatically replay the parked command", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new only once");
		const accepts = mock(() => true);
		const results = await Promise.allSettled([
			takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
			takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
		]);
		const fulfilled = results.filter((result) => result.status === "fulfilled");
		const rejected = results.filter((result) => result.status === "rejected");
		expect(fulfilled.map((result) => result.value?.id)).toEqual([selected.id]);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toMatchObject({ code: "BUFFER_EDIT_CONFLICT" });
		expect(
			await takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
		).toBeUndefined();
		expect(accepts).toHaveBeenCalledTimes(1);
		expect(readRow(selected.id)?.state).toBe("failed");
	});

	test.each([
		{ text: "/new quoted literally", literal: true },
		{ text: "ordinary guidance", literal: false },
	])("honors injected rejection for $text", async ({ text, literal }) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, text);
		db.update(narratorBufferedMessages)
			.set({ metadataJson: JSON.stringify({ executionIntent: { literal } }) })
			.where(eq(narratorBufferedMessages.id, selected.id))
			.run();
		const before = readRow(selected.id);
		const accepts = mock((message: { text: string; executionIntent?: { literal?: boolean } }) => {
			expect(message.text).toBe(text);
			expect(message.executionIntent?.literal).toBe(literal);
			return false;
		});
		expect(
			await takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
		).toBeUndefined();
		expect(accepts).toHaveBeenCalledTimes(1);
		expect(readRow(selected.id)).toEqual(before);
	});

	test("does not offer failed, claimed, machine, foreign, undeliverable or missing rows", async () => {
		const ids: string[] = [];
		for (const state of ["failed", "claimed"] as const) {
			const selected = await enqueueBufferedMessage(NARRATOR_ID, `/new ${state}`);
			db.update(narratorBufferedMessages)
				.set({ state })
				.where(eq(narratorBufferedMessages.id, selected.id))
				.run();
			ids.push(selected.id);
		}
		const machine = await enqueueBufferedMessage(NARRATOR_ID, "/new machine");
		db.update(narratorBufferedMessages)
			.set({ kind: "agent_message" })
			.where(eq(narratorBufferedMessages.id, machine.id))
			.run();
		const undeliverable = await enqueueBufferedMessage(NARRATOR_ID, "/new no delivery");
		db.update(narratorBufferedMessages)
			.set({ deliveryId: null })
			.where(eq(narratorBufferedMessages.id, undeliverable.id))
			.run();
		const foreign = await enqueueBufferedMessage(OTHER_ID, "/new foreign");
		ids.push(machine.id, undeliverable.id, foreign.id, "missing-independent-command");
		const before = ids.map(readRow);
		const accepts = mock(() => true);
		for (const id of ids) {
			expect(
				await takeBufferedMessageForIndependentCommand(NARRATOR_ID, id, accepts),
			).toBeUndefined();
		}
		expect(accepts).not.toHaveBeenCalled();
		expect(ids.map(readRow)).toEqual(before);
	});

	test("explicit retries reuse the target and ordinary edit/retry cannot revive the source", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new retry");
		const first = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			() => true,
		);
		const held = readRow(selected.id);
		expect(await canEditBufferedMessage(NARRATOR_ID, selected.id)).toBe(false);
		expect(await updateBufferedMessage(NARRATOR_ID, selected.id, "ordinary input")).toBe(false);
		expect(await updateBufferedMessageMode(NARRATOR_ID, selected.id, "tool")).toBe(false);
		expect(await retryBufferedMessage(NARRATOR_ID, selected.id)).toBe(false);
		expect(
			String(
				await captureWorkerRejection(
					persistAdditionalBufferedTextFiles(selected.id, [new File(["extra"], "extra.txt")], []),
				),
			),
		).toContain("no longer editable");
		expect(readRow(selected.id)).toEqual(held);
		const retry = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			() => true,
			{ retry: true },
		);
		expect(retry?._independentNewNarratorId).toBe(first?._independentNewNarratorId);
		expect(readRow(selected.id)?.contentRevision).toBe((held?.contentRevision ?? 0) + 1);
		expect(await removeBufferedMessage(NARRATOR_ID, selected.id)).toBe(true);
		expect(readRow(selected.id)?.state).toBe("cancelled");
	});

	test("only the exact claim may convert a consumer-claimed /new", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new consumer");
		const claim = { id: selected.id, narratorId: NARRATOR_ID, token: "token", epoch: "epoch" };
		db.update(narratorBufferedMessages)
			.set({
				state: "claimed",
				claimToken: claim.token,
				claimEpoch: claim.epoch,
				claimedAt: new Date().toISOString(),
			})
			.where(eq(narratorBufferedMessages.id, selected.id))
			.run();
		const before = readRow(selected.id);
		const accepts = mock(() => true);
		for (const claimed of [
			{ ...claim, token: "stale" },
			{ ...claim, epoch: "stale" },
			{ ...claim, id: "other" },
			{ ...claim, narratorId: OTHER_ID },
		]) {
			expect(
				await takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts, {
					claimed,
				}),
			).toBeUndefined();
		}
		expect(accepts).not.toHaveBeenCalled();
		expect(readRow(selected.id)).toEqual(before);
		const converted = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			accepts,
			{ claimed: claim },
		);
		expect(converted?._independentNewNarratorId).toBeString();
		expect(converted?._mailboxClaim).toBeUndefined();
		expect(readRow(selected.id)).toMatchObject({
			state: "failed",
			claimToken: null,
			claimEpoch: null,
			claimedAt: null,
			contentRevision: (before?.contentRevision ?? 0) + 1,
		});
	});

	test.each([
		"token",
		"epoch",
	] as const)("claim conversion CAS rejects concurrent %s replacement", async (key) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new claim race");
		const claim = { id: selected.id, narratorId: NARRATOR_ID, token: "token", epoch: "epoch" };
		db.update(narratorBufferedMessages)
			.set({ state: "claimed", claimToken: claim.token, claimEpoch: claim.epoch })
			.where(eq(narratorBufferedMessages.id, selected.id))
			.run();
		await expect(
			takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				() => {
					db.update(narratorBufferedMessages)
						.set(key === "token" ? { claimToken: "next" } : { claimEpoch: "next" })
						.where(eq(narratorBufferedMessages.id, selected.id))
						.run();
					return true;
				},
				{ claimed: claim },
			),
		).rejects.toBeInstanceOf(RuntimeReadConflictError);
		expect(readRow(selected.id)?.state).toBe("claimed");
		expect(readRow(selected.id)?.text).toBe("/new claim race");
	});

	test("dispatch protects only its own row while source urgent/edit/claim remain live", async () => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new protected");
		const unrelated = await enqueueBufferedMessage(NARRATOR_ID, "ordinary source input");
		const message = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			() => true,
		);
		const target = message?._independentNewNarratorId;
		if (!target) throw new Error("Expected target");
		const dispatch = mock(async () => target);
		expect(
			await captureWorkerRejection(
				runIndependentBufferedCommand(NARRATOR_ID, selected.id, "wrong", dispatch),
			),
		).toBeInstanceOf(RuntimeReadConflictError);
		expect(dispatch).not.toHaveBeenCalled();
		expect(
			String(
				await captureWorkerRejection(
					runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, async () => "wrong"),
				),
			),
		).toContain("unexpected narrator id");
		expect(readRow(selected.id)?.state).toBe("failed");
		let entered!: () => void;
		let finish!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const completed = runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, async () => {
			entered();
			await gate;
			return target;
		});
		await started;
		try {
			expect(isBufferConsumptionHeld(NARRATOR_ID)).toBe(false);
			expect(
				await updateBufferedMessage(NARRATOR_ID, unrelated.id, "source edit during dispatch"),
			).toBe(true);
			expect(await updateBufferedMessageMode(NARRATOR_ID, unrelated.id, "interrupt")).toBe(true);
			expect(isBufferConsumptionHeld(NARRATOR_ID)).toBe(false);
			const claimed = await bufferEditHolds.exclusive(NARRATOR_ID, () =>
				isBufferConsumptionHeld(NARRATOR_ID)
					? undefined
					: createMailboxStore(db).claimEligibleHead(NARRATOR_ID, {
							token: "source-loop",
							epoch: "source-epoch",
						}),
			);
			expect(claimed?.id).toBe(unrelated.id);
			expect(claimed?.priority).toBe(true);
			expect(await captureWorkerRejection(clearBufferedMessages(NARRATOR_ID))).toMatchObject({
				code: "BUFFER_EDIT_CONFLICT",
			});
			expect(
				await captureWorkerRejection(removeBufferedMessage(NARRATOR_ID, selected.id)),
			).toMatchObject({ code: "BUFFER_EDIT_CONFLICT" });
			expect(
				await captureWorkerRejection(
					updateBufferedMessage(NARRATOR_ID, selected.id, "replacement"),
				),
			).toMatchObject({ code: "BUFFER_EDIT_CONFLICT" });
			expect(readRow(selected.id)?.state).toBe("failed");
		} finally {
			finish();
		}
		expect(await completed).toBe(target);
		expect(readRow(selected.id)?.state).toBe("cancelled");
	});

	test.each([
		"revision",
		"state",
		"metadata",
	] as const)("rejects a stale SQLite observation after a concurrent %s change", async (change) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new stale");
		const accepts = mock(() => {
			db.update(narratorBufferedMessages)
				.set(
					change === "revision"
						? { contentRevision: 7 }
						: change === "state"
							? { state: "claimed" }
							: { metadataJson: JSON.stringify({ executionIntent: { literal: true } }) },
				)
				.where(eq(narratorBufferedMessages.id, selected.id))
				.run();
			return true;
		});
		await expect(
			takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, accepts),
		).rejects.toBeInstanceOf(RuntimeReadConflictError);
		expect(accepts).toHaveBeenCalledTimes(1);
		expect(readRow(selected.id)?.state).toBe(change === "state" ? "claimed" : "queued");
		expect(readRow(selected.id)?.text).toBe("/new stale");
	});

	test("retains staged payload on callback failure and cleans only after durable target acceptance", async () => {
		const text = `/new ${"large body ".repeat(Math.ceil(MAILBOX_LIMITS.inlineBytes / 10))}`;
		const commandText = `/new ${"command ".repeat(MAILBOX_LIMITS.metadataBytes / 8)}`;
		const attachmentText = "independent recipient must still be able to copy this attachment";
		const selected = await enqueueBufferedMessage(
			NARRATOR_ID,
			text,
			undefined,
			commandText,
			undefined,
			undefined,
			[new File([attachmentText], "instructions.txt", { type: "text/plain" })],
		);
		const row = readRow(selected.id);
		if (!row) throw new Error("Expected staged mailbox row");
		const payload = JSON.parse(row.payloadRefJson ?? "null") as { path: string };
		const metadata = JSON.parse(row.metadataJson ?? "null") as {
			stagingId: string;
			commandTextPath: string;
		};
		const saved = JSON.parse(row.textFilePathsJson ?? "null") as Array<{ path: string }>;
		try {
			expect(row.text).toBe("");
			expect(row.commandText).toBeNull();
			const message = await takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				(projected) => projected.commandText === commandText,
			);
			expect(message?.text).toBe(text);
			expect(message?.commandText).toBe(commandText);
			expect(Object.getOwnPropertyDescriptor(message, "text")?.get).toBeFunction();
			expect(Object.getOwnPropertyDescriptor(message, "commandText")?.get).toBeFunction();
			expect(Object.getOwnPropertyDescriptor(message, "textFiles")?.get).toBeFunction();
			expect(message?.textFiles?.[0].name).toBe("instructions.txt");
			expect(await message?.textFiles?.[0].text()).toBe(attachmentText);
			expect(message?._stagingId).toBe(metadata.stagingId);
			for (const path of [payload.path, metadata.commandTextPath, saved[0].path]) {
				expect(existsSync(path)).toBe(true);
			}
			const target = message?._independentNewNarratorId;
			if (!target) throw new Error("Expected independent recipient");
			const failure = new Error("recipient persist failed");
			expect(
				await captureWorkerRejection(
					runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, async (current) => {
						expect(current.text).toBe(text);
						expect(await current.textFiles?.[0].text()).toBe(attachmentText);
						throw failure;
					}),
				),
			).toBe(failure);
			expect(readRow(selected.id)).toMatchObject({
				state: "failed",
				payloadRefJson: row.payloadRefJson,
				textFilePathsJson: row.textFilePathsJson,
			});
			expect(readRow(selected.id)?.lastError).toContain("recipient persist failed");
			for (const path of [payload.path, metadata.commandTextPath, saved[0].path])
				expect(existsSync(path)).toBe(true);
			const retry = await takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				() => true,
				{ retry: true },
			);
			expect(retry?._independentNewNarratorId).toBe(target);
			const result = await runIndependentBufferedCommand(
				NARRATOR_ID,
				selected.id,
				target,
				async (current) => {
					expect(readRow(selected.id)?.state).toBe("failed");
					expect(current.text).toBe(text);
					expect(current.commandText).toBe(commandText);
					expect(await current.textFiles?.[0].text()).toBe(attachmentText);
					for (const path of [payload.path, metadata.commandTextPath, saved[0].path])
						expect(existsSync(path)).toBe(true);
					return target;
				},
			);
			expect(result).toBe(target);
			expect(readRow(selected.id)).toMatchObject({
				state: "cancelled",
				payloadRefJson: null,
				textFilePathsJson: null,
			});
			for (const path of [payload.path, metadata.commandTextPath, saved[0].path])
				expect(existsSync(path)).toBe(false);
		} finally {
			await cleanupBufferedTextFilesAsync(metadata.stagingId);
		}
	});

	test("successful target acceptance with a lost source CAS keeps source staging for explicit recovery", async () => {
		const selected = await enqueueBufferedMessage(
			NARRATOR_ID,
			"/new final CAS",
			undefined,
			undefined,
			undefined,
			undefined,
			[new File(["source attachment"], "keep.txt")],
		);
		const message = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			() => true,
		);
		const target = message?._independentNewNarratorId;
		const saved = message?._savedFiles?.[0];
		if (!target || !saved) throw new Error("Expected staged independent source");
		const before = readRow(selected.id);
		expect(
			await captureWorkerRejection(
				runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, async () => {
					db.update(narratorBufferedMessages)
						.set({ contentRevision: (before?.contentRevision ?? 0) + 1 })
						.where(eq(narratorBufferedMessages.id, selected.id))
						.run();
					return target;
				}),
			),
		).toBeInstanceOf(RuntimeReadConflictError);
		expect(readRow(selected.id)?.state).toBe("failed");
		expect(existsSync(saved.path)).toBe(true);
		expect(JSON.parse(readRow(selected.id)?.metadataJson ?? "{}").independentNewNarratorId).toBe(
			target,
		);
		expect(await removeBufferedMessage(NARRATOR_ID, selected.id)).toBe(true);
		expect(existsSync(saved.path)).toBe(false);
	});

	test("completion receipt survives a real SQLite commit followed by an exception and repeated mode/retry", async () => {
		const selected = await enqueueBufferedMessage(
			NARRATOR_ID,
			"/new commit receipt",
			undefined,
			undefined,
			undefined,
			undefined,
			[new File(["accepted"], "receipt.txt")],
		);
		const message = await takeBufferedMessageForIndependentCommand(
			NARRATOR_ID,
			selected.id,
			() => true,
		);
		const target = message?._independentNewNarratorId;
		if (!target || !message?._stagingId) throw new Error("Expected source reservation");
		const before = readRow(selected.id);
		const transaction = db.transaction.bind(db);
		let injected = false;
		const responseLost = new Error("SQLite commit succeeded but response failed");
		const commitFault = spyOn(db, "transaction").mockImplementation((work, config) => {
			const result = transaction(work, config);
			if (!injected) {
				injected = true;
				throw responseLost;
			}
			return result;
		});
		const dispatch = mock(async () => target);
		try {
			expect(await runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, dispatch)).toBe(
				target,
			);
		} finally {
			commitFault.mockRestore();
		}
		expect(injected).toBe(true);
		expect(dispatch).toHaveBeenCalledTimes(1);
		const receipt = readRow(selected.id);
		expect(receipt).toMatchObject({
			state: "cancelled",
			text: "",
			payloadRefJson: null,
			textFilePathsJson: null,
			contentRevision: (before?.contentRevision ?? 0) + 1,
		});
		expect(JSON.parse(receipt?.metadataJson ?? "{}")).toEqual({
			independentNewNarratorId: target,
			independentNewCompleted: true,
			stagingId: message._stagingId,
		});
		const accepts = mock(() => {
			throw new Error("Completed payload must not be reparsed");
		});
		for (const retry of [false, true]) {
			const replay = await takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				accepts,
				{ retry },
			);
			expect(replay).toMatchObject({
				_independentNewNarratorId: target,
				_independentNewCompleted: true,
				text: "",
			});
			expect(await runIndependentBufferedCommand(NARRATOR_ID, selected.id, target, dispatch)).toBe(
				target,
			);
		}
		expect(accepts).not.toHaveBeenCalled();
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(readRow(selected.id)).toEqual(receipt);
	});

	test.each([
		"confirmed",
		"uncommitted",
		"unknown",
	] as const)("PG ambiguous completion is recovered only by its durable receipt (%s)", async (outcome) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new PG commit receipt");
		const fixtureRow = readRow(selected.id);
		if (!fixtureRow) throw new Error("Expected source fixture");
		const row = {
			...fixtureRow,
			id: "pg-ambiguous-source",
			state: "failed",
			metadataJson: JSON.stringify({ independentNewNarratorId: "pg-receipt-target" }),
		};
		let confirming = false;
		let readFails = outcome === "unknown";
		const failure = new Error("PG response lost after final write");
		const getById = mock(async () => {
			if (confirming && readFails) throw new Error("PG confirmation unavailable");
			return row;
		});
		const completeIndependentUserCommand = mock(async () => {
			confirming = true;
			if (outcome !== "uncommitted") {
				row.state = "cancelled";
				row.text = "";
				row.metadataJson = JSON.stringify({
					independentNewNarratorId: "pg-receipt-target",
					independentNewCompleted: true,
					stagingId: row.id,
				});
			}
			throw failure;
		});
		bindRuntimeQueue({
			backend: "postgres",
			queue: {
				mailbox: { getById, completeIndependentUserCommand },
			} as unknown as PostgresRuntimeQueue,
		});
		const dispatch = mock(async () => "pg-receipt-target");
		try {
			const result = runIndependentBufferedCommand(
				NARRATOR_ID,
				row.id,
				"pg-receipt-target",
				dispatch,
			);
			if (outcome === "confirmed") expect(await result).toBe("pg-receipt-target");
			else expect(await captureWorkerRejection(result)).toBe(failure);
			expect(row.state).toBe(outcome === "uncommitted" ? "failed" : "cancelled");
			readFails = false;
			if (outcome !== "uncommitted") {
				const accepts = mock(() => false);
				for (const retry of [false, true]) {
					expect(
						await takeBufferedMessageForIndependentCommand(NARRATOR_ID, row.id, accepts, { retry }),
					).toMatchObject({
						_independentNewCompleted: true,
						_independentNewNarratorId: "pg-receipt-target",
					});
					expect(
						await runIndependentBufferedCommand(NARRATOR_ID, row.id, "pg-receipt-target", dispatch),
					).toBe("pg-receipt-target");
				}
				expect(accepts).not.toHaveBeenCalled();
			}
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(completeIndependentUserCommand).toHaveBeenCalledTimes(1);
		} finally {
			bindRuntimeQueue(undefined);
		}
		expect(readRow(selected.id)).toEqual(fixtureRow);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"real staging cleanup EACCES cannot turn accepted dispatch into failure or requeue",
		async () => {
			const selected = await enqueueBufferedMessage(
				NARRATOR_ID,
				"/new cleanup fault",
				undefined,
				undefined,
				undefined,
				undefined,
				[new File(["keep until accepted"], "attachment.txt", { type: "text/plain" })],
			);
			const message = await takeBufferedMessageForIndependentCommand(
				NARRATOR_ID,
				selected.id,
				() => true,
			);
			const target = message?._independentNewNarratorId;
			const saved = message?._savedFiles?.[0];
			if (!target || !saved || !message?._stagingId) throw new Error("Expected staged recipient");
			const directory = dirname(saved.path);
			const warn = spyOn(logger, "warn");
			try {
				chmodSync(directory, 0o500);
				const result = await runIndependentBufferedCommand(
					NARRATOR_ID,
					selected.id,
					target,
					async (current) => {
						expect(await current.textFiles?.[0].text()).toBe("keep until accepted");
						expect(existsSync(saved.path)).toBe(true);
						return target;
					},
				);
				expect(result).toBe(target);
				expect(readRow(selected.id)?.state).toBe("cancelled");
				expect(existsSync(saved.path)).toBe(true);
				expect(warn).toHaveBeenCalledWith(
					"Independent command staging cleanup deferred",
					expect.objectContaining({
						messageId: selected.id,
						error: expect.stringContaining("EACCES"),
					}),
				);
				expect(await retryBufferedMessage(NARRATOR_ID, selected.id)).toBe(false);
				expect(
					await takeBufferedMessageForIndependentCommand(NARRATOR_ID, selected.id, () => true, {
						retry: true,
					}),
				).toMatchObject({ _independentNewNarratorId: target, _independentNewCompleted: true });
			} finally {
				warn.mockRestore();
				chmodSync(directory, 0o700);
				await cleanupBufferedTextFilesAsync(message._stagingId);
			}
		},
	);

	test.each([
		true,
		false,
	])("PG dispatch completes/fails exclusively through the bound queue (success=%s)", async (success) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new pg dispatch");
		const original = readRow(selected.id);
		if (!original) throw new Error("Expected fixture row");
		const row = {
			...original,
			id: "pg-dispatch-source",
			state: "failed",
			contentRevision: 9,
			metadataJson: JSON.stringify({ independentNewNarratorId: "pg-target" }),
		};
		const failure = new Error("PG target failed");
		const getById = mock(async () => row);
		const expectedMetadata = row.metadataJson;
		const completeIndependentUserCommand = mock(async () => {
			row.state = "cancelled";
			row.text = "";
			row.metadataJson = JSON.stringify({
				independentNewNarratorId: "pg-target",
				independentNewCompleted: true,
				stagingId: row.id,
			});
			return true;
		});
		const holdIndependentUserCommand = mock(async () => true);
		bindRuntimeQueue({
			backend: "postgres",
			queue: {
				mailbox: { getById, completeIndependentUserCommand, holdIndependentUserCommand },
			} as unknown as PostgresRuntimeQueue,
		});
		const forbiddenSqlite = new Proxy(
			{},
			{
				get() {
					throw new Error("Forbidden SQLite access during PG dispatch");
				},
			},
		);
		mock.module("../../db", () => ({
			...realDbModule,
			db: forbiddenSqlite,
			sqlite: forbiddenSqlite,
		}));
		try {
			const dispatch = runIndependentBufferedCommand(
				NARRATOR_ID,
				row.id,
				"pg-target",
				async (current) => {
					expect(current.text).toBe("/new pg dispatch");
					expect(current._independentNewNarratorId).toBe("pg-target");
					if (!success) throw failure;
					return "pg-target";
				},
			);
			if (success) {
				expect(await dispatch).toBe("pg-target");
				expect(completeIndependentUserCommand).toHaveBeenCalledWith(
					NARRATOR_ID,
					row.id,
					"pg-target",
					{ revision: 9, metadataJson: expectedMetadata },
					"Dispatched independent /new command",
				);
				expect(holdIndependentUserCommand).not.toHaveBeenCalled();
			} else {
				expect(await captureWorkerRejection(dispatch)).toBe(failure);
				expect(completeIndependentUserCommand).not.toHaveBeenCalled();
				expect(holdIndependentUserCommand).toHaveBeenCalledWith(
					NARRATOR_ID,
					row.id,
					"pg-target",
					{ state: "failed", revision: 9, metadataJson: row.metadataJson },
					expect.stringContaining("PG target failed"),
				);
			}
		} finally {
			bindRuntimeQueue(undefined);
			mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
		}
		expect(readRow(selected.id)).toEqual(original);
	});

	test.each([
		true,
		false,
	])("PG uses named independent hold authority and observed revision without SQLite (hold=%s)", async (cancelled) => {
		const selected = await enqueueBufferedMessage(NARRATOR_ID, "/new pg authority");
		const fixtureRow = readRow(selected.id);
		if (!fixtureRow) throw new Error("Expected fixture mailbox row");
		const row = {
			...fixtureRow,
			id: "pg-independent-row",
			deliveryId: "pg-independent-delivery",
			contentRevision: 7,
		};
		const getById = mock(async (id: string) => {
			expect(id).toBe(row.id);
			return row;
		});
		const holdIndependentUserCommand = mock(async () => cancelled);
		bindRuntimeQueue({
			backend: "postgres",
			queue: {
				mailbox: { getById, holdIndependentUserCommand },
			} as unknown as PostgresRuntimeQueue,
		});
		const forbiddenSqlite = new Proxy(
			{},
			{
				get() {
					throw new Error("Forbidden SQLite access during independent PG command");
				},
			},
		);
		mock.module("../../db", () => ({
			...realDbModule,
			db: forbiddenSqlite,
			sqlite: forbiddenSqlite,
		}));
		try {
			const result = takeBufferedMessageForIndependentCommand(NARRATOR_ID, row.id, () => true);
			if (cancelled) {
				expect(await result).toMatchObject({ id: row.id, text: "/new pg authority" });
			} else {
				await expect(result).rejects.toBeInstanceOf(RuntimeReadConflictError);
			}
			expect(getById).toHaveBeenCalledTimes(1);
			expect(holdIndependentUserCommand).toHaveBeenCalledTimes(1);
			expect(holdIndependentUserCommand).toHaveBeenCalledWith(
				NARRATOR_ID,
				row.id,
				expect.any(String),
				{ state: "queued", revision: 7, metadataJson: row.metadataJson, claim: undefined },
				"Independent /new dispatch incomplete; explicitly retry to finish",
			);
		} finally {
			bindRuntimeQueue(undefined);
			mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
		}
		expect(readRow(selected.id)).toEqual(fixtureRow);
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
			expect((await getBufferedMessages(NARRATOR_ID)).map((msg) => msg.text)).toEqual([
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

			expect((await getBufferedMessages(NARRATOR_ID)).map((msg) => msg.text)).toEqual([
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
		expect(await getBufferedMessages(NARRATOR_ID)).toEqual([]);
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
		expect((await getBufferedMessages(NARRATOR_ID)).map((msg) => msg.text)).toEqual(["during"]);
	});
});

describe("independent command queue summaries", () => {
	for (const queueMode of ["turn", "tool", "interrupt"] as const) {
		test(`${queueMode} exposes retry-only capability without leaking the reserved narrator ID`, () => {
			const targetId = "private-reserved-narrator";
			const input = {
				id: "failed-input",
				text: "/new task",
				bufferedAt: "2026-01-01",
				state: "failed" as const,
				queueMode,
			};
			const [ordinary, reserved] = toBufferSummary([
				input,
				{ ...input, _independentNewNarratorId: targetId },
			]);
			expect(ordinary.retryOnly).toBeUndefined();
			expect(reserved.retryOnly).toBe(true);
			expect(reserved.state).toBe("failed");
			expect(reserved.queueMode).toBe(queueMode);
			expect(reserved).not.toHaveProperty("_independentNewNarratorId");
			expect(JSON.stringify(reserved)).not.toContain(targetId);
		});
	}
});
