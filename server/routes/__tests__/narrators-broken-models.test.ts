/**
 * Access boundary and route ordering for the broken-model migration endpoints.
 *
 * Two things must hold regardless of the service internals:
 *  - only admins may bulk-rewrite other users' narrator models;
 *  - the literal `/broken-models` paths must not be swallowed by `/:id`, which
 *    would silently turn a scan into "fetch the narrator named broken-models".
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-broken-models-route-"));
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

describe("broken model migration access boundary", () => {
	test("rejects a non-admin scan", async () => {
		const response = await appForRole("user").request("http://localhost/narrators/broken-models");
		expect(response.status).toBe(403);
	});

	test("rejects a non-admin migrate", async () => {
		const response = await appForRole("user").request(
			"http://localhost/narrators/broken-models/migrate",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
			},
		);
		expect(response.status).toBe(403);
	});

	test("rejects a non-admin undo", async () => {
		const response = await appForRole("user").request(
			"http://localhost/narrators/broken-models/undo",
			{ method: "POST" },
		);
		expect(response.status).toBe(403);
	});
});

describe("broken model migration route resolution", () => {
	test("an admin scan reaches the scan handler, not the /:id route", async () => {
		const response = await appForRole("admin").request("http://localhost/narrators/broken-models");

		// The /:id route would 404 on a narrator literally named "broken-models"; the scan
		// handler answers 200 with the scan envelope instead.
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ groups: expect.any(Array) });
		expect(typeof body.totalBroken).toBe("number");
		expect(typeof body.undoAvailable).toBe("boolean");
	});

	test("migrate validates its body before touching any narrator", async () => {
		const response = await appForRole("admin").request(
			"http://localhost/narrators/broken-models/migrate",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
			},
		);
		expect(response.status).toBe(400);
	});
});
