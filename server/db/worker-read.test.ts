import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq, relations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { PgDialect } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	closeDbWorkerConnections,
	drainDbWorkerPool,
	getDbWorkerPoolStats,
	type ReadTaskCompletion,
	resetDbWorkerPoolForTest,
	resumeDbWorkerPool,
	runEphemeralReadTask,
	runReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../lib/db-worker/pool";
import { streamSelectRows } from "../lib/db-worker/select-rows";
import { AppError } from "../lib/errors";
import {
	type ReadWorkerDiagnosticStats,
	sqlExecutionDiagnostics,
} from "../lib/sql-execution-diagnostics";
import {
	readDbAll,
	readQuery,
	readQueryFirst,
	readSqlRows,
	readSqlValues,
	readTransactionTask,
} from "./worker-read";

const authors = sqliteTable("authors", {
	id: integer().primaryKey(),
	name: text().notNull(),
	enabled: integer({ mode: "boolean" }).notNull(),
	detail: text({ mode: "json" }).$type<{ n: number }>(),
});
const books = sqliteTable("books", {
	id: integer().primaryKey(),
	authorId: integer(),
	title: text(),
});
const authorRelations = relations(authors, ({ many }) => ({ books: many(books) }));
const bookRelations = relations(books, ({ one }) => ({
	author: one(authors, { fields: [books.authorId], references: [authors.id] }),
}));
let directory: string;
let connection: Database;
let database: ReturnType<
	typeof drizzle<{
		authors: typeof authors;
		books: typeof books;
		authorRelations: typeof authorRelations;
		bookRelations: typeof bookRelations;
	}>
>;
let previousHome: string | undefined;

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), "worker-read-fixture-"));
	previousHome = process.env.NARRAFORK_HOME;
	process.env.NARRAFORK_HOME = join(directory, "isolated-home");
	connection = new Database(join(directory, "fixture.sqlite"));
	connection.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE authors(id INTEGER PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,detail TEXT); CREATE TABLE books(id INTEGER PRIMARY KEY, authorId INTEGER,title TEXT);",
	);
	database = drizzle(connection, { schema: { authors, books, authorRelations, bookRelations } });
	database
		.insert(authors)
		.values([
			{ id: 1, name: "Ada", enabled: true, detail: { n: 3 } },
			{ id: 2, name: "Grace", enabled: false, detail: null },
		])
		.run();
	database.insert(books).values({ id: 1, authorId: 1, title: "A" }).run();
});

afterAll(() => {
	shutdownDbWorkerPool();
	connection.close();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(directory, { recursive: true, force: true });
});

test("select timings separate acknowledged consumer waits from active work without changing rows", async () => {
	let clock = 0;
	const timer = spyOn(performance, "now").mockImplementation(() => clock++);
	const params = {
		kind: "selectRowsV1" as const,
		sql: "SELECT id,name FROM authors ORDER BY id",
		params: [],
		mode: "values" as const,
	};
	const consumed: unknown[] = [];
	try {
		const measured = await streamSelectRows(
			connection,
			{ ...params, diagnosticTiming: true },
			new AbortController().signal,
			async (rows) => {
				consumed.push(...rows);
				clock += 200;
			},
		);
		expect(consumed).toEqual([
			[1, "Ada"],
			[2, "Grace"],
		]);
		expect(measured.workerAckWaitMs).toBe(201);
		expect(measured.workerActiveMs).toBe(2);
		const ordinary = await streamSelectRows(
			connection,
			params,
			new AbortController().signal,
			async () => {},
		);
		expect(ordinary).toEqual({ rows: measured.rows, bytes: measured.bytes });
	} finally {
		timer.mockRestore();
	}
});

