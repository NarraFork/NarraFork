import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { sign } from "hono/jwt";
import { db } from "../../db";
import {
	narrators,
	oauthAccessTokens,
	oauthAuthorizationCodes,
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { exchangeCodeForToken, issueAuthorizationCode } from "../../lib/oauth-provider";
import { settings } from "../../lib/settings";
import { requireAuth } from "../../middleware/auth";
import { hashDeviceToken } from "../../services/device-service";
import { createOAuthGrant } from "../../services/oauth-grant-service";
import { oauthProvisionRoutes } from "../oauth-provision";

const REDIRECT_URI = "http://127.0.0.1:9876/oauth/callback";
const DEFAULT_POLICY = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
};

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api/oauth/provision", oauthProvisionRoutes);
app.onError(
	(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
);

const cleanup = {
	clientIds: new Set<string>(),
	deviceIds: new Set<string>(),
	grantIds: new Set<string>(),
	narratorIds: new Set<string>(),
	projectIds: new Set<string>(),
	userIds: new Set<string>(),
};

interface Fixture {
	clientDbId: string;
	clientId: string;
	grantId: string;
	projectIds: string[];
	token: string;
	userId: string;
}

function pkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}

async function createFixture(input: {
	label: string;
	projectCount?: number;
	scopes?: string[];
	policy?: Record<string, unknown>;
}): Promise<Fixture> {
	const userId = generateId();
	cleanup.userIds.add(userId);
	await db.insert(users).values({
		id: userId,
		username: `legacy-provision-${input.label}-${userId}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: new Date().toISOString(),
	});

	const now = new Date().toISOString();
	const projectIds: string[] = [];
	for (let index = 0; index < (input.projectCount ?? 1); index++) {
		const projectId = generateId();
		projectIds.push(projectId);
		cleanup.projectIds.add(projectId);
		await db.insert(projects).values({
			id: projectId,
			name: `Legacy provision ${input.label} ${index}`,
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
	}

	const clientDbId = generateId();
	const clientId = `legacy-provision-${input.label}-${clientDbId}`;
	cleanup.clientIds.add(clientDbId);
	await db.insert(oauthClients).values({
		id: clientDbId,
		clientId,
		name: `Legacy provision ${input.label}`,
		redirectUris: [REDIRECT_URI],
		scopes: ["device:manage", "narrator:use"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		policyJson: input.policy ?? DEFAULT_POLICY,
		createdBy: userId,
		createdAt: now,
		updatedAt: now,
	});

	const scopes = input.scopes ?? ["device:manage", "narrator:use"];
	const grant = await createOAuthGrant({
		userId,
		clientId,
		scopes,
		projectIds,
		policyJson: input.policy ?? DEFAULT_POLICY,
	});
	cleanup.grantIds.add(grant.id);
	const verifier = `legacy-verifier-${input.label}-${Date.now()}`;
	const { code } = await issueAuthorizationCode({
		clientId,
		userId,
		grantId: grant.id,
		redirectUri: REDIRECT_URI,
		scopes,
		codeChallenge: pkceChallenge(verifier),
	});
	const pair = await exchangeCodeForToken({
		code,
		clientId,
		redirectUri: REDIRECT_URI,
		codeVerifier: verifier,
	});
	return { clientDbId, clientId, grantId: grant.id, projectIds, token: pair.accessToken, userId };
}

function jsonHeaders(token: string) {
	return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function sessionJwt(userId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return sign({ sub: userId, role: "user", iat: now, exp: now + 3600 }, settings.auth.jwtSecret);
}

describe("deprecated oauth provision shim", () => {
	test("requires OAuth and rejects first-party sessions", async () => {
		const fixture = await createFixture({ label: "session-rejected" });
		const response = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(await sessionJwt(fixture.userId)),
			body: JSON.stringify({ projectId: fixture.projectIds[0] }),
		});
		expect(response.status).toBe(401);
		expect((await response.json()) as { code: string }).toMatchObject({ code: "OAUTH_REQUIRED" });
	});

	test("delegates device provisioning with deprecation headers and never rotates on replay", async () => {
		const fixture = await createFixture({ label: "device-idempotent" });
		const first = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({}),
		});
		expect(first.status).toBe(201);
		expect(first.headers.get("Deprecation")).toBe("true");
		expect(first.headers.get("Link")).toContain("/api/external/v1");
		const firstBody = (await first.json()) as {
			created: boolean;
			deviceId: string;
			deviceRef: string;
			deviceToken: string;
		};
		cleanup.deviceIds.add(firstBody.deviceId);
		expect(firstBody.created).toBe(true);
		expect(firstBody.deviceToken.startsWith("rdev_")).toBe(true);
		const originalHash = hashDeviceToken(firstBody.deviceToken);

		const replay = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({}),
		});
		expect(replay.status).toBe(200);
		const replayBody = (await replay.json()) as {
			created: boolean;
			deviceId: string;
			deviceToken: null;
		};
		expect(replayBody).toMatchObject({
			created: false,
			deviceId: firstBody.deviceId,
			deviceToken: null,
		});
		const row = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, firstBody.deviceId),
		});
		expect(row?.tokenHash).toBe(originalHash);
		expect(row?.oauthOwnerGrantId).toBe(fixture.grantId);
		expect(row?.projectId).toBe(fixture.projectIds[0]);
	});

	test("uses labels as fixed provision keys and requires projectId for ambiguous grants", async () => {
		const fixture = await createFixture({ label: "labels", projectCount: 2 });
		const ambiguous = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({ label: "motion" }),
		});
		expect(ambiguous.status).toBe(400);

		const ids: string[] = [];
		for (const label of ["motion", "navigation"]) {
			const response = await app.request("/api/oauth/provision/device", {
				method: "POST",
				headers: jsonHeaders(fixture.token),
				body: JSON.stringify({ label, projectId: fixture.projectIds[0] }),
			});
			expect(response.status).toBe(201);
			const body = (await response.json()) as { deviceId: string };
			cleanup.deviceIds.add(body.deviceId);
			ids.push(body.deviceId);
		}
		expect(ids[0]).not.toBe(ids[1]);
	});

	test("provisions a grant-owned narrator bound to the grant-owned device", async () => {
		const policy = {
			...DEFAULT_POLICY,
			allowedPermissionModes: ["readOnly", "dontAsk"],
		};
		const fixture = await createFixture({ label: "narrator", policy });
		const deviceResponse = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({}),
		});
		const device = (await deviceResponse.json()) as { deviceId: string; deviceRef: string };
		cleanup.deviceIds.add(device.deviceId);

		const title = "Legacy external narrator";
		const first = await app.request("/api/oauth/provision/narrator", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({ deviceRef: device.deviceRef, title, permissionMode: "dontAsk" }),
		});
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { created: boolean; narratorId: string };
		cleanup.narratorIds.add(firstBody.narratorId);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, firstBody.narratorId),
		});
		expect(row).toMatchObject({
			contextProjectId: fixture.projectIds[0],
			defaultDeviceId: device.deviceId,
			oauthOwnerGrantId: fixture.grantId,
			oauthProvisionKey: "legacy-narrator-default",
			permissionMode: "dontAsk",
			title,
		});

		const replay = await app.request("/api/oauth/provision/narrator", {
			method: "POST",
			headers: jsonHeaders(fixture.token),
			body: JSON.stringify({ deviceRef: device.deviceId }),
		});
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			created: false,
			narratorId: firstBody.narratorId,
		});
	});

	test("enforces legacy scopes before provisioning", async () => {
		const deviceOnly = await createFixture({
			label: "device-scope-only",
			scopes: ["device:manage"],
		});
		const narrator = await app.request("/api/oauth/provision/narrator", {
			method: "POST",
			headers: jsonHeaders(deviceOnly.token),
			body: JSON.stringify({ deviceRef: "missing" }),
		});
		expect(narrator.status).toBe(403);
		expect(await narrator.json()).toMatchObject({ code: "INSUFFICIENT_SCOPE" });

		const narratorOnly = await createFixture({
			label: "narrator-scope-only",
			scopes: ["narrator:use"],
		});
		const device = await app.request("/api/oauth/provision/device", {
			method: "POST",
			headers: jsonHeaders(narratorOnly.token),
			body: JSON.stringify({}),
		});
		expect(device.status).toBe(403);
		expect(await device.json()).toMatchObject({ code: "INSUFFICIENT_SCOPE" });
	});
});

afterAll(async () => {
	if (cleanup.narratorIds.size > 0) {
		await db.delete(narrators).where(inArray(narrators.id, [...cleanup.narratorIds]));
	}
	if (cleanup.deviceIds.size > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, [...cleanup.deviceIds]));
	}
	if (cleanup.clientIds.size > 0) {
		await db
			.delete(oauthAccessTokens)
			.where(inArray(oauthAccessTokens.oauthClientId, [...cleanup.clientIds]));
		await db
			.delete(oauthAuthorizationCodes)
			.where(inArray(oauthAuthorizationCodes.oauthClientId, [...cleanup.clientIds]));
		await db
			.delete(oauthGrantEvents)
			.where(inArray(oauthGrantEvents.oauthClientId, [...cleanup.clientIds]));
	}
	if (cleanup.grantIds.size > 0) {
		await db
			.delete(oauthGrantProjects)
			.where(inArray(oauthGrantProjects.grantId, [...cleanup.grantIds]));
		await db.delete(oauthGrants).where(inArray(oauthGrants.id, [...cleanup.grantIds]));
	}
	if (cleanup.clientIds.size > 0) {
		await db.delete(oauthClients).where(inArray(oauthClients.id, [...cleanup.clientIds]));
	}
	if (cleanup.projectIds.size > 0) {
		await db.delete(projects).where(inArray(projects.id, [...cleanup.projectIds]));
	}
	if (cleanup.userIds.size > 0) {
		await db.delete(users).where(inArray(users.id, [...cleanup.userIds]));
	}
});
