/**
 * PostgreSQL implementation of `AuthMfaStore`.
 *
 * Same capability as `sqlite-mfa-store.ts`, different engine — and deliberately not the
 * same code: what the two implementations share is the port (`mfa-store.ts`). Everything
 * dialect-shaped lives here: a genuinely async transaction (an `await` between BEGIN and
 * COMMIT is safe on a networked driver, which is exactly what the write-port base
 * contrasts with the SQLite implementation's strictly synchronous section), whole-section
 * retry, and conflict translation.
 *
 * HOW EACH REQUIREMENT OF THE PORT IS MET
 * ---------------------------------------
 * - ATOMICITY: `savePendingTotp`, `replaceBackupCodes` and `clearFactors` each run their
 *   whole decision in one `db.transaction`; any rejection rolls all of it back.
 * - RETRY: `withPgRetry` wraps the WHOLE section (BEGIN through COMMIT), never a single
 *   statement. Each section is idempotent under whole-section replay: `savePendingTotp`
 *   re-decides from the row it finds, the backup-code rows carry caller-supplied ids so a
 *   replay writes the same rows, and `clearFactors` is a delete.
 * - CONFLICTS AS VOCABULARY: SQLSTATE 23505 is translated to `WriteConflictError` before
 *   it can cross the port boundary (the only statement that can produce one is the
 *   first-enrollment insert losing a race on `idx_user_totp_user`). `withPgRetry`
 *   classifies that as a unique-violation and never retries it into a false success.
 * - THE GUARDED CONSUME: `markBackupCodeUsed` is one conditional UPDATE
 *   (`… WHERE id = ? AND used_at IS NULL`), so two concurrent redemptions of one code
 *   serialize on the row lock and the loser updates zero rows — the same answer the
 *   SQLite implementation gives.
 * - HASHING STAYS OUTSIDE: nothing here hashes a code or a password; the service hands
 *   over finished rows. The atomic sections contain database writes only.
 */

import { WriteConflictError } from "@server/db/backend/write-port";
import { isPgUniqueViolation } from "@server/db/pg-errors";
import { withPgRetry } from "@server/db/pg-retry";
import { userMfaBackupCodes, userPasskeys, users, userTotp } from "@server/db/postgres-schema";
import { and, eq, isNull } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	AuthMfaStore,
	BackupCodeDraft,
	StoredBackupCode,
	TotpEnrollment,
	TotpStatus,
} from "./mfa-store";

/** Transaction handle as produced by `db.transaction(async (tx) => …)`. PG-side only. */
type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

/** How deep `cause` chains are followed when looking for the driver error's detail. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The constraint name the server attached to a unique violation, when it reported one.
 * Same extraction rule as the registration store: Bun SQL surfaces it as
 * `PostgresError.constraint`, and Drizzle may wrap the driver error under `cause`.
 */
function extractConstraintName(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (!current || typeof current !== "object") return null;
		const constraint = (current as Record<string, unknown>).constraint;
		if (typeof constraint === "string" && constraint.length > 0) return constraint;
		current = (current as Record<string, unknown>).cause;
	}
	return null;
}

/**
 * Translate a unique violation into port vocabulary; everything else passes through.
 * The translation happens HERE, at the port boundary, so the caller never recognizes a
 * driver error shape.
 */
function rethrowAsPortError(error: unknown): never {
	if (isPgUniqueViolation(error)) {
		throw new WriteConflictError("write conflicts with an existing row", {
			constraint: extractConstraintName(error),
			cause: error,
		});
	}
	throw error;
}

/**
 * The pending-secret decision as one async section — the piece `withPgRetry` must be able
 * to replay WHOLE. An ACTIVE enrollment is never overwritten: overwriting one would
 * silently replace the user's second factor with a secret chosen by whoever triggered
 * this call. A missing or still-pending enrollment is replaced by the new pending secret.
 */
async function savePendingTotpSection(
	tx: PgTransaction,
	input: { id: string; userId: string; secret: string; nowIso: string },
): Promise<"saved" | "alreadyActive"> {
	// Serialize enrollment decisions on the stable users row. Locking only the optional
	// user_totp row is insufficient when two requests race while no enrollment exists: both
	// can observe absence, then one loses the unique index and reports a conflict instead of
	// preserving the store's "saved or alreadyActive" contract.
	await tx
		.select({ id: users.id })
		.from(users)
		.where(eq(users.id, input.userId))
		.for("update")
		.limit(1);
	const existing = (
		await tx
			.select({ id: userTotp.id, status: userTotp.status })
			.from(userTotp)
			.where(eq(userTotp.userId, input.userId))
			.limit(1)
	)[0];
	if (existing?.status === "active") return "alreadyActive";
	try {
		if (existing) {
			await tx
				.update(userTotp)
				.set({
					secret: input.secret,
					status: "pending",
					activatedAt: null,
					createdAt: input.nowIso,
				})
				.where(eq(userTotp.userId, input.userId));
		} else {
			// The row can still appear between the SELECT and this INSERT when two enrollments
			// race on a user with none: the unique index on `user_totp.user_id` decides, and
			// the loser hears it as port vocabulary, not as a driver error.
			await tx.insert(userTotp).values({
				id: input.id,
				userId: input.userId,
				secret: input.secret,
				status: "pending",
				createdAt: input.nowIso,
			});
		}
	} catch (error) {
		rethrowAsPortError(error);
	}
	return "saved";
}

