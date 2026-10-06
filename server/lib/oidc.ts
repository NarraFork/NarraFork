/**
 * OpenID Connect (OIDC) authorization-code flow helpers — built on `jose`, no
 * extra dependencies.
 *
 * Responsibilities:
 *  - discover a provider's endpoints from its issuer (.well-known, cached);
 *  - build the authorization URL (with state, nonce and PKCE);
 *  - exchange an authorization code for tokens;
 *  - verify the id_token signature (via the provider's JWKS) and claims.
 *
 * The verified claims (sub, email, name) are consumed by sso-service to link or
 * provision a local user.
 */
import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { OidcProviderConfig } from "./settings/types";

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

interface OidcEndpoints {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	userinfoEndpoint?: string;
}

interface CachedDiscovery {
	endpoints: OidcEndpoints;
	jwks: ReturnType<typeof createRemoteJWKSet>;
	fetchedAt: number;
}

const discoveryCache = new Map<string, CachedDiscovery>();

/** Strip a trailing slash so issuer comparisons and URL joins are consistent. */
function normalizeIssuer(issuer: string): string {
	return issuer.replace(/\/+$/, "");
}

/** Fetch (and cache) a provider's OIDC discovery document + JWKS. */
export async function discover(issuer: string): Promise<CachedDiscovery> {
	const key = normalizeIssuer(issuer);
	const cached = discoveryCache.get(key);
	if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached;

	const url = `${key}/.well-known/openid-configuration`;
	const res = await fetch(url, { headers: { Accept: "application/json" } });
	if (!res.ok) {
		throw new Error(`OIDC discovery failed (${res.status}) for ${key}`);
	}
	const doc = (await res.json()) as {
		issuer?: string;
		authorization_endpoint?: string;
		token_endpoint?: string;
		jwks_uri?: string;
		userinfo_endpoint?: string;
	};
	if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
		throw new Error(`OIDC discovery document for ${key} is missing required endpoints`);
	}
	const endpoints: OidcEndpoints = {
		issuer: doc.issuer ?? key,
		authorizationEndpoint: doc.authorization_endpoint,
		tokenEndpoint: doc.token_endpoint,
		jwksUri: doc.jwks_uri,
		userinfoEndpoint: doc.userinfo_endpoint,
	};
	const entry: CachedDiscovery = {
		endpoints,
		jwks: createRemoteJWKSet(new URL(endpoints.jwksUri)),
		fetchedAt: Date.now(),
	};
	discoveryCache.set(key, entry);
	return entry;
}

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

export interface PkcePair {
	verifier: string;
	challenge: string;
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): PkcePair {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

/** Generate a random opaque token (state / nonce). */
export function randomToken(): string {
	return base64url(randomBytes(24));
}

/** Default scopes when a provider does not specify any. */
function resolveScopes(provider: OidcProviderConfig): string {
	const scopes = provider.scopes?.length ? provider.scopes : ["openid", "profile", "email"];
	// Guarantee openid is present and de-duplicated.
	return Array.from(new Set(["openid", ...scopes])).join(" ");
}

/** Build the authorization URL to redirect the user to. */
export async function buildAuthorizationUrl(params: {
	provider: OidcProviderConfig;
	redirectUri: string;
	state: string;
	nonce: string;
	codeChallenge: string;
}): Promise<string> {
	const { endpoints } = await discover(params.provider.issuer);
	const url = new URL(endpoints.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.provider.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", resolveScopes(params.provider));
	url.searchParams.set("state", params.state);
	url.searchParams.set("nonce", params.nonce);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	return url.toString();
}

export interface OidcClaims {
	sub: string;
	email?: string;
	emailVerified?: boolean;
	name?: string;
}

/**
 * Exchange an authorization code for tokens and verify the id_token. Returns the
 * verified identity claims. Throws on any verification failure.
 */
export async function exchangeAndVerify(params: {
	provider: OidcProviderConfig;
	code: string;
	redirectUri: string;
	codeVerifier: string;
	expectedNonce: string;
}): Promise<OidcClaims> {
	const { endpoints, jwks } = await discover(params.provider.issuer);

	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: params.code,
		redirect_uri: params.redirectUri,
		client_id: params.provider.clientId,
		client_secret: params.provider.clientSecret,
		code_verifier: params.codeVerifier,
	});
	const tokenRes = await fetch(endpoints.tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body,
	});
	if (!tokenRes.ok) {
		const text = await tokenRes.text().catch(() => "");
		throw new Error(`OIDC token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`);
	}
	const tokens = (await tokenRes.json()) as { id_token?: string };
	if (!tokens.id_token) {
		throw new Error("OIDC token response missing id_token");
	}

	// Verify signature + standard claims (issuer + audience).
	const { payload } = await jwtVerify(tokens.id_token, jwks, {
		issuer: endpoints.issuer,
		audience: params.provider.clientId,
	});

	// Nonce binding: the id_token must echo the nonce we sent.
	if (payload.nonce !== params.expectedNonce) {
		throw new Error("OIDC id_token nonce mismatch");
	}

	const claims = payload as JWTPayload & {
		email?: string;
		email_verified?: boolean;
		name?: string;
		preferred_username?: string;
	};
	if (!claims.sub) {
		throw new Error("OIDC id_token missing sub claim");
	}
	return {
		sub: claims.sub,
		email: claims.email,
		emailVerified: claims.email_verified,
		name: claims.name ?? claims.preferred_username,
	};
}
