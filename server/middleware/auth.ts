import {
	isSessionTokenVersionCurrent,
	isWithinAbsoluteSessionLimit,
	resolveSessionStart,
	SESSION_RENEWAL_HEADER,
	SESSION_START_CLAIM,
	SESSION_VERSION_CLAIM,
	shouldRenewSessionToken,
} from "@shared/session-auth";
import type { Context, Next } from "hono";
import { JwtTokenExpired } from "hono/utils/jwt/types";
import {
	isAuthenticSessionTokenIgnoringExpiry,
	type JwtPayload,
	renewToken,
	verifyToken,
} from "../lib/auth";
// The two remaining raw AppErrors below are deliberate: `INVALID_SCOPE` is a programming
// error that never reaches a browser, and `INSUFFICIENT_SCOPE` is read by third-party
// OAuth clients rather than rendered in the UI, so neither needs a localized wording.
import { AppError, catalogError } from "../lib/errors";
import { logger } from "../lib/logger";
import { validateAccessToken } from "../lib/oauth-provider";
import { authSessionStore } from "../services/auth/store";

/** OAuth grant metadata attached to requests authenticated by an access token. */
export interface OAuthAuthContext {
	tokenId: string;
	clientId: string;
	oauthClientId: string;
	grantId: string | null;
	refreshFamilyId: string | null;
	expiresAt: string;
	scopes: string[];
}

/** The first-party session principal established by a session JWT. */
export interface SessionAuthPrincipal {
	type: "session";
	user: JwtPayload;
}

/** The external principal established by a NarraFork OAuth access token. */
export interface OAuthAuthPrincipal {
	type: "oauth";
	user: JwtPayload;
	oauth: OAuthAuthContext;
}

export type AuthPrincipal = SessionAuthPrincipal | OAuthAuthPrincipal;

// Extend Hono's context variables for type-safe user access
declare module "hono" {
	interface ContextVariableMap {
		auth: AuthPrincipal;
		user: JwtPayload;
		oauth: OAuthAuthContext;
	}
}

/**
 * Lightweight cache: verified user IDs are remembered for a short window
 * so we don't hit SQLite on every single request.
 */
interface VerifiedUser {
	at: number;
	tokenVersion: number;
}

const verifiedUsers = new Map<string, VerifiedUser>();
const VERIFY_TTL_MS = 60_000; // 1 minute

function getVerifiedUser(userId: string): VerifiedUser | undefined {
	const entry = verifiedUsers.get(userId);
	if (!entry) return undefined;
	if (Date.now() - entry.at > VERIFY_TTL_MS) {
		verifiedUsers.delete(userId);
		return undefined;
	}
	return entry;
}

/**
 * Drop cached existence + token-generation state.
 *
 * MUST be called by anything that bumps `users.token_version`, otherwise the revocation
 * only takes effect once the cache entry ages out (up to `VERIFY_TTL_MS` of continued
 * access for a credential that was supposed to be dead).
 */
export function invalidateUserCache(userId?: string) {
	if (userId) {
		verifiedUsers.delete(userId);
	} else {
		verifiedUsers.clear();
	}
}

function getStoredAuthPrincipal(c: Context): AuthPrincipal | undefined {
	const principal = c.get("auth") as AuthPrincipal | undefined;
	if (principal?.type === "session" || principal?.type === "oauth") return principal;
	return undefined;
}

/**
 * Read the principal established by auth middleware. The legacy `user`/`oauth`
 * variables remain supported for callers that inspect them directly, but the
 * discriminated `auth` value is the source of truth for boundary decisions.
 */
export function getAuthPrincipal(c: Context): AuthPrincipal | undefined {
	const principal = getStoredAuthPrincipal(c);
	if (principal) return principal;

	// Compatibility for middleware tests and older callers that populated the
	// legacy context variables themselves before invoking assertAdmin.
	const user = c.get("user") as JwtPayload | undefined;
	if (!user?.sub) return undefined;
	const oauth = c.get("oauth") as OAuthAuthContext | undefined;
	const inferred = oauth
		? { type: "oauth" as const, user, oauth }
		: { type: "session" as const, user };
	setAuthPrincipal(c, inferred);
	return inferred;
}

