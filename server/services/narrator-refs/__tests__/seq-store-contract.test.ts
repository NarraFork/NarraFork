/**
 * seq-store contract tests (SQLite backend).
 *
 * Pins the behavior every `narrator_message_refs.seq` writer must satisfy through the
 * single allocation authority in `server/services/narrator-refs/seq-store.ts`:
 *
 *   - EMPTY BASE: an empty narrator's first ref claims seq 0 on EVERY path — the old
 *     publication / parent-injection sites used to start at 1;
 *   - NO DUPLICATE UNDER CONCURRENCY: many in-flight appends land on distinct,
 *     contiguous seqs (bun:sqlite serializes the synchronous claim transactions, which
 *     is exactly the guarantee the future counter claim preserves on a
 *     multi-connection backend);
 *   - SHIFT THEN APPEND: a shift+insert consumes one top-of-history slot, so the next
 *     append continues at max+1 with the shifted order intact;
 *   - ROLLBACK: a failed insert leaves neither message nor ref behind, and a rolled-back
 *     claim is re-issued (true for MAX+1 AND for the counter claim — the counter bump
 *     rolls back with the same transaction);
 *   - FORK FLOOR: after copying a parent's (sparse) refs, allocation continues at
 *     max(copied)+1 and later backfills of OLDER refs never lower that floor.
 *
 * The PG-side statement-shape verification (real PostgreSQL 17, counter claim vs
 * serialized MAX+1 equivalence) lives in
 * tests/server/services/narrator-refs/pg-ref-seq-claim.test.ts.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ db, sqlite }));

// narrator-service must be imported before narrator-persistence: the two form a
// pre-existing import cycle (see tests/server/services/narrator-message-count.test.ts).
const { narratorService } = await import("../../narrator-service");
const { ensureAllRefsMaterialized } = await import("../../narrator-refs-backfill");
const { appendMessageRef, insertMessageRef, narratorPersistence } = await import(
	"../../narrator-persistence"
);
const {
	NARRATOR_REF_SEQ_BASE,
	NARRATOR_REF_SEQ_EMPTY_TOP,
	claimNextRefSeq,
	claimShiftInsertSlot,
	initializeRefSeqFloor,
	readTopRefSeq,
} = await import("../seq-store");

const NOW = "2026-09-01T00:00:00.000Z";

function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, NOW, NOW);
}

/** Insert a message + ref directly, bypassing allocation (fork/backfill simulation). */
function seedRef(messageId: string, narratorId: string, seq: number) {
	db.insert(narratorMessages)
		.values({
			id: messageId,
			narratorId,
			role: "user",
			contentJson: [{ type: "text", text: messageId }],
			contentText: messageId,
			createdAt: NOW,
		})
		.run();
	db.transaction((tx) => {
		tx.insert(narratorMessageRefs)
			.values({ id: `ref-${messageId}`, narratorId, messageId, seq })
			.run();
		initializeRefSeqFloor(tx, narratorId);
	});
}

function refsOf(narratorId: string): { messageId: string; seq: number }[] {
	return db
		.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
		.from(narratorMessageRefs)
		.where(eq(narratorMessageRefs.narratorId, narratorId))
		.all()
		.sort((a, b) => a.seq - b.seq);
}

