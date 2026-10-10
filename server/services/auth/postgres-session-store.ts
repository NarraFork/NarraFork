/**
 * PostgreSQL implementation of `AuthSessionStore`.
 *
 * Same capability as `sqlite-session-store.ts`, different engine — and deliberately not the
 * same code: every method is honestly async against a networked driver, and each statement
 * runs through `withPgRetry` (`server/db/pg-retry.ts`), whose retry unit is safe here because
 * every operation in this port is a SINGLE statement. A server-side abort of an autocommit
 * statement (40001/40P01/55P03) means that statement never took effect, so replaying it
 * cannot duplicate anything; `bumpTokenVersion` in particular must stay one atomic
 * increment statement, never a read-modify-write spread over two.
 *
 * No unique-violation translation lives in this file because no statement in this port can
 * produce one: the port writes nothing but the guarded increment. Should that ever change,
 * the conflict must cross the boundary as `WriteConflictError` vocabulary (see
 * `server/db/backend/write-port.ts`), not as a driver error.
 */
import { withPgRetry } from "@server/db/pg-retry";
import { userPreferences, users } from "@server/db/postgres-schema";
import { ValidationError } from "@server/lib/errors";
import { eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { AccountRole } from "../registration/account-store";
import type {
	AuthSessionStore,
	LoginCredential,
	SessionProfile,
	SessionState,
} from "./session-store";

/** The schema stores role as text; the two role names are all it ever holds. */
function asRole(role: string): AccountRole {
	return role === "admin" ? "admin" : "user";
}

/**
 * Build the store over a caller-supplied handle. The factory takes the database rather
 * than opening one: who owns the connection (and its lifecycle) is a composition-root
 * decision, and tests supply a handle pointed at a throwaway container.
 */
export function createPostgresAuthSessionStore(db: BunSQLDatabase): AuthSessionStore {
	return {
		async findLoginCredential(username: string): Promise<LoginCredential | null> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({
							id: users.id,
							passwordHash: users.passwordHash,
							mfaEnabled: users.mfaEnabled,
						})
						.from(users)
						.where(eq(users.username, username))
						.limit(1);
					return rows[0] ?? null;
				},
				{ label: "authSession.findLoginCredential" },
			);
		},

		async updateProfile(
			_userId: string,
			update: { gitUsername?: string | null; gitEmail?: string | null },
		): Promise<void> {
			// Git identity storage/resolution is not wired to PostgreSQL yet. Do not
			// acknowledge a legacy-column write that cannot change commit attribution.
			if (update.gitUsername !== undefined || update.gitEmail !== undefined) {
				throw new ValidationError("Git identities are not supported on the PostgreSQL backend yet");
			}
		},

		async setAvatarImage(userId: string, imageId: string | null): Promise<void> {
			await withPgRetry(
				async () => {
					await db.update(users).set({ avatarImageId: imageId }).where(eq(users.id, userId));
				},
				{ label: "authSession.setAvatarImage" },
			);
		},

		async findSessionState(userId: string): Promise<SessionState | null> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ id: users.id, role: users.role, tokenVersion: users.tokenVersion })
						.from(users)
						.where(eq(users.id, userId))
						.limit(1);
					const row = rows[0];
					if (!row) return null;
					return { id: row.id, role: asRole(row.role), tokenVersion: row.tokenVersion };
				},
				{ label: "authSession.findSessionState" },
			);
		},

		async findSessionProfile(userId: string): Promise<SessionProfile | null> {
			return withPgRetry(
				async () => {
					// One LEFT JOIN: the preferences row belongs to the account, and reading them
					// together is the same observation the SQLite adapter makes.
					const rows = await db
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
					const row = rows[0];
					if (!row) return null;
					return { ...row, role: asRole(row.role) };
				},
				{ label: "authSession.findSessionProfile" },
			);
		},

		async findPasswordHash(userId: string): Promise<string | null> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ passwordHash: users.passwordHash })
						.from(users)
						.where(eq(users.id, userId))
						.limit(1);
					return rows[0]?.passwordHash ?? null;
				},
				{ label: "authSession.findPasswordHash" },
			);
		},

		async bumpTokenVersion(userId: string): Promise<number> {
			return withPgRetry(
				async () => {
					// The increment happens IN the statement: two concurrent bumps both land,
					// with no read-modify-write window. `?? 0` is the port's answer for a
					// missing account.
					const rows = await db
						.update(users)
						.set({ tokenVersion: sql`${users.tokenVersion} + 1` })
						.where(eq(users.id, userId))
						.returning({ tokenVersion: users.tokenVersion });
					return rows[0]?.tokenVersion ?? 0;
				},
				{ label: "authSession.bumpTokenVersion" },
			);
		},
	};
}
