import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { CanonicalCapabilityId } from "@shared/integrations/capabilities";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
	narrators,
	oauthClients,
	oauthGrantEvents,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { normalizeOAuthClientPolicy } from "../../lib/oauth-client-policy";
import { createDevice } from "../device-service";
import {
	listExternalDevices,
	listExternalProjects,
	provisionExternalDevice,
	provisionExternalNarrator,
	rotateExternalDeviceCredential,
} from "../external-resource-service";
import { integrationAuthorityService } from "../integration-authority-service";
import { integrationResourceBindingService } from "../integration-resource-binding-service";
import type { ExternalOAuthContext } from "../oauth-resource-access";

const ids = {
	user: generateId(),
	client: generateId(),
	grant: generateId(),
	allowedProjectA: generateId(),
	allowedProjectB: generateId(),
	deniedProject: generateId(),
	projectDevice: generateId(),
	globalAllowedDevice: generateId(),
	globalDeniedDevice: generateId(),
	orphanedDevice: generateId(),
	deniedProjectDevice: generateId(),
};
const now = new Date().toISOString();
const deviceIds = [
	ids.projectDevice,
	ids.globalAllowedDevice,
	ids.globalDeniedDevice,
	ids.orphanedDevice,
	ids.deniedProjectDevice,
];
const createdDeviceIds = new Set<string>();
const createdNarratorIds = new Set<string>();

function deviceIdentity(projectId: string, scope: "global" | "project") {
	return {
		provisionIdentity: {
			version: 1,
			algorithm: "sha256",
			digest: createHash("sha256")
				.update(JSON.stringify({ version: 1, resourceType: "device", projectId, scope }))
				.digest("hex"),
		},
	};
}

function deviceRow(id: string, index: number, scope: "global" | "project", projectId: string) {
	return {
		id,
		name: `External list device ${index}`,
		slug: `external-list-${index}-${id.slice(0, 8)}`,
		tokenHash: `external-list-hash-${index}`,
		tokenPrefix: `rdev_el${index}`,
		connectionMode: "reverse" as const,
		status: "offline" as const,
		scope,
		projectId,
		createdBy: ids.user,
		oauthOwnerGrantId: null,
		oauthProvisionKey: `legacy-wrong-${index}`,
		createdAt: new Date(Date.parse(now) + index).toISOString(),
		updatedAt: now,
	};
}

