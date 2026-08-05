import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
	oauthClients,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import type { OAuthClientPolicy } from "../../lib/oauth-client-policy";
import { getSessionDevices } from "../device-connection-service";
import { integrationAuthorityService } from "../integration-authority-service";
import { resolveOAuthDeviceRuntimeAuthorization } from "../oauth-device-runtime-policy";

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

const created = {
	users: [] as string[],
	projects: [] as string[],
	clients: [] as string[],
	grants: [] as string[],
	bindings: [] as string[],
	provenance: [] as string[],
	devices: [] as string[],
};

async function createFixture(policy: OAuthClientPolicy = allowGlobalPolicy) {
	const ids = {
		user: generateId(),
		project: generateId(),
		client: generateId(),
		grant: generateId(),
		binding: generateId(),
		provenance: generateId(),
		device: generateId(),
	};
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: ids.user,
		username: `oauth-device-runtime-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: ids.project,
		name: `OAuth device runtime ${ids.project}`,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: `oauth-device-runtime-${ids.client}`,
		name: "OAuth device runtime client",
		redirectUris: [],
		scopes: ["device.provision"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		policyJson: policy,
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrants).values({
		id: ids.grant,
		oauthClientId: ids.client,
		userId: ids.user,
		scopes: ["device.provision"],
		policyJson: policy,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrantProjects).values({
		id: ids.binding,
		grantId: ids.grant,
		projectId: ids.project,
		createdAt: now,
	});
	await integrationAuthorityService.create({
		id: ids.grant,
		kind: "oauth_grant",
		integrationId: ids.client,
		ownerUserId: ids.user,
		policyJson: policy,
		grants: [
			{
				capabilityId: "device.provision",
				scope: { type: "project", id: ids.project },
				createdBy: { type: "user", id: ids.user },
			},
		],
	});
	await db.insert(remoteDevices).values({
		id: ids.device,
		name: "OAuth runtime policy device",
		slug: `oauth-runtime-policy-${ids.device.slice(0, 8)}`,
		tokenHash: "oauth-runtime-policy-hash",
		tokenPrefix: "rdev_policy",
		connectionMode: "reverse",
		status: "offline",
		scope: "project",
		projectId: ids.project,
		createdBy: ids.user,
		oauthOwnerGrantId: null,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(integrationResourceBindings).values({
		id: ids.provenance,
		resourceType: "device",
		resourceId: ids.device,
		sourceType: "oauth_client",
		sourceId: ids.client,
		authorityType: "oauth_grant",
		authorityId: ids.grant,
		state: "active",
		createdAt: now,
		updatedAt: now,
	});
	created.users.push(ids.user);
	created.projects.push(ids.project);
	created.clients.push(ids.client);
	created.grants.push(ids.grant);
	created.bindings.push(ids.binding);
	created.provenance.push(ids.provenance);
	created.devices.push(ids.device);
	return { ids, now };
}

function deviceResource(
	ids: { device: string; grant: string; user: string; project: string },
	overrides: Partial<{
		createdBy: string;
		scope: "global" | "project";
		projectId: string | null;
		revokedAt: string | null;
	}> = {},
) {
	return {
		id: ids.device,
		createdBy: ids.user,
		scope: "project" as const,
		projectId: ids.project,
		revokedAt: null,
		...overrides,
	};
}

afterEach(async () => {
	for (const id of created.provenance.splice(0)) {
		await db.delete(integrationResourceBindings).where(eq(integrationResourceBindings.id, id));
	}
	for (const id of created.devices.splice(0)) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, id));
	}
	for (const id of created.bindings.splice(0)) {
		await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.id, id));
	}
	for (const id of created.grants.splice(0)) {
		await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, id));
		await db.delete(oauthGrants).where(eq(oauthGrants.id, id));
	}
	for (const id of created.clients.splice(0)) {
		await db.delete(oauthClients).where(eq(oauthClients.id, id));
	}
	for (const id of created.projects.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
	for (const id of created.users.splice(0)) {
		await db.delete(users).where(eq(users.id, id));
	}
});

describe("OAuth device runtime authorization", () => {
	test("leaves ordinary devices unchanged", async () => {
		const result = await resolveOAuthDeviceRuntimeAuthorization({
			id: generateId(),
			createdBy: "ordinary-owner",
			scope: "global",
			projectId: null,
			revokedAt: null,
		});
		expect(result).toEqual({ oauthOwned: false, allowed: true });
	});

	test("uses active binding when the legacy owner column is empty", async () => {
		const { ids } = await createFixture();
		const result = await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids));
		expect(result).toMatchObject({
			oauthOwned: true,
			allowed: true,
			grantId: ids.grant,
			oauthClientId: ids.client,
			userId: ids.user,
			projectId: ids.project,
		});
	});

	test("excludes orphaned provenance from runtime authorization and session selection", async () => {
		const { ids, now } = await createFixture();
		await db
			.update(integrationResourceBindings)
			.set({ state: "orphaned", orphanedAt: now })
			.where(eq(integrationResourceBindings.id, ids.provenance));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth device provenance is inactive",
		});
		expect((await getSessionDevices(ids.project)).map((device) => device.id)).not.toContain(
			ids.device,
		);
	});

	test("denies inactive authorities and clients", async () => {
		const first = await createFixture();
		const authority = await integrationAuthorityService.requireSnapshot(first.ids.grant);
		await integrationAuthorityService.revoke({
			authorityId: first.ids.grant,
			expectedRevision: authority.authority.revision,
			reason: "test revoke",
		});
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(first.ids))).toMatchObject({
			allowed: false,
			reason: "OAuth authority is inactive",
		});

		const second = await createFixture();
		await db
			.update(oauthClients)
			.set({ revokedAt: second.now })
			.where(eq(oauthClients.id, second.ids.client));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(second.ids))).toMatchObject({
			allowed: false,
			reason: "OAuth client is inactive",
		});
	});

	test("denies owner drift but keeps ownership after project-scope grant removal", async () => {
		const { ids } = await createFixture();
		await db
			.update(remoteDevices)
			.set({ createdBy: generateId() })
			.where(eq(remoteDevices.id, ids.device));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth device owner no longer matches the authority",
		});

		await db
			.update(remoteDevices)
			.set({ createdBy: ids.user })
			.where(eq(remoteDevices.id, ids.device));
		// De-projectization: removing project-scope grants no longer revokes device runtime.
		// Grant ownership (active binding + active authority + owner match) is the boundary.
		const authority = await integrationAuthorityService.requireSnapshot(ids.grant);
		await integrationAuthorityService.replaceGrants({
			authorityId: ids.grant,
			expectedRevision: authority.authority.revision,
			grants: [],
		});
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			oauthOwned: true,
			allowed: true,
		});
	});

	test("grant-owned global device stays authorized regardless of allowGlobalDevice", async () => {
		// De-projectization: grant ownership (the resource binding + active authority)
		// is the sole isolation boundary for OAuth-owned devices. The device scope
		// column and allowGlobalDevice no longer gate a self-owned device's runtime.
		const { ids } = await createFixture();
		await db.update(remoteDevices).set({ scope: "global" }).where(eq(remoteDevices.id, ids.device));
		await db
			.update(oauthClients)
			.set({ policyJson: { ...allowGlobalPolicy, allowGlobalDevice: false } })
			.where(eq(oauthClients.id, ids.client));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			oauthOwned: true,
			allowed: true,
		});
	});
});
