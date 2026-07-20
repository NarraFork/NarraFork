import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuditEvents,
	integrationResourceBindings,
	narrators,
	oauthClients,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { integrationResourceBindingService } from "../integration-resource-binding-service";

const ids = {
	user: generateId(),
	project: generateId(),
	client: generateId(),
	grant: generateId(),
	deviceA: generateId(),
	deviceB: generateId(),
	deviceC: generateId(),
	narrator: generateId(),
	narratorDelete: generateId(),
};
const now = new Date().toISOString();

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `integration-binding-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: ids.project,
		name: "Integration binding project",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: `integration-binding-${ids.client}`,
		name: "Integration binding client",
		redirectUris: [],
		scopes: ["device.provision", "narrator.provision"],
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
		scopes: ["device.provision", "narrator.provision"],
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(remoteDevices).values(
		[ids.deviceA, ids.deviceB, ids.deviceC].map((id, index) => ({
			id,
			name: `Integration binding device ${index}`,
			slug: `integration-binding-${index}-${id.slice(0, 8)}`,
			tokenHash: `integration-binding-hash-${index}`,
			tokenPrefix: `rdev_ib${index}`,
			connectionMode: "reverse" as const,
			status: "offline" as const,
			scope: "project" as const,
			projectId: ids.project,
			createdBy: ids.user,
			oauthOwnerGrantId: ids.grant,
			oauthProvisionKey: `device-${index}`,
			createdAt: now,
			updatedAt: now,
		})),
	);
	await db.insert(narrators).values([
		{
			id: ids.narrator,
			title: "Integration binding narrator",
			oauthOwnerGrantId: ids.grant,
			oauthProvisionKey: "narrator-0",
			contextProjectId: ids.project,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: ids.narratorDelete,
			title: "Integration binding narrator to delete",
			oauthOwnerGrantId: ids.grant,
			oauthProvisionKey: "narrator-delete",
			contextProjectId: ids.project,
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterAll(async () => {
	await db.delete(integrationAuditEvents).where(eq(integrationAuditEvents.authorityId, ids.grant));
	await db
		.delete(integrationResourceBindings)
		.where(
			inArray(integrationResourceBindings.resourceId, [
				ids.deviceA,
				ids.deviceB,
				ids.deviceC,
				ids.narrator,
				ids.narratorDelete,
			]),
		);
	await db.delete(narrators).where(inArray(narrators.id, [ids.narrator, ids.narratorDelete]));
	await db
		.delete(remoteDevices)
		.where(inArray(remoteDevices.id, [ids.deviceA, ids.deviceB, ids.deviceC]));
	await db.delete(oauthGrants).where(eq(oauthGrants.id, ids.grant));
	await db.delete(oauthClients).where(eq(oauthClients.id, ids.client));
	await db.delete(projects).where(eq(projects.id, ids.project));
	await db.delete(users).where(eq(users.id, ids.user));
});

describe("IntegrationResourceBindingService", () => {
	test("validates polymorphic resources and bounds metadata", async () => {
		await expect(
			integrationResourceBindingService.create({
				resourceType: "device",
				resourceId: generateId(),
				sourceType: "oauth_client",
				sourceId: ids.client,
				authorityType: "oauth_grant",
				authorityId: ids.grant,
			}),
		).rejects.toThrow();
		await expect(
			integrationResourceBindingService.create({
				resourceType: "device",
				resourceId: ids.deviceA,
				sourceType: "oauth_client",
				sourceId: ids.client,
				authorityType: "oauth_grant",
				authorityId: ids.grant,
				metadataJson: { oversized: "x".repeat(5_000) },
			}),
		).rejects.toThrow(/4096/);
	});

	test("serializes concurrent upserts and rejects implicit provenance transfer", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, ids.deviceC));
		const bindings = await Promise.all(
			Array.from({ length: 8 }, () =>
				integrationResourceBindingService.upsert({
					resourceType: "device",
					resourceId: ids.deviceC,
					sourceType: "oauth_client",
					sourceId: ids.client,
					authorityType: "oauth_grant",
					authorityId: ids.grant,
					metadataJson: { provisionKey: "device-2" },
				}),
			),
		);
		expect(new Set(bindings.map((binding) => binding.id)).size).toBe(1);
		const rows = await db.query.integrationResourceBindings.findMany({
			where: eq(integrationResourceBindings.resourceId, ids.deviceC),
		});
		expect(rows).toHaveLength(1);
		await expect(
			integrationResourceBindingService.upsert({
				resourceType: "device",
				resourceId: ids.deviceC,
				sourceType: "oauth_client",
				sourceId: generateId(),
				authorityType: "oauth_grant",
				authorityId: ids.grant,
			}),
		).rejects.toMatchObject({ code: "INTEGRATION_PROVENANCE_CONFLICT" });
	});

	test("preserves lifecycle history and prevents terminal bindings from reactivating", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, ids.deviceC));
		const authorityId = ids.grant;
		await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId: ids.deviceC,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId,
		});
		expect(await integrationResourceBindingService.markOrphaned("oauth_grant", authorityId)).toBe(
			1,
		);
		const orphaned = await integrationResourceBindingService.get("device", ids.deviceC);
		expect(orphaned?.orphanedAt).toBeTruthy();
		expect(await integrationResourceBindingService.markOrphaned("oauth_grant", authorityId)).toBe(
			0,
		);
		expect((await integrationResourceBindingService.get("device", ids.deviceC))?.orphanedAt).toBe(
			orphaned?.orphanedAt,
		);
		expect(await integrationResourceBindingService.markRevoked("device", ids.deviceC)).toBe(true);
		const revoked = await integrationResourceBindingService.get("device", ids.deviceC);
		expect(revoked).toMatchObject({ state: "revoked", orphanedAt: orphaned?.orphanedAt });
		expect(revoked?.revokedAt).toBeTruthy();

		const stillRevoked = await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId: ids.deviceC,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId,
			state: "active",
		});
		expect(stillRevoked.state).toBe("revoked");
		expect(stillRevoked.revokedAt).toBe(revoked?.revokedAt ?? null);
		expect(await integrationResourceBindingService.markDeleted("device", ids.deviceC)).toBe(true);
		const auditRows = await db.query.integrationAuditEvents.findMany({
			where: eq(integrationAuditEvents.authorityId, authorityId),
		});
		expect(
			auditRows.filter((row) => row.operationId === "resource_binding.orphan_many"),
		).toHaveLength(1);
		expect(auditRows.map((row) => row.operationId)).toEqual(
			expect.arrayContaining(["resource_binding.revoke", "resource_binding.delete"]),
		);
		const orphanAudit = auditRows.find((row) => row.operationId === "resource_binding.orphan_many");
		expect(orphanAudit?.metadataJson).toMatchObject({ affectedCount: 1, state: "orphaned" });
		const deleted = await integrationResourceBindingService.get("device", ids.deviceC);
		const stillDeleted = await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId: ids.deviceC,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId,
			state: "active",
		});
		expect(stillDeleted).toMatchObject({ state: "deleted", deletedAt: deleted?.deletedAt });
	});

	test("orphans large authority sets in bounded batches with one aggregate audit", async () => {
		const authorityId = generateId();
		const resourceIds = Array.from({ length: 101 }, () => generateId());
		await db.insert(integrationResourceBindings).values(
			resourceIds.map((resourceId) => ({
				id: generateId(),
				resourceType: "device" as const,
				resourceId,
				sourceType: "oauth_client" as const,
				sourceId: ids.client,
				authorityType: "oauth_grant" as const,
				authorityId,
				state: "active" as const,
				createdAt: now,
				updatedAt: now,
			})),
		);
		try {
			expect(await integrationResourceBindingService.markOrphaned("oauth_grant", authorityId)).toBe(
				101,
			);
			expect(
				await db.query.integrationResourceBindings.findMany({
					where: and(
						eq(integrationResourceBindings.authorityId, authorityId),
						eq(integrationResourceBindings.state, "orphaned"),
					),
				}),
			).toHaveLength(101);
			const audits = await db.query.integrationAuditEvents.findMany({
				where: and(
					eq(integrationAuditEvents.authorityId, authorityId),
					eq(integrationAuditEvents.operationId, "resource_binding.orphan_many"),
				),
			});
			expect(audits).toHaveLength(1);
			expect(audits[0]?.metadataJson).toMatchObject({ affectedCount: 101 });
		} finally {
			await db
				.delete(integrationAuditEvents)
				.where(eq(integrationAuditEvents.authorityId, authorityId));
			await db
				.delete(integrationResourceBindings)
				.where(eq(integrationResourceBindings.authorityId, authorityId));
		}
	});

	test("rolls back a synchronously inserted binding with its resource transaction", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, ids.deviceB));
		expect(() =>
			db.transaction((tx) => {
				integrationResourceBindingService.createInTransaction(tx, {
					resourceType: "device",
					resourceId: ids.deviceB,
					sourceType: "oauth_client",
					sourceId: ids.client,
					authorityType: "oauth_grant",
					authorityId: ids.grant,
					provisionKey: "transaction-rollback",
					metadataJson: {
						provisionIdentity: { version: 1, algorithm: "sha256", digest: "a".repeat(64) },
					},
				});
				throw new Error("force binding create rollback");
			}),
		).toThrow("force binding create rollback");
		expect(await integrationResourceBindingService.get("device", ids.deviceB)).toBeNull();
	});

	test("rolls back deleted provenance when the resource transaction fails", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, ids.deviceB));
		await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId: ids.deviceB,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
		});
		expect(() =>
			db.transaction((tx) => {
				integrationResourceBindingService.markDeletedInTransaction(tx, "device", ids.deviceB);
				throw new Error("force resource delete rollback");
			}),
		).toThrow("force resource delete rollback");
		expect(await integrationResourceBindingService.get("device", ids.deviceB)).toMatchObject({
			state: "active",
			deletedAt: null,
		});
	});

	test("creates, upserts, lists and preserves terminal state timestamps", async () => {
		const created = await integrationResourceBindingService.create({
			resourceType: "device",
			resourceId: ids.deviceA,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			provisionKey: "device-0",
			metadataJson: { provisionKey: "device-0" },
		});
		expect(created.state).toBe("active");
		expect(
			await integrationResourceBindingService.getByProvisionKey({
				authorityType: "oauth_grant",
				authorityId: ids.grant,
				resourceType: "device",
				provisionKey: "device-0",
				state: "active",
			}),
		).toMatchObject({ id: created.id, resourceId: ids.deviceA });
		expect(
			await integrationResourceBindingService.getByProvisionKey({
				authorityType: "oauth_grant",
				authorityId: generateId(),
				resourceType: "device",
				provisionKey: "device-0",
			}),
		).toBeNull();
		const updated = await integrationResourceBindingService.upsert({
			resourceType: "device",
			resourceId: ids.deviceA,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			metadataJson: { provisionKey: "device-0", projectId: ids.project },
		});
		expect(updated.id).toBe(created.id);
		expect(updated.metadataJson).toEqual({ provisionKey: "device-0", projectId: ids.project });
		const page = await integrationResourceBindingService.listByAuthority("oauth_grant", ids.grant, {
			limit: 1,
		});
		expect(page.items).toHaveLength(1);
		expect(await integrationResourceBindingService.markRevoked("device", ids.deviceA)).toBe(true);
		expect(
			(await integrationResourceBindingService.get("device", ids.deviceA))?.revokedAt,
		).toBeTruthy();
		expect(await integrationResourceBindingService.markDeleted("device", ids.deviceA)).toBe(true);
		const deleted = await integrationResourceBindingService.get("device", ids.deviceA);
		expect(deleted?.state).toBe("deleted");
		expect(deleted?.deletedAt).toBeTruthy();
	});

	test("retains provenance after the resource entity is deleted", async () => {
		await integrationResourceBindingService.upsert({
			resourceType: "narrator",
			resourceId: ids.narratorDelete,
			sourceType: "oauth_client",
			sourceId: ids.client,
			authorityType: "oauth_grant",
			authorityId: ids.grant,
			metadataJson: { provisionKey: "narrator-delete" },
		});
		expect(
			await integrationResourceBindingService.markDeleted("narrator", ids.narratorDelete),
		).toBe(true);
		await db.delete(narrators).where(eq(narrators.id, ids.narratorDelete));
		expect(
			await integrationResourceBindingService.get("narrator", ids.narratorDelete),
		).toMatchObject({
			state: "deleted",
			sourceId: ids.client,
			authorityId: ids.grant,
		});
	});

	test("backfills OAuth devices and narrators in bounded idempotent pages", async () => {
		await db
			.delete(integrationResourceBindings)
			.where(inArray(integrationResourceBindings.resourceId, [ids.deviceB, ids.narrator]));
		let cursor: string | undefined;
		let created = 0;
		for (;;) {
			const page = await integrationResourceBindingService.backfill({
				limit: 1,
				cursor,
				authorityId: ids.grant,
			});
			created += page.created;
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(created).toBeGreaterThanOrEqual(2);
		expect(await integrationResourceBindingService.get("device", ids.deviceB)).toMatchObject({
			authorityId: ids.grant,
			state: "active",
		});
		expect(await integrationResourceBindingService.get("narrator", ids.narrator)).toMatchObject({
			authorityId: ids.grant,
			state: "active",
		});
		expect(await integrationResourceBindingService.get("device", ids.deviceA)).toMatchObject({
			state: "deleted",
		});
		expect(await integrationResourceBindingService.get("device", ids.deviceC)).toMatchObject({
			state: "deleted",
		});

		cursor = undefined;
		let recreated = 0;
		for (;;) {
			const page = await integrationResourceBindingService.backfill({
				limit: 1,
				cursor,
				authorityId: ids.grant,
			});
			recreated += page.created;
			if (!page.nextCursor) break;
			cursor = page.nextCursor;
		}
		expect(recreated).toBe(0);
	});
});
