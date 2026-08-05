/**
 * DB-level guards for the recovery-card "already offered" watermark.
 *
 * Two invariants the pure-function tests cannot cover:
 *
 * 1. **`updatedAt` is never advanced.** The whole mechanism falls back to `updatedAt` as
 *    the failure time, so pushing it forward to "the moment the card was offered" makes
 *    the watermark comparison stop suppressing anything and the same dead subagents get
 *    re-proposed on every later narrator error. Every other narrators update in this
 *    codebase writes `updatedAt`, so the omission looks like an oversight; this test is
 *    what stops the next person from "fixing" it.
 *
 * 2. **The read-modify-write is serialized through `narratorTraitsLock`.** `traits` is a
 *    whole-column JSON array, so an unlocked watermark write racing a concurrent trait
 *    write (a user editing this subagent's disabled-tools) silently drops one of them.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";
import { narratorTraitsLock } from "../../lib/async-mutex";
import { parseTraits } from "../../lib/narrator-utils";

const { db, sqlite } = getTestDb();
// Snapshot the real db module before mocking: Bun's mock.module is process-wide and
// mock.restore() does not undo it, so this FTS-less test db would otherwise leak into
// later real-db suites.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { buildRecoveryOfferedTrait, markRecoveryOffered, parseRecoveryOfferedAtMs } = await import(
	"../narrator-subagent-recovery"
);

const FAILED_AT_MS = Date.parse("2026-04-01T02:00:00.000Z");
const FAILED_AT = new Date(FAILED_AT_MS).toISOString();

const PARENT_ID = "parent-1";

async function seedParent(): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: PARENT_ID, variant: "primary", createdAt: now, updatedAt: now });
}

async function seedFailedSubagent(id: string, traits: string[] = []): Promise<void> {
	await seedParent();
	await db.insert(narrators).values({
		id,
		variant: "subagent:general",
		parentNarratorId: PARENT_ID,
		status: "idle",
		substatus: JSON.stringify(["error"]),
		traits,
		createdAt: new Date(FAILED_AT_MS - 60_000).toISOString(),
		updatedAt: FAILED_AT,
	});
}

async function readRow(id: string) {
	return db.query.narrators.findFirst({
		where: eq(narrators.id, id),
		columns: { traits: true, updatedAt: true },
	});
}

beforeEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
	cleanDb(sqlite);
});

describe("markRecoveryOffered", () => {
	test("stamps the watermark without advancing updatedAt", async () => {
		await seedFailedSubagent("sub-1");

		await markRecoveryOffered([{ id: "sub-1", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-1");
		expect(parseRecoveryOfferedAtMs(row?.traits)).toBe(FAILED_AT_MS);
		// The load-bearing assertion: the recorded failure time must still be the failure,
		// not the offer. If this drifts, the watermark suppresses nothing.
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("keeps unrelated traits and replaces an older watermark", async () => {
		await seedFailedSubagent("sub-2", [
			"background",
			"custom-disabled-tools:abc",
			buildRecoveryOfferedTrait(FAILED_AT_MS - 60_000),
		]);

		await markRecoveryOffered([{ id: "sub-2", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-2");
		const traits = parseTraits(row?.traits);
		expect(traits).toContain("background");
		expect(traits).toContain("custom-disabled-tools:abc");
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("skips entries with no usable failure time and unknown rows", async () => {
		await seedFailedSubagent("sub-3");

		await markRecoveryOffered([
			{ id: "sub-3", failedAtMs: null },
			{ id: "does-not-exist", failedAtMs: FAILED_AT_MS },
		]);

		const row = await readRow("sub-3");
		expect(parseRecoveryOfferedAtMs(row?.traits)).toBeNull();
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	test("writes nothing when the row is already watermarked at this failure", async () => {
		await seedFailedSubagent("sub-4", [buildRecoveryOfferedTrait(FAILED_AT_MS)]);

		await markRecoveryOffered([{ id: "sub-4", failedAtMs: FAILED_AT_MS }]);

		const row = await readRow("sub-4");
		expect(parseTraits(row?.traits)).toEqual([buildRecoveryOfferedTrait(FAILED_AT_MS)]);
		expect(row?.updatedAt).toBe(FAILED_AT);
	});

	// Control case: proves the scenario below is genuinely lock-sensitive rather than
	// passing by accident of timing. This models what the watermark write used to do —
	// read traits, then write them back with no lock — against the same interleaving, and
	// shows the concurrent trait write is lost wholesale.
	test("an UNLOCKED read-modify-write does lose the concurrent write (why the lock matters)", async () => {
		await seedFailedSubagent("sub-race", ["background"]);

		const unlockedWatermark = (async () => {
			const stale = await readRow("sub-race");
			// The lock-less path reads here and writes after the other side has committed.
			await new Promise((resolve) => setTimeout(resolve, 20));
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(stale?.traits), buildRecoveryOfferedTrait(FAILED_AT_MS)] })
				.where(eq(narrators.id, "sub-race"));
		})();

		const concurrentTraitWrite = (async () => {
			const current = await readRow("sub-race");
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(current?.traits), "custom-disabled-tools:xyz"] })
				.where(eq(narrators.id, "sub-race"));
		})();

		await Promise.all([unlockedWatermark, concurrentTraitWrite]);

		const traits = parseTraits((await readRow("sub-race"))?.traits);
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
		// The user's edit is gone — exactly the silent data loss the lock prevents.
		expect(traits).not.toContain("custom-disabled-tools:xyz");
	});

	// Without the lock this loses one of the two writes: both sides read the same traits
	// array and the later write overwrites the earlier one wholesale.
	test("does not clobber a concurrent trait write held under narratorTraitsLock", async () => {
		await seedFailedSubagent("sub-5", ["background"]);

		// Hold the lock the way routes/narrators' updateNarratorTraits does, and only
		// release it after markRecoveryOffered has started, so the watermark write must
		// queue behind this read-modify-write rather than racing it.
		let releaseHolder!: () => void;
		const holderCanFinish = new Promise<void>((resolve) => {
			releaseHolder = resolve;
		});
		const holder = narratorTraitsLock.acquire("sub-5", async () => {
			const current = await readRow("sub-5");
			await holderCanFinish;
			await db
				.update(narrators)
				.set({ traits: [...parseTraits(current?.traits), "custom-disabled-tools:xyz"] })
				.where(eq(narrators.id, "sub-5"));
		});

		const watermarking = markRecoveryOffered([{ id: "sub-5", failedAtMs: FAILED_AT_MS }]);
		// Give the watermark path a chance to reach the lock before the holder releases.
		await new Promise((resolve) => setTimeout(resolve, 10));
		releaseHolder();
		await Promise.all([holder, watermarking]);

		const traits = parseTraits((await readRow("sub-5"))?.traits);
		expect(traits).toContain("background");
		expect(traits).toContain("custom-disabled-tools:xyz");
		expect(parseRecoveryOfferedAtMs(traits)).toBe(FAILED_AT_MS);
	});
});
