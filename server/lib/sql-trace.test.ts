import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	configureSqlTraceForTest,
	currentSqlTraceSpan,
	flushSqlTraceSync,
	instrumentSqliteConnection,
	normalizeSql,
	runInSqlTraceSpan,
	startSqlTraceSpan,
	withSqlTraceSpan,
} from "./sql-trace";

let dir: string;

function readRecords(): Array<Record<string, unknown>> {
	flushSqlTraceSync();
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ndjson"))
		.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function openDb(): Database {
	const db = instrumentSqliteConnection(new Database(":memory:"));
	db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
	return db;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nf-sql-trace-"));
	configureSqlTraceForTest({ mode: "summary", dir });
});

afterEach(() => {
	configureSqlTraceForTest({ mode: "off", dir });
	rmSync(dir, { recursive: true, force: true });
});

describe("normalizeSql", () => {
	test("strips literals and collapses value lists", () => {
		expect(normalizeSql("SELECT * FROM t WHERE id = 42 AND name = 'x''y'")).toBe(
			"SELECT * FROM t WHERE id = ? AND name = ?",
		);
		expect(normalizeSql("select * from t where id in (?, ?, ?)")).toBe(
			"select * from t where id in (?, …)",
		);
		expect(normalizeSql("insert into t values (?1, ?2), (?3, ?4)")).toBe(
			"insert into t values (?, …), …",
		);
	});
});