function messageVersionOf(narratorId: string): number {
	return (
		db
			.select({ v: narrators.messageVersion })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.get()?.v ?? -1
	);
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("empty narrator base", () => {
	test("base constants: first ref is 0, the empty watermark is -1", () => {
		expect(NARRATOR_REF_SEQ_BASE).toBe(0);
		expect(NARRATOR_REF_SEQ_EMPTY_TOP).toBe(-1);
	});

	test("claim on an empty narrator allocates 0 and the top read is null", () => {
		seedNarrator();
		db.transaction((tx) => {
			expect(readTopRefSeq(tx, "n1")).toBeNull();
			expect(claimNextRefSeq(tx, "n1")).toBe(0);
		});
	});

	test("every persistence append path starts at 0", async () => {
		seedNarrator();
		const user = await narratorPersistence.persistUserMessage("n1", "hello");
		expect(user.seq).toBe(0);
		const system = await narratorPersistence.persistSystemMessage("n1", "note");
		expect(system.seq).toBe(1);
		const display = await narratorPersistence.persistDisplayMessage("n1", "info");
		expect(display.seq).toBe(2);
	});

	test("clearContext on an empty narrator claims seq 0", async () => {
		seedNarrator();
		const { seq } = await narratorPersistence.clearContext("n1");
		expect(seq).toBe(0);
	});
});

describe("concurrent appends", () => {
	test("20 in-flight appends claim 20 distinct contiguous seqs", async () => {
		seedNarrator();
		const results = await Promise.all(
			Array.from({ length: 20 }, (_, i) => narratorPersistence.persistUserMessage("n1", `m${i}`)),
		);
		const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
		expect(new Set(seqs).size).toBe(20);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
	});

	test("mixed concurrent writers across subsystems stay unique and contiguous", async () => {
		seedNarrator();
		const results = await Promise.all([
			...Array.from({ length: 5 }, (_, i) => narratorPersistence.persistUserMessage("n1", `u${i}`)),
			...Array.from({ length: 5 }, (_, i) =>
				narratorPersistence.persistSystemMessage("n1", `s${i}`),
			),
			...Array.from({ length: 5 }, (_, i) =>
				narratorPersistence.persistDisplayMessage("n1", `d${i}`),
			),
			...Array.from({ length: 5 }, (_, i) =>
				(async () => {
					const id = `raw-${i}`;
					await db.insert(narratorMessages).values({
						id,
						narratorId: "n1",
						role: "system",
						contentJson: [{ type: "text", text: id }],
						contentText: id,
						createdAt: NOW,
					});
					return { seq: await appendMessageRef("n1", id) };
				})(),
			),
		]);
		const seqs = results.map((r) => r.seq).sort((a, b) => a - b);
		expect(new Set(seqs).size).toBe(20);
		expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i));
	});

	test("claims in two transactions never return the same seq", () => {
		seedNarrator();
		// The primitive-level shape of the race: two claims, two transactions. On SQLite
		// the synchronous write transaction IS the serialization point; the PG suite
		// proves the counter-claim statement shape provides the same guarantee across
		// real concurrent connections.
		const first = db.transaction((tx) => {
			const seq = claimNextRefSeq(tx, "n1");
			db.insert(narratorMessages)
				.values({
					id: "tx-a",
					narratorId: "n1",
					role: "user",
					contentJson: [{ type: "text", text: "a" }],
					createdAt: NOW,
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: "ref-tx-a", narratorId: "n1", messageId: "tx-a", seq })
				.run();
			return seq;
		});
		const second = db.transaction((tx) => {
			const seq = claimNextRefSeq(tx, "n1");
			db.insert(narratorMessages)
				.values({
					id: "tx-b",
					narratorId: "n1",
					role: "user",
					contentJson: [{ type: "text", text: "b" }],
					createdAt: NOW,
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: "ref-tx-b", narratorId: "n1", messageId: "tx-b", seq })
				.run();
			return seq;
		});
		expect(first).toBe(0);
		expect(second).toBe(1);
	});
});

