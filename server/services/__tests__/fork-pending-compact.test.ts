/**
 * The fork ref-copy must never share a message that still carries an in-flight
 * history compact marker: the parent's finalizer will copy-on-write that row,
 * leaving the child with a marker it can never finish.
 *
 * This used to be enforced by expanding `json_each(content_json)` over every
 * message in the fork prefix, which read the entire history's message bodies.
 * It is now enforced through the `compact_pending` generated column plus its
 * partial index. These tests pin the *behaviour* so the cheaper implementation
 * cannot silently diverge from the predicate it replaced.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import { narratorService } from "../narrator-service";

const TAG = `fork-pending-${Date.now()}`;
let parentId: string;

/** Content of a compact marker in each lifecycle state. */
const COMPACT_BLOCKS = {
	compacting: { type: "compact", status: "compacting", summary: "" },
	legacyRunning: { type: "compact", status: "running", summary: "" },
	runningAttempt: {
		type: "compact",
		status: "compacted",
		summary: "done",
		attempts: [
			{ attempt: 1, model: "m", status: "failed", startedAt: "t0", finishedAt: "t1" },
			{ attempt: 2, model: "m", status: "running", startedAt: "t2" },
		],
	},
	compacted: { type: "compact", status: "compacted", summary: "stable" },
	failed: { type: "compact", status: "failed", summary: "", error: "boom" },
} as const;

async function insertMessage(
	narratorId: string,
	seq: number,
	contentJson: unknown,
	role: "user" | "assistant" | "system" = "system",
): Promise<string> {
	const id = `${TAG}-msg-${seq}`;
	const now = new Date().toISOString();
	await db.insert(narratorMessages).values({
		id,
		narratorId,
		role,
		contentJson,
		contentText: `msg ${seq}`,
		createdAt: now,
	});
	await db.insert(narratorMessageRefs).values({
		id: `${TAG}-ref-${seq}`,
		narratorId,
		messageId: id,
		seq,
		isCompact: 0,
	});
	return id;
}

beforeAll(async () => {
	parentId = `${TAG}-parent`;
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: parentId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});

	// A realistic prefix: ordinary turns interleaved with compact markers in every
	// lifecycle state. Odd states are what the predicate has to discriminate.
	await insertMessage(parentId, 0, [{ type: "text", text: "hello" }], "user");
	await insertMessage(parentId, 1, [{ type: "text", text: "hi" }], "assistant");
	await insertMessage(parentId, 2, [COMPACT_BLOCKS.compacted]);
	await insertMessage(parentId, 3, [{ type: "text", text: "more" }], "assistant");
	await insertMessage(parentId, 4, [COMPACT_BLOCKS.failed]);
	await insertMessage(parentId, 5, [COMPACT_BLOCKS.compacting]);
	await insertMessage(parentId, 6, [COMPACT_BLOCKS.legacyRunning]);
	await insertMessage(parentId, 7, [COMPACT_BLOCKS.runningAttempt]);
	await insertMessage(parentId, 8, [{ type: "text", text: "tail" }], "assistant");
});

describe("compact_pending generated column", () => {
	test("flags exactly the in-flight compact markers", async () => {
		const rows = await db
			.select({
				id: narratorMessages.id,
				compactPending: narratorMessages.compactPending,
			})
			.from(narratorMessages)
			.innerJoin(narratorMessageRefs, eq(narratorMessageRefs.messageId, narratorMessages.id))
			.where(eq(narratorMessageRefs.narratorId, parentId))
			.orderBy(narratorMessageRefs.seq);

		const pendingSeqs = rows
			.map((row, index) => ({ index, pending: row.compactPending }))
			.filter((row) => row.pending === 1)
			.map((row) => row.index);

		// seq 5 (compacting), 6 (legacy running), 7 (last attempt running).
		expect(pendingSeqs).toEqual([5, 6, 7]);
	});

	test("stays in sync when a marker is finalized", async () => {
		const messageId = `${TAG}-msg-5`;
		const readFlag = async () =>
			(
				await db
					.select({ compactPending: narratorMessages.compactPending })
					.from(narratorMessages)
					.where(eq(narratorMessages.id, messageId))
			)[0]?.compactPending;

		expect(await readFlag()).toBe(1);
		// A virtual generated column is recomputed from contentJson, so finalizing the
		// marker must clear the flag without any explicit bookkeeping.
		await db
			.update(narratorMessages)
			.set({ contentJson: [COMPACT_BLOCKS.compacted] })
			.where(eq(narratorMessages.id, messageId));
		expect(await readFlag()).toBe(0);

		// Restore for the fork tests below.
		await db
			.update(narratorMessages)
			.set({ contentJson: [COMPACT_BLOCKS.compacting] })
			.where(eq(narratorMessages.id, messageId));
		expect(await readFlag()).toBe(1);
	});
});

