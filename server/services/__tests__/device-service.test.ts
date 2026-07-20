import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { integrationResourceBindings, projects, remoteDevices } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	getDeviceConnectionDiagnostics,
	getSessionDevices,
	stopDirectDial,
} from "../device-connection-service";
import {
	createDevice,
	deviceHasFeature,
	hashDeviceToken,
	isDeviceAuthorizedForProject,
	requireAuthorizedDeviceForProject,
	updateDevice,
} from "../device-service";
import { integrationResourceBindingService } from "../integration-resource-binding-service";

const projectIds: string[] = [];
const deviceIds: string[] = [];

async function insertProject(name: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({ id, name, createdAt: now, updatedAt: now });
	projectIds.push(id);
	return id;
}

async function createTestDevice(input: {
	name: string;
	scope: "global" | "project";
	projectId?: string;
}) {
	const result = await createDevice({
		name: input.name,
		connectionMode: "reverse",
		scope: input.scope,
		projectId: input.projectId,
		createdBy: "device-service-test",
	});
	deviceIds.push(result.device.id);
	return result.device;
}

afterEach(async () => {
	for (const id of deviceIds) stopDirectDial(id);
	for (const id of deviceIds) {
		await db
			.delete(integrationResourceBindings)
			.where(eq(integrationResourceBindings.resourceId, id));
	}
	for (const id of deviceIds.splice(0)) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, id));
	}
	for (const id of projectIds.splice(0)) {
		await db.delete(projects).where(eq(projects.id, id));
	}
});