describe("shift then append", () => {
	test("clearContextBefore shifts the tail up and the next append lands at max+1", async () => {
		seedNarrator();
		await narratorPersistence.persistUserMessage("n1", "a");
		const b = await narratorPersistence.persistUserMessage("n1", "b");
		await narratorPersistence.persistUserMessage("n1", "c");

		const marker = await narratorPersistence.clearContextBefore("n1", b.id);
		expect(marker.seq).toBe(1);

		const after = await narratorPersistence.persistUserMessage("n1", "after");
		expect(after.seq).toBe(4);

		expect(refsOf("n1")).toEqual([
			{ messageId: expect.any(String), seq: 0 },
			{ messageId: marker.id, seq: 1 },
			{ messageId: b.id, seq: 2 },
			{ messageId: expect.any(String), seq: 3 },
			{ messageId: after.id, seq: 4 },
		]);
	});

	test("the shift primitive frees exactly the requested slot and claims resume at max+1", () => {
		seedNarrator();
		seedRef("m0", "n1", 0);
		seedRef("m1", "n1", 1);
		seedRef("m2", "n1", 2);

		db.transaction((tx) => {
			claimShiftInsertSlot(tx, "n1", 1);
			expect(readTopRefSeq(tx, "n1")).toBe(3); // the shift consumed one top slot
			db.insert(narratorMessages)
				.values({
					id: "shifted-in",
					narratorId: "n1",
					role: "system",
					contentJson: [{ type: "text", text: "x" }],
					createdAt: NOW,
				})
				.run();
			tx.insert(narratorMessageRefs)
				.values({ id: "ref-shifted-in", narratorId: "n1", messageId: "shifted-in", seq: 1 })
				.run();
		});

		expect(refsOf("n1")).toEqual([
			{ messageId: "m0", seq: 0 },
			{ messageId: "shifted-in", seq: 1 },
			{ messageId: "m1", seq: 2 },
			{ messageId: "m2", seq: 3 },
		]);
		db.transaction((tx) => {
			expect(claimNextRefSeq(tx, "n1")).toBe(4);
		});
	});

	test("segment compact marker reads, shifts and inserts in one transaction", async () => {
		seedNarrator();
		const a = await narratorPersistence.persistUserMessage("n1", "a");
		const b = await narratorPersistence.persistUserMessage("n1", "b");
		const c = await narratorPersistence.persistUserMessage("n1", "c");

		const { message, hiddenMessageIds } = await narratorPersistence.persistSegmentCompactMarker(
			"n1",
			[b.id, c.id],
		);
		expect(message.seq).toBe(1);
		expect(hiddenMessageIds.sort()).toEqual([b.id, c.id].sort());

		const after = await narratorPersistence.persistUserMessage("n1", "after");
		expect(after.seq).toBe(4);
		expect(refsOf("n1").map((r) => r.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(refsOf("n1")[0].messageId).toBe(a.id);
	});
});

describe("rollback", () => {
	test("a failing ref insert rolls back the message too — no orphan either way", () => {
		seedNarrator();
		const versionBefore = messageVersionOf("n1");
		expect(() =>
			db.transaction((tx) => {
				tx.insert(narratorMessages)
					.values({
						id: "doomed",
						narratorId: "n1",
						role: "system",
						contentJson: [{ type: "error", message: "x" }],
						createdAt: NOW,
					})
					.run();
				const seq = claimNextRefSeq(tx, "n1");
				// FK violation: no such message. The whole transaction must roll back.
				tx.insert(narratorMessageRefs)
					.values({ id: "ref-doomed", narratorId: "n1", messageId: "not-a-message", seq })
					.run();
			}),
		).toThrow();
		expect(
			db.select().from(narratorMessages).where(eq(narratorMessages.id, "doomed")).all(),
		).toEqual([]);
		expect(refsOf("n1")).toEqual([]);
		expect(messageVersionOf("n1")).toBe(versionBefore);
	});

	test("a rolled-back claim is re-issued to the next writer", () => {
		seedNarrator();
		expect(() =>
			db.transaction((tx) => {
				const seq = claimNextRefSeq(tx, "n1");
				db.insert(narratorMessages)
					.values({
						id: "rolled-back",
						narratorId: "n1",
						role: "user",
						contentJson: [{ type: "text", text: "x" }],
						createdAt: NOW,
					})
					.run();
				tx.insert(narratorMessageRefs)
					.values({ id: "ref-rolled-back", narratorId: "n1", messageId: "rolled-back", seq })
					.run();
				throw new Error("simulated post-insert failure");
			}),
		).toThrow("simulated post-insert failure");
		expect(refsOf("n1")).toEqual([]);
		// True under MAX+1 AND under the counter claim (the bump rolls back with the
		// same transaction): the next claim reuses the rolled-back seq.
		db.transaction((tx) => {
			expect(claimNextRefSeq(tx, "n1")).toBe(0);
		});
	});

	test("segment compact with no matching messages fails inside the transaction, leaving nothing", async () => {
		seedNarrator();
		await narratorPersistence.persistUserMessage("n1", "real");
		const versionBefore = messageVersionOf("n1");
		await expect(
			narratorPersistence.persistSegmentCompactMarker("n1", ["no-such-message"]),
		).rejects.toThrow("No matching messages found");
		// The validation now happens INSIDE the write transaction, so a failure can
		// leave no half-shifted refs, no marker message and no version bump.
		expect(refsOf("n1")).toHaveLength(1);
		expect(
			db
				.select()
				.from(narratorMessages)
				.where(and(eq(narratorMessages.narratorId, "n1"), eq(narratorMessages.role, "user")))
				.all(),
		).toHaveLength(1);
		expect(messageVersionOf("n1")).toBe(versionBefore);
	});
});

describe("monotone production counter", () => {
	test("deleting a sparse tail and copying older refs never reuses a committed seq", async () => {
		seedNarrator();
		seedRef("sparse", "n1", 41);
		const first = await narratorPersistence.persistUserMessage("n1", "after sparse");
		expect(first.seq).toBe(42);
		db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, first.id)).run();
		db.transaction((tx) => expect(initializeRefSeqFloor(tx, "n1")).toBe(43));
		expect((await narratorPersistence.persistUserMessage("n1", "after delete")).seq).toBe(43);
	});

	test("explicit ref insertion advances the floor before a production append", async () => {
		seedNarrator();
		db.insert(narratorMessages)
			.values({ id: "explicit", narratorId: "n1", role: "user", contentJson: [], createdAt: NOW })
			.run();
		await insertMessageRef("n1", "explicit", 50);
		expect((await narratorPersistence.persistUserMessage("n1", "next")).seq).toBe(51);
	});

	test("both assistant insertion entrypoints roll back message, counter and version on ref failure", async () => {
		seedNarrator();
		sqlite.exec(
			"CREATE TRIGGER reject_assistant_ref BEFORE INSERT ON narrator_message_refs BEGIN SELECT RAISE(ABORT, 'ref rejected'); END",
		);
		try {
			await expect(
				narratorPersistence.persistAssistantMessage("n1", {
					uuid: "failed-full",
					session_id: "s",
					message: { content: [{ type: "text", text: "failed" }] },
				}),
			).rejects.toThrow();
			await expect(
				narratorPersistence.createPartialAssistantMessage("n1", {
					uuid: "failed-partial",
					session_id: "s",
				}),
			).rejects.toThrow();
		} finally {
			sqlite.exec("DROP TRIGGER reject_assistant_ref");
		}
		expect(db.select({ id: narratorMessages.id }).from(narratorMessages).all()).toHaveLength(0);
		expect(refsOf("n1")).toHaveLength(0);
		expect(messageVersionOf("n1")).toBe(0);
		expect((await narratorPersistence.persistUserMessage("n1", "survives")).seq).toBe(0);
	});
});

