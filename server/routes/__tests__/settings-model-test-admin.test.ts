import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-model-test-admin-"));
process.env.NARRAFORK_HOME = testHome;
const { settings } = await import("../../lib/settings");
const { settingsRoutes } = await import("../settings");

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
		throw error;
	});
	app.route("/settings", settingsRoutes);
	return app;
}

describe("settings conditional admin guards", () => {
	test("rejects a non-admin before attempting provider resolution", async () => {
		const response = await appForRole("user").request("/settings/test-model", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "does-not-matter", prompt: "hello" }),
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Admin access required",
			code: "FORBIDDEN",
		});
	});

	test("rejects explicit trustedProxyCidrs patches from non-admins without mutation", async () => {
		const before = structuredClone(settings.auth);
		const response = await appForRole("user").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				auth: { trustedProxyCidrs: ["10.0.0.0/8"] },
				agent: { maxTurns: settings.agent.maxTurns + 1 },
			}),
		});

		expect(response.status).toBe(403);
		expect(settings.auth).toEqual(before);
	});

	test("allows ordinary settings patches for non-admins", async () => {
		const original = settings.auth.registrationOpen;
		const response = await appForRole("user").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { registrationOpen: !original } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.registrationOpen).toBe(!original);
		settings.auth.registrationOpen = original;
	});

	test("allows admins to update trustedProxyCidrs", async () => {
		const original = structuredClone(settings.auth.trustedProxyCidrs);
		const response = await appForRole("admin").request("/settings", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ auth: { trustedProxyCidrs: ["10.0.0.0/8"] } }),
		});

		expect(response.status).toBe(200);
		expect(settings.auth.trustedProxyCidrs).toEqual(["10.0.0.0/8"]);
		settings.auth.trustedProxyCidrs = original;
	});
});