test("fixed query sites reach IPC diagnostics and measure Drizzle consumption only", async () => {
	let clock = 0;
	const timer = spyOn(performance, "now").mockImplementation(() => clock);
	const records: Array<{ site?: string; stats: ReadWorkerDiagnosticStats }> = [];
	const diagnostic = spyOn(sqlExecutionDiagnostics, "beginReadWorkerDiagnostic").mockImplementation(
		(site) => (stats) => {
			records.push({ site, stats });
		},
	);
	try {
		const result = await readQuery(
			database
				.select({
					name: sql<string>`${authors.name}`.mapWith((value) => {
						clock += 25;
						return value;
					}),
				})
				.from(authors)
				.orderBy(authors.id),
			{ site: "modifications.history.workspace" },
		);
		expect(result).toEqual([{ name: "Ada" }, { name: "Grace" }]);
		expect(records[0]).toMatchObject({
			site: "modifications.history.workspace",
			stats: { consumeMs: 50, queueWaitMs: 0, acquireMs: 0, status: "ok" },
		});
		expect(records[0]?.stats.workerActiveMs).toBeGreaterThanOrEqual(0);
		expect(records[0]?.stats.workerAckWaitMs).toBeGreaterThanOrEqual(0);
		await readSqlRows("SELECT ? AS body", ["private-body"], {
			dbPath: connection.filename,
			site: "/private/path",
		});
		expect(records[1]?.site).toBeUndefined();
		expect(records[1]?.stats).not.toHaveProperty("consumeMs");
		expect(records[1]?.stats).not.toHaveProperty("queueWaitMs");
		expect(JSON.stringify(records)).not.toMatch(/private|SELECT/);
	} finally {
		diagnostic.mockRestore();
		timer.mockRestore();
	}
});

