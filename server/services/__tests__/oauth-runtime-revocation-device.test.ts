import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
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
import {
	propagateOAuthClientRestriction,
	propagateOAuthGrantRevocation,
	propagateOAuthProjectRemoval,
} from "../oauth-runtime-revocation";

const ids = {
	user: generateId(),
	project: generateId(),
	client: generateId(),
	grantA: generateId(),
	grantB: generateId(),
	bindingA: generateId(),
	bindingB: generateId(),
	ordinaryDevice: generateId(),
};
const ownedGrantADeviceIds = Array.from({ length: 101 }, () => generateId());
const ownedGrantBDeviceId = generateId();
const now = new Date().toISOString();

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `oauth-revocation-device-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: ids.project,
		name: "OAuth revocation device project",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: `oauth-revocation-device-${ids.client}`,
		name: "OAuth revocation device client",
		redirectUris: [],
		scopes: ["device:provision"],
		grantTypes: ["authorization_code", "refresh_token"],
		publicClient: true,
		createdBy: ids.user,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrants).values([
		{
			id: ids.grantA,
			oauthClientId: ids.client,
			userId: ids.user,
			scopes: ["device:provision"],
			createdAt: now,
			updatedAt: now,
		},
		{
			id: ids.grantB,
			oauthClientId: ids.client,
			userId: ids.user,
			scopes: ["device:provision"],
			revokedAt: now,
			createdAt: now,
			updatedAt: now,
		},
	]);
	await db.insert(oauthGrantProjects).values([
		{ id: ids.bindingA, grantId: ids.grantA, projectId: ids.project, createdAt: now },
		{ id: ids.bindingB, grantId: ids.grantB, projectId: ids.project, createdAt: now },
	]);
	await db.insert(remoteDevices).values([
		...ownedGrantADeviceIds.map((id, index) => ({
			id,
			name: `OAuth grant A device ${index}`,
			slug: `oauth-revoke-a-${index}-${id.slice(0, 6)}`,
			tokenHash: `hash-a-${index}`,
			tokenPrefix: `rdev_a${index}`,
			connectionMode: "reverse" as const,
			status: "offline" as const,
			scope: "project" as const,
			projectId: ids.project,
			createdBy: ids.user,
			oauthOwnerGrantId: ids.grantA,
			createdAt: now,
			updatedAt: now,
		})),
		{
			id: ownedGrantBDeviceId,
			name: "OAuth grant B device",
			slug: `oauth-revoke-b-${ownedGrantBDeviceId.slice(0, 8)}`,
			tokenHash: "hash-b",
			tokenPrefix: "rdev_b",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: ids.project,
			createdBy: ids.user,
			oauthOwnerGrantId: ids.grantB,
			createdAt: now,
			updatedAt: now,
		},
		{
			id: ids.ordinaryDevice,
			name: "Ordinary project device",
			slug: `ordinary-revoke-${ids.ordinaryDevice.slice(0, 8)}`,
			tokenHash: "hash-ordinary",
			tokenPrefix: "rdev_o",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: ids.project,
			createdBy: ids.user,
			createdAt: now,
			updatedAt: now,
		},
	]);
});

afterAll(async () => {
	await db
		.delete(remoteDevices)
		.where(
			inArray(remoteDevices.id, [...ownedGrantADeviceIds, ownedGrantBDeviceId, ids.ordinaryDevice]),
		);
	await db
		.delete(oauthGrantProjects)
		.where(inArray(oauthGrantProjects.id, [ids.bindingA, ids.bindingB]));
	await db.delete(oauthGrants).where(inArray(oauthGrants.id, [ids.grantA, ids.grantB]));
	await db.delete(oauthClients).where(inArray(oauthClients.id, [ids.client]));
	await db.delete(projects).where(inArray(projects.id, [ids.project]));
	await db.delete(users).where(inArray(users.id, [ids.user]));
});

describe("OAuth-owned device runtime revocation pagination", () => {
	test("selects bounded pages by grant, client, and project without ordinary devices", async () => {
		expect(await propagateOAuthGrantRevocation([ids.grantA])).toBe(101);
		expect(await propagateOAuthClientRestriction(ids.client)).toBe(102);
		expect(await propagateOAuthProjectRemoval(ids.project)).toBe(102);
	});
});
