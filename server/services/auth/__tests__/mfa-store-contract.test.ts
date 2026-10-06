/**
 * The MFA-store contract, verified against real SQLite.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The factor lifecycle's guarantees, on the store that serves them by default:
 *
 *   - `savePendingTotp` is one indivisible decision: an ACTIVE enrollment is never
 *     overwritten ("alreadyActive", nothing written), while a missing or pending one
 *     is replaced by the new pending secret;
 *   - `activateTotp` flips only a PENDING enrollment (guarded — teardown in between
 *     cannot resurrect a row);
 *   - `replaceBackupCodes` is all-or-nothing: a failure mid-swap (a real UNIQUE
 *     violation inside the batch insert) leaves the OLD batch intact;
 *   - `markBackupCodeUsed` is a guarded write: a consumed code reports false from
 *     then on, and the unused neighbours are unaffected;
 *   - `clearFactors` removes the enrollment and the backup codes together;
 *   - the MFA flag and the passkey existence read round-trip.
 *
 * ISOLATION: the store runs on `tests/setup`'s in-memory database, mocked over
 * `server/db`. No real NarraFork database is touched.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../../tests/setup";
import { userMfaBackupCodes, userPasskeys, users, userTotp } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import type { BackupCodeDraft } from "../mfa-store";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({ db, sqlite }));

const { sqliteAuthMfaStore: store } = await import("../sqlite-mfa-store");
const { authMfaStore } = await import("../store");

afterAll(() => {
	mock.module("../../../db", () => realDbModule);
	mock.restore();
});

const NOW = "2026-08-12T00:00:00.000Z";

let userId: string;

beforeEach(async () => {
	cleanDb(sqlite);
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `mfa-${userId.slice(0, 6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW,
	});
});

function codeDraft(overrides: Partial<BackupCodeDraft> = {}): BackupCodeDraft {
	return { id: generateId(), codeHash: `hash-${generateId(6)}`, createdAt: NOW, ...overrides };
}

async function backupCodeRows(): Promise<Array<{ id: string; usedAt: string | null }>> {
	return await db.query.userMfaBackupCodes.findMany({
		where: eq(userMfaBackupCodes.userId, userId),
		columns: { id: true, usedAt: true },
	});
}

describe("AuthMfaStore — SQLite", () => {
	test("enrollment: pending is saved, replaced while pending, never over an active one", async () => {
		expect(
			await store.savePendingTotp({ id: generateId(), userId, secret: "S1", nowIso: NOW }),
		).toBe("saved");
		expect(await store.findTotp(userId, "pending")).toEqual({ status: "pending", secret: "S1" });

		// A second setup replaces the pending secret — the authenticator was never confirmed.
		expect(
			await store.savePendingTotp({ id: generateId(), userId, secret: "S2", nowIso: NOW }),
		).toBe("saved");
		expect((await store.findTotp(userId, "pending"))?.secret).toBe("S2");

		await store.activateTotp(userId, NOW);
		expect((await store.findTotp(userId, "active"))?.secret).toBe("S2");
		expect(await store.findTotp(userId, "pending")).toBeNull();

		// An ACTIVE enrollment is not overwritable: the decision is made inside the store.
		expect(
			await store.savePendingTotp({ id: generateId(), userId, secret: "S3", nowIso: NOW }),
		).toBe("alreadyActive");
		expect((await store.findTotp(userId, "active"))?.secret).toBe("S2");
	});

	test("activation is guarded: nothing pending means nothing happens", async () => {
		await store.activateTotp(userId, NOW);
		expect(await store.findTotp(userId, "active")).toBeNull();

		await store.savePendingTotp({ id: generateId(), userId, secret: "S1", nowIso: NOW });
		await store.activateTotp(userId, NOW);
		const active = await db.query.userTotp.findFirst({
			where: eq(userTotp.userId, userId),
		});
		expect(active?.status).toBe("active");
		expect(active?.activatedAt).toBe(NOW);
	});

	test("the MFA flag round-trips", async () => {
		expect(await store.findMfaEnabled(userId)).toBe(false);
		await store.setMfaEnabled(userId, true);
		expect(await store.findMfaEnabled(userId)).toBe(true);
		await store.setMfaEnabled(userId, false);
		expect(await store.findMfaEnabled(userId)).toBe(false);
		expect(await store.findMfaEnabled(generateId())).toBe(false);
	});

	test("the passkey existence read sees enrolled passkeys only", async () => {
		expect(await store.hasAnyPasskey(userId)).toBe(false);
		await db.insert(userPasskeys).values({
			id: generateId(),
			userId,
			credentialId: `cred-${generateId(6)}`,
			publicKey: "pk",
			createdAt: NOW,
		});
		expect(await store.hasAnyPasskey(userId)).toBe(true);
	});

	test("backup codes: count, consume exactly once, neighbours unaffected", async () => {
		const drafts = [codeDraft(), codeDraft(), codeDraft()];
		await store.replaceBackupCodes(userId, drafts);
		expect(await store.countUnusedBackupCodes(userId)).toBe(3);
		expect((await store.findUnusedBackupCodes(userId)).map((row) => row.id).sort()).toEqual(
			drafts.map((row) => row.id).sort(),
		);

		expect(await store.markBackupCodeUsed(drafts[0].id, NOW)).toBe(true);
		// The guarded update: the same code cannot be consumed twice.
		expect(await store.markBackupCodeUsed(drafts[0].id, NOW)).toBe(false);
		expect(await store.countUnusedBackupCodes(userId)).toBe(2);
		expect((await store.findUnusedBackupCodes(userId)).map((row) => row.id).sort()).toEqual(
			[drafts[1].id, drafts[2].id].sort(),
		);
	});

	test("rotation swaps the whole batch; a mid-swap failure keeps the old batch", async () => {
		const oldBatch = [codeDraft(), codeDraft()];
		await store.replaceBackupCodes(userId, oldBatch);

		// The new batch fails INSIDE the insert (a duplicate id within it is a real UNIQUE
		// violation), i.e. after the old rows were deleted inside the section. Everything
		// must roll back: the old batch is what the user still has.
		const doomed = codeDraft();
		await expect(
			store.replaceBackupCodes(userId, [codeDraft(), doomed, { ...doomed }]),
		).rejects.toThrow();
		expect((await backupCodeRows()).map((row) => row.id).sort()).toEqual(
			oldBatch.map((row) => row.id).sort(),
		);
		expect(await store.countUnusedBackupCodes(userId)).toBe(2);

		// And a good batch still swaps cleanly afterwards.
		const newBatch = [codeDraft()];
		await store.replaceBackupCodes(userId, newBatch);
		expect((await backupCodeRows()).map((row) => row.id)).toEqual([newBatch[0].id]);
	});

	test("clearFactors removes the enrollment and the codes together", async () => {
		await store.savePendingTotp({ id: generateId(), userId, secret: "S1", nowIso: NOW });
		await store.activateTotp(userId, NOW);
		await store.replaceBackupCodes(userId, [codeDraft(), codeDraft()]);

		await store.clearFactors(userId);
		expect(await store.findTotp(userId, "active")).toBeNull();
		expect(await store.countUnusedBackupCodes(userId)).toBe(0);
		expect(
			await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) }),
		).toBeUndefined();
		expect(await backupCodeRows()).toEqual([]);
	});

	test("the MFA store is wired to the SQLite implementation by default", () => {
		expect(authMfaStore).toBe(store);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The port and its adapters carry no cross-dialect dependency
// ─────────────────────────────────────────────────────────────────────────────

describe("the MFA port and its adapters stay dialect-clean", () => {
	const SERVICE_DIR = join(import.meta.dir, "..");

	/** Import specifiers only — prose mentioning a dialect is documentation, not coupling. */
	function importSpecifiers(file: string): string[] {
		const source = readFileSync(join(SERVICE_DIR, file), "utf8");
		return [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
			(m) => m[1] ?? m[2],
		);
	}

	test("mfa-store.ts imports nothing database-specific", () => {
		// The port file has no imports at all today — the claim is that it STAYS that way:
		// an accidental dialect import here is how a portable contract silently becomes a
		// SQLite one.
		const specifiers = importSpecifiers("mfa-store.ts");
		for (const specifier of specifiers) {
			expect(specifier, `imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm");
			expect(specifier, `imports ${specifier}`).not.toMatch(/(?:^|\/)db(?:\/|$)|db\/schema$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/postgres/);
		}
	});

	test("the PostgreSQL adapter carries no SQLite dependency", () => {
		// Same rule as the session adapter: PG-side modules are what it MAY import, and
		// the assertions below require them so the check is not vacuous.
		const specifiers = importSpecifiers("postgres-mfa-store.ts");
		expect(specifiers.length, "postgres-mfa-store.ts should have imports").toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier, `imports ${specifier}`).not.toBe("bun:sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/bun-sqlite");
			expect(specifier, `imports ${specifier}`).not.toStartWith("drizzle-orm/sqlite-core");
			expect(specifier, `imports ${specifier}`).not.toMatch(/^(?:@server\/db|(?:\.\.?\/)+db)$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/(?:^|\/)db\/schema$/);
			expect(specifier, `imports ${specifier}`).not.toMatch(/db\/connection$/);
		}
		expect(specifiers).toContain("@server/db/postgres-schema");
		expect(specifiers).toContain("@server/db/pg-retry");
		expect(specifiers).toContain("@server/db/backend/write-port");
	});
});
