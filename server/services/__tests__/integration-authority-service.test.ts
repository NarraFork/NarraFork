import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { integrationAuthorities, integrationCapabilityGrants, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { integrationAuthorityService } from "../integration-authority-service";

const ids = {
	user: generateId(),
	authority: generateId(),
	legacyAuthority: generateId(),
	duplicateAuthority: generateId(),
};
const now = new Date().toISOString();

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `integration-authority-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "admin",
		createdAt: now,
	});
});

afterAll(async () => {
	await db
		.delete(integrationCapabilityGrants)
		.where(
			inArray(integrationCapabilityGrants.authorityId, [
				ids.authority,
				ids.legacyAuthority,
				ids.duplicateAuthority,
			]),
		);
	await db
		.delete(integrationAuthorities)
		.where(
			inArray(integrationAuthorities.id, [
				ids.authority,
				ids.legacyAuthority,
				ids.duplicateAuthority,
			]),
		);
	await db.delete(users).where(eq(users.id, ids.user));
});

describe("IntegrationAuthorityService", () => {
	test("creates one durable authority with canonical scoped grants", async () => {
		const snapshot = await integrationAuthorityService.create({
			id: ids.authority,
			kind: "oauth_grant",
			integrationId: "oauth-client-for-authority-test",
			ownerUserId: ids.user,
			policyJson: { allowRemoteExecution: false },
			grants: [
				{
					capabilityId: "project.read",
					scope: { type: "project", id: "project-a" },
					createdBy: { type: "user", id: ids.user },
				},
				{
					capabilityId: "device.read",
					scope: { type: "project", id: "project-a" },
					constraints: { maxBytes: 1024, methods: ["device.list"] },
					createdBy: { type: "user", id: ids.user },
				},
			],
		});
		expect(snapshot.authority).toMatchObject({
			id: ids.authority,
			kind: "oauth_grant",
			integrationType: "oauth_client",
			state: "active",
			revision: 1,
		});
		expect(snapshot.grants.map((grant) => grant.capabilityId)).toEqual([
			"device.read",
			"project.read",
		]);
	});

	test("repairs a pre-sourceGrantId OAuth authority once with revision CAS", async () => {
		await db.insert(integrationAuthorities).values({
			id: ids.legacyAuthority,
			kind: "oauth_grant",
			integrationType: "oauth_client",
			integrationId: "legacy-oauth-client",
			ownerUserId: ids.user,
			sourceGrantId: null,
			state: "active",
			revision: 1,
			createdAt: now,
			updatedAt: now,
		});
		const repaired = await integrationAuthorityService.repairOAuthSourceGrantId({
			authorityId: ids.legacyAuthority,
			expectedRevision: 1,
		});
		expect(repaired.authority).toMatchObject({
			sourceGrantId: ids.legacyAuthority,
			revision: 2,
		});
		const idempotent = await integrationAuthorityService.repairOAuthSourceGrantId({
			authorityId: ids.legacyAuthority,
			expectedRevision: 2,
		});
		expect(idempotent.authority.revision).toBe(2);
	});

	test("replaces grants with revision CAS and prevents concurrent stale writes", async () => {
		const replaced = await integrationAuthorityService.replaceGrants({
			authorityId: ids.authority,
			expectedRevision: 1,
			policyJson: { allowRemoteExecution: false, version: 2 },
			grants: [
				{
					capabilityId: "project.read",
					scope: { type: "project", id: "project-b" },
					createdBy: { type: "user", id: ids.user },
				},
			],
		});
		expect(replaced.authority.revision).toBe(2);
		expect(replaced.grants).toHaveLength(1);
		expect(replaced.grants[0]?.scopeKey).toBe("project:project-b");

		const results = await Promise.allSettled(
			["project-c", "project-d"].map((projectId) =>
				integrationAuthorityService.replaceGrants({
					authorityId: ids.authority,
					expectedRevision: 2,
					grants: [
						{
							capabilityId: "project.read",
							scope: { type: "project", id: projectId },
							createdBy: { type: "user", id: ids.user },
						},
					],
				}),
			),
		);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(
			(await integrationAuthorityService.requireSnapshot(ids.authority)).authority.revision,
		).toBe(3);
	});

	test("revokes grants and advances authority revision atomically", async () => {
		const before = await integrationAuthorityService.requireSnapshot(ids.authority);
		const revoked = await integrationAuthorityService.revoke({
			authorityId: ids.authority,
			expectedRevision: before.authority.revision,
			reason: "test revocation",
		});
		expect(revoked.authority.state).toBe("revoked");
		expect(revoked.authority.revision).toBe(before.authority.revision + 1);
		expect(revoked.authority.revokedAt).toBeTruthy();
		expect(revoked.grants).toEqual([]);
	});

	test("rejects duplicate capability/scope grants and unknown capabilities", async () => {
		await expect(
			integrationAuthorityService.create({
				id: ids.duplicateAuthority,
				kind: "plugin_installation",
				integrationId: "example.plugin",
				grants: [
					{
						capabilityId: "project.read",
						scope: { type: "global" },
						createdBy: { type: "system" },
					},
					{
						capabilityId: "project.read",
						scope: { type: "global" },
						createdBy: { type: "system" },
					},
				],
			}),
		).rejects.toThrow(/unique/i);

		await expect(
			integrationAuthorityService.create({
				id: ids.duplicateAuthority,
				kind: "plugin_installation",
				integrationId: "example.plugin",
				grants: [
					{
						capabilityId: "unknown.capability" as never,
						scope: { type: "global" },
						createdBy: { type: "system" },
					},
				],
			}),
		).rejects.toThrow(/Unknown canonical capability/);
	});
});
