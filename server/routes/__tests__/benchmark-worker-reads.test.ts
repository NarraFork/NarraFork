import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { cleanDb, getTestDb } from "../../../tests/setup";
import * as schema from "../../db/schema";
import { buildAppErrorResponse } from "../../lib/app-error-response";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	setDbWorkerSpecifiersForTest,
} from "../../lib/db-worker/pool";
import {
	BENCHMARK_CHUNK_BYTES,
	BENCHMARK_MAX_RESPONSE_BYTES,
	BENCHMARK_MAX_ROWS,
	BENCHMARK_MAX_STREAMS,
	MAX_TASKS_PER_SUITE,
} from "../../services/benchmark-limits";
import {
	createBenchmarkReadStream,
	readSqliteBenchmark,
} from "../../services/benchmark-suite-stream";

const home = mkdtempSync(join(tmpdir(), "nf-benchmark-test-"));
const path = join(home, "fixture.db");
const memory = getTestDb();
writeFileSync(path, memory.sqlite.serialize());
memory.sqlite.close();
const sqlite = new Database(path);
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = OFF");
const db = drizzle({ client: sqlite, schema });
const sqliteFixture = {
	db,
	sqlite,
	activeDatabaseBackend: "sqlite",
	postgresRuntime: null,
};
mock.module("../../db", () => sqliteFixture);
mock.module("../../services/narrator-service", () => ({ narratorService: {} }));
mock.module("../../services/narrator-session", () => ({
	interruptNarrator: mock(),
	sendMessage: mock(),
}));
const { benchmarkRoutes } = await import("../benchmarks");
const app = new Hono();
let role: "user" | "admin" = "admin";
app.use("*", async (c, next) => {
	c.set("user", { sub: "fixture", sid: "fixture-session", role, iat: 0, exp: 0 });
	await next();
});
app.route("/benchmarks", benchmarkRoutes);
app.onError((err, c) => buildAppErrorResponse(err, c) ?? c.json({ error: "Internal error" }, 500));

