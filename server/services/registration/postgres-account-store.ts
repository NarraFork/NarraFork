/**
 * PostgreSQL implementation of `RegistrationAccountStore`.
 *
 * Same capability as `sqlite-account-store.ts`, different engine — and deliberately NOT
 * the same code: what the two implementations share is the port
 * (`account-store.ts`), the redemption rules (`invitation-rules.ts`) and the hashing rule
 * (`code-hash.ts`). Everything dialect-shaped lives here: the PG schema, a genuinely async
 * transaction, whole-section retry, and conflict translation.
 *
 * HOW EACH REQUIREMENT OF THE PORT IS MET
 * ---------------------------------------
 * - PROMISE boundary: every method is honestly async against a networked driver. An
 *   `await` between BEGIN and COMMIT is safe here, which is exactly what the write-port
 *   base (`server/db/backend/write-port.ts`) contrasts with the SQLite implementation's
 *   strictly synchronous section.
 * - ATOMICITY: the whole "resolve invitation → insert account → insert preferences →
 *   burn invitation" section runs in one `db.transaction`. Any rejection rolls all of it
 *   back: no account, no preferences row, and the invitation is still usable.
 * - RETRY: `withPgRetry` wraps the WHOLE section (BEGIN through COMMIT), never a single
 *   statement. The section is idempotent under whole-section replay — the account id
 *   comes from the caller's draft, so a replay writes the same rows, and a replay that
 *   finds them already written surfaces as a conflict instead of duplicating anything.
 * - CONFLICTS AS VOCABULARY: SQLSTATE 23505 is translated to `WriteConflictError` (with
 *   the constraint name the server reported) before it can cross the port boundary.
 *   `withPgRetry` classifies that as a unique-violation and never retries it into a
 *   false success; the registration caller decides what "already exists" means.
 *
 * THE CLAIM IS A GUARDED WRITE, NOT A CHECK-THEN-WRITE
 * ----------------------------------------------------
 * Redemption is split into resolve + claim because `used_by_user_id` has a foreign key
 * to `users`, so the claim can only run once the account row exists (same ordering as
 * the SQLite side). The resolve SELECT learns the role and rejects unusable codes; it is
 * NOT what makes redemption safe under concurrency. Safety comes from the claim being a
 * single conditional UPDATE (`… WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`):
 * two concurrent sections that both resolved the same unused code serialize on the row
 * lock, the loser re-evaluates the guard against the winner's committed row and updates
 * zero rows, and zero rows is rejected as `CODE_ALREADY_USED` — the same answer the
 * SQLite implementation gives. A design that trusted the resolve SELECT to decide
 * whether to write would burn one code for two accounts.
 */

import { WriteConflictError } from "@server/db/backend/write-port";
import { isPgUniqueViolation } from "@server/db/pg-errors";
import { withPgRetry } from "@server/db/pg-retry";
import { registrationCodes, userPreferences, users } from "@server/db/postgres-schema";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import { and, count, eq, isNull } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type {
	RegistrationAccountDraft,
	RegistrationAccountResult,
	RegistrationAccountStore,
} from "./account-store";
import { hashInvitationCode } from "./code-hash";
import { assertInvitationRedeemable, type InvitationState } from "./invitation-rules";

/** Transaction handle as produced by `db.transaction(async (tx) => …)`. PG-side only. */
type PgTransaction = Parameters<Parameters<BunSQLDatabase["transaction"]>[0]>[0];

/** How deep `cause` chains are followed when looking for the driver error's detail. */
const MAX_CAUSE_DEPTH = 8;