function setAuthPrincipal(c: Context, principal: AuthPrincipal): void {
	c.set("auth", principal);
	c.set("user", principal.user);
	if (principal.type === "oauth") c.set("oauth", principal.oauth);
}

/**
 * Whether a verification failure reports an `exp` in the past.
 *
 * Session tokens are verified with `hono/jwt`, which raises its own
 * `JwtTokenExpired`. The `name` check keeps this working across duplicated
 * module instances where `instanceof` fails. (jose is intentionally not matched:
 * every session-token path in this codebase goes through `hono/jwt`, so a jose
 * `JWTExpired` branch here would be dead code.)
 *
 * This alone does NOT mean the token was ever ours — `hono/jwt` evaluates `exp`
 * before the signature, so a forged token with a past `exp` lands here too. See
 * `isExpiredSessionJwt` for the signature confirmation.
 */
function reportsExpiredJwt(err: unknown): boolean {
	if (err instanceof JwtTokenExpired) return true;
	const name = (err as { name?: unknown } | null)?.name;
	return name === "JwtTokenExpired";
}

/**
 * Whether a verification failure means the session JWT was well-formed,
 * correctly signed by this instance, and only past its `exp`.
 *
 * The signature is re-checked with `exp` disabled, because otherwise any forged
 * token carrying a past `exp` would be reported as `TOKEN_EXPIRED` — which both
 * confirms token shape to an unauthenticated caller and makes the frontend drop
 * whatever session it currently holds.
 *
 * Getting this right matters beyond the error code. An expired session must
 * short-circuit here; otherwise it falls through to the OAuth access-token
 * lookup, costing a pointless database round-trip and reporting the generic
 * `UNAUTHORIZED` instead of the actionable `TOKEN_EXPIRED`.
 */
async function isExpiredSessionJwt(err: unknown, token: string): Promise<boolean> {
	if (!reportsExpiredJwt(err)) return false;
	return await isAuthenticSessionTokenIgnoringExpiry(token);
}

/**
 * Paths whose responses are served with a `public` or otherwise shared
 * `Cache-Control`, and must therefore never carry a session credential.
 *
 * A renewal header attached to `public, max-age=31536000, immutable` is written
 * to the browser's disk cache alongside the asset and is reusable by any
 * intermediary cache (reverse proxy, CDN, corporate proxy). Worse, a later cache
 * hit would replay a days-old header and push a stale token back into
 * localStorage. Excluding these paths is preferred over forcing `no-store` on
 * the renewal response, which would destroy asset caching for no benefit: these
 * routes are polled often enough that some other API call will carry the
 * renewal instead.
 *
 * Verified against every `Cache-Control` set behind the session gate:
 *  - /api/uploads/*            → public, max-age=31536000, immutable
 *  - /api/notification-sounds/:id → public, max-age=86400
 *  - /api/fs/preview          → private, max-age=60
 * `/api/fs/preview` is only `private`, but it is still a cacheable response
 * replayed without hitting the server, so it is excluded on the same grounds.
 */
const NON_RENEWABLE_PATH_PATTERNS: readonly RegExp[] = [
	/^\/api\/uploads(?:\/|$)/,
	/^\/api\/notification-sounds\/[^/]+(?:\/|$)/,
	/^\/api\/fs\/preview(?:\/|$)/,
];

