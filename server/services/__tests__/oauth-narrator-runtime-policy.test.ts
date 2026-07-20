import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
	narratorBufferedMessages,
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
import { integrationAuthorityService } from "../integration-authority-service";
import { createOAuthGrant, revokeOAuthGrantForUser } from "../oauth-grant-service";
import { resolveOAuthNarratorRuntimePolicy } from "../oauth-narrator-runtime-policy";

const ids = {
	user: generateId(),
	project: generateId(),
	client: generateId(),
	grant: generateId(),
	grantProject: generateId(),
	device: generateId(),
	narrator: generateId(),
};
const now = new Date().toISOString();
const appendPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly", "dontAsk"],
	systemPromptMode: "append",
	maxSystemPromptChars: 100,
	allowGlobalDevice: false,
	allowKnowledgeWrite: true,
};
const managedPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
};

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `oauth-runtime-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: ids.project,
		name: "OAuth runtime project",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: `oauth-runtime-${ids.client}`,
		name: "OAuth runtime client",
		redirectUris: [],
		scopes: ["narrator.send_message"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		policyJson: appendPolicy,
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrants).values({
		id: ids.grant,
		oauthClientId: ids.client,
		userId: ids.user,
		scopes: ["narrator.send_message"],
		policyJson: appendPolicy,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrantProjects).values({
		id: ids.grantProject,
		grantId: ids.grant,
		projectId: ids.project,
		createdAt: now,
	});
	await integrationAuthorityService.create({
		id: ids.grant,
		kind: "oauth_grant",
		integrationId: ids.client,
		ownerUserId: ids.user,
		policyJson: appendPolicy,
		grants: [
			{
				capabilityId: "narrator.send_message",
				scope: { type: "project", id: ids.project },
				createdBy: { type: "user", id: ids.user },
			},
		],
	});
	await db.insert(remoteDevices).values({
		id: ids.device,
		name: "OAuth runtime device",
		slug: `oauth-runtime-${ids.device.slice(0, 8)}`,
		tokenHash: "runtime-hash",
		tokenPrefix: "rdev_runtime",
		connectionMode: "reverse",
		status: "offline",
		scope: "project",
		projectId: ids.project,
		createdBy: ids.user,
		oauthOwnerGrantId: null,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: ids.narrator,
		permissionMode: "bypassPermissions",
		systemPrompt: "mutable prompt must not win",
		contextProjectId: ids.project,
		defaultDeviceId: ids.device,
		oauthOwnerGrantId: null,
		oauthProvisionKey: "legacy-wrong-runtime",
		oauthPolicySnapshotJson: {
			version: 1,
			policy: appendPolicy,
			permissionMode: "readOnly",
			systemPrompt: "frozen prompt",
			projectId: ids.project,
			deviceId: ids.device,
		},
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(integrationResourceBindings).values([
		{
			id: generateId(),
			resourceType: "device",
			resourceId: ids.device,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			state: "active",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: generateId(),
			resourceType: "narrator",
			resourceId: ids.narrator,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			state: "active",
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterAll(async () => {
	await db
		.delete(integrationResourceBindings)
		.where(inArray(integrationResourceBindings.resourceId, [ids.device, ids.narrator]));
	await db.delete(narrators).where(eq(narrators.id, ids.narrator));
	await db.delete(remoteDevices).where(eq(remoteDevices.id, ids.device));
	await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.id, ids.grantProject));
	await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, ids.grant));
	await db.delete(oauthGrants).where(eq(oauthGrants.id, ids.grant));
	await db.delete(oauthClients).where(eq(oauthClients.id, ids.client));
	await db.delete(projects).where(eq(projects.id, ids.project));
	await db.delete(users).where(eq(users.id, ids.user));
});

describe("OAuth narrator runtime policy", () => {
	test("uses bindings despite empty or tampered legacy ownership columns", async () => {
		const policy = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(policy).toMatchObject({
			grantId: ids.grant,
			userId: ids.user,
			projectId: ids.project,
			deviceId: ids.device,
			permissionMode: "readOnly",
			systemPrompt: "frozen prompt",
			allowKnowledgeWrite: true,
			allowLocalExecution: false,
		});
		expect(policy?.allowedTools.has("KnowledgeCreate")).toBe(true);
		expect(policy?.allowedTools.has("Write")).toBe(false);
	});

	test("rejects a default device bound to a different grant", async () => {
		const binding = await db.query.integrationResourceBindings.findFirst({
			where: eq(integrationResourceBindings.resourceId, ids.device),
		});
		expect(binding).toBeTruthy();
		await db
			.update(integrationResourceBindings)
			.set({ authorityId: generateId() })
			.where(eq(integrationResourceBindings.resourceId, ids.device));
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toThrow(
			"OAuth narrator device binding is inactive",
		);
		await db
			.update(integrationResourceBindings)
			.set({ authorityId: ids.grant })
			.where(eq(integrationResourceBindings.resourceId, ids.device));
	});

	test("live client policy may tighten but never widen the provision snapshot", async () => {
		await db
			.update(oauthClients)
			.set({ policyJson: managedPolicy, updatedAt: new Date().toISOString() })
			.where(eq(oauthClients.id, ids.client));
		const policy = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(policy?.permissionMode).toBe("readOnly");
		expect(policy?.systemPrompt).toBeUndefined();
		expect(policy?.allowKnowledgeWrite).toBe(false);
		expect(policy?.allowedTools.has("KnowledgeCreate")).toBe(false);
	});

	test("re-consent project removal immediately clears queued runtime work", async () => {
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids.narrator));
		await db.insert(narratorBufferedMessages).values({
			id: generateId(),
			narratorId: ids.narrator,
			text: "project removal must never resume",
			seq: 0,
			bufferedAt: new Date().toISOString(),
		});
		await createOAuthGrant({
			userId: ids.user,
			oauthClientId: ids.client,
			scopes: ["narrator.send_message"],
			projectIds: [],
			policyJson: managedPolicy,
		});
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toMatchObject({
			code: "OAUTH_RUNTIME_FORBIDDEN",
		});
		expect(
			await db.query.narratorBufferedMessages.findMany({
				where: eq(narratorBufferedMessages.narratorId, ids.narrator),
			}),
		).toHaveLength(0);
		await db
			.insert(oauthGrantProjects)
			.values({
				id: ids.grantProject,
				grantId: ids.grant,
				projectId: ids.project,
				createdAt: now,
			})
			.onConflictDoNothing();
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toMatchObject({
			code: "OAUTH_RUNTIME_FORBIDDEN",
		});
	});

	test("grant revocation clears durable buffers and leaves the narrator stopped", async () => {
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids.narrator));
		await db.insert(narratorBufferedMessages).values({
			id: generateId(),
			narratorId: ids.narrator,
			text: "grant revoke must never resume",
			seq: 0,
			bufferedAt: new Date().toISOString(),
		});
		await revokeOAuthGrantForUser({ grantId: ids.grant, userId: ids.user });
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toMatchObject({
			code: "OAUTH_RUNTIME_FORBIDDEN",
		});
		const buffered = await db.query.narratorBufferedMessages.findMany({
			where: eq(narratorBufferedMessages.narratorId, ids.narrator),
		});
		expect(buffered).toHaveLength(0);
		const stopped = await db.query.narrators.findFirst({
			where: eq(narrators.id, ids.narrator),
			columns: { status: true, substatus: true },
		});
		expect(stopped?.status).toBe("idle");
		expect(stopped?.substatus).toContain("authorization_revoked");
	});
});
