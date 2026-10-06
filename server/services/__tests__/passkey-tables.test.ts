/**
 * Integration test for the passkey tables (user_passkeys + webauthn_challenges)
 * against a real (in-memory) schema built from the actual Drizzle migrations.
 *
 * Validates the schema-level invariants the passkey-service relies on:
 *  - credential IDs are globally unique (unique index);
 *  - a user may register multiple passkeys;
 *  - deleting a user cascades to their passkeys and challenges;
 *  - challenges are single-use rows keyed by their unique challenge string.
 *
 * Uses tests/setup.ts getTestDb(), so it never touches the real database or
 * the instance lock.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userPasskeys, users, webauthnChallenges } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();

async function makeUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `pk-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

function passkeyRow(userId: string, credentialId: string) {
	return {
		id: generateId(),
		userId,
		credentialId,
		publicKey: "pub",
		counter: 0,
		transports: ["internal"] as string[],
		deviceType: "multiDevice",
		backedUp: true,
		name: "Test Key",
		createdAt: new Date().toISOString(),
	};
}

beforeEach(() => cleanDb(sqlite));

describe("passkey tables integration", () => {
	test("a user can register multiple passkeys", async () => {
		const userId = await makeUser();
		await db.insert(userPasskeys).values(passkeyRow(userId, "cred-a"));
		await db.insert(userPasskeys).values(passkeyRow(userId, "cred-b"));
		const rows = await db.query.userPasskeys.findMany({
			where: eq(userPasskeys.userId, userId),
		});
		expect(rows.length).toBe(2);
	});

	test("credential_id is globally unique", async () => {
		const a = await makeUser();
		const b = await makeUser();
		await db.insert(userPasskeys).values(passkeyRow(a, "dup-cred"));
		let threw = false;
		try {
			await db.insert(userPasskeys).values(passkeyRow(b, "dup-cred"));
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("transports JSON round-trips as an array", async () => {
		const userId = await makeUser();
		await db.insert(userPasskeys).values(passkeyRow(userId, "cred-json"));
		const row = await db.query.userPasskeys.findFirst({
			where: eq(userPasskeys.credentialId, "cred-json"),
		});
		expect(row?.transports).toEqual(["internal"]);
		expect(row?.backedUp).toBe(true);
	});

	test("deleting a user cascades to passkeys + challenges", async () => {
		const userId = await makeUser();
		await db.insert(userPasskeys).values(passkeyRow(userId, "cred-cascade"));
		await db.insert(webauthnChallenges).values({
			id: generateId(),
			challenge: "chal-1",
			type: "registration",
			userId,
			expiresAt: Date.now() + 60_000,
			createdAt: new Date().toISOString(),
		});

		await db.delete(users).where(eq(users.id, userId));

		const pks = await db.query.userPasskeys.findMany({ where: eq(userPasskeys.userId, userId) });
		const chals = await db.query.webauthnChallenges.findMany({
			where: eq(webauthnChallenges.userId, userId),
		});
		expect(pks.length).toBe(0);
		expect(chals.length).toBe(0);
	});

	test("challenge string is unique", async () => {
		await db.insert(webauthnChallenges).values({
			id: generateId(),
			challenge: "dup-chal",
			type: "authentication",
			userId: null,
			expiresAt: Date.now() + 60_000,
			createdAt: new Date().toISOString(),
		});
		let threw = false;
		try {
			await db.insert(webauthnChallenges).values({
				id: generateId(),
				challenge: "dup-chal",
				type: "authentication",
				userId: null,
				expiresAt: Date.now() + 60_000,
				createdAt: new Date().toISOString(),
			});
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});
});
