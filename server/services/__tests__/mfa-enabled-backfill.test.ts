/**
 * Integration test for the one-time `users.mfa_enabled` backfill query used by
 * run-migrations.ts. It preserves the pre-upgrade behavior where holding ANY
 * second factor (active TOTP or a passkey) forced a second step at login.
 *
 * We exercise the exact UPDATE statement against a real (in-memory) schema so a
 * regression in the query (join/predicate) is caught. Uses tests/setup.ts
 * getTestDb(), so it never touches the real database.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userPasskeys, users, userTotp } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();

/** Mirror of backfillMfaEnabled()'s UPDATE in run-migrations.ts. */
const BACKFILL_SQL = `UPDATE users SET mfa_enabled = 1
	WHERE mfa_enabled = 0
	  AND (
	    EXISTS (SELECT 1 FROM user_totp t WHERE t.user_id = users.id AND t.status = 'active')
	    OR EXISTS (SELECT 1 FROM user_passkeys p WHERE p.user_id = users.id)
	  )`;

async function makeUser(mfaEnabled = false): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `bf-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		mfaEnabled,
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function addPasskey(userId: string): Promise<void> {
	await db.insert(userPasskeys).values({
		id: generateId(),
		userId,
		credentialId: `cred-${generateId()}`,
		publicKey: "pub",
		counter: 0,
		createdAt: new Date().toISOString(),
	});
}

async function addTotp(userId: string, status: "pending" | "active"): Promise<void> {
	await db.insert(userTotp).values({
		id: generateId(),
		userId,
		secret: "SECRET",
		status,
		createdAt: new Date().toISOString(),
	});
}

async function mfaEnabledOf(userId: string): Promise<boolean> {
	const row = await db.query.users.findFirst({
		where: eq(users.id, userId),
		columns: { mfaEnabled: true },
	});
	return !!row?.mfaEnabled;
}

beforeEach(() => cleanDb(sqlite));

describe("mfa_enabled backfill", () => {
	test("enables MFA for a user with a passkey", async () => {
		const userId = await makeUser();
		await addPasskey(userId);
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(userId)).toBe(true);
	});

	test("enables MFA for a user with an active TOTP factor", async () => {
		const userId = await makeUser();
		await addTotp(userId, "active");
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(userId)).toBe(true);
	});

	test("does NOT enable MFA for a pending (unverified) TOTP factor", async () => {
		const userId = await makeUser();
		await addTotp(userId, "pending");
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(userId)).toBe(false);
	});

	test("does NOT enable MFA for a user with no factors", async () => {
		const userId = await makeUser();
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(userId)).toBe(false);
	});

	test("only touches users that own the factor", async () => {
		const withFactor = await makeUser();
		const without = await makeUser();
		await addPasskey(withFactor);
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(withFactor)).toBe(true);
		expect(await mfaEnabledOf(without)).toBe(false);
	});

	test("leaves an already-enabled flag untouched (idempotent)", async () => {
		const userId = await makeUser(true);
		await addPasskey(userId);
		// The row already has mfa_enabled = 1, so the WHERE clause excludes it.
		sqlite.run(BACKFILL_SQL);
		expect(await mfaEnabledOf(userId)).toBe(true);
	});
});
