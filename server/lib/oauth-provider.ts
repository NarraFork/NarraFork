/**
 * OAuth 2.0 authorization server core (Authorization Code + PKCE).
 *
 * NarraFork acts as the OAuth *provider* here: external applications (e.g. the
 * robot assistant) register as public clients, send the user through the
 * consent flow, and receive access/refresh tokens that authorize calls to the
 * NarraFork API. This is unrelated to the login-via-SSO (OIDC) feature.
 *
 * Storage rules mirror the device-token model: codes and tokens are random
 * secrets; only their SHA-256 hashes are persisted, and the plaintext is
 * returned to the caller exactly once.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "../db";
import {
	integrationAuthorities,
	integrationCapabilityGrants,
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrants,
} from "../db/schema";
import { AppError } from "./errors";
import { eventBus } from "./event-bus";
import { generateId } from "./id";
import { logger } from "./logger";
import { recordOAuthSecurityEvent } from "./oauth-security-observability";

/** Canonical scopes exposed by the OAuth provider and External API v1. */
export const OAUTH_EXTERNAL_V1_SCOPES = [
	"project.read",
	"device.read",
	"device.provision",
	"device.rotate",
	"narrator.read",
	"event.subscribe",
	"narrator.provision",
	"narrator.send_message",
	"narrator.interrupt",
] as const;

/** Scopes the provider currently understands. Unknown scopes are rejected. */
export const OAUTH_SUPPORTED_SCOPES = OAUTH_EXTERNAL_V1_SCOPES;
export type OAuthScope = (typeof OAUTH_SUPPORTED_SCOPES)[number];

export const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const OAUTH_LAST_USED_THROTTLE_MS = 5 * 60 * 1000; // approximately 5 minutes

/** RFC 6749 §5.2 error codes the token endpoint can surface. */
export type OAuthErrorCode =
	| "invalid_request"
	| "invalid_client"
	| "invalid_grant"
	| "invalid_scope"
	| "unauthorized_client"
	| "unsupported_grant_type";

export class OAuthError extends AppError {
	constructor(
		public oauthError: OAuthErrorCode,
		description: string,
	) {
		super(description, 400, "OAUTH_ERROR");
		this.name = "OAuthError";
	}
}

export function hashOAuthSecret(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

/** Constant-time string comparison (length-safe). */
function secretsEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

/** PKCE S256: base64url(SHA-256(verifier)), compared in constant time. */
export function verifyPkceChallenge(verifier: string, challenge: string): boolean {
	const computed = base64url(createHash("sha256").update(verifier).digest());
	return secretsEqual(computed, challenge);
}

export type OAuthClientRow = typeof oauthClients.$inferSelect;

/**
 * Resolve a client by its public `client_id` and enforce that it is usable.
 * Throws OAuthError(invalid_client) on any problem.
 */
export async function requireActiveClient(clientId: string): Promise<OAuthClientRow> {
	if (!clientId) {
		throw new OAuthError("invalid_request", "client_id is required");
	}
	const client = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, clientId),
	});
	if (!client || client.revokedAt || !client.publicClient) {
		throw new OAuthError("invalid_client", "Unknown, revoked, or unsupported client");
	}
	return client;
}

async function requireActiveClientReference(input: {
	clientId?: string;
	oauthClientId?: string | null;
}): Promise<OAuthClientRow> {
	if (input.clientId) return requireActiveClient(input.clientId);
	if (!input.oauthClientId) throw new OAuthError("invalid_request", "client_id is required");
	const client = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.id, input.oauthClientId),
	});
	if (!client || client.revokedAt || !client.publicClient) {
		throw new OAuthError("invalid_client", "Unknown, revoked, or unsupported client");
	}
	return client;
}

/**
 * Validate a redirect URI against the client's allow-list.
 *
 * Normal native-app redirects are exact matches. For RFC 8252 loopback
 * redirects, an admin may register port `0` (for example
 * `http://127.0.0.1:0/callback`) to allow the app to select an ephemeral local
 * port while keeping host, path, query, and scheme constrained.
 */