/**
 * The constraint name the server attached to a unique violation, when it reported one.
 *
 * Bun SQL surfaces it as `PostgresError.constraint` (see `bun-types/sql.d.ts`); Drizzle
 * may wrap the driver error under `cause`, so the chain is walked with the same bound
 * `pg-errors.ts` uses. "Which fact already exists" is the caller's decision input —
 * a conflict on `users_username_unique` and one on `user_preferences_user_id_unique`
 * are not the same event.
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
 *
 * The translation happens HERE, at the port boundary, so the caller never recognizes a
 * driver error shape. `WriteConflictError` carries the original error as `cause`, which
 * keeps the SQLSTATE reachable for classification — `withPgRetry` sees a
 * unique-violation, not a retryable failure — while the port's own vocabulary is what
 * the caller switches on.
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

/** The invitation row, mapped to the plain-data shape the redemption rules decide over. */
async function findInvitation(tx: PgTransaction, code: string): Promise<InvitationState | null> {
	const rows = await tx
		.select({
			id: registrationCodes.id,
			role: registrationCodes.role,
			boundUsername: registrationCodes.boundUsername,
			expiresAt: registrationCodes.expiresAt,
			usedAt: registrationCodes.usedAt,
			revokedAt: registrationCodes.revokedAt,
		})
		.from(registrationCodes)
		.where(eq(registrationCodes.codeHash, hashInvitationCode(code)))
		.limit(1);
	const row = rows[0];
	if (!row) return null;
	// `role` is text in the schema; the issuance path only ever writes the two role names,
	// and the rules module's return type is where the narrowing is stated.
	return { ...row, role: row.role === "admin" ? "admin" : "user" };
}

/**
 * The whole atomic section, extracted so it is one readable unit — the piece
 * `withPgRetry` must be able to replay WHOLE, and the piece that must stay free of any
 * side effect that is not a database write (broadcasts and notifications belong after
 * the retry boundary resolves, never inside it).
 */
async function createAccountSection(
	tx: PgTransaction,
	draft: RegistrationAccountDraft,
): Promise<RegistrationAccountResult> {
	const invitation = draft.invitationCode
		? assertInvitationRedeemable(await findInvitation(tx, draft.invitationCode), {
				username: draft.username,
				nowIso: draft.nowIso,
			})
		: null;

	let account: RegistrationAccountResult["account"];
	try {
		const [inserted] = await tx
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
			});
		if (!inserted) throw new Error("account insert returned no row");
		account = {
			...inserted,
			role: inserted.role === "admin" ? "admin" : "user",
		};
		await tx.insert(userPreferences).values({
			id: generateId(),
			userId: account.id,
			language: draft.language,
			createdAt: draft.nowIso,
			updatedAt: draft.nowIso,
		});
	} catch (error) {
		rethrowAsPortError(error);
	}

	// After the account row exists: the claim writes a foreign key to it. The guard is
	// re-checked BY THE UPDATE ITSELF — see the header for why the resolve above cannot
	// carry that responsibility under concurrency.
	if (invitation) {
		const claimed = await tx
			.update(registrationCodes)
			.set({ usedAt: draft.nowIso, usedByUserId: account.id })
			.where(
				and(
					eq(registrationCodes.id, invitation.id),
					isNull(registrationCodes.usedAt),
					isNull(registrationCodes.revokedAt),
				),
			)
			.returning({ id: registrationCodes.id });
		if (claimed.length === 0) {
			throw new AppError("This registration code has already been used", 409, "CODE_ALREADY_USED");
		}
	}

	return { account, redeemedCodeId: invitation?.id ?? null };
}

/**
 * Build the store over a caller-supplied handle. The factory takes the database rather
 * than opening one: who owns the connection (and its lifecycle) is a composition-root
 * decision, and tests supply a handle pointed at a throwaway container.
 */
export function createPostgresRegistrationAccountStore(
	db: BunSQLDatabase,
): RegistrationAccountStore {
	return {
		async countAccounts(): Promise<number> {
			return withPgRetry(
				async () => {
					const rows = await db.select({ value: count() }).from(users);
					return Number(rows[0]?.value ?? 0);
				},
				{ label: "registration.countAccounts" },
			);
		},

		async isUsernameTaken(username: string): Promise<boolean> {
			return withPgRetry(
				async () => {
					const rows = await db
						.select({ id: users.id })
						.from(users)
						.where(eq(users.username, username))
						.limit(1);
					return rows.length > 0;
				},
				{ label: "registration.isUsernameTaken" },
			);
		},

		async createAccount(draft: RegistrationAccountDraft): Promise<RegistrationAccountResult> {
			// The retry unit is the whole section — BEGIN through COMMIT. It is idempotent
			// under replay: the account id comes from the draft, so a replay after a commit
			// whose acknowledgement was lost surfaces as a conflict rather than a duplicate.
			return withPgRetry(() => db.transaction((tx) => createAccountSection(tx, draft)), {
				label: "registration.createAccount",
			});
		},
	};
}
