/**
 * SQLite implementation of `RegistrationAccountStore`.
 *
 * The atomic section is a STRICTLY SYNCHRONOUS `db.transaction` callback, and that is not a
 * style choice. `bun:sqlite` commits when the callback RETURNS, so an `async` callback
 * commits at its first `await` and every statement after it runs in autocommit — not rolled
 * back on failure, and interleavable with another request's transaction on the shared
 * connection. `server/db/transaction-atomicity-contract.test.ts` demonstrates both failures
 * and gates the shape. `createAccount` is therefore `async` on the OUTSIDE (the caller only
 * ever sees a Promise) while the section between BEGIN and COMMIT contains no `await` at
 * all.
 *
 * Ordering inside the section is forced by the schema: `registration_codes.used_by_user_id`
 * has a foreign key to `users`, which SQLite checks the moment the row is written. So the
 * invitation is resolved first (its role decides what to insert the user with), then the
 * account, then the invitation is claimed. A failure anywhere rolls back all three.
 *
 * A PostgreSQL implementation of the same port belongs in a sibling module and will be
 * genuinely async — an `await` on a networked driver is safe. It will not reuse this file,
 * this schema or `registration_codes` as such; what it must reuse is
 * `assertInvitationRedeemable`, so the accept/reject rules and their error identities stay
 * one definition rather than two that drift.
 */
import { db } from "@server/db";
import { userPreferences, users } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { registrationCodeService } from "@server/services/registration-code-service";
import { count, eq } from "drizzle-orm";
import type {
	RegistrationAccountDraft,
	RegistrationAccountResult,
	RegistrationAccountStore,
} from "./account-store";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The whole atomic section, extracted so it is one readable synchronous unit.
 *
 * Keeping it a named function (rather than an inline closure) is deliberate: it is the piece
 * that must never acquire an `await`, and a reviewer can check that property by reading one
 * short function instead of scanning a nested callback.
 */
function createAccountAtomically(
	tx: DbTransaction,
	draft: RegistrationAccountDraft,
): RegistrationAccountResult {
	const invitation = draft.invitationCode
		? registrationCodeService.resolveUsableCodeInTransaction(tx, {
				code: draft.invitationCode,
				username: draft.username,
				nowIso: draft.nowIso,
			})
		: null;

	const [account] = tx
		.insert(users)
		.values({
			id: draft.userId,
			username: draft.username,
			passwordHash: draft.passwordHash,
			role: invitation?.role ?? draft.defaultRole,
			avatarColor: draft.avatarColor,
			createdAt: draft.nowIso,
		})
		.returning({
			id: users.id,
			username: users.username,
			role: users.role,
			avatarColor: users.avatarColor,
			avatarImageId: users.avatarImageId,
			createdAt: users.createdAt,
		})
		.all();

	tx.insert(userPreferences)
		.values({
			id: generateId(),
			userId: account.id,
			language: draft.language,
			createdAt: draft.nowIso,
			updatedAt: draft.nowIso,
		})
		.run();

	// After the account row exists: the claim writes a foreign key to it.
	if (invitation) {
		registrationCodeService.claimCodeInTransaction(tx, {
			codeId: invitation.id,
			userId: account.id,
			nowIso: draft.nowIso,
		});
	}

	return { account, redeemedCodeId: invitation?.id ?? null };
}

export const sqliteRegistrationAccountStore: RegistrationAccountStore = {
	async countAccounts(): Promise<number> {
		const [row] = await db.select({ value: count() }).from(users);
		return row?.value ?? 0;
	},

	async isUsernameTaken(username: string): Promise<boolean> {
		const existing = await db.query.users.findFirst({
			where: eq(users.username, username),
			columns: { id: true },
		});
		return existing !== undefined;
	},

	async createAccount(draft: RegistrationAccountDraft): Promise<RegistrationAccountResult> {
		// No `await` inside — see the header. The `async` keyword here only shapes the
		// return value for the caller; the transaction has already committed (or rolled
		// back) by the time this Promise resolves.
		return db.transaction((tx) => createAccountAtomically(tx, draft));
	},
};
