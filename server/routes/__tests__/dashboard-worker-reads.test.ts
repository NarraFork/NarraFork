import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import * as schema from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import * as pool from "../../lib/db-worker/pool";

const home = mkdtempSync(join(tmpdir(), "dashboard-worker-"));
const file = join(home, "fixture.db");
const memory = getTestDb();
writeFileSync(file, memory.sqlite.serialize());
memory.sqlite.close();
const sqlite = new Database(file);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = OFF");
const db = drizzle({ client: sqlite, schema });
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const permissions = mock(async (_id: string) => [{}]);
mock.module("../../services/narrator-service", () => ({
	narratorService: { getPendingPermissions: permissions },
}));
const { dashboardRoutes } = await import("../dashboard");
const app = new Hono();
let role: "user" | "admin" = "user";
app.use("*", async (c, next) => {
	c.set("user", { sub: "alice", role, iat: 0, exp: 0 });
	await next();
});
app.route("/api/dashboard", dashboardRoutes);
app.onError((err, c) => {
	if (c.req.raw.signal.aborted && err.name === "AbortError")
		return new Response(null, { status: 499 });
	return buildAppErrorResponse(err, c) ?? c.json({ error: "Internal error" }, 500);
});
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	await pool.resetDbWorkerPoolForTest();
	cleanDb(sqlite);
	role = "user";
	permissions.mockClear();
});
afterEach(async () => {
	mock.restore();
	await pool.resetDbWorkerPoolForTest();
});
afterAll(() => {
	mock.module("../../db", () => realDb);
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

const empty = {
	activeProjectCount: 0,
	totalProjectCount: 0,
	workingNarratorCount: 0,
	waitingNarratorCount: 0,
	runningTerminalCount: 0,
	runningContainerCount: 0,
	enabledScheduledTaskCount: 0,
	todayCostUsd: 0,
	todayTokens: { input: 0, output: 0, reasoning: 0, total: 0 },
	attention: { permissionCount: 0, failedNarratorCount: 0 },
};
const now = new Date().toISOString();
function seed() {
	for (const id of ["alice", "bob"]) {
		db.insert(schema.users)
			.values({ id, username: id, passwordHash: "unused", createdAt: now })
			.run();
	}
	for (const [id, ownerUserId, visibility, status] of [
		["own", "alice", "private", "active"],
		["public", "bob", "public", "archived"],
		["private", "bob", "private", "active"],
	] as const) {
		db.insert(schema.projects)
			.values({
				id,
				name: id,
				ownerUserId,
				visibility,
				status,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	for (const [id, status, ownerUserId, extra] of [
		["work", "working", "alice", {}],
		["wait", "waiting", "alice", { errorMessage: "failed" }],
		["secret", "waiting", "bob", { errorMessage: "failed" }],
		["archived", "archived", "alice", { errorMessage: "failed" }],
		["hidden", "waiting", "alice", { hiddenFromLists: true }],
		["other-variant", "waiting", "alice", { variant: "memory" }],
	] as const) {
		db.insert(schema.narrators)
			.values({
				id,
				status,
				ownerUserId,
				visibility: "private",
				createdAt: now,
				updatedAt: now,
				...extra,
			})
			.run();
	}
	for (const status of ["running", "exited"] as const) {
		db.insert(schema.terminals).values({ id: status, name: status, status, createdAt: now }).run();
	}
	for (const status of ["running", "stopped"] as const) {
		db.insert(schema.containerInstances)
			.values({
				id: status,
				serviceName: status,
				status,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	for (const enabled of [true, false]) {
		db.insert(schema.scheduledTasks)
			.values({
				id: String(enabled),
				name: "task",
				enabled,
				cronExpr: "* * * * *",
				prompt: "hello",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	for (const [id, userId, createdAt] of [
		["today", "alice", now],
		["other", "bob", now],
		["legacy", null, now],
		["old", "alice", "2000-01-01T00:00:00.000Z"],
	] as const) {
		db.insert(schema.apiRequests)
			.values({
				id,
				userId,
				createdAt,
				costUsd: 1.25,
				inputTokens: 10,
				outputTokens: 20,
				reasoningTokens: 3,
			})
			.run();
	}
}

async function summary(expected: unknown) {
	const dispatch = spyOn(pool, "runReadTask");
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/dashboard/summary");
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual(expected);
	expect(dispatch).toHaveBeenCalledTimes(11);
	for (const [, params, options] of dispatch.mock.calls) {
		expect(params.kind).toBe("selectRows");
		if (params.kind === "selectRows")
			expect(params.maxRows).toBe(params.sql.includes("limit") ? 50 : 1);
		expect(options?.diagnosticSource).toBe("dashboard.summary");
		expect(options?.signal).toBeInstanceOf(AbortSignal);
	}
	expect(pool.getDbWorkerPoolStats().workers).toBeGreaterThan(0);
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
}

test("empty database defaults are returned by real worker reads", async () => {
	await summary(empty);
});

test("seeded aggregates preserve user ACLs and own daily usage", async () => {
	seed();
	await summary({
		...empty,
		activeProjectCount: 1,
		totalProjectCount: 2,
		workingNarratorCount: 1,
		waitingNarratorCount: 1,
		runningTerminalCount: 1,
		runningContainerCount: 1,
		enabledScheduledTaskCount: 1,
		todayCostUsd: 1.25,
		todayTokens: { input: 10, output: 20, reasoning: 3, total: 33 },
		attention: { permissionCount: 1, failedNarratorCount: 1 },
	});
	expect(permissions).toHaveBeenCalledWith("wait");
});

test("admin scope includes private resources without changing daily usage scope", async () => {
	seed();
	role = "admin";
	await summary({
		...empty,
		activeProjectCount: 2,
		totalProjectCount: 3,
		workingNarratorCount: 1,
		waitingNarratorCount: 2,
		runningTerminalCount: 1,
		runningContainerCount: 1,
		enabledScheduledTaskCount: 1,
		todayCostUsd: 1.25,
		todayTokens: { input: 10, output: 20, reasoning: 3, total: 33 },
		attention: { permissionCount: 2, failedNarratorCount: 2 },
	});
});

test("waiting narrator IDs stay capped at fifty while the count remains exact", async () => {
	seed();
	for (let i = 0; i < 55; i++) {
		db.insert(schema.narrators)
			.values({
				id: `waiting-${i}`,
				status: "waiting",
				ownerUserId: "alice",
				visibility: "private",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	await summary({
		...empty,
		activeProjectCount: 1,
		totalProjectCount: 2,
		workingNarratorCount: 1,
		waitingNarratorCount: 56,
		runningTerminalCount: 1,
		runningContainerCount: 1,
		enabledScheduledTaskCount: 1,
		todayCostUsd: 1.25,
		todayTokens: { input: 10, output: 20, reasoning: 3, total: 33 },
		attention: { permissionCount: 50, failedNarratorCount: 1 },
	});
	expect(permissions).toHaveBeenCalledTimes(50);
});

test.each([
	["unavailable", new pool.WorkersUnavailableError("disabled"), 503],
	["queue full", new pool.DbReadTaskOverloadedError(), 503],
	["timeout", new pool.DbReadTaskTimeoutError("timeout"), 503],
	["crash", new pool.DbReadTaskExecutionError("worker exited"), 500],
] as const)("%s is an error, never inline success or unauthorized", async (_name, error, status) => {
	spyOn(pool, "runReadTask").mockRejectedValue(error);
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/dashboard/summary");
	expect(response.status).toBe(status);
	expect(await response.json()).toHaveProperty("error");
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});

test("disabled workers fail through the real pool without main connection execution", async () => {
	process.env.NARRAFORK_DB_WORKER = "off";
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/dashboard/summary");
	expect(response.status).toBe(503);
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});

test("request abort reaches the real pool and never executes inline", async () => {
	const controller = new AbortController();
	controller.abort();
	const prepare = spyOn(sqlite, "prepare");
	const query = spyOn(sqlite, "query");
	const response = await app.request("/api/dashboard/summary", { signal: controller.signal });
	expect(response.status).toBe(500);
	expect(prepare).not.toHaveBeenCalled();
	expect(query).not.toHaveBeenCalled();
});
