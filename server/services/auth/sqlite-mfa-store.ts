/**
 * SQLite implementation of `AuthMfaStore`.
 *
 * The atomic sections (`savePendingTotp`, `replaceBackupCodes`, `clearFactors`) are
 * STRICTLY SYNCHRONOUS `db.transaction` callbacks, and that is not a style choice:
 * `bun:sqlite` commits when the callback RETURNS, so an `async` callback commits at its
 * first `await` and everything after it runs unprotected (see
 * `server/db/transaction-atomicity-contract.test.ts`). Each section below is a named
 * function containing no `await` at all; the `async` on the port methods only shapes
 * the boundary Promise.
 *
 * Behaviour is the pre-port `mfa-service.ts` behaviour, lifted verbatim: same guarded
 * consume update, same delete-then-insert backup-code rotation, same teardown of both
 * factor tables together. The PostgreSQL sibling implements the same port with a
 * genuinely async transaction, which is safe on a networked driver.
 */
import { db } from "@server/db";
import { userMfaBackupCodes, userPasskeys, users, userTotp } from "@server/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import type {
	AuthMfaStore,
	BackupCodeDraft,
	StoredBackupCode,
	TotpEnrollment,
	TotpStatus,
} from "./mfa-store";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The pending-secret decision as one synchronous unit. An ACTIVE enrollment is never
 * overwritten — overwriting one would silently replace the user's second factor with a
 * secret chosen by whoever triggered this call. A missing or still-pending enrollment is
 * replaced by the new pending secret.
 */
function savePendingTotpAtomically(
	tx: DbTransaction,
	input: { id: string; userId: string; secret: string; nowIso: string },
): "saved" | "alreadyActive" {
	const existing = tx
		.select({ id: userTotp.id, status: userTotp.status })
		.from(userTotp)
		.where(eq(userTotp.userId, input.userId))
		.limit(1)
		.all()[0];
	if (existing?.status === "active") return "alreadyActive";
	if (existing) {
		tx.update(userTotp)
			.set({ secret: input.secret, status: "pending", activatedAt: null, createdAt: input.nowIso })
			.where(eq(userTotp.userId, input.userId))
			.run();
	} else {
		tx.insert(userTotp)
			.values({
				id: input.id,
				userId: input.userId,
				secret: input.secret,
				status: "pending",
				createdAt: input.nowIso,
			})
			.run();
	}
	return "saved";
}

/** Backup-code rotation as one synchronous unit: the old batch and the new one swap atomically. */
function replaceBackupCodesAtomically(
	tx: DbTransaction,
	userId: string,
	rows: BackupCodeDraft[],
): void {
	tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId)).run();
	if (rows.length > 0) {
		tx.insert(userMfaBackupCodes)
			.values(rows.map((row) => ({ ...row, userId })))
			.run();
	}
}

/** Teardown as one synchronous unit: the enrollment and its backup codes go together. */
function clearFactorsAtomically(tx: DbTransaction, userId: string): void {
	tx.delete(userTotp).where(eq(userTotp.userId, userId)).run();
	tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId)).run();
}

export const sqliteAuthMfaStore: AuthMfaStore = {
	async findTotp(userId: string, status: TotpStatus): Promise<TotpEnrollment | null> {
		const row = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, status)),
			columns: { status: true, secret: true },
		});
		if (!row) return null;
		return { status: row.status === "active" ? "active" : "pending", secret: row.secret };
	},

	async findMfaEnabled(userId: string): Promise<boolean> {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { mfaEnabled: true },
		});
		return !!row?.mfaEnabled;
	},

	async setMfaEnabled(userId: string, enabled: boolean): Promise<void> {
		await db.update(users).set({ mfaEnabled: enabled }).where(eq(users.id, userId));
	},

	async hasAnyPasskey(userId: string): Promise<boolean> {
		const row = await db.query.userPasskeys.findFirst({
			where: eq(userPasskeys.userId, userId),
			columns: { id: true },
		});
		return !!row;
	},

	async savePendingTotp(input: {
		id: string;
		userId: string;
		secret: string;
		nowIso: string;
	}): Promise<"saved" | "alreadyActive"> {
		// No `await` inside the section — see the header.
		return db.transaction((tx) => savePendingTotpAtomically(tx, input));
	},

	async activateTotp(userId: string, nowIso: string): Promise<void> {
		// Guarded on the pending state: activation after teardown (or a double activate)
		// updates nothing instead of resurrecting a row.
		await db
			.update(userTotp)
			.set({ status: "active", activatedAt: nowIso })
			.where(and(eq(userTotp.userId, userId), eq(userTotp.status, "pending")));
	},

	async countUnusedBackupCodes(userId: string): Promise<number> {
		const rows = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
			columns: { id: true },
		});
		return rows.length;
	},

	async findUnusedBackupCodes(userId: string): Promise<StoredBackupCode[]> {
		return await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
			columns: { id: true, codeHash: true },
		});
	},

	async markBackupCodeUsed(id: string, nowIso: string): Promise<boolean> {
		// A guarded write, not a check-then-write: the row is consumed only while still
		// unused, so two concurrent redemptions of one code cannot both succeed.
		const consumed = await db
			.update(userMfaBackupCodes)
			.set({ usedAt: nowIso })
			.where(and(eq(userMfaBackupCodes.id, id), isNull(userMfaBackupCodes.usedAt)))
			.returning({ id: userMfaBackupCodes.id })
			.get();
		return consumed !== undefined;
	},

	async replaceBackupCodes(userId: string, rows: BackupCodeDraft[]): Promise<void> {
		// No `await` inside the section — see the header.
		db.transaction((tx) => replaceBackupCodesAtomically(tx, userId, rows));
	},

	async clearFactors(userId: string): Promise<void> {
		// No `await` inside the section — see the header.
		db.transaction((tx) => clearFactorsAtomically(tx, userId));
	},
};