test("capacity waits exclude worker startup acquisition and preserve task results", async () => {
	resetDbWorkerPoolForTest();
	const previous = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	let clock = 0;
	const timer = spyOn(performance, "now").mockImplementation(() => clock);
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let received!: () => void;
	const chunk = new Promise<void>((resolve) => {
		received = resolve;
	});
	const records: ReadTaskCompletion[] = [];
	const params = {
		kind: "selectRowsV1" as const,
		sql: "SELECT 7 AS n",
		params: [],
		mode: "values" as const,
		diagnosticTiming: true as const,
	};
	let first: Promise<unknown> | undefined;
	let second: Promise<unknown> | undefined;
	try {
		first = runReadTask(connection.filename, params, {
			onChunk: async () => {
				received();
				await gate;
			},
			onComplete: (stats) => {
				records.push(stats);
			},
		});
		clock = 40;
		await chunk;
		second = runReadTask(connection.filename, params, {
			onComplete: (stats) => {
				records.push(stats);
			},
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(getDbWorkerPoolStats().queued).toBe(1);
		clock = 140;
		release();
		expect(await first).toMatchObject({ rows: 1, bytes: 8 });
		expect(await second).toMatchObject({ rows: 1, bytes: 8 });
		expect(records[0]).toMatchObject({ acquireMs: 40, queueWaitMs: 0 });
		expect(records[1]).toMatchObject({ acquireMs: 0, queueWaitMs: 100 });
	} finally {
		release();
		await Promise.allSettled([first, second]);
		timer.mockRestore();
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
		else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previous;
		resetDbWorkerPoolForTest();
	}
});

test("unknown database identities fail closed while PostgreSQL retains its async adapter", async () => {
	const original = process.env.NARRAFORK_TEST;
	delete process.env.NARRAFORK_TEST;
	try {
		await expect(readQuery(Promise.resolve([]))).rejects.toThrow("database identity");
		const pgQuery = Object.assign(Promise.resolve([{ id: 7 }]), { dialect: new PgDialect() });
		expect(await readQuery(pgQuery, { dbPath: "must-not-open.sqlite" })).toEqual([{ id: 7 }]);
	} finally {
		if (original === undefined) delete process.env.NARRAFORK_TEST;
		else process.env.NARRAFORK_TEST = original;
	}
});

test("file-backed worker reads selected fields and leaves application home untouched", async () => {
	const result = await readQuery(database.select().from(authors).orderBy(authors.id));
	expect(result).toEqual(database.select().from(authors).orderBy(authors.id).all());
	expect(existsSync(join(directory, "isolated-home"))).toBe(false);
});

test("relation findMany/findFirst preserve nested JSON and undefined", async () => {
	const query = () =>
		database.query.authors.findMany({ with: { books: true }, orderBy: authors.id });
	expect(await readQuery(query())).toEqual(query().sync());
	expect(
		await readQuery(database.query.authors.findFirst({ where: eq(authors.id, 99) })),
	).toBeUndefined();
	expect(await readQueryFirst(database.select().from(authors).where(eq(authors.id, 1)))).toEqual(
		database.select().from(authors).where(eq(authors.id, 1)).get(),
	);
});

test("left join retains duplicate column positions and null nested rows", async () => {
	const query = () =>
		database
			.select()
			.from(authors)
			.leftJoin(books, eq(authors.id, books.authorId))
			.orderBy(authors.id);
	expect(await readQuery(query())).toEqual(query().all());
});

test("raw SQL and SQLWrapper preserve aliases and complete multi-batch results", async () => {
	expect(await readDbAll(database, sql`select name from authors order by id`)).toEqual([
		{ name: "Ada" },
		{ name: "Grace" },
	]);
	const statement =
		"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<600) SELECT x, printf('%01000d',x) AS body FROM n ORDER BY x DESC";
	const rows = await readSqlRows<{ x: number; body: string }>(statement, [], {
		dbPath: connection.filename,
	});
	expect(rows.length).toBe(600);
	expect(rows[0]?.x).toBe(600);
	expect(rows[599]?.x).toBe(1);
	expect(await readSqlValues("SELECT 1 AS x, 2 AS x", [], { dbPath: connection.filename })).toEqual(
		[[1, 2]],
	);
});

test("wide positional selections preserve column order across Bun runtimes", async () => {
	const fields = Array.from({ length: 80 }, (_, index) => `c${index}`);
	connection.exec(`CREATE TABLE wide (${fields.map((field) => `${field} INTEGER`).join(",")})`);
	connection.exec(`INSERT INTO wide VALUES (${fields.map((_, index) => index).join(",")})`);
	const expected = connection.query("SELECT * FROM wide").values();
	expect(await readSqlValues("SELECT * FROM wide", [], { dbPath: connection.filename })).toEqual(
		expected,
	);
	expect(
		await readSqlValues("SELECT 10 AS '10', 2 AS '2', 1 AS '10'", [], {
			dbPath: connection.filename,
		}),
	).toEqual([[10, 2, 1]]);
});

test("worker holds its task until the result consumer acknowledges a batch", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let received!: () => void;
	const first = new Promise<void>((resolve) => {
		received = resolve;
	});
	let batches = 0;
	let completed = false;
	const task = runReadTask(
		connection.filename,
		{
			kind: "selectRowsV1",
			sql: "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<300) SELECT x FROM n",
			params: [],
			mode: "values",
		},
		{
			onChunk: async () => {
				batches++;
				received();
				await gate;
			},
		},
	).then(() => {
		completed = true;
	});
	await first;
	expect(batches).toBe(1);
	expect(completed).toBe(false);
	release();
	await task;
	expect(batches).toBe(3);
});

test("domain bridge forwards chunk consumption and preserves oversized single rows", async () => {
	const large = "x".repeat(300 * 1024);
	const consumed: unknown[] = [];
	const result = await readTransactionTask<{ rows: number }>(
		database,
		{ kind: "selectRowsV1", sql: "SELECT ? AS id, 1 AS cursor", params: [large], mode: "objects" },
		() => {
			throw new Error("unexpected local fallback");
		},
		{
			onChunk: (rows) => {
				consumed.push(...rows);
			},
		},
	);
	expect(result.rows).toBe(1);
	expect(consumed).toEqual([{ id: large, cursor: 1 }]);
	const empty: unknown[] = [];
	await readTransactionTask(
		database,
		{ kind: "selectRowsV1", sql: "SELECT 1 WHERE 0", params: [], mode: "objects" },
		() => null,
		{
			onChunk: (rows) => {
				empty.push(...rows);
			},
		},
	);
	expect(empty).toEqual([]);
});

test("domain chunk consumer failure releases its worker and propagates the original error", async () => {
	const consumerError = new Error("consumer rejected original row");
	let failure: unknown;
	try {
		await readTransactionTask(
			database,
			{ kind: "selectRowsV1", sql: "SELECT 1", params: [], mode: "objects" },
			() => null,
			{
				onChunk: () => {
					throw consumerError;
				},
			},
		);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBe(consumerError);
	await drainDbWorkerPool();
	resumeDbWorkerPool();
	expect(await readSqlValues("SELECT 2", [], { dbPath: connection.filename })).toEqual([[2]]);
});

test("association batches preserve empty pages and stop before permission or pagination boundaries", async () => {
	const chunks: unknown[] = [];
	const first = await readTransactionTask<{ pageCount: number }>(
		database,
		{
			kind: "revertSelectionReadV1",
			action: "associationPages",
			deadlineAt: Date.now() + 5000,
			queries: [
				{ query: "SELECT 1 AS id, 1 AS cursor WHERE 0", params: [], stopOnRows: true },
				{ query: "SELECT 'narrator' AS id, 1 AS cursor", params: [], stopOnRows: true },
				{ query: "SELECT id FROM must_not_read_after_acl", params: [], stopOnRows: false },
			],
		},
		() => {
			throw new Error("unexpected local fallback");
		},
		{
			onChunk: (rows) => {
				chunks.push(...rows);
			},
		},
	);
	expect(first.pageCount).toBe(2);
	expect(chunks).toEqual([{ pageIndex: 1, row: { id: "narrator", cursor: 1 } }]);
	let count = 0;
	const second = await readTransactionTask<{ pageCount: number }>(
		database,
		{
			kind: "revertSelectionReadV1",
			action: "associationPages",
			deadlineAt: Date.now() + 5000,
			queries: [
				{
					query:
						"WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<33) SELECT x AS id,x AS cursor FROM n",
					params: [],
					stopOnRows: false,
				},
				{ query: "SELECT id FROM must_not_read_after_page", params: [], stopOnRows: false },
			],
		},
		() => {
			throw new Error("unexpected local fallback");
		},
		{
			onChunk: (rows) => {
				count += rows.length;
			},
		},
	);
	expect(second.pageCount).toBe(1);
	expect(count).toBe(33);
});

test("cleanup domain tasks return the existing aggregate summaries", async () => {
	expect(
		await runReadTask(connection.filename, {
			kind: "databaseCleanupReadV1",
			action: "sessions",
			narratorIds: [],
			relations: [],
		}),
	).toEqual({ narrators: 0, messages: 0, toolCalls: 0, apiRequests: 0, approxBytes: 0 });
	expect(
		await runReadTask(connection.filename, {
			kind: "databaseCleanupReadV1",
			action: "payloads",
			cutoffIso: "2026-01-01T00:00:00.000Z",
		}),
	).toEqual({ count: 0, approxBytes: 0, oldestAt: null });
});

test("domain read transactions preserve Map results and application errors", async () => {
	const result = await runReadTask<{ parents: Map<string, unknown> }>(connection.filename, {
		kind: "narrator-read-transaction-v1",
		operation: "aggregateScope",
		narratorId: "absent",
		ids: [],
	});
	expect(result.parents).toBeInstanceOf(Map);
	try {
		await runReadTask(connection.filename, {
			kind: "narrator-read-transaction-v1",
			operation: "aggregateScope",
			narratorId: "absent",
			ids: Array.from({ length: 501 }, (_, index) => String(index)),
		});
		throw new Error("expected budget rejection");
	} catch (error) {
		expect(error).toBeInstanceOf(AppError);
		expect((error as AppError).statusCode).toBe(409);
		expect((error as AppError).code).toBe("HISTORY_AGGREGATE_UNAVAILABLE");
	}
});

test("closing readers drains tasks and keeps admission closed until maintenance ends", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let arrived!: () => void;
	const received = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const task = runReadTask(
		connection.filename,
		{ kind: "selectRowsV1", sql: "SELECT 1", params: [], mode: "values" },
		{
			onChunk: async () => {
				arrived();
				await gate;
			},
		},
	);
	await received;
	let closed = false;
	const closing = closeDbWorkerConnections(connection.filename, () => {
		closed = true;
	});
	await expect(readSqlRows("SELECT 2", [], { dbPath: connection.filename })).rejects.toThrow(
		"closing",
	);
	expect(closed).toBe(false);
	release();
	await task;
	await closing;
	expect(closed).toBe(true);
	expect(await readSqlValues("SELECT 3", [], { dbPath: connection.filename })).toEqual([[3]]);
	await drainDbWorkerPool();
	await expect(readSqlRows("SELECT 4", [], { dbPath: connection.filename })).rejects.toThrow(
		"closing",
	);
	resumeDbWorkerPool();
	expect(await readSqlValues("SELECT 5", [], { dbPath: connection.filename })).toEqual([[5]]);
});

test("drain includes ephemeral readers and waits for their acknowledged result", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let arrived!: () => void;
	const received = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	const params = {
		kind: "selectRowsV1" as const,
		sql: "SELECT 1",
		params: [],
		mode: "values" as const,
	};
	const read = runEphemeralReadTask(connection.filename, params, {
		onChunk: async () => {
			arrived();
			await gate;
		},
	});
	await received;
	let drained = false;
	const closing = drainDbWorkerPool().then(() => {
		drained = true;
	});
	await expect(runEphemeralReadTask(connection.filename, params)).rejects.toThrow("closing");
	expect(drained).toBe(false);
	release();
	await read;
	await closing;
	expect(drained).toBe(true);
	resumeDbWorkerPool();
});