describe("forkNarrator omits in-flight compact markers", () => {
	test("copies every stable ref and no pending one", async () => {
		const forked = await narratorService.forkNarrator(parentId, null, {
			inheritMode: "full",
			forkMessageId: `${TAG}-msg-8`,
			standalone: true,
			title: "fork-pending-test",
		});

		const childRefs = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, forked.id))
			.orderBy(narratorMessageRefs.seq);

		const copied = childRefs.map((row) => row.messageId);
		// The pending markers must be absent...
		expect(copied).not.toContain(`${TAG}-msg-5`);
		expect(copied).not.toContain(`${TAG}-msg-6`);
		expect(copied).not.toContain(`${TAG}-msg-7`);
		// ...while stable markers and ordinary turns after the last stable compact
		// boundary (seq 4, a failed marker with isCompact=0) are all preserved.
		expect(copied).toContain(`${TAG}-msg-8`);
		expect(copied).toContain(`${TAG}-msg-4`);

		// Inherited refs keep the PARENT's seq rather than being renumbered from 0, so a
		// later lazy backfill can splice older rows in without shifting anything (see
		// narrator-refs-backfill). The excluded pending markers therefore leave gaps —
		// which is fine, since every consumer treats seq as a cursor, not an index.
		const parentSeqByMessage = new Map<string, number>(
			(
				await db
					.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
					.from(narratorMessageRefs)
					.where(eq(narratorMessageRefs.narratorId, parentId))
			).map((row) => [row.messageId, row.seq] as const),
		);
		for (const row of childRefs) {
			expect(parentSeqByMessage.has(row.messageId)).toBeTrue();
			expect(row.seq).toBe(parentSeqByMessage.get(row.messageId) as number);
		}
		// Still strictly increasing, so ordering is unaffected by the gaps.
		const seqs = childRefs.map((row) => row.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
		expect(new Set(seqs).size).toBe(seqs.length);

		await narratorService.remove(forked.id);
	});

	test("forkFromMessages also refuses to share a pending marker", async () => {
		const forked = await narratorService.forkFromMessages(
			parentId,
			[`${TAG}-msg-3`, `${TAG}-msg-5`, `${TAG}-msg-8`],
			{ title: "fork-from-messages-pending-test" },
		);

		const copied = (
			await db
				.select({ messageId: narratorMessageRefs.messageId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, forked.id))
		).map((row) => row.messageId);

		expect(copied.sort()).toEqual([`${TAG}-msg-3`, `${TAG}-msg-8`]);

		await narratorService.remove(forked.id);
	});

	test("the fork boundary skips a pending compact marker for a stable one", async () => {
		// Two history-compact boundaries: a stable one at seq 2 and a *pending* one at
		// seq 5. The full inherit path must fall back to seq 2, because starting the
		// child at seq 5 would hand it a marker that can never finish.
		const setBoundary = async (seq: number, isCompact: number) =>
			db
				.update(narratorMessageRefs)
				.set({ isCompact })
				.where(and(eq(narratorMessageRefs.narratorId, parentId), eq(narratorMessageRefs.seq, seq)));
		await setBoundary(2, 1);
		await setBoundary(5, 1);

		const forked = await narratorService.forkNarrator(parentId, null, {
			inheritMode: "full",
			standalone: true,
			title: "fork-boundary-test",
		});

		const copied = (
			await db
				.select({ messageId: narratorMessageRefs.messageId })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, forked.id))
		).map((row) => row.messageId);

		// The pending marker is never shared.
		expect(copied).not.toContain(`${TAG}-msg-5`);
		// The boundary resolved to the stable marker at seq 2, so history after it is
		// inherited and history before it is not.
		expect(copied).toContain(`${TAG}-msg-3`);
		expect(copied).toContain(`${TAG}-msg-8`);
		expect(copied).not.toContain(`${TAG}-msg-0`);
		expect(copied).not.toContain(`${TAG}-msg-1`);

		await narratorService.remove(forked.id);
		await setBoundary(2, 0);
		await setBoundary(5, 0);
	});
});
