import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePg } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../tests/setup";
import type { db as appDb } from "../db";
import * as relations from "../db/relations";
import * as schema from "../db/schema";
import { buildAppErrorResponse } from "../lib/app-error-response";
import * as pool from "../lib/db-worker/pool";
import { SELECT_ROWS_MAX_ROWS } from "../lib/db-worker/protocol";
import { decodeExecutionLogCursor } from "../lib/execution-log-cursor";
import { createExecutionLogRoutes } from "../routes/execution-log";
import { type ExecutionLogFilters, ExecutionLogService } from "./execution-log-service";

const home = mkdtempSync(join(tmpdir(), "execution-log-workers-"));
const file = join(home, "fixture.db");
const memory = getTestDb();
writeFileSync(file, memory.sqlite.serialize());
const sqlite = new Database(file);
sqlite.run("PRAGMA journal_mode = WAL");
const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const service = new ExecutionLogService(db, { payloadSearchWindowRows: 2 });
const inline = new ExecutionLogService(memory.db, { payloadSearchWindowRows: 2 });
const app = new Hono();
app.route(
	"/execution-log",
	createExecutionLogRoutes({
		service,
		requireAuth: async (_c, next) => {
			await next();
		},
		requireAdmin: async (_c, next) => {
			await next();
		},
	}),
);
app.onError(
	(error, c) => buildAppErrorResponse(error, c) ?? c.json({ error: "Internal error" }, 500),
);
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	await pool.resetDbWorkerPoolForTest();
	cleanDb(sqlite);
	cleanDb(memory.sqlite);
});
afterEach(async () => {
	mock.restore();
	await pool.resetDbWorkerPoolForTest();
});
afterAll(() => {
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
	sqlite.close();
	memory.sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

const time = "2026-10-01T00:00:00.000Z";
function seed(database: typeof db) {
	database
		.insert(schema.narrators)
		.values({
			id: "n",
			title: "Narrator",
			createdAt: time,
			updatedAt: time,
		})
		.run();
	database
		.insert(schema.narratorMessages)
		.values({
			id: "m",
			narratorId: "n",
			role: "assistant",
			contentJson: [],
			createdAt: time,
		})
		.run();
	for (let i = 0; i < 6; i++) {
		database
			.insert(schema.narratorToolCalls)
			.values({
				id: `call-${i}`,
				narratorId: "n",
				messageId: "m",
				toolUseId: `use-${i}`,
				toolName: i % 2 ? "Bash" : "RetiredTool",
				provider: i === 5 ? "  " : i % 2 ? "codex" : null,
				status: i % 2 ? "fail" : "success",
				errorMessage: i % 2 ? "failure" : null,
				isBackground: i % 2 === 0,
				inputJson: { description: "test command", command: "echo hello" },
				outputJson: { text: i % 2 ? "needle" : "other" },
				model: "test-model",
				createdAt: time,
				executionStartedAt: new Date(Date.parse(time) + Math.floor(i / 2) * 1000).toISOString(),
			})
			.run();
	}
}
function seedBoth() {
	seed(db);
	seed(memory.db);
}

function observeMainConnection() {
	return { prepare: spyOn(sqlite, "prepare"), query: spyOn(sqlite, "query") };
}
function expectOffThread(observed: ReturnType<typeof observeMainConnection>) {
	expect(observed.prepare).not.toHaveBeenCalled();
	expect(observed.query).not.toHaveBeenCalled();
}

test.each([
	false,
	true,
])("facets match inline results with seeded=%s and dispatch the SQL subquery", async (seeded) => {
	if (seeded) seedBoth();
	const expected = await inline.listFacets();
	const dispatch = spyOn(pool, "runReadTask");
	const observed = observeMainConnection();
	const response = await app.request("/execution-log/facets");
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(JSON.stringify(expected));
	expect(dispatch).toHaveBeenCalledTimes(1);
	const [, task, options] = dispatch.mock.calls[0];
	expect(task.kind).toBe("selectRows");
	if (task.kind === "selectRows") {
		expect(task.sql).toContain("AS recent");
		expect(task.sql).toContain("group by");
		expect(task.params).toContain(20_000);
		expect(task.maxRows).toBe(SELECT_ROWS_MAX_ROWS);
	}
	expect(options?.diagnosticSource).toBe("execution-log.facets");
	expect(options?.signal).toBeInstanceOf(AbortSignal);
	expect(pool.getDbWorkerPoolStats().workers).toBeGreaterThan(0);
	expectOffThread(observed);
});

test.each([
	{},
	{ onlyErrors: true },
	{ toolName: "Bash" },
	{ model: "test" },
	{ q: "needle", searchPayload: true },
] satisfies ExecutionLogFilters[])("list pagination and optional payload window match inline results for %j", async (filters) => {
	seedBoth();
	let cursor: NonNullable<ReturnType<typeof decodeExecutionLogCursor>> | undefined;
	for (let i = 0; i < 4; i++) {
		const expected = await inline.listCursor(filters, 2, cursor);
		const dispatch = spyOn(pool, "runReadTask");
		const observed = observeMainConnection();
		const controller = new AbortController();
		try {
			expect(await service.listCursor(filters, 2, cursor, { signal: controller.signal })).toEqual(
				expected,
			);
			expect(dispatch).toHaveBeenCalledTimes("q" in filters ? 2 : 1);
			for (const [, task, options] of dispatch.mock.calls) {
				expect(options?.signal).toBe(controller.signal);
				expect(task.kind).toBe("selectRows");
				if (task.kind === "selectRows")
					expect(task.maxRows).toBe(options?.diagnosticSource === "execution-log.list" ? 3 : 1);
			}
			expectOffThread(observed);
		} finally {
			dispatch.mockRestore();
			observed.prepare.mockRestore();
			observed.query.mockRestore();
		}
		if (!expected.nextCursor) break;
		cursor = decodeExecutionLogCursor(expected.nextCursor) ?? undefined;
	}
});

test("list route forwards the request signal and empty-page defaults", async () => {
	const expected = await inline.listCursor({}, 2);
	const dispatch = spyOn(pool, "runReadTask");
	const observed = observeMainConnection();
	const response = await app.request("/execution-log?limit=2");
	expect(response.status).toBe(200);
	expect(await response.text()).toBe(JSON.stringify(expected));
	expect(dispatch.mock.calls[0][2]?.signal).toBeInstanceOf(AbortSignal);
	expectOffThread(observed);
});

test("the 20k input window remains intact and excessive distinct facets fail instead of truncating", async () => {
	const client = new Database(join(home, "facet-window.db"));
	try {
		client.run(
			"CREATE TABLE narrator_tool_calls (id INTEGER PRIMARY KEY, tool_name TEXT, provider TEXT, started_at TEXT)",
		);
		client.run("CREATE INDEX facet_started_at ON narrator_tool_calls (started_at, id)");
		client.run(`WITH RECURSIVE seq(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM seq WHERE x<20000)
			INSERT INTO narrator_tool_calls (id, tool_name, provider, started_at)
			SELECT x, CASE WHEN x=0 THEN 'OutsideWindow' ELSE 'InsideWindow' END,
				'window-provider', '2026-11-01T00:00:00.000Z' FROM seq`);
		const facetsService = new ExecutionLogService(
			drizzle({
				client,
				schema: { ...schema, ...relations },
			}),
		);
		const expected = await facetsService.listFacets();
		expect(expected.toolNames).toContain("InsideWindow");
		expect(expected.toolNames).not.toContain("OutsideWindow");
		client.run("UPDATE narrator_tool_calls SET provider = 'Unique-' || id");
		const dispatch = spyOn(pool, "runReadTask");
		const failure = await facetsService.listFacets().then(
			() => null,
			(error: unknown) => error,
		);
		expect(String(failure)).toContain("row budget");
		expect(dispatch).toHaveBeenCalledTimes(1);
		dispatch.mockRestore();
	} finally {
		await pool.resetDbWorkerPoolForTest();
		client.close();
	}
});

test.each([
	["unavailable", new pool.WorkersUnavailableError("disabled"), 503],
	["queue full", new pool.DbReadTaskOverloadedError(), 503],
	["timeout", new pool.DbReadTaskTimeoutError("timeout"), 503],
	["crash", new pool.DbReadTaskExecutionError("exited"), 500],
] as const)("%s propagates for both facet and list routes without inline execution", async (_name, error, status) => {
	spyOn(pool, "runReadTask").mockRejectedValue(error);
	const observed = observeMainConnection();
	for (const path of [
		"/execution-log/facets",
		"/execution-log",
		"/execution-log?q=needle&searchPayload=true",
	]) {
		const response = await app.request(path);
		expect(response.status).toBe(status);
		expect(await response.json()).toHaveProperty("error");
	}
	expectOffThread(observed);
});

test("real disabled workers and pre-aborted requests fail without executing inline", async () => {
	const observed = observeMainConnection();
	for (const path of [
		"/execution-log/facets",
		"/execution-log",
		"/execution-log?q=needle&searchPayload=true",
	]) {
		process.env.NARRAFORK_DB_WORKER = "off";
		expect((await app.request(path)).status).toBe(503);
		delete process.env.NARRAFORK_DB_WORKER;
		const controller = new AbortController();
		controller.abort();
		expect((await app.request(path, { signal: controller.signal })).status).toBe(500);
	}
	expectOffThread(observed);
});

test("PostgreSQL facet builders execute inline without entering the SQLite pool", async () => {
	const execute = mock(async () => ({ rows: [["PGTool", "pg-provider"]] }));
	const pg = drizzlePg(execute);
	const pgService = new ExecutionLogService(pg as unknown as typeof appDb);
	const dispatch = spyOn(pool, "runReadTask");
	process.env.NARRAFORK_DB_WORKER = "off";
	const facets = await pgService.listFacets();
	expect(facets.toolNames).toContain("PGTool");
	expect(facets.providers).toEqual(["pg-provider"]);
	expect(execute).toHaveBeenCalledTimes(1);
	expect(dispatch).not.toHaveBeenCalled();
});
