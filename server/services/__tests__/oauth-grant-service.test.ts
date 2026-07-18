import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import {
	oauthClients,
	oauthGrantEvents,
	oauthGrantProjects,
	oauthGrants,
	projects,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import {
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
		scopes: ["device:manage", "narrator:use"],
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
		scopes: ["device:manage", "narrator:use"],
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
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientId));
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientTwoId));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientId));
	await db.delete(oauthGrants).where(eq(oauthGrants.oauthClientId, clientTwoId));
});

afterAll(async () => {
	await db.delete(oauthGrantEvents).where(eq(oauthGrantEvents.oauthClientId, clientId));
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
			scopes: ["device:manage"],
			projectIds: [projectA],
			policyJson: { permissionMode: "readOnly" },
			legacyUnscoped: true,
		});
		const second = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["narrator:use"],
			projectIds: [projectB],
			policyJson: { permissionMode: "dontAsk" },
		});
		expect(second.id).toBe(first.id);
		expect(second.scopes).toEqual(["narrator:use"]);
		expect(second.projectIds).toEqual([projectB]);
		expect(second.policyJson).toEqual({ permissionMode: "dontAsk" });
		expect(second.legacyUnscoped).toBe(false);
		expect(await isOAuthGrantProjectAllowed(second.id, projectA, userId)).toBe(false);
		expect(await isOAuthGrantProjectAllowed(second.id, projectB, userId)).toBe(true);

		const active = await db.query.oauthGrants.findMany({
			where: and(eq(oauthGrants.userId, userId), eq(oauthGrants.oauthClientId, clientId)),
		});
		expect(active.filter((grant) => grant.revokedAt === null)).toHaveLength(1);
		const approvals = await db.query.oauthGrantEvents.findMany({
			where: eq(oauthGrantEvents.grantId, first.id),
			orderBy: (table, { asc }) => [asc(table.createdAt)],
		});
		expect(approvals.filter((event) => event.eventType === "approved")).toHaveLength(2);
		const reconsent = approvals.find((event) => event.metadata?.action === "reconsent");
		expect(reconsent?.metadata).toMatchObject({
			action: "reconsent",
			policySnapshot: { permissionMode: "dontAsk" },
			previousScopes: ["device:manage"],
			previousProjectIds: [projectA],
		});
	});

	test("does not revive a revoked grant on new authorization", async () => {
		const first = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device:manage"],
		});
		const revoked = await revokeOAuthGrantForUser({ grantId: first.id, userId });
		expect(revoked?.revokedAt).toBeTruthy();

		const second = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["narrator:use"],
		});
		expect(second.id).not.toBe(first.id);
		expect(second.revokedAt).toBeNull();
		const old = await getUserOAuthGrant(userId, first.id);
		expect(old?.revokedAt).toBeTruthy();
	});

	test("enforces a finite project allow-list, including an empty deny-all list", async () => {
		const grant = await createOAuthGrant({
			userId,
			clientId: clientPublicId,
			scopes: ["device:manage"],
			projectIds: [projectA],
		});
		expect(grant.projectIds).toEqual([projectA]);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectA, userId)).toBe(true);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectB, userId)).toBe(false);
		expect(await isOAuthGrantProjectAllowed(grant.id, projectA, otherUserId)).toBe(false);

		const denyAll = await createOAuthGrant({
			userId: otherUserId,
			clientId: clientPublicId,
			scopes: ["device:manage"],
			projectIds: [],
		});
		expect(denyAll.projectIds).toEqual([]);
		expect(await isOAuthGrantProjectAllowed(denyAll.id, projectA, otherUserId)).toBe(false);

		await expect(
			createOAuthGrant({
				userId: generateId(),
				clientId: clientPublicId,
				scopes: ["device:manage"],
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
			requestedScopes: ["device:manage"],
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
