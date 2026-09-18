/**
 * The database capability the session layer needs, stated without a dialect.
 *
 * WHY THIS EXISTS
 * ---------------
 * Login, session issuance, session verification and revocation all read and write the same
 * small set of account facts — but until now each of them spoke to the SQLite handle directly:
 * `lib/auth.ts` queried `users`/`user_preferences` for login and session issuance,
 * `middleware/auth.ts` queried `users` on every authenticated request (existence, token
 * generation, renewal role), and `revokeUserSessions` bumped `token_version` inline. With the
 * process booted on PostgreSQL that SQLite handle is a fail-closed proxy, so every one of
 * those paths — including the read-only session check — would have died against the wrong
 * database. Worse, injecting only SOME of them would split the loop: a registration written
 * to PostgreSQL with a login read from SQLite.
 *
 * So the requirement is written here, in domain terms: what each operation takes, what it
 * returns, and what must be true afterwards. This file imports nothing dialect-specific —
 * no driver, no Drizzle, no `server/db`, no schema — and a test asserts exactly that.
 *
 * WHAT THE OPERATIONS OWE THE CALLER
 * ----------------------------------
 * - READ-AFTER-WRITE: a fact written through this port (a bumped token generation, a
 *   created account) is visible to the next read through this port on the same store. The
 *   whole point of the port is that one deployment reads and writes ONE database.
 * - `bumpTokenVersion` is an atomic increment (`SET token_version = token_version + 1`),
 *   never a read-modify-write: two concurrent bumps must both land. It returns the NEW
 *   value, or 0 when no such account exists (the pre-port behaviour, preserved verbatim).
 * - Every method returns a Promise so the caller never depends on which backend it holds:
 *   the SQLite implementation resolves around already-committed synchronous work, the
 *   PostgreSQL one around a genuinely async driver round-trip.
 *
 * WHAT IT IS NOT
 * --------------
 * Not a user repository. Only the reads/writes the session loop itself performs are here;
 * profile editing (`PATCH /me`, avatar), passkey enrollment and SSO identities keep their
 * existing storage paths and are deliberately out of this slice. Widening the port beyond
 * the loop would be inventing a repository layer nobody asked for.
 */
import type { AccountRole } from "../registration/account-store";

/** What password verification needs, and nothing more. */
export interface LoginCredential {
	id: string;
	passwordHash: string;
	/** The explicit opt-in switch gating the login-time second factor. */
	mfaEnabled: boolean;
}

/**
 * The session-gate facts: does this account still exist, what is its live role (renewal
 * never trusts the presented token), and which token generation is current (revocation).
 */
export interface SessionState {
	id: string;
	role: AccountRole;
	tokenVersion: number;
}

/** The full account profile a session result or the `/me` payload is built from. */
export interface SessionProfile {
	id: string;
	username: string;
	role: AccountRole;
	avatarColor: string | null;
	avatarImageId: string | null;
	gitUsername: string | null;
	gitEmail: string | null;
	createdAt: string;
	/** Internal revocation counter; carried here so session issuance can sign against it. */
	tokenVersion: number;
	/** The account's UI language preference, or null when no preferences row exists. */
	language: string | null;
}

export interface AuthSessionStore {
	/** Look up an account by username for password verification. Unknown → null. */
	findLoginCredential(username: string): Promise<LoginCredential | null>;
	/** Update editable profile fields on the same backend as the session loop. */
	updateProfile(
		userId: string,
		update: { gitUsername?: string | null; gitEmail?: string | null },
	): Promise<void>;
	/** Set or clear the avatar reference after the upload has been persisted. */
	setAvatarImage(userId: string, imageId: string | null): Promise<void>;
	/** Existence + live role + current token generation for the session gate. Unknown → null. */
	findSessionState(userId: string): Promise<SessionState | null>;
	/** Profile + language + token generation for session issuance and `/me`. Unknown → null. */
	findSessionProfile(userId: string): Promise<SessionProfile | null>;
	/** The stored password hash for in-session re-verification. Unknown → null. */
	findPasswordHash(userId: string): Promise<string | null>;
	/**
	 * Atomically bump the account's token generation, invalidating every session token it
	 * holds. Returns the NEW value; an unknown account returns 0 and changes nothing.
	 */
	bumpTokenVersion(userId: string): Promise<number>;
}
