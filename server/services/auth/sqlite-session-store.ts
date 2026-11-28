/**
 * SQLite implementation of `AuthSessionStore`.
 *
 * Every operation is a single statement or a strictly synchronous section. Legacy
 * profile identity updates delegate to one synchronous transaction, while
 * `bumpTokenVersion` remains one atomic increment statement. The `async` keywords
 * shape the boundary Promise; no
 * `await` ever sits between a BEGIN and a COMMIT here, which is the property
 * `server/db/transaction-atomicity-contract.test.ts` exists to gate.
 *
 * Behaviour is the pre-port behaviour, lifted verbatim: the same columns, the same
 * `?? 0` for a missing row, the same role normalization the registration store already
 * performs. A second backend implements the same port over its own driver in a sibling
 * module and shares nothing with this file but the port.
 */
import { db } from "@server/db";
import { authSessions, userPreferences, users } from "@server/db/schema";
import type { AuthReadOptions } from "@server/lib/auth-read-admission";
import { and, eq, inArray, isNotNull, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import { updateLegacyGitIdentityProfile } from "../git-identities";
import type { AccountRole } from "../registration/account-store";
import type {
	AuthSessionRecord,
	AuthSessionStore,
	LoginCredential,
	NewAuthSession,
	SessionProfile,
	SessionState,
} from "./session-store";
import { authRead } from "./sqlite-auth-read";

/** The schema stores role as text; the two role names are all it ever holds. */
function asRole(role: string): AccountRole {
	return role === "admin" ? "admin" : "user";
}

/** One session row joined with its account, by a unique key. */
async function findSession(
	where: SQL,
	options?: AuthReadOptions,
): Promise<AuthSessionRecord | null> {
	const query = db
		.select({
			id: authSessions.id,
			userId: authSessions.userId,
			role: users.role,
			userTokenVersion: users.tokenVersion,
			sessionTokenVersion: authSessions.tokenVersion,
			sessionStart: authSessions.sessionStart,
			createdAt: authSessions.createdAt,
			expiresAt: authSessions.expiresAt,
			revokedAt: authSessions.revokedAt,
		})
		.from(authSessions)
		.innerJoin(users, eq(users.id, authSessions.userId))
		.where(where)
		.limit(1);
	const [row] = await authRead(query, options);
	if (!row) return null;
	return { ...row, role: asRole(row.role) };
}

export const sqliteAuthSessionStore: AuthSessionStore = {
	async findLoginCredential(username: string): Promise<LoginCredential | null> {
		const [row] = await authRead(
			db
				.select({ id: users.id, passwordHash: users.passwordHash, mfaEnabled: users.mfaEnabled })
				.from(users)
				.where(eq(users.username, username))
				.limit(1),
		);
		return row ?? null;
	},

	async updateProfile(
		userId: string,
		update: { gitUsername?: string | null; gitEmail?: string | null },
	): Promise<void> {
		await updateLegacyGitIdentityProfile(userId, update);
	},

	async setAvatarImage(userId: string, imageId: string | null): Promise<void> {
		await db.update(users).set({ avatarImageId: imageId }).where(eq(users.id, userId));
	},

	async findSessionState(userId: string): Promise<SessionState | null> {
		const [row] = await authRead(
			db
				.select({ id: users.id, role: users.role, tokenVersion: users.tokenVersion })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1),
		);
		if (!row) return null;
		return { id: row.id, role: asRole(row.role), tokenVersion: row.tokenVersion };
	},

	async findSessionProfile(userId: string): Promise<SessionProfile | null> {
		// One LEFT JOIN instead of the pre-port pair of findFirsts: the preferences row
		// belongs to the account, and reading them together is the same observation.
		const query = db
			.select({
				id: users.id,
				username: users.username,
				role: users.role,
				avatarColor: users.avatarColor,
				avatarImageId: users.avatarImageId,
				gitUsername: users.gitUsername,
				gitEmail: users.gitEmail,
				createdAt: users.createdAt,
				tokenVersion: users.tokenVersion,
				language: userPreferences.language,
			})
			.from(users)
			.leftJoin(userPreferences, eq(userPreferences.userId, users.id))
			.where(eq(users.id, userId))
			.limit(1);
		const [row] = await authRead(query);
		if (!row) return null;
		return { ...row, role: asRole(row.role) };
	},

	async findPasswordHash(userId: string): Promise<string | null> {
		const [row] = await authRead(
			db
				.select({ passwordHash: users.passwordHash })
				.from(users)
				.where(eq(users.id, userId))
				.limit(1),
		);
		return row?.passwordHash ?? null;
	},

	async bumpTokenVersion(userId: string): Promise<number> {
		// The increment happens IN the statement: two concurrent bumps both land, with no
		// read-modify-write window. `?? 0` preserves the pre-port answer for a missing row.
		const [row] = await db
			.update(users)
			.set({ tokenVersion: sql`${users.tokenVersion} + 1` })
			.where(eq(users.id, userId))
			.returning({ tokenVersion: users.tokenVersion });
		return row?.tokenVersion ?? 0;
	},

	async createSession(session: NewAuthSession): Promise<void> {
		await db.insert(authSessions).values(session);
	},

	async findSessionByTokenHash(
		tokenHash: string,
		options?: AuthReadOptions,
	): Promise<AuthSessionRecord | null> {
		return findSession(eq(authSessions.tokenHash, tokenHash), options);
	},

	async findSessionById(
		sessionId: string,
		options?: AuthReadOptions,
	): Promise<AuthSessionRecord | null> {
		return findSession(eq(authSessions.id, sessionId), options);
	},

	async extendSession(sessionId: string, expiresAt: number): Promise<void> {
		await db
			.update(authSessions)
			.set({ expiresAt })
			.where(
				and(
					eq(authSessions.id, sessionId),
					isNull(authSessions.revokedAt),
					lt(authSessions.expiresAt, expiresAt),
				),
			);
	},

	async revokeSession(sessionId: string, revokedAt: number): Promise<void> {
		await db
			.update(authSessions)
			.set({ revokedAt })
			.where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
	},

	async deleteStaleSessions(before: number, limit: number): Promise<number> {
		// Bounded by `limit` so one sweep never holds the main thread for a large delete.
		const stale = db
			.select({ id: authSessions.id })
			.from(authSessions)
			.where(
				or(
					lt(authSessions.expiresAt, before),
					and(isNotNull(authSessions.revokedAt), lt(authSessions.revokedAt, before)),
				),
			)
			.limit(limit);
		const deleted = await db
			.delete(authSessions)
			.where(inArray(authSessions.id, stale))
			.returning({ id: authSessions.id });
		return deleted.length;
	},
};
