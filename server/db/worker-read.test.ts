import { Database } from "bun:sqlite";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { eq, relations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer as pgInteger, pgTable } from "drizzle-orm/pg-core";
import { drizzle as drizzlePg } from "drizzle-orm/pg-proxy";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { DOMAIN_READ_STREAM_CHUNK_BYTES } from "../lib/db-worker/domain-protocol";
import { DbReadError } from "../lib/db-worker/errors";
import {
	drainDbWorkerPool,
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	runTrackedEphemeralReadTask,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../lib/db-worker/pool";
import {
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
} from "../lib/db-worker/protocol";
import { sourceRowsCommitment } from "../lib/db-worker/select-digest-batch";
import { logger } from "../lib/logger";
import {
	consumeReadDomainTask,
	consumeReadSqlValues,
	readDbAll,
	readDomainTask,
	readNativeRows,
	readNativeValues,
	readQuery,
	readQueryFirst,
	readSelectDigestBatch,
} from "./worker-read";
import { adaptReadQuery } from "./worker-read-adapter";

const owners = sqliteTable("owners", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});
const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	ownerId: text("owner_id"),
	meta: text("meta", { mode: "json" }).$type<{ tags: string[] }>(),
	done: integer("done", { mode: "boolean" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

let home: string;
let sqlite: Database;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "narrafork-worker-read-"));
	sqlite = new Database(join(home, "fixture.db"));
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
	sqlite.run(
		"CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT, meta TEXT, done INTEGER NOT NULL, created_at INTEGER NOT NULL)",
	);
	db = drizzle({ client: sqlite });
	db.insert(owners).values({ id: "o1", name: "alice" }).run();
	db.insert(items)
		.values([
			{ id: "i1", ownerId: "o1", meta: { tags: ["a"] }, done: true, createdAt: new Date(1000) },
			{ id: "i2", ownerId: null, meta: null, done: false, createdAt: new Date(2000) },
		])
		.run();
	await resetDbWorkerPoolForTest();
});

let previousWorker: string | undefined;
let previousConcurrency: string | undefined;
beforeEach(async () => {
	previousWorker = process.env.NARRAFORK_DB_WORKER;
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "2";
	await resetDbWorkerPoolForTest();
});
afterEach(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	await resetDbWorkerPoolForTest();
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

function useWorkerFixture(name: string, source: string): void {
	const file = join(home, `${name}.ts`);
	writeFileSync(
		file,
		`import { parentPort } from "node:worker_threads";\nconst self = { onmessage: undefined };\nconst postMessage = (message) => parentPort.postMessage(message);\nparentPort.on("message", data => { if (data.type) self.onmessage?.({data}); });\n${source}`,
	);
	setDbWorkerSpecifiersForTest([pathToFileURL(file).href]);
}

async function waitForBusy(): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (getDbWorkerPoolStats().busy === 0 && Date.now() < deadline) await Bun.sleep(1);
	expect(getDbWorkerPoolStats().busy).toBe(1);
}

/** Real pool failures must never call Drizzle's main-connection execution method. */
async function rejectsOffThread(options: Parameters<typeof readQuery>[1] = {}) {
	const query = db.select().from(owners);
	const execute = spyOn(query, "execute");
	try {
		const error = await readQuery(query, options).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toBeInstanceOf(Error);
		expect(execute).not.toHaveBeenCalled();
	} finally {
		execute.mockRestore();
	}
}

afterAll(async () => {
	await drainDbWorkerPool({ timeoutMs: 20_000 });
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
});

describe("registered domain streaming", () => {
	const input = { narratorId: "n1", messageId: "m1", blockReads: false };
	const content =
		"a".repeat(Math.floor(DOMAIN_READ_STREAM_CHUNK_BYTES / 3) - 1) + "🙂界".repeat(30_000);
	beforeAll(() => {
		sqlite.exec(`
			CREATE TABLE narrator_messages (
				id TEXT PRIMARY KEY, role TEXT, body_revision INTEGER, state_revision INTEGER,
				composer_document TEXT, content_json TEXT
			);
			CREATE TABLE narrator_message_refs (id TEXT, narrator_id TEXT, message_id TEXT);
			INSERT INTO narrator_message_refs VALUES ('r1', 'n1', 'm1');
		`);
		sqlite.run("INSERT INTO narrator_messages VALUES ('m1', 'user', 1, 2, NULL, ?)", [
			JSON.stringify([{ type: "text", text: content }]),
		]);
	});

	test("streams a file-backed payload in order and waits for the consumer ACK", async () => {
		const first = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const parts: Uint8Array[] = [];
		let settled = false;
		const read = consumeReadDomainTask(sqlite, "composerDocument", input, async (bytes) => {
			parts.push(bytes);
			if (parts.length === 1) {
				first.resolve();
				await release.promise;
			}
		}).finally(() => {
			settled = true;
		});
		try {
			await Promise.race([first.promise, read]);
			await Bun.sleep(30);
			expect(parts).toHaveLength(1);
			expect(settled).toBe(false);
		} finally {
			release.resolve();
		}
		const result = await read;
		const payload = Buffer.concat(parts);
		expect(parts.length).toBeGreaterThan(1);
		expect(parts.every((bytes) => bytes.byteLength <= DOMAIN_READ_STREAM_CHUNK_BYTES)).toBe(true);
		expect(JSON.parse(payload.toString()).text).toBe(content);
		expect(result).toEqual({
			metadata: { kind: "found", refId: "r1", bodyRevision: 1, stateRevision: 2 },
			bytes: payload.byteLength,
			chunks: parts.length,
		});
		expect(getDbWorkerPoolStats().tracked).toBe(0);
	});

	test.each([
		"cancel",
		"consumer",
		"timeout",
	])("%s releases a stream without reading on the caller connection", async (failure) => {
		const controller = new AbortController();
		const gate = Promise.withResolvers<void>();
		const query = spyOn(sqlite, "query");
		let frames = 0;
		try {
			const error = await consumeReadDomainTask(
				sqlite,
				"composerDocument",
				input,
				() => {
					frames++;
					if (failure === "consumer") throw new Error("injected consumer failure");
					if (failure === "cancel") controller.abort();
					return gate.promise;
				},
				{ signal: controller.signal, timeoutMs: failure === "timeout" ? 1_000 : 10_000 },
			).then(
				() => null,
				(error: unknown) => error,
			);
			expect(error).toMatchObject({
				code:
					failure === "cancel"
						? "DB_READ_ABORTED"
						: failure === "consumer"
							? "DB_READ_CONSUMER_FAILED"
							: "DB_READ_TASK_TIMEOUT",
			});
			expect(frames).toBe(1);
			expect(query).not.toHaveBeenCalled();
		} finally {
			gate.resolve();
			query.mockRestore();
		}
	});

	test("rejects terminal counts that do not match the ACKed frames", async () => {
		useWorkerFixture(
			"mismatched-stream-counts",
			`
			self.onmessage = ({ data }) => {
				if (data.type === "task") postMessage({
					type: "result", requestId: data.requestId, durationMs: 0,
					result: { metadata: { kind: "missing" }, bytes: 1, chunks: 1 },
				});
			};
			postMessage({ type: "ready" });
		`,
		);
		const error = await consumeReadDomainTask(sqlite, "composerDocument", input, () => {}).then(
			() => null,
			(error: unknown) => error,
		);
		expect(error).toMatchObject({ code: "DB_READ_PROTOCOL" });
	});
});

