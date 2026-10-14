import { afterAll, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";

const realDatabase = { ...(await import("../../db")) };
const realAccess = { ...(await import("../../lib/project-access")) };
// Load SQLite-backed dependencies before substituting the PostgreSQL fail-closed facade.
await import("../../services/project-db-sync");
const { projectDbRoutes } = await import("../project-db");
let databaseReads = 0;
const access = mock(async () => {
	throw new Error("Unexpected project ACL access");
});
mock.module("../../db", () => ({
	...realDatabase,
	activeDatabaseBackend: "postgres",
	db: new Proxy(realDatabase.db, {
		get() {
			databaseReads++;
			throw new Error("SQLite compatibility proxy must not be used in PostgreSQL mode");
		},
	}),
}));
mock.module("../../lib/project-access", () => ({ ...realAccess, requireProjectAccess: access }));
afterAll(() => {
	mock.module("../../db", () => realDatabase);
	mock.module("../../lib/project-access", () => realAccess);
	mock.restore();
});

test("PostgreSQL disable fails closed with 503 before ACL or SQLite proxy access", async () => {
	const app = new Hono().route("/projects", projectDbRoutes).onError((error, c) => {
		if (error instanceof AppError) return c.json({ code: error.code }, error.statusCode as 503);
		throw error;
	});
	const response = await app.request("/projects/unknown/legacy-sync/disable", { method: "POST" });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ code: "LEGACY_PROJECT_SYNC_UNSUPPORTED" });
	expect(access.mock.calls.length).toBe(0);
	expect(databaseReads).toBe(0);
});
