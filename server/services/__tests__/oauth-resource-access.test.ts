import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
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
import { integrationAuthorityService } from "../integration-authority-service";
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
	allowDangerReflectionPrompt: false,
	maxDangerReflectionPromptChars: 0,
	allowRobotDiagnosticPreset: false,
	deviceAccess: { host: "denied", global: "denied", selfRegistered: "denied" },
	messageDetail: "summary",
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
			scopes: input.scopes ?? ["device.provision", "narrator.provision", "not:live"],
		},
	};
}

async function createAuthority(input: {
	grantId: string;
	clientId: string;
	userId: string;
	scopes: CanonicalCapabilityId[];
	projectIds: string[];
	policy: OAuthClientPolicy;
}): Promise<void> {
	await integrationAuthorityService.create({
		id: input.grantId,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: input.clientId,
		ownerUserId: input.userId,
		sourceGrantId: input.grantId,
		policyJson: input.policy,
		grants: input.scopes.flatMap((capabilityId) => [
			{
				capabilityId,
				scope: { type: "integration", id: input.grantId },
				createdBy: { type: "user", id: input.userId },
			},
			...input.projectIds.map((projectId) => ({
				capabilityId,
				scope: { type: "project" as const, id: projectId },
				createdBy: { type: "user" as const, id: input.userId },
			})),
		]),
	});
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
			scopes: ["device.provision", "narrator.provision"],
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
			scopes: ["device.provision", "narrator.provision"],
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
			scopes: ["device.provision"],
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
			scopes: ["device.provision"],
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
			scopes: ["device.provision"],
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
			scopes: ["device.provision"],
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
			scopes: ["device.provision", "narrator.provision"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantB,
			oauthClientId: clientB,
			userId: userB,
			scopes: ["device.provision", "narrator.provision"],
			policyJson: denyGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantEmpty,
			oauthClientId: clientEmpty,
			userId: userEmpty,
			scopes: ["device.provision"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantLegacy,
			oauthClientId: clientLegacy,
			userId: userLegacy,
			scopes: ["device.provision"],
			policyJson: allowGlobalPolicy,
			legacyUnscoped: true,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantRevoked,
			oauthClientId: clientA,
			userId: userA,
			scopes: ["device.provision"],
			policyJson: allowGlobalPolicy,
			revokedAt: now,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantRevokedClient,
			oauthClientId: revokedClient,
			userId: userRevokedClient,
			scopes: ["device.provision"],
			policyJson: allowGlobalPolicy,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: grantNoGlobal,
			oauthClientId: clientNoGlobal,
			userId: userNoGlobal,
			scopes: ["device.provision"],
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
	await Promise.all([
		createAuthority({
			grantId: grantA,
			clientId: clientA,
			userId: userA,
			scopes: ["device.provision", "narrator.provision"],
			projectIds: [projectA],
			policy: allowGlobalPolicy,
		}),
		createAuthority({
			grantId: grantB,
			clientId: clientB,
			userId: userB,
			scopes: ["device.provision", "narrator.provision"],
			projectIds: [projectB],
			policy: denyGlobalPolicy,
		}),
		createAuthority({
			grantId: grantEmpty,
			clientId: clientEmpty,
			userId: userEmpty,
			scopes: ["device.provision"],
			projectIds: [],
			policy: allowGlobalPolicy,
		}),
		createAuthority({
			grantId: grantRevokedClient,
			clientId: revokedClient,
			userId: userRevokedClient,
			scopes: ["device.provision"],
			projectIds: [projectA],
			policy: allowGlobalPolicy,
		}),
		createAuthority({
			grantId: grantNoGlobal,
			clientId: clientNoGlobal,
			userId: userNoGlobal,
			scopes: ["device.provision"],
			projectIds: [projectA],
			policy: denyGlobalPolicy,
		}),
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
			oauthOwnerGrantId: null,
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
			oauthOwnerGrantId: grantB,
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
	await db.insert(integrationResourceBindings).values([
		...[
			[deviceA, clientA, grantA, "active"],
			[deviceGlobalA, clientA, grantA, "active"],
			[deviceProjectBByA, clientA, grantA, "active"],
			[deviceB, clientB, grantB, "active"],
			[deviceRevokedA, clientA, grantA, "revoked"],
			[deviceGlobalNoGlobal, clientNoGlobal, grantNoGlobal, "active"],
		].map(([resourceId, sourceId, authorityId, state]) => ({
			id: generateId(),
			resourceType: "device" as const,
			resourceId,
			sourceType: "oauth_client" as const,
			sourceId,
			authorityType: "oauth_grant" as const,
			authorityId,
			state: state as "active" | "revoked",
			createdAt: now,
			updatedAt: now,
			revokedAt: state === "revoked" ? now : null,
		})),
		...[
			[narratorA, clientA, grantA],
			[narratorProjectBByA, clientA, grantA],
			[narratorB, clientB, grantB],
			[narratorUnbound, clientA, grantA],
		].map(([resourceId, sourceId, authorityId]) => ({
			id: generateId(),
			resourceType: "narrator" as const,
			resourceId,
			sourceType: "oauth_client" as const,
			sourceId,
			authorityType: "oauth_grant" as const,
			authorityId,
			state: "active" as const,
			createdAt: now,
			updatedAt: now,
		})),
	]);
});

afterAll(async () => {
	await db
		.delete(integrationResourceBindings)
		.where(
			inArray(integrationResourceBindings.resourceId, [
				deviceA,
				deviceGlobalA,
				deviceProjectBByA,
				deviceB,
				deviceRevokedA,
				deviceGlobalNoGlobal,
				narratorA,
				narratorProjectBByA,
				narratorB,
				narratorUnbound,
			]),
		);
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
		.delete(integrationAuthorities)
		.where(
			inArray(integrationAuthorities.id, [
				grantA,
				grantB,
				grantEmpty,
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
		expect(ctx.scopes).toEqual(["device.provision", "narrator.provision"]);
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

	test("rejects grant-less, authority-less, revoked-grant, and revoked-client principals", async () => {
		await expect(requireExternalOAuthContext(principal({ grantId: null }))).rejects.toMatchObject({
			statusCode: 403,
			code: "OAUTH_GRANT_REQUIRED",
		});
		await expect(
			requireExternalOAuthContext(
				principal({
					userId: userLegacy,
					clientId: publicClientLegacy,
					grantId: grantLegacy,
				}),
			),
		).rejects.toMatchObject({ statusCode: 403, code: "OAUTH_GRANT_FORBIDDEN" });
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
		expect(() => assertExternalScope(ctx, "device.provision")).not.toThrow();
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
				scopes: ["device.provision"],
			}),
		);
		expect(empty.projectIds).toEqual([]);
		expect(() => assertExternalProjectAllowed(empty, projectA)).toThrow(
			expect.objectContaining({ statusCode: 403, code: "OAUTH_PROJECT_FORBIDDEN" }),
		);
	});

	test("returns resources owned by the grant regardless of project (grant-ownership boundary)", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		expect((await requireOwnedExternalDevice(ctx, deviceA)).id).toBe(deviceA);
		expect((await requireOwnedExternalDevice(ctx, deviceGlobalA)).id).toBe(deviceGlobalA);
		// Bound to grant A but in project B: grant ownership is the boundary, so it is now visible.
		expect((await requireOwnedExternalDevice(ctx, deviceProjectBByA)).id).toBe(deviceProjectBByA);
		expect((await requireOwnedExternalNarrator(ctx, narratorA)).id).toBe(narratorA);
		expect((await requireOwnedExternalNarrator(ctx, narratorProjectBByA)).id).toBe(
			narratorProjectBByA,
		);
		// Project-less narrator bound to grant A is now first-class under grant ownership.
		expect((await requireOwnedExternalNarrator(ctx, narratorUnbound)).id).toBe(narratorUnbound);

		// Cross-grant (grant B) and revoked resources remain hidden as 404.
		for (const id of [deviceB, deviceRevokedA]) {
			await expect(requireOwnedExternalDevice(ctx, id)).rejects.toMatchObject({
				statusCode: 404,
				code: "NOT_FOUND",
			});
		}
		await expect(requireOwnedExternalNarrator(ctx, narratorB)).rejects.toMatchObject({
			statusCode: 404,
			code: "NOT_FOUND",
		});
	});

	test("device binding is bounded by grant ownership, not project", async () => {
		const ctx = await requireExternalOAuthContext(principal());
		const ownedProjectDevice = await requireOwnedExternalDevice(ctx, deviceA);
		const ownedGlobalDevice = await requireOwnedExternalDevice(ctx, deviceGlobalA);
		await expect(assertExternalDeviceBinding(ctx, ownedProjectDevice)).resolves.toBeUndefined();
		await expect(assertExternalDeviceBinding(ctx, ownedGlobalDevice)).resolves.toBeUndefined();
		// Same grant, different project is now allowed (project no longer a boundary).
		const ownedProjectBDevice = await requireOwnedExternalDevice(ctx, deviceProjectBByA);
		await expect(assertExternalDeviceBinding(ctx, ownedProjectBDevice)).resolves.toBeUndefined();

		// Cross-grant device is still hidden (grant ownership fails).
		await expect(
			assertExternalDeviceBinding(ctx, { id: deviceB, scope: "project", projectId: projectB }),
		).rejects.toMatchObject({ statusCode: 404, code: "NOT_FOUND" });

		// De-projectization: a self-owned global device is accessible even when the
		// client policy sets allowGlobalDevice=false — grant ownership is the boundary,
		// not the device scope column. (deviceGlobalNoGlobal is owned by grantNoGlobal.)
		const noGlobalCtx = await requireExternalOAuthContext(
			principal({
				userId: userNoGlobal,
				clientId: publicClientNoGlobal,
				grantId: grantNoGlobal,
				scopes: ["device.provision"],
			}),
		);
		expect((await requireOwnedExternalDevice(noGlobalCtx, deviceGlobalNoGlobal)).id).toBe(
			deviceGlobalNoGlobal,
		);
		await expect(
			assertExternalDeviceBinding(noGlobalCtx, {
				id: deviceGlobalNoGlobal,
				scope: "global",
				projectId: projectA,
			}),
		).resolves.toBeUndefined();
	});
});
