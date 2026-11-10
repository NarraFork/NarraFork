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
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	setDbWorkerSpecifiersForTest,
	shutdownDbWorkerPool,
} from "../lib/db-worker/pool";
import { readQuery } from "./worker-read";

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

beforeAll(() => {
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
	resetDbWorkerPoolForTest();
});

let previousWorker: string | undefined;
let previousConcurrency: string | undefined;
beforeEach(() => {
	previousWorker = process.env.NARRAFORK_DB_WORKER;
	previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	resetDbWorkerPoolForTest();
});
afterEach(() => {
	resetDbWorkerPoolForTest();
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

function useWorkerFixture(name: string, source: string): void {
	const file = join(home, `${name}.ts`);
	writeFileSync(file, source);
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

afterAll(() => {
	shutdownDbWorkerPool();
	sqlite.close();
	rmSync(home, { recursive: true, force: true });
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

	test("fails instead of truncating when the row budget is exceeded", async () => {
		await expect(readQuery(db.select().from(items), { maxRows: 1 })).rejects.toThrow("row budget");
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
		shutdownDbWorkerPool();
		await Promise.all([running, queued]);
		expect(getDbWorkerPoolStats().workers).toBe(0);
		expect(getDbWorkerPoolStats().queued).toBe(0);
	});

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

	test("a worker that exits during the task never executes the query on the main connection", async () => {
		useWorkerFixture(
			"exits",
			'self.onmessage = () => process.exit(3); postMessage({ type: "ready" });',
		);
		await rejectsOffThread();
		expect(getDbWorkerPoolStats().busy).toBe(0);
	});

	test("a timeout never executes the query on the main connection", async () => {
		useWorkerFixture("hangs", 'self.onmessage = () => {}; postMessage({ type: "ready" });');
		await rejectsOffThread({ timeoutMs: 200 });
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
		shutdownDbWorkerPool();
		await pending;
		expect(getDbWorkerPoolStats().workers).toBe(0);
	});
});
