/**
 * Device visibility through `getSessionDevices`, against a real database.
 *
 * `device-authorization.test.ts` covers the pure matrix. This file proves the
 * axes actually gate what a session can see, because that list is what ends up
 * injected into the system prompt — a private device leaking into another user's
 * session would be a real authorization failure, not a cosmetic one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { db } from "../../db";
import { projects, remoteDevices } from "../../db/schema";
import { generateId } from "../../lib/id";
import { getSessionDevices } from "../device-connection-service";
import { createDevice } from "../device-service";

const OWNER = "user-owner-visibility";
const OTHER = "user-other-visibility";

const createdDevices: string[] = [];
const createdProjects: string[] = [];

afterEach(async () => {
	if (createdDevices.length > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, createdDevices.splice(0)));
	}
	if (createdProjects.length > 0) {
		await db.delete(projects).where(inArray(projects.id, createdProjects.splice(0)));
	}
});

async function makeProject(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Device visibility ${id.slice(0, 6)}`,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(id);
	return id;
}

async function makeDevice(input: {
	name: string;
	ownerScope: "private" | "shared";
	scope: "global" | "project";
	projectId?: string;
	createdBy: string;
}): Promise<string> {
	const { device } = await createDevice({
		name: input.name,
		connectionMode: "reverse",
		ownerScope: input.ownerScope,
		scope: input.scope,
		projectId: input.projectId,
		createdBy: input.createdBy,
	});
	createdDevices.push(device.id);
	return device.id;
}

async function visibleIds(projectId: string | null, userId?: string | null): Promise<Set<string>> {
	const devices = await getSessionDevices(projectId, userId);
	return new Set(devices.map((device) => device.id));
}

describe("private devices are only visible to their owner", () => {
	test("the owner sees it; another user and an unattended session do not", async () => {
		const deviceId = await makeDevice({
			name: "Owner laptop",
			ownerScope: "private",
			scope: "global",
			createdBy: OWNER,
		});

		expect(await visibleIds(null, OWNER)).toContain(deviceId);
		expect(await visibleIds(null, OTHER)).not.toContain(deviceId);
		// No acting user: cannot prove ownership, so it must stay hidden.
		expect(await visibleIds(null, null)).not.toContain(deviceId);
		expect(await visibleIds(null)).not.toContain(deviceId);
	});
});

describe("shared devices follow the project axis only", () => {
	test("a communal global device is visible to everyone", async () => {
		const deviceId = await makeDevice({
			name: "Build machine",
			ownerScope: "shared",
			scope: "global",
			createdBy: OWNER,
		});

		expect(await visibleIds(null, OTHER)).toContain(deviceId);
		expect(await visibleIds(null)).toContain(deviceId);
	});

	test("a project device is visible inside its project and hidden outside", async () => {
		const projectId = await makeProject();
		const otherProjectId = await makeProject();
		const deviceId = await makeDevice({
			name: "Deploy target",
			ownerScope: "shared",
			scope: "project",
			projectId,
			createdBy: OWNER,
		});

		expect(await visibleIds(projectId, OTHER)).toContain(deviceId);
		expect(await visibleIds(otherProjectId, OTHER)).not.toContain(deviceId);
		expect(await visibleIds(null, OTHER)).not.toContain(deviceId);
	});
});

describe("both axes compose", () => {
	test("a private project device needs the right user AND the right project", async () => {
		const projectId = await makeProject();
		const otherProjectId = await makeProject();
		const deviceId = await makeDevice({
			name: "Private project box",
			ownerScope: "private",
			scope: "project",
			projectId,
			createdBy: OWNER,
		});

		expect(await visibleIds(projectId, OWNER)).toContain(deviceId);
		expect(await visibleIds(otherProjectId, OWNER)).not.toContain(deviceId);
		expect(await visibleIds(projectId, OTHER)).not.toContain(deviceId);
	});
});

describe("default behaviour is unchanged", () => {
	test("a device registered without an owner scope stays communal", async () => {
		const { device } = await createDevice({
			name: "Legacy default",
			connectionMode: "reverse",
			scope: "global",
			createdBy: OWNER,
		});
		createdDevices.push(device.id);
		expect(device.ownerScope).toBe("shared");
		expect(await visibleIds(null, OTHER)).toContain(device.id);
	});
});