const previous = process.env.NARRAFORK_DB_WORKER;
beforeEach(async () => {
	delete process.env.NARRAFORK_DB_WORKER;
	await resetDbWorkerPoolForTest();
	cleanDb(sqlite);
	role = "admin";
});
afterEach(async () => {
	await resetDbWorkerPoolForTest();
});
afterAll(() => {
	if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previous;
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

const createdAt = "2026-01-01T00:00:00.000Z";
const tasks = [{ id: "task", name: "fixture", prompt: "汉🚀".repeat(BENCHMARK_CHUNK_BYTES) }];
function insertSuite(id: string, tasksJson: unknown) {
	return db
		.insert(schema.benchmarkSuites)
		.values({ id, name: id, tasksJson, createdAt })
		.returning()
		.get();
}

test("admin receives a backpressured JSON array from one worker snapshot across WAL edits", async () => {
	const first = insertSuite("a", tasks);
	const second = insertSuite("b", null);
	role = "user";
	expect((await app.request("/benchmarks/suites")).status).toBe(403);
	expect(getDbWorkerPoolStats().workers).toBe(0);
	role = "admin";
	const response = await app.request("/benchmarks/suites");
	expect(response.status).toBe(200);
	expect(response.headers.get("Content-Type")).toContain("application/json");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing response body");
	const start = await reader.read();
	expect(start.value?.length).toBe(BENCHMARK_CHUNK_BYTES);
	expect(getDbWorkerPoolStats().busy).toBe(0);
	sqlite.run("UPDATE benchmark_suites SET name = 'changed' WHERE id = 'b'");
	sqlite.run("DELETE FROM benchmark_suites WHERE id = 'a'");
	insertSuite("c", []);
	const decoder = new TextDecoder();
	let json = decoder.decode(start.value, { stream: true });
	for (let part = await reader.read(); !part.done; part = await reader.read()) {
		expect(part.value.length).toBeLessThanOrEqual(BENCHMARK_CHUNK_BYTES);
		json += decoder.decode(part.value, { stream: true });
	}
	expect(JSON.parse(json + decoder.decode())).toEqual([first, second]);
	expect(await (await app.request("/benchmarks/suites")).json()).toEqual([
		{ ...second, name: "changed" },
		expect.objectContaining({ id: "c" }),
	]);
	expect((await app.request("/benchmarks/suites/a")).status).toBe(404);
});

test("run and result contracts are preserved; summary does not read evaluator output", async () => {
	insertSuite("suite", []);
	const run = db
		.insert(schema.benchmarkRuns)
		.values({
			id: "r",
			name: "example",
			suiteId: "suite",
			model: "fixture",
			config: { settings: [true] },
			createdAt,
		})
		.returning()
		.get();
	const result = db
		.insert(schema.benchmarkTaskResults)
		.values({
			id: "t",
			runId: "r",
			taskId: "task",
			taskName: "fixture",
			status: "passed",
			score: 1,
			output: "complete",
			metadata: { nested: [false] },
			tokensIn: 7,
			createdAt,
		})
		.returning()
		.get();
	expect(await (await app.request("/benchmarks/runs?suiteId=suite")).json()).toEqual([run]);
	expect(await (await app.request("/benchmarks/runs/r")).json()).toEqual(run);
	expect(await (await app.request("/benchmarks/runs/r/results")).json()).toEqual([result]);
	sqlite.run("UPDATE benchmark_task_results SET metadata = 'invalid JSON'");
	expect((await app.request("/benchmarks/runs/r/results")).status).toBe(503);
	expect(await (await app.request("/benchmarks/runs/r/summary")).json()).toMatchObject({
		runId: "r",
		suiteName: "suite",
		passed: 1,
		avgScore: 1,
		totalTokensIn: 7,
	});
});

test("route rejects producer, row and byte overflow rather than returning a partial list", async () => {
	const body = {
		name: "oversize",
		tasks: Array.from({ length: MAX_TASKS_PER_SUITE + 1 }, (_, i) => ({
			id: `task-${i}`,
			name: "fixture",
			prompt: "ok",
		})),
	};
	const post = (payload: unknown) =>
		app.request("/benchmarks/suites", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	expect((await post(body)).status).toBe(400);
	expect(await (await app.request("/benchmarks/suites")).json()).toEqual([]);
	sqlite.run(
		"WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i <= ?) INSERT INTO benchmark_suites(id, name, created_at) SELECT 'suite-' || i, 'fixture', 'date' FROM n",
		[BENCHMARK_MAX_ROWS],
	);
	expect((await app.request("/benchmarks/suites")).status).toBe(413);
	sqlite.run("DELETE FROM benchmark_suites");
	sqlite.run(
		"INSERT INTO benchmark_suites(id, name, tasks_json, created_at) VALUES ('huge', 'fixture', zeroblob(?), 'date')",
		[BENCHMARK_MAX_RESPONSE_BYTES + 1],
	);
	expect((await app.request("/benchmarks/suites/huge")).status).toBe(413);
	expect((await app.request("/benchmarks/suites")).status).toBe(413);
});

test("narrator metrics retain token accounting and the last nonempty assistant answer", async () => {
	db.insert(schema.narrators).values({ id: "n", createdAt, updatedAt: createdAt }).run();
	for (const [id, role, contentText] of [
		["a", "assistant", "initial"],
		["b", "assistant", "full answer"],
		["c", "assistant", ""],
		["d", "user", "not an answer"],
	] as const) {
		db.insert(schema.narratorMessages)
			.values({
				id,
				narratorId: "n",
				role,
				contentText,
				contentJson: [],
				tokensIn: 2,
				outputTokens: 3,
				reasoningTokens: 4,
				costUsd: 0.0123456,
				createdAt: createdAt + id,
			})
			.run();
	}
	db.insert(schema.narratorToolCalls)
		.values({
			id: "tool",
			narratorId: "n",
			messageId: "b",
			toolUseId: "tool",
			toolName: "fixture",
			createdAt,
		})
		.run();
	expect(await readSqliteBenchmark(sqlite, { type: "narratorMetrics", id: "n" })).toEqual({
		tokensIn: 8,
		tokensOut: 28,
		costUsd: 0.049382,
		toolCallCount: 1,
		messageCount: 4,
		lastAssistantText: "full answer",
	});
});

test("PostgreSQL read rejects escaped JSON that exceeds the HTTP byte budget", async () => {
	const row = { id: "pg-suite", description: "small\nvalue" };
	const unsafe = mock(async () => [{ payload: JSON.stringify(row) }]);
	mock.module("../../db", () => ({
		...sqliteFixture,
		activeDatabaseBackend: "postgres",
		postgresRuntime: { executor: { unsafe } },
	}));
	try {
		expect(await (await app.request("/benchmarks/suites")).json()).toEqual([row]);
		const controlCharacter = String.fromCharCode(1);
		// Each source byte becomes six JSON bytes, so the raw SQL check admits this row.
		row.description = controlCharacter.repeat(Math.floor(BENCHMARK_MAX_RESPONSE_BYTES / 6) + 1);
		expect(Buffer.byteLength(row.description)).toBeLessThan(BENCHMARK_MAX_RESPONSE_BYTES);
		const response = await app.request("/benchmarks/suites");
		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "Benchmark response exceeds its budget" });
		expect(unsafe).toHaveBeenCalledTimes(2);
		expect(getDbWorkerPoolStats().workers).toBe(0);
	} finally {
		mock.module("../../db", () => sqliteFixture);
	}
});

test("abort, cancel, and idle timeout release staged streams without fallback", async () => {
	insertSuite("a", tasks);
	const abort = new AbortController();
	const response = await app.request("/benchmarks/suites", { signal: abort.signal });
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Missing response body");
	expect((await reader.read()).done).toBe(false);
	abort.abort(new Error("cancel benchmark request"));
	const reason = await reader.read().then(
		() => null,
		(error: unknown) => error,
	);
	expect(reason).toMatchObject({ message: "cancel benchmark request" });

	const streams = [];
	for (let i = 0; i < BENCHMARK_MAX_STREAMS; i++) {
		const stream = await createBenchmarkReadStream(sqlite, { type: "suites" });
		if (!stream) throw new Error("Missing list stream");
		streams.push(stream);
	}
	expect((await app.request("/benchmarks/suites")).status).toBe(413);
	await Promise.all(streams.map((stream) => stream.cancel()));
	const timed = await createBenchmarkReadStream(sqlite, { type: "suites" }, undefined, 750);
	if (!timed) throw new Error("Missing list stream");
	const timedReader = timed.getReader();
	await Bun.sleep(800);
	const timeout = await timedReader.read().then(
		() => null,
		(error: unknown) => error,
	);
	expect(timeout).toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
	expect(await (await app.request("/benchmarks/suites")).json()).toHaveLength(1);
});

test("disabled, unavailable connection and worker query failure never run inline", async () => {
	insertSuite("a", tasks);
	process.env.NARRAFORK_DB_WORKER = "off";
	expect((await app.request("/benchmarks/suites")).status).toBe(503);
	expect((await app.request("/benchmarks/suites/a")).status).toBe(503);
	expect(getDbWorkerPoolStats().workers).toBe(0);
	delete process.env.NARRAFORK_DB_WORKER;
	setDbWorkerSpecifiersForTest([join(home, "missing-worker.ts")]);
	expect((await app.request("/benchmarks/suites")).status).toBe(503);
	expect(getDbWorkerPoolStats().workers).toBe(0);
	await resetDbWorkerPoolForTest();
	const inMemory = new Database(":memory:");
	try {
		expect(() => readSqliteBenchmark(inMemory, { type: "suites" })).toThrow(
			"unsupported_sqlite_connection",
		);
	} finally {
		inMemory.close();
	}
	sqlite.run("ALTER TABLE benchmark_suites RENAME TO fixture_suites");
	try {
		expect((await app.request("/benchmarks/suites")).status).toBe(503);
	} finally {
		sqlite.run("ALTER TABLE fixture_suites RENAME TO benchmark_suites");
	}
	expect(await (await app.request("/benchmarks/suites")).json()).toHaveLength(1);
});
