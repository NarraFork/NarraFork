import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
	integrationAuthorities,
	integrationResourceBindings,
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { integrationAuthorityService } from "../integration-authority-service";
import { integrationResourceBindingService } from "../integration-resource-binding-service";
import {
	backfillOAuthGrantAuthorities,
	createOAuthGrant,
	getUserOAuthGrant,
	isOAuthGrantProjectAllowed,
	listUserOAuthGrants,
	recordDeniedGrantEvent,
	revokeOAuthGrantForUser,
} from "../oauth-grant-service";

const userId = generateId();
const otherUserId = generateId();
const clientId = generateId();
const clientPublicId = `oauth-grant-service-${clientId.slice(0, 8)}`;
const clientTwoId = generateId();
const clientTwoPublicId = `oauth-grant-service-two-${clientTwoId.slice(0, 8)}`;
const projectA = generateId();
const projectB = generateId();
const now = new Date().toISOString();
const createdResourceIds = new Set<string>();

beforeAll(async () => {
	await db.insert(users).values([
		{
			id: userId,
			username: `oauth-grant-user-${userId}`,
			passwordHash: "not-a-real-hash",
			role: "user",
			createdAt: now,
		},
		{
			id: otherUserId,
			username: `oauth-grant-other-${otherUserId}`,
			passwordHash: "not-a-real-hash",
			role: "user",
			createdAt: now,
		},
	]);
	await db.insert(oauthClients).values({
		id: clientId,
		clientId: clientPublicId,
		name: "Grant Service Test Client",
		redirectUris: ["http://127.0.0.1:9876/callback"],
		scopes: ["device.provision", "narrator.provision"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		createdBy: userId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: clientTwoId,
		clientId: clientTwoPublicId,
		name: "Grant Service Test Client Two",
		redirectUris: ["http://127.0.0.1:9877/callback"],
		scopes: ["device.provision", "narrator.provision"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		createdBy: userId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(projects).values([
		{ id: projectA, name: "Grant project A", createdAt: now, updatedAt: now },
		{ id: projectB, name: "Grant project B", createdAt: now, updatedAt: now },
	]);
});

afterEach(async () => {
	for (const resourceId of createdResourceIds) {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, resourceId));
		await db.delete(remoteDevices).where(eq(remoteDevices.id, resourceId));
	}
	createdResourceIds.clear();
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientId));
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientTwoId));
	await db
		.delete(integrationAuthorities)
		.where(inArray(integrationAuthorities.integrationId, [clientId, clientTwoId]));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientId));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientTwoId));
});

afterAll(async () => {
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientId));
	await db
		.delete(integrationAuthorities)
		.where(inArray(integrationAuthorities.integrationId, [clientId, clientTwoId]));
	await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.projectId, projectA));
	await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.projectId, projectB));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientId));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientTwoId));
	await db.delete(oauthClients).where(eq(oauthClients.id, clientId));
	await db.delete(oauthClients).where(eq(oauthClients.id, clientTwoId));
	await db.delete(projects).where(eq(projects.id, projectA));
	await db.delete(projects).where(eq(projects.id, projectB));
	await db.delete(users).where(eq(users.id, otherUserId));
	await db.delete(users).where(eq(users.id, userId));
});

