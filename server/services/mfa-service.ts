/**
 * MFA service — all database-backed TOTP and backup-code operations.
 *
 * Tables:
 * - `user_totp`           : one row per user; pending during enrollment,
 *                           active once a code confirms the authenticator.
 * - `user_mfa_backup_codes`: one-time recovery codes (bcrypt-hashed).
 *
 * The plaintext backup codes are returned exactly once, at activation time.
 * Afterwards only their hashes are stored and they can never be retrieved.
 */
import { randomInt } from "node:crypto";
import { db } from "@server/db";
import { userMfaBackupCodes, userTotp } from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { generateTotpSecret, verifyTotpCode } from "@server/lib/totp";
import { and, eq, isNull } from "drizzle-orm";

/** Number of one-time backup codes generated on activation. */
const BACKUP_CODE_COUNT = 10;
/** base32-ish alphabet without ambiguous chars (no 0/O/1/I/L). */
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const BACKUP_GROUP_LEN = 4;

const BCRYPT_COST = 10;

/** Normalize a backup code for hashing/compare: drop separators, lowercase. */
function normalizeBackupCode(raw: string): string {
	return raw.replace(/[\s-]/g, "").toLowerCase();
}

function randomBackupCode(): string {
	const pick = () => BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)];
	const group = () => Array.from({ length: BACKUP_GROUP_LEN }, pick).join("");
	return `${group()}-${group()}`;
}

export interface MfaStatus {
	totpEnabled: boolean;
	/** Number of unused backup codes remaining. */
	backupCodesRemaining: number;
}

export const mfaService = {
	/** Whether the user has an ACTIVE TOTP factor (gates the login MFA step). */
	async isTotpActive(userId: string): Promise<boolean> {
		const row = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, "active")),
			columns: { id: true },
		});
		return !!row;
	},

	/** Full MFA status for the security settings page. */
	async getStatus(userId: string): Promise<MfaStatus> {
		const totp = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, "active")),
			columns: { id: true },
		});
		if (!totp) {
			return { totpEnabled: false, backupCodesRemaining: 0 };
		}
		const unused = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
			columns: { id: true },
		});
		return { totpEnabled: true, backupCodesRemaining: unused.length };
	},

	/**
	 * Begin TOTP enrollment: generate a fresh secret and store it as `pending`,
	 * replacing any previous pending row. Returns the base32 secret so the
	 * caller can build the otpauth URI + QR code. Does nothing if TOTP is
	 * already active.
	 */
	async beginSetup(userId: string): Promise<{ secret: string } | { alreadyActive: true }> {
		const existing = await db.query.userTotp.findFirst({
			where: eq(userTotp.userId, userId),
			columns: { id: true, status: true },
		});
		if (existing?.status === "active") {
			return { alreadyActive: true };
		}
		const secret = generateTotpSecret();
		const now = new Date().toISOString();
		if (existing) {
			await db
				.update(userTotp)
				.set({ secret, status: "pending", activatedAt: null, createdAt: now })
				.where(eq(userTotp.userId, userId));
		} else {
			await db.insert(userTotp).values({
				id: generateId(),
				userId,
				secret,
				status: "pending",
				createdAt: now,
			});
		}
		return { secret };
	},

	/**
	 * Confirm enrollment: the submitted code must validate against the pending
	 * secret. On success, mark active and (re)generate one-time backup codes,
	 * returning the plaintext codes for one-time display.
	 */
	async activate(
		userId: string,
		code: string,
	): Promise<{ ok: false } | { ok: true; backupCodes: string[] }> {
		const pending = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, "pending")),
			columns: { secret: true },
		});
		if (!pending) return { ok: false };
		if (!verifyTotpCode(pending.secret, code)) return { ok: false };

		const now = new Date().toISOString();
		await db
			.update(userTotp)
			.set({ status: "active", activatedAt: now })
			.where(eq(userTotp.userId, userId));

		const backupCodes = await this.regenerateBackupCodes(userId);
		return { ok: true, backupCodes };
	},

	/** Replace all backup codes with a fresh batch; returns plaintext codes. */
	async regenerateBackupCodes(userId: string): Promise<string[]> {
		const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode);
		const now = new Date().toISOString();
		const rows = await Promise.all(
			codes.map(async (code) => ({
				id: generateId(),
				userId,
				codeHash: await Bun.password.hash(normalizeBackupCode(code), {
					algorithm: "bcrypt",
					cost: BCRYPT_COST,
				}),
				createdAt: now,
			})),
		);
		await db.transaction(async (tx) => {
			await tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId));
			await tx.insert(userMfaBackupCodes).values(rows);
		});
		return codes;
	},

	/** Verify a TOTP code against the user's ACTIVE secret. */
	async verifyTotp(userId: string, code: string): Promise<boolean> {
		const row = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, "active")),
			columns: { secret: true },
		});
		if (!row) return false;
		return verifyTotpCode(row.secret, code);
	},

	/**
	 * Verify and CONSUME a backup code. Each code is single-use: on a match its
	 * `usedAt` is stamped and true is returned. Returns false if no unused code
	 * matches.
	 */
	async consumeBackupCode(userId: string, code: string): Promise<boolean> {
		const normalized = normalizeBackupCode(code);
		const unused = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
			columns: { id: true, codeHash: true },
		});
		for (const row of unused) {
			if (await Bun.password.verify(normalized, row.codeHash)) {
				await db
					.update(userMfaBackupCodes)
					.set({ usedAt: new Date().toISOString() })
					.where(eq(userMfaBackupCodes.id, row.id));
				return true;
			}
		}
		return false;
	},

	/** Fully disable TOTP and remove all backup codes. */
	async disable(userId: string): Promise<void> {
		await db.transaction(async (tx) => {
			await tx.delete(userTotp).where(eq(userTotp.userId, userId));
			await tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId));
		});
	},
};
