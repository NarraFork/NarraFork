import { isOpaqueSessionToken, shouldRenewSessionToken } from "@shared/session-auth";
import type { Context, Next } from "hono";
import { extendSessionToken, type SessionPayload, verifyToken } from "../lib/auth";
import { AppError, catalogError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
// The two remaining raw AppErrors below are deliberate: `INVALID_SCOPE` is a programming
// error that never reaches a browser, and `INSUFFICIENT_SCOPE` is read by third-party
// OAuth clients rather than rendered in the UI, so neither needs a localized wording.
import { isManagerTokenAuthorized, readManagerToken } from "../lib/manager-token";
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

/** The first-party session principal established by a session token. */
export interface SessionAuthPrincipal {
	type: "session";
	user: SessionPayload;
}

/** The external principal established by a NarraFork OAuth access token. */
export interface OAuthAuthPrincipal {
	type: "oauth";
	user: SessionPayload;
	oauth: OAuthAuthContext;
}

export type AuthPrincipal = SessionAuthPrincipal | OAuthAuthPrincipal;

// Extend Hono's context variables for type-safe user access
declare module "hono" {
	interface ContextVariableMap {
		auth: AuthPrincipal;
		user: SessionPayload;
		oauth: OAuthAuthContext;
	}
}

/**
 * Tell live subscribers (open editor sockets, …) that a user's authorization changed.
 * A hint only: every request resolves its session against the database anyway.
 */
export function notifyAuthChanged(userId?: string) {
	eventBus.emit({ type: "auth:changed", ...(userId ? { userId } : {}) });
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
	const user = c.get("user") as SessionPayload | undefined;
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
 * Sliding renewal.
 *
 * Only inside the renewal window (the last 3 days of a 7-day expiry), so ordinary
 * requests write nothing; the next request after a renewal sees the new expiry and
 * stops renewing. The token itself never changes. The absolute ceiling is enforced
 * by `extendSessionToken`. Failures are swallowed: the current request is already
 * authenticated and must not fail just because renewal did.
 */
async function maybeExtendSession(payload: SessionPayload): Promise<void> {
	if (!shouldRenewSessionToken(payload.exp, Math.floor(Date.now() / 1000))) return;
	try {
		await extendSessionToken(payload);
	} catch (error) {
		logger.warn("Failed to extend session", {
			userId: payload.sub,
			error: error instanceof Error ? error.name : "UnknownError",
		});
	}
}

function hasErrorName(err: unknown, name: string): boolean {
	return (err as { name?: unknown } | null)?.name === name;
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
	if (isOpaqueSessionToken(token)) {
		let payload: SessionPayload;
		try {
			payload = await verifyToken(token);
		} catch (err) {
			// Error names rather than `instanceof`, to survive duplicated module instances.
			if (hasErrorName(err, "SessionTokenRevoked")) throw catalogError("SESSION_REVOKED");
			if (hasErrorName(err, "SessionTokenExpired")) throw catalogError("TOKEN_EXPIRED");
			// Unknown token. Anything else (a storage failure) must not read as "your session
			// is gone", or the client would drop a perfectly good token.
			if (err instanceof AppError && err.statusCode === 401) throw catalogError("TOKEN_INVALID");
			throw err;
		}
		// Resolved against the live account row: existence, role and token generation are
		// already current.
		const principal: SessionAuthPrincipal = { type: "session", user: payload };
		setAuthPrincipal(c, principal);
		await maybeExtendSession(payload);
		return principal;
	}

	// Not a session token — an OAuth access token issued by NarraFork's own authorization
	// server (third-party API clients), or nothing usable (including session JWTs from
	// before opaque session tokens, which are simply no longer accepted).
	const oauthGrant = await validateAccessToken(token).catch(() => null);
	if (!oauthGrant) {
		throw catalogError("TOKEN_INVALID");
	}
	// OAuth access tokens are short-lived and revocable, so always resolve the live user row.
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

/**
 * Authenticate either a first-party session token or an OAuth access token.
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

/** Require an OAuth access token and reject first-party session tokens. */
export async function requireOAuthAuth(c: Context, next: Next) {
	const principal = await authenticateRequest(c);
	if (principal.type !== "oauth") {
		throw catalogError("OAUTH_TOKEN_REQUIRED");
	}
	await next();
}

/**
 * Require a first-party session token. OAuth access tokens authenticate normal API
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

export async function assertAdmin(c: Context): Promise<void> {
	const principal = getAuthPrincipal(c);
	if (principal?.type === "oauth" || c.get("oauth")) {
		// OAuth grants are intentionally never accepted for administrative actions,
		// even when the live user row currently has the admin role.
		throw catalogError("ADMIN_REQUIRES_SESSION");
	}
	const user = principal?.user ?? (c.get("user") as SessionPayload | undefined);
	if (!user) {
		throw catalogError("AUTH_REQUIRED");
	}
	// Authorize against the LIVE role. A session the gate resolved in this request already
	// carries it (read from `users` together with the session row). Anything else — a caller
	// that set `user` directly without authenticating — reads the row now and fails closed
	// if the user is gone.
	let role: string | undefined = user.sid ? user.role : undefined;
	if (role === undefined) {
		const row = await authSessionStore.findSessionState(user.sub);
		if (!row) {
			throw catalogError("USER_GONE");
		}
		role = row.role;
	}
	if (role !== "admin") {
		throw catalogError("ADMIN_REQUIRED");
	}
}

export async function requireAdmin(c: Context, next: Next) {
	await assertAdmin(c);
	await next();
}

/**
 * 管理员会话，或管理器面板持有的本机令牌。
 *
 * 面板是独立进程、没有用户会话令牌。令牌由面板生成，只放进它拉起的服务进程的环境变量。
 * 对端必须是回环 socket（`peerIp`，不是解析过转发头的 clientIp），并且 Bearer 与令牌一致。
 * 终端里手动启动的服务没有这个环境变量，因此没有旁路。
 */
export async function requireAdminOrManagerToken(c: Context, next: Next) {
	const env = c.env as { peerIp?: string } | undefined;
	if (
		isManagerTokenAuthorized({
			peerIp: env?.peerIp,
			authorization: c.req.header("authorization"),
			expectedToken: readManagerToken(),
		})
	) {
		await next();
		return;
	}
	await authenticateRequest(c);
	await assertAdmin(c);
	await next();
}

/**
 * Gate a route on an OAuth scope. Requests authenticated by a session token
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