const context: ExternalOAuthContext = {
	principal: {} as ExternalOAuthContext["principal"],
	userId: ids.user,
	grantId: ids.grant,
	oauthClientId: ids.client,
	clientId: `external-list-${ids.client}`,
	scopes: [
		"project.read",
		"device.read",
		"device.provision",
		"device.rotate",
		"narrator.provision",
	],
	authorityRevision: 1,
	projectIds: [ids.allowedProjectA, ids.allowedProjectB],
	allowedProjectIds: new Set([ids.allowedProjectA, ids.allowedProjectB]),
	capabilityProjectIds: new Map([
		["project.read", new Set([ids.allowedProjectA, ids.allowedProjectB])],
		["device.read", new Set([ids.allowedProjectA, ids.allowedProjectB])],
		["device.provision", new Set([ids.allowedProjectA, ids.allowedProjectB])],
		["device.rotate", new Set([ids.allowedProjectA, ids.allowedProjectB])],
		["narrator.provision", new Set([ids.allowedProjectA, ids.allowedProjectB])],
	]),
	policy: normalizeOAuthClientPolicy({ allowGlobalDevice: true }),
};

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `external-list-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values([
		{
			id: ids.allowedProjectA,
			name: "External list A",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: ids.allowedProjectB,
			name: "External list B",
			createdAt: now,
			updatedAt: now,
		},
		{
			id: ids.deniedProject,
			name: "External list C",
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: context.clientId,
		name: "External list client",
		redirectUris: [],
		scopes: [
			"project.read",
			"device.read",
			"device.provision",
			"device.rotate",
			"narrator.provision",
		],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrants).values({
		id: ids.grant,
		oauthClientId: ids.client,
		userId: ids.user,
		scopes: [
			"project.read",
			"device.read",
			"device.provision",
			"device.rotate",
			"narrator.provision",
		],
		createdAt: now,
		updatedAt: now,
	});
	await integrationAuthorityService.create({
		id: ids.grant,
		kind: "oauth_grant",
		integrationType: "oauth_client",
		integrationId: ids.client,
		ownerUserId: ids.user,
		sourceGrantId: ids.grant,
		policyJson: context.policy,
		grants: (context.scopes as CanonicalCapabilityId[]).flatMap((capabilityId) => [
			{
				capabilityId,
				scope: { type: "integration" as const, id: ids.grant },
				createdBy: { type: "user" as const, id: ids.user },
			},
			...context.projectIds.map((projectId) => ({
				capabilityId,
				scope: { type: "project" as const, id: projectId },
				createdBy: { type: "user" as const, id: ids.user },
			})),
		]),
	});
	await db
		.insert(remoteDevices)
		.values([
			deviceRow(ids.projectDevice, 0, "project", ids.allowedProjectA),
			deviceRow(ids.globalAllowedDevice, 1, "global", ids.allowedProjectA),
			deviceRow(ids.globalDeniedDevice, 2, "global", ids.deniedProject),
			deviceRow(ids.orphanedDevice, 3, "project", ids.allowedProjectA),
			deviceRow(ids.deniedProjectDevice, 4, "project", ids.deniedProject),
		]);
	for (const [index, resourceId] of deviceIds.entries()) {
		await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			state: resourceId === ids.orphanedDevice ? "orphaned" : "active",
			provisionKey: `external-list-${index}`,
			metadataJson: { provisionKey: `external-list-${index}` },
		});
	}
});

afterAll(async () => {
	const allDeviceIds = [...deviceIds, ...createdDeviceIds];
	const allResourceIds = [...allDeviceIds, ...createdNarratorIds];
	await db
		.delete(integrationResourceBindings)
		.where(inArray(integrationResourceBindings.resourceId, allResourceIds));
	if (createdNarratorIds.size > 0) {
		await db.delete(narrators).where(inArray(narrators.id, [...createdNarratorIds]));
	}
	await db.delete(remoteDevices).where(inArray(remoteDevices.id, allDeviceIds));
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.grantId, ids.grant));
	await db.delete(integrationAuthorities).where(eq(integrationAuthorities.id, ids.grant));
	await db.delete(oauthGrants).where(eq(oauthGrants.id, ids.grant));
	await db.delete(oauthClients).where(eq(oauthClients.id, ids.client));
	await db
		.delete(projects)
		.where(inArray(projects.id, [ids.allowedProjectA, ids.allowedProjectB, ids.deniedProject]));
	await db.delete(users).where(eq(users.id, ids.user));
});

describe("external integration resource lists", () => {
	test("paginates only projects in the live grant allow-list", async () => {
		const first = await listExternalProjects(context, { limit: 1 });
		expect(first.items.map((project) => project.id)).toEqual([ids.allowedProjectA]);
		expect(first.nextCursor).toBeTruthy();
		const second = await listExternalProjects(context, {
			limit: 1,
			cursor: first.nextCursor ?? undefined,
		});
		expect(second.items.map((project) => project.id)).toEqual([ids.allowedProjectB]);
		expect(second.nextCursor).toBeNull();
	});

	test("requires both project visibility and an active provenance binding for devices", async () => {
		const result = await listExternalDevices(context, { limit: 10 });
		expect(new Set(result.items.map((device) => device.id))).toEqual(
			new Set([ids.projectDevice, ids.globalAllowedDevice]),
		);
		expect(result.nextCursor).toBeNull();

		const noGlobal = await listExternalDevices(
			{ ...context, policy: normalizeOAuthClientPolicy({ allowGlobalDevice: false }) },
			{ limit: 10 },
		);
		expect(noGlobal.items.map((device) => device.id)).toEqual([ids.projectDevice]);
	});

	test("fails closed when a legacy provision binding has no versioned identity", async () => {
		await expect(
			provisionExternalDevice(context, "external-list-0", {
				projectId: ids.allowedProjectA,
				name: "Ignored idempotent name",
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "RESOURCE_PROVISION_CONFLICT" });
	});

	test("rolls back device, binding, and OAuth event when create fails before commit", async () => {
		const eventCountBefore = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, ids.grant),
		});
		await expect(
			provisionExternalDevice(
				context,
				"atomic-create-failure",
				{ projectId: ids.allowedProjectA, name: "Atomic create rollback device" },
				{
					beforeDeviceTransactionCommit: () => {
						throw new Error("injected create failure");
					},
				},
			),
		).rejects.toThrow("injected create failure");
		expect(
			await db.query.remoteDevices.findFirst({
				where: eq(remoteDevices.name, "Atomic create rollback device"),
			}),
		).toBeUndefined();
		expect(
			await integrationResourceBindingService.getByProvisionKey({
				authorityType: "oauth_grant",
				authorityId: ids.grant,
				resourceType: "device",
				provisionKey: "atomic-create-failure",
			}),
		).toBeNull();
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: eq(oauthGrantEvents.grantId, ids.grant),
			}),
		).toHaveLength(eventCountBefore.length);
	});

	test("rolls back token hash and OAuth event when rotation fails before commit", async () => {
		const created = await provisionExternalDevice(context, "atomic-rotate", {
			projectId: ids.allowedProjectA,
		});
		createdDeviceIds.add(created.device.id);
		const before = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, created.device.id),
		});
		const eventCountBefore = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, ids.grant),
		});
		await expect(
			rotateExternalDeviceCredential(context, created.device.id, {
				beforeDeviceRotateTransactionCommit: () => {
					throw new Error("injected rotate failure");
				},
			}),
		).rejects.toThrow("injected rotate failure");
		const after = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, created.device.id),
		});
		expect(after?.tokenHash).toBe(before?.tokenHash);
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: eq(oauthGrantEvents.grantId, ids.grant),
			}),
		).toHaveLength(eventCountBefore.length);
	});

	test("reuses and validates a concurrent provision winner", async () => {
		let winnerId = "";
		const result = await provisionExternalDevice(
			context,
			"injected-winner",
			{ projectId: ids.allowedProjectA, name: "Losing device" },
			{
				beforeDeviceCreateAttempt: async () => {
					const winner = await createDevice({
						name: "Winning device",
						slug: `external-winner-${generateId().slice(0, 8)}`,
						connectionMode: "reverse",
						scope: "project",
						projectId: ids.allowedProjectA,
						createdBy: ids.user,
					});
					winnerId = winner.device.id;
					createdDeviceIds.add(winnerId);
					await integrationResourceBindingService.create({
						resourceType: "device",
						resourceId: winnerId,
						sourceType: "oauth_client",
						sourceId: ids.client,
						authorityType: "oauth_grant",
						authorityId: ids.grant,
						provisionKey: "injected-winner",
						metadataJson: deviceIdentity(ids.allowedProjectA, "project"),
					});
				},
			},
		);
		expect(result).toMatchObject({
			created: false,
			credential: null,
			device: { id: winnerId, name: "Winning device" },
		});
		expect(
			await db.query.remoteDevices.findFirst({ where: eq(remoteDevices.name, "Losing device") }),
		).toBeUndefined();
	});

	test("rolls back narrator, binding, and event when the provision transaction fails", async () => {
		const title = `Injected narrator rollback ${generateId()}`;
		const provisionKey = `narrator-rollback-${generateId().slice(0, 8)}`;
		const eventCountBefore = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, ids.grant),
		});
		await expect(
			provisionExternalNarrator(
				context,
				provisionKey,
				{
					projectId: ids.allowedProjectA,
					deviceId: ids.projectDevice,
					title,
				},
				{
					beforeNarratorTransactionCommit: (tx, narratorId) => {
						expect(
							tx
								.select({ id: narrators.id })
								.from(narrators)
								.where(eq(narrators.id, narratorId))
								.get(),
						).toEqual({ id: narratorId });
						expect(
							tx
								.select({ resourceId: integrationResourceBindings.resourceId })
								.from(integrationResourceBindings)
								.where(eq(integrationResourceBindings.provisionKey, provisionKey))
								.get(),
						).toEqual({ resourceId: narratorId });
						expect(
							tx
								.select({ requestId: oauthGrantEvents.requestId })
								.from(oauthGrantEvents)
								.where(
									eq(oauthGrantEvents.requestId, `resource-provisioned:narrator:${narratorId}`),
								)
								.get(),
						).toEqual({ requestId: `resource-provisioned:narrator:${narratorId}` });
						throw new Error("injected narrator transaction failure");
					},
				},
			),
		).rejects.toThrow("injected narrator transaction failure");
		expect(
			await db.query.narrators.findFirst({ where: eq(narrators.title, title) }),
		).toBeUndefined();
		expect(
			await integrationResourceBindingService.getByProvisionKey({
				authorityType: "oauth_grant",
				authorityId: ids.grant,
				resourceType: "narrator",
				provisionKey,
			}),
		).toBeNull();
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: eq(oauthGrantEvents.grantId, ids.grant),
			}),
		).toHaveLength(eventCountBefore.length);

		const retried = await provisionExternalNarrator(context, provisionKey, {
			projectId: ids.allowedProjectA,
			deviceId: ids.projectDevice,
			title,
		});
		createdNarratorIds.add(retried.narrator.id);
		expect(retried.created).toBe(true);
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: and(
					eq(oauthGrantEvents.grantId, ids.grant),
					eq(oauthGrantEvents.requestId, `resource-provisioned:narrator:${retried.narrator.id}`),
				),
			}),
		).toHaveLength(1);
	});

	test("commits narrator, binding, and provision event together exactly once", async () => {
		const provisionKey = `narrator-atomic-success-${generateId().slice(0, 8)}`;
		const title = `Atomic narrator success ${generateId()}`;
		let beforeCommitCalls = 0;
		const result = await provisionExternalNarrator(
			context,
			provisionKey,
			{
				projectId: ids.allowedProjectA,
				deviceId: ids.projectDevice,
				title,
			},
			{
				beforeNarratorTransactionCommit: (tx, narratorId) => {
					beforeCommitCalls++;
					expect(
						tx
							.select({ id: narrators.id })
							.from(narrators)
							.where(eq(narrators.id, narratorId))
							.get(),
					).toEqual({ id: narratorId });
					expect(
						tx
							.select({ resourceId: integrationResourceBindings.resourceId })
							.from(integrationResourceBindings)
							.where(eq(integrationResourceBindings.provisionKey, provisionKey))
							.get(),
					).toEqual({ resourceId: narratorId });
					expect(
						tx
							.select({ requestId: oauthGrantEvents.requestId })
							.from(oauthGrantEvents)
							.where(eq(oauthGrantEvents.requestId, `resource-provisioned:narrator:${narratorId}`))
							.get(),
					).toEqual({ requestId: `resource-provisioned:narrator:${narratorId}` });
				},
			},
		);
		createdNarratorIds.add(result.narrator.id);
		expect(beforeCommitCalls).toBe(1);
		expect(result.created).toBe(true);
		expect(await db.select().from(narrators).where(eq(narrators.title, title))).toHaveLength(1);
		expect(
			await db
				.select()
				.from(integrationResourceBindings)
				.where(eq(integrationResourceBindings.provisionKey, provisionKey)),
		).toHaveLength(1);
		expect(
			await db
				.select()
				.from(oauthGrantEvents)
				.where(
					eq(oauthGrantEvents.requestId, `resource-provisioned:narrator:${result.narrator.id}`),
				),
		).toHaveLength(1);
	});

	test("concurrent narrator provision keys create one resource and replay the winner", async () => {
		const provisionKey = `narrator-concurrent-${generateId().slice(0, 8)}`;
		const title = `Concurrent narrator ${generateId()}`;
		const request = {
			projectId: ids.allowedProjectA,
			deviceId: ids.projectDevice,
			title,
		};
		const results = await Promise.all([
			provisionExternalNarrator(context, provisionKey, request),
			provisionExternalNarrator(context, provisionKey, request),
		]);
		const narratorId = results[0].narrator.id;
		createdNarratorIds.add(narratorId);
		expect(results.map((result) => result.narrator.id)).toEqual([narratorId, narratorId]);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		expect(await db.select().from(narrators).where(eq(narrators.title, title))).toHaveLength(1);
		expect(
			await db
				.select()
				.from(integrationResourceBindings)
				.where(eq(integrationResourceBindings.provisionKey, provisionKey)),
		).toHaveLength(1);
		expect(
			await db
				.select()
				.from(oauthGrantEvents)
				.where(eq(oauthGrantEvents.requestId, `resource-provisioned:narrator:${narratorId}`)),
		).toHaveLength(1);
	});

	test("repairs a missing narrator provision event idempotently on replay", async () => {
		const provisionKey = `narrator-event-repair-${generateId().slice(0, 8)}`;
		const request = {
			projectId: ids.allowedProjectA,
			deviceId: ids.projectDevice,
			title: `Narrator event repair ${generateId()}`,
		};
		const created = await provisionExternalNarrator(context, provisionKey, request);
		createdNarratorIds.add(created.narrator.id);
		const requestId = `resource-provisioned:narrator:${created.narrator.id}`;
		await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.requestId, requestId));
		expect(
			await db.query.oauthGrantEvents.findFirst({
				where: eq(oauthGrantEvents.requestId, requestId),
			}),
		).toBeUndefined();

		const repaired = await provisionExternalNarrator(context, provisionKey, request);
		expect(repaired).toMatchObject({
			created: false,
			narrator: { id: created.narrator.id },
		});
		const replayed = await provisionExternalNarrator(context, provisionKey, request);
		expect(replayed.created).toBe(false);
		expect(
			await db.query.oauthGrantEvents.findMany({
				where: eq(oauthGrantEvents.requestId, requestId),
			}),
		).toHaveLength(1);
	});
});
