/**
 * Access boundary, route ordering and authorization handling for the Setup
 * Assistant endpoint.
 *
 * What must hold regardless of the service internals:
 *  - only admins may spawn a narrator that installs system software;
 *  - the literal `/setup-assistant` path must not be swallowed by `/:id`, which
 *    would turn the call into "fetch the narrator named setup-assistant";
 *  - an invalid authorization value is refused rather than silently downgraded,
 *    and an absent one means standard permissions — never full authority.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-setup-assistant-route-"));
process.env.NARRAFORK_HOME = testHome;
// Imported after NARRAFORK_HOME is redirected: the route module initialises the DB
// layer at import time and must not contend for the real ~/.narrafork instance.
const { narratorRoutes } = await import("../narrators");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `${role}-id`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify({ error: String(error) }), {
			status: 500,
			headers: { "content-type": "application/json" },
		});
	});
	app.route("/narrators", narratorRoutes);
	return app;
}

function post(role: "admin" | "user", body?: unknown) {
	return appForRole(role).request("http://localhost/narrators/setup-assistant", {
		method: "POST",
		...(body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
}

describe("setup assistant access boundary", () => {
	test("rejects a non-admin: installing system software is instance-wide", async () => {
		const response = await post("user", { authorization: "default" });
		expect(response.status).toBe(403);
	});

	test("a non-admin cannot reach it by asking for full authority either", async () => {
		const response = await post("user", { authorization: "full" });
		expect(response.status).toBe(403);
	});
});

describe("setup assistant route resolution and validation", () => {
	test("an admin request reaches the handler, not the /:id route", async () => {
		// /:id would 404 for a narrator literally named "setup-assistant". The handler
		// instead answers with the created/dependencies envelope — 201 when it spawned a
		// narrator, 200 with created:false when this machine has nothing to install.
		const response = await post("admin", { authorization: "default" });
		expect([200, 201]).toContain(response.status);
		const body = (await response.json()) as Record<string, unknown>;
		expect(typeof body.created).toBe("boolean");
		expect(body.dependencies).toBeDefined();
	});

	test("an unknown authorization value is refused, not downgraded", async () => {
		const response = await post("admin", { authorization: "bypassEverything" });
		expect(response.status).toBe(400);
	});

	test("a bodyless POST is accepted and never means full authority", async () => {
		const response = await post("admin");
		expect([200, 201]).toContain(response.status);
		const body = (await response.json()) as Record<string, unknown>;
		// created:false (nothing missing) carries no authorization; when it did create
		// one, the echoed authorization must be the standard level.
		if (body.created === true) expect(body.authorization).toBe("default");
	});
});