export function requireAllowedRedirectUri(client: OAuthClientRow, redirectUri: string): void {
	if (!redirectUri) {
		throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
	}
	const exact = client.redirectUris.some((uri) => secretsEqual(uri, redirectUri));
	if (exact) return;

	let actual: URL;
	try {
		actual = new URL(redirectUri);
	} catch {
		throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
	}
	const isLoopback =
		actual.protocol === "http:" &&
		(actual.hostname === "127.0.0.1" ||
			actual.hostname === "localhost" ||
			actual.hostname === "[::1]");
	const wildcardMatch = client.redirectUris.some((registered) => {
		if (!isLoopback) return false;
		let template: URL;
		try {
			template = new URL(registered);
		} catch {
			return false;
		}
		const templateLoopback =
			template.protocol === "http:" &&
			template.hostname === actual.hostname &&
			template.port === "0";
		return (
			templateLoopback &&
			template.pathname === actual.pathname &&
			template.search === actual.search &&
			template.hash === actual.hash
		);
	});
	if (!wildcardMatch) {
		throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
	}
}

export function parseScopes(scopeParam: string | string[] | undefined | null): string[] {
	const raw = Array.isArray(scopeParam) ? scopeParam.join(" ") : (scopeParam ?? "");
	return [
		...new Set(
			raw
				.split(/\s+/)
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}

/**
 * Requested scopes must be (a) known to the provider and (b) a subset of the
 * scopes the client is registered for. An empty request is allowed and means
 * "no extra privileges" per RFC 6749 §3.3.
 */
export function requireValidScopes(client: OAuthClientRow, requested: string[]): string[] {
	const normalized = [...new Set(requested.map((scope) => scope.trim()).filter(Boolean))];
	for (const scope of normalized) {
		if (!OAUTH_SUPPORTED_SCOPES.includes(scope as OAuthScope)) {
			throw new OAuthError("invalid_scope", `Unknown scope: ${scope}`);
		}
		if (!client.scopes.includes(scope)) {
			throw new OAuthError("invalid_scope", `Scope not allowed for this client: ${scope}`);
		}
	}
	return normalized;
}

function intersectScopes(...scopeSets: string[][]): string[] {
	if (scopeSets.length === 0) return [];
	const remaining = scopeSets.slice(1).map((scopes) => new Set(scopes));
	return [...new Set(scopeSets[0])].filter((scope) =>
		remaining.every((scopes) => scopes.has(scope)),
	);
}

interface ActiveGrantBinding {
	id: string;
	oauthClientId: string;
	userId: string;
	scopes: string[];
	authorityRevision: number;
}

async function requireActiveGrantBinding(input: {
	grantId: string;
	oauthClientId: string;
	userId: string;
}): Promise<ActiveGrantBinding> {
	const [grant, authority] = await Promise.all([
		db.query.oauthGrants.findFirst({
			where: and(eq(oauthGrants.id, input.grantId), isNull(oauthGrants.revokedAt)),
			columns: { id: true, oauthClientId: true, userId: true },
		}),
		db.query.integrationAuthorities.findFirst({
			where: and(
				eq(integrationAuthorities.id, input.grantId),
				eq(integrationAuthorities.kind, "oauth_grant"),
				eq(integrationAuthorities.integrationType, "oauth_client"),
				eq(integrationAuthorities.integrationId, input.oauthClientId),
				eq(integrationAuthorities.state, "active"),
			),
			columns: { id: true, ownerUserId: true, revision: true },
		}),
	]);
	if (
		!grant ||
		!authority ||
		grant.oauthClientId !== input.oauthClientId ||
		grant.userId !== input.userId ||
		authority.ownerUserId !== input.userId
	) {
		throw new OAuthError("invalid_grant", "OAuth grant is invalid or revoked");
	}
	const now = new Date().toISOString();
	const rows = await db.query.integrationCapabilityGrants.findMany({
		where: and(
			eq(integrationCapabilityGrants.authorityId, input.grantId),
			isNull(integrationCapabilityGrants.revokedAt),
			or(
				isNull(integrationCapabilityGrants.expiresAt),
				gt(integrationCapabilityGrants.expiresAt, now),
			),
		),
		columns: { capabilityId: true },
		limit: 2_001,
	});
	if (rows.length > 2_000) {
		throw new OAuthError("invalid_grant", "OAuth grant capability limit was exceeded");
	}
	return {
		...grant,
		scopes: [...new Set(rows.map((row) => row.capabilityId))],
		authorityRevision: authority.revision,
	};
}

async function updateLastUsedAtBestEffort(input: {
	tokenId: string;
	oauthClientId: string;
	grantId: string | null;
}): Promise<void> {
	const now = new Date();
	const nowIso = now.toISOString();
	const cutoffIso = new Date(now.getTime() - OAUTH_LAST_USED_THROTTLE_MS).toISOString();
	try {
		await db
			.update(oauthAccessTokens)
			.set({ lastUsedAt: nowIso })
			.where(
				and(
					eq(oauthAccessTokens.id, input.tokenId),
					or(isNull(oauthAccessTokens.lastUsedAt), lt(oauthAccessTokens.lastUsedAt, cutoffIso)),
				),
			);
	} catch {
		// Usage telemetry is best-effort and must not reject a valid bearer.
	}
	try {
		await db
			.update(oauthClients)
			.set({ lastUsedAt: nowIso })
			.where(
				and(
					eq(oauthClients.id, input.oauthClientId),
					or(isNull(oauthClients.lastUsedAt), lt(oauthClients.lastUsedAt, cutoffIso)),
				),
			);
	} catch {
		// Usage telemetry is best-effort and must not reject a valid bearer.
	}
	if (input.grantId) {
		try {
			await db
				.update(oauthGrants)
				.set({ lastUsedAt: nowIso })
				.where(
					and(
						eq(oauthGrants.id, input.grantId),
						or(isNull(oauthGrants.lastUsedAt), lt(oauthGrants.lastUsedAt, cutoffIso)),
					),
				);
		} catch {
			// Usage telemetry is best-effort and must not reject a valid bearer.
		}
	}
}

async function updateGrantTokenIssuedAtBestEffort(grantId: string | null): Promise<void> {
	if (!grantId) return;
	try {
		const now = new Date().toISOString();
		await db
			.update(oauthGrants)
			.set({ lastTokenIssuedAt: now, updatedAt: now })
			.where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)));
	} catch {
		// Telemetry timestamps must never turn a successful token issuance into an error.
	}
}

