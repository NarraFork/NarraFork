/**
 * SSO / OIDC routes.
 *
 * Login flow (public, browser redirects):
 *   1. GET  /auth/sso/:providerId/start  → 302 to the IdP authorization URL
 *   2. GET  /auth/sso/callback           → verify, resolve/provision user,
 *                                          302 back to the frontend with a
 *                                          single-use sso_code
 *   3. POST /auth/sso/exchange {code}     → returns the real session JWT
 *
 * The JWT is never placed in a URL; the frontend exchanges a short-lived,
 * single-use code for it. This avoids leaking the session token via browser
 * history, referrer headers or server logs.
 *
 * Link flow (authenticated): POST /auth/sso/:providerId/link/start returns an
 * authorization URL whose state records the current user, so the same callback
 * links the verified identity instead of logging in.
 */
import { type Context, Hono } from "hono";
import { buildSessionResult } from "../lib/auth";
import { AppError, formatZodError, ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import {
	buildAuthorizationUrl,
	exchangeAndVerify,
	generatePkce,
	type OidcClaims,
	randomToken,
} from "../lib/oidc";
import { settings } from "../lib/settings";
import type { OidcProviderConfig } from "../lib/settings/types";
import { oidcExchangeSchema } from "../lib/validators";
import { requireAuth } from "../middleware/auth";
import { ssoService } from "../services/sso-service";

export const ssoRoutes = new Hono();

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_TTL_MS = 2 * 60 * 1000; // 2 minutes

interface PendingState {
	providerId: string;
	nonce: string;
	codeVerifier: string;
	redirectUri: string;
	/** Set when this is a "link to current user" flow (not a login). */
	linkUserId?: string;
	expiresAt: number;
}

/** One-time session codes minted after a successful SSO login. */
interface PendingCode {
	userId: string;
	expiresAt: number;
}

/**
 * In-memory ceremony state. NOTE: this assumes a single server process —
 * NarraFork's intended self-hosted deployment model. Pending SSO logins (state)
 * and minted one-time codes live only in this process's memory, so a restart or
 * a horizontally-scaled multi-instance deployment (behind a load balancer
 * without sticky sessions) would drop in-flight ceremonies → `state_expired` /
 * `SSO_CODE_INVALID`. Both are short-lived (≤10 min / ≤2 min) and the user can
 * simply retry. If multi-instance support is ever needed, move these to a shared
 * store (e.g. the DB, like webauthn_challenges).
 */
const pendingStates = new Map<string, PendingState>();
const pendingCodes = new Map<string, PendingCode>();

function sweep() {
	const now = Date.now();
	for (const [k, v] of pendingStates) if (v.expiresAt <= now) pendingStates.delete(k);
	for (const [k, v] of pendingCodes) if (v.expiresAt <= now) pendingCodes.delete(k);
}

function enabledProviders(): OidcProviderConfig[] {
	return (settings.auth.oidcProviders ?? []).filter((p) => p.enabled !== false && p.issuer);
}

function findProvider(id: string): OidcProviderConfig | undefined {
	return enabledProviders().find((p) => p.id === id);
}

/**
 * Build this instance's SSO callback URL from the incoming request.
 *
 * Relies on the `x-forwarded-proto` / `host` headers so it works behind a
 * reverse proxy / TLS terminator. These headers are client-controllable, but a
 * forged value here only changes the `redirect_uri` we send to the IdP — and
 * OIDC requires that to EXACTLY match a value pre-registered with the provider,
 * so a mismatch just fails the exchange (no open-redirect / token leak). For
 * hardening, pin the public origin at the reverse proxy and ensure it sets a
 * trustworthy `host` / `x-forwarded-proto`.
 */
function callbackUrl(c: Context): string {
	const proto =
		c.req.header("x-forwarded-proto") || (settings.server.tls?.enabled ? "https" : "http");
	const host = c.req.header("host") ?? `localhost:${settings.server.port}`;
	return `${proto}://${host}/api/auth/sso/callback`;
}

/** Public: list enabled SSO providers (id + display name only). */
ssoRoutes.get("/providers", (c) => {
	const providers = enabledProviders().map((p) => ({ id: p.id, name: p.name }));
	return c.json({ providers });
});

/** Public: begin a login ceremony — 302 redirect to the IdP. */
ssoRoutes.get("/:providerId/start", async (c) => {
	const providerId = c.req.param("providerId");
	const provider = providerId ? findProvider(providerId) : undefined;
	if (!provider) return c.redirect("/login?sso_error=unknown_provider");
	try {
		const redirectUri = callbackUrl(c);
		const url = await beginCeremony(provider, redirectUri);
		return c.redirect(url);
	} catch (err) {
		logger.error("SSO start failed", { provider: providerId, error: String(err) });
		return c.redirect("/login?sso_error=start_failed");
	}
});

/** Public: OIDC redirect callback. Handles both login and link ceremonies. */
export async function handleSsoCallback(c: Context) {
	const code = c.req.query("code");
	const state = c.req.query("state");
	const oidcError = c.req.query("error");
	if (oidcError) return c.redirect(`/login?sso_error=${encodeURIComponent(oidcError)}`);
	if (!code || !state) return c.redirect("/login?sso_error=missing_params");

	sweep();
	const pending = pendingStates.get(state);
	pendingStates.delete(state);
	if (!pending || pending.expiresAt <= Date.now()) {
		return c.redirect("/login?sso_error=state_expired");
	}
	const provider = findProvider(pending.providerId);
	if (!provider) return c.redirect("/login?sso_error=unknown_provider");

	let claims: OidcClaims;
	try {
		claims = await exchangeAndVerify({
			provider,
			code,
			redirectUri: pending.redirectUri,
			codeVerifier: pending.codeVerifier,
			expectedNonce: pending.nonce,
		});
	} catch (err) {
		logger.error("SSO callback verification failed", {
			provider: provider.id,
			error: String(err),
		});
		return c.redirect("/login?sso_error=verification_failed");
	}

	// Link flow: attach the identity to the already-known user.
	if (pending.linkUserId) {
		const result = await ssoService.linkIdentity(pending.linkUserId, provider, claims);
		if (!result.ok) {
			return c.redirect("/settings/security?sso_error=already_linked_other");
		}
		return c.redirect("/settings/security?sso_linked=1");
	}

	// Login flow: resolve or provision the user, then hand back a one-time code.
	try {
		const userId = await ssoService.resolveLogin(provider, claims);
		const ssoCode = generateId(32);
		pendingCodes.set(ssoCode, { userId, expiresAt: Date.now() + CODE_TTL_MS });
		return c.redirect(`/login?sso_code=${encodeURIComponent(ssoCode)}`);
	} catch (err) {
		const code = err instanceof AppError && err.code ? err.code.toLowerCase() : "login_failed";
		return c.redirect(`/login?sso_error=${encodeURIComponent(code)}`);
	}
}

/** Public: exchange a one-time SSO code for the real session JWT. */
ssoRoutes.post("/exchange", async (c) => {
	const parsed = oidcExchangeSchema.safeParse(await c.req.json());
	if (!parsed.success) throw new ValidationError(formatZodError(parsed.error));
	sweep();
	const entry = pendingCodes.get(parsed.data.code);
	pendingCodes.delete(parsed.data.code);
	if (!entry || entry.expiresAt <= Date.now()) {
		throw new AppError("Invalid or expired SSO code", 401, "SSO_CODE_INVALID");
	}
	const session = await buildSessionResult(entry.userId);
	return c.json(session);
});

/** Authenticated: begin a "link this provider to my account" ceremony. */
ssoRoutes.post("/:providerId/link/start", requireAuth, async (c) => {
	const user = c.get("user");
	const providerId = c.req.param("providerId");
	const provider = providerId ? findProvider(providerId) : undefined;
	if (!provider) throw new AppError("Unknown SSO provider", 404, "NOT_FOUND");
	const redirectUri = callbackUrl(c);
	const authorizeUrl = await beginCeremony(provider, redirectUri, user.sub);
	return c.json({ authorizeUrl });
});

/** Build state + PKCE, store it, and return the IdP authorization URL. */
async function beginCeremony(
	provider: OidcProviderConfig,
	redirectUri: string,
	linkUserId?: string,
): Promise<string> {
	sweep();
	const state = randomToken();
	const nonce = randomToken();
	const pkce = generatePkce();
	pendingStates.set(state, {
		providerId: provider.id,
		nonce,
		codeVerifier: pkce.verifier,
		redirectUri,
		linkUserId,
		expiresAt: Date.now() + STATE_TTL_MS,
	});
	return buildAuthorizationUrl({
		provider,
		redirectUri,
		state,
		nonce,
		codeChallenge: pkce.challenge,
	});
}
