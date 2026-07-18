import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { db } from "../../db";
import {
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	oauthSecurityEvents,
	projects,
	users,
} from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import {
	hashOAuthSecret,
	OAUTH_EXTERNAL_V1_SCOPES,
	OAUTH_LEGACY_SCOPES,
	OAUTH_SUPPORTED_SCOPES,
} from "../../lib/oauth-provider";
import { oauthRateLimitTesting } from "../../lib/oauth-rate-limit";
import { settings } from "../../lib/settings";
import { requireAuth } from "../../middleware/auth";
import { createOAuthGrant } from "../../services/oauth-grant-service";
import { oauthRoutes } from "../oauth";

const CLIENT_ID = "robot-assistant-routes";
const REDIRECT_URI = "http://127.0.0.1:9876/oauth/callback";
const USERNAME = "oauth-routes-test-user";
const PROJECT_ALPHA = "oauth-routes-project-alpha";
const PROJECT_BETA = "oauth-routes-project-beta";
const PROJECT_ARCHIVED = "oauth-routes-project-archived";
const UNKNOWN_PROJECT = "oauth-routes-project-missing";

let clientDbId = "";

const app = new Hono();
app.route("/api/oauth", oauthRoutes);
// Probe endpoint to verify OAuth access tokens authenticate against requireAuth.
app.get("/api/probe", requireAuth, (c) => {
	const oauth = c.get("oauth");
	return c.json({ sub: c.get("user").sub, clientId: oauth?.clientId ?? null });
});
// Mirror the production global error mapping so 401 AppErrors surface as 401,
// not 500, in these tests.
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

let userId = "";

function base64url(buf: Buffer): string {
	return buf.toString("base64url");
}

function pkceChallenge(verifier: string): string {
	return base64url(createHash("sha256").update(verifier).digest());
}

/** Sign a session JWT directly (createToken would pull in passkey/webauthn deps). */
function createSessionJwt(sub: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub, role: "user", iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

async function ensureUser(): Promise<string> {
	if (userId) return userId;
	const existing = await db.query.users.findFirst({ where: eq(users.username, USERNAME) });
	if (existing) {
		userId = existing.id;
		return userId;
	}
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: USERNAME,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return userId;
}

async function ensureClient(): Promise<void> {
	const now = new Date().toISOString();
	const createdBy = await ensureUser();
	await db
		.insert(oauthClients)
		.values({
			id: generateId(),
			clientId: CLIENT_ID,
			name: "Robot Assistant",
			redirectUris: [REDIRECT_URI],
			scopes: ["device:manage", "narrator:use"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			policyJson: { summary: "Routes test policy" } as Record<string, unknown>,
			createdBy,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing();
	const client = await db.query.oauthClients.findFirst({
		where: eq(oauthClients.clientId, CLIENT_ID),
	});
	if (!client) throw new Error("OAuth test client was not created");
	clientDbId = client.id;
	await db
		.update(oauthClients)
		.set({
			name: "Robot Assistant",
			redirectUris: [REDIRECT_URI],
			scopes: ["device:manage", "narrator:use"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			policyJson: { summary: "Routes test policy" } as Record<string, unknown>,
			revokedAt: null,
			updatedAt: now,
		})
		.where(eq(oauthClients.id, client.id));
	await db
		.insert(projects)
		.values([
			{
				id: PROJECT_ALPHA,
				name: "OAuth Routes Alpha",
				status: "active",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: PROJECT_BETA,
				name: "OAuth Routes Beta",
				status: "active",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: PROJECT_ARCHIVED,
				name: "OAuth Routes Archived",
				status: "archived",
				createdAt: now,
				updatedAt: now,
			},
		])
		.onConflictDoUpdate({
			target: projects.id,
			set: { name: "OAuth Routes Alpha", status: "active", updatedAt: now },
		});
	await db
		.update(projects)
		.set({ name: "OAuth Routes Beta", status: "active", updatedAt: now })
		.where(eq(projects.id, PROJECT_BETA));
	await db
		.update(projects)
		.set({ name: "OAuth Routes Archived", status: "archived", updatedAt: now })
		.where(eq(projects.id, PROJECT_ARCHIVED));
}

async function sessionHeader(): Promise<string> {
	return `Bearer ${await createSessionJwt(await ensureUser())}`;
}

/** Drive the full authorize → token exchange flow through the HTTP endpoints. */
async function runAuthorizeFlow(verifier: string): Promise<{
	token: Record<string, unknown>;
}> {
	const authRes = await app.request("/api/oauth/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
		body: JSON.stringify({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: "device:manage narrator:use",
			state: "state-123",
			code_challenge: pkceChallenge(verifier),
			code_challenge_method: "S256",
			project_ids: [PROJECT_ALPHA],
			approve: true,
		}),
	});
	expect(authRes.status).toBe(200);
	const { redirect } = (await authRes.json()) as { redirect: string };
	const code = new URL(redirect).searchParams.get("code");
	expect(code).toBeTruthy();

	const tokenRes = await app.request("/api/oauth/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code: code as string,
			redirect_uri: REDIRECT_URI,
			code_verifier: verifier,
		}),
	});
	expect(tokenRes.status).toBe(200);
	const token = (await tokenRes.json()) as Record<string, unknown>;
	return { token };
}

afterEach(async () => {
	oauthRateLimitTesting.resetNamespace("token");
	await db.delete(oauthSecurityEvents).where(eq(oauthSecurityEvents.endpoint, "token"));
	await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, CLIENT_ID));
	await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.clientId, CLIENT_ID));
	if (clientDbId) {
		const grantRows = await db.query.oauthGrants.findMany({
			where: eq(oauthGrants.oauthClientId, clientDbId),
			columns: { id: true },
		});
		const grantIds = grantRows.map((grant) => grant.id);
		await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientDbId));
		if (grantIds.length > 0) {
			await db.delete(oauthGrantProjects).where(inArray(oauthGrantProjects.grantId, grantIds));
			await db.delete(oauthGrants).where(inArray(oauthGrants.id, grantIds));
		}
	}
});

