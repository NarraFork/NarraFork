import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	oauthClients,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import type { OAuthClientPolicy } from "../../lib/oauth-client-policy";
import { resolveOAuthDeviceRuntimeAuthorization } from "../oauth-device-runtime-policy";

const allowGlobalPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: true,
	allowKnowledgeWrite: false,
};

const created = {
	users: [] as string[],
	projects: [] as string[],
	clients: [] as string[],
	grants: [] as string[],
	bindings: [] as string[],
	devices: [] as string[],
};

async function createFixture(policy: OAuthClientPolicy = allowGlobalPolicy) {
	const ids = {
		user: generateId(),
		project: generateId(),
		client: generateId(),
		grant: generateId(),
		binding: generateId(),
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
		scopes: ["device:provision"],
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
		scopes: ["device:provision"],
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
		oauthOwnerGrantId: ids.grant,
		createdAt: now,
		updatedAt: now,
	});
	created.users.push(ids.user);
	created.projects.push(ids.project);
	created.clients.push(ids.client);
	created.grants.push(ids.grant);
	created.bindings.push(ids.binding);
	created.devices.push(ids.device);
	return { ids, now };
}

function deviceResource(
	ids: { device: string; grant: string; user: string; project: string },
	overrides: Partial<{
		oauthOwnerGrantId: string | null;
		createdBy: string;
		scope: "global" | "project";
		projectId: string | null;
		revokedAt: string | null;
	}> = {},
) {
	return {
		id: ids.device,
		oauthOwnerGrantId: ids.grant,
		createdBy: ids.user,
		scope: "project" as const,
		projectId: ids.project,
		revokedAt: null,
		...overrides,
	};
}

afterEach(async () => {
	for (const id of created.devices.splice(0)) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, id));
	}
	for (const id of created.bindings.splice(0)) {
		await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.id, id));
	}
	for (const id of created.grants.splice(0)) {
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
			oauthOwnerGrantId: null,
			createdBy: "ordinary-owner",
			scope: "global",
			projectId: null,
			revokedAt: null,
		});
		expect(result).toEqual({ oauthOwned: false, allowed: true });
	});

	test("allows an active owner, client, grant, and project binding", async () => {
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

	test("denies inactive grants and clients", async () => {
		const { ids, now } = await createFixture();
		await db.update(oauthGrants).set({ revokedAt: now }).where(eq(oauthGrants.id, ids.grant));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth grant is inactive",
		});

		await db.update(oauthGrants).set({ revokedAt: null }).where(eq(oauthGrants.id, ids.grant));
		await db.update(oauthClients).set({ revokedAt: now }).where(eq(oauthClients.id, ids.client));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth client is inactive",
		});
	});

	test("denies owner and project binding drift", async () => {
		const { ids } = await createFixture();
		await db
			.update(remoteDevices)
			.set({ createdBy: generateId() })
			.where(eq(remoteDevices.id, ids.device));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth device owner no longer matches the grant",
		});

		await db
			.update(remoteDevices)
			.set({ createdBy: ids.user })
			.where(eq(remoteDevices.id, ids.device));
		await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.id, ids.binding));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth device project access has been revoked",
		});
	});

	test("enforces the live global-device policy intersection", async () => {
		const { ids } = await createFixture();
		await db.update(remoteDevices).set({ scope: "global" }).where(eq(remoteDevices.id, ids.device));
		await db
			.update(oauthClients)
			.set({ policyJson: { ...allowGlobalPolicy, allowGlobalDevice: false } })
			.where(eq(oauthClients.id, ids.client));
		expect(await resolveOAuthDeviceRuntimeAuthorization(deviceResource(ids))).toMatchObject({
			allowed: false,
			reason: "OAuth global device access has been revoked",
		});
	});
});
