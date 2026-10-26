/**
 * Shared contract between the server auth middleware and the frontend API client
 * for first-party session tokens.
 *
 * Session tokens are opaque random strings prefixed with `SESSION_TOKEN_PREFIX`. The
 * server stores only their SHA-256 in `auth_sessions`, so a session cannot be forged
 * from any instance secret, and a single session can be revoked on its own. The token
 * never changes during a session: renewal slides its expiry server-side.
 *
 * Not every 401 means "your session is gone". Second-factor verification failures,
 * OAuth-only boundaries and consent-page login hints all answer 401 while the caller's
 * session is still perfectly valid. Clearing the stored token on those responses logs
 * the user out for no reason, so the client only discards a token when the error code
 * is in `SESSION_INVALID_ERROR_CODES`.
 */

/** Prefix that marks a first-party opaque session token. */
export const SESSION_TOKEN_PREFIX = "nfs_";

/** Whether a bearer string is an opaque first-party session token (by shape only). */
export function isOpaqueSessionToken(token: string): boolean {
	return token.startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * Error codes that mean the presented session credential itself is no longer
 * usable. Only these justify dropping the locally stored token.
 */
export const SESSION_INVALID_ERROR_CODES = [
	// Session expired past its lifetime, or was revoked.
	"TOKEN_EXPIRED",
	// Missing/invalid Authorization header, unverifiable token, or the user row
	// backing the token no longer exists.
	"UNAUTHORIZED",
	// A session token was required but the request presented an OAuth access token,
	// so no usable first-party session exists for this client.
	"SESSION_REQUIRED",
] as const;

export type SessionInvalidErrorCode = (typeof SESSION_INVALID_ERROR_CODES)[number];

const SESSION_INVALID_ERROR_CODE_SET: ReadonlySet<string> = new Set(SESSION_INVALID_ERROR_CODES);

/**
 * Whether a 401 response body indicates the stored session token is dead.
 *
 * A 401 without a recognizable `code` is treated as session loss: legacy routes
 * and non-JSON gateway responses (e.g. a reverse proxy rejecting the request)
 * carry no code, and for those the safest reading of 401 is still "not
 * authenticated". Codes we do recognize but that are not session failures
 * (`MFA_CODE_INVALID`, `PASSKEY_AUTH_FAILED`, `OAUTH_REQUIRED`, …) keep the
 * session intact.
 */
export function isSessionInvalidResponse(
	data: Record<string, unknown> | null | undefined,
): boolean {
	const code = data?.code;
	if (typeof code !== "string" || !code.trim()) return true;
	return SESSION_INVALID_ERROR_CODE_SET.has(code);
}

/** Lifetime of a session without activity. */
export const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Extend a session once its remaining lifetime drops below this threshold.
 * At 3 days against a 7-day TTL, any user who touches the app at least once a
 * week keeps a valid session, while an abandoned session still expires within
 * the original window. Extending only inside the window keeps ordinary requests
 * from writing anything.
 */
export const SESSION_RENEWAL_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

/**
 * Absolute ceiling on a session, measured from the original login instant.
 *
 * Sliding renewal alone turns a 7-day session into an unbounded bearer credential:
 * any request inside the renewal window extends it, so a stolen token stays alive
 * forever as long as it is touched occasionally. This ceiling caps the whole
 * session — after 30 days the user must authenticate again, no matter how active
 * the session was.
 */
export const ABSOLUTE_SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;

/** Whether a session expiring at `exp` (unix seconds) should be extended now. */
export function shouldRenewSessionToken(exp: number, nowSeconds: number): boolean {
	if (!Number.isFinite(exp) || exp <= 0) return false;
	const remaining = exp - nowSeconds;
	// Already expired sessions never reach this point (verification rejects them),
	// and a session whose remaining life exceeds the threshold needs nothing.
	return remaining > 0 && remaining < SESSION_RENEWAL_THRESHOLD_SECONDS;
}