export interface IssueAuthorizationCodeInput {
	clientId?: string;
	/** Optional internal oauth_clients.id assertion supplied by grant-aware callers. */
	oauthClientId?: string | null;
	/** Null keeps the phase-0 legacy provisioning flow compatible. */
	grantId?: string | null;
	userId: string;
	redirectUri: string;
	scopes: string[];
	codeChallenge: string;
	codeChallengeMethod?: string;
}

export interface IssueAuthorizationCodeResult {
	/** Plaintext code — returned to the client exactly once. */
	code: string;
	expiresAt: string;
}

export async function issueAuthorizationCode(
	input: IssueAuthorizationCodeInput,
): Promise<IssueAuthorizationCodeResult> {
	const client = await requireActiveClientReference(input);
	if (input.clientId && input.oauthClientId && input.oauthClientId !== client.id) {
		throw new OAuthError("invalid_client", "oauthClientId does not match client_id");
	}
	requireAllowedRedirectUri(client, input.redirectUri);
	const scopes = requireValidScopes(client, input.scopes);
	const grantId = input.grantId ?? null;
	if (grantId) {
		const grant = await requireActiveGrantBinding({
			grantId,
			oauthClientId: client.id,
			userId: input.userId,
		});
		if (intersectScopes(scopes, grant.scopes).length !== scopes.length) {
			throw new OAuthError("invalid_scope", "Requested scope is not present in the OAuth grant");
		}
	}

	if (!input.codeChallenge) {
		throw new OAuthError("invalid_request", "code_challenge is required (PKCE)");
	}
	const method = input.codeChallengeMethod ?? "S256";
	if (method !== "S256") {
		throw new OAuthError("invalid_request", "Only S256 code_challenge_method is supported");
	}

	const code = `nfcode_${base64url(randomBytes(32))}`;
	const now = Date.now();
	const expiresAt = new Date(now + AUTHORIZATION_CODE_TTL_MS).toISOString();

	await db.insert(oauthAuthorizationCodes).values({
		id: generateId(),
		codeHash: hashOAuthSecret(code),
		clientId: client.clientId,
		oauthClientId: client.id,
		grantId,
		userId: input.userId,
		redirectUri: input.redirectUri,
		scopes,
		codeChallenge: input.codeChallenge,
		codeChallengeMethod: "S256",
		expiresAt,
		createdAt: new Date(now).toISOString(),
	});

	return { code, expiresAt };
}

