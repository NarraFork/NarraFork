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
import { userPreferences, users } from "@server/db/schema";
import { eq, sql } from "drizzle-orm";
import { updateLegacyGitIdentityProfile } from "../git-identities";
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

export const sqliteAuthSessionStore: AuthSessionStore = {
	async findLoginCredential(username: string): Promise<LoginCredential | null> {
		const row = await db.query.users.findFirst({
			where: eq(users.username, username),
			columns: { id: true, passwordHash: true, mfaEnabled: true },
		});
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
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { id: true, role: true, tokenVersion: true },
		});
		if (!row) return null;
		return { id: row.id, role: asRole(row.role), tokenVersion: row.tokenVersion };
	},

	async findSessionProfile(userId: string): Promise<SessionProfile | null> {
		// One LEFT JOIN instead of the pre-port pair of findFirsts: the preferences row
		// belongs to the account, and reading them together is the same observation.
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

	async findPasswordHash(userId: string): Promise<string | null> {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { passwordHash: true },
		});
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
};