test("cancelled readers finish exiting before drain permits replacement", async () => {
	const controller = new AbortController();
	let arrived!: () => void;
	const received = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = runReadTask(
		connection.filename,
		{ kind: "selectRowsV1", sql: "SELECT 1", params: [], mode: "values" },
		{
			signal: controller.signal,
			onChunk: async () => {
				arrived();
				await gate;
			},
		},
	).then(
		() => false,
		(error) => error instanceof Error && error.message.includes("aborted"),
	);
	await received;
	controller.abort();
	expect(await pending).toBe(true);
	await drainDbWorkerPool();
	release();
	resumeDbWorkerPool();
	expect(await readSqlValues("SELECT 2", [], { dbPath: connection.filename })).toEqual([[2]]);
});

test("closing cached readers allows a replacement file to supply the next read", async () => {
	const originalPath = join(directory, "replace.sqlite");
	const replacementPath = join(directory, "replacement.sqlite");
	for (const [path, value] of [
		[originalPath, 1],
		[replacementPath, 2],
	] as const) {
		const db = new Database(path);
		db.exec(`CREATE TABLE marker(value INTEGER); INSERT INTO marker VALUES (${value})`);
		db.close();
	}
	expect(await readSqlValues("SELECT value FROM marker", [], { dbPath: originalPath })).toEqual([
		[1],
	]);
	await closeDbWorkerConnections(originalPath, () => renameSync(replacementPath, originalPath));
	expect(await readSqlValues("SELECT value FROM marker", [], { dbPath: originalPath })).toEqual([
		[2],
	]);
});

