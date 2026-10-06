/**
 * Non-admin device management boundary.
 *
 * This router used to be blanket admin-only. Opening it up is only safe if three
 * separate lines hold, so each is pinned here rather than trusted to review:
 *
 * 1. A user may register and manage their **own** devices.
 * 2. A user may not read, edit, or delete **someone else's** device — and cannot
 *    tell an existing-but-foreign id apart from a nonexistent one.
 * 3. The endpoints whose blast radius is the whole server stay admin-only. The
 *    transfer endpoints take an unbounded server-local `localPath`
 *    (`validateLocalAbsolutePath` only checks that it is absolute), so exposing
 *    them to a non-admin would be arbitrary read/write on the NarraFork host
 *    regardless of who owns the device.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { projects, remoteDevices } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { deviceRoutes } from "../devices";

const OWNER = "user-owner";
const OTHER = "user-other";
const ADMIN = "user-admin";

const created: string[] = [];
const createdProjects: string[] = [];

/** A real project row: project-scoped devices are validated against it. */
async function makeProject(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `Device auth ${id.slice(0, 6)}`,
		createdAt: now,
		updatedAt: now,
	});
	createdProjects.push(id);
	return id;
}

function appAs(userId: string, role: "admin" | "user"): Hono {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.route("/api/devices", deviceRoutes);
	app.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return app;
}

async function makeDevice(
	createdBy: string,
	overrides: { scope?: "global" | "project"; ownerScope?: "private" | "shared" } = {},
): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	const scope = overrides.scope ?? "project";
	// A project-scoped device needs a real project: PATCH revalidates the scope even
	// when only the name changes.
	const projectId = scope === "project" ? await makeProject() : null;
	await db.insert(remoteDevices).values({
		id,
		name: `Device ${id.slice(0, 6)}`,
		slug: `dev-${id.slice(0, 10).toLowerCase()}`,
		tokenHash: "hash",
		tokenPrefix: "rdev_ccc",
		connectionMode: "reverse",
		createdBy,
		scope,
		projectId,
		ownerScope: overrides.ownerScope ?? "shared",
		createdAt: now,
		updatedAt: now,
	});
	created.push(id);
	return id;
}

beforeEach(() => {
	created.length = 0;
	createdProjects.length = 0;
});

afterEach(async () => {
	if (created.length > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, created));
	}
	if (createdProjects.length > 0) {
		await db.delete(projects).where(inArray(projects.id, createdProjects));
	}
});

describe("registering a device", () => {
	test("a non-admin may register a project-scoped device", async () => {
		const res = await appAs(OWNER, "user").request("/api/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "My Laptop",
				connectionMode: "reverse",
				scope: "project",
				projectId: await makeProject(),
			}),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		created.push(body.device.id);
		// The plaintext key is returned exactly once, here.
		expect(typeof body.token).toBe("string");
		expect(body.device.createdBy).toBe(OWNER);
	});

	test("a non-admin may not register a global device", async () => {
		// Global means reachable from every project AND injected by default, so it
		// is the one scope a user must not be able to grant itself.
		const res = await appAs(OWNER, "user").request("/api/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Sneaky", connectionMode: "reverse", scope: "global" }),
		});
		expect(res.status).toBe(403);
	});

	test("an admin may register a global device", async () => {
		const res = await appAs(ADMIN, "admin").request("/api/devices", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Build Farm", connectionMode: "reverse", scope: "global" }),
		});
		expect(res.status).toBe(201);
		created.push((await res.json()).device.id);
	});
});

describe("managing one's own device", () => {
	test("the registrar may read, rename, set path rules, and delete it", async () => {
		const id = await makeDevice(OWNER);
		const app = appAs(OWNER, "user");

		expect((await app.request(`/api/devices/${id}`)).status).toBe(200);

		const renamed = await app.request(`/api/devices/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Renamed" }),
		});
		expect(renamed.status).toBe(200);
		expect((await renamed.json()).name).toBe("Renamed");

		const rules = await app.request(`/api/devices/${id}/path-rules`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rules: [{ action: "allow", path: "/srv/work" }] }),
		});
		expect(rules.status).toBe(200);

		expect((await app.request(`/api/devices/${id}`, { method: "DELETE" })).status).toBe(200);
	});

	test("the registrar may generate an install script", async () => {
		// Without this, registering a device would be useless to a non-admin: the
		// script only enrolls a machine they already control.
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/install-script`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ platform: "linux-amd64", mode: "user" }),
		});
		// 200 when a release is published, 400 when none is — either way, not a
		// permission failure.
		expect(res.status).not.toBe(403);
		expect(res.status).not.toBe(404);
	});

	test("the registrar may not promote their own device to global", async () => {
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ scope: "global" }),
		});
		expect(res.status).toBe(403);
	});

	test("the list shows only the caller's own devices", async () => {
		const mine = await makeDevice(OWNER);
		const theirs = await makeDevice(OTHER);
		const res = await appAs(OWNER, "user").request("/api/devices");
		const ids = (await res.json()).map((device: { id: string }) => device.id);
		expect(ids).toContain(mine);
		expect(ids).not.toContain(theirs);
	});

	test("an admin's list includes devices registered by others", async () => {
		const theirs = await makeDevice(OTHER);
		const res = await appAs(ADMIN, "admin").request("/api/devices");
		const ids = (await res.json()).map((device: { id: string }) => device.id);
		expect(ids).toContain(theirs);
	});
});

