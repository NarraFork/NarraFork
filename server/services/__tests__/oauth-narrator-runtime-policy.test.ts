import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
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
import { integrationResourceBindingService } from "../integration-resource-binding-service";
import { createOAuthGrant, revokeOAuthGrantForUser } from "../oauth-grant-service";
import { resolveOAuthNarratorRuntimePolicy } from "../oauth-narrator-runtime-policy";

const ids = {
	user: generateId(),
	project: generateId(),
	client: generateId(),
	grant: generateId(),
	grantProject: generateId(),
	device: generateId(),
	device2: generateId(),
	narrator: generateId(),
	narratorV2: generateId(),
};
const now = new Date().toISOString();
const appendPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly", "dontAsk"],
	systemPromptMode: "append",
	maxSystemPromptChars: 100,
	allowGlobalDevice: false,
	allowKnowledgeWrite: true,
	allowDangerReflectionPrompt: false,
	maxDangerReflectionPromptChars: 0,
	allowRobotDiagnosticPreset: false,
	deviceAccess: { host: "denied", global: "readWrite", selfRegistered: "readWrite" },
	messageDetail: "summary",
};
const managedPolicy: OAuthClientPolicy = {
	defaultPermissionMode: "readOnly",
	allowedPermissionModes: ["readOnly"],
	systemPromptMode: "managed",
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
	allowDangerReflectionPrompt: false,
	maxDangerReflectionPromptChars: 0,
	allowRobotDiagnosticPreset: false,
	deviceAccess: { host: "denied", global: "denied", selfRegistered: "denied" },
	messageDetail: "summary",
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
		integrationType: "oauth_client",
		integrationId: ids.client,
		sourceGrantId: ids.grant,
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
	await db.insert(remoteDevices).values([
		{
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
		},
		{
			id: ids.device2,
			name: "OAuth runtime device 2",
			slug: `oauth-runtime-${ids.device2.slice(0, 8)}`,
			tokenHash: "runtime-hash-2",
			tokenPrefix: "rdev_runtime2",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: ids.project,
			createdBy: ids.user,
			oauthOwnerGrantId: null,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(narrators).values({
		id: ids.narrator,
		permissionMode: "bypassPermissions",
		systemPrompt: "mutable prompt must not win",
		contextProjectId: ids.project,
		defaultDeviceId: ids.device,
		oauthOwnerGrantId: null,
		oauthProvisionKey: "legacy-wrong-runtime",
		oauthPolicySnapshotJson: {
			version: 2,
			policy: appendPolicy,
			permissionMode: "readOnly",
			systemPrompt: "frozen prompt",
			projectId: ids.project,
			defaultDeviceId: ids.device,
			deviceIds: [ids.device],
		},
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: ids.narratorV2,
		permissionMode: "readOnly",
		contextProjectId: ids.project,
		defaultDeviceId: ids.device,
		oauthPolicySnapshotJson: {
			version: 2,
			policy: appendPolicy,
			permissionMode: "readOnly",
			systemPrompt: "v2 frozen prompt",
			projectId: ids.project,
			defaultDeviceId: ids.device,
			deviceIds: [ids.device, ids.device2].sort(),
		},
		createdAt: now,
		updatedAt: now,
	});
	await integrationResourceBindingService.create({
		resourceType: "device",
		resourceId: ids.device,
		sourceType: "oauth_client",
		sourceId: ids.client,
		authorityType: "oauth_grant",
		authorityId: ids.grant,
		state: "active",
	});
	await integrationResourceBindingService.create({
		resourceType: "device",
		resourceId: ids.device2,
		sourceType: "oauth_client",
		sourceId: ids.client,
		authorityType: "oauth_grant",
		authorityId: ids.grant,
		state: "active",
	});
	await integrationResourceBindingService.create({
		resourceType: "narrator",
		resourceId: ids.narrator,
		sourceType: "oauth_client",
		sourceId: ids.client,
		authorityType: "oauth_grant",
		authorityId: ids.grant,
		state: "active",
	});
	await integrationResourceBindingService.create({
		resourceType: "narrator",
		resourceId: ids.narratorV2,
		sourceType: "oauth_client",
		sourceId: ids.client,
		authorityType: "oauth_grant",
		authorityId: ids.grant,
		state: "active",
	});
});

afterAll(async () => {
	await db
		.delete(integrationResourceBindings)
		.where(
			inArray(integrationResourceBindings.resourceId, [
				ids.device,
				ids.device2,
				ids.narrator,
				ids.narratorV2,
			]),
		);
	await db.delete(narrators).where(inArray(narrators.id, [ids.narrator, ids.narratorV2]));
	await db.delete(remoteDevices).where(inArray(remoteDevices.id, [ids.device, ids.device2]));
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
			defaultDeviceId: ids.device,
			deviceIds: [ids.device],
			permissionMode: "readOnly",
			systemPrompt: "frozen prompt",
			allowKnowledgeWrite: true,
			allowLocalExecution: false,
		});
		expect(policy?.allowedTools.has("KnowledgeCreate")).toBe(true);
		expect(policy?.allowedTools.has("Bash")).toBe(true);
		expect(policy?.allowedTools.has("Write")).toBe(true);
		expect(policy?.allowedTools.has("Edit")).toBe(true);
	});

	test("rejects obsolete v1 runtime snapshots", async () => {
		await db
			.update(narrators)
			.set({
				oauthPolicySnapshotJson: {
					version: 1,
					policy: appendPolicy,
					permissionMode: "readOnly",
					systemPrompt: "obsolete prompt",
					projectId: ids.project,
					deviceId: ids.device,
				},
			})
			.where(eq(narrators.id, ids.narrator));
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toThrow(
			"must be reprovisioned with a valid runtime snapshot",
		);
		await db
			.update(narrators)
			.set({
				oauthPolicySnapshotJson: {
					version: 2,
					policy: appendPolicy,
					permissionMode: "readOnly",
					systemPrompt: "frozen prompt",
					projectId: ids.project,
					defaultDeviceId: ids.device,
					deviceIds: [ids.device],
				},
			})
			.where(eq(narrators.id, ids.narrator));
	});

	test("authorizes every v2 device and permits the persisted default within that set", async () => {
		const expectedDeviceIds = [ids.device, ids.device2].sort();
		const initial = await resolveOAuthNarratorRuntimePolicy(ids.narratorV2, ids.user);
		expect(initial).toMatchObject({
			defaultDeviceId: ids.device,
			deviceIds: expectedDeviceIds,
			allowLocalExecution: false,
		});
		expect(initial?.allowedTools.has("SwitchDevice")).toBe(true);

		await db
			.update(narrators)
			.set({ defaultDeviceId: ids.device2 })
			.where(eq(narrators.id, ids.narratorV2));
		const switched = await resolveOAuthNarratorRuntimePolicy(ids.narratorV2, ids.user);
		expect(switched?.defaultDeviceId).toBe(ids.device2);
		expect(switched?.deviceIds).toEqual(expectedDeviceIds);

		await db
			.update(integrationResourceBindings)
			.set({ sourceId: generateId() })
			.where(eq(integrationResourceBindings.resourceId, ids.device2));
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narratorV2, ids.user)).rejects.toThrow(
			"OAuth narrator device binding is inactive",
		);
		await db
			.update(integrationResourceBindings)
			.set({ sourceId: ids.client })
			.where(eq(integrationResourceBindings.resourceId, ids.device2));
	});

	test("never falls back to an ordinary session when OAuth provenance is missing", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(
				and(
					eq(integrationResourceBindings.resourceType, "narrator"),
					eq(integrationResourceBindings.resourceId, ids.narrator),
				),
			);
		await expect(resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user)).rejects.toThrow(
			"OAuth narrator provenance is missing",
		);
		await integrationResourceBindingService.create({
			resourceType: "narrator",
			resourceId: ids.narrator,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			state: "active",
		});
	});

	test("ignores oauth_grants mirror fields when authority and bindings remain active", async () => {
		await db
			.update(oauthGrants)
			.set({ scopes: [], policyJson: managedPolicy, updatedAt: new Date().toISOString() })
			.where(eq(oauthGrants.id, ids.grant));
		await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.grantId, ids.grant));

		const policy = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(policy?.policy).toMatchObject({
			deviceAccess: { host: "denied", global: "readWrite", selfRegistered: "readWrite" },
		});
		expect(policy?.allowedTools.has("Bash")).toBe(true);
		expect(policy?.allowedTools.has("Write")).toBe(true);
		expect(policy?.allowLocalExecution).toBe(false);

		await db
			.update(oauthGrants)
			.set({
				scopes: ["narrator.send_message"],
				policyJson: appendPolicy,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(oauthGrants.id, ids.grant));
		await db.insert(oauthGrantProjects).values({
			id: ids.grantProject,
			grantId: ids.grant,
			projectId: ids.project,
			createdAt: now,
		});
	});

	test("widening deviceAccess.host to readWrite flips allowLocalExecution to true, and reverting restores the default-denied posture", async () => {
		// Baseline: host is denied by default (appendPolicy never widened it).
		const denied = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(denied?.allowLocalExecution).toBe(false);

		// The effective policy is the intersection of client, authority, AND the
		// narrator's own frozen snapshot policy — per the "ceiling only shrinks" design,
		// ALL THREE layers must agree host is widened, not just the live client policy.
		const hostWidenedPolicy: OAuthClientPolicy = {
			...appendPolicy,
			deviceAccess: { ...appendPolicy.deviceAccess, host: "readWrite" },
		};
		await db
			.update(oauthClients)
			.set({ policyJson: hostWidenedPolicy, updatedAt: new Date().toISOString() })
			.where(eq(oauthClients.id, ids.client));
		await db
			.update(integrationAuthorities)
			.set({ policyJson: hostWidenedPolicy })
			.where(eq(integrationAuthorities.id, ids.grant));
		await db
			.update(narrators)
			.set({
				oauthPolicySnapshotJson: {
					version: 2,
					policy: hostWidenedPolicy,
					permissionMode: "readOnly",
					systemPrompt: "frozen prompt",
					projectId: ids.project,
					defaultDeviceId: ids.device,
					deviceIds: [ids.device],
				},
			})
			.where(eq(narrators.id, ids.narrator));

		const widened = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(widened?.allowLocalExecution).toBe(true);
		expect(widened?.policy.deviceAccess.host).toBe("readWrite");

		// Reverting only the live client policy (while the frozen snapshot stays widened)
		// must re-close host, confirming the client layer alone cannot keep it open —
		// every layer is still required, symmetric with the widening direction.
		await db
			.update(oauthClients)
			.set({ policyJson: appendPolicy, updatedAt: new Date().toISOString() })
			.where(eq(oauthClients.id, ids.client));
		const restored = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(restored?.allowLocalExecution).toBe(false);

		// Restore all three layers to the original fixture policy for subsequent tests.
		await db
			.update(integrationAuthorities)
			.set({ policyJson: appendPolicy })
			.where(eq(integrationAuthorities.id, ids.grant));
		await db
			.update(narrators)
			.set({
				oauthPolicySnapshotJson: {
					version: 2,
					policy: appendPolicy,
					permissionMode: "readOnly",
					systemPrompt: "frozen prompt",
					projectId: ids.project,
					defaultDeviceId: ids.device,
					deviceIds: [ids.device],
				},
			})
			.where(eq(narrators.id, ids.narrator));
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
		expect(policy?.allowedTools.has("Bash")).toBe(false);
		expect(policy?.allowedTools.has("Write")).toBe(false);
		expect(policy?.allowedTools.has("Edit")).toBe(false);
	});

	// Uses its own narrator/policy rows: these cases rewrite the client and authority
	// policies, and the shared ids.narrator fixture is depended on by the revocation tests
	// that follow.
	describe("bypassPermissions narrators", () => {
		const bypassNarratorId = generateId();
		const bypassPolicy = {
			...appendPolicy,
			defaultPermissionMode: "bypassPermissions" as const,
			allowedPermissionModes: ["bypassPermissions", "readOnly", "dontAsk"],
			allowDangerReflectionPrompt: true,
			maxDangerReflectionPromptChars: 200,
			// The frozen snapshot participates in the policy intersection, so the preset must be
			// enabled here too for the "every layer allows it" path to be exercised.
			allowRobotDiagnosticPreset: true,
		};
		const reflectionPrompt = "field diagnostics: read-only inspection is expected";

		beforeAll(async () => {
			await db.insert(narrators).values({
				id: bypassNarratorId,
				permissionMode: "bypassPermissions",
				contextProjectId: null,
				defaultDeviceId: ids.device,
				oauthPolicySnapshotJson: {
					version: 3,
					policy: bypassPolicy,
					permissionMode: "bypassPermissions",
					systemPrompt: null,
					dangerReflectionPrompt: reflectionPrompt,
					projectId: null,
					defaultDeviceId: ids.device,
					deviceIds: [ids.device, ids.device2].sort(),
				},
				createdAt: now,
				updatedAt: now,
			});
			await integrationResourceBindingService.create({
				resourceType: "narrator",
				resourceId: bypassNarratorId,
				sourceType: "oauth_client",
				sourceId: ids.client,
				authorityType: "oauth_grant",
				authorityId: ids.grant,
				state: "active",
			});
		});

		afterAll(async () => {
			await db
				.delete(integrationResourceBindings)
				.where(eq(integrationResourceBindings.resourceId, bypassNarratorId));
			await db.delete(narrators).where(eq(narrators.id, bypassNarratorId));
			await setLivePolicies(appendPolicy);
		});

		async function setLivePolicies(policyJson: Record<string, unknown>) {
			await db
				.update(oauthClients)
				.set({ policyJson, updatedAt: new Date().toISOString() })
				.where(eq(oauthClients.id, ids.client));
			await db
				.update(integrationAuthorities)
				.set({ policyJson })
				.where(eq(integrationAuthorities.id, ids.grant));
		}

		// The reflection loop cannot settle a pause without its decision tools, and
		// executeTool enforces allowedTools before the permission handler runs. Admitting
		// them is what makes bypassPermissions review-based rather than fail-closed.
		test("admit the danger reflection decision tools and keep the client prompt", async () => {
			await setLivePolicies(bypassPolicy);
			const policy = await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user);
			expect(policy?.permissionMode).toBe("bypassPermissions");
			expect(policy?.dangerReflectionPrompt).toBe(reflectionPrompt);
			expect(policy?.allowedTools.has("DangerConfirm")).toBe(true);
			expect(policy?.allowedTools.has("DangerCancel")).toBe(true);
		});

		test("drop to readOnly without the reflection tools when the policy stops allowing bypass", async () => {
			await setLivePolicies({
				...bypassPolicy,
				defaultPermissionMode: "readOnly",
				allowedPermissionModes: ["readOnly", "dontAsk"],
			});
			const policy = await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user);
			expect(policy?.permissionMode).toBe("readOnly");
			expect(policy?.allowedTools.has("DangerConfirm")).toBe(false);
			expect(policy?.allowedTools.has("DangerCancel")).toBe(false);
		});

		test("fall all the way to dontAsk when it is the only surviving mode", async () => {
			await setLivePolicies({
				...bypassPolicy,
				defaultPermissionMode: "dontAsk",
				allowedPermissionModes: ["dontAsk"],
			});
			const policy = await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user);
			expect(policy?.permissionMode).toBe("dontAsk");
		});

		// The appendix is advisory context, not a capability: revoking it must degrade the
		// reflection prompt, never break an existing diagnostic session.
		test("drop the reflection prompt when the capability is revoked", async () => {
			await setLivePolicies({ ...bypassPolicy, allowDangerReflectionPrompt: false });
			const policy = await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user);
			expect(policy?.permissionMode).toBe("bypassPermissions");
			expect(policy?.dangerReflectionPrompt).toBeUndefined();
		});

		test("drop the reflection prompt when it exceeds the current ceiling", async () => {
			await setLivePolicies({ ...bypassPolicy, maxDangerReflectionPromptChars: 5 });
			const policy = await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user);
			expect(policy?.dangerReflectionPrompt).toBeUndefined();
		});

		// The preset is a policy ceiling like every other dimension: it survives only when the
		// client, the authority, and the frozen snapshot all allow it, and revoking it on the
		// live client is enough to drop it from an already-provisioned narrator.
		test("expose the robot diagnostic preset only while every policy layer allows it", async () => {
			await setLivePolicies({ ...bypassPolicy, allowRobotDiagnosticPreset: true });
			expect(
				(await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user))
					?.useRobotDiagnosticPreset,
			).toBe(true);

			await setLivePolicies({ ...bypassPolicy, allowRobotDiagnosticPreset: false });
			expect(
				(await resolveOAuthNarratorRuntimePolicy(bypassNarratorId, ids.user))
					?.useRobotDiagnosticPreset,
			).toBe(false);
		});
	});

	test("project removal alone no longer revokes runtime under grant ownership", async () => {
		// De-projectization: OAuth grants are bound by ownership, not projects. Re-consenting
		// with an empty project list must NOT revoke an already-provisioned narrator as long as
		// the narrator.send_message capability remains on the authority. Only grant revocation
		// (covered by the next test) tears down the runtime.
		await db.update(narrators).set({ status: "working" }).where(eq(narrators.id, ids.narrator));
		await createOAuthGrant({
			userId: ids.user,
			oauthClientId: ids.client,
			scopes: ["narrator.send_message"],
			projectIds: [],
			policyJson: managedPolicy,
		});
		const policy = await resolveOAuthNarratorRuntimePolicy(ids.narrator, ids.user);
		expect(policy).not.toBeNull();
		expect(policy?.grantId).toBe(ids.grant);
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
		expect(buffered).toHaveLength(1);
		expect(buffered[0]?.state).toBe("cancelled");
		expect(
			buffered.filter((row) => row.state === "queued" || row.state === "claimed"),
		).toHaveLength(0);
		// Cancellation retains the audit state but clears the resumable payload.
		expect(buffered[0]?.text).toBe("");
		const stopped = await db.query.narrators.findFirst({
			where: eq(narrators.id, ids.narrator),
			columns: { status: true, substatus: true },
		});
		expect(stopped?.status).toBe("idle");
		expect(stopped?.substatus).toContain("authorization_revoked");
	});
});