describe("instrumentSqliteConnection", () => {
	test("is a no-op when tracing is off", () => {
		configureSqlTraceForTest({ mode: "off", dir });
		const db = new Database(":memory:");
		const prepare = db.prepare;
		expect(instrumentSqliteConnection(db)).toBe(db);
		expect(db.prepare).toBe(prepare);
		expect(readdirSync(dir)).toEqual([]);
	});

	test("attributes statements to the active span with per-fingerprint aggregates", async () => {
		// Reproduce the former n1 assertion's collision with a valid random span ID.
		const random = spyOn(Math, "random").mockReturnValue(23 / 36);
		try {
			configureSqlTraceForTest({ mode: "summary", dir });
		} finally {
			random.mockRestore();
		}
		const boundValues = Array.from({ length: 3 }, (_, i) => `private-bound-value:${i}:do-not-log`);
		const db = openDb();
		await withSqlTraceSpan("http", "GET /api/x", { path: "/api/x" }, async () => {
			for (const value of boundValues) db.query("INSERT INTO t (name) VALUES (?)").run(value);
			await Promise.resolve();
			expect(db.query("SELECT * FROM t").all()).toHaveLength(3);
			db.prepare("SELECT name FROM t WHERE id = ?").get(1);
		});
		const records = readRecords();
		const span = records.find((r) => r.t === "span" && r.label === "GET /api/x");
		expect(span).toBeDefined();
		expect(span?.end).toBe(true);
		expect(span?.n).toBe(5);
		const stmts = span?.stmts as Array<{ h: string; n: number; rows: number }>;
		const catalog = new Map(
			records.filter((r) => r.t === "stmt").map((r) => [r.h as string, r.sql as string]),
		);
		const insert = stmts.find((s) => catalog.get(s.h)?.startsWith("INSERT"));
		expect(insert?.n).toBe(3);
		expect(insert?.rows).toBe(3);
		const select = stmts.find((s) => catalog.get(s.h) === "SELECT * FROM t");
		expect(select?.rows).toBe(3);
		// Legitimate span IDs must not be mistaken for leaked bound parameters.
		expect(records.some((r) => r.t === "span" && r.id === "n1")).toBe(true);
		const output = JSON.stringify(records);
		for (const value of boundValues) expect(output).not.toContain(value);
	});

	test("child spans carry their parent id and their own SQL", async () => {
		const db = openDb();
		await withSqlTraceSpan("agent", "agent run", undefined, async () => {
			db.query("SELECT 1").get();
			await withSqlTraceSpan("tool", "tool Read", undefined, async () => {
				db.query("SELECT 2").get();
			});
		});
		const spans = readRecords().filter((r) => r.t === "span");
		const agent = spans.find((r) => r.kind === "agent");
		const tool = spans.find((r) => r.kind === "tool");
		expect(tool?.parent).toBe(agent?.id);
		expect(agent?.n).toBe(1);
		expect(tool?.n).toBe(1);
	});

	test("SQL outside any span lands in a background span labelled by call site", () => {
		const db = openDb();
		db.query("SELECT count(*) FROM t").get();
		const bg = readRecords().find((r) => r.t === "span" && r.kind === "bg");
		expect(bg).toBeDefined();
		expect(String(bg?.label)).toContain("sql-trace.test.ts");
	});

	test("falls back to the target table when the app frame is lost in a continuation", async () => {
		const db = openDb();
		const t = sqliteTable("t", { id: integer("id").primaryKey(), name: text("name") });
		const orm = drizzle({ client: db });
		// Awaiting an ORM query runs it in a promise continuation whose stack has no app frame.
		await orm.select().from(t);
		const bg = readRecords().filter((r) => r.t === "span" && r.kind === "bg");
		expect(bg.map((r) => r.label)).toContain("async t");
	});

	test("records slow statements individually and full mode records every call", () => {
		configureSqlTraceForTest({ mode: "full", dir });
		const db = openDb();
		const span = startSqlTraceSpan("job", "job");
		expect(span).not.toBeNull();
		runInSqlTraceSpan(span, () => db.query("SELECT 1").get());
		span?.end();
		const sql = readRecords().filter((r) => r.t === "sql");
		expect(sql.length).toBeGreaterThanOrEqual(2);
		expect(sql.some((r) => r.span === span?.id && r.op === "get")).toBe(true);
	});

	test("iterate is timed across the whole iteration", () => {
		const db = openDb();
		db.run("INSERT INTO t (name) VALUES ('a'), ('b')");
		withSqlTraceSpan("job", "iter", undefined, () => {
			const rows = [...db.query("SELECT * FROM t").iterate()];
			expect(rows).toHaveLength(2);
		});
		const span = readRecords().find((r) => r.t === "span" && r.label === "iter");
		expect((span?.stmts as Array<{ rows: number }>)[0]?.rows).toBe(2);
	});

	test("transactions are counted once at the outermost level", () => {
		const db = openDb();
		const inner = db.transaction(() => db.query("INSERT INTO t (name) VALUES ('x')").run());
		const outer = db.transaction(() => {
			inner();
			inner();
		});
		withSqlTraceSpan("job", "tx", undefined, () => outer.immediate());
		const span = readRecords().find((r) => r.t === "span" && r.label === "tx");
		expect(span?.txN).toBe(1);
		expect(db.query("SELECT count(*) AS c FROM t").get()).toEqual({ c: 2 });
	});

	test("drizzle queries are traced through the instrumented client", async () => {
		const db = openDb();
		const t = sqliteTable("t", { id: integer("id").primaryKey(), name: text("name") });
		const orm = drizzle({ client: db });
		withSqlTraceSpan("http", "drizzle", undefined, () => {
			orm.insert(t).values({ name: "a" }).run();
			orm.transaction((tx) => {
				tx.insert(t).values({ name: "b" }).run();
			});
			expect(orm.select().from(t).all()).toHaveLength(2);
		});
		const span = readRecords().find((r) => r.t === "span" && r.label === "drizzle");
		expect(span?.n).toBeGreaterThanOrEqual(3);
		expect(span?.txN).toBe(1);
	});

	test("errors propagate and are still timed", () => {
		const db = openDb();
		expect(() =>
			withSqlTraceSpan("job", "err", undefined, () => db.query("SELECT * FROM missing").all()),
		).toThrow();
		const span = readRecords().find((r) => r.t === "span" && r.label === "err");
		expect(span?.a).toEqual({ error: true });
	});

	test("SQL running after a span ended is emitted as a late record", async () => {
		const db = openDb();
		let resume: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let done: Promise<void> = Promise.resolve();
		withSqlTraceSpan("ws", "late", undefined, () => {
			done = gate.then(() => {
				expect(currentSqlTraceSpan()?.label).toBe("late");
				db.query("SELECT 1").get();
			});
		});
		resume();
		await done;
		const spans = readRecords().filter((r) => r.t === "span" && r.label === "late");
		expect(spans.some((r) => r.end === true)).toBe(true);
		expect(spans.some((r) => r.late === true && r.n === 1)).toBe(true);
	});
});
