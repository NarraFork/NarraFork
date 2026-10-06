/**
 * The database capability the MFA service needs, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * `mfa-service.ts` owned the TOTP/backup-code tables directly: enrollment, activation,
 * the login-time factor check, backup-code consumption and teardown were all expressed
 * as SQLite queries and `bun:sqlite` transactions. On a PostgreSQL deployment those
 * queries have to run against the same database the account lives in — an MFA flag read
 * from SQLite while the login lookup reads PostgreSQL would either lock users out or
 * silently skip the second factor.
 *
 * So the requirement is written here instead, in domain terms only. This file imports
 * nothing dialect-specific — no driver, no Drizzle, no `server/db`, no schema — and a
 * test asserts exactly that.
 *
 * ATOMICITY IS PART OF THE CONTRACT
 * ---------------------------------
 * - `savePendingTotp` is one indivisible decision: an ACTIVE enrollment is never
 *   overwritten (that would silently downgrade a user's second factor to a secret the
 *   caller just made up), while a missing or still-pending one is replaced by the new
 *   pending secret. Check and write happen together, or not at all.
 * - `replaceBackupCodes` is all-or-nothing: the old batch is deleted and the new batch
 *   inserted as one fact, so a failure can never leave the user with NO usable backup
 *   codes while the service believes it returned fresh ones.
 * - `clearFactors` removes the TOTP enrollment and every backup code together.
 * - `markBackupCodeUsed` is a GUARDED write, not a check-then-write: it consumes the
 *   code only if it is still unused, so two concurrent redemptions of one code cannot
 *   both succeed. The bcrypt comparison that picks the row happens OUTSIDE the atomic
 *   section (in the service), exactly like password hashing at registration.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a passkey or WebAuthn store. `hasAnyPasskey` is an existence READ only, here
 * because the MFA service must know whether a second factor exists at all; passkey
 * enrollment and ceremonies keep their own storage path and are out of this slice.
 */
export type TotpStatus = "pending" | "active";

/** The stored TOTP enrollment, as far as the MFA service needs it. */
export interface TotpEnrollment {
	status: TotpStatus;
	secret: string;
}

/** An unused backup code row, for the verify-and-consume loop. */
export interface StoredBackupCode {
	id: string;
	codeHash: string;
}

/** A new backup code row, already hashed by the caller (CPU work, not database work). */
export interface BackupCodeDraft {
	id: string;
	codeHash: string;
	createdAt: string;
}

export interface AuthMfaStore {
	/** The enrollment in the given state, or null. The login gate reads `active`. */
	findTotp(userId: string, status: TotpStatus): Promise<TotpEnrollment | null>;
	/** Whether the user opted into requiring a second factor at login. */
	findMfaEnabled(userId: string): Promise<boolean>;
	/** Set the login-time second-factor requirement flag. */
	setMfaEnabled(userId: string, enabled: boolean): Promise<void>;
	/** Whether the user has at least one enrolled passkey (existence read only). */
	hasAnyPasskey(userId: string): Promise<boolean>;
	/**
	 * Store a freshly generated pending secret. "alreadyActive" when an ACTIVE enrollment
	 * exists (nothing is written); otherwise the new pending secret replaces any previous
	 * pending one — atomically.
	 */
	savePendingTotp(input: {
		id: string;
		userId: string;
		secret: string;
		nowIso: string;
	}): Promise<"saved" | "alreadyActive">;
	/**
	 * Mark the pending enrollment active. Called only after the service verified a code
	 * against the pending secret; a no-op when no pending enrollment exists anymore.
	 */
	activateTotp(userId: string, nowIso: string): Promise<void>;
	/** How many backup codes remain unused (the status page's count). */
	countUnusedBackupCodes(userId: string): Promise<number>;
	/** Every unused backup code row, for the service's verify-and-consume loop. */
	findUnusedBackupCodes(userId: string): Promise<StoredBackupCode[]>;
	/**
	 * Consume one backup code — but only if it is still unused. Returns false when the
	 * guarded update found the row already consumed (a concurrent redemption won).
	 */
	markBackupCodeUsed(id: string, nowIso: string): Promise<boolean>;
	/** Replace the user's whole backup-code batch with a fresh one, atomically. */
	replaceBackupCodes(userId: string, rows: BackupCodeDraft[]): Promise<void>;
	/** Remove the TOTP enrollment and every backup code, atomically. */
	clearFactors(userId: string): Promise<void>;
}
