import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { errors } from "jose";
import { db } from "../db";
import { users } from "../db/schema";
import { type JwtPayload, verifyToken } from "../lib/auth";
import { AppError } from "../lib/errors";
import { validateAccessToken } from "../lib/oauth-provider";

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
const verifiedUsers = new Map<string, number>();
const VERIFY_TTL_MS = 60_000; // 1 minute

function isUserVerifiedRecently(userId: string): boolean {
	const ts = verifiedUsers.get(userId);
	if (!ts) return false;
	if (Date.now() - ts > VERIFY_TTL_MS) {
		verifiedUsers.delete(userId);
		return false;
	}
	return true;
}

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
 * Authenticate once per request and return the explicit session/oauth principal.
 * Subsequent auth middleware in the same Hono chain reuses `c.get("auth")`
 * instead of re-verifying or replacing context state.
 */
async function authenticateRequest(c: Context): Promise<AuthPrincipal> {
	const existing = getStoredAuthPrincipal(c);
	if (existing) return existing;

	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		throw new AppError("Authentication required", 401, "UNAUTHORIZED");
	}

	const token = header.slice(7);
	let payload: JwtPayload;
	try {
		payload = await verifyToken(token);
	} catch (err) {
		if (err instanceof errors.JWTExpired) {
			throw new AppError("Token expired", 401, "TOKEN_EXPIRED");
		}
		// Not a valid session JWT — fall through to OAuth access tokens issued by
		// NarraFork's own authorization server (third-party API clients).
		const oauthGrant = await validateAccessToken(token).catch(() => null);
		if (!oauthGrant) {
			throw new AppError("Invalid or expired token", 401, "UNAUTHORIZED");
		}
		// OAuth access tokens are short-lived and revocable, so always resolve the
		// live user row instead of using the session-JWT existence cache.
		const row = await db.query.users.findFirst({
			where: eq(users.id, oauthGrant.userId),
			columns: { id: true, role: true },
		});
		if (!row) {
			throw new AppError("User no longer exists", 401, "UNAUTHORIZED");
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

	// Ensure the user still exists in the database (handles DB wipe, user deletion, etc.)
	if (!isUserVerifiedRecently(payload.sub)) {
		const row = await db.query.users.findFirst({
			where: eq(users.id, payload.sub),
			columns: { id: true },
		});
		if (!row) {
			throw new AppError("User no longer exists", 401, "UNAUTHORIZED");
		}
		verifiedUsers.set(payload.sub, Date.now());
	}

	const principal: SessionAuthPrincipal = { type: "session", user: payload };
	setAuthPrincipal(c, principal);
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
		throw new AppError("OAuth access token required", 401, "OAUTH_REQUIRED");
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
		throw new AppError("Session authentication required", 401, "SESSION_REQUIRED");
	}
	await next();
}

export function assertAdmin(c: Context): void {
	const principal = getAuthPrincipal(c);
	if (principal?.type === "oauth" || c.get("oauth")) {
		// OAuth grants are intentionally never accepted for administrative actions,
		// even when the live user row currently has the admin role.
		throw new AppError("Admin access requires a session", 403, "FORBIDDEN");
	}
	const user = principal?.user ?? (c.get("user") as JwtPayload | undefined);
	if (!user) {
		throw new AppError("Authentication required", 401, "UNAUTHORIZED");
	}
	if (user.role !== "admin") {
		throw new AppError("Admin access required", 403, "FORBIDDEN");
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
