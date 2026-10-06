/**
 * The database capability registration needs, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * Creating an account is one indivisible business fact: an invitation code is validated,
 * the account row is written, and the code is burned by that same account — all of it or
 * none of it. Until now that fact was expressed in `server/lib/auth.ts` by opening a
 * `bun:sqlite` transaction and passing the `tx` handle into a service, which meant the
 * authentication layer knew about SQLite transactions and SQLite tables. Any second
 * backend would have had to reproduce that shape rather than the requirement.
 *
 * So the requirement is written here instead, in domain terms only: what goes in, what
 * comes out, and which failures are guaranteed to leave nothing behind. This file must
 * import nothing dialect-specific — no driver, no Drizzle, no `server/db`, no schema — and
 * a test asserts exactly that, because an accidental import here is how a "portable"
 * contract silently becomes a SQLite one.
 *
 * ATOMICITY IS PART OF THE CONTRACT, NOT OF THE IMPLEMENTATION
 * ------------------------------------------------------------
 * `createAccount` either returns a created account (with the invitation consumed, if one
 * was supplied) or rejects having written nothing at all: no user, no preferences row, and
 * an invitation that is still usable. How that is achieved is the implementation's
 * business. The SQLite adapter uses a strictly synchronous native transaction, because
 * `bun:sqlite` commits when the transaction callback RETURNS — an `async` callback commits
 * at its first `await` and everything after it runs unprotected (see
 * `server/db/transaction-atomicity-contract.test.ts`). A future PostgreSQL adapter will use
 * a genuinely async transaction, which is safe on a networked driver. Both satisfy the
 * signatures below, which are `Promise`-returning precisely so the caller never depends on
 * which one it holds.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a user DAO. Only the three reads/writes registration itself performs are here;
 * login, MFA, OAuth and profile editing are untouched and still speak to the database
 * directly. Widening this port beyond the sliced capability would be inventing a
 * repository layer nobody asked for.
 */
import type { Locale } from "@shared/i18n-locales";

export type AccountRole = "admin" | "user";

/** Everything needed to create one account. All fields are plain data, by design. */
export interface RegistrationAccountDraft {
	userId: string;
	username: string;
	/** Already hashed by the caller: password hashing is CPU work, not database work. */
	passwordHash: string;
	avatarColor: string;
	/** Initial UI language, persisted as the account's preference. */
	language: Locale;
	/**
	 * Role to use when no invitation decides one — i.e. an open-registration signup, or the
	 * bootstrap administrator.
	 */
	defaultRole: AccountRole;
	/**
	 * Plaintext invitation code to redeem as part of this creation. Absent means "no
	 * invitation is involved"; the store must then not touch any invitation.
	 *
	 * Whether a signup is *allowed* without one is policy, decided before we get here.
	 */
	invitationCode?: string;
	/** Single timestamp for every row written, so the account and its redemption agree. */
	nowIso: string;
}

/** The created account, in the shape the session layer needs. */
export interface RegisteredAccount {
	id: string;
	username: string;
	role: AccountRole;
	avatarColor: string | null;
	avatarImageId: string | null;
	createdAt: string;
}

export interface RegistrationAccountResult {
	account: RegisteredAccount;
	/** Invitation consumed by this creation, or null when none was supplied. */
	redeemedCodeId: string | null;
}

export interface RegistrationAccountStore {
	/** How many accounts exist. Zero means this instance still needs its bootstrap admin. */
	countAccounts(): Promise<number>;
	isUsernameTaken(username: string): Promise<boolean>;
	/**
	 * Validate the invitation (when given), create the account and its preferences, and
	 * burn the invitation — atomically.
	 *
	 * Rejects with the registration-code `AppError`s (`CODE_INVALID`, `CODE_EXPIRED`,
	 * `CODE_REVOKED`, `CODE_ALREADY_USED`, `CODE_USERNAME_MISMATCH`) when the invitation is
	 * unusable, and propagates a storage failure as-is. In every rejection the database is
	 * left exactly as it was found.
	 */
	createAccount(draft: RegistrationAccountDraft): Promise<RegistrationAccountResult>;
}
