/**
 * Creating a session on an execution device.
 *
 * The creation dialog picks the device BEFORE the directory, so these pin the server
 * contract it relies on:
 *  - `/api/narrators/workspace-devices` lists exactly the caller's visible devices;
 *  - a remote creation records the device and its directory in one row;
 *  - a remote directory is validated by the DEVICE, so a `C:\...` path is not read as a
 *    relative POSIX path and a missing directory is refused instead of silently falling
 *    back to the device default;
 *  - the pre-creation browser refuses paths outside the device's declared root for
 *    non-admins, and never reveals a device the caller cannot see.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { narrators, projects, users } from "@server/db/schema";
import { windowsPathSemantics } from "@server/lib/agent/execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "@server/lib/agent/execution/registry";
import { AppError } from "@server/lib/errors";
import { generateId } from "@server/lib/id";
import * as deviceConnections from "@server/services/device-connection-service";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

// The browser endpoint forwards to a real device RPC and resolves the target against a
// live connection. Keep every other export and replace just those two, so a refused
// path can be proven never to reach a device.
const realTransferService = await import("@server/services/device-transfer-service");
const browseRemoteDirectory = mock(async () => ({
	path: "",
	entries: [] as Array<{ name: string; isDirectory: boolean }>,
}));
const resolveRemoteBrowseTarget = mock((_deviceId: string, path?: string) => ({
	path: (path ?? "C:\\device-default").replace(/\\+$/, "") || "C:\\",
	defaultCwd: "C:\\device-default",
	pathFlavor: "windows" as const,
	sep: "\\",
}));
mock.module("@server/services/device-transfer-service", () => ({
	...realTransferService,
	browseRemoteDirectory,
	resolveRemoteBrowseTarget,
}));

const { db } = await import("@server/db");
const { narratorRoutes } = await import("@server/routes/narrators");

const WINDOWS_DEVICE = "win-box";

function app(actor: string) {
	const routes = new Hono();
	routes.use("*", async (c, next) => {
		c.set("user", { sub: actor, role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	routes.onError(
		(error) =>
			new Response(
				JSON.stringify({
					error: error.message,
					code: error instanceof AppError ? error.code : "TEST_ERROR",
					...(error instanceof AppError && error.details ? { details: error.details } : {}),
				}),
				{
					status: error instanceof AppError ? error.statusCode : 500,
					headers: { "content-type": "application/json" },
				},
			),
	);
	routes.route("/api/narrators", narratorRoutes);
	return routes;
}

let root: string;
let owner: string;
let projectId: string;
const restorers: (() => void)[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "narrator-create-device-"));
	await mkdir(join(root, "work"));
	owner = generateId();
	projectId = generateId();
	const now = new Date().toISOString();
	await db.insert(users).values({
		id: owner,
		username: owner,
		passwordHash: "fixture",
		createdAt: now,
	});
	await db.insert(projects).values({
		id: projectId,
		name: "device project",
		gitPath: join(root, "work"),
		ownerUserId: owner,
		createdAt: now,
		updatedAt: now,
	});
	setRemoteBackendResolver((deviceId) =>
		deviceId === WINDOWS_DEVICE
			? Object.assign(Object.create(localBackend), {
					kind: "remote" as const,
					deviceId,
					defaultCwd: "C:\\device-default",
					pathFlavor: "windows" as const,
					paths: windowsPathSemantics,
					statFile: async (path: string) => ({
						isDirectory: path === "C:\\work",
						isFile: path !== "C:\\work",
						size: 0,
					}),
				})
			: null,
	);
});

afterEach(async () => {
	for (const restore of restorers.splice(0).reverse()) restore();
	setRemoteBackendResolver(null);
	await db.delete(narrators).where(eq(narrators.ownerUserId, owner));
	await db.delete(projects).where(eq(projects.id, projectId));
	await db.delete(users).where(eq(users.id, owner));
	await rm(root, { recursive: true, force: true });
});

function stubDevices(devices: Array<Record<string, unknown>>) {
	const spy = spyOn(deviceConnections, "getSessionDevices").mockResolvedValue(devices as never);
	restorers.push(() => spy.mockRestore());
	return spy;
}

const windowsDevice = {
	id: WINDOWS_DEVICE,
	slug: "win-box",
	scope: "project" as const,
	name: "windows box",
	online: true,
	defaultCwd: "C:\\device-default",
	platform: { os: "windows", arch: "amd64" },
	ownedByActingUser: true,
};

describe("creating a session on an execution device", () => {
	test("a remote creation records the device and its directory in one row", async () => {
		stubDevices([windowsDevice]);
		const response = await app(owner).request("/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "on windows", deviceId: WINDOWS_DEVICE, cwd: "C:\\work" }),
		});
		expect(response.status, await response.clone().text()).toBe(201);
		const created = (await response.json()) as { id: string };
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, created.id) });
		expect(row?.defaultDeviceId).toBe(WINDOWS_DEVICE);
		expect(row?.cwd).toBe("C:\\work");
		// `C:\...` is not an absolute POSIX path; a host-grammar check would have stored
		// the directory as a local claim and left the device unconfigured.
		expect(row?.workspaceDirectories).toEqual({
			[WINDOWS_DEVICE]: { cwd: "C:\\work", pathFlavor: "windows" },
		});
	});

	test("a remote creation without a directory is refused instead of using the device default", async () => {
		stubDevices([windowsDevice]);
		const response = await app(owner).request("/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "no dir", deviceId: WINDOWS_DEVICE }),
		});
		expect(response.status).toBe(400);
		expect(await db.query.narrators.findFirst({ where: eq(narrators.ownerUserId, owner) })).toBe(
			undefined,
		);
	});

	test("a remote creation refuses a missing directory and an unknown device", async () => {
		stubDevices([windowsDevice]);
		const missing = await app(owner).request("/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceId: WINDOWS_DEVICE, cwd: "C:\\not-there" }),
		});
		expect(missing.status).toBe(400);
		const unknown = await app(owner).request("/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceId: "someone-elses-box", cwd: "/srv/app" }),
		});
		expect(unknown.status).toBe(400);
		expect(await db.query.narrators.findFirst({ where: eq(narrators.ownerUserId, owner) })).toBe(
			undefined,
		);
	});

	test("a local creation keeps working without any device", async () => {
		stubDevices([windowsDevice]);
		const response = await app(owner).request("/api/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "local", cwd: join(root, "work") }),
		});
		expect(response.status, await response.clone().text()).toBe(201);
		const created = (await response.json()) as { id: string };
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, created.id) });
		expect(row?.defaultDeviceId).toBeNull();
		expect(row?.cwd).toBe(join(root, "work"));
	});
});

describe("devices and directories before the session exists", () => {
	test("the device list is the caller's own visibility, never an arbitrary lookup", async () => {
		stubDevices([windowsDevice]);
		const response = await app(owner).request("/api/narrators/workspace-devices");
		expect(response.status).toBe(200);
		const listed = (await response.json()) as {
			devices: Array<{ id: string; defaultCwd: string; platform?: { os: string } }>;
		};
		expect(listed.devices.map((device) => device.id)).toEqual([WINDOWS_DEVICE]);
		expect(listed.devices[0]?.defaultCwd).toBe("C:\\device-default");
		expect(listed.devices[0]?.platform?.os).toBe("windows");
	});

	test("browsing a device the caller cannot see answers like an unknown device", async () => {
		stubDevices([]);
		const response = await app(owner).request(
			`/api/narrators/workspace-directory-browse?deviceId=${WINDOWS_DEVICE}`,
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: `Unknown or unauthorized device: ${WINDOWS_DEVICE}`,
		});
	});

	test("a non-admin may only browse inside the device's declared root", async () => {
		stubDevices([windowsDevice]);
		browseRemoteDirectory.mockClear();
		browseRemoteDirectory.mockResolvedValue({ path: "C:\\device-default", entries: [] } as never);
		const inside = await app(owner).request(
			`/api/narrators/workspace-directory-browse?deviceId=${WINDOWS_DEVICE}&path=${encodeURIComponent("C:\\device-default\\src")}`,
		);
		expect(inside.status, await inside.clone().text()).toBe(200);
		expect(browseRemoteDirectory).toHaveBeenCalledTimes(1);
		const outside = await app(owner).request(
			`/api/narrators/workspace-directory-browse?deviceId=${WINDOWS_DEVICE}&path=${encodeURIComponent("C:\\Windows")}`,
		);
		expect(outside.status).toBe(403);
		// A refused path must never reach the device.
		expect(browseRemoteDirectory).toHaveBeenCalledTimes(1);
	});
});
