import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { requireSqliteNarratorSurface } from "../narrators";

function admissionApp(backend: string, effects: { body: number; database: number; host: number }) {
	const app = new Hono();
	app.onError((error, c) => {
		return buildAppErrorResponse(error, c) ?? c.json({ error: String(error) }, 500);
	});
	app.use("*", async (_c, next) => {
		requireSqliteNarratorSurface(backend);
		return next();
	});
	app.get("/narrators/:id", (c) => {
		effects.database++;
		return c.json({ id: c.req.param("id") });
	});
	app.post("/narrators", async (c) => {
		effects.body++;
		await c.req.json();
		effects.database++;
		effects.host++;
		return c.json({ ok: true });
	});
	return app;
}

describe("PostgreSQL narrator HTTP admission", () => {
	test("rejects GET before narrator database access", async () => {
		const effects = { body: 0, database: 0, host: 0 };
		const response = await admissionApp("postgres", effects).request(
			"http://localhost/narrators/not-a-real-id",
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "Narrator HTTP API is not yet supported on the PostgreSQL backend",
			code: "POSTGRES_UNSUPPORTED",
		});
		expect(effects).toEqual({ body: 0, database: 0, host: 0 });
	});

	test("rejects POST before body parsing, database access, or host effects", async () => {
		const effects = { body: 0, database: 0, host: 0 };
		const response = await admissionApp("postgres", effects).request("http://localhost/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{this body must never be parsed",
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ code: "POSTGRES_UNSUPPORTED" });
		expect(effects).toEqual({ body: 0, database: 0, host: 0 });
	});

	test("registers the production gate before body limits and narrator ACL admission", async () => {
		const source = await Bun.file(new URL("../narrators.ts", import.meta.url)).text();
		const gate = source.indexOf('narratorRoutes.use("*", async (_c, next) => {');
		expect(gate).toBeGreaterThan(-1);
		expect(source.indexOf("const boundedRevertRequest", gate)).toBeGreaterThan(gate);
		expect(source.indexOf('narratorRoutes.use("/:id/*"', gate)).toBeGreaterThan(gate);
	});

	test("leaves SQLite requests admitted", async () => {
		const effects = { body: 0, database: 0, host: 0 };
		const response = await admissionApp("sqlite", effects).request("http://localhost/narrators", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		expect(response.status).toBe(200);
		expect(effects).toEqual({ body: 1, database: 1, host: 1 });
	});
});
