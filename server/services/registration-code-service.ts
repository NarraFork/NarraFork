/**
 * Registration codes — single-use invitations issued by an administrator.
 *
 * These exist so an instance can keep public registration closed and still let a
 * specific person create their own account (choosing their own password, which an
 * admin-created account cannot offer).
 *
 * Two properties are load-bearing:
 *  - Only the SHA-256 hash is persisted. The plaintext is returned exactly once,
 *    by `createCode`, and never appears in list output or logs. A database read
 *    therefore cannot be turned back into a usable invitation.
 *  - Redemption is a conditional UPDATE inside the caller's transaction, so two
 *    concurrent registrations with the same code cannot both succeed, and a code
 *    is never consumed by a registration that later rolls back.
 */
import { createHash } from "node:crypto";
import { db } from "@server/db";
import { registrationCodes, users } from "@server/db/schema";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import {
	assertInvitationRedeemable,
	type RedeemableInvitation,
} from "@server/services/registration/invitation-rules";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";

/** Transaction handle as produced by `db.transaction((tx) => ...)`. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Prefix so a leaked string is recognisable as a NarraFork invitation. */
const CODE_PREFIX = "nfrc_";
/** 24 nanoid chars ≈ 143 bits — not guessable, and short enough to paste. */
const CODE_BODY_LENGTH = 24;

const DEFAULT_EXPIRY_HOURS = 24 * 7;
const HOUR_MS = 60 * 60 * 1000;

export type RegistrationCodeStatus = "active" | "used" | "revoked" | "expired";

export interface RegistrationCodeSummary {
	id: string;
	note: string | null;
	role: "admin" | "user";
	boundUsername: string | null;
	expiresAt: string;
	usedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
	createdByUsername: string | null;
	usedByUsername: string | null;
	status: RegistrationCodeStatus;
}

export interface CreateRegistrationCodeInput {
	note?: string;
	role?: "admin" | "user";
	/** Restrict the code to one username. Omit to let the recipient choose. */
	boundUsername?: string;
	expiresInHours?: number;
	createdByUserId: string;
}

/** Generate a fresh plaintext code. */
export function generateRegistrationCode(): string {
	return `${CODE_PREFIX}${generateId(CODE_BODY_LENGTH)}`;
}

/**
 * Hash a code for storage/lookup.
 *
 * A plain SHA-256 (no salt, no KDF) is deliberate: the code is a 143-bit random
 * value, not a human-chosen password, so there is nothing to brute-force and the
 * hash must stay deterministic to serve as a unique index for lookup.
 */
export function hashRegistrationCode(code: string): string {
	return createHash("sha256").update(code.trim()).digest("hex");
}

function statusOf(
	row: {
		usedAt: string | null;
		revokedAt: string | null;
		expiresAt: string;
	},
	nowMs: number,
): RegistrationCodeStatus {
	if (row.usedAt) return "used";
	if (row.revokedAt) return "revoked";
	if (Date.parse(row.expiresAt) <= nowMs) return "expired";
	return "active";
}

/** Bound on the admin list: an instance that needs more than this has a process problem. */
const LIST_LIMIT = 500;

const SUMMARY_COLUMNS = {
	id: registrationCodes.id,
	note: registrationCodes.note,
	role: registrationCodes.role,
	boundUsername: registrationCodes.boundUsername,
	expiresAt: registrationCodes.expiresAt,
	usedAt: registrationCodes.usedAt,
	revokedAt: registrationCodes.revokedAt,
	createdAt: registrationCodes.createdAt,
	createdByUserId: registrationCodes.createdByUserId,
	usedByUserId: registrationCodes.usedByUserId,
} as const;

type SummaryRow = {
	id: string;
	note: string | null;
	role: "admin" | "user";
	boundUsername: string | null;
	expiresAt: string;
	usedAt: string | null;
	revokedAt: string | null;
	createdAt: string;
	createdByUserId: string | null;
	usedByUserId: string | null;
};

/** Resolve creator/redeemer usernames in one bounded query and derive status. */
async function toSummaries(rows: SummaryRow[]): Promise<RegistrationCodeSummary[]> {
	const referencedIds = new Set<string>();
	for (const row of rows) {
		if (row.createdByUserId) referencedIds.add(row.createdByUserId);
		if (row.usedByUserId) referencedIds.add(row.usedByUserId);
	}
	const usernames = new Map<string, string>();
	if (referencedIds.size > 0) {
		const userRows = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(inArray(users.id, [...referencedIds]));
		for (const user of userRows) usernames.set(user.id, user.username);
	}

	const nowMs = Date.now();
	return rows.map((row) => ({
		id: row.id,
		note: row.note,
		role: row.role,
		boundUsername: row.boundUsername,
		expiresAt: row.expiresAt,
		usedAt: row.usedAt,
		revokedAt: row.revokedAt,
		createdAt: row.createdAt,
		createdByUsername: row.createdByUserId ? (usernames.get(row.createdByUserId) ?? null) : null,
		usedByUsername: row.usedByUserId ? (usernames.get(row.usedByUserId) ?? null) : null,
		status: statusOf(row, nowMs),
	}));
}