export interface OAuthTokenPair {
	accessToken: string;
	tokenType: "Bearer";
	expiresIn: number;
	refreshToken: string;
	scope: string;
}

export interface IssueTokenPairInput {
	clientId: string;
	oauthClientId?: string | null;
	grantId?: string | null;
	userId: string;
	scopes: string[];
	refreshFamilyId?: string;
	refreshParentTokenId?: string;
	refreshFamilyExpiresAt?: string;
}

/** Persist one access+refresh pair and return the plaintext tokens. */
export async function issueTokenPair(input: IssueTokenPairInput): Promise<OAuthTokenPair> {
	const client = await requireActiveClient(input.clientId);
	if (input.oauthClientId && input.oauthClientId !== client.id) {
		throw new OAuthError("invalid_client", "OAuth client binding does not match client_id");
	}
	for (const scope of input.scopes) {
		if (!OAUTH_SUPPORTED_SCOPES.includes(scope as OAuthScope)) {
			throw new OAuthError("invalid_scope", `Unknown scope: ${scope}`);
		}
	}
	const oauthClientId = client.id;
	const grantId = input.grantId ?? null;
	let scopes = intersectScopes(input.scopes, client.scopes);
	if (grantId) {
		const grant = await requireActiveGrantBinding({
			grantId,
			oauthClientId,
			userId: input.userId,
		});
		scopes = intersectScopes(scopes, grant.scopes);
	}

	const accessToken = `nfat_${base64url(randomBytes(32))}`;
	const refreshToken = `nfrt_${base64url(randomBytes(32))}`;
	const now = Date.now();
	const tokenId = generateId();
	const refreshFamilyId = input.refreshFamilyId ?? tokenId;
	const refreshFamilyExpiresAt =
		input.refreshFamilyExpiresAt ?? new Date(now + REFRESH_TOKEN_TTL_MS).toISOString();

	await db.insert(oauthAccessTokens).values({
		id: tokenId,
		tokenHash: hashOAuthSecret(accessToken),
		clientId: input.clientId,
		oauthClientId,
		grantId,
		userId: input.userId,
		scopes,
		expiresAt: new Date(now + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
		refreshTokenHash: hashOAuthSecret(refreshToken),
		refreshExpiresAt: refreshFamilyExpiresAt,
		refreshFamilyId,
		refreshFamilyExpiresAt,
		refreshParentTokenId: input.refreshParentTokenId ?? null,
		createdAt: new Date(now).toISOString(),
	});
	await updateGrantTokenIssuedAtBestEffort(grantId);
	await recordOAuthSecurityEvent({
		event: input.refreshParentTokenId ? "refresh_rotated" : "token_issued",
		grantId,
		userId: input.userId,
		oauthClientId,
		metadata: {
			tokenId,
			refreshFamilyId,
			...(input.refreshParentTokenId ? { parentTokenId: input.refreshParentTokenId } : {}),
		},
	});

	return {
		accessToken,
		tokenType: "Bearer",
		expiresIn: ACCESS_TOKEN_TTL_SECONDS,
		refreshToken,
		scope: scopes.join(" "),
	};
}

export interface ExchangeCodeInput {
	code: string;
	clientId: string;
	redirectUri: string;
	codeVerifier: string;
}

/**
 * Redeem an authorization code. Enforces single-use, expiry, exact client +
 * redirect match, and the PKCE S256 verifier. The code row is consumed before
 * the PKCE check so a failed exchange cannot be brute-forced repeatedly.
 */
export async function exchangeCodeForToken(input: ExchangeCodeInput): Promise<OAuthTokenPair> {
	if (!input.code || !input.codeVerifier) {
		throw new OAuthError("invalid_request", "code and code_verifier are required");
	}
	const client = await requireActiveClient(input.clientId);
	if (!client.grantTypes.includes("authorization_code")) {
		throw new OAuthError("unauthorized_client", "Client may not use the authorization_code grant");
	}

	const codeHash = hashOAuthSecret(input.code);
	const row = await db.query.oauthAuthorizationCodes.findFirst({
		where: eq(oauthAuthorizationCodes.codeHash, codeHash),
	});
	if (!row || row.consumedAt) {
		throw new OAuthError("invalid_grant", "Authorization code is invalid or already used");
	}
	if (Date.parse(row.expiresAt) <= Date.now()) {
		throw new OAuthError("invalid_grant", "Authorization code has expired");
	}
	if (row.clientId !== input.clientId || !secretsEqual(row.redirectUri, input.redirectUri)) {
		throw new OAuthError("invalid_grant", "client_id or redirect_uri does not match the code");
	}
	if (row.oauthClientId && row.oauthClientId !== client.id) {
		throw new OAuthError("invalid_grant", "Authorization code client binding is invalid");
	}
	if (row.grantId) {
		await requireActiveGrantBinding({
			grantId: row.grantId,
			oauthClientId: row.oauthClientId ?? client.id,
			userId: row.userId,
		});
	}

	// Consume with a compare-and-set before checking the verifier. Exactly one
	// concurrent exchange can win, and a bad verifier still burns the code.
	const [consumed] = await db
		.update(oauthAuthorizationCodes)
		.set({ consumedAt: new Date().toISOString() })
		.where(and(eq(oauthAuthorizationCodes.id, row.id), isNull(oauthAuthorizationCodes.consumedAt)))
		.returning({ id: oauthAuthorizationCodes.id });
	if (!consumed) {
		throw new OAuthError("invalid_grant", "Authorization code is invalid or already used");
	}

	if (!verifyPkceChallenge(input.codeVerifier, row.codeChallenge)) {
		throw new OAuthError("invalid_grant", "code_verifier does not match code_challenge");
	}

	return issueTokenPair({
		clientId: row.clientId,
		oauthClientId: row.oauthClientId ?? client.id,
		grantId: row.grantId,
		userId: row.userId,
		scopes: row.scopes,
	});
}

export interface RefreshAccessTokenInput {
	refreshToken: string;
	clientId: string;
}

async function revokeRefreshFamilyForReuse(
	row: typeof oauthAccessTokens.$inferSelect,
): Promise<void> {
	const now = new Date().toISOString();
	const familyId = row.refreshFamilyId ?? row.id;
	await db
		.update(oauthAccessTokens)
		.set({
			refreshFamilyRevokedAt: now,
			refreshReuseDetectedAt: now,
			revokedByType: "system",
			revokedReason: "Refresh token reuse detected",
		})
		.where(eq(oauthAccessTokens.id, familyId));
	eventBus.emit({
		type: "oauth:token_invalidated",
		tokenId: row.id,
		refreshFamilyId: familyId,
		reasonCode: "refresh_reuse_detected",
	});
	await recordOAuthSecurityEvent({
		event: "refresh_reuse_detected",
		grantId: row.grantId,
		userId: row.userId,
		oauthClientId: row.oauthClientId,
		metadata: { refreshFamilyId: familyId },
	});
	if (row.grantId) {
		const { propagateOAuthGrantRevocation } = await import("../services/oauth-runtime-revocation");
		await propagateOAuthGrantRevocation([row.grantId], "OAuth refresh token reuse detected");
	}
	logger.warn("OAuth refresh token reuse detected", {
		grantId: row.grantId,
		oauthClientId: row.oauthClientId,
		refreshFamilyId: familyId,
	});
}

/**
 * Rotate a refresh token: the old row is revoked and a fresh access+refresh
 * pair is issued for the same grant. Presenting a previously-rotated (now
 * revoked) refresh token fails with invalid_grant.
 */
export async function refreshAccessToken(input: RefreshAccessTokenInput): Promise<OAuthTokenPair> {
	if (!input.refreshToken) {
		throw new OAuthError("invalid_request", "refresh_token is required");
	}
	const client = await requireActiveClient(input.clientId);
	if (!client.grantTypes.includes("refresh_token")) {
		throw new OAuthError("unauthorized_client", "Client may not use the refresh_token grant");
	}

	const refreshHash = hashOAuthSecret(input.refreshToken);
	const row = await db.query.oauthAccessTokens.findFirst({
		where: eq(oauthAccessTokens.refreshTokenHash, refreshHash),
	});
	if (!row) {
		throw new OAuthError("invalid_grant", "Refresh token is invalid or revoked");
	}
	if (row.revokedAt) {
		if (row.refreshUsedAt) {
			await revokeRefreshFamilyForReuse(row);
			throw new OAuthError("invalid_grant", "Refresh token reuse detected");
		}
		throw new OAuthError("invalid_grant", "Refresh token is invalid or revoked");
	}
	const familyId = row.refreshFamilyId ?? row.id;
	const familyRoot = await db.query.oauthAccessTokens.findFirst({
		where: eq(oauthAccessTokens.id, familyId),
	});
	if (!familyRoot || familyRoot.refreshFamilyRevokedAt) {
		throw new OAuthError("invalid_grant", "Refresh token family is revoked");
	}
	const familyExpiresAt = row.refreshFamilyExpiresAt ?? row.refreshExpiresAt;
	if (!familyExpiresAt || Date.parse(familyExpiresAt) <= Date.now()) {
		throw new OAuthError("invalid_grant", "Refresh token has expired");
	}
	if (row.grantId) {
		await requireActiveGrantBinding({
			grantId: row.grantId,
			oauthClientId: row.oauthClientId ?? client.id,
			userId: row.userId,
		});
	}
	await updateLastUsedAtBestEffort({
		tokenId: row.id,
		oauthClientId: row.oauthClientId ?? client.id,
		grantId: row.grantId,
	});

	const consumedAt = new Date().toISOString();
	const [consumed] = await db
		.update(oauthAccessTokens)
		.set({
			revokedAt: consumedAt,
			refreshUsedAt: consumedAt,
			revokedByType: "system",
			revokedReason: "Refresh token rotated",
		})
		.where(and(eq(oauthAccessTokens.id, row.id), isNull(oauthAccessTokens.revokedAt)))
		.returning({ id: oauthAccessTokens.id });
	if (!consumed) {
		const raced = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.id, row.id),
		});
		if (raced) await revokeRefreshFamilyForReuse(raced);
		throw new OAuthError("invalid_grant", "Refresh token reuse detected");
	}
	eventBus.emit({
		type: "oauth:token_invalidated",
		tokenId: row.id,
		refreshFamilyId: familyId,
		reasonCode: "refresh_rotated",
	});

	return issueTokenPair({
		clientId: row.clientId,
		oauthClientId: row.oauthClientId ?? client.id,
		grantId: row.grantId,
		userId: row.userId,
		scopes: row.scopes,
		refreshFamilyId: familyId,
		refreshParentTokenId: row.id,
		refreshFamilyExpiresAt: familyExpiresAt,
	});
}

