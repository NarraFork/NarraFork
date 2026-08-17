/**
 * Device path guard rule API.
 *
 * The properties worth pinning here are the ones a unit test cannot see: that
 * rule ORDER survives the HTTP + JSON + SQLite round trip byte for byte (order is
 * the priority mechanism, so any reordering silently rewrites the policy), that
 * malformed rules are refused rather than stored, and that the response keeps
 * "what I configured" separate from "what the device reports enforcing".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { generateId } from "../../lib/id";
import { deviceRoutes } from "../devices";

const createdDevices: string[] = [];

function app(role: "admin" | "user" = "admin", userId = "user-path-rules"): Hono {
	const instance = new Hono();
	instance.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	instance.route("/api/devices", deviceRoutes);
	instance.onError(
		(err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal server error" }, 500),
	);
	return instance;
}

async function makeDevice(): Promise<string> {
	const now = new Date().toISOString();
	const id = generateId();
	await db.insert(remoteDevices).values({
		id,
		name: `Path Rules ${id.slice(0, 6)}`,
		slug: `path-rules-${id.slice(0, 8).toLowerCase()}`,
		tokenHash: "hash",
		tokenPrefix: "rdev_aaa",
		connectionMode: "reverse",
		createdBy: "user-path-rules",
		createdAt: now,
		updatedAt: now,
	});
	createdDevices.push(id);
	return id;
}

beforeEach(() => {
	createdDevices.length = 0;
});

afterEach(async () => {
	if (createdDevices.length > 0) {
		await db.delete(remoteDevices).where(inArray(remoteDevices.id, createdDevices));
	}
});

describe("GET /api/devices/:id/path-rules", () => {
	test("a device with no rules reports an empty list, which means unrestricted", async () => {
		const id = await makeDevice();
		const res = await app().request(`/api/devices/${id}/path-rules`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.rules).toEqual([]);
		expect(body.reportedRules).toBeNull();
	});

	test("an unknown device is refused rather than returning empty rules", async () => {
		const res = await app().request(`/api/devices/${generateId()}/path-rules`);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe("PUT /api/devices/:id/path-rules", () => {
	async function put(id: string, rules: unknown, role: "admin" | "user" = "admin") {
		return app(role).request(`/api/devices/${id}/path-rules`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rules }),
		});
	}

	test("rule order survives the round trip exactly", async () => {
		const id = await makeDevice();
		// Deliberately not in sorted order, and with a deny between two allows: a
		// server that sorted or grouped these would invert the intended policy.
		const rules = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work/secrets" },
			{ action: "allow", path: "/srv/work/secrets/public" },
			{ action: "deny", path: "/srv/aaa-would-sort-first" },
		];
		const res = await put(id, rules);
		expect(res.status).toBe(200);
		expect((await res.json()).rules).toEqual(rules);

		// And again on a fresh read, so this is persistence order, not echo order.
		const reread = await app().request(`/api/devices/${id}/path-rules`);
		expect((await reread.json()).rules).toEqual(rules);
	});

	test("duplicate paths are preserved because the later rule wins", async () => {
		const id = await makeDevice();
		const rules = [
			{ action: "allow", path: "/srv/work" },
			{ action: "deny", path: "/srv/work" },
		];
		const res = await put(id, rules);
		expect(res.status).toBe(200);
		expect((await res.json()).rules).toEqual(rules);
	});

	test("an empty list is accepted and means unrestricted", async () => {
		const id = await makeDevice();
		await put(id, [{ action: "allow", path: "/srv/work" }]);
		const res = await put(id, []);
		expect(res.status).toBe(200);
		expect((await res.json()).rules).toEqual([]);
	});

	test("relative paths are refused and nothing is stored", async () => {
		const id = await makeDevice();
		const res = await put(id, [{ action: "allow", path: "relative/dir" }]);
		expect(res.status).toBeGreaterThanOrEqual(400);

		const after = await app().request(`/api/devices/${id}/path-rules`);
		expect((await after.json()).rules).toEqual([]);
	});

	test("an unknown action is refused", async () => {
		const id = await makeDevice();
		const res = await put(id, [{ action: "maybe", path: "/srv/work" }]);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test("control characters are refused so they cannot reach a config file", async () => {
		const id = await makeDevice();
		expect(
			(await put(id, [{ action: "allow", path: "/srv/wo\nrk" }])).status,
		).toBeGreaterThanOrEqual(400);
		expect(
			(await put(id, [{ action: "deny", path: "/srv/wo\u0000rk" }])).status,
		).toBeGreaterThanOrEqual(400);
	});

	test("windows paths are accepted even though the server is not Windows", async () => {
		const id = await makeDevice();
		const rules = [
			{ action: "allow", path: "C:\\work" },
			{ action: "deny", path: "C:\\work\\secrets" },
			{ action: "allow", path: "\\\\fileserver\\share" },
		];
		const res = await put(id, rules);
		expect(res.status).toBe(200);
		expect((await res.json()).rules).toEqual(rules);
	});

	test("a partially invalid list is rejected whole, not partially applied", async () => {
		const id = await makeDevice();
		await put(id, [{ action: "allow", path: "/srv/original" }]);
		const res = await put(id, [
			{ action: "allow", path: "/srv/valid" },
			{ action: "deny", path: "not-absolute" },
		]);
		expect(res.status).toBeGreaterThanOrEqual(400);

		// The previously saved rule must still be intact.
		const after = await app().request(`/api/devices/${id}/path-rules`);
		expect((await after.json()).rules).toEqual([{ action: "allow", path: "/srv/original" }]);
	});

	test("the config snippet is valid JSON with the rules in order", async () => {
		const id = await makeDevice();
		const rules = [
			{ action: "allow", path: "C:\\work" },
			{ action: "deny", path: 'C:\\we"ird\\path' },
		];
		const res = await put(id, rules);
		const { configSnippet } = await res.json();
		// Must parse: a snippet built by concatenation would break on the quote and
		// the backslashes, handing the operator a config the executor cannot read.
		expect(JSON.parse(configSnippet)).toEqual({ pathRules: rules });
	});

	test("a user who did not register the device cannot change its guard rules", async () => {
		// Path rules are a manager-tier power, not admin-only: the registrar of a
		// device configures its guard. Someone else must be refused, and with 404 so
		// the status cannot be used to enumerate device ids.
		const id = await makeDevice();
		const res = await app("user", "someone-else").request(`/api/devices/${id}/path-rules`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rules: [{ action: "allow", path: "/srv/work" }] }),
		});
		expect(res.status).toBe(404);

		const after = await app().request(`/api/devices/${id}/path-rules`);
		expect((await after.json()).rules).toEqual([]);
	});

	test("the registrar may set guard rules without being an admin", async () => {
		const id = await makeDevice();
		const res = await app("user", "user-path-rules").request(`/api/devices/${id}/path-rules`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rules: [{ action: "allow", path: "/srv/work" }] }),
		});
		expect(res.status).toBe(200);
	});

	test("an over-long list is refused", async () => {
		const id = await makeDevice();
		const rules = Array.from({ length: 300 }, () => ({
			action: "allow" as const,
			path: "/srv/work",
		}));
		expect((await put(id, rules)).status).toBeGreaterThanOrEqual(400);
	});
});