describe("fork floor", () => {
	test("selected-message production fork initializes its copied-ref floor", async () => {
		seedNarrator("parent");
		seedRef("selected-a", "parent", 10);
		seedRef("selected-b", "parent", 50);
		const child = await narratorService.forkFromMessages("parent", ["selected-a", "selected-b"]);
		expect(child.nextSeq).toBe(3); // Preserve the selected-fork API's existing 1,2 numbering.
		expect(
			(await narratorPersistence.persistUserMessage(child.id, "after selected copy")).seq,
		).toBe(3);
	});

	test("real lazy fork and inherited backfill never lower a deleted-tail watermark", async () => {
		seedNarrator("parent");
		seedRef("older", "parent", 1);
		seedRef("compact", "parent", 10);
		seedRef("tail", "parent", 11);
		db.update(narratorMessageRefs)
			.set({ isCompact: 1 })
			.where(eq(narratorMessageRefs.messageId, "compact"))
			.run();
		db.update(narratorMessages)
			.set({
				role: "system",
				contentJson: [{ type: "compact", status: "compacted", summary: "summary" }],
			})
			.where(eq(narratorMessages.id, "compact"))
			.run();
		db.update(narrators).set({ contextSummary: "summary" }).where(eq(narrators.id, "parent")).run();
		const child = await narratorService.forkNarrator("parent", null, { inheritMode: "full" });
		const own = await narratorPersistence.persistUserMessage(child.id, "before backfill");
		expect(own.seq).toBe(12);
		db.delete(narratorMessageRefs)
			.where(
				and(
					eq(narratorMessageRefs.narratorId, child.id),
					eq(narratorMessageRefs.messageId, own.id),
				),
			)
			.run();
		await ensureAllRefsMaterialized(child.id);
		expect(refsOf(child.id).map((row) => row.messageId)).toEqual(["older", "compact", "tail"]);
		expect((await narratorPersistence.persistUserMessage(child.id, "after backfill")).seq).toBe(13);
	});

	test("floor after copy, and older backfill never lowers it", () => {
		seedNarrator("parent");
		seedNarrator("child");
		seedRef("p5", "parent", 5);
		seedRef("p6", "parent", 6);
		seedRef("p7", "parent", 7);

		// Copy the inherited window exactly as forkNarrator does (seq preserved).
		db.transaction((tx) => {
			const rows = tx
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, "parent"))
				.all();
			for (const row of rows) {
				tx.insert(narratorMessageRefs)
					.values({
						id: `child-${row.messageId}`,
						narratorId: "child",
						messageId: row.messageId,
						seq: row.seq,
					})
					.run();
			}
			expect(initializeRefSeqFloor(tx, "child")).toBe(8);
		});

		db.transaction((tx) => {
			expect(initializeRefSeqFloor(tx, "child")).toBe(8);
		});

		// The child's own append lands at 8 …
		db.insert(narratorMessages)
			.values({
				id: "child-own",
				narratorId: "child",
				role: "user",
				contentJson: [{ type: "text", text: "mine" }],
				createdAt: NOW,
			})
			.run();
		db.transaction((tx) => {
			const seq = claimNextRefSeq(tx, "child");
			expect(seq).toBe(8);
			tx.insert(narratorMessageRefs)
				.values({ id: "ref-child-own", narratorId: "child", messageId: "child-own", seq })
				.run();
		});

		// … and a later backfill of OLDER refs (seq 1..3) must not lower the floor.
		seedRef("p1", "parent", 1);
		seedRef("p2", "parent", 2);
		db.transaction((tx) => {
			const rows = tx
				.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
				.from(narratorMessageRefs)
				.where(eq(narratorMessageRefs.narratorId, "parent"))
				.all();
			for (const row of rows) {
				if (row.seq >= 5) continue;
				tx.insert(narratorMessageRefs)
					.values({
						id: `child-${row.messageId}`,
						narratorId: "child",
						messageId: row.messageId,
						seq: row.seq,
					})
					.run();
			}
			expect(initializeRefSeqFloor(tx, "child")).toBe(9);
		});
		db.transaction((tx) => {
			expect(claimNextRefSeq(tx, "child")).toBe(9);
		});
	});
});
