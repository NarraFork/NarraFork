/**
 * TOTP (Time-based One-Time Password) helpers — thin wrapper around `otpauth`.
 *
 * Used for two-factor authentication. A user enrolls an authenticator app by
 * scanning the otpauth:// URI (rendered as a QR code), then proves possession
 * by entering a 6-digit code. Secrets are stored base32-encoded in `user_totp`.
 */
import { Secret, TOTP } from "otpauth";

/** Issuer label shown in authenticator apps. */
const ISSUER = "NarraFork";
/** Standard TOTP parameters (compatible with Google Authenticator, 1Password, etc.). */
const ALGORITHM = "SHA1";
const DIGITS = 6;
const PERIOD = 30;
/**
 * Acceptable clock-drift window, in steps of `PERIOD` seconds, on each side.
 * window=1 → accept the current code plus the immediately previous/next step
 * (±30s), tolerating modest clock skew without materially weakening security.
 */
const VALIDATE_WINDOW = 1;

/** Generate a fresh random base32 TOTP secret (160-bit, RFC 4226 recommended). */
export function generateTotpSecret(): string {
	return new Secret({ size: 20 }).base32;
}

function buildTotp(secretBase32: string, accountLabel: string): TOTP {
	return new TOTP({
		issuer: ISSUER,
		label: accountLabel,
		algorithm: ALGORITHM,
		digits: DIGITS,
		period: PERIOD,
		secret: Secret.fromBase32(secretBase32),
	});
}

/**
 * Build the otpauth:// URI for enrollment. The frontend renders this as a QR
 * code; the plaintext secret is also shown for manual entry.
 */
export function buildTotpUri(secretBase32: string, accountLabel: string): string {
	return buildTotp(secretBase32, accountLabel).toString();
}

/**
 * Verify a user-supplied 6-digit code against the stored secret.
 * Returns true when the code matches within the allowed drift window.
 * Non-numeric / wrong-length input is rejected without touching the validator.
 */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
	const normalized = code.replace(/\s/g, "");
	if (!/^\d{6}$/.test(normalized)) return false;
	try {
		const delta = buildTotp(secretBase32, ISSUER).validate({
			token: normalized,
			window: VALIDATE_WINDOW,
		});
		return delta !== null;
	} catch {
		return false;
	}
}
