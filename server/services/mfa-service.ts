/**
 * MFA service — all database-backed TOTP and backup-code operations.
 *
 * Tables (behind `AuthMfaStore`, so the service itself names none of them):
 * - `user_totp`           : one row per user; pending during enrollment,
 *                           active once a code confirms the authenticator.
 * - `user_mfa_backup_codes`: one-time recovery codes (bcrypt-hashed).
 *
 * The plaintext backup codes are returned exactly once, at activation time.
 * Afterwards only their hashes are stored and they can never be retrieved.
 *
 * Storage goes through `authMfaStore` (`services/auth/store.ts`): this module holds no
 * transaction handle and no dialect, so a second backend implements the same capability
 * rather than reproducing SQLite's transaction shape. CPU work that must stay outside
 * any atomic section — bcrypt hashing of new backup codes, TOTP code verification —
 * stays here, and the store's atomic sections contain database writes only.
 */
import { randomInt } from "node:crypto";
import { generateId } from "@server/lib/id";
import { generateTotpSecret, verifyTotpCode } from "@server/lib/totp";
import { authMfaStore as store } from "./auth/store";

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
		return (await store.findTotp(userId, "active")) !== null;
	},

	/** Whether the user has opted into requiring a second factor at login. */
	async isMfaEnabled(userId: string): Promise<boolean> {
		return await store.findMfaEnabled(userId);
	},

	/** Set the login-time second-factor requirement flag. */
	async setMfaEnabled(userId: string, enabled: boolean): Promise<void> {
		await store.setMfaEnabled(userId, enabled);
	},

	/** Whether the user has at least one enrolled passkey (a usable second factor). */
	async hasAnyPasskey(userId: string): Promise<boolean> {
		return await store.hasAnyPasskey(userId);
	},

	/**
	 * Whether the user currently has any usable second factor enrolled (an active
	 * TOTP authenticator or at least one passkey). Enforcing MFA without a factor
	 * would lock the user out, so this gates enabling the switch.
	 */
	async hasAnyFactor(userId: string): Promise<boolean> {
		const [totp, passkey] = await Promise.all([
			store.findTotp(userId, "active"),
			store.hasAnyPasskey(userId),
		]);
		return totp !== null || passkey;
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
		const mfaEnabled = await store.findMfaEnabled(userId);
		const totp = await store.findTotp(userId, "active");
		if (!totp) {
			return { mfaEnabled, totpEnabled: false, backupCodesRemaining: 0 };
		}
		return {
			mfaEnabled,
			totpEnabled: true,
			backupCodesRemaining: await store.countUnusedBackupCodes(userId),
		};
	},

	/**
	 * Begin TOTP enrollment: generate a fresh secret and store it as `pending`,
	 * replacing any previous pending row. Returns the base32 secret so the
	 * caller can build the otpauth URI + QR code. Does nothing if TOTP is
	 * already active.
	 */
	async beginSetup(userId: string): Promise<{ secret: string } | { alreadyActive: true }> {
		const secret = generateTotpSecret();
		// The active-enrollment check and the pending-secret write are one atomic
		// decision inside the store: an active factor is never silently replaced.
		const outcome = await store.savePendingTotp({
			id: generateId(),
			userId,
			secret,
			nowIso: new Date().toISOString(),
		});
		if (outcome === "alreadyActive") return { alreadyActive: true };
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
		const pending = await store.findTotp(userId, "pending");
		if (!pending) return { ok: false };
		// Code verification is CPU work, deliberately outside any atomic section.
		if (!verifyTotpCode(pending.secret, code)) return { ok: false };

		await store.activateTotp(userId, new Date().toISOString());

		const backupCodes = await this.regenerateBackupCodes(userId);
		return { ok: true, backupCodes };
	},

	/** Replace all backup codes with a fresh batch; returns plaintext codes. */
	async regenerateBackupCodes(userId: string): Promise<string[]> {
		const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode);
		const now = new Date().toISOString();
		// Hashing is deliberately outside the atomic section: it is ~100ms of CPU per
		// code, and holding a transaction open across it would serialize unrelated
		// writes for no benefit.
		const rows = await Promise.all(
			codes.map(async (code) => ({
				id: generateId(),
				codeHash: await Bun.password.hash(normalizeBackupCode(code), {
					algorithm: "bcrypt",
					cost: BCRYPT_COST,
				}),
				createdAt: now,
			})),
		);
		await store.replaceBackupCodes(userId, rows);
		return codes;
	},

	/** Verify a TOTP code against the user's ACTIVE secret. */
	async verifyTotp(userId: string, code: string): Promise<boolean> {
		const enrollment = await store.findTotp(userId, "active");
		if (!enrollment) return false;
		return verifyTotpCode(enrollment.secret, code);
	},

	/**
	 * Verify and CONSUME a backup code. Each code is single-use: on a match its
	 * `usedAt` is stamped and true is returned. Returns false if no unused code
	 * matches.
	 */
	async consumeBackupCode(userId: string, code: string): Promise<boolean> {
		const normalized = normalizeBackupCode(code);
		const unused = await store.findUnusedBackupCodes(userId);
		for (const row of unused) {
			// The bcrypt comparison picks the row OUTSIDE any atomic section; the
			// consumption itself is the store's guarded update, which a concurrent
			// redemption of the same code cannot also win.
			if (await Bun.password.verify(normalized, row.codeHash)) {
				if (await store.markBackupCodeUsed(row.id, new Date().toISOString())) return true;
			}
		}
		return false;
	},

	/** Fully disable TOTP and remove all backup codes. */
	async disable(userId: string): Promise<void> {
		await store.clearFactors(userId);
	},
};