describe("strict and extended read bridge", () => {
	const strict = { executionPolicy: "worker-required" as const };
	test("relational many/first/empty preserve Drizzle nested mapping", async () => {
		const ownersRelations = relations(owners, ({ many }) => ({ items: many(items) }));
		const itemsRelations = relations(items, ({ one }) => ({
			owner: one(owners, { fields: [items.ownerId], references: [owners.id] }),
		}));
		const relational = drizzle(sqlite, {
			schema: { owners, items, ownersRelations, itemsRelations },
		});
		const query = () => relational.query.owners.findMany({ with: { items: true } });
		const expected = await query();
		const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
			throw new Error("main connection prepared SQL");
		});
		try {
			expect(await readQuery(query(), strict)).toEqual(expected);
			expect(
				await readQuery(relational.query.owners.findFirst({ with: { items: true } }), strict),
			).toEqual(expected[0]);
			expect(
				await readQuery(
					relational.query.owners.findFirst({ where: eq(owners.id, "missing") }),
					strict,
				),
			).toBeUndefined();
		} finally {
			prepare.mockRestore();
		}
	});
	test("raw/native, wrapper and first queries execute off the owning connection", async () => {
		const prepare = spyOn(sqlite, "prepare").mockImplementation(() => {
			throw new Error("main prepare");
		});
		try {
			expect(
				await readNativeValues(
					sqlite,
					"SELECT ?, ?, ?, ?",
					[new Uint8Array([1, 2]), true, 42n, null],
					strict,
				),
			).toEqual([[new Uint8Array([1, 2]), 1, 42, null]]);
			expect(await readNativeValues(sqlite, "SELECT 1 AS id, 2 AS id", [], strict)).toEqual([
				[1, 2],
			]);
			expect(
				await readQuery(
					db.select({ value: sql<Uint8Array>`${new Uint8Array([3, 4])}` }).from(owners),
					strict,
				),
			).toEqual([{ value: new Uint8Array([3, 4]) }]);
			expect(await readNativeRows(sqlite, "SELECT id FROM owners", [], strict)).toEqual([
				{ id: "o1" },
			]);
			expect(await readDbAll(db, sql`SELECT id FROM owners`, strict)).toEqual([{ id: "o1" }]);
			expect(await readQueryFirst(db.select().from(owners), strict)).toEqual({
				id: "o1",
				name: "alice",
			});
			expect(
				await readQueryFirst(db.select().from(owners).where(eq(owners.id, "missing")), strict),
			).toBeUndefined();
		} finally {
			prepare.mockRestore();
		}
	});
	for (const bridge of ["native", "dbAll"] as const) {
		test(`${bridge} rejects cancellation after Worker delivery during row mapping`, async () => {
			const controller = new AbortController();
			const fromEntries = Object.fromEntries;
			let mapped = 0;
			let busyAtAbort: number | undefined;
			const mapping = spyOn(Object, "fromEntries").mockImplementation(
				(entries: Parameters<typeof Object.fromEntries>[0]) => {
					const row = fromEntries(entries);
					if (Object.hasOwn(row, "mapping_read_value") && ++mapped === 128) {
						queueMicrotask(() => {
							busyAtAbort = getDbWorkerPoolStats().busy;
							controller.abort();
						});
					}
					return row;
				},
			);
			const query =
				"WITH RECURSIVE mapping_rows(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM mapping_rows WHERE value < 257) SELECT value AS mapping_read_value FROM mapping_rows";
			try {
				const result =
					bridge === "native"
						? readNativeRows(sqlite, query, [], { ...strict, signal: controller.signal })
						: readDbAll(db, sql.raw(query), { ...strict, signal: controller.signal });
				await expect(result).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
				expect(busyAtAbort).toBe(0);
				expect(mapped).toBe(128);
			} finally {
				mapping.mockRestore();
			}
		});
	}

	test("native row mapping checks cancellation before returning its final batch", async () => {
		const controller = new AbortController();
		const fromEntries = Object.fromEntries;
		let mapped = 0;
		const mapping = spyOn(Object, "fromEntries").mockImplementation(
			(entries: Parameters<typeof Object.fromEntries>[0]) => {
				const row = fromEntries(entries);
				if (Object.hasOwn(row, "mapping_read_value") && ++mapped === 128) controller.abort();
				return row;
			},
		);
		try {
			await expect(
				readNativeRows(
					sqlite,
					"WITH RECURSIVE mapping_rows(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM mapping_rows WHERE value < 128) SELECT value AS mapping_read_value FROM mapping_rows",
					[],
					{ ...strict, signal: controller.signal },
				),
			).rejects.toMatchObject({ code: "DB_READ_ABORTED" });
			expect(mapped).toBe(128);
		} finally {
			mapping.mockRestore();
		}
	});

	test("large UTF8 escaped text and Blob binds execute intact in a real worker", async () => {
		const text = `${"界".repeat(70_000)}${"\\".repeat(70_000)}`;
		const blob = new Uint8Array(SELECT_ROWS_MAX_PARAMS_BYTES + 1).fill(7);
		const result = await readNativeValues(sqlite, "SELECT ?, ?", [text, blob], strict);
		expect(result[0][0]).toBe(text);
		expect((result[0][1] as Uint8Array).byteLength).toBe(blob.byteLength);
		expect((result[0][1] as Uint8Array).every((value) => value === 7)).toBe(true);
	});

	test("strict policy controls unsupported, memory and transaction paths before execution", async () => {
		let executed = false;
		const unsupported = {
			toSQL: () => ({ sql: "SELECT 1", params: [] }),
			// biome-ignore lint/suspicious/noThenProperty: intentional execution-detecting query thenable
			then: () => {
				executed = true;
				return Promise.resolve([]);
			},
		};
		await expect(
			readQuery(
				unsupported as unknown as PromiseLike<unknown[]> & {
					toSQL(): { sql: string; params: unknown[] };
				},
				strict,
			),
		).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
		expect(executed).toBe(false);
		const memory = new Database(":memory:");
		try {
			await expect(readNativeRows(memory, "SELECT 1", [], strict)).rejects.toMatchObject({
				code: "DB_READ_UNSUPPORTED",
			});
		} finally {
			memory.close();
		}
		sqlite.transaction(() => {
			db.insert(owners).values({ id: "tx", name: "transaction" }).run();
			expect(db.select().from(owners).where(eq(owners.id, "tx")).all()).toHaveLength(1);
			// SQLite write transaction callbacks remain synchronous.
		})();
		sqlite.run("BEGIN");
		try {
			await expect(readQuery(db.select().from(owners), strict)).rejects.toMatchObject({
				code: "DB_READ_UNSUPPORTED",
			});
		} finally {
			sqlite.run("ROLLBACK");
			sqlite.run("DELETE FROM owners WHERE id = 'tx'");
		}
	});
	test("strict policy rejects disabled workers without executing the main connection", async () => {
		const before = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			const query = db.select().from(owners);
			const execute = spyOn(query, "execute");
			try {
				await expect(readQuery(query, strict)).rejects.toMatchObject({
					code: "DB_READ_UNAVAILABLE",
				});
				expect(execute).not.toHaveBeenCalled();
			} finally {
				execute.mockRestore();
			}
		} finally {
			if (before === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = before;
		}
	});
	test("PostgreSQL dispatch precedes strict SQLite and unsupported db.all is not executed", async () => {
		let calls = 0;
		const pg = drizzlePg(async (_sql, _params, method) => {
			calls++;
			return { rows: method === "all" ? [[7]] : [{ value: 7 }] };
		});
		const table = pgTable("fixture", { value: pgInteger("value") });
		const before = process.env.NARRAFORK_DB_WORKER;
		process.env.NARRAFORK_DB_WORKER = "off";
		try {
			expect(await readQuery(pg.select().from(table), strict)).toEqual([{ value: 7 }]);
			expect(await readDbAll(pg, sql`SELECT 7 AS value`, strict)).toEqual([{ value: 7 }]);
			expect(calls).toBe(2);
			await expect(
				readDbAll(
					{
						all: () => {
							throw new Error("must not execute");
						},
					},
					sql`SELECT 1`,
					strict,
				),
			).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
		} finally {
			if (before === undefined) delete process.env.NARRAFORK_DB_WORKER;
			else process.env.NARRAFORK_DB_WORKER = before;
		}
	});
	test("raw read bridges reject disabled workers without preparing on the owning connection", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		const prepare = spyOn(sqlite, "prepare");
		try {
			await expect(readNativeRows(sqlite, "SELECT 1")).rejects.toMatchObject({
				code: "DB_READ_UNAVAILABLE",
			});
			await expect(readDbAll(db, sql`SELECT 1`)).rejects.toMatchObject({
				code: "DB_READ_UNAVAILABLE",
			});
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
		}
	});
	test("static domain probe runs off-thread and query errors are content free", async () => {
		expect(await readDomainTask(sqlite, "readerProbe", null, strict)).toEqual({ ready: true });
		try {
			await readNativeRows(sqlite, "SELECT private_column FROM private_table", [], strict);
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({ name: "DbReadTaskExecutionError", code: "SQLITE_ERROR" });
			expect(String(error)).not.toContain("private_");
		}
	});
});