/** Backup-code rotation as one async section: the old batch and the new one swap atomically. */
async function replaceBackupCodesSection(
	tx: PgTransaction,
	userId: string,
	rows: BackupCodeDraft[],
): Promise<void> {
	await tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId));
	if (rows.length > 0) {
		await tx.insert(userMfaBackupCodes).values(rows.map((row) => ({ ...row, userId })));
	}
}

/** Teardown as one async section: the enrollment and its backup codes go together. */
async function clearFactorsSection(tx: PgTransaction, userId: string): Promise<void> {
	await tx.delete(userTotp).where(eq(userTotp.userId, userId));
	await tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId));
}

/**
 * Build the store over a caller-supplied handle. The factory takes the database rather
 * than opening one: who owns the connection (and its lifecycle) is a composition-root
 * decision, and tests supply a handle pointed at a throwaway container.
 */
export function createPostgresAuthMfaStore(db: BunSQLDatabase): AuthMfaStore {
	return {
		async findTotp(userId: string, status: TotpStatus): Promise<TotpEnrollment | null> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ status: userTotp.status, secret: userTotp.secret })
						.from(userTotp)
						.where(and(eq(userTotp.userId, userId), eq(userTotp.status, status)))
						.limit(1);
					const row = rows[0];
					if (!row) return null;
					return { status: row.status === "active" ? "active" : "pending", secret: row.secret };
				},
				{ label: "authMfa.findTotp" },
			);
		},

		async findMfaEnabled(userId: string): Promise<boolean> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ mfaEnabled: users.mfaEnabled })
						.from(users)
						.where(eq(users.id, userId))
						.limit(1);
					return !!rows[0]?.mfaEnabled;
				},
				{ label: "authMfa.findMfaEnabled" },
			);
		},

		async setMfaEnabled(userId: string, enabled: boolean): Promise<void> {
			await withPgRetry(
				async () => {
					await db.update(users).set({ mfaEnabled: enabled }).where(eq(users.id, userId));
				},
				{ label: "authMfa.setMfaEnabled" },
			);
		},

		async hasAnyPasskey(userId: string): Promise<boolean> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ id: userPasskeys.id })
						.from(userPasskeys)
						.where(eq(userPasskeys.userId, userId))
						.limit(1);
					return rows.length > 0;
				},
				{ label: "authMfa.hasAnyPasskey" },
			);
		},

		async savePendingTotp(input: {
			id: string;
			userId: string;
			secret: string;
			nowIso: string;
		}): Promise<"saved" | "alreadyActive"> {
			return withPgRetry(() => db.transaction((tx) => savePendingTotpSection(tx, input)), {
				label: "authMfa.savePendingTotp",
			});
		},

		async activateTotp(userId: string, nowIso: string): Promise<void> {
			await withPgRetry(
				async () => {
					// Guarded on the pending state: activation after teardown (or a double
					// activate) updates nothing instead of resurrecting a row.
					await db
						.update(userTotp)
						.set({ status: "active", activatedAt: nowIso })
						.where(and(eq(userTotp.userId, userId), eq(userTotp.status, "pending")));
				},
				{ label: "authMfa.activateTotp" },
			);
		},

		async countUnusedBackupCodes(userId: string): Promise<number> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ id: userMfaBackupCodes.id })
						.from(userMfaBackupCodes)
						.where(and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)));
					return rows.length;
				},
				{ label: "authMfa.countUnusedBackupCodes" },
			);
		},

		async findUnusedBackupCodes(userId: string): Promise<StoredBackupCode[]> {
			return withPgRetry(
				async () => {
					return await db
						.select({ id: userMfaBackupCodes.id, codeHash: userMfaBackupCodes.codeHash })
						.from(userMfaBackupCodes)
						.where(and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)));
				},
				{ label: "authMfa.findUnusedBackupCodes" },
			);
		},

		async markBackupCodeUsed(id: string, nowIso: string): Promise<boolean> {
			return withPgRetry(
				async () => {
					// A guarded write, not a check-then-write: the row is consumed only while
					// still unused, so two concurrent redemptions of one code cannot both succeed.
					const consumed = await db
						.update(userMfaBackupCodes)
						.set({ usedAt: nowIso })
						.where(and(eq(userMfaBackupCodes.id, id), isNull(userMfaBackupCodes.usedAt)))
						.returning({ id: userMfaBackupCodes.id });
					return consumed.length > 0;
				},
				{ label: "authMfa.markBackupCodeUsed" },
			);
		},

		async replaceBackupCodes(userId: string, rows: BackupCodeDraft[]): Promise<void> {
			// The retry unit is the whole swap: old batch deleted and new batch inserted as
			// one fact. The rows carry caller-supplied ids, so a replay writes the same rows.
			await withPgRetry(() => db.transaction((tx) => replaceBackupCodesSection(tx, userId, rows)), {
				label: "authMfa.replaceBackupCodes",
			});
		},

		async clearFactors(userId: string): Promise<void> {
			await withPgRetry(() => db.transaction((tx) => clearFactorsSection(tx, userId)), {
				label: "authMfa.clearFactors",
			});
		},
	};
}