describe("oauth grant service", () => {
	test("atomically applies each re-consent to the active grant and records approval", async () => {
		const first = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [projectA],
			policyJson: { permissionMode: "readOnly" },
			legacyUnscoped: true,
		});
		const second = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["narrator.provision"],
			projectIds: [projectB],
			policyJson: { permissionMode: "dontAsk" },
		});
		expect(second.id).toBe(first.id);
		expect(second.scopes).toEqual(["narrator.provision"]);
		expect(second.projectIds).toEqual([projectB]);
		expect(second.policyJson).toEqual({ permissionMode: "dontAsk" });
		expect(second.legacyUnscoped).toBe(false);
		expect(await isOAuthGrantProjectAllowed(second.id, projectA, userId)).toBe(false);
		expect(await isOAuthGrantProjectAllowed(second.id, projectB, userId)).toBe(true);

		const active = await db.query.oauthGrants.findMany({
			where: and(eq(oauthGrants.userId, userId), eq(oauthGrants.oauthClientId, clientId)),
		});
		expect(active.filter((grant) => grant.revokedAt === null)).toHaveLength(1);
		const legacyShadow = active.find((grant) => grant.id === second.id);
		expect(legacyShadow?.scopes).toEqual([]);
		expect(legacyShadow?.policyJson).toBeNull();
		expect(
			await db.query.oauthGrantProjects.findMany({
				where: eq(oauthGrantProjects.grantId, second.id),
			}),
		).toEqual([]);
		const approvals = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, first.id),
			orderBy: (table, { asc }) => [asc(table.createdAt)],
		});
		expect(approvals.filter((event) => event.eventType === "approved")).toHaveLength(2);
		const reconsent = approvals.find((event) => event.metadata?.action === "reconsent");
		expect(reconsent?.metadata).toMatchObject({
			action: "reconsent",
			policySnapshot: { permissionMode: "dontAsk" },
			previousScopes: ["device.provision"],
			previousProjectIds: [projectA],
		});
	});

	test("backfills a legacy grant once and ignores later mirror tampering", async () => {
		const legacyGrantId = generateId();
		await db.insert(oauthGrants).values({
			id: legacyGrantId,
			oauthClientId: clientTwoId,
			userId: otherUserId,
			scopes: ["device.provision", "legacy.unsupported"],
			policyJson: { permissionMode: "readOnly" },
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(oauthGrantProjects).values({
			id: generateId(),
			grantId: legacyGrantId,
			projectId: projectA,
			createdAt: now,
		});

		const migrated = await backfillOAuthGrantAuthorities({ limit: 100 });
		expect(migrated.created).toBe(1);
		const authority = await integrationAuthorityService.requireSnapshot(legacyGrantId);
		expect(authority.authority).toMatchObject({
			sourceGrantId: legacyGrantId,
			integrationId: clientTwoId,
			ownerUserId: otherUserId,
			policyJson: { permissionMode: "readOnly" },
		});
		expect(
			authority.grants.map((grant) => `${grant.capabilityId}:${grant.scopeKey}`).sort(),
		).toEqual([
			`device.provision:integration:${legacyGrantId}`,
			`device.provision:project:${projectA}`,
		]);

		await db
			.update(oauthGrants)
			.set({ scopes: ["narrator.provision"], policyJson: { permissionMode: "dontAsk" } })
			.where(eq(oauthGrants.id, legacyGrantId));
		await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.grantId, legacyGrantId));
		const repeated = await backfillOAuthGrantAuthorities({ limit: 100 });
		expect(repeated.created).toBe(0);
		expect(repeated.repaired).toBe(0);
		const unchanged = await integrationAuthorityService.requireSnapshot(legacyGrantId);
		expect(unchanged.authority.policyJson).toEqual({ permissionMode: "readOnly" });
		expect([...new Set(unchanged.grants.map((grant) => grant.capabilityId))]).toEqual([
			"device.provision",
		]);
	});

	test("re-consent atomically repairs a legacy authority before startup backfill finishes", async () => {
		const legacyGrantId = generateId();
		await db.insert(oauthGrants).values({
			id: legacyGrantId,
			oauthClientId: clientTwoId,
			userId: otherUserId,
			scopes: ["device.provision"],
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(integrationAuthorities).values({
			id: legacyGrantId,
			kind: "oauth_grant",
			integrationType: "oauth_client",
			integrationId: clientTwoId,
			ownerUserId: otherUserId,
			sourceGrantId: null,
			state: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});

		const reconsented = await createOAuthGrant({
			userId: otherUserId,
			oauthClientId: clientTwoId,
			scopes: ["narrator.provision"],
			projectIds: [projectB],
		});
		expect(reconsented.id).toBe(legacyGrantId);
		const authority = await integrationAuthorityService.requireSnapshot(legacyGrantId);
		expect(authority.authority).toMatchObject({ sourceGrantId: legacyGrantId, revision: 2 });
		expect([...new Set(authority.grants.map((grant) => grant.capabilityId))]).toEqual([
			"narrator.provision",
		]);
	});

	test("never reactivates a revoked legacy grant during backfill", async () => {
		const revokedGrantId = generateId();
		await db.insert(oauthGrants).values({
			id: revokedGrantId,
			oauthClientId: clientTwoId,
			userId: otherUserId,
			scopes: ["device.provision"],
			revokedAt: now,
			revokedByType: "system",
			revokedReason: "legacy revoked fixture",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(oauthGrantProjects).values({
			id: generateId(),
			grantId: revokedGrantId,
			projectId: projectA,
			createdAt: now,
		});
		const migrated = await backfillOAuthGrantAuthorities({ limit: 100 });
		expect(migrated.processed).toBe(0);
		expect(await integrationAuthorityService.getSnapshot(revokedGrantId)).toBeNull();
		expect(await getUserOAuthGrant(otherUserId, revokedGrantId)).toMatchObject({
			scopes: ["device.provision"],
			projectIds: [projectA],
		});
		expect(await isOAuthGrantProjectAllowed(revokedGrantId, projectA, otherUserId)).toBe(false);
	});

	test("does not revive a revoked grant and displays its latest approved access", async () => {
		const first = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [projectA],
		});
		const reconsented = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["narrator.provision"],
			projectIds: [projectB],
		});
		expect(reconsented.id).toBe(first.id);
		const revoked = await revokeOAuthGrantForUser({ grantId: first.id, userId });
		expect(revoked).toMatchObject({
			revokedAt: expect.any(String),
			scopes: ["narrator.provision"],
			projectIds: [projectB],
		});

		const second = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
		});
		expect(second.id).not.toBe(first.id);
		expect(second.revokedAt).toBeNull();
		const old = await getUserOAuthGrant(userId, first.id);
		expect(old).toMatchObject({
			revokedAt: expect.any(String),
			scopes: ["narrator.provision"],
			projectIds: [projectB],
		});
	});

	test("orphans integration provenance before revoking its grant", async () => {
		const grant = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [projectA],
		});
		const deviceId = generateId();
		createdResourceIds.add(deviceId);
		await db.insert(remoteDevices).values({
			id: deviceId,
			name: "Grant provenance device",
			slug: `grant-provenance-${deviceId.slice(0, 8)}`,
			tokenHash: "grant-provenance-hash",
			tokenPrefix: "rdev_grant",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectA,
			createdBy: userId,
			oauthOwnerGrantId: grant.id,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(integrationResourceBindings).values({
			id: generateId(),
			resourceType: "device",
			resourceId: deviceId,
			sourceType: "oauth_client",
			sourceId: clientId,
			authorityType: "oauth_grant",
			authorityId: grant.id,
			state: "active",
			createdAt: now,
			updatedAt: now,
		});

		await revokeOAuthGrantForUser({ grantId: grant.id, userId });
		const provenance = await db.query.integrationResourceBindings.findFirst({
			where: eq(integrationResourceBindings.resourceId, deviceId),
		});
		expect(provenance?.state).toBe("orphaned");
		expect(provenance?.orphanedAt).toBeTruthy();
		expect((await getUserOAuthGrant(userId, grant.id))?.revokedAt).toBeTruthy();
	});

	test("retries post-commit revocation cleanup for an already-revoked grant", async () => {
		const grant = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [projectA],
		});
		const deviceId = generateId();
		createdResourceIds.add(deviceId);
		await db.insert(remoteDevices).values({
			id: deviceId,
			name: "Retry cleanup device",
			slug: `retry-cleanup-${deviceId.slice(0, 8)}`,
			tokenHash: "retry-cleanup-hash",
			tokenPrefix: "rdev_retry",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: projectA,
			createdBy: userId,
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(integrationResourceBindings).values({
			id: generateId(),
			resourceType: "device",
			resourceId: deviceId,
			sourceType: "oauth_client",
			sourceId: clientId,
			authorityType: "oauth_grant",
			authorityId: grant.id,
			state: "active",
			createdAt: now,
			updatedAt: now,
		});

		const originalMarkOrphaned = integrationResourceBindingService.markOrphaned.bind(
			integrationResourceBindingService,
		);
		let cleanupAttempts = 0;
		integrationResourceBindingService.markOrphaned = async (...args) => {
			cleanupAttempts++;
			if (cleanupAttempts === 1) throw new Error("injected orphan cleanup failure");
			return originalMarkOrphaned(...args);
		};
		try {
			await expect(
				revokeOAuthGrantForUser({ grantId: grant.id, userId, reason: "retry cleanup" }),
			).rejects.toThrow("injected orphan cleanup failure");
			expect((await getUserOAuthGrant(userId, grant.id))?.revokedAt).toBeTruthy();
			expect(
				(
					await db.query.integrationResourceBindings.findFirst({
						where: eq(integrationResourceBindings.resourceId, deviceId),
					})
				)?.state,
			).toBe("active");

			const retried = await revokeOAuthGrantForUser({
				grantId: grant.id,
				userId,
				reason: "retry cleanup",
			});
			expect(retried?.revokedAt).toBeTruthy();
			expect(cleanupAttempts).toBe(2);
			expect(
				(
					await db.query.integrationResourceBindings.findFirst({
						where: eq(integrationResourceBindings.resourceId, deviceId),
					})
				)?.state,
			).toBe("orphaned");
			expect(
				(
					await db.query.oauthGrantEvents.findMany({
						where: and(
							eq(oauthGrantEvents.grantId, grant.id),
							eq(oauthGrantEvents.eventType, "revoked"),
						),
					})
				).length,
			).toBe(1);
		} finally {
			integrationResourceBindingService.markOrphaned = originalMarkOrphaned;
		}
	});

	test("enforces a finite project allow-list, including an empty deny-all list", async () => {
		const grant = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [projectA],
		});
		expect(grant.projectIds).toEqual([projectA]);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectA, userId)).toBe(true);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectB, userId)).toBe(false);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectA, otherUserId)).toBe(false);

		const denyAll = await createOAuthGrant({
			userId: otherUserId,
			clientId: clientPublicId,
			scopes: ["device.provision"],
			projectIds: [],
		});
		expect(denyAll.projectIds).toEqual([]);
		expect(await isOAuthGrantProjectAllowed(denyAll.id, projectA, otherUserId)).toBe(false);

		await expect(
			createOAuthGrant({
				userId: generateId(),
				clientId: clientPublicId,
				scopes: ["device.provision"],
				projectIds: Array.from({ length: 101 }, () => generateId()),
			}),
		).rejects.toThrow(/cannot exceed/);
	});

	test("records denied consent with nullable grant and event user ids", async () => {
		const event = await recordDeniedGrantEvent({
			clientId: clientPublicId,
			userId,
			actorType: "user",
			actorUserId: userId,
			requestedScopes: ["device.provision"],
			reason: "user declined",
		});
		expect(event.eventType).toBe("denied");
		expect(event.grantId).toBeNull();
		expect(event.userId).toBe(userId);

		const anonymous = await recordDeniedGrantEvent({
			clientId: clientPublicId,
			actorType: "system",
		});
		expect(anonymous.grantId).toBeNull();
		expect(anonymous.userId).toBeNull();
	});

	test("lists owned grants with cursor pagination and revokes by ownership", async () => {
		const first = await createOAuthGrant({ userId, clientId: clientPublicId, scopes: [] });
		await createOAuthGrant({ userId, clientId: clientTwoPublicId, scopes: [] });
		const page = await listUserOAuthGrants(userId, { limit: 1, includeRevoked: true });
		expect(page.items).toHaveLength(1);
		expect(page.nextCursor).toBeTruthy();
		const next = await listUserOAuthGrants(userId, {
			limit: 10,
			cursor: page.nextCursor ?? undefined,
			includeRevoked: true,
		});
		expect(next.items.every((item) => item.userId === userId)).toBe(true);

		const denied = await revokeOAuthGrantForUser({ grantId: first.id, userId: otherUserId });
		expect(denied).toBeNull();
		expect((await getUserOAuthGrant(userId, first.id))?.revokedAt).toBeNull();
		const revoked = await revokeOAuthGrantForUser({
			grantId: first.id,
			userId,
			reason: "user disconnected app",
		});
		expect(revoked?.revokedAt).toBeTruthy();

		const events = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, first.id),
		});
		expect(events.some((event) => event.eventType === "revoked")).toBe(true);
	});
});
