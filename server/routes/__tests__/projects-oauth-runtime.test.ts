import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import {
	narrators,
	oauthClients,
	oauthGrantProjects,
	oauthGrants,
	projects,
	remoteDevices,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import { projectRoutes } from "../projects";

const app = new Hono().route("/projects", projectRoutes);
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
const policy = {
	defaultPermissionMode: "readOnly" as const,
	allowedPermissionModes: ["readOnly" as const],
	systemPromptMode: "managed" as const,
	maxSystemPromptChars: 0,
	allowGlobalDevice: false,
	allowKnowledgeWrite: false,
};

beforeAll(async () => {
	await db.insert(users).values({
		id: ids.user,
		username: `project-delete-oauth-${ids.user}`,
		passwordHash: "not-a-real-hash",
		role: "user",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: ids.project,
		name: "OAuth project deletion",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthClients).values({
		id: ids.client,
		clientId: `project-delete-${ids.client}`,
		name: "OAuth project deletion client",
		redirectUris: [],
		scopes: ["narrator.send_message"],
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
		scopes: ["narrator.send_message"],
		policyJson: policy,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(oauthGrantProjects).values({
		id: ids.grantProject,
		grantId: ids.grant,
		projectId: ids.project,
		createdAt: now,
	});
	await db.insert(remoteDevices).values({
		id: ids.device,
		name: "OAuth project deletion device",
		slug: `project-delete-${ids.device.slice(0, 8)}`,
		tokenHash: "project-delete-hash",
		tokenPrefix: "rdev_delete",
		connectionMode: "reverse",
		status: "offline",
		scope: "project",
		projectId: ids.project,
		createdBy: ids.user,
		oauthOwnerGrantId: ids.grant,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: ids.narrator,
		contextProjectId: ids.project,
		defaultDeviceId: ids.device,
		oauthOwnerGrantId: ids.grant,
		oauthProvisionKey: "project-delete",
		oauthPolicySnapshotJson: {
			version: 2,
			policy,
			permissionMode: "readOnly",
			systemPrompt: null,
			projectId: ids.project,
			defaultDeviceId: ids.device,
			deviceIds: [ids.device],
		},
		createdAt: now,
		updatedAt: now,
	});
});

afterAll(async () => {
	await db.delete(narrators).where(eq(narrators.id, ids.narrator));
	await db.delete(remoteDevices).where(eq(remoteDevices.id, ids.device));
	await db.delete(oauthGrantProjects).where(eq(oauthGrantProjects.id, ids.grantProject));
	await db.delete(oauthGrants).where(eq(oauthGrants.id, ids.grant));
	await db.delete(oauthClients).where(eq(oauthClients.id, ids.client));
	await db.delete(projects).where(eq(projects.id, ids.project));
	await db.delete(users).where(eq(users.id, ids.user));
});

describe("project deletion OAuth runtime cleanup", () => {
	test("stops OAuth narrators and revokes anchored devices before deleting the project", async () => {
		const response = await app.request(`/projects/${ids.project}`, { method: "DELETE" });
		expect(response.status).toBe(200);
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, ids.project) }),
		).toBeUndefined();
		const device = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, ids.device),
		});
		expect(device).toMatchObject({ projectId: null, status: "offline" });
		expect(device?.revokedAt).toBeTruthy();
		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, ids.narrator),
		});
		expect(narrator?.contextProjectId).toBeNull();
		expect(
			await db.query.oauthGrantProjects.findFirst({
				where: eq(oauthGrantProjects.id, ids.grantProject),
			}),
		).toBeUndefined();
	});
});
