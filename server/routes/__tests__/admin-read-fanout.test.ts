import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { db, sqlite } from "../../db";
import { users } from "../../db/schema";
import { readNativeRows } from "../../db/worker-read";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import { createToken } from "../../lib/auth";
import { drainDbWorkerPool } from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import {
	readFanoutHttpMiddleware,
	resetReadFanoutDiagnosticsForTest,
	startReadFanoutCapture,
	stopReadFanoutCapture,
} from "../../lib/read-fanout-diagnostics";
import { requireAuth } from "../../middleware/auth";
import { adminRoutes } from "../admin";

const app = new Hono();
app.use("/api/*", readFanoutHttpMiddleware);
app.route("/api/admin", adminRoutes);
app.get("/api/read-fanout-fixture/:id", requireAuth, async (c) => {
	await readNativeRows(sqlite, "SELECT ? AS value", ["private-bind"], {
		diagnosticSource: "private-source",
	});
	return c.json({ ok: true });
});
app.onError(
	(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "fixture failure" }, 500),
);
const adminId = generateId();
const userId = generateId();
let adminToken: string;
let userToken: string;
const PREFIX = "/api/admin/diagnostics/read-fanout";
function post(action: "start" | "stop", body: unknown, token?: string) {
	return app.request(`http://local${PREFIX}/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}
beforeAll(async () => {
	for (const [id, role] of [
		[adminId, "admin"],
		[userId, "user"],
	] as const)
		db.insert(users)
			.values({
				id,
				username: id,
				passwordHash: "fixture",
				role,
				createdAt: new Date().toISOString(),
			})
			.run();
	adminToken = await createToken(adminId);
	userToken = await createToken(userId);
});
afterEach(resetReadFanoutDiagnosticsForTest);
afterAll(async () => {
	db.delete(users)
		.where(inArray(users.id, [adminId, userId]))
		.run();
	await drainDbWorkerPool({ timeoutMs: 20_000 });
});

describe("administrator read-fanout controls", () => {
	test("both complete API paths enforce authentication and live admin authorization", async () => {
		for (const action of ["start", "stop"] as const) {
			expect((await post(action, { captureId: "private-capture" })).status).toBe(401);
			expect((await post(action, { captureId: "private-capture" }, userToken)).status).toBe(403);
		}
	});

	test("start validates duration, limits concurrent windows, and stop requires the matching capture", async () => {
		for (const durationMs of [0, -1, 60_001, 1.5, "10", null])
			expect((await post("start", { durationMs }, adminToken)).status).toBe(400);
		const started = await post("start", {}, adminToken);
		expect(started.status).toBe(200);
		expect(started.headers.get("Cache-Control")).toBe("no-store");
		const capture = await started.json();
		expect(capture.durationMs).toBe(30_000);
		expect(typeof capture.captureId).toBe("string");
		expect((await post("start", {}, adminToken)).status).toBe(409);
		expect((await post("stop", {}, adminToken)).status).toBe(400);
		expect((await post("stop", { captureId: "wrong" }, adminToken)).status).toBe(404);
		const stopped = await post("stop", { captureId: capture.captureId }, adminToken);
		expect(stopped.status).toBe(200);
		expect(stopped.headers.get("Cache-Control")).toBe("no-store");
		expect((await stopped.json()).captureId).toBe(capture.captureId);
		expect((await post("stop", { captureId: capture.captureId }, adminToken)).status).toBe(404);
	});

	test("control authentication reads are excluded; ordinary auth and query share the route scope", async () => {
		// Reuse a worker whose message listener was created outside the excluded request scope.
		await readNativeRows(sqlite, "SELECT 1 AS warm");
		const first = startReadFanoutCapture();
		await post("start", {}, adminToken);
		await post("stop", { captureId: "wrong" }, userToken);
		const empty = stopReadFanoutCapture(first.captureId);
		expect(empty.totals.logicalReads).toBe(0);
		expect(empty.totals.poolEntries).toBe(0);
		expect(empty.totals.preWindowResponses).toBe(0);
		const started = await post("start", { durationMs: 60_000 }, adminToken);
		const { captureId } = await started.json();
		const response = await app.request(
			"http://local/api/read-fanout-fixture/private-id?token=private-query",
			{ headers: { authorization: `Bearer ${userToken}` } },
		);
		expect(response.status).toBe(200);
		const stopped = await post("stop", { captureId }, adminToken);
		const report = await stopped.json();
		const observed = report.sources.find(
			(row: { source: string }) => row.source === "HTTP GET /api/read-fanout-fixture/:id",
		);
		expect(observed.counts.logicalReads).toBeGreaterThanOrEqual(2);
		expect(report.totals.logicalReads).toBe(observed.counts.logicalReads);
		expect(report.totals.scopesStarted).toBe(1);
		expect(report.totals.preWindowResponses).toBe(0);
		for (const secret of [
			adminToken,
			userToken,
			adminId,
			userId,
			"private-bind",
			"private-source",
			"private-id",
			"private-query",
		])
			expect(JSON.stringify(report)).not.toContain(secret);
	});
});
