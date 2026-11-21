import { Database, type Statement } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	configureSqlTraceForTest,
	flushSqlTraceSync,
	instrumentSqliteConnection,
	withSqlTraceSpan,
} from "../../sql-trace";
import {
	acceptSqlDiagnosticEvent,
	captureSqlDiagnosticSite,
	createHostSqlDiagnosticState,
	createSqlDiagnosticConfig,
	createWorkerSqlDiagnostics,
	getSqlDiagnosticSession,
	isSqlDiagnosticEvent,
	SQL_DIAGNOSTIC_EVENT_BYTES,
	SQL_DIAGNOSTIC_EVENTS_PER_SECOND,
	type SqlDiagnosticConfig,
	type SqlDiagnosticEvent,
	sqlDiagnosticSnapshot,
} from "../sql-diagnostics";

const config: SqlDiagnosticConfig = {
	session: "1234567890abcdef",
	key: "ab".repeat(32),
	continuity: new SharedArrayBuffer(4),
};
beforeEach(() => {
	Atomics.store(new Int32Array(config.continuity as SharedArrayBuffer), 0, 0);
});
const requestId = "dbr-test-1";
const sql = "SELECT ? AS value";
const hash = (text: string) =>
	crypto.createHmac("sha256", Buffer.from(config.key, "hex")).update(text).digest("hex");
