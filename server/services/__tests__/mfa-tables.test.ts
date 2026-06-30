/**
 * Integration test for the MFA tables (user_totp + user_mfa_backup_codes)
 * against a real (in-memory) schema built from the actual Drizzle migrations.
 *
 * This validates the schema-level invariants the mfa-service relies on:
 *  - one TOTP row per user (unique index) with a pending→active lifecycle;
 *  - backup codes are per-user and single-use (usedAt stamping);
 *  - deleting a user cascades to both MFA tables.
 *
 * Uses tests/setup.ts getTestDb(), so it never touches the real database or
 * the instance lock.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { userMfaBackupCodes, users, userTotp } from "../../db/schema";
import { generateId } from "../../lib/id";

const { db, sqlite } = getTestDb();

async function makeUser(): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `mfa-${id.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

beforeEach(() => cleanDb(sqlite));

describe("mfa tables integration", () => {
	test("TOTP enrollment lifecycle: pending → active", async () => {
		const userId = await makeUser();
		const now = new Date().toISOString();

		await db
			.insert(userTotp)
			.values({ id: generateId(), userId, secret: "SECRET", status: "pending", createdAt: now });

		let row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
		expect(row?.status).toBe("pending");

		await db
			.update(userTotp)
			.set({ status: "active", activatedAt: now })
			.where(eq(userTotp.userId, userId));
		row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
		expect(row?.status).toBe("active");
		expect(row?.activatedAt).toBe(now);
	});

	test("unique index allows at most one TOTP row per user", async () => {
		const userId = await makeUser();
		const now = new Date().toISOString();
		await db
			.insert(userTotp)
			.values({ id: generateId(), userId, secret: "A", status: "pending", createdAt: now });

		let threw = false;
		try {
			await db
				.insert(userTotp)
				.values({ id: generateId(), userId, secret: "B", status: "pending", createdAt: now });
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	test("backup codes are single-use via usedAt stamping", async () => {
		const userId = await makeUser();
		const now = new Date().toISOString();
		const codeId = generateId();
		await db.insert(userMfaBackupCodes).values([
			{ id: codeId, userId, codeHash: "h1", createdAt: now },
			{ id: generateId(), userId, codeHash: "h2", createdAt: now },
		]);

		// Two unused codes initially.
		let unused = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
		});
		expect(unused.length).toBe(2);

		// Consume one.
		await db
			.update(userMfaBackupCodes)
			.set({ usedAt: now })
			.where(eq(userMfaBackupCodes.id, codeId));
		unused = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
		});
		expect(unused.length).toBe(1);
	});

	test("deleting a user cascades to TOTP + backup codes", async () => {
		const userId = await makeUser();
		const now = new Date().toISOString();
		await db
			.insert(userTotp)
			.values({ id: generateId(), userId, secret: "S", status: "active", createdAt: now });
		await db
			.insert(userMfaBackupCodes)
			.values({ id: generateId(), userId, codeHash: "h", createdAt: now });

		await db.delete(users).where(eq(users.id, userId));

		const totp = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
		const codes = await db.query.userMfaBackupCodes.findMany({
			where: eq(userMfaBackupCodes.userId, userId),
		});
		expect(totp).toBeUndefined();
		expect(codes.length).toBe(0);
	});
});
