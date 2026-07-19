import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 0 OAuth security-matrix regression tests.
 *
 * The application is imported only after NARRAFORK_HOME points at a fresh temp
 * directory. This keeps the suite away from the developer's real database and
 * filesystem while preserving server/app.ts route order and middleware wiring.
 * Provisioning success cases deliberately use invalid bodies: they exercise the
 * real scope gate without creating a remote device or narrator (those legacy
 * tables may not exist in an older test schema).
 */
const previousHome = process.env.NARRAFORK_HOME;
const previousAllowMultiple = process.env.NARRAFORK_ALLOW_MULTIPLE;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-oauth-boundary-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const [
	{ app },
	{ db },
	{ oauthAccessTokens, oauthAuthorizationCodes, oauthClients, users },
	{ eq },
	{ sign },
	{ generateId },
	{ settings },
	{ exchangeCodeForToken, issueAuthorizationCode },
] = await Promise.all([
	import("../../app"),
	import("../../db"),
	import("../../db/schema"),
	import("drizzle-orm"),
	import("hono/jwt"),
	import("../../lib/id"),
	import("../../lib/settings"),
	import("../../lib/oauth-provider"),
]);

const CLIENT_ID = "oauth-boundary-test-client";
const REDIRECT_URI = "http://127.0.0.1:9876/oauth/callback";
const USERNAME = "oauth-boundary-user";
const ADMIN_USERNAME = "oauth-boundary-admin";

let userId = "";
let adminId = "";

async function ensureActors(): Promise<void> {
	const now = new Date().toISOString();
	userId = generateId();
	adminId = generateId();
	await db.insert(users).values([
		{
			id: userId,
			username: USERNAME,
			passwordHash: "not-a-real-hash",
			role: "user",
			createdAt: now,
		},
		{
			id: adminId,
			username: ADMIN_USERNAME,
			passwordHash: "not-a-real-hash",
			role: "admin",
			createdAt: now,
		},
	]);
	await db.insert(oauthClients).values({
		id: generateId(),
		clientId: CLIENT_ID,
		name: "OAuth Boundary Test Client",
		redirectUris: [REDIRECT_URI],
		scopes: ["device:manage", "narrator:use"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		createdBy: adminId,
		createdAt: now,
		updatedAt: now,
	});
}

async function sessionToken(actorId: string, role: "admin" | "user"): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: actorId, role, iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

async function oauthToken(actorId: string, scopes: string[]): Promise<string> {
	const verifier = `oauth-boundary-verifier-${scopes.join("-") || "none"}-${actorId}`;
	const challenge = Buffer.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
	).toString("base64url");
	const { code } = await issueAuthorizationCode({
		clientId: CLIENT_ID,
		userId: actorId,
		redirectUri: REDIRECT_URI,
		scopes,
		codeChallenge: challenge,
	});
	const pair = await exchangeCodeForToken({
		code,
		clientId: CLIENT_ID,
		redirectUri: REDIRECT_URI,
		codeVerifier: verifier,
	});
	return pair.accessToken;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

async function responseCode(response: Response): Promise<string | undefined> {
	const body = (await response.json().catch(() => ({}))) as { code?: unknown };
	return typeof body.code === "string" ? body.code : undefined;
}

beforeAll(async () => {
	await ensureActors();
});

afterAll(async () => {
	await db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.clientId, CLIENT_ID));
	await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.clientId, CLIENT_ID));
	await db.delete(oauthClients).where(eq(oauthClients.clientId, CLIENT_ID));
	await db.delete(users).where(eq(users.id, adminId));
	await db.delete(users).where(eq(users.id, userId));

	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	if (previousAllowMultiple === undefined) delete process.env.NARRAFORK_ALLOW_MULTIPLE;
	else process.env.NARRAFORK_ALLOW_MULTIPLE = previousAllowMultiple;
	rmSync(testHome, { recursive: true, force: true });
});

describe("OAuth boundary security matrix", () => {
	test("OAuth tokens cannot access ordinary or admin representative APIs", async () => {
		const tokens = {
			"empty-scope": await oauthToken(userId, []),
			"device-manage": await oauthToken(userId, ["device:manage"]),
			"narrator-use": await oauthToken(userId, ["narrator:use"]),
			"admin-user-oauth": await oauthToken(adminId, ["device:manage", "narrator:use"]),
		};

		const failures: string[] = [];
		for (const [label, token] of Object.entries(tokens)) {
			const ordinary = await app.request("/api/narrators?standalone=true&limit=1", {
				headers: bearer(token),
			});
			if (![401, 403].includes(ordinary.status)) {
				failures.push(`${label} ordinary API returned ${ordinary.status}`);
			}

			const admin = await app.request("/api/admin/users", { headers: bearer(token) });
			if (![401, 403].includes(admin.status)) {
				failures.push(`${label} admin API returned ${admin.status}`);
			}
		}
		expect(failures).toEqual([]);
	});

	test("OAuth access tokens cannot execute consent, while session JWTs retain access", async () => {
		const token = await oauthToken(userId, ["device:manage"]);
		const consent = await app.request("/api/oauth/authorize", {
			method: "POST",
			headers: { ...bearer(token), "Content-Type": "application/json" },
			body: JSON.stringify({ approve: true }),
		});
		expect(consent.status).toBe(401);
		expect(await responseCode(consent)).toBe("SESSION_REQUIRED");

		const session = await sessionToken(userId, "user");
		const ordinary = await app.request("/api/narrators?standalone=true&limit=1", {
			headers: bearer(session),
		});
		expect(ordinary.status).toBe(200);

		const adminSession = await sessionToken(adminId, "admin");
		const admin = await app.request("/api/admin/users", {
			headers: bearer(adminSession),
		});
		expect(admin.status).toBe(200);
	});

	test("mounts External v1 as OAuth-only before the session API boundary", async () => {
		const session = await sessionToken(userId, "user");
		const sessionResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(session),
		});
		expect(sessionResponse.status).toBe(401);
		expect(await responseCode(sessionResponse)).toBe("OAUTH_REQUIRED");

		const grantless = await oauthToken(userId, ["device:manage"]);
		const oauthResponse = await app.request("/api/external/v1/projects", {
			headers: bearer(grantless),
		});
		expect(oauthResponse.status).toBe(403);
		expect(await responseCode(oauthResponse)).toBe("OAUTH_LEGACY_GRANT_FORBIDDEN");
	});

	test("grant-less OAuth tokens cannot use deprecated provisioning regardless of scope or role", async () => {
		const tokens = [
			await oauthToken(userId, []),
			await oauthToken(userId, ["device:manage"]),
			await oauthToken(userId, ["narrator:use"]),
			await oauthToken(adminId, ["device:manage", "narrator:use"]),
		];
		for (const token of tokens) {
			for (const [path, body] of [
				["/api/oauth/provision/device", { label: "INVALID LABEL!" }],
				["/api/oauth/provision/narrator", { deviceRef: "" }],
			] as const) {
				const response = await app.request(path, {
					method: "POST",
					headers: { ...bearer(token), "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(403);
				expect(await responseCode(response)).toBe("OAUTH_LEGACY_GRANT_FORBIDDEN");
			}
		}
	});
});