describe("another user's device", () => {
	test("is not readable, editable, or deletable", async () => {
		const id = await makeDevice(OTHER);
		const app = appAs(OWNER, "user");

		expect((await app.request(`/api/devices/${id}`)).status).toBe(404);
		expect(
			(
				await app.request(`/api/devices/${id}`, {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name: "Hijacked" }),
				})
			).status,
		).toBe(404);
		expect((await app.request(`/api/devices/${id}`, { method: "DELETE" })).status).toBe(404);
	});

	test("its key cannot be rotated, which would hijack the machine", async () => {
		// Rotating someone else's key would break their executor and hand the new
		// credential to the attacker.
		const id = await makeDevice(OTHER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/rotate-token`, {
			method: "POST",
		});
		expect(res.status).toBe(404);
	});

	test("its path rules cannot be read or widened", async () => {
		const id = await makeDevice(OTHER);
		const app = appAs(OWNER, "user");
		expect((await app.request(`/api/devices/${id}/path-rules`)).status).toBe(404);
		expect(
			(
				await app.request(`/api/devices/${id}/path-rules`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ rules: [] }),
				})
			).status,
		).toBe(404);
	});

	test("a shared device is usable by others but still not manageable by them", async () => {
		// The distinction this whole change rests on: usage and management are
		// different powers. Shared only affects who may run tool calls on it.
		const id = await makeDevice(OTHER, { ownerScope: "shared" });
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Not yours" }),
		});
		expect(res.status).toBe(404);
	});

	test("reports 404 for a foreign id exactly as for a nonexistent one", async () => {
		// Otherwise the status code becomes an oracle for enumerating device ids.
		const foreign = await makeDevice(OTHER);
		const app = appAs(OWNER, "user");
		const foreignRes = await app.request(`/api/devices/${foreign}`);
		const missingRes = await app.request(`/api/devices/${generateId()}`);
		expect(foreignRes.status).toBe(missingRes.status);
	});
});

describe("server-filesystem endpoints stay admin-only", () => {
	test("a non-admin cannot start a transfer even on their own device", async () => {
		// localPath is an unbounded path on the NarraFork server, so this endpoint is
		// effectively arbitrary server-side file read/write.
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/transfer-tasks`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				direction: "download",
				remotePath: "/etc/hostname",
				localPath: "/etc/narrafork-owned",
			}),
		});
		expect(res.status).toBe(403);
	});

	test("a non-admin cannot use the synchronous transfer endpoint either", async () => {
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/transfers`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				direction: "upload",
				remotePath: "/tmp/x",
				localPath: "/root/.ssh/id_rsa",
			}),
		});
		expect(res.status).toBe(403);
	});

	test("a non-admin cannot list or control transfer tasks", async () => {
		const id = await makeDevice(OWNER);
		const app = appAs(OWNER, "user");
		expect((await app.request(`/api/devices/${id}/transfer-tasks`)).status).toBe(403);
		expect(
			(await app.request(`/api/devices/${id}/transfer-tasks/task-1/cancel`, { method: "POST" }))
				.status,
		).toBe(403);
		expect(
			(await app.request(`/api/devices/${id}/transfer-tasks/task-1/pause`, { method: "POST" }))
				.status,
		).toBe(403);
		expect(
			(await app.request(`/api/devices/${id}/transfer-tasks/task-1/resume`, { method: "POST" }))
				.status,
		).toBe(403);
	});

	test("a non-admin cannot stat remote paths through the recursive /fs endpoint", async () => {
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/fs?path=%2F&recursive=true`);
		expect(res.status).toBe(403);
	});

	test("the registrar may still browse one directory level, for the path picker", async () => {
		// /browse touches no server-local path and the path-rules editor needs it, so
		// it sits at the manager tier rather than admin.
		const id = await makeDevice(OWNER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/browse`);
		expect(res.status).not.toBe(403);
	});

	test("a non-admin cannot browse another user's device", async () => {
		const id = await makeDevice(OTHER);
		const res = await appAs(OWNER, "user").request(`/api/devices/${id}/browse`);
		expect(res.status).toBe(404);
	});
});