export const registrationCodeService = {
	/**
	 * Issue a code. The returned `code` is the only time the plaintext exists —
	 * callers must hand it to the administrator and not persist or log it.
	 */
	async createCode(
		input: CreateRegistrationCodeInput,
	): Promise<{ code: string; summary: RegistrationCodeSummary }> {
		const code = generateRegistrationCode();
		const now = new Date();
		const hours = input.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
		const row = {
			id: generateId(),
			codeHash: hashRegistrationCode(code),
			note: input.note?.trim() || null,
			role: input.role ?? ("user" as const),
			boundUsername: input.boundUsername?.trim() || null,
			expiresAt: new Date(now.getTime() + hours * HOUR_MS).toISOString(),
			createdByUserId: input.createdByUserId,
			usedAt: null,
			usedByUserId: null,
			revokedAt: null,
			createdAt: now.toISOString(),
		};
		await db.insert(registrationCodes).values(row);

		const creator = await db.query.users.findFirst({
			where: eq(users.id, input.createdByUserId),
			columns: { username: true },
		});

		return {
			code,
			summary: {
				id: row.id,
				note: row.note,
				role: row.role,
				boundUsername: row.boundUsername,
				expiresAt: row.expiresAt,
				usedAt: null,
				revokedAt: null,
				createdAt: row.createdAt,
				createdByUsername: creator?.username ?? null,
				usedByUsername: null,
				status: statusOf(row, now.getTime()),
			},
		};
	},

	/**
	 * List codes for the admin UI, newest first.
	 *
	 * `codeHash` is intentionally absent from the projection: the hash is not a
	 * usable credential, but publishing it would let anyone holding the list
	 * confirm a guessed code offline. There is no reason for it to leave the server.
	 */
	async listCodes(): Promise<RegistrationCodeSummary[]> {
		const rows = await db
			.select(SUMMARY_COLUMNS)
			.from(registrationCodes)
			.orderBy(desc(registrationCodes.createdAt))
			.limit(LIST_LIMIT);
		return toSummaries(rows);
	},

	/**
	 * Revoke an unused code.
	 *
	 * A redeemed code cannot be revoked: the account it created already exists, so
	 * pretending otherwise would misrepresent the audit trail. Deleting the account
	 * is the operation for that case.
	 */
	async revokeCode(id: string): Promise<RegistrationCodeSummary> {
		const existing = await db.query.registrationCodes.findFirst({
			where: eq(registrationCodes.id, id),
		});
		if (!existing) throw new AppError("Registration code not found", 404, "NOT_FOUND");
		if (existing.usedAt) {
			throw new AppError("This code has already been used", 409, "CODE_ALREADY_USED");
		}
		if (!existing.revokedAt) {
			await db
				.update(registrationCodes)
				.set({ revokedAt: new Date().toISOString() })
				.where(eq(registrationCodes.id, id));
		}
		const [row] = await db
			.select(SUMMARY_COLUMNS)
			.from(registrationCodes)
			.where(eq(registrationCodes.id, id));
		if (!row) throw new AppError("Registration code not found", 404, "NOT_FOUND");
		const [summary] = await toSummaries([row]);
		return summary;
	},

	/** Permanently remove a code row (any status) — audit-log housekeeping. */
	async deleteCode(id: string): Promise<void> {
		const [deleted] = await db
			.delete(registrationCodes)
			.where(eq(registrationCodes.id, id))
			.returning({ id: registrationCodes.id });
		if (!deleted) throw new AppError("Registration code not found", 404, "NOT_FOUND");
	},

	/**
	 * Validate a code and report the role it grants, without consuming it.
	 *
	 * Redemption is split into resolve + claim because `used_by_user_id` has a
	 * foreign key to `users`, which SQLite checks immediately: the claim can only
	 * run once the account row exists. The caller therefore resolves first (to learn
	 * the role it must insert the user with), inserts, then claims — all inside one
	 * transaction, so any failure rolls back both.
	 */
	resolveUsableCodeInTransaction(
		tx: DbTransaction,
		params: { code: string; username: string; nowIso: string },
	): RedeemableInvitation {
		const hash = hashRegistrationCode(params.code);
		const row = tx.query.registrationCodes
			.findFirst({ where: eq(registrationCodes.codeHash, hash) })
			.sync();
		// The lookup is SQLite's job; deciding whether the invitation may be used is not.
		// `assertInvitationRedeemable` holds the rules and their error identities so a second
		// backend storing invitations elsewhere answers identically instead of re-deriving
		// the precedence between revoked/used/expired.
		return assertInvitationRedeemable(row ?? null, params);
	},

	/**
	 * Mark a resolved code as used by a freshly created account.
	 *
	 * The UPDATE re-checks `used_at IS NULL AND revoked_at IS NULL` instead of
	 * trusting the earlier resolve. Two requests can read the same unused row before
	 * either writes; the guarded update means only one of them changes a row, and the
	 * loser is rejected as already-used (rolling back its account insert).
	 */
	claimCodeInTransaction(
		tx: DbTransaction,
		params: { codeId: string; userId: string; nowIso: string },
	): void {
		const claimed = tx
			.update(registrationCodes)
			.set({ usedAt: params.nowIso, usedByUserId: params.userId })
			.where(
				and(
					eq(registrationCodes.id, params.codeId),
					isNull(registrationCodes.usedAt),
					isNull(registrationCodes.revokedAt),
				),
			)
			.returning({ id: registrationCodes.id })
			.all();
		if (claimed.length === 0) {
			throw new AppError("This registration code has already been used", 409, "CODE_ALREADY_USED");
		}
	},
};