async function revokeTokenRow(
	row: Pick<
		typeof oauthAccessTokens.$inferSelect,
		"id" | "grantId" | "userId" | "oauthClientId" | "refreshFamilyId" | "revokedAt"
	>,
	kind: "access" | "refresh",
	now: string,
): Promise<void> {
	const familyId = row.refreshFamilyId ?? row.id;
	await db
		.update(oauthAccessTokens)
		.set({ refreshFamilyRevokedAt: now })
		.where(eq(oauthAccessTokens.id, familyId));
	if (!row.revokedAt) {
		await db
			.update(oauthAccessTokens)
			.set({ revokedAt: now })
			.where(eq(oauthAccessTokens.id, row.id));
	}
	eventBus.emit({
		type: "oauth:token_invalidated",
		tokenId: row.id,
		refreshFamilyId: familyId,
		reasonCode: `${kind}_token_revoked`,
	});
	await recordOAuthSecurityEvent({
		event: "token_revoked",
		grantId: row.grantId,
		userId: row.userId,
		oauthClientId: row.oauthClientId,
		metadata: { tokenId: row.id, kind, refreshFamilyId: familyId },
	});
}

/** Revoke an access or refresh token. Unknown tokens are a silent no-op (RFC 7009). */
export async function revokeToken(tokenOrRefresh: string): Promise<void> {
	if (!tokenOrRefresh) return;
	const hash = hashOAuthSecret(tokenOrRefresh);
	const now = new Date().toISOString();

	const columns = {
		id: true,
		grantId: true,
		userId: true,
		oauthClientId: true,
		refreshFamilyId: true,
		revokedAt: true,
	} as const;
	const byAccess = await db.query.oauthAccessTokens.findFirst({
		where: eq(oauthAccessTokens.tokenHash, hash),
		columns,
	});
	if (byAccess) {
		await revokeTokenRow(byAccess, "access", now);
		return;
	}

	const byRefresh = await db.query.oauthAccessTokens.findFirst({
		where: eq(oauthAccessTokens.refreshTokenHash, hash),
		columns,
	});
	if (byRefresh) await revokeTokenRow(byRefresh, "refresh", now);
}