test("read connections preserve foreign-key checks and reject unregistered tasks", async () => {
	expect(
		await readSqlValues("SELECT foreign_keys FROM pragma_foreign_keys", [], {
			dbPath: connection.filename,
		}),
	).toEqual([[1]]);
	expect(
		await readSqlValues("SELECT query_only FROM pragma_query_only", [], {
			dbPath: connection.filename,
		}),
	).toEqual([[1]]);
	let failure: unknown;
	try {
		await runReadTask(connection.filename, { kind: "unregistered" } as never);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe("Unknown database read task");
});

test("worker deadline preserves the original DOMException contract", async () => {
	let failure: unknown;
	try {
		await runReadTask(connection.filename, {
			kind: "revertSelectionReadV1",
			action: "verify",
			commitments: [],
			deadlineAt: Date.now() - 1,
		});
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(DOMException);
	expect((failure as DOMException).name).toBe("TimeoutError");
	expect((failure as DOMException).message).toBe("The operation timed out.");
});

test("IPC restores only genuine allowlisted DOMExceptions", async () => {
	await drainDbWorkerPool();
	resumeDbWorkerPool();
	const workerPath = join(directory, "dom-error-worker.ts");
	const protocolPath = new URL("../lib/db-worker/protocol.ts", import.meta.url).href;
	writeFileSync(
		workerPath,
		`import { readWorkerDomExceptionName } from ${JSON.stringify(protocolPath)};
self.onmessage = ({data}) => {
 if(data.type === 'shutdown') { process.exit(0); }
 if(data.type !== 'task') return;
 const name = data.params.params[0];
 const fake = data.params.params[1];
 const error = fake ? Object.assign(new Error('original message'),{name}) : new DOMException('original message',name);
 postMessage({type:'error',requestId:data.requestId,message:error.message,domExceptionName:readWorkerDomExceptionName(error)});
};postMessage({type:'ready'});`,
	);
	setDbWorkerSpecifiersForTest([pathToFileURL(workerPath).href]);
	try {
		for (const name of ["AbortError", "TimeoutError"] as const) {
			for (const fake of [false, true]) {
				let failure: unknown;
				try {
					await runReadTask(connection.filename, {
						kind: "selectRowsV1",
						sql: "SELECT 1",
						params: [name, fake],
						mode: "values",
					});
				} catch (error) {
					failure = error;
				}
				expect(failure instanceof DOMException).toBe(!fake);
				expect((failure as Error).message).toBe("original message");
				expect((failure as Error).name).toBe(fake ? "Error" : name);
			}
		}
	} finally {
		await drainDbWorkerPool();
		resetDbWorkerPoolForTest();
	}
});

test("cancellation and SQL failures reject without a main-thread retry", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		readQuery(database.select().from(authors), { signal: controller.signal }),
	).rejects.toThrow();
	await expect(
		readSqlRows("DELETE FROM authors", [], { dbPath: connection.filename }),
	).rejects.toThrow("SELECT");
	expect(database.select().from(authors).all().length).toBe(2);
});
