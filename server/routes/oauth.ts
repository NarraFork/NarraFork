/**
 * OAuth 2.0 provider endpoints (RFC 6749 + RFC 7636 PKCE + RFC 8414 metadata).
 *
 * NarraFork is the authorization server: external applications obtain tokens
 * here and then call the NarraFork API with them. Mounting in app.ts keeps
 * /token, /revoke and the well-known document public (before the global auth
 * gate), while POST /authorize runs requireAuth itself.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db";
import { oauthGrants, projects, users } from "../db/schema";
import { verifyToken } from "../lib/auth";
import { getClientIp } from "../lib/client-ip";
import { ValidationError } from "../lib/errors";
import { generateId } from "../lib/id";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	exchangeCodeForToken,
	issueAuthorizationCode,
	OAUTH_EXTERNAL_V1_SCOPES,
	OAUTH_SUPPORTED_SCOPES,
	OAuthError,
	parseScopes,
	refreshAccessToken,
	requireActiveClient,
	requireAllowedRedirectUri,
	requireValidScopes,
	revokeToken,
} from "../lib/oauth-provider";
import { oauthRateLimit } from "../lib/oauth-rate-limit";
import { requireSessionAuth } from "../middleware/auth";
import {
	createOAuthGrant,
	oauthGrantService,
	recordDeniedGrantEvent,
} from "../services/oauth-grant-service";

/** RFC 6749 §5.2 JSON error body for OAuth endpoint failures. */
function oauthErrorResponse(c: Context, err: OAuthError) {
	return c.json(
		{ error: err.oauthError, error_description: err.message },
		err.oauthError === "invalid_client" ? 401 : 400,
	);
}

/**
 * Resolve the signed-in user from the session JWT without throwing. OAuth
 * access tokens are deliberately NOT accepted on the consent endpoints — a
 * third-party token must never be able to mint new grants.
 */
async function getSessionUser(c: Context): Promise<{ id: string; username: string } | null> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const token = header.slice(7);
	// Session JWTs are compact JWS (three base64url segments). Skip the verify
	// round-trip for opaque bearer strings like OAuth access tokens.
	if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return null;
	try {
		const payload = await verifyToken(token);
		const row = await db.query.users.findFirst({
			where: eq(users.id, payload.sub),
			columns: { id: true, username: true },
		});
		return row ?? null;
	} catch {
		return null;
	}
}

interface AuthorizationRequestInput {
	response_type?: unknown;
	client_id?: unknown;
	redirect_uri?: unknown;
	scope?: unknown;
	code_challenge?: unknown;
	code_challenge_method?: unknown;
	state?: unknown;
}

interface ValidatedAuthorizationRequest {
	client: Awaited<ReturnType<typeof requireActiveClient>>;
	redirectUri: string;
	scopes: string[];
	codeChallenge: string;
	codeChallengeMethod: "S256";
	state: string | null;
}

const MAX_AUDIT_USER_AGENT_CHARS = 512;
const MAX_AUDIT_REQUEST_ID_CHARS = 256;
const MAX_OAUTH_PROJECTS = 100;
const MAX_FORWARDED_ORIGIN_HEADER_CHARS = 2_048;
const MAX_FORWARDED_ORIGIN_HOPS = 20;

function rightmostForwardedHeaderValue(raw: string): string | null {
	if (raw.length > MAX_FORWARDED_ORIGIN_HEADER_CHARS) return null;
	const values = raw.split(",");
	if (values.length > MAX_FORWARDED_ORIGIN_HOPS) return null;
	return values.at(-1)?.trim() || null;
}

/**
 * Resolve the browser-visible origin used by RFC 8414 metadata. Forwarded
 * origin headers are accepted only when the Bun socket boundary marked the
 * immediate peer as a configured trusted proxy. The rightmost value belongs
 * to the closest proxy, avoiding a caller-prepended spoofed value.
 */
