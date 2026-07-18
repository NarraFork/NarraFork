import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
	narrators,
	oauthClients,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import type { OAuthClientPolicy } from "../../lib/oauth-client-policy";
import type { OAuthAuthPrincipal } from "../../middleware/auth";
import {
	assertExternalDeviceBinding,
	assertExternalProjectAllowed,
	assertExternalScope,
	requireExternalOAuthContext,
	requireOwnedExternalDevice,
	requireOwnedExternalNarrator,
} from "../oauth-resource-access";

const now = new Date().toISOString();
const userA = generateId();
const userB = generateId();
const userEmpty = generateId();
const userLegacy = generateId();
const userRevokedClient = generateId();
const userNoGlobal = generateId();
const projectA = generateId();
const projectB = generateId();
const clientA = generateId();
const clientB = generateId();
const clientEmpty = generateId();
const clientLegacy = generateId();
const revokedClient = generateId();
const clientNoGlobal = generateId();
const publicClientA = `resource-access-a-${clientA.slice(0, 8)}`;
const publicClientB = `resource-access-b-${clientB.slice(0, 8)}`;
const publicClientEmpty = `resource-access-empty-${clientEmpty.slice(0, 8)}`;
const publicClientLegacy = `resource-access-legacy-${clientLegacy.slice(0, 8)}`;
const publicRevokedClient = `resource-access-revoked-${revokedClient.slice(0, 8)}`;
const publicClientNoGlobal = `resource-access-no-global-${clientNoGlobal.slice(0, 8)}`;
const grantA = generateId();
const grantB = generateId();
const grantEmpty = generateId();
const grantLegacy = generateId();
const grantRevoked = generateId();
const grantRevokedClient = generateId();
const grantNoGlobal = generateId();
const deviceA = generateId();
const deviceGlobalA = generateId();
const deviceProjectBByA = generateId();
const deviceB = generateId();
const deviceRevokedA = generateId();
const deviceGlobalNoGlobal = generateId();
const narratorA = generateId();
const narratorProjectBByA = generateId();
const narratorB = generateId();
const narratorUnbound = generateId();

const allowGlobalPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: true,
	allowKnowledgeWrite: false,
};

const denyGlobalPolicy: OAuthClientPolicy = {
	...allowGlobalPolicy,
	allowGlobalDevice: false,
};

function principal(
	input: { userId?: string; clientId?: string; grantId?: string | null; scopes?: string[] } = {},
): OAuthAuthPrincipal {
	return {
		type: "oauth",
		user: {
			sub: input.userId ?? userA,
			role: "user",
			iat: 0,
			exp: 0,
		},
		oauth: {
			tokenId: "oauth-resource-access-token",
			clientId: input.clientId ?? publicClientA,
			oauthClientId: "oauth-resource-access-client",
			grantId: input.grantId === undefined ? grantA : input.grantId,
			refreshFamilyId: null,
			expiresAt: "2099-01-01T00:00:00.000Z",
			scopes: input.scopes ?? ["device:manage", "narrator:use", "not:live"],
		},
	};
}

