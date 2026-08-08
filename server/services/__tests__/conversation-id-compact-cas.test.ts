/**
 * conversation-id-compact-cas.test.ts — teardown must not resurrect a conversation
 * id that a compact deliberately cleared.
 *
 * `apiConversationId = null` is how a compact says "the history was replaced; the
 * next request must open a FRESH upstream session". Background compacts are
 * fire-and-forget and routinely settle around a turn boundary, so the dangerous
 * case is a turn that ended completely normally — no overflow, no error:
 *
 *   1. background compact finalizes → column nulled, history replaced
 *   2. the turn tears down → writes the id it held in memory
 *   3. next activation reads a non-null id → skips the upstream session reset and
 *      sends compacted history down a session that still holds the pre-compact
 *      turns, which the provider then answers twice.
 *
 * Step 2 is the only step under our control, so the write is a compare-and-set
 * against the id the session started from. Losing that CAS is correct behaviour.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
// Snapshot the real module first: Bun's mock.module is global and LEAKS across
// files (mock.restore() does not undo it), so without the afterAll below this
// test's in-memory db would silently become every later file's db.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported first: narrator-persistence participates in a
// circular import with it, and pulling persistence in on its own trips the
// service module's binding initialization.
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");

const NARRATOR_ID = "n-convo-cas";

async function seedNarrator(apiConversationId: string | null): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: NARRATOR_ID,
		variant: "primary",
		status: "idle",
		apiConversationId,
		createdAt: now,
		updatedAt: now,
	});
}

async function readConversationId(): Promise<string | null> {
	const row = await db.query.narrators.findFirst({
		where: eq(narrators.id, NARRATOR_ID),
		columns: { apiConversationId: true },
	});
	return row?.apiConversationId ?? null;
}

beforeEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("updateConversationId compare-and-set", () => {
	test("a compact's cleared id survives teardown of the turn that started it", async () => {
		await seedNarrator("session-before-compact");

		// The compact finalized mid-turn and nulled the column.
		await db
			.update(narrators)
			.set({ apiConversationId: null })
			.where(eq(narrators.id, NARRATOR_ID));

		// Teardown tries to write back the id the session started with.
		const applied = await narratorPersistence.updateConversationId(
			NARRATOR_ID,
			"session-before-compact",
			"session-before-compact",
		);

		expect(applied).toBe(false);
		expect(await readConversationId()).toBeNull();
	});

	test("the normal case still persists so the next activation reuses the session", async () => {
		await seedNarrator("session-a");

		const applied = await narratorPersistence.updateConversationId(
			NARRATOR_ID,
			"session-b",
			"session-a",
		);

		expect(applied).toBe(true);
		expect(await readConversationId()).toBe("session-b");
	});

	test("a session that started with no stored id may claim the empty column", async () => {
		await seedNarrator(null);

		const applied = await narratorPersistence.updateConversationId(
			NARRATOR_ID,
			"fresh-session",
			null,
		);

		expect(applied).toBe(true);
		expect(await readConversationId()).toBe("fresh-session");
	});

	test("a session that started with no stored id loses to a compact that nulled it again", async () => {
		// Started fresh (null), generated an id, then a compact cleared the column
		// after some other write had already put an id there.
		await seedNarrator("someone-elses-session");

		const applied = await narratorPersistence.updateConversationId(
			NARRATOR_ID,
			"fresh-session",
			null,
		);

		expect(applied).toBe(false);
		expect(await readConversationId()).toBe("someone-elses-session");
	});

	test("omitting the baseline keeps the unconditional write for deliberate callers", async () => {
		await seedNarrator("session-a");

		const applied = await narratorPersistence.updateConversationId(NARRATOR_ID, "forced");

		expect(applied).toBe(true);
		expect(await readConversationId()).toBe("forced");
	});
});