describe("readQuery", () => {
	test("decodes columns, joins and left-join nulls exactly like await query", async () => {
		const all = () => db.select().from(items).orderBy(items.id);
		const joined = () =>
			db
				.select({ item: items, owner: owners })
				.from(items)
				.leftJoin(owners, eq(owners.id, items.ownerId))
				.orderBy(items.id);
		const duplicateIds = () =>
			db
				.select({ itemId: items.id, ownerId: owners.id, total: sql<number>`count(*)` })
				.from(items)
				.leftJoin(owners, eq(owners.id, items.ownerId))
				.groupBy(items.id)
				.orderBy(items.id);
		expect(await readQuery(all())).toEqual(await all());
		expect(await readQuery(joined())).toEqual(await joined());
		expect(await readQuery(duplicateIds())).toEqual(await duplicateIds());
		const [first] = await readQuery(db.select().from(items).orderBy(items.id));
		expect(first?.createdAt).toBeInstanceOf(Date);
		expect(first?.meta).toEqual({ tags: ["a"] });
		expect(getDbWorkerPoolStats().workers).toBeGreaterThan(0);
	}, 30_000);

	test("returns complete rows above maxRows and preserves the business SQL LIMIT", async () => {
		const selected = () => db.select().from(items).orderBy(items.id);
		const complete = await readQuery(selected(), { maxRows: 1 });
		const expected = await selected();
		expect(complete).toEqual(expected);
		expect(complete).toHaveLength(2);
		const limited = await readQuery(selected().limit(1), { maxRows: 1 });
		expect(limited).toEqual(expected.slice(0, 1));
	}, 30_000);

	test("runs inline inside a transaction so it sees uncommitted writes", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		sqlite.run("BEGIN");
		try {
			db.insert(owners).values({ id: "o2", name: "bob" }).run();
			expect(await readQuery(db.select().from(owners))).toHaveLength(2);
		} finally {
			sqlite.run("ROLLBACK");
		}
	});

	test("runs inline for in-memory databases even when workers are disabled", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		const client = new Database(":memory:");
		const memory = drizzle({ client });
		try {
			expect(await readQuery(memory.select({ one: sql<number>`1` }).from(sql`(SELECT 1)`))).toEqual(
				[{ one: 1 }],
			);
		} finally {
			client.close();
		}
	});

	test("preserves the ordinary non-SQLite/async builder path", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		const query = Object.assign(Promise.resolve([{ one: 1 }]), {
			toSQL: () => ({ sql: "SELECT 1", params: [] }),
		});
		expect(await readQuery(query)).toEqual([{ one: 1 }]);
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	const unsupportedConnections: Array<[string, unknown]> = [
		["missing session", undefined],
		["missing client", {}],
		["null client", { client: null }],
		["missing filename", { client: { inTransaction: true } }],
		["null filename", { client: { filename: null, inTransaction: true } }],
		["numeric filename", { client: { filename: 123, inTransaction: true } }],
		["object filename", { client: { filename: {}, inTransaction: true } }],
	];
	for (const [shape, session] of unsupportedConnections) {
		test(`${shape} fails explicitly without awaiting or executing the SQLite query`, async () => {
			const query = db.select().from(owners);
			// Replace only this builder's private session, simulating a Drizzle adapter/API change.
			Reflect.set(query, "session", session);
			const then = spyOn(query, "then");
			const execute = spyOn(query, "execute");
			const compile = spyOn(query, "toSQL");
			try {
				await expect(readQuery(query)).rejects.toMatchObject({
					name: "WorkersUnavailableError",
					reason: "unsupported_sqlite_connection",
				});
				expect(then).not.toHaveBeenCalled();
				expect(execute).not.toHaveBeenCalled();
				expect(compile).not.toHaveBeenCalled();
				expect(getDbWorkerPoolStats().workers).toBe(0);
			} finally {
				then.mockRestore();
				execute.mockRestore();
				compile.mockRestore();
			}
		});
	}

	test("fails without executing the query when workers are disabled", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		await rejectsOffThread();
	});

	test("fails without executing the query when concurrency is zero", async () => {
		process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "0";
		await rejectsOffThread();
	});

	test("pool shutdown rejects queued reads without executing them on the main connection", async () => {
		useWorkerFixture(
			"queued-shutdown",
			'self.onmessage = () => {}; postMessage({ type: "ready" });',
		);
		const running = rejectsOffThread();
		await waitForBusy();
		const queued = rejectsOffThread();
		const deadline = Date.now() + 3_000;
		while (getDbWorkerPoolStats().queued === 0 && Date.now() < deadline) await Bun.sleep(1);
		expect(getDbWorkerPoolStats().queued).toBe(1);
		await shutdownDbWorkerPool();
		await Promise.all([running, queued]);
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
	});

	test.each([
		false,
		true,
	])("creation failure never executes inline (shortRead=%s)", async (shortRead) => {
		setDbWorkerSpecifiersForTest([pathToFileURL(join(home, "missing-worker.ts")).href]);
		await rejectsOffThread({ shortRead });
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("ORM bridge forwards auth scheduling and the original absolute deadline", async () => {
		await expect(
			readQuery(db.select().from(owners), {
				schedulingHint: "auth-session",
				deadlineAt: Date.now() - 1,
			}),
		).rejects.toMatchObject({ code: "DB_READ_TASK_TIMEOUT" });
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(
			await readQuery(db.select().from(owners), {
				schedulingHint: "auth-session",
				deadlineAt: Date.now() + 10_000,
			}),
		).toEqual([{ id: "o1", name: "alice" }]);
		expect(getDbWorkerPoolStats().reservation).toMatchObject({
			reserved: { idle: 1 },
			shared: { idle: 0 },
		});
		await expect(
			readNativeRows(sqlite, "SELECT 1", [], { schedulingHint: "auth-session" }),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
	});

	test("tracked ephemeral startup probes preserve result and confirmed release", async () => {
		const successful = join(home, "ephemeral-ready.ts");
		writeFileSync(
			successful,
			'import { parentPort } from "node:worker_threads"; parentPort.on("message", data => parentPort.postMessage({ type: "result", requestId: data.requestId, result: "complete", durationMs: 0 })); parentPort.postMessage({ type: "ready" });',
		);
		setDbWorkerSpecifiersForTest([
			pathToFileURL(join(home, "missing-ephemeral-entry.ts")).href,
			pathToFileURL(successful).href,
		]);
		const handle = runTrackedEphemeralReadTask<string>(
			sqlite.filename,
			{ kind: "storageScanContext" },
			{ timeoutMs: 5_000 },
		);
		await expect(handle.result).resolves.toBe("complete");
		await handle.released;
		expect(getDbWorkerPoolStats().tracked).toBe(0);
		expect(getDbWorkerPoolStats().workers).toBe(0);
	}, 10_000);

	test("a real creation failure never executes the query on the main connection", async () => {
		setDbWorkerSpecifiersForTest([pathToFileURL(join(home, "missing-worker.ts")).href]);
		await rejectsOffThread();
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("a missing ready handshake never executes the query on the main connection", async () => {
		useWorkerFixture("no-ready", 'postMessage({ type: "not-ready" }); process.exit(4);');
		await rejectsOffThread();
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test.each([
		false,
		true,
	])("Worker exit never executes inline (shortRead=%s)", async (shortRead) => {
		useWorkerFixture(
			"exits",
			'self.onmessage = () => process.exit(3); postMessage({ type: "ready" });',
		);
		await rejectsOffThread({ shortRead });
		expect(getDbWorkerPoolStats().busy).toBe(0);
	});

	test.each([false, true])("timeout never executes inline (shortRead=%s)", async (shortRead) => {
		useWorkerFixture("hangs", 'self.onmessage = () => {}; postMessage({ type: "ready" });');
		await rejectsOffThread({ shortRead, timeoutMs: 200 });
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("cancellation retires the worker without executing the query on the main connection", async () => {
		useWorkerFixture("aborted", 'self.onmessage = () => {}; postMessage({ type: "ready" });');
		const controller = new AbortController();
		const pending = rejectsOffThread({ signal: controller.signal });
		await waitForBusy();
		controller.abort();
		await pending;
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("pool shutdown during execution never executes the query on the main connection", async () => {
		useWorkerFixture("shutdown", 'self.onmessage = () => {}; postMessage({ type: "ready" });');
		const pending = rejectsOffThread();
		await waitForBusy();
		await shutdownDbWorkerPool();
		await pending;
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});
});

describe("readQuery on the short-read pool", () => {
	test("decodes rows without touching the ordinary read pool", async () => {
		const rows = await readQuery(db.select().from(owners).where(eq(owners.id, "o1")), {
			shortRead: true,
		});
		expect(rows).toEqual([{ id: "o1", name: "alice" }]);
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});

	test("row thresholds do not truncate complete short-read results", async () => {
		expect(await readQuery(db.select().from(items), { shortRead: true })).toHaveLength(2);
		expect(await readQuery(db.select().from(items), { shortRead: true, maxRows: 2 })).toHaveLength(
			2,
		);
	});

	test("disabled workers never execute the query on the main connection", async () => {
		process.env.NARRAFORK_DB_WORKER = "off";
		await rejectsOffThread({ shortRead: true });
	});
});

describe("single-compilation relational worker reads", () => {
	const strict = { executionPolicy: "worker-required" as const };
	const ownersRelations = relations(owners, ({ many }) => ({ items: many(items) }));
	const itemsRelations = relations(items, ({ one }) => ({
		owner: one(owners, { fields: [items.ownerId], references: [owners.id] }),
	}));
	function relationalDb(client: Database) {
		return drizzle(client, { schema: { owners, items, ownersRelations, itemsRelations } });
	}
	let fixtureHome: string;
	let client: Database;
	let relational: ReturnType<typeof relationalDb>;
	type RelationalRead = PromiseLike<unknown> & {
		toSQL(): { sql: string; params: unknown[] };
	};

	beforeAll(() => {
		fixtureHome = mkdtempSync(join(tmpdir(), "narrafork-worker-single-compile-"));
		client = new Database(join(fixtureHome, "fixture.db"));
		client.run("PRAGMA journal_mode = WAL");
		client.run("CREATE TABLE owners (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
		client.run(
			"CREATE TABLE items (id TEXT PRIMARY KEY, owner_id TEXT, meta TEXT, done INTEGER NOT NULL, created_at INTEGER NOT NULL)",
		);
		relational = relationalDb(client);
		client.transaction(() => {
			for (let index = 0; index < 385; index++) {
				const suffix = String(index).padStart(3, "0");
				relational
					.insert(owners)
					.values({ id: `o${suffix}`, name: `owner-${suffix}` })
					.run();
				relational
					.insert(items)
					.values({
						id: `i${suffix}`,
						ownerId: index === 384 ? null : `o${suffix}`,
						meta: index % 3 ? { tags: [suffix] } : null,
						done: index % 2 === 0,
						createdAt: new Date(1_000 + index),
					})
					.run();
			}
		})();
	});

	afterAll(async () => {
		await drainDbWorkerPool({ timeoutMs: 20_000 });
		client.close();
		rmSync(fixtureHome, { recursive: true, force: true });
		resetDbWorkerPoolForTest();
	});

	function observeCompilation(query: unknown) {
		const counts = { _toSQL: 0, _prepare: 0, toSQL: 0 };
		const restore: Array<() => void> = [];
		const originalSession = Reflect.get(query as object, "session");
		for (const method of ["_toSQL", "_prepare", "toSQL"] as const) {
			const descriptor = Object.getOwnPropertyDescriptor(query, method);
			const original = Reflect.get(query as object, method) as (...args: unknown[]) => unknown;
			// Object.assign() must copy this instance-local spy into the isolated preparation clone.
			Object.defineProperty(query, method, {
				configurable: true,
				enumerable: true,
				writable: true,
				value: function (this: unknown, ...args: unknown[]) {
					counts[method]++;
					return Reflect.apply(original, this, args);
				},
			});
			restore.push(() => {
				if (descriptor) Object.defineProperty(query, method, descriptor);
				else Reflect.deleteProperty(query as object, method);
			});
		}
		return {
			counts,
			originalSession,
			restore: () => {
				for (const undo of restore.reverse()) undo();
			},
		};
	}

	function protectMainClient() {
		const reject = () => {
			throw new Error("measured worker query executed on main connection");
		};
		const guards = [
			spyOn(client, "prepare").mockImplementation(reject),
			spyOn(client, "query").mockImplementation(reject),
			spyOn(client, "run").mockImplementation(reject),
			spyOn(client, "exec").mockImplementation(reject),
		];
		return {
			assertUnused: () => {
				for (const guard of guards) expect(guard).not.toHaveBeenCalled();
			},
			restore: () => {
				for (const guard of guards.reverse()) guard.mockRestore();
			},
		};
	}

	const cases: Array<{ name: string; query: () => RelationalRead }> = [
		{
			name: "empty findMany",
			query: () => relational.query.items.findMany({ where: eq(items.id, "missing") }),
		},
		...([1, 128, 129, 385] as const).map((limit) => ({
			name: `${limit}-row findMany`,
			query: () => relational.query.items.findMany({ orderBy: items.id, limit }),
		})),
		{
			name: "findFirst",
			query: () => relational.query.items.findFirst({ where: eq(items.id, "i001") }),
		},
		{
			name: "empty findFirst",
			query: () => relational.query.items.findFirst({ where: eq(items.id, "missing") }),
		},
		{
			name: "nested many across mapping batches",
			query: () =>
				relational.query.owners.findMany({
					orderBy: owners.id,
					with: { items: { orderBy: items.id, with: { owner: true } } },
				}),
		},
		{
			name: "nested findFirst",
			query: () =>
				relational.query.owners.findFirst({
					where: eq(owners.id, "o000"),
					with: { items: true },
				}),
		},
		{
			name: "nullable nested one across mapping batches",
			query: () => relational.query.items.findMany({ orderBy: items.id, with: { owner: true } }),
		},
	];
	for (const entry of cases) {
		test(`${entry.name} compiles once and preserves native mapping`, async () => {
			const expected = await entry.query();
			const query = entry.query();
			const observed = observeCompilation(query);
			const guard = protectMainClient();
			try {
				expect(await readQuery(query, strict)).toEqual(expected);
				expect(observed.counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
				expect(Reflect.get(query, "session")).toBe(observed.originalSession);
				guard.assertUnused();
			} finally {
				guard.restore();
				observed.restore();
			}
		});
	}

	test("one adapter reuses its compilation for repeated compile and empty mapping calls", () => {
		const query = relational.query.items.findMany({ where: eq(items.id, "i001") });
		const observed = observeCompilation(query);
		const guard = protectMainClient();
		try {
			const adapter = adaptReadQuery(query);
			expect(adapter).toBeDefined();
			const compiled = adapter?.compile();
			expect(compiled?.params).toEqual(["i001"]);
			expect(adapter?.compile()).toBe(compiled);
			expect(adapter?.map([])).toEqual([]);
			expect(adapter?.map([])).toEqual([]);
			expect(observed.counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
			expect(Reflect.get(query, "session")).toBe(observed.originalSession);
			guard.assertUnused();
		} finally {
			guard.restore();
			observed.restore();
		}
	});

	test("parallel bindings and a repeated query keep per-adaptation compilation isolated", async () => {
		const makeQuery = (id: string) =>
			relational.query.items.findMany({ where: eq(items.id, id), with: { owner: true } });
		const ids = ["i000", "i384"];
		const expected = await Promise.all(ids.map((id) => makeQuery(id)));
		const queries = ids.map(makeQuery);
		const observed = queries.map(observeCompilation);
		const guard = protectMainClient();
		try {
			expect(await Promise.all(queries.map((query) => readQuery(query, strict)))).toEqual(expected);
			for (let index = 0; index < queries.length; index++) {
				expect(observed[index].counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
				expect(Reflect.get(queries[index], "session")).toBe(observed[index].originalSession);
			}
			expect(await readQuery(queries[0], strict)).toEqual(expected[0]);
			expect(observed[0].counts).toEqual({ _toSQL: 2, _prepare: 2, toSQL: 0 });
			expect(observed[1].counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
			guard.assertUnused();
		} finally {
			guard.restore();
			for (const observation of observed) observation.restore();
		}
	});

	test("ordinary selects order their fields once for empty and subsequent mapping batches", () => {
		const query = relational.select({ id: items.id }).from(items);
		const adapter = adaptReadQuery(query);
		expect(adapter).toBeDefined();
		adapter?.compile();
		const fields = (query as unknown as { config: { fields: Record<string, unknown> } }).config
			.fields;
		const descriptor = Object.getOwnPropertyDescriptor(fields, "id");
		let ordered = 0;
		Object.defineProperty(fields, "id", {
			configurable: true,
			enumerable: true,
			get: () => {
				ordered++;
				return items.id;
			},
		});
		const guard = protectMainClient();
		try {
			expect(adapter?.map([])).toEqual([]);
			expect(adapter?.map([["i000"]])).toEqual([{ id: "i000" }]);
			expect(adapter?.map([["i001"]])).toEqual([{ id: "i001" }]);
			expect(ordered).toBe(1);
			guard.assertUnused();
		} finally {
			guard.restore();
			if (descriptor) Object.defineProperty(fields, "id", descriptor);
			else Reflect.deleteProperty(fields, "id");
		}
	});

	test("cancellation after the first relational mapping batch stops before the next batch", async () => {
		const selected = () =>
			relational.query.items.findMany({ columns: { id: true }, orderBy: items.id });
		expect(await selected()).toHaveLength(385);
		const controller = new AbortController();
		let decoded = 0;
		let busyAtAbort: number | undefined;
		const originalDecode = items.id.mapFromDriverValue.bind(items.id);
		// Observe the selected column instance's native decoder, including aliased row mapping.
		const decoding = spyOn(items.id, "mapFromDriverValue").mockImplementation((value) => {
			if (++decoded === 128) {
				queueMicrotask(() => {
					busyAtAbort = getDbWorkerPoolStats().busy;
					controller.abort();
				});
			}
			return originalDecode(value);
		});
		const query = selected();
		const observed = observeCompilation(query);
		let guard: ReturnType<typeof protectMainClient> | undefined;
		try {
			expect(
				await relational.query.items.findFirst({
					columns: { id: true },
					where: eq(items.id, "i000"),
				}),
			).toEqual({ id: "i000" });
			expect(decoded).toBe(1);
			decoded = 0;
			guard = protectMainClient();
			await expect(
				readQuery(query, { ...strict, signal: controller.signal }),
			).rejects.toMatchObject({
				code: "DB_READ_ABORTED",
			});
			expect(decoded).toBe(128);
			expect(busyAtAbort).toBe(0);
			expect(observed.counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
			guard.assertUnused();
		} finally {
			guard?.restore();
			observed.restore();
			decoding.mockRestore();
		}
	});

	test("a decoder error in a later relational batch retains the error and one compilation", async () => {
		const selected = () =>
			relational.query.items.findMany({ columns: { id: true }, orderBy: items.id });
		expect(await selected()).toHaveLength(385);
		const failure = new Error("fixture decoder failure");
		let decoded = 0;
		const originalDecode = items.id.mapFromDriverValue.bind(items.id);
		const decoding = spyOn(items.id, "mapFromDriverValue").mockImplementation((value) => {
			if (++decoded === 129) throw failure;
			return originalDecode(value);
		});
		const query = selected();
		const observed = observeCompilation(query);
		let guard: ReturnType<typeof protectMainClient> | undefined;
		try {
			expect(
				await relational.query.items.findFirst({
					columns: { id: true },
					where: eq(items.id, "i000"),
				}),
			).toEqual({ id: "i000" });
			expect(decoded).toBe(1);
			decoded = 0;
			guard = protectMainClient();
			await expect(readQuery(query, strict)).rejects.toBe(failure);
			expect(decoded).toBe(129);
			expect(getDbWorkerPoolStats().busy).toBe(0);
			expect(observed.counts).toEqual({ _toSQL: 1, _prepare: 1, toSQL: 0 });
			guard.assertUnused();
		} finally {
			guard?.restore();
			observed.restore();
			decoding.mockRestore();
		}
	});

	for (const mode of ["missing mapper", "preparation failure"] as const) {
		test(`isolated ${mode} fails without preparing on the owning session`, async () => {
			const query = relational.query.items.findMany();
			const originalSession = Reflect.get(query, "session");
			const failure = new Error("fixture preparation failure");
			Object.defineProperty(query, "_prepare", {
				configurable: true,
				enumerable: true,
				value: () => {
					if (mode === "preparation failure") throw failure;
					return {};
				},
			});
			const guard = protectMainClient();
			try {
				const result = readQuery(query, strict);
				if (mode === "preparation failure") await expect(result).rejects.toBe(failure);
				else await expect(result).rejects.toMatchObject({ code: "DB_READ_UNSUPPORTED" });
				expect(Reflect.get(query, "session")).toBe(originalSession);
				guard.assertUnused();
			} finally {
				guard.restore();
				Reflect.deleteProperty(query, "_prepare");
			}
		});
	}
});

describe("read query rejection diagnostics", () => {
	let clock = Date.now();
	let now: ReturnType<typeof spyOn<typeof Date, "now">>;
	let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
	const secret = "private-bound-value";
	const strict = { executionPolicy: "worker-required" as const };
	beforeEach(() => {
		clock = Math.max(clock, Date.now()) + 10_000;
		now = spyOn(Date, "now").mockImplementation(() => clock);
		warn = spyOn(logger, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		now.mockRestore();
		warn.mockRestore();
	});
	function rejectionLog(index = 0) {
		const [message, data] = warn.mock.calls[index] ?? [];
		expect(message).toBe("Database read query rejected");
		expect(data).toMatchObject({
			code: "DB_READ_INVALID",
			maxParameters: 4096,
			parameterMaxBytes: SELECT_ROWS_MAX_PARAMS_BYTES,
			sqlMaxBytes: SELECT_ROWS_MAX_SQL_BYTES,
			maxRowsBudget: SELECT_ROWS_MAX_ROWS,
			rateLimitWindowMs: 10_000,
			rateLimitMaxLogs: 5,
		});
		expect(JSON.stringify(data)).not.toContain(secret);
		return data as Record<string, unknown>;
	}

	test("db.all shares one observation log across validations and raw illegal input still logs rejection", async () => {
		const binds = Array(SELECT_ROWS_MAX_PARAMS + 1).fill(secret);
		const query = sql`WITH data(value) AS (VALUES ${sql.join(
			binds.map((value) => sql`(${value})`),
			sql`,`,
		)}) SELECT value FROM data`;
		const template = `WITH data(value) AS (VALUES ${binds.map(() => "(?)").join(",")}) SELECT value FROM data`;
		const result = await readDbAll(db, query, {
			...strict,
			maxRows: 123,
			diagnosticSource: "workspace-modification-view.selectPerPathRows",
		});
		expect(result).toHaveLength(4097);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toBe("Database read observation threshold exceeded");
		const observation = warn.mock.calls[0][1] as Record<string, unknown>;
		expect(observation).toMatchObject({
			sql: template,
			sqlTruncated: false,
			source: "workspace-modification-view.selectPerPathRows",
			sourceTruncated: false,
			metrics: { sqlBytes: Buffer.byteLength(template), parameterCount: 4097, rows: 4097 },
			status: "completed",
			partial: false,
			suppressedSinceLastLog: 0,
		});
		const exceeded = observation.exceeded as Array<{ kind: string }>;
		expect(new Set(exceeded.map((item) => item.kind)).size).toBe(exceeded.length);
		expect(JSON.stringify(observation)).not.toContain(secret);
		await expect(
			readNativeRows(sqlite, "SELECT ? AS value", [secret], { ...strict, maxRows: 0 }),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(rejectionLog(1)).toMatchObject({
			sql: "SELECT ? AS value",
			sqlBytes: Buffer.byteLength("SELECT ? AS value"),
			parameterCount: 1,
			maxRows: 0,
		});
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test("digest SQL examples share one bounded text allowance and preserve strict result shape", async () => {
		const query = `SELECT ? AS value ${" ".repeat(33_000)}`;
		const value = secret + "x".repeat(70_000);
		const commitment = sourceRowsCommitment([{ value }]);
		const result = await readSelectDigestBatch(
			sqlite,
			Array.from({ length: 17 }, (_, ordinal) => ({
				ordinal,
				query,
				params: [value],
				...commitment,
			})),
			strict,
		);
		expect(result.matches).toBe(true);
		expect(Object.keys(result).sort()).toEqual(["entries", "matches"]);
		expect(warn).toHaveBeenCalledTimes(1);
		const diagnostic = warn.mock.calls[0][1] as {
			sqlTemplates: string[];
			sqlTruncated: boolean;
			metrics: { sqlBytes: number; parameterCount: number };
		};
		expect(diagnostic.sqlTemplates.length).toBeLessThanOrEqual(3);
		expect(
			diagnostic.sqlTemplates.reduce((bytes, template) => bytes + Buffer.byteLength(template), 0),
		).toBeLessThanOrEqual(64 * 1024);
		expect(diagnostic.sqlTruncated).toBe(true);
		expect(diagnostic.metrics).toMatchObject({
			sqlBytes: Buffer.byteLength(query) * 17,
			parameterCount: 17,
		});
		expect(JSON.stringify(diagnostic)).not.toContain(secret);
	}, 30_000);

	test("ordinary and extended ORM rejection paths retain SQL and their actual counts", async () => {
		const ordinary = db.select({ value: sql`${secret}` }).from(owners);
		await expect(
			readQuery(ordinary, {
				...strict,
				maxRows: 0,
				diagnosticSource: "orm.ordinary",
			}),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(rejectionLog()).toMatchObject({
			sql: ordinary.toSQL().sql,
			sqlBytes: Buffer.byteLength(ordinary.toSQL().sql),
			parameterCount: 1,
			maxRows: 0,
			source: "orm.ordinary",
		});
		const binds = [new Uint8Array(Buffer.from(secret)), ...Array(4095).fill(secret), NaN];
		const extended = db
			.select()
			.from(owners)
			.where(
				sql`${owners.id} in (${sql.join(
					binds.map((value) => sql`${value}`),
					sql`,`,
				)})`,
			);
		await expect(
			readQuery(extended, { ...strict, maxRows: 23, diagnosticSource: "orm.extended" }),
		).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(rejectionLog(1)).toMatchObject({
			sql: extended.toSQL().sql,
			sqlBytes: Buffer.byteLength(extended.toSQL().sql),
			parameterCount: 4097,
			maxRows: 23,
			source: "orm.extended",
		});
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test("stream encoding and validation failures log caller stacks without delivering chunks", async () => {
		let chunks = 0;
		const consume = () => {
			chunks++;
		};
		for (const [binds, maxRows] of [
			[[...Array(4096).fill(secret), NaN], 17],
			[[secret], 0],
		] as const) {
			await expect(
				consumeReadSqlValues(sqlite, "SELECT ? AS value", binds, consume, { ...strict, maxRows }),
			).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		}
		for (const [index, parameterCount, maxRows] of [
			[0, 4097, 17],
			[1, 1, 0],
		]) {
			const log = rejectionLog(index);
			expect(log).toMatchObject({
				sql: "SELECT ? AS value",
				sqlBytes: Buffer.byteLength("SELECT ? AS value"),
				parameterCount,
				maxRows,
				source: "unspecified",
			});
			expect(log.stack).toContain("worker-read.test.ts");
			expect(Buffer.byteLength(log.stack as string)).toBeLessThanOrEqual(4096);
		}
		expect(chunks).toBe(0);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	test("bounds UTF-8 SQL, source and stack prefixes and preserves errors when logging fails", async () => {
		const failure = new DbReadError("DB_READ_INVALID", "Invalid or oversized read query");
		failure.stack = `diagnostic caller\n${"界".repeat(8192)}`;
		const binds = [secret];
		Object.defineProperty(binds, 0, {
			get: () => {
				throw failure;
			},
		});
		const template = `SELECT ? ${"界".repeat(SELECT_ROWS_MAX_SQL_BYTES)}`;
		warn.mockImplementationOnce(() => {
			throw new Error("log sink unavailable");
		});
		await expect(
			readNativeValues(sqlite, template, binds, {
				...strict,
				diagnosticSource: "来".repeat(256),
			}),
		).rejects.toBe(failure);
		const log = rejectionLog();
		expect(log).toMatchObject({
			sqlBytes: Buffer.byteLength(template),
			sqlTruncated: true,
			parameterCount: 1,
			maxRows: SELECT_ROWS_MAX_ROWS,
			sourceTruncated: true,
			sourceMaxBytes: 256,
			stackTruncated: true,
			stackMaxBytes: 4096,
		});
		for (const [field, budget] of [
			["sql", SELECT_ROWS_MAX_SQL_BYTES],
			["source", 256],
			["stack", 4096],
		] as const) {
			const text = log[field] as string;
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
			expect(text).not.toContain("�");
		}
		expect(template.startsWith(log.sql as string)).toBe(true);
		expect(failure.stack.startsWith(log.stack as string)).toBe(true);
	});

	test("admits five warnings per ten seconds and reports suppressed counts on the next log", async () => {
		const reject = () => readNativeValues(sqlite, "SELECT ?", [secret], { ...strict, maxRows: 0 });
		for (let attempt = 0; attempt < 8; attempt++)
			await expect(reject()).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(warn).toHaveBeenCalledTimes(5);
		for (let index = 0; index < 5; index++)
			expect(rejectionLog(index).suppressedSinceLastLog).toBe(0);
		clock += 9999;
		await expect(reject()).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(warn).toHaveBeenCalledTimes(5);
		clock++;
		await expect(reject()).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(warn).toHaveBeenCalledTimes(6);
		expect(rejectionLog(5).suppressedSinceLastLog).toBe(4);
		for (let attempt = 0; attempt < 5; attempt++)
			await expect(reject()).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(warn).toHaveBeenCalledTimes(10);
		clock += 10_000;
		await expect(reject()).rejects.toMatchObject({ code: "DB_READ_INVALID" });
		expect(warn).toHaveBeenCalledTimes(11);
		expect(rejectionLog(10).suppressedSinceLastLog).toBe(1);
	});

	test("successful reads and worker execution failures do not emit rejection diagnostics", async () => {
		expect(await readNativeValues(sqlite, "SELECT ?", [7], strict)).toEqual([[7]]);
		expect(await readQuery(db.select({ value: sql`${true}` }).from(owners), strict)).toEqual([
			{ value: 1 },
		]);
		const failure = await readNativeValues(
			sqlite,
			"SELECT missing_private_column FROM owners",
			[],
			strict,
		).catch((error: unknown) => error);
		expect(failure).toMatchObject({ name: "DbReadTaskExecutionError", code: "SQLITE_ERROR" });
		expect(warn.mock.calls.map(([message]) => message)).toEqual([
			"Database read worker query failed",
		]);
		const logged = JSON.stringify(warn.mock.calls);
		expect(logged).not.toContain("missing_private_column");
		expect(logged).not.toContain(home);
	}, 30_000);
});
