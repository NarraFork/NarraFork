import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationCapabilityGrants,
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrantEvents,
	oauthGrants,
	users,
} from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import {
	exchangeCodeForToken,
	issueAuthorizationCode,
	issueTokenPair,
	refreshAccessToken,
	validateAccessToken,
} from "../../lib/oauth-provider";
import { settings } from "../../lib/settings";
import { requireSessionAuth } from "../../middleware/auth";
import { integrationAuthorityService } from "../../services/integration-authority-service";
import { oauthGrantRoutes } from "../oauth-grants";

const app = new Hono();
app.use("/api/*", requireSessionAuth);
app.route("/api/oauth/grants", oauthGrantRoutes);
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

const userId = generateId();
const otherUserId = generateId();
const createdClientIds = new Set<string>();
const createdPublicClientIds = new Set<string>();

interface TestGrant {
	id: string;
	oauthClientId: string;
	clientId: string;
	userId: string;
}

interface GrantResponse {
	id: string;
	client: { clientId: string; name: string };
	scopes: string[];
	projectIds: string[];
	consentedAt: string | null;
	lastUsedAt: string | null;
	status: "active" | "revoked";
	revokedAt: string | null;
	reason: string | null;
}

function bearer(token: string): Record<string, string> {
	return { Authorization: `Bearer ${token}` };
}