afterAll(async () => {
	if (clientDbId) {
		await db.delete(oauthClients).where(eq(oauthClients.id, clientDbId));
	}
	await db
		.delete(projects)
		.where(inArray(projects.id, [PROJECT_ALPHA, PROJECT_BETA, PROJECT_ARCHIVED]));
	if (userId) await db.delete(users).where(eq(users.id, userId));
});

describe("oauth routes", () => {
	test("serves RFC 8414 authorization server metadata anonymously", async () => {
		const res = await app.request(
			"http://narrafork.test/api/oauth/.well-known/oauth-authorization-server",
		);
		expect(res.status).toBe(200);
		const meta = (await res.json()) as Record<string, unknown>;
		expect(meta.issuer).toBe("http://narrafork.test");
		expect(meta.authorization_endpoint).toBe("http://narrafork.test/oauth/authorize");
		expect(meta.token_endpoint).toBe("http://narrafork.test/api/oauth/token");
		expect(meta.revocation_endpoint).toBe("http://narrafork.test/api/oauth/revoke");
		expect(meta.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
		expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
		expect(meta.scopes_supported).toEqual([...OAUTH_SUPPORTED_SCOPES]);
		expect(meta.narrafork_external_api).toEqual({
			version: "v1",
			base_url: "http://narrafork.test/api/external/v1",
			websocket_url: "ws://narrafork.test/ws/external/v1/narrators",
			websocket_ticket_endpoint: "http://narrafork.test/api/external/v1/ws-tickets",
			recommended_scopes: [...OAUTH_EXTERNAL_V1_SCOPES],
			deprecated_scopes: [...OAUTH_LEGACY_SCOPES],
			deprecated_provisioning_base_url: "http://narrafork.test/api/oauth/provision",
		});
	});

	test("GET /authorize validates the request and requires a session", async () => {
		await ensureClient();
		const base =
			`/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=device:manage` +
			`&code_challenge=${pkceChallenge("v")}&code_challenge_method=S256&state=s1`;

		const anon = await app.request(base);
		expect(anon.status).toBe(401);
		expect(((await anon.json()) as { error: string }).error).toBe("login_required");

		const signedIn = await app.request(base, {
			headers: { Authorization: await sessionHeader() },
		});
		expect(signedIn.status).toBe(200);
		const info = (await signedIn.json()) as {
			client: { clientId: string; name: string; policy: Record<string, unknown> };
			scopes: string[];
			existingScopes: string[];
			newScopes: string[];
			projects: Array<{ id: string; name: string }>;
			selectedProjectIds: string[];
			consentRequired: boolean;
			state: string;
		};
		expect(info.client).toEqual({
			clientId: CLIENT_ID,
			name: "Robot Assistant",
			policy: { summary: "Routes test policy" },
		});
		expect(info.scopes).toEqual(["device:manage"]);
		expect(info.existingScopes).toEqual([]);
		expect(info.newScopes).toEqual(["device:manage"]);
		expect(info.selectedProjectIds).toEqual([]);
		expect(info.consentRequired).toBe(true);
		expect(info.projects.some((project) => project.id === PROJECT_ALPHA)).toBe(true);
		expect(info.projects.some((project) => project.id === PROJECT_ARCHIVED)).toBe(false);
		expect(info.state).toBe("s1");

		const badClient = await app.request(base.replace(CLIENT_ID, "missing-client"), {
			headers: { Authorization: await sessionHeader() },
		});
		expect(badClient.status).toBe(401);
		expect(((await badClient.json()) as { error: string }).error).toBe("invalid_client");

		const badScope = await app.request(base.replace("scope=device:manage", "scope=root:all"), {
			headers: { Authorization: await sessionHeader() },
		});
		expect(badScope.status).toBe(400);
		expect(((await badScope.json()) as { error: string }).error).toBe("invalid_scope");
	});

	test("GET /authorize returns policy, existing access, and active project choices", async () => {
		await ensureClient();
		await createOAuthGrant({
			userId: await ensureUser(),
			oauthClientId: clientDbId,
			scopes: ["narrator:use"],
			projectIds: [PROJECT_BETA],
			policyJson: { summary: "Routes test policy" },
		});
		const query =
			`/api/oauth/authorize?response_type=code&client_id=${CLIENT_ID}` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=device:manage+narrator:use` +
			`&code_challenge=${pkceChallenge("existing-grant-verifier")}&code_challenge_method=S256`;
		const response = await app.request(query, {
			headers: { Authorization: await sessionHeader() },
		});
		expect(response.status).toBe(200);
		const info = (await response.json()) as {
			existingScopes: string[];
			newScopes: string[];
			projects: Array<{ id: string; name: string }>;
			selectedProjectIds: string[];
			consentRequired: boolean;
		};
		expect(info.existingScopes).toEqual(["narrator:use"]);
		expect(info.newScopes).toEqual(["device:manage"]);
		expect(info.selectedProjectIds).toEqual([PROJECT_BETA]);
		expect(info.consentRequired).toBe(true);
		expect(info.projects.length).toBeLessThanOrEqual(100);
		expect(info.projects.some((project) => project.id === PROJECT_ALPHA)).toBe(true);
		expect(info.projects.some((project) => project.id === PROJECT_BETA)).toBe(true);
		expect(info.projects.some((project) => project.id === PROJECT_ARCHIVED)).toBe(false);
		for (let index = 1; index < info.projects.length; index++) {
			const previous = info.projects[index - 1];
			const current = info.projects[index];
			expect(
				previous.name < current.name ||
					(previous.name === current.name && previous.id <= current.id),
			).toBe(true);
		}
	});

	test("POST /authorize safely redirects denial and records an audit event", async () => {
		await ensureClient();
		const requestId = "oauth-deny-request-123";
		const userAgent = "oauth-route-test-user-agent-".repeat(40);
		const deniedBody = {
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: "device:manage",
			state: "deny-state",
			code_challenge: pkceChallenge("deny-verifier"),
			code_challenge_method: "S256",
			approve: false,
		};

		const unsafe = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
			body: JSON.stringify({ ...deniedBody, redirect_uri: "https://attacker.example/callback" }),
		});
		expect(unsafe.status).toBe(400);
		expect(((await unsafe.json()) as { error: string }).error).toBe("invalid_request");

		const denied = await app.request(
			"/api/oauth/authorize",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: await sessionHeader(),
					"X-Request-Id": requestId,
					"User-Agent": userAgent,
				},
				body: JSON.stringify(deniedBody),
			},
			{ clientIp: "203.0.113.7" },
		);
		expect(denied.status).toBe(200);
		const deniedUrl = new URL(((await denied.json()) as { redirect: string }).redirect);
		expect(deniedUrl.origin + deniedUrl.pathname).toBe(REDIRECT_URI);
		expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
		expect(deniedUrl.searchParams.get("state")).toBe("deny-state");
		expect(deniedUrl.searchParams.get("code")).toBeNull();

		const event = await db.query.oauthGrantEvents.findFirst({
			where: eq(oauthGrantEvents.requestId, requestId),
		});
		expect(event).toMatchObject({
			eventType: "denied",
			oauthClientId: clientDbId,
			userId: await ensureUser(),
			requestedScopes: ["device:manage"],
			ipAddress: "203.0.113.7",
			requestId,
		});
		expect(event?.userAgent).toHaveLength(512);
	});

	test("POST /authorize creates a grant and binds the code to it", async () => {
		await ensureClient();
		const body = JSON.stringify({
			client_id: CLIENT_ID,
			redirect_uri: REDIRECT_URI,
			scope: "device:manage",
			state: "xyz",
			code_challenge: pkceChallenge("verifier-a"),
			code_challenge_method: "S256",
			project_ids: [PROJECT_ALPHA, PROJECT_ALPHA],
			approve: true,
		});

		const anon = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		});
		expect(anon.status).toBe(401);

		const ok = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
			body,
		});
		expect(ok.status).toBe(200);
		const { redirect } = (await ok.json()) as { redirect: string };
		const url = new URL(redirect);
		expect(url.origin + url.pathname).toBe(REDIRECT_URI);
		expect(url.searchParams.get("state")).toBe("xyz");
		const code = url.searchParams.get("code");
		expect(code?.startsWith("nfcode_")).toBe(true);

		const grant = await db.query.oauthGrants.findFirst({
			where: eq(oauthGrants.oauthClientId, clientDbId),
		});
		expect(grant).toMatchObject({
			userId: await ensureUser(),
			scopes: ["device:manage"],
			policyJson: { summary: "Routes test policy" },
		});
		const grantProject = await db.query.oauthGrantProjects.findFirst({
			where: eq(oauthGrantProjects.grantId, grant?.id ?? ""),
		});
		expect(grantProject?.projectId).toBe(PROJECT_ALPHA);
		const codeRow = await db.query.oauthAuthorizationCodes.findFirst({
			where: eq(oauthAuthorizationCodes.clientId, CLIENT_ID),
		});
		expect(codeRow).toMatchObject({ oauthClientId: clientDbId, grantId: grant?.id });
	});

	test("POST /authorize re-consents the active grant with updated scopes and projects", async () => {
		await ensureClient();
		const authorize = async (scope: string, projectId: string, verifier: string) => {
			const response = await app.request("/api/oauth/authorize", {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
				body: JSON.stringify({
					client_id: CLIENT_ID,
					redirect_uri: REDIRECT_URI,
					scope,
					code_challenge: pkceChallenge(verifier),
					project_ids: [projectId],
					approve: true,
				}),
			});
			expect(response.status).toBe(200);
		};

		await authorize("device:manage", PROJECT_ALPHA, "reconsent-one");
		const first = await db.query.oauthGrants.findFirst({
			where: eq(oauthGrants.oauthClientId, clientDbId),
		});
		expect(first).toBeTruthy();
		await authorize("narrator:use", PROJECT_BETA, "reconsent-two");

		const second = await db.query.oauthGrants.findFirst({
			where: eq(oauthGrants.oauthClientId, clientDbId),
		});
		expect(second?.id).toBe(first?.id);
		expect(second?.scopes).toEqual(["narrator:use"]);
		const selected = await db.query.oauthGrantProjects.findMany({
			where: eq(oauthGrantProjects.grantId, second?.id ?? ""),
		});
		expect(selected.map((project) => project.projectId)).toEqual([PROJECT_BETA]);
		const reconsentEvent = await db.query.oauthGrantEvents.findFirst({
			where: eq(oauthGrantEvents.grantId, second?.id ?? ""),
			orderBy: (table, { desc }) => [desc(table.createdAt)],
		});
		expect(reconsentEvent?.metadata).toMatchObject({
			action: "reconsent",
			previousScopes: ["device:manage"],
			previousProjectIds: [PROJECT_ALPHA],
		});
	});

	test("POST /authorize rejects an unknown project with RFC OAuth JSON", async () => {
		await ensureClient();
		const response = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				scope: "device:manage",
				code_challenge: pkceChallenge("unknown-project-verifier"),
				project_ids: [UNKNOWN_PROJECT],
				approve: true,
			}),
		});
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: string }).error).toBe("invalid_request");
		expect(
			await db.query.oauthGrants.findFirst({ where: eq(oauthGrants.oauthClientId, clientDbId) }),
		).toBeUndefined();
	});

	test("POST /authorize rejects OAuth access tokens as consent credentials", async () => {
		await ensureClient();
		const { token } = await runAuthorizeFlow("consent-token-verifier-0123456789");
		const response = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token.access_token}`,
			},
			body: JSON.stringify({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				scope: "device:manage",
				code_challenge: pkceChallenge("consent-token-verifier-0123456789"),
				approve: true,
			}),
		});

		expect(response.status).toBe(401);
		expect(((await response.json()) as { code: string }).code).toBe("SESSION_REQUIRED");
	});

	test("full code + PKCE flow, refresh rotation, revocation, and API access", async () => {
		await ensureClient();
		const verifier = "route-level-verifier-0123456789-abcdef";
		const { token } = await runAuthorizeFlow(verifier);
		expect(token.token_type).toBe("Bearer");
		expect(token.expires_in).toBe(3600);
		expect(token.scope).toBe("device:manage narrator:use");

		// The access token authenticates API calls through requireAuth.
		const probe = await app.request("/api/probe", {
			headers: { Authorization: `Bearer ${token.access_token}` },
		});
		expect(probe.status).toBe(200);
		const probeBody = (await probe.json()) as { sub: string; clientId: string };
		expect(probeBody.sub).toBe(await ensureUser());
		expect(probeBody.clientId).toBe(CLIENT_ID);

		// Refresh rotation.
		const refreshRes = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: token.refresh_token as string,
			}),
		});
		expect(refreshRes.status).toBe(200);
		const rotated = (await refreshRes.json()) as { access_token: string; refresh_token: string };
		expect(rotated.access_token).not.toBe(token.access_token);

		// Old access token is dead after rotation.
		const staleProbe = await app.request("/api/probe", {
			headers: { Authorization: `Bearer ${token.access_token}` },
		});
		expect(staleProbe.status).toBe(401);

		// Revoke the rotated access token (anonymous, RFC 7009 always 200).
		const revokeRes = await app.request("/api/oauth/revoke", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token: rotated.access_token }),
		});
		expect(revokeRes.status).toBe(200);
		const revokedProbe = await app.request("/api/probe", {
			headers: { Authorization: `Bearer ${rotated.access_token}` },
		});
		expect(revokedProbe.status).toBe(401);
	});

	test("token endpoint rejects a wrong PKCE verifier with invalid_grant", async () => {
		await ensureClient();
		const authRes = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				scope: "device:manage",
				code_challenge: pkceChallenge("right-verifier"),
				project_ids: [PROJECT_ALPHA],
				approve: true,
			}),
		});
		const { redirect } = (await authRes.json()) as { redirect: string };
		const code = new URL(redirect).searchParams.get("code") as string;

		const tokenRes = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: CLIENT_ID,
				code,
				redirect_uri: REDIRECT_URI,
				code_verifier: "wrong-verifier",
			}),
		});
		expect(tokenRes.status).toBe(400);
		expect(((await tokenRes.json()) as { error: string }).error).toBe("invalid_grant");
	});

	test("token rate limiting is audited once and does not consume an authorization code", async () => {
		await ensureClient();
		const verifier = "rate-limit-verifier-0123456789";
		const authRes = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: await sessionHeader() },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				redirect_uri: REDIRECT_URI,
				scope: "device:manage",
				code_challenge: pkceChallenge(verifier),
				project_ids: [PROJECT_ALPHA],
				approve: true,
			}),
		});
		const { redirect } = (await authRes.json()) as { redirect: string };
		const code = new URL(redirect).searchParams.get("code") as string;
		oauthRateLimitTesting.resetNamespace("token");
		const request = () =>
			app.request(
				"/api/oauth/token",
				{
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "client_credentials",
						client_id: CLIENT_ID,
					}),
				},
				{ clientIp: "198.51.100.77" },
			);
		for (let index = 0; index < 30; index++) expect((await request()).status).toBe(400);
		const limited = await request();
		expect(limited.status).toBe(429);
		expect(limited.headers.get("Retry-After")).toBeTruthy();
		expect((await request()).status).toBe(429);
		const codeRow = await db.query.oauthAuthorizationCodes.findFirst({
			where: eq(oauthAuthorizationCodes.codeHash, hashOAuthSecret(code)),
		});
		expect(codeRow?.consumedAt).toBeNull();
		const events = await db.query.oauthSecurityEvents.findMany({
			where: eq(oauthSecurityEvents.endpoint, "token"),
		});
		expect(events).toHaveLength(1);
		expect(JSON.stringify(events)).not.toContain(code);
	});

	test("token endpoint rejects unsupported grant types", async () => {
		const res = await app.request("/api/oauth/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "client_credentials", client_id: CLIENT_ID }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe("unsupported_grant_type");
	});
});
