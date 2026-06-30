/**
 * Integration test for the user_identities table (SSO identity links) against a
 * real (in-memory) schema built from the actual Drizzle migrations.
 *
 * Validates the schema-level invariants the sso-service relies on:
 *  - a (provider, subject) pair is globally unique (one external identity → one
 *    local user);
 *  - the same subject can exist across different providers;
 *  - a user may link multiple providers;
 *  - deleting a user cascades to their identities.
 *
 * Uses tests/setup.ts getTestDb(), so it never touches the real database or the
 * instance lock.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userIdentities, users } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();

async function makeUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `sso-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

function identityRow(userId: string, provider: string, subject: string) {
	return {
		id: generateId(),
		userId,
		provider,
		subject,
		email: `${subject}@example.com`,
		displayName: "Test User",
		createdAt: new Date().toISOString(),
	};
}

beforeEach(() => cleanDb(sqlite));

describe("user_identities integration", () => {
	test("a user can link multiple providers", async () => {
		const userId = await makeUser();
		await db.insert(userIdentities).values(identityRow(userId, "corp-okta", "sub-1"));
		await db.insert(userIdentities).values(identityRow(userId, "google", "sub-2"));
		const rows = await db.query.userIdentities.findMany({
			where: eq(userIdentities.userId, userId),
		});
		expect(rows.length).toBe(2);
	});

	test("(provider, subject) is globally unique", async () => {
		const a = await makeUser();
		const b = await makeUser();
		await db.insert(userIdentities).values(identityRow(a, "corp-okta", "shared-sub"));
		let threw = false;
		try {
			await db.insert(userIdentities).values(identityRow(b, "corp-okta", "shared-sub"));
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("the same subject is allowed across different providers", async () => {
		const userId = await makeUser();
		await db.insert(userIdentities).values(identityRow(userId, "provider-a", "same-sub"));
		// Different provider, same subject string — must be allowed.
		await db.insert(userIdentities).values(identityRow(userId, "provider-b", "same-sub"));
		const rows = await db.query.userIdentities.findMany({
			where: eq(userIdentities.userId, userId),
		});
		expect(rows.length).toBe(2);
	});

	test("lookup by (provider, subject) resolves the owning user", async () => {
		const userId = await makeUser();
		await db.insert(userIdentities).values(identityRow(userId, "corp-okta", "lookup-sub"));
		const found = await db.query.userIdentities.findFirst({
			where: and(
				eq(userIdentities.provider, "corp-okta"),
				eq(userIdentities.subject, "lookup-sub"),
			),
		});
		expect(found?.userId).toBe(userId);
	});

	test("deleting a user cascades to their identities", async () => {
		const userId = await makeUser();
		await db.insert(userIdentities).values(identityRow(userId, "corp-okta", "cascade-sub"));
		await db.delete(users).where(eq(users.id, userId));
		const rows = await db.query.userIdentities.findMany({
			where: eq(userIdentities.userId, userId),
		});
		expect(rows.length).toBe(0);
	});
});
