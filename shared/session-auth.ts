/**
 * Shared contract between the server auth middleware and the frontend API client
 * for first-party session JWTs.
 *
 * Two problems this solves:
 *  1. Not every 401 means "your session is gone". Second-factor verification
 *     failures, OAuth-only boundaries and consent-page login hints all answer
 *     401 while the caller's session is still perfectly valid. Clearing the
 *     stored token on those responses logs the user out for no reason, so the
 *     client only discards a token when the error code is in
 *     `SESSION_INVALID_ERROR_CODES`.
 *  2. Session JWTs have a fixed lifetime and no refresh token, so an active user
 *     was forced to re-login every time the window elapsed. The server now
 *     re-signs a token when it is close to expiry and returns it in
 *     `SESSION_RENEWAL_HEADER`; the client swaps it in transparently.
 */

/**
 * Error codes that mean the presented session credential itself is no longer
 * usable. Only these justify dropping the locally stored token.
 */
export const SESSION_INVALID_ERROR_CODES = [
	// Session JWT expired past its lifetime.
	"TOKEN_EXPIRED",
	// Missing/invalid Authorization header, unverifiable token, or the user row
	// backing the token no longer exists.
	"UNAUTHORIZED",
	// A session JWT was required but the request presented an OAuth access token,
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

/** Response header carrying a re-signed session JWT for sliding renewal. */
export const SESSION_RENEWAL_HEADER = "X-NarraFork-Session-Token";

/** Total lifetime of a session JWT. */
export const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Renew a session JWT once its remaining lifetime drops below this threshold.
 * At 3 days against a 7-day TTL, any user who touches the app at least once a
 * week keeps a valid session indefinitely, while an abandoned session still
 * expires within the original window.
 */
export const SESSION_RENEWAL_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;

/**
 * Absolute ceiling on a renewal chain, measured from the original login instant
 * recorded in `SESSION_START_CLAIM`.
 *
 * Sliding renewal alone turns a 7-day JWT into an unbounded bearer credential:
 * any request inside the renewal window mints a new token, so a stolen token
 * stays alive forever as long as it is touched occasionally. This ceiling caps
 * the whole chain — after 30 days the user must authenticate again, no matter
 * how active the session was.
 */
export const ABSOLUTE_SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;

/**
 * Claim carrying the session-start time (unix seconds) of the original login.
 * It is copied verbatim into every renewed token and must never be reset by a
 * renewal, otherwise the absolute ceiling below could be slid forward forever.
 */
export const SESSION_START_CLAIM = "sst";

/** Whether a token with this `exp` (unix seconds) should be re-issued now. */
export function shouldRenewSessionToken(exp: number, nowSeconds: number): boolean {
	if (!Number.isFinite(exp) || exp <= 0) return false;
	const remaining = exp - nowSeconds;
	// Already expired tokens never reach this point (verification rejects them),
	// and a token whose remaining life exceeds the threshold needs nothing.
	return remaining > 0 && remaining < SESSION_RENEWAL_THRESHOLD_SECONDS;
}

/**
 * Resolve the session-start anchor to use when renewing a token.
 *
 * Tokens issued before the absolute ceiling existed carry no `sst`. Rejecting
 * them outright would log every current user out on deploy, so a missing anchor
 * is treated as "the ceiling starts now": such a session gets at most one more
 * full 30-day window instead of an immediate logout. The trade-off is that a
 * token stolen before this change can still be extended for one final window —
 * acceptable because the alternative is a forced mass re-login, and every token
 * minted from here on is anchored.
 */
export function resolveSessionStart(sessionStart: unknown, nowSeconds: number): number {
	return typeof sessionStart === "number" &&
		Number.isFinite(sessionStart) &&
		sessionStart > 0 &&
		sessionStart <= nowSeconds
		? sessionStart
		: nowSeconds;
}

/** Whether the renewal chain anchored at `sessionStart` is still inside the ceiling. */
export function isWithinAbsoluteSessionLimit(sessionStart: number, nowSeconds: number): boolean {
	return nowSeconds - sessionStart < ABSOLUTE_SESSION_MAX_SECONDS;
}