function resolveDiscoveryOrigin(c: Context): URL {
	const requestUrl = new URL(c.req.url);
	const directOrigin = new URL(requestUrl.origin);
	const env = c.env as { trustedProxy?: unknown } | undefined;
	if (env?.trustedProxy !== true) return directOrigin;

	const forwardedProtoHeader = c.req.header("X-Forwarded-Proto");
	const forwardedHostHeader = c.req.header("X-Forwarded-Host");
	let protocol = requestUrl.protocol;
	let host = requestUrl.host;

	if (forwardedProtoHeader !== undefined) {
		const forwardedProto = rightmostForwardedHeaderValue(forwardedProtoHeader)?.toLowerCase();
		if (forwardedProto !== "http" && forwardedProto !== "https") return directOrigin;
		protocol = `${forwardedProto}:`;
	}
	if (forwardedHostHeader !== undefined) {
		const forwardedHost = rightmostForwardedHeaderValue(forwardedHostHeader);
		if (!forwardedHost) return directOrigin;
		host = forwardedHost;
	}

	try {
		const publicOrigin = new URL(`${protocol}//${host}`);
		if (publicOrigin.protocol !== "http:" && publicOrigin.protocol !== "https:") {
			return directOrigin;
		}
		if (
			publicOrigin.username ||
			publicOrigin.password ||
			publicOrigin.pathname !== "/" ||
			publicOrigin.search ||
			publicOrigin.hash
		) {
			return directOrigin;
		}
		return publicOrigin;
	} catch {
		return directOrigin;
	}
}

function oauthString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) {
		throw new OAuthError("invalid_request", `${field} is required`);
	}
	return value;
}

function oauthScopeInput(value: unknown): string | string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.every((scope) => typeof scope === "string")) {
		return value as string[];
	}
	throw new OAuthError("invalid_request", "scope must be a string");
}

async function validateAuthorizationRequest(
	input: AuthorizationRequestInput,
	options: { requireResponseType: boolean },
): Promise<ValidatedAuthorizationRequest> {
	if (
		(options.requireResponseType && input.response_type !== "code") ||
		(input.response_type !== undefined && input.response_type !== "code")
	) {
		throw new OAuthError("invalid_request", "Only response_type=code is supported");
	}

	const client = await requireActiveClient(oauthString(input.client_id, "client_id"));
	if (!client.grantTypes.includes("authorization_code")) {
		throw new OAuthError("unauthorized_client", "Client may not use the authorization_code grant");
	}
	const redirectUri = oauthString(input.redirect_uri, "redirect_uri");
	requireAllowedRedirectUri(client, redirectUri);
	const scopes = requireValidScopes(client, parseScopes(oauthScopeInput(input.scope)));
	const codeChallenge = oauthString(input.code_challenge, "code_challenge");
	if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) {
		throw new OAuthError("invalid_request", "code_challenge is not a valid PKCE challenge");
	}
	const codeChallengeMethod = input.code_challenge_method ?? "S256";
	if (codeChallengeMethod !== "S256") {
		throw new OAuthError("invalid_request", "Only S256 code_challenge_method is supported");
	}
	if (input.state !== undefined && typeof input.state !== "string") {
		throw new OAuthError("invalid_request", "state must be a string");
	}
	return {
		client,
		redirectUri,
		scopes,
		codeChallenge,
		codeChallengeMethod,
		state: typeof input.state === "string" ? input.state : null,
	};
}

async function getActiveGrant(userId: string, oauthClientId: string) {
	return db.query.oauthGrants.findFirst({
		where: and(
			eq(oauthGrants.userId, userId),
			eq(oauthGrants.oauthClientId, oauthClientId),
			isNull(oauthGrants.revokedAt),
		),
	});
}

function auditContext(c: Context): {
	ipAddress: string;
	userAgent: string | null;
	requestId: string;
} {
	const userAgent = c.req.header("User-Agent")?.slice(0, MAX_AUDIT_USER_AGENT_CHARS) ?? null;
	const requestId =
		c.req.header("X-Request-Id")?.slice(0, MAX_AUDIT_REQUEST_ID_CHARS) || generateId();
	return { ipAddress: getClientIp(c), userAgent, requestId };
}

function buildRedirect(
	redirectUri: string,
	params: { code?: string; error?: string; state: string | null },
): string {
	const redirect = new URL(redirectUri);
	if (params.code) redirect.searchParams.set("code", params.code);
	if (params.error) redirect.searchParams.set("error", params.error);
	if (params.state !== null) redirect.searchParams.set("state", params.state);
	return redirect.toString();
}