beforeAll(async () => {
	await db.insert(users).values(
		[userA, userB, userEmpty, userLegacy, userRevokedClient, userNoGlobal].map((id) => ({
			id,
			username: `oauth-resource-${id}`,
			passwordHash: "not-a-real-hash",
			role: "user" as const,
			createdAt: now,
		})),
	);
	await db.insert(projects).values([
		{ id: projectA, name: "OAuth resource project A", createdAt: now, updatedAt: now },
		{ id: projectB, name: "OAuth resource project B", createdAt: now, updatedAt: now },
	]);
	await db.insert(oauthClients).values([
		{
			id: clientA,
			clientId: publicClientA,
			name: "OAuth Resource A",
			redirectUris: [],
			scopes: ["device:manage", "narrator:use"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			policyJson: allowGlobalPolicy,
			createdBy: userA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: clientB,
			clientId: publicClientB,
			name: "OAuth Resource B",
			redirectUris: [],
			scopes: ["device:manage", "narrator:use"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: userB,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: clientEmpty,
			clientId: publicClientEmpty,
			name: "OAuth Resource Empty",
			redirectUris: [],
			scopes: ["device:manage"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: userEmpty,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: clientLegacy,
			clientId: publicClientLegacy,
			name: "OAuth Resource Legacy",
			redirectUris: [],
			scopes: ["device:manage"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: userLegacy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: revokedClient,
			clientId: publicRevokedClient,
			name: "OAuth Resource Revoked Client",
			redirectUris: [],
			scopes: ["device:manage"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: userRevokedClient,
			createdAt: now,
			updatedAt: now,
			revokedAt: now,
		},
		{
			id: clientNoGlobal,
			clientId: publicClientNoGlobal,
			name: "OAuth Resource No Global",
			redirectUris: [],
			scopes: ["device:manage"],
			grantTypes: ["authorization_code", "refresh_token"],
			publicClient: true,
			createdBy: userNoGlobal,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(oauthGrants).values([
		{
			id: grantA,
			oauthClientId: clientA,
			userId: userA,
			scopes: ["device:manage", "narrator:use"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantB,
			oauthClientId: clientB,
			userId: userB,
			scopes: ["device:manage", "narrator:use"],
			policyJson: denyGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantEmpty,
			oauthClientId: clientEmpty,
			userId: userEmpty,
			scopes: ["device:manage"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantLegacy,
			oauthClientId: clientLegacy,
			userId: userLegacy,
			scopes: ["device:manage"],
			policyJson: allowGlobalPolicy,
			legacyUnscoped: true,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantRevoked,
			oauthClientId: clientA,
			userId: userA,
			scopes: ["device:manage"],
			policyJson: allowGlobalPolicy,
			revokedAt: now,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantRevokedClient,
			oauthClientId: revokedClient,
			userId: userRevokedClient,
			scopes: ["device:manage"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantNoGlobal,
			oauthClientId: clientNoGlobal,
			userId: userNoGlobal,
			scopes: ["device:manage"],
			policyJson: denyGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(oauthGrantProjects).values([
		{ id: generateId(), grantId: grantA, projectId: projectA, createdAt: now },
		{ id: generateId(), grantId: grantB, projectId: projectB, createdAt: now },
		{ id: generateId(), grantId: grantLegacy, projectId: projectA, createdAt: now },
		{ id: generateId(), grantId: grantRevokedClient, projectId: projectA, createdAt: now },
		{ id: generateId(), grantId: grantNoGlobal, projectId: projectA, createdAt: now },
	]);
	await db.insert(remoteDevices).values([
		{
			id: deviceA,
			name: "OAuth device A",
			slug: `oauth-device-a-${deviceA.slice(0, 8)}`,
			tokenHash: "test-hash-a",
			tokenPrefix: "rdev_a",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectA,
			createdBy: userA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: deviceGlobalA,
			name: "OAuth global device A",
			slug: `oauth-global-a-${deviceGlobalA.slice(0, 8)}`,
			tokenHash: "test-hash-global-a",
			tokenPrefix: "rdev_ga",
			connectionMode: "reverse",
			status: "offline",
			scope: "global",
			projectId: projectA,
			createdBy: userA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: deviceProjectBByA,
			name: "OAuth device project B owned by A",
			slug: `oauth-device-b-a-${deviceProjectBByA.slice(0, 8)}`,
			tokenHash: "test-hash-b-a",
			tokenPrefix: "rdev_ba",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectB,
			createdBy: userA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: deviceB,
			name: "OAuth device B",
			slug: `oauth-device-b-${deviceB.slice(0, 8)}`,
			tokenHash: "test-hash-b",
			tokenPrefix: "rdev_b",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectB,
			createdBy: userB,
			oauthOwnerGrantId: grantB,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: deviceRevokedA,
			name: "OAuth revoked device A",
			slug: `oauth-revoked-a-${deviceRevokedA.slice(0, 8)}`,
			tokenHash: "test-hash-revoked-a",
			tokenPrefix: "rdev_ra",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectA,
			createdBy: userA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
			revokedAt: now,
		},
		{
			id: deviceGlobalNoGlobal,
			name: "OAuth forbidden global device",
			slug: `oauth-global-no-${deviceGlobalNoGlobal.slice(0, 8)}`,
			tokenHash: "test-hash-global-no",
			tokenPrefix: "rdev_gn",
			connectionMode: "reverse",
			status: "offline",
			scope: "global",
			projectId: projectA,
			createdBy: userNoGlobal,
			oauthOwnerGrantId: grantNoGlobal,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(narrators).values([
		{
			id: narratorA,
			contextProjectId: projectA,
			defaultDeviceId: deviceA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: narratorProjectBByA,
			contextProjectId: projectB,
			defaultDeviceId: deviceProjectBByA,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: narratorB,
			contextProjectId: projectB,
			defaultDeviceId: deviceB,
			oauthOwnerGrantId: grantB,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: narratorUnbound,
			contextProjectId: null,
			oauthOwnerGrantId: grantA,
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterAll(async () => {
	await db
		.delete(narrators)
		.where(inArray(narrators.id, [narratorA, narratorProjectBByA, narratorB, narratorUnbound]));
	await db
		.delete(remoteDevices)
		.where(
			inArray(remoteDevices.id, [
				deviceA,
				deviceGlobalA,
				deviceProjectBByA,
				deviceB,
				deviceRevokedA,
				deviceGlobalNoGlobal,
			]),
		);
	await db
		.delete(oauthGrantProjects)
		.where(
			inArray(oauthGrantProjects.grantId, [
				grantA,
				grantB,
				grantEmpty,
				grantLegacy,
				grantRevoked,
				grantRevokedClient,
				grantNoGlobal,
			]),
		);
	await db
		.delete(oauthGrants)
		.where(
			inArray(oauthGrants.id, [
				grantA,
				grantB,
				grantEmpty,
				grantLegacy,
				grantRevoked,
				grantRevokedClient,
				grantNoGlobal,
			]),
		);
	await db
		.delete(oauthClients)
		.where(
			inArray(oauthClients.id, [
				clientA,
				clientB,
				clientEmpty,
				clientLegacy,
				revokedClient,
				clientNoGlobal,
			]),
		);
	await db.delete(projects).where(inArray(projects.id, [projectA, projectB]));
	await db
		.delete(users)
		.where(
			inArray(users.id, [userA, userB, userEmpty, userLegacy, userRevokedClient, userNoGlobal]),
		);
});

describe("OAuth external resource access", () => {
	test("loads the live grant, active client, bounded allow-list, and grant policy snapshot", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		expect(ctx).toMatchObject({
			userId: userA,
			grantId: grantA,
			oauthClientId: clientA,
			clientId: publicClientA,
			projectIds: [projectA],
			policy: allowGlobalPolicy,
		});
		expect(ctx.scopes).toEqual(["device:manage", "narrator:use"]);
		expect(ctx.allowedProjectIds.has(projectA)).toBe(true);

		const app = new Hono();
		app.use("*", async (c, next) => {
			const auth = principal();
			c.set("auth", auth);
			c.set("user", auth.user);
			c.set("oauth", auth.oauth);
			await next();
		});
		app.get("/", async (c) => {
			const external = await requireExternalOAuthContext(c);
			return c.json({ grantId: external.grantId, projectIds: external.projectIds });
		});
		const response = await app.request("/");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ grantId: grantA, projectIds: [projectA] });
	});

	test("explicitly rejects grant-less v1, legacy, revoked-grant, and revoked-client principals", async () => {
		await expect(requireExternalOAuthContext(principal({ grantId: null }))).rejects.toMatchObject({
			statusCode: 403,
			code: "OAUTH_LEGACY_GRANT_FORBIDDEN",
		});
		await expect(
			requireExternalOAuthContext(
				principal({
					userId: userLegacy,
					clientId: publicClientLegacy,
					grantId: grantLegacy,
				}),
			),
		).rejects.toMatchObject({ statusCode: 403, code: "OAUTH_LEGACY_GRANT_FORBIDDEN" });
		await expect(
			requireExternalOAuthContext(principal({ grantId: grantRevoked })),
		).rejects.toMatchObject({ statusCode: 403, code: "OAUTH_GRANT_FORBIDDEN" });
		await expect(
			requireExternalOAuthContext(
				principal({
					userId: userRevokedClient,
					clientId: publicRevokedClient,
					grantId: grantRevokedClient,
				}),
			),
		).rejects.toMatchObject({ statusCode: 403, code: "OAUTH_CLIENT_FORBIDDEN" });
	});

	test("enforces effective scopes and exact finite project membership", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		expect(() => assertExternalScope(ctx, "device:manage")).not.toThrow();
		expect(() => assertExternalScope(ctx, "knowledge:write")).toThrow(
			expect.objectContaining({ statusCode: 403, code: "INSUFFICIENT_SCOPE" }),
		);
		expect(() => assertExternalProjectAllowed(ctx, projectA)).not.toThrow();
		expect(() => assertExternalProjectAllowed(ctx, projectB)).toThrow(
			expect.objectContaining({ statusCode: 403, code: "OAUTH_PROJECT_FORBIDDEN" }),
		);

		const empty = await requireExternalOAuthContext(
			principal({
				userId: userEmpty,
				clientId: publicClientEmpty,
				grantId: grantEmpty,
				scopes: ["device:manage"],
			}),
		);
		expect(empty.projectIds).toEqual([]);
		expect(() => assertExternalProjectAllowed(empty, projectA)).toThrow(
			expect.objectContaining({ statusCode: 403, code: "OAUTH_PROJECT_FORBIDDEN" }),
		);
	});

	test("returns only owned device/narrator resources in allowed projects", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		expect((await requireOwnedExternalDevice(ctx, deviceA)).id).toBe(deviceA);
		expect((await requireOwnedExternalDevice(ctx, deviceGlobalA)).id).toBe(deviceGlobalA);
		expect((await requireOwnedExternalNarrator(ctx, narratorA)).id).toBe(narratorA);

		for (const id of [deviceProjectBByA, deviceB, deviceRevokedA]) {
			await expect(requireOwnedExternalDevice(ctx, id)).rejects.toMatchObject({
				statusCode: 404,
				code: "NOT_FOUND",
			});
		}
		for (const id of [narratorProjectBByA, narratorB, narratorUnbound]) {
			await expect(requireOwnedExternalNarrator(ctx, id)).rejects.toMatchObject({
				statusCode: 404,
				code: "NOT_FOUND",
			});
		}
	});

	test("prevents cross-grant and cross-project narrator/device binding", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		const ownedProjectDevice = await requireOwnedExternalDevice(ctx, deviceA);
		const ownedGlobalDevice = await requireOwnedExternalDevice(ctx, deviceGlobalA);
		expect(() => assertExternalDeviceBinding(ctx, ownedProjectDevice, projectA)).not.toThrow();
		expect(() => assertExternalDeviceBinding(ctx, ownedGlobalDevice, projectA)).not.toThrow();

		expect(() =>
			assertExternalDeviceBinding(
				ctx,
				{
					id: deviceB,
					oauthOwnerGrantId: grantB,
					scope: "project",
					projectId: projectB,
				},
				projectA,
			),
		).toThrow(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
		expect(() =>
			assertExternalDeviceBinding(
				ctx,
				{
					id: deviceProjectBByA,
					oauthOwnerGrantId: grantA,
					scope: "project",
					projectId: projectB,
				},
				projectA,
			),
		).toThrow(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
		expect(() => assertExternalDeviceBinding(ctx, ownedProjectDevice, projectB)).toThrow(
			expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }),
		);

		const noGlobalCtx = await requireExternalOAuthContext(
			principal({
				userId: userNoGlobal,
				clientId: publicClientNoGlobal,
				grantId: grantNoGlobal,
				scopes: ["device:manage"],
			}),
		);
		await expect(
			requireOwnedExternalDevice(noGlobalCtx, deviceGlobalNoGlobal),
		).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });
		expect(() =>
			assertExternalDeviceBinding(
				noGlobalCtx,
				{
					id: deviceGlobalNoGlobal,
					oauthOwnerGrantId: grantNoGlobal,
					scope: "global",
					projectId: projectA,
				},
				projectA,
			),
		).toThrow(expect.objectContaining({ statusCode: 404, code: "NOT_FOUND" }));
	});
});
