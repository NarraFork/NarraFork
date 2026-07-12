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
import { userMfaBackupCodes, userPasskeys, users, userTotp } from "@server/db/schema";
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
	/** Whether a second factor is REQUIRED at login (the explicit opt-in switch). */
	mfaEnabled: boolean;
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

	/** Whether the user has opted into requiring a second factor at login. */
	async isMfaEnabled(userId: string): Promise<boolean> {
		const row = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { mfaEnabled: true },
		});
		return !!row?.mfaEnabled;
	},

	/** Set the login-time second-factor requirement flag. */
	async setMfaEnabled(userId: string, enabled: boolean): Promise<void> {
		await db.update(users).set({ mfaEnabled: enabled }).where(eq(users.id, userId));
	},

	/**
	 * Whether the user currently has any usable second factor enrolled (an active
	 * TOTP authenticator or at least one passkey). Enforcing MFA without a factor
	 * would lock the user out, so this gates enabling the switch.
	 */
	async hasAnyFactor(userId: string): Promise<boolean> {
		const [totp, passkey] = await Promise.all([
			db.query.userTotp.findFirst({
				where: and(eq(userTotp.userId, userId), eq(userTotp.status, "active")),
				columns: { id: true },
			}),
			db.query.userPasskeys.findFirst({
				where: eq(userPasskeys.userId, userId),
				columns: { id: true },
			}),
		]);
		return !!totp || !!passkey;
	},

	/**
	 * Turn the MFA requirement off automatically when the user no longer has any
	 * usable second factor (e.g. after disabling TOTP and deleting all passkeys).
	 * This prevents an "MFA required but no factor available" lockout. Returns
	 * true when the flag was changed.
	 */
	async syncMfaEnabledAfterFactorChange(userId: string): Promise<boolean> {
		const enabled = await this.isMfaEnabled(userId);
		if (!enabled) return false;
		if (await this.hasAnyFactor(userId)) return false;
		await this.setMfaEnabled(userId, false);
		return true;
	},

	/** Full MFA status for the security settings page. */
	async getStatus(userId: string): Promise<MfaStatus> {
		const user = await db.query.users.findFirst({
			where: eq(users.id, userId),
			columns: { mfaEnabled: true },
		});
		const mfaEnabled = !!user?.mfaEnabled;
		const totp = await db.query.userTotp.findFirst({
			where: and(eq(userTotp.userId, userId), eq(userTotp.status, "active")),
			columns: { id: true },
		});
		if (!totp) {
			return { mfaEnabled, totpEnabled: false, backupCodesRemaining: 0 };
		}
		const unused = await db.query.userMfaBackupCodes.findMany({
			where: and(eq(userMfaBackupCodes.userId, userId), isNull(userMfaBackupCodes.usedAt)),
			columns: { id: true },
		});
		return { mfaEnabled, totpEnabled: true, backupCodesRemaining: unused.length };
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
		db.transaction((tx) => {
			tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId)).run();
			tx.insert(userMfaBackupCodes).values(rows).run();
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
				const consumed = await db
					.update(userMfaBackupCodes)
					.set({ usedAt: new Date().toISOString() })
					.where(and(eq(userMfaBackupCodes.id, row.id), isNull(userMfaBackupCodes.usedAt)))
					.returning({ id: userMfaBackupCodes.id })
					.get();
				if (consumed) return true;
			}
		}
		return false;
	},

	/** Fully disable TOTP and remove all backup codes. */
	async disable(userId: string): Promise<void> {
		db.transaction((tx) => {
			tx.delete(userTotp).where(eq(userTotp.userId, userId)).run();
			tx.delete(userMfaBackupCodes).where(eq(userMfaBackupCodes.userId, userId)).run();
		});
	},
};
