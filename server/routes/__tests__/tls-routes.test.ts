import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-tls-routes-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART = "1";

const { settings } = await import("../../lib/settings");
const { tlsRoutes } = await import("../tls");

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	delete process.env.NARRAFORK_CONTRACT_SUPPRESS_RESTART;
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
	app.route("/settings/tls", tlsRoutes);
	return app;
}

describe("tls route guards", () => {
	test("rejects non-admin certificate generation", async () => {
		const response = await appForRole("user").request("/settings/tls/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ customSans: ["nas.local"] }),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Admin access required",
			code: "FORBIDDEN",
		});
	});

	test("rejects non-admin CA regeneration", async () => {
		const response = await appForRole("user").request("/settings/tls/regenerate-ca", {
			method: "POST",
		});
		expect(response.status).toBe(403);
	});

	test("rejects invalid custom SANs with a 400 naming the offender", async () => {
		const response = await appForRole("admin").request("/settings/tls/generate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ customSans: ["https://evil.example"] }),
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("https://evil.example");
	});

	test("status is readable by any signed-in user before any cert exists", async () => {
		const response = await appForRole("user").request("/settings/tls/status");
		expect(response.status).toBe(200);
		const body = (await response.json()) as { caExists: boolean; certExists: boolean };
		expect(body.caExists).toBe(false);
		expect(body.certExists).toBe(false);
	});

	test("ca.pem is 404 before generation and downloadable (not admin-only) after", async () => {
		const missing = await appForRole("user").request("/settings/tls/ca.pem");
		expect(missing.status).toBe(404);

		const original = structuredClone(settings);
		try {
			const generated = await appForRole("admin").request("/settings/tls/generate", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ customSans: ["nas.local"] }),
			});
			expect(generated.status).toBe(200);
			const genBody = (await generated.json()) as {
				effectiveSans: string[];
				caCreated: boolean;
				serverRestarting: boolean;
			};
			expect(genBody.caCreated).toBe(true);
			expect(genBody.effectiveSans).toContain("nas.local");
			expect(genBody.effectiveSans).toContain("localhost");

			// A plain user can fetch the CA — they need it to trust their own device.
			const download = await appForRole("user").request("/settings/tls/ca.pem");
			expect(download.status).toBe(200);
			expect(download.headers.get("content-disposition")).toContain("narrafork-ca.pem");
			const pem = await download.text();
			expect(pem).toContain("-----BEGIN CERTIFICATE-----");
		} finally {
			const { saveSettings, settings: current } = await import("../../lib/settings");
			saveSettings({ ...current, server: original.server });
		}
	});
});