async function validateProjectIds(projectIds: unknown): Promise<string[]> {
	if (
		!Array.isArray(projectIds) ||
		!projectIds.every((projectId) => typeof projectId === "string")
	) {
		throw new OAuthError("invalid_request", "project_ids must be an array of strings");
	}
	const normalized = [...new Set((projectIds as string[]).map((projectId) => projectId.trim()))];
	if (normalized.some((projectId) => !projectId)) {
		throw new OAuthError("invalid_request", "project_ids must not contain empty values");
	}
	if (normalized.length > MAX_OAUTH_PROJECTS) {
		throw new OAuthError(
			"invalid_request",
			`project_ids cannot contain more than ${MAX_OAUTH_PROJECTS} projects`,
		);
	}
	if (normalized.length === 0) return normalized;
	const rows = await db.query.projects.findMany({
		where: inArray(projects.id, normalized),
		columns: { id: true },
		limit: MAX_OAUTH_PROJECTS,
	});
	const existing = new Set(rows.map((project) => project.id));
	const missing = normalized.find((projectId) => !existing.has(projectId));
	if (missing) throw new OAuthError("invalid_request", `Unknown project: ${missing}`);
	return normalized;
}

export const oauthRoutes = new Hono();

oauthRoutes.use(
	"*",
	bodyLimit({
		maxSize: 64 * 1024,
		onError: (c) =>
			c.json({ error: "invalid_request", error_description: "OAuth request is too large" }, 413),
	}),
);

/**
 * RFC 8414 authorization server metadata. The issuer uses the direct request
 * origin, or the public origin supplied by an explicitly trusted reverse proxy.
 */
oauthRoutes.get("/.well-known/oauth-authorization-server", (c) => {
	const publicOrigin = resolveDiscoveryOrigin(c);
	const issuer = publicOrigin.origin;
	const webSocketProtocol = publicOrigin.protocol === "https:" ? "wss:" : "ws:";
	return c.json({
		issuer,
		// The authorization endpoint is the browser-facing consent page. That page
		// calls the JSON API under /api/oauth/authorize after the user signs in.
		// Keeping the UI URL here lets native clients open a real consent screen
		// instead of receiving a JSON 401 response in the system browser.
		authorization_endpoint: `${issuer}/oauth/authorize`,
		token_endpoint: `${issuer}/api/oauth/token`,
		revocation_endpoint: `${issuer}/api/oauth/revoke`,
		response_types_supported: ["code"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		scopes_supported: [...OAUTH_SUPPORTED_SCOPES],
		code_challenge_methods_supported: ["S256"],
		token_endpoint_auth_methods_supported: ["none"],
		revocation_endpoint_auth_methods_supported: ["none"],
		narrafork_external_api: {
			version: "v1",
			base_url: `${issuer}/api/external/v1`,
			websocket_url: `${webSocketProtocol}//${publicOrigin.host}/ws/external/v1/narrators`,
			websocket_ticket_endpoint: `${issuer}/api/external/v1/ws-tickets`,
			recommended_scopes: [...OAUTH_EXTERNAL_V1_SCOPES],
		},
	});
});

/**
 * Validate an authorization request and return what the consent screen needs.
 * Without a session this answers 401 (the frontend sends the user to login
 * first, preserving the query); with a session the frontend renders the
 * approve/deny dialog from this payload and posts back to POST /authorize.
 */
oauthRoutes.get("/authorize", oauthRateLimit("authorize"), async (c) => {
	const query = c.req.query();
	try {
		const request = await validateAuthorizationRequest(query, { requireResponseType: true });
		const user = await getSessionUser(c);
		if (!user) {
			return c.json(
				{
					error: "login_required",
					error_description: "Sign in to NarraFork before authorizing this application.",
				},
				401,
			);
		}

		const activeGrant = await getActiveGrant(user.id, request.client.id);
		const activeGrantView = activeGrant
			? await oauthGrantService.getUserGrant(user.id, activeGrant.id)
			: null;
		const existingScopes = activeGrantView?.scopes ?? [];
		const selectedProjectIds = activeGrantView?.projectIds ?? [];
		const availableProjects = await db.query.projects.findMany({
			where: eq(projects.status, "active"),
			columns: { id: true, name: true },
			orderBy: (table, { asc }) => [asc(table.name), asc(table.id)],
			limit: MAX_OAUTH_PROJECTS,
		});

		return c.json({
			client: {
				clientId: request.client.clientId,
				name: request.client.name,
				policy: request.client.policyJson ?? null,
			},
			scopes: request.scopes,
			existingScopes,
			newScopes: request.scopes.filter((scope) => !existingScopes.includes(scope)),
			projects: availableProjects,
			selectedProjectIds,
			consentRequired: true,
			state: request.state,
			user: { username: user.username },
		});
	} catch (err) {
		if (err instanceof OAuthError) return oauthErrorResponse(c, err);
		throw err;
	}
});

/** Signed-in user confirms or denies the grant; approval issues the code. */
oauthRoutes.post(
	"/authorize",
	oauthRateLimit("authorize"),
	requireSessionAuth,
	oauthRateLimit("authorize", { includePrincipal: true }),
	async (c) => {
		try {
			let rawBody: unknown;
			try {
				rawBody = await c.req.json();
			} catch {
				throw new OAuthError("invalid_request", "Invalid JSON body");
			}
			if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
				throw new OAuthError("invalid_request", "Request body must be a JSON object");
			}
			const body = rawBody as Record<string, unknown>;
			const request = await validateAuthorizationRequest(body, { requireResponseType: false });
			if (body.approve !== true && body.approve !== false) {
				throw new OAuthError("invalid_request", "approve must be a boolean");
			}
			const userId = c.get("user").sub;
			const activeGrant = await getActiveGrant(userId, request.client.id);
			const audit = auditContext(c);

			if (body.approve === false) {
				await recordDeniedGrantEvent({
					grantId: activeGrant?.id ?? null,
					oauthClientId: request.client.id,
					userId,
					actorType: "user",
					actorUserId: userId,
					requestedScopes: request.scopes,
					grantedScopes: [],
					reason: "User denied the OAuth authorization request",
					ipAddress: audit.ipAddress,
					userAgent: audit.userAgent,
					requestId: audit.requestId,
				});
				return c.json({
					redirect: buildRedirect(request.redirectUri, {
						error: "access_denied",
						state: request.state,
					}),
				});
			}

			const projectIds = await validateProjectIds(body.project_ids);
			const grant = await createOAuthGrant({
				userId,
				oauthClientId: request.client.id,
				scopes: request.scopes,
				projectIds,
				policyJson: request.client.policyJson ?? null,
				actorType: "user",
				actorUserId: userId,
				requestId: audit.requestId,
				ipAddress: audit.ipAddress,
				userAgent: audit.userAgent,
			});
			const { code } = await issueAuthorizationCode({
				clientId: request.client.clientId,
				oauthClientId: request.client.id,
				grantId: grant.id,
				userId,
				redirectUri: request.redirectUri,
				scopes: request.scopes,
				codeChallenge: request.codeChallenge,
				codeChallengeMethod: request.codeChallengeMethod,
			});

			return c.json({
				redirect: buildRedirect(request.redirectUri, { code, state: request.state }),
			});
		} catch (err) {
			if (err instanceof OAuthError) return oauthErrorResponse(c, err);
			if (err instanceof ValidationError) {
				return oauthErrorResponse(c, new OAuthError("invalid_request", err.message));
			}
			throw err;
		}
	},
);