const databases: Database[] = [];
const directories: string[] = [];
const restores: Array<() => void> = [];
function database() {
	const db = new Database(":memory:");
	databases.push(db);
	return db;
}
function harness(clock: () => number = () => 100) {
	Atomics.store(new Int32Array(config.continuity as SharedArrayBuffer), 0, 0);
	const events: SqlDiagnosticEvent[] = [];
	const state = createHostSqlDiagnosticState(config, false);
	const reporter = createWorkerSqlDiagnostics((event) => {
		events.push(event);
		expect(acceptSqlDiagnosticEvent(state, event, clock())).toBe(true);
	}, clock);
	return { reporter, events, state };
}
function starts(events: SqlDiagnosticEvent[]) {
	return events.filter(
		(event): event is Extract<SqlDiagnosticEvent, { phase: "start" }> => event.phase === "start",
	);
}
afterEach(() => {
	for (const restore of restores.splice(0).reverse()) restore();
	for (const db of databases.splice(0)) db.close();
	for (const dir of directories.splice(0)) {
		configureSqlTraceForTest({ mode: "off", dir });
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("worker SQLite SQL diagnostics", () => {
	test("disabled session preserves methods and makes no key/hash/clock/stack/post calls", () => {
		const previous = process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
		delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
		restores.push(() => {
			if (previous === undefined) delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
			else process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = previous;
		});
		const rng = spyOn(crypto, "randomBytes");
		const hmac = spyOn(crypto, "createHmac");
		restores.push(
			() => rng.mockRestore(),
			() => hmac.mockRestore(),
		);
		const nativeError = globalThis.Error;
		let stacks = 0;
		globalThis.Error = class extends nativeError {
			constructor(message?: string) {
				super(message);
				stacks++;
			}
		} as ErrorConstructor;
		restores.push(() => {
			globalThis.Error = nativeError;
		});
		let clocks = 0;
		let posts = 0;
		const reporter = createWorkerSqlDiagnostics(
			() => posts++,
			() => ++clocks,
		);
		const db = database();
		const query = db.query;
		expect(getSqlDiagnosticSession()).toBeUndefined();
		reporter.run(undefined, requestId, () => {
			expect(reporter.instrument(db)).toBe(db);
			expect(db.query(sql).get("private-bind")).toEqual({ value: "private-bind" });
		});
		expect(db.query).toBe(query);
		expect(rng).not.toHaveBeenCalled();
		expect(hmac).not.toHaveBeenCalled();
		expect([clocks, posts, stacks]).toEqual([0, 0, 0]);
	});

	test("session key is created once only after opt-in and shared by subsequent requests", () => {
		const previous = process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
		process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = "1";
		restores.push(() => {
			if (previous === undefined) delete process.env.NF_DB_WORKER_SQL_DIAGNOSTICS;
			else process.env.NF_DB_WORKER_SQL_DIAGNOSTICS = previous;
		});
		const first = getSqlDiagnosticSession();
		expect(first).toBe(getSqlDiagnosticSession());
		expect(first?.key).toMatch(/^[a-f0-9]{64}$/);
		expect(first?.session).toMatch(/^[a-f0-9]{16}$/);
	});

	test("each request owns a distinct four-byte continuity flag under the shared session key", () => {
		const first = createSqlDiagnosticConfig(config);
		const second = createSqlDiagnosticConfig(config);
		expect(first.key).toBe(second.key);
		expect(first.continuity).not.toBe(second.continuity);
		expect(first.continuity?.byteLength).toBe(4);
		Atomics.store(new Int32Array(first.continuity as SharedArrayBuffer), 0, 2);
		expect(sqlDiagnosticSnapshot(createHostSqlDiagnosticState(first, false), 100).state).toBe(
			"unknown",
		);
		expect(sqlDiagnosticSnapshot(createHostSqlDiagnosticState(second, false), 100).state).toBe(
			"unobserved",
		);
	});

	test("only SQL text enters HMAC; cached statements retain identity and bind-independent hashes", () => {
		const { reporter, events } = harness();
		const db = database();
		reporter.run(config, requestId, () => {
			reporter.instrument(db);
			const query = db.query;
			expect(reporter.instrument(db).query).toBe(query);
			const statement = db.query(sql);
			expect(db.query(sql)).toBe(statement);
			expect(statement.get("secret-one")).toEqual({ value: "secret-one" });
			expect(statement.get("secret-two")).toEqual({ value: "secret-two" });
			expect(db.prepare("SELECT 2 AS value").get()).toEqual({ value: 2 });
			expect(db.prepare("SELECT 'sql-literal-private' AS value").get()).toEqual({
				value: "sql-literal-private",
			});
		});
		const executions = starts(events).filter((event) => event.statement.stage === "execute");
		expect(executions.map((event) => event.statement.sqlHash)).toEqual([
			hash(sql),
			hash(sql),
			hash("SELECT 2 AS value"),
			hash("SELECT 'sql-literal-private' AS value"),
		]);
		const text = JSON.stringify(events);
		for (const secret of [
			sql,
			"secret-one",
			"secret-two",
			"sql-literal-private",
			config.key,
			process.cwd(),
		])
			expect(text).not.toContain(secret);
		for (const event of events)
			expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThanOrEqual(
				SQL_DIAGNOSTIC_EVENT_BYTES,
			);
	});

	test("connection run/exec and Statement methods preserve results, this and finalize", () => {
		const { reporter, events } = harness();
		const db = database();
		reporter.run(config, requestId, () => {
			reporter.instrument(db);
			db.exec("CREATE TABLE t(value TEXT)");
			db.run("INSERT INTO t VALUES (?)", ["a"]);
			const insert = db.prepare("INSERT INTO t VALUES (?)");
			expect(insert.run("b").changes).toBe(1);
			const statement = db.prepare("SELECT value FROM t ORDER BY value");
			expect(statement.all()).toEqual([{ value: "a" }, { value: "b" }]);
			expect(statement.get()).toEqual({ value: "a" });
			expect(statement.values()).toEqual([["a"], ["b"]]);
			expect([...statement.iterate()]).toEqual([{ value: "a" }, { value: "b" }]);
			const finalize = statement.finalize;
			statement.finalize();
			expect(statement.finalize).toBe(finalize);
			expect(() => statement.get()).toThrow();
		});
		expect(new Set(starts(events).map((event) => event.statement.operation))).toEqual(
			new Set(["prepare", "run", "exec", "all", "get", "values", "iterate"]),
		);
		expect(events.filter((event) => event.phase === "start")).toHaveLength(
			events.filter((event) => event.phase === "end").length,
		);
	});

	test("prepare and execute exceptions are the original objects and leak no error text", () => {
		const { reporter, events, state } = harness();
		const failure = new Error("private-error SELECT secret FROM /home/private/person");
		const nativeStatement = {
			get() {
				expect(this).toBe(nativeStatement);
				throw failure;
			},
		};
		const fake = {
			prepare(text: string) {
				expect(this).toBe(fake);
				if (text === "bad-private-sql") throw failure;
				return nativeStatement;
			},
		};
		reporter.run(config, requestId, () => {
			reporter.instrument(fake);
			for (const work of [() => fake.prepare("bad-private-sql"), () => fake.prepare(sql).get()]) {
				try {
					work();
					throw new Error("Expected original failure");
				} catch (error) {
					expect(error).toBe(failure);
				}
			}
		});
		expect(
			events.filter((event) => event.phase === "end" && event.outcome === "threw"),
		).toHaveLength(2);
		expect(sqlDiagnosticSnapshot(state, 200)).toMatchObject({
			state: "idle",
			recent: { outcome: "threw" },
		});
		expect(JSON.stringify(events)).not.toContain("private-error");
		expect(JSON.stringify(events)).not.toContain("bad-private-sql");
	});

	test("finalize closes an open iteration once and retains the native return/exception", () => {
		const { reporter, events, state } = harness();
		const db = database();
		reporter.run(config, requestId, () => {
			reporter.instrument(db);
			const statement = db.prepare("SELECT 1 AS n UNION ALL SELECT 2");
			const iterator = statement.iterate();
			expect(iterator.next().value).toEqual({ n: 1 });
			expect(sqlDiagnosticSnapshot(state, 100).state).toBe("running");
			expect(statement.finalize()).toBeUndefined();
			expect(sqlDiagnosticSnapshot(state, 100)).toMatchObject({
				state: "idle",
				recent: { outcome: "closed" },
			});
			iterator.return?.();
		});
		expect(
			events.filter((event) => event.phase === "end" && event.statement.stage === "iterate"),
		).toHaveLength(1);
	});

	test("hash and clock failures preserve business work and keep diagnostic error text private", () => {
		const { reporter, events } = harness();
		const failure = new Error("private-crypto-error");
		const hmac = spyOn(crypto, "createHmac").mockImplementation(() => {
			throw failure;
		});
		restores.push(() => hmac.mockRestore());
		expect(
			reporter.run(config, requestId, () =>
				reporter.instrument(database()).query("SELECT 7 AS n").get(),
			),
		).toEqual({ n: 7 });
		expect(events).toMatchObject([{ phase: "coverageLost", reason: "instrumentation" }]);
		expect(JSON.stringify(events)).not.toContain(failure.message);
		hmac.mockRestore();
		const brokenClock = createWorkerSqlDiagnostics(
			() => {},
			() => {
				throw failure;
			},
		);
		expect(
			brokenClock.run(config, requestId, () =>
				brokenClock.instrument(database()).query("SELECT 9 AS n").get(),
			),
		).toEqual({ n: 9 });
	});

	test("iterate keeps the outer statement active through nested consumer SQL and early return", () => {
		const { reporter, events, state } = harness();
		const db = database();
		reporter.run(config, requestId, () => {
			reporter.instrument(db);
			for (const row of db.query("SELECT 1 AS value UNION ALL SELECT 2").iterate()) {
				expect(row).toEqual({ value: 1 });
				const outer = sqlDiagnosticSnapshot(state, 100).current?.id;
				db.query("SELECT 7").get();
				expect(sqlDiagnosticSnapshot(state, 150)).toMatchObject({
					state: "running",
					current: { id: outer, stage: "iterate", ageMs: 50 },
				});
				break;
			}
			expect(sqlDiagnosticSnapshot(state, 200)).toMatchObject({
				state: "idle",
				recent: { operation: "iterate", outcome: "closed" },
			});
		});
		expect(
			events.filter((event) => event.phase === "start" && event.statement.operation === "iterate"),
		).toHaveLength(1);
		expect(state.active).toHaveLength(0);
	});

	test("iterate exhaustion, native next failure and consumer failure preserve iterator cleanup", () => {
		const { reporter, events } = harness();
		const failure = new Error("private-iterator-error");
		let returns = 0;
		const fake = {
			query: () => ({
				iterate: () => ({
					[Symbol.iterator]() {
						return this;
					},
					next() {
						throw failure;
					},
					return() {
						returns++;
						return { done: true, value: undefined };
					},
				}),
			}),
		};
		reporter.run(config, requestId, () => {
			reporter.instrument(fake);
			const iterator = fake.query().iterate();
			expect(() => iterator.next()).toThrow(failure);
			iterator.return();
			const db = reporter.instrument(database());
			expect([...db.query("SELECT 1 AS value UNION ALL SELECT 2").iterate()]).toHaveLength(2);
			expect(() => {
				for (const _ of db.query("SELECT 3").iterate()) throw failure;
			}).toThrow(failure);
		});
		expect(returns).toBe(1);
		expect(
			events
				.filter((event) => event.phase === "end" && event.statement.stage === "iterate")
				.map((event) => (event.phase === "end" ? event.outcome : "")),
		).toEqual(["threw", "exhausted", "closed"]);
		expect(JSON.stringify(events)).not.toContain(failure.message);
	});

	test("cached statements use the active request and execution callsite across await", async () => {
		const events: SqlDiagnosticEvent[] = [];
		const reporter = createWorkerSqlDiagnostics(
			(event) => events.push(event),
			() => 100,
		);
		const db = database();
		let statement!: Statement;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const one = reporter.run(config, "dbr-await-1", async () => {
			reporter.instrument(db);
			statement = db.query(sql);
			await gate;
			return statement.get("one");
		});
		const two = reporter.run(config, "dbr-await-2", () => {
			expect(db.query(sql)).toBe(statement);
			return statement.get("two");
		});
		release();
		expect(await one).toEqual({ value: "one" });
		expect(two).toEqual({ value: "two" });
		const executions = starts(events).filter((event) => event.statement.stage === "execute");
		expect(executions.map((event) => event.requestId)).toEqual(["dbr-await-2", "dbr-await-1"]);
		expect(executions[0].statement.workerSite?.line).not.toBe(
			executions[1].statement.workerSite?.line,
		);
		const count = events.length;
		statement.get("outside");
		expect(events).toHaveLength(count);
	});

	test("nested native query/prepare wrappers and host ends restore the outer SQL", () => {
		const { reporter, state } = harness();
		const statement = {
			get() {
				return 42;
			},
		};
		const fake = {
			prepare() {
				expect(sqlDiagnosticSnapshot(state, 100).current?.operation).toBe("prepare");
				return statement;
			},
			query() {
				expect(sqlDiagnosticSnapshot(state, 100).current?.operation).toBe("query");
				const result = this.prepare();
				expect(sqlDiagnosticSnapshot(state, 100)).toMatchObject({
					state: "running",
					current: { operation: "query" },
				});
				return result;
			},
		};
		reporter.run(config, requestId, () => {
			reporter.instrument(fake);
			expect(fake.query().get()).toBe(42);
		});
		expect(state.active).toHaveLength(0);
	});

	test("oversized SQL is uncollected rather than hashed as a prefix", () => {
		const { reporter, events } = harness();
		const fake = { run: () => 42 };
		reporter.run(config, requestId, () => {
			reporter.instrument(fake);
			Reflect.apply(fake.run, fake, [`SELECT 1${" ".repeat(65_536)}`]);
			Reflect.apply(fake.run, fake, ["来".repeat(30_000)]);
		});
		for (const event of starts(events)) {
			expect(event.statement.hashStatus).toBe("oversize");
			expect(event.statement.sqlHash).toBeUndefined();
		}
	});

	test("128-event budget reserves continuity loss and clears the previous running hash", () => {
		const { reporter, events, state } = harness();
		const db = database();
		reporter.run(config, requestId, () => {
			reporter.instrument(db);
			const stmt = db.query(sql);
			for (let index = 0; index < 200; index++) expect(stmt.get(index)).toEqual({ value: index });
		});
		expect(events).toHaveLength(SQL_DIAGNOSTIC_EVENTS_PER_SECOND);
		expect(events.at(-1)).toMatchObject({ phase: "coverageLost", reason: "rate-limit" });
		expect(sqlDiagnosticSnapshot(state, 100)).toMatchObject({
			state: "unknown",
			reason: "rate-limit",
		});
		expect(sqlDiagnosticSnapshot(state, 100).current).toBeUndefined();
		expect(state.active).toHaveLength(0);
	});

	test("failed diagnostic post leaves business exceptions/results intact and marks loss", () => {
		const events: SqlDiagnosticEvent[] = [];
		let calls = 0;
		const reporter = createWorkerSqlDiagnostics((event) => {
			if (++calls === 2) throw new Error("private-post-error");
			events.push(event);
		});
		const db = database();
		expect(
			reporter.run(config, requestId, () => reporter.instrument(db).query("SELECT 42 AS n").get()),
		).toEqual({ n: 42 });
		expect(events.at(-1)).toMatchObject({ phase: "coverageLost", reason: "post-failed" });
		const state = createHostSqlDiagnosticState(config, false);
		for (const event of events) acceptSqlDiagnosticEvent(state, event, 100);
		expect(sqlDiagnosticSnapshot(state, 200)).toMatchObject({ state: "unknown" });
		expect(sqlDiagnosticSnapshot(state, 200).current).toBeUndefined();
		const broken = createWorkerSqlDiagnostics(() => {
			throw new Error("private-post-error");
		});
		expect(
			broken.run(config, requestId, () =>
				broken.instrument(database()).query("SELECT 5 AS n").get(),
			),
		).toEqual({ n: 5 });
	});

	test("unwrappable methods and too many simultaneous iterators lose coverage with bounded state", () => {
		const { reporter, events, state } = harness();
		const frozen = Object.freeze({ run: () => 42 });
		expect(reporter.run(config, requestId, () => reporter.instrument(frozen).run())).toBe(42);
		expect(events.at(-1)).toMatchObject({ phase: "coverageLost", reason: "instrumentation" });
		expect(state.active).toHaveLength(0);
		const next = harness();
		const db = database();
		next.reporter.run(config, requestId, () => {
			next.reporter.instrument(db);
			const iterators = Array.from({ length: 40 }, () => db.prepare("SELECT 1").iterate());
			for (const iterator of iterators) iterator.return?.();
		});
		expect(next.events.some((event) => event.phase === "coverageLost")).toBe(true);
		expect(next.state.active).toHaveLength(0);
	});

	test("cross-request iterator use is explicitly unknown rather than reassigned", () => {
		const events: SqlDiagnosticEvent[] = [];
		const reporter = createWorkerSqlDiagnostics((event) => events.push(event));
		const db = database();
		let iterator!: IterableIterator<unknown>;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = reporter.run(config, "dbr-iter-1", async () => {
			reporter.instrument(db);
			iterator = db.query("SELECT 1").iterate();
			await gate;
		});
		reporter.run(config, "dbr-iter-2", () => {
			iterator.next();
			iterator.return?.();
		});
		release();
		return first.then(() => {
			expect(
				events.filter((event) => event.phase === "coverageLost").map((event) => event.requestId),
			).toEqual(["dbr-iter-1", "dbr-iter-2"]);
		});
	});

	test("sites contain only a relative code path, function and bounded line/column", () => {
		expect(
			captureSqlDiagnosticSite(
				"Error: private\n    at safeCall (/private/home/person/server/services/read.ts:12:7)\n    at ignored (/private/token.ts:1:1)",
			),
		).toEqual({ file: "server/services/read.ts", line: 12, column: 7, fn: "safeCall" });
		expect(
			captureSqlDiagnosticSite("Error: secret\n    at private (/home/person/secrets.ts:1:1)"),
		).toBeUndefined();
		expect(
			captureSqlDiagnosticSite("Error: secret\n    at private (/server/../secret.ts:1:1)"),
		).toBeUndefined();
	});

	test("compiled and bridge-only stacks are explicitly unavailable without leaking paths", () => {
		const compiled = "Error: private\n    at safeCall (/$bunfs/root/narrafork:120:8)";
		expect(captureSqlDiagnosticSite(compiled, "host")).toBeUndefined();
		const bridges =
			"Error: private\n    at nativeResult (/private/server/db/worker-read.ts:272:1)\n    at readNativeRows (/private/server/db/worker-read.ts:300:1)";
		expect(captureSqlDiagnosticSite(bridges, "host")).toBeUndefined();
		expect(captureSqlDiagnosticSite(bridges, "worker")?.file).toBe("server/db/worker-read.ts");
		const state = createHostSqlDiagnosticState(config, false);
		state.hostSite = captureSqlDiagnosticSite(compiled, "host");
		expect(sqlDiagnosticSnapshot(state, 100)).toMatchObject({ hostSiteStatus: "unavailable" });
		expect(JSON.stringify(sqlDiagnosticSnapshot(state, 100))).not.toContain("$bunfs");
	});

	test("host rejects malicious/oversized/invalid events and missing or duplicate sequence", () => {
		const valid: SqlDiagnosticEvent = {
			type: "sqlDiagnostic",
			requestId,
			session: config.session,
			sequence: 1,
			phase: "start",
			statement: {
				id: 1,
				stage: "execute",
				operation: "get",
				hashStatus: "collected",
				sqlHash: hash(sql),
			},
		};
		expect(isSqlDiagnosticEvent(valid)).toBe(true);
		for (const malformed of [
			{ ...valid, sql: "private" },
			{ ...valid, sequence: Infinity },
			{ ...valid, session: "private" },
			{
				...valid,
				statement: {
					...valid.statement,
					workerSite: { file: "/private/server/test.ts", line: 1, column: 1 },
				},
			},
			{
				...valid,
				statement: {
					...valid.statement,
					workerSite: { file: "server/test.ts", line: 1, column: 1, fn: "private".repeat(1000) },
				},
			},
			{ ...valid, statement: { ...valid.statement, hashStatus: "oversize" } },
			{ ...valid, phase: "end", durationMs: -1, outcome: "threw" },
		]) {
			expect(isSqlDiagnosticEvent(malformed)).toBe(false);
			const state = createHostSqlDiagnosticState(config, false);
			expect(acceptSqlDiagnosticEvent(state, malformed, 100)).toBe(false);
			expect(sqlDiagnosticSnapshot(state, 100).state).toBe("unknown");
		}
		for (const sequence of [1, 3]) {
			const state = createHostSqlDiagnosticState(config, false);
			acceptSqlDiagnosticEvent(state, valid, 100);
			expect(acceptSqlDiagnosticEvent(state, { ...valid, sequence }, 200)).toBe(false);
			expect(sqlDiagnosticSnapshot(state, 200)).toMatchObject({
				state: "unknown",
				reason: "sequence",
			});
			expect(sqlDiagnosticSnapshot(state, 200).current).toBeUndefined();
		}
		expect(sqlDiagnosticSnapshot(createHostSqlDiagnosticState(config, true), 100)).toMatchObject({
			coverage: "postgres-uncovered",
			state: "uncovered",
		});
	});

	test("real isolated worker posts execute start before a bounded native SQLite call is released", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nf-sql-start-worker-"));
		directories.push(dir);
		const path = join(dir, "worker.ts");
		writeFileSync(
			path,
			`
			import { Database } from "bun:sqlite";
			import { parentPort } from "node:worker_threads";
			import { createWorkerSqlDiagnostics } from ${JSON.stringify(new URL("../sql-diagnostics.ts", import.meta.url).href)};
			parentPort.once("message", ({ config, shared }) => {
				const gate = new Int32Array(shared);
				const db = new Database(":memory:");
				const prepare = db.prepare;
				db.prepare = function (...args) {
					const statement = Reflect.apply(prepare, this, args);
					const get = statement.get;
					statement.get = function (...binds) {
						Atomics.store(gate, 0, 1);
						Atomics.wait(gate, 0, 1, 2000);
						return Reflect.apply(get, this, binds);
					};
					return statement;
				};
				const reporter = createWorkerSqlDiagnostics(event => parentPort.postMessage(event));
				const result = reporter.run(config, "dbr-native-1", () => reporter.instrument(db).prepare("SELECT 42 AS n").get());
				parentPort.postMessage({ type: "done", result });
				db.close(); parentPort.close();
			});
		`,
		);
		const shared = new SharedArrayBuffer(4);
		const gate = new Int32Array(shared);
		const worker = new Worker(path);
		let receive!: () => void;
		const started = new Promise<void>((resolve) => {
			receive = resolve;
		});
		let settled = false;
		const result = new Promise<unknown>((resolve, reject) => {
			worker.on("error", reject);
			worker.on("message", (message) => {
				if (
					isSqlDiagnosticEvent(message) &&
					message.phase === "start" &&
					message.statement.stage === "execute"
				)
					receive();
				if (message.type === "done") {
					settled = true;
					resolve(message.result);
				}
			});
		});
		worker.postMessage({ config, shared });
		try {
			await Promise.race([started, result]);
			expect(settled).toBe(false);
			for (let tries = 0; tries < 200 && Atomics.load(gate, 0) === 0; tries++) await Bun.sleep(1);
			expect(Atomics.load(gate, 0)).toBe(1);
			expect(settled).toBe(false);
			Atomics.store(gate, 0, 2);
			Atomics.notify(gate, 0);
			expect(await result).toEqual({ n: 42 });
		} finally {
			Atomics.store(gate, 0, 2);
			Atomics.notify(gate, 0);
			await worker.terminate();
		}
	}, 5000);

	test.each([
		"post-failure",
		"quota",
	] as const)("shared continuity marks the host unknown while the next native SQL is held (%s)", async (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "nf-sql-continuity-worker-"));
		directories.push(dir);
		const path = join(dir, "worker.ts");
		writeFileSync(
			path,
			`
			import { Database } from "bun:sqlite";
			import { parentPort } from "node:worker_threads";
			import { createWorkerSqlDiagnostics } from ${JSON.stringify(new URL("../sql-diagnostics.ts", import.meta.url).href)};
			parentPort.once("message", ({ first, second, shared, mode }) => {
				const gate = new Int32Array(shared);
				const db = new Database(":memory:");
				const native = db.run;
				let hold = false;
				db.run = function (...args) {
					if (hold) { Atomics.store(gate, 0, 1); Atomics.wait(gate, 0, 1, 5000); }
					return Reflect.apply(native, this, args);
				};
				let posts = 0;
				const reporter = createWorkerSqlDiagnostics(event => {
					posts++;
					if (mode === "post-failure" && (posts === 2 || posts === 3)) throw new Error("private-diagnostic-post");
					parentPort.postMessage(event);
				});
				if (mode === "post-failure") {
					reporter.run(first, "dbr-gap-1", () => {
						reporter.instrument(db); db.run("SELECT 1"); hold = true; db.run("SELECT 2");
					});
				} else {
					reporter.run(first, "dbr-gap-1", () => {
						reporter.instrument(db); for (let index = 0; index < 64; index++) db.run("SELECT 1");
					});
					hold = true;
					reporter.run(second, "dbr-gap-2", () => db.run("SELECT 2"));
				}
				parentPort.postMessage({ type: "done" }); db.close(); parentPort.close();
			});
		`,
		);
		const first = createSqlDiagnosticConfig(config);
		const second = createSqlDiagnosticConfig(config);
		expect(first.continuity).not.toBe(second.continuity);
		const firstState = createHostSqlDiagnosticState(first, false);
		const secondState = createHostSqlDiagnosticState(second, false);
		const shared = new SharedArrayBuffer(4);
		const gate = new Int32Array(shared);
		const worker = new Worker(path);
		const events: SqlDiagnosticEvent[] = [];
		let settled = false;
		const result = new Promise<void>((resolve, reject) => {
			worker.on("error", reject);
			worker.on("message", (message) => {
				if (isSqlDiagnosticEvent(message)) {
					events.push(message);
					acceptSqlDiagnosticEvent(
						message.requestId === "dbr-gap-1" ? firstState : secondState,
						message,
						Date.now(),
					);
				}
				if (message.type === "done") {
					settled = true;
					resolve();
				}
			});
		});
		worker.postMessage({ first, second, shared, mode });
		try {
			const deadline = Date.now() + 3000;
			while (
				(Atomics.load(gate, 0) === 0 || events.length < (mode === "quota" ? 128 : 1)) &&
				Date.now() < deadline
			)
				await Bun.sleep(1);
			expect(Atomics.load(gate, 0)).toBe(1);
			expect(settled).toBe(false);
			const snapshot = sqlDiagnosticSnapshot(
				mode === "post-failure" ? firstState : secondState,
				Date.now(),
			);
			expect(snapshot).toMatchObject({
				state: "unknown",
				reason: mode === "post-failure" ? "post-failed" : "rate-limit",
			});
			expect(snapshot.current).toBeUndefined();
			if (mode === "quota") {
				expect(events).toHaveLength(128);
				expect(events.filter((event) => event.requestId === "dbr-gap-2")).toHaveLength(0);
			} else expect(events).toHaveLength(1);
			Atomics.store(gate, 0, 2);
			Atomics.notify(gate, 0);
			await result;
		} finally {
			Atomics.store(gate, 0, 2);
			Atomics.notify(gate, 0);
			await worker.terminate();
		}
	}, 8000);

	test("missing or malformed shared continuity is explicitly unknown", () => {
		for (const continuity of [
			undefined,
			new SharedArrayBuffer(0),
			new SharedArrayBuffer(8),
			new ArrayBuffer(4),
		]) {
			const state = createHostSqlDiagnosticState(
				{ ...config, continuity } as SqlDiagnosticConfig,
				false,
			);
			expect(sqlDiagnosticSnapshot(state, 100)).toMatchObject({
				state: "unknown",
				reason: "continuity-unavailable",
			});
		}
	});

	test("existing SQL trace output/counts match with the additional wrapper enabled", async () => {
		const run = async (enabled: boolean) => {
			const dir = mkdtempSync(join(tmpdir(), "nf-sql-diagnostic-trace-"));
			directories.push(dir);
			configureSqlTraceForTest({ mode: "full", dir });
			const { reporter } = harness();
			const db = instrumentSqliteConnection(database());
			await reporter.run(enabled ? config : undefined, requestId, () =>
				withSqlTraceSpan("job", "compat", undefined, () => {
					reporter.instrument(db);
					expect(db.query(sql).get("private-bind")).toEqual({ value: "private-bind" });
					expect([...db.query("SELECT 1 AS n UNION ALL SELECT 2").iterate()]).toHaveLength(2);
				}),
			);
			flushSqlTraceSync();
			const records = readdirSync(dir)
				.filter((name) => name.endsWith(".ndjson"))
				.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			configureSqlTraceForTest({ mode: "off", dir });
			return records;
		};
		const baseline = await run(false);
		const wrapped = await run(true);
		const shape = (records: Array<Record<string, unknown>>) =>
			records
				.filter((record) => record.t === "sql")
				.map((record) => ({ op: record.op, rows: record.rows, h: record.h }));
		expect(shape(wrapped)).toEqual(shape(baseline));
		expect(baseline.find((record) => record.t === "span" && record.label === "compat")?.n).toBe(2);
		expect(wrapped.find((record) => record.t === "span" && record.label === "compat")?.n).toBe(2);
		expect(JSON.stringify(wrapped)).not.toContain("private-bind");
	});
});