export interface ValidatedAccessToken {
	tokenId: string;
	userId: string;
	clientId: string;
	oauthClientId: string;
	grantId: string | null;
	refreshFamilyId: string | null;
	expiresAt: string;
	/** Live effective scopes: token ∩ grant (when present) ∩ client. */
	scopes: string[];
}

async function validateAccessTokenRow(
	row: typeof oauthAccessTokens.$inferSelect | undefined,
	updateTelemetry: boolean,
): Promise<ValidatedAccessToken | null> {
	if (!row || row.revokedAt) return null;
	if (Date.parse(row.expiresAt) <= Date.now()) return null;
	if (row.refreshFamilyId) {
		const familyRoot = await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.id, row.refreshFamilyId),
			columns: { refreshFamilyRevokedAt: true, refreshFamilyExpiresAt: true },
		});
		if (!familyRoot || familyRoot.refreshFamilyRevokedAt) return null;
		if (
			familyRoot.refreshFamilyExpiresAt &&
			Date.parse(familyRoot.refreshFamilyExpiresAt) <= Date.now()
		) {
			return null;
		}
	}

	const activeClient = await db.query.oauthClients.findFirst({
		where: and(
			row.oauthClientId
				? eq(oauthClients.id, row.oauthClientId)
				: eq(oauthClients.clientId, row.clientId),
			isNull(oauthClients.revokedAt),
		),
		columns: { id: true, clientId: true, scopes: true },
	});
	if (!activeClient || activeClient.clientId !== row.clientId) return null;

	let scopes = intersectScopes(row.scopes, activeClient.scopes);
	if (row.grantId) {
		let grant: ActiveGrantBinding;
		try {
			grant = await requireActiveGrantBinding({
				grantId: row.grantId,
				oauthClientId: activeClient.id,
				userId: row.userId,
			});
		} catch {
			return null;
		}
		scopes = intersectScopes(scopes, grant.scopes);
	}

	if (updateTelemetry) {
		await updateLastUsedAtBestEffort({
			tokenId: row.id,
			oauthClientId: activeClient.id,
			grantId: row.grantId,
		});
	}
	return {
		tokenId: row.id,
		userId: row.userId,
		clientId: row.clientId,
		oauthClientId: activeClient.id,
		grantId: row.grantId,
		refreshFamilyId: row.refreshFamilyId,
		expiresAt: row.expiresAt,
		scopes,
	};
}

/** Validate a plaintext bearer token and update low-frequency usage telemetry. */
export async function validateAccessToken(token: string): Promise<ValidatedAccessToken | null> {
	if (!token) return null;
	return validateAccessTokenRow(
		await db.query.oauthAccessTokens.findFirst({
			where: eq(oauthAccessTokens.tokenHash, hashOAuthSecret(token)),
		}),
		true,
	);
}

/** Revalidate a connected transport by non-secret token row ID without usage writes. */
export async function validateAccessTokenById(
	tokenId: string,
): Promise<ValidatedAccessToken | null> {
	if (!tokenId) return null;
	return validateAccessTokenRow(
		await db.query.oauthAccessTokens.findFirst({ where: eq(oauthAccessTokens.id, tokenId) }),
		false,
	);
}