async function sessionToken(actorId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: actorId, role: "user", iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

async function sessionHeaders(actorId: string): Promise<Record<string, string>> {
	return {
		...bearer(await sessionToken(actorId)),
		"Content-Type": "application/json",
	};
}

async function insertGrants(actorId: string, count: number): Promise<TestGrant[]> {
	const now = new Date().toISOString();
	const grants = Array.from({ length: count }, (_, index) => {
		const oauthClientId = generateId();
		const grantId = generateId();
		const clientId = `oauth-grants-route-${oauthClientId.slice(0, 10)}-${index}`;
		return { id: grantId, oauthClientId, clientId, userId: actorId };
	});

	await db.insert(oauthClients).values(
		grants.map((grant, index) => ({
			id: grant.oauthClientId,
			clientId: grant.clientId,
			name: `Connected App ${index}`,
			redirectUris: ["http://127.0.0.1:9876/oauth/callback"],
			scopes: ["device.provision", "narrator.provision"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: actorId,
			createdAt: now,
			updatedAt: now,
		})),
	);
	for (const grant of grants) {
		createdClientIds.add(grant.oauthClientId);
		createdPublicClientIds.add(grant.clientId);
	}
	await db.insert(oauthGrants).values(
		grants.map((grant) => ({
			id: grant.id,
			oauthClientId: grant.oauthClientId,
			userId: actorId,
			scopes: ["device.provision", "narrator.provision"],
			consentedAt: now,
			createdAt: now,
			updatedAt: now,
		})),
	);
	for (const grant of grants) {
		await integrationAuthorityService.create({
			id: grant.id,
			kind: "oauth_grant",
			integrationId: grant.oauthClientId,
			ownerUserId: actorId,
			grants: ["device.provision", "narrator.provision"].map((capabilityId) => ({
				capabilityId: capabilityId as "device.provision" | "narrator.provision",
				scope: { type: "global" as const },
				createdBy: { type: "user" as const, id: actorId },
			})),
		});
	}

	return grants;
}

async function cleanupCreatedClients(): Promise<void> {
	const clientIds = [...createdClientIds];
	const publicClientIds = [...createdPublicClientIds];
	if (publicClientIds.length > 0) {
		await db.delete(oauthAccessTokens).where(inArray(oauthAccessTokens.clientId, publicClientIds));
		await db
			.delete(oauthAuthorizationCodes)
			.where(inArray(oauthAuthorizationCodes.clientId, publicClientIds));
	}
	if (clientIds.length > 0) {
		const grantRows = await db.query.oauthGrants.findMany({
			where: inArray(oauthGrants.oauthClientId, clientIds),
			columns: { id: true },
		});
		const grantIds = grantRows.map((grant) => grant.id);
		await db.delete(oauthGrantEvents).where(inArray(oauthGrantEvents.oauthClientId, clientIds));
		if (grantIds.length > 0) {
			await db
				.delete(integrationCapabilityGrants)
				.where(inArray(integrationCapabilityGrants.authorityId, grantIds));
			await db.delete(integrationAuthorities).where(inArray(integrationAuthorities.id, grantIds));
		}
		await db.delete(oauthGrants).where(inArray(oauthGrants.oauthClientId, clientIds));
		await db.delete(oauthClients).where(inArray(oauthClients.id, clientIds));
	}
	createdClientIds.clear();
	createdPublicClientIds.clear();
}

beforeAll(async () => {
	const now = new Date().toISOString();
	await db.insert(users).values([
		{
			id: userId,
			username: `oauth-grants-route-user-${userId}`,
			passwordHash: "not-a-real-hash",
			role: "user",
			createdAt: now,
		},
		{
			id: otherUserId,
			username: `oauth-grants-route-other-${otherUserId}`,
			passwordHash: "not-a-real-hash",
			role: "user",
			createdAt: now,
		},
	]);
});

afterEach(cleanupCreatedClients);

afterAll(async () => {
	await cleanupCreatedClients();
	await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
});

describe("oauth grants Connected Apps routes", () => {
	test("returns the UI projection with cursor pagination and revoked history", async () => {
		const grants = await insertGrants(userId, 3);
		const [otherGrant] = await insertGrants(otherUserId, 1);
		const revokedAt = new Date().toISOString();
		await db
			.update(oauthGrants)
			.set({
				lastUsedAt: revokedAt,
				revokedAt,
				revokedByUserId: userId,
				revokedByType: "user",
				revokedReason: "Historical disconnect",
			})
			.where(eq(oauthGrants.id, grants[0].id));

		const firstResponse = await app.request("/api/oauth/grants?limit=2", {
			headers: await sessionHeaders(userId),
		});
		expect(firstResponse.status).toBe(200);
		const first = (await firstResponse.json()) as {
			items: GrantResponse[];
			nextCursor: string | null;
		};
		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();

		const secondResponse = await app.request(
			`/api/oauth/grants?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
			{ headers: await sessionHeaders(userId) },
		);
		expect(secondResponse.status).toBe(200);
		const second = (await secondResponse.json()) as {
			items: GrantResponse[];
			nextCursor: string | null;
		};
		expect(second.items).toHaveLength(1);
		expect(second.nextCursor).toBeNull();

		const items = [...first.items, ...second.items];
		expect(new Set(items.map((item) => item.id))).toEqual(new Set(grants.map((grant) => grant.id)));
		expect(items.some((item) => item.id === otherGrant.id)).toBe(false);
		const historical = items.find((item) => item.id === grants[0].id);
		expect(historical).toMatchObject({
			client: { clientId: grants[0].clientId, name: "Connected App 0" },
			scopes: ["device.provision", "narrator.provision"],
			projectIds: [],
			lastUsedAt: revokedAt,
			status: "revoked",
			revokedAt,
			reason: "Historical disconnect",
		});
		expect("userId" in (historical as unknown as Record<string, unknown>)).toBe(false);
	});

	test("returns 404 for another user's grant and never revokes it", async () => {
		const [own] = await insertGrants(userId, 1);
		const [other] = await insertGrants(otherUserId, 1);

		const ownGet = await app.request(`/api/oauth/grants/${own.id}`, {
			headers: await sessionHeaders(userId),
		});
		expect(ownGet.status).toBe(200);

		const otherGet = await app.request(`/api/oauth/grants/${other.id}`, {
			headers: await sessionHeaders(userId),
		});
		expect(otherGet.status).toBe(404);

		const otherDelete = await app.request(`/api/oauth/grants/${other.id}`, {
			method: "DELETE",
			headers: await sessionHeaders(userId),
		});
		expect(otherDelete.status).toBe(404);
		expect(
			await db.query.oauthGrants.findFirst({
				where: and(eq(oauthGrants.id, other.id), isNull(oauthGrants.revokedAt)),
			}),
		).toBeTruthy();

		const ownDelete = await app.request(`/api/oauth/grants/${own.id}`, {
			method: "DELETE",
			headers: await sessionHeaders(userId),
		});
		expect(ownDelete.status).toBe(200);
		expect(((await ownDelete.json()) as GrantResponse).status).toBe("revoked");
		const events = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, own.id),
		});
		expect(events.filter((event) => event.eventType === "revoked")).toHaveLength(1);
	});

	test("deduplicates batch ids, enforces ownership atomically, and rejects over 100 ids", async () => {
		const [own] = await insertGrants(userId, 1);
		const [other] = await insertGrants(otherUserId, 1);

		const mixed = await app.request("/api/oauth/grants/revoke-batch", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({ grantIds: [own.id, other.id] }),
		});
		expect(mixed.status).toBe(404);
		expect(
			await db.query.oauthGrants.findFirst({
				where: and(eq(oauthGrants.id, own.id), isNull(oauthGrants.revokedAt)),
			}),
		).toBeTruthy();

		const tooMany = await app.request("/api/oauth/grants/revoke-batch", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({
				grantIds: Array.from({ length: 101 }, () => generateId()),
			}),
		});
		expect(tooMany.status).toBe(400);

		const deduplicated = await app.request("/api/oauth/grants/revoke-batch", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({ grantIds: [own.id, own.id] }),
		});
		expect(deduplicated.status).toBe(200);
		expect(await deduplicated.json()).toEqual({ revokedCount: 1 });
		const events = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, own.id),
		});
		expect(events.filter((event) => event.eventType === "revoked")).toHaveLength(1);
	});

	test("revoke-all requires confirmation and processes at most 100 active grants per call", async () => {
		await insertGrants(userId, 101);
		const [other] = await insertGrants(otherUserId, 1);

		const unconfirmed = await app.request("/api/oauth/grants/revoke-all", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({ confirm: false }),
		});
		expect(unconfirmed.status).toBe(400);

		const firstResponse = await app.request("/api/oauth/grants/revoke-all", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({ confirm: true }),
		});
		expect(firstResponse.status).toBe(200);
		expect(await firstResponse.json()).toEqual({ revokedCount: 100, hasMore: true });

		const remaining = await db.query.oauthGrants.findMany({
			where: and(eq(oauthGrants.userId, userId), isNull(oauthGrants.revokedAt)),
			limit: 2,
		});
		expect(remaining).toHaveLength(1);
		expect(
			await db.query.oauthGrants.findFirst({
				where: and(eq(oauthGrants.id, other.id), isNull(oauthGrants.revokedAt)),
			}),
		).toBeTruthy();

		const secondResponse = await app.request("/api/oauth/grants/revoke-all", {
			method: "POST",
			headers: await sessionHeaders(userId),
			body: JSON.stringify({ confirm: true }),
		});
		expect(secondResponse.status).toBe(200);
		expect(await secondResponse.json()).toEqual({ revokedCount: 1, hasMore: false });
	});

	test("rejects OAuth bearers and grant revocation invalidates bearer, refresh, and code", async () => {
		const [grant] = await insertGrants(userId, 1);
		const tokenPair = await issueTokenPair({
			clientId: grant.clientId,
			oauthClientId: grant.oauthClientId,
			grantId: grant.id,
			userId,
			scopes: ["device.provision"],
		});
		const verifier = "oauth-grants-route-verifier-0123456789";
		const challenge = createHash("sha256").update(verifier).digest("base64url");
		const { code } = await issueAuthorizationCode({
			clientId: grant.clientId,
			oauthClientId: grant.oauthClientId,
			grantId: grant.id,
			userId,
			redirectUri: "http://127.0.0.1:9876/oauth/callback",
			scopes: ["device.provision"],
			codeChallenge: challenge,
		});
		expect(await validateAccessToken(tokenPair.accessToken)).not.toBeNull();

		const oauthBearerResponse = await app.request("/api/oauth/grants?limit=1", {
			headers: bearer(tokenPair.accessToken),
		});
		expect(oauthBearerResponse.status).toBe(401);
		expect((await oauthBearerResponse.json()) as { code: string }).toMatchObject({
			code: "SESSION_REQUIRED",
		});

		const revokeResponse = await app.request(`/api/oauth/grants/${grant.id}`, {
			method: "DELETE",
			headers: await sessionHeaders(userId),
		});
		expect(revokeResponse.status).toBe(200);
		expect(await validateAccessToken(tokenPair.accessToken)).toBeNull();
		await expect(
			refreshAccessToken({ refreshToken: tokenPair.refreshToken, clientId: grant.clientId }),
		).rejects.toThrow(/invalid or revoked/i);
		await expect(
			exchangeCodeForToken({
				code,
				clientId: grant.clientId,
				redirectUri: "http://127.0.0.1:9876/oauth/callback",
				codeVerifier: verifier,
			}),
		).rejects.toThrow(/invalid or revoked/i);
	});
});