function readFormString(form: Record<string, string | File>, key: string): string {
	const value = form[key];
	return typeof value === "string" ? value : "";
}

/** Public token endpoint (RFC 6749 §5): authorization_code + refresh_token grants. */
oauthRoutes.post("/token", oauthRateLimit("token"), async (c) => {
	const form = await c.req.parseBody();
	try {
		const grantType = readFormString(form, "grant_type");
		const clientId = readFormString(form, "client_id");
		let pair: Awaited<ReturnType<typeof exchangeCodeForToken>>;
		if (grantType === "authorization_code") {
			pair = await exchangeCodeForToken({
				code: readFormString(form, "code"),
				clientId,
				redirectUri: readFormString(form, "redirect_uri"),
				codeVerifier: readFormString(form, "code_verifier"),
			});
		} else if (grantType === "refresh_token") {
			pair = await refreshAccessToken({
				refreshToken: readFormString(form, "refresh_token"),
				clientId,
			});
		} else {
			throw new OAuthError(
				"unsupported_grant_type",
				"grant_type must be authorization_code or refresh_token",
			);
		}
		return c.json({
			access_token: pair.accessToken,
			token_type: pair.tokenType,
			expires_in: pair.expiresIn,
			refresh_token: pair.refreshToken,
			scope: pair.scope,
		});
	} catch (err) {
		if (err instanceof OAuthError) return oauthErrorResponse(c, err);
		throw err;
	}
});

/** Public revocation endpoint (RFC 7009): always answers 200, even for unknown tokens. */
oauthRoutes.post("/revoke", oauthRateLimit("revoke"), async (c) => {
	const form = await c.req.parseBody();
	await revokeToken(readFormString(form, "token"));
	return c.json({ revoked: true });
});

export { ACCESS_TOKEN_TTL_SECONDS };