function allowsSessionRenewalHeader(path: string): boolean {
	return !NON_RENEWABLE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Sliding session renewal.
 *
 * Session JWTs are self-contained and have no companion refresh token, so
 * without this an active user is logged out the moment the original lifetime
 * elapses. Whenever a request arrives with a still-valid token that is close to
 * expiry, re-sign it and hand the replacement back in a response header; the
 * frontend API client stores it and subsequent requests carry the fresh token.
 *
 * Deliberately narrow:
 *  - only first-party session JWTs (OAuth access tokens have their own refresh
 *    flow and revocation semantics, and must not be silently extended);
 *  - only inside the renewal window, so the common request pays no signing cost;
 *  - never past the absolute ceiling anchored at the original login;
 *  - never on responses that are cacheable by the browser or a shared cache;
 *  - the role is always re-read from `users`, never copied from the presented
 *    token, so a demotion cannot be frozen into an endless renewal chain;
 *  - failures are swallowed, since the current request is already authenticated
 *    and must not fail just because renewal did.
 *
 * The extra `users` lookup is bounded: it runs only inside the renewal window
 * (the last 3 days of a 7-day token), and the very next request carries the
 * refreshed token, so a client makes at most a handful of these per week — not
 * one per request.
 *
 * Throws when the user row is gone, matching the existence check in
 * `authenticateRequest`: a deleted user must not be renewed *or* served.
 */
async function maybeRenewSessionToken(c: Context, payload: JwtPayload): Promise<void> {
	const nowSeconds = Math.floor(Date.now() / 1000);
	if (!shouldRenewSessionToken(payload.exp, nowSeconds)) return;
	if (!allowsSessionRenewalHeader(c.req.path)) return;

	const sessionStart = resolveSessionStart(payload[SESSION_START_CLAIM], nowSeconds);
	if (!isWithinAbsoluteSessionLimit(sessionStart, nowSeconds)) return;

	// Re-read the live role. Outside the try/catch below so a vanished user
	// surfaces as a 401 instead of being silently treated as "renewal failed".
	const row = await authSessionStore.findSessionState(payload.sub);
	if (!row) {
		invalidateUserCache(payload.sub);
		throw catalogError("USER_GONE");
	}

	try {
		// Sign against the live generation, exactly as the role is taken live. The request that
		// reached here already passed the version check, so this cannot mint a token for a
		// revoked session — it only avoids handing back a token that a bump landing between
		// that check and this line would immediately invalidate.
		const renewed = await renewToken(row.id, row.role, sessionStart, row.tokenVersion);
		c.header(SESSION_RENEWAL_HEADER, renewed);
	} catch (error) {
		// Never log the error message itself: hono's JWT errors embed the whole
		// token in `message` (`token (${token}) expired`).
		logger.warn("Failed to renew session token", {
			userId: payload.sub,
			error: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

/**
 * Authenticate once per request and return the explicit session/oauth principal.
 * Subsequent auth middleware in the same Hono chain reuses `c.get("auth")`
 * instead of re-verifying or replacing context state.
 */
async function authenticateRequest(c: Context): Promise<AuthPrincipal> {
	const existing = getStoredAuthPrincipal(c);
	if (existing) return existing;

	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		throw catalogError("AUTH_REQUIRED");
	}

	const token = header.slice(7);
	let payload: JwtPayload;
	try {
		payload = await verifyToken(token);
	} catch (err) {
		if (await isExpiredSessionJwt(err, token)) {
			throw catalogError("TOKEN_EXPIRED");
		}
		// Not a valid session JWT — fall through to OAuth access tokens issued by
		// NarraFork's own authorization server (third-party API clients).
		const oauthGrant = await validateAccessToken(token).catch(() => null);
		if (!oauthGrant) {
			throw catalogError("TOKEN_INVALID");
		}
		// OAuth access tokens are short-lived and revocable, so always resolve the
		// live user row instead of using the session-JWT existence cache.
		const row = await authSessionStore.findSessionState(oauthGrant.userId);
		if (!row) {
			throw catalogError("USER_GONE");
		}
		const principal: OAuthAuthPrincipal = {
			type: "oauth",
			user: { sub: row.id, role: row.role, iat: 0, exp: 0 },
			oauth: {
				tokenId: oauthGrant.tokenId,
				clientId: oauthGrant.clientId,
				oauthClientId: oauthGrant.oauthClientId,
				grantId: oauthGrant.grantId,
				refreshFamilyId: oauthGrant.refreshFamilyId,
				expiresAt: oauthGrant.expiresAt,
				scopes: oauthGrant.scopes,
			},
		};
		setAuthPrincipal(c, principal);
		return principal;
	}

	// Confirm the user still exists (handles DB wipe, user deletion) and that this token's
	// generation has not been revoked. Both facts come from the same row and share one cache
	// entry, so token-version enforcement costs no extra query — the revocation window is the
	// existing 60s TTL, which anything bumping the counter shortens to zero by invalidating
	// the entry (see invalidateUserCache).
	let verified = getVerifiedUser(payload.sub);
	if (!verified) {
		const row = await authSessionStore.findSessionState(payload.sub);
		if (!row) {
			throw catalogError("USER_GONE");
		}
		verified = { at: Date.now(), tokenVersion: row.tokenVersion };
		verifiedUsers.set(payload.sub, verified);
	}
	if (!isSessionTokenVersionCurrent(payload[SESSION_VERSION_CLAIM], verified.tokenVersion)) {
		// Reported as expiry, not as a generic failure: the credential really is finished, and
		// TOKEN_EXPIRED is the code the frontend acts on by clearing its stored token and
		// sending the user back to login.
		throw catalogError("SESSION_REVOKED");
	}

	const principal: SessionAuthPrincipal = { type: "session", user: payload };
	setAuthPrincipal(c, principal);
	await maybeRenewSessionToken(c, payload);
	return principal;
}

/**
 * Authenticate either a first-party session JWT or an OAuth access token.
 * This dual-mode helper is reserved for explicitly external/legacy paths and tests;
 * ordinary application routes use requireSessionAuth.
 */
export async function requireAuth(c: Context, next: Next) {
	await authenticateRequest(c);
	await next();
}

/** Explicit name for callers that intentionally accept either external mode. */
export async function requireExternalAuth(c: Context, next: Next) {
	await authenticateRequest(c);
	await next();
}

/** Require an OAuth access token and reject first-party session JWTs. */
export async function requireOAuthAuth(c: Context, next: Next) {
	const principal = await authenticateRequest(c);
	if (principal.type !== "oauth") {
		throw catalogError("OAUTH_TOKEN_REQUIRED");
	}
	await next();
}

/**
 * Require a first-party session JWT. OAuth access tokens authenticate normal API
 * requests through requireExternalAuth/requireAuth, but they must never satisfy
 * user-consent flows.
 */
export async function requireSessionAuth(c: Context, next: Next) {
	const principal = await authenticateRequest(c);
	if (principal.type !== "session" || c.get("oauth")) {
		throw catalogError("SESSION_REQUIRED");
	}
	await next();
}

export function assertAdmin(c: Context): void {
	const principal = getAuthPrincipal(c);
	if (principal?.type === "oauth" || c.get("oauth")) {
		// OAuth grants are intentionally never accepted for administrative actions,
		// even when the live user row currently has the admin role.
		throw catalogError("ADMIN_REQUIRES_SESSION");
	}
	const user = principal?.user ?? (c.get("user") as JwtPayload | undefined);
	if (!user) {
		throw catalogError("AUTH_REQUIRED");
	}
	if (user.role !== "admin") {
		throw catalogError("ADMIN_REQUIRED");
	}
}

export async function requireAdmin(c: Context, next: Next) {
	assertAdmin(c);
	await next();
}

/**
 * Gate a route on an OAuth scope. Requests authenticated by a session JWT
 * (first-party UI) always pass — scopes only constrain third-party OAuth
 * access tokens. The auth lookup is cached, so this is safe after requireAuth
 * and can also be used as a standalone boundary.
 */
export function requireExternalScope(scope: string) {
	const requiredScope = scope.trim();
	if (!requiredScope) {
		throw new AppError("Required scope must not be empty", 500, "INVALID_SCOPE");
	}

	return async (c: Context, next: Next) => {
		const principal = await authenticateRequest(c);
		if (principal.type === "session") {
			await next();
			return;
		}
		if (!principal.oauth.scopes.includes(requiredScope)) {
			throw new AppError(`Missing required scope: ${requiredScope}`, 403, "INSUFFICIENT_SCOPE");
		}
		await next();
	};
}

/** Backwards-compatible name used by the existing provision routes. */
export function requireScope(scope: string) {
	return requireExternalScope(scope);
}
