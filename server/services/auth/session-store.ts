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
	/** Internal revocation counter; carried here so session issuance can bind to it. */
	tokenVersion: number;
	/** The account's UI language preference, or null when no preferences row exists. */
	language: string | null;
}

/** A new opaque-token session row. Times are unix seconds. */
export interface NewAuthSession {
	id: string;
	userId: string;
	/** SHA-256 of the bearer token; the token itself is never stored. */
	tokenHash: string;
	tokenVersion: number;
	sessionStart: number;
	createdAt: number;
	expiresAt: number;
}

/**
 * A session row joined with its account: everything the gate needs to accept or reject a
 * presented token in one read. The role and the account's token generation are LIVE values.
 */
export interface AuthSessionRecord {
	id: string;
	userId: string;
	role: AccountRole;
	/** `users.token_version` now. */
	userTokenVersion: number;
	/** `users.token_version` when the session was issued. */
	sessionTokenVersion: number;
	sessionStart: number;
	createdAt: number;
	expiresAt: number;
	revokedAt: number | null;
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
	/** Persist a freshly issued session. */
	createSession(session: NewAuthSession): Promise<void>;
	/** Resolve a session by token hash, joined with its account. Unknown → null. */
	findSessionByTokenHash(tokenHash: string): Promise<AuthSessionRecord | null>;
	/** Resolve a session by id, joined with its account (long-lived sockets). Unknown → null. */
	findSessionById(sessionId: string): Promise<AuthSessionRecord | null>;
	/**
	 * Slide a live session's expiry forward. Never revives a revoked session and never
	 * shortens one (a concurrent renewal that already went further wins).
	 */
	extendSession(sessionId: string, expiresAt: number): Promise<void>;
	/** Mark one session revoked. Idempotent: an already revoked session keeps its timestamp. */
	revokeSession(sessionId: string, revokedAt: number): Promise<void>;
	/**
	 * Delete up to `limit` sessions that expired, or were revoked, before `before`.
	 * Returns how many rows were deleted, so the caller can keep sweeping in bounded batches.
	 */
	deleteStaleSessions(before: number, limit: number): Promise<number>;
}