describe("remote device configuration", () => {
	test("validates and normalizes connection mode and project scope on update", async () => {
		const projectId = await insertProject("Scoped project");
		const device = await createTestDevice({ name: "Editable", scope: "global" });

		await expect(updateDevice(device.id, { connectionMode: "direct" })).rejects.toThrow(
			"directUrl is required",
		);
		await expect(
			updateDevice(device.id, { connectionMode: "direct", directUrl: "https://invalid" }),
		).rejects.toThrow("must use wss://");
		await expect(
			updateDevice(device.id, {
				connectionMode: "direct",
				directUrl: "ws://192.168.1.20:7900/ws/device",
			}),
		).rejects.toThrow("loopback IP literal");
		await expect(updateDevice(device.id, { scope: "project" })).rejects.toThrow(
			"projectId is required",
		);

		const scoped = await updateDevice(device.id, {
			connectionMode: "direct",
			directUrl: "wss://executor.example.test/ws/device",
			scope: "project",
			projectId,
		});
		expect(scoped?.connectionMode).toBe("direct");
		expect(scoped?.directUrl).toBe("wss://executor.example.test/ws/device");
		expect(scoped?.scope).toBe("project");
		expect(scoped?.projectId).toBe(projectId);

		const global = await updateDevice(device.id, {
			connectionMode: "reverse",
			scope: "global",
		});
		expect(global?.connectionMode).toBe("reverse");
		expect(global?.directUrl).toBeNull();
		expect(global?.scope).toBe("global");
		expect(global?.projectId).toBeNull();
	});

	test("uses active binding to preserve a global project anchor without legacy ownership writes", async () => {
		const projectId = await insertProject("Binding anchored project");
		const device = await createTestDevice({
			name: "Binding anchored device",
			scope: "project",
			projectId,
		});
		const raw = await db.query.remoteDevices.findFirst({
			where: eq(remoteDevices.id, device.id),
		});
		expect(raw).toMatchObject({ oauthOwnerGrantId: null, oauthProvisionKey: null });
		await integrationResourceBindingService.create({
			resourceType: "device",
			resourceId: device.id,
			sourceType: "first_party",
			sourceId: "device-service-test",
			authorityType: "system",
			authorityId: "device-service-test",
		});
		const global = await updateDevice(device.id, { scope: "global" });
		expect(global).toMatchObject({ scope: "global", projectId });
	});

	test("rejects a project-scoped device for an unknown project", async () => {
		await expect(
			createDevice({
				name: "Unknown project",
				connectionMode: "reverse",
				scope: "project",
				projectId: "missing-project",
				createdBy: "device-service-test",
			}),
		).rejects.toThrow("Project not found");
	});

	test("uses one fail-closed project authorization rule for global and scoped devices", async () => {
		const projectA = await insertProject("Authorization A");
		const projectB = await insertProject("Authorization B");
		const global = await createTestDevice({ name: "Global auth", scope: "global" });
		const scoped = await createTestDevice({
			name: "Scoped auth",
			scope: "project",
			projectId: projectA,
		});

		expect(isDeviceAuthorizedForProject(global, null)).toBe(true);
		expect(isDeviceAuthorizedForProject(scoped, projectA)).toBe(true);
		expect(isDeviceAuthorizedForProject(scoped, projectB)).toBe(false);
		expect(isDeviceAuthorizedForProject(scoped, null)).toBe(false);
		await expect(requireAuthorizedDeviceForProject(scoped.id, projectA)).resolves.toMatchObject({
			id: scoped.id,
		});
		await expect(requireAuthorizedDeviceForProject(scoped.id, projectB)).rejects.toMatchObject({
			code: "DEVICE_SCOPE_FORBIDDEN",
		});
		await expect(requireAuthorizedDeviceForProject(scoped.id, null)).rejects.toThrow(
			"Standalone terminals may only use global",
		);
	});

	test("recognizes negotiated feature strings without weakening missing-feature checks", () => {
		expect(deviceHasFeature({ features: ["pty.ready-stream.v1"] }, "pty.ready-stream.v1")).toBe(
			true,
		);
		expect(
			deviceHasFeature({ features: { "pty.ready-stream.v1": true } }, "pty.ready-stream.v1"),
		).toBe(true);
		expect(deviceHasFeature({ pty: true }, "pty.ready-stream.v1")).toBe(false);
	});

	test("reports an actionable offline diagnostic for a reverse device", async () => {
		const device = await createTestDevice({ name: "Reverse offline", scope: "global" });
		const diagnostics = await getDeviceConnectionDiagnostics(device.id);
		expect(diagnostics).toMatchObject({
			deviceId: device.id,
			mode: "reverse",
			online: false,
			stage: "waiting_for_executor",
		});
	});

	test("exposes global and matching project devices while failing closed on malformed scope", async () => {
		const projectA = await insertProject("Project A");
		const projectB = await insertProject("Project B");
		const global = await createTestDevice({ name: "Global", scope: "global" });
		const scopedA = await createTestDevice({
			name: "A only",
			scope: "project",
			projectId: projectA,
		});
		const scopedB = await createTestDevice({
			name: "B only",
			scope: "project",
			projectId: projectB,
		});

		const malformedId = generateId();
		const now = new Date().toISOString();
		await db.insert(remoteDevices).values({
			id: malformedId,
			name: "Malformed project scope",
			slug: `malformed-${malformedId.slice(0, 8)}`,
			tokenHash: hashDeviceToken("rdev_malformed_scope"),
			tokenPrefix: "rdev_mal",
			connectionMode: "reverse",
			status: "offline",
			scope: "project",
			projectId: null,
			createdBy: "device-service-test",
			createdAt: now,
			updatedAt: now,
		});
		deviceIds.push(malformedId);

		const forA = (await getSessionDevices(projectA)).map((item) => item.id);
		expect(forA).toContain(global.id);
		expect(forA).toContain(scopedA.id);
		expect(forA).not.toContain(scopedB.id);
		expect(forA).not.toContain(malformedId);

		const forB = (await getSessionDevices(projectB)).map((item) => item.id);
		expect(forB).toContain(global.id);
		expect(forB).toContain(scopedB.id);
		expect(forB).not.toContain(scopedA.id);
		expect(forB).not.toContain(malformedId);

		const standalone = (await getSessionDevices(null)).map((item) => item.id);
		expect(standalone).toContain(global.id);
		expect(standalone).not.toContain(scopedA.id);
		expect(standalone).not.toContain(scopedB.id);
		expect(standalone).not.toContain(malformedId);
	});
});
