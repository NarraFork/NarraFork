import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SqlExecutionDiagnostics, type SqlExecutionRecord } from "../lib/sql-execution-diagnostics";
import { installSqliteExecutionDiagnostics } from "./sqlite-execution-diagnostics";

const rows = sqliteTable("diagnostic_rows", { id: integer().primaryKey(), body: text() });
function fixture(clock?: () => number) {
	const native = new Database(":memory:");
	native.run("create table diagnostic_rows (id integer primary key, body text)");
	const records: SqlExecutionRecord[] = [];
	const diagnostics = new SqlExecutionDiagnostics((record) => records.push(record), clock);
	const db = installSqliteExecutionDiagnostics(drizzle(native, { schema: { rows } }), diagnostics);
	return { native, records, diagnostics, db };
}

describe("controlled SQLite prepared execution diagnostics", () => {
	test("async scopes preserve promise identity, settlement order and rejection", async () => {
		const diagnostics = new SqlExecutionDiagnostics(() => {});
		const events: string[] = [];
		const original = Promise.resolve(1);
		const observed = diagnostics.scope("request", () => original);
		expect(observed).toBe(original);
		void observed.then(() => events.push("caller"));
		queueMicrotask(() => events.push("marker"));
		await observed;
		expect(events).toEqual(["caller", "marker"]);
		const error = new Error("original failure");
		const rejected = Promise.reject(error);
		expect(diagnostics.scope("request", () => rejected)).toBe(rejected);
		await expect(rejected).rejects.toBe(error);
	});

	test("worker completion captures correlation, independent clocks and exclusive counters", async () => {
		const records: SqlExecutionRecord[] = [];
		const diagnostics = new SqlExecutionDiagnostics((record) => records.push(record));
		let complete!: ReturnType<SqlExecutionDiagnostics["beginReadWorkerDiagnostic"]>;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scope = diagnostics.scope(
			"request",
			async () => {
				diagnostics.execute("select", "all", () => 1);
				complete = diagnostics.beginReadWorkerDiagnostic();
				await waiting;
			},
			"request-a",
		);
		const stats = {
			elapsedMs: 75,
			workerDurationMs: 90,
			rows: 3,
			bytes: 42,
			status: "ok" as const,
			task: "selectRowsV1",
		};
		complete(stats);
		complete(stats);
		release();
		await scope;
		expect(records).toHaveLength(3);
		expect(records[0]).toMatchObject({
			executionLocation: "read-worker",
			requestId: "request-a",
			elapsedMs: 75,
			workerDurationMs: 90,
			rows: 3,
			bytes: 42,
		});
		expect(
			records
				.filter((record) => record.kind === "sql-execution-summary")
				.map((record) => [record.executionLocation, record.count]),
		).toEqual([
			["read-worker", 1],
			["main-sync", 1],
		]);
		expect(records.every((record) => !("queueMs" in record))).toBe(true);
	});

	test("fixed business labels retain correlation, timing semantics and existing event quota", () => {
		const records: SqlExecutionRecord[] = [];
		const diagnostics = new SqlExecutionDiagnostics(
			(record) => records.push(record),
			() => 0,
		);
		expect(diagnostics.correlation()).toEqual({ requestId: null, contextId: null });
		diagnostics.scope(
			"request",
			() => {
				const correlation = diagnostics.correlation();
				for (let i = 0; i < 40; i++)
					diagnostics.beginReadWorkerDiagnostic("subagent.exact.effects")({
						elapsedMs: 100,
						workerDurationMs: 90,
						queueWaitMs: 5,
						acquireMs: 3,
						workerActiveMs: 20,
						workerAckWaitMs: 70,
						consumeMs: 60,
						task: "selectRowsV1",
						status: "ok",
					});
				expect(records).toHaveLength(30);
				expect(records[0]).toMatchObject({
					...correlation,
					querySite: "subagent.exact.effects",
					queueWaitMs: 5,
					acquireMs: 3,
					consumeMs: 60,
					workerActiveMs: 20,
					workerAckWaitMs: 70,
				});
				expect(records[0]?.timing).toContain("not-pure-sql");
				expect(records[0]?.timing).toContain("overlaps-ack");
			},
			"message-request",
		);
		expect(records[0]?.requestId).toBe("message-request");
		expect(records[0]?.contextId).toBe(records.at(-1)?.contextId ?? null);
		const privateRecords: SqlExecutionRecord[] = [];
		const privateDiagnostics = new SqlExecutionDiagnostics((record) => privateRecords.push(record));
		privateDiagnostics.beginReadWorkerDiagnostic("/private/path SELECT body")({
			elapsedMs: 55,
			queueWaitMs: 9,
			consumeMs: 10,
			task: "selectRowsV1",
			status: "ok",
		});
		expect(privateRecords[0]).not.toHaveProperty("querySite");
		expect(privateRecords[0]).not.toHaveProperty("queueWaitMs");
		expect(JSON.stringify(privateRecords)).not.toMatch(/private|SELECT|body/);
	});

	test("worker fast success is aggregated; failures and cancellation are rate limited and redacted", () => {
		const records: SqlExecutionRecord[] = [];
		const diagnostics = new SqlExecutionDiagnostics(
			(record) => records.push(record),
			() => 0,
		);
		const complete = () => diagnostics.beginReadWorkerDiagnostic();
		complete()({ elapsedMs: 2, status: "ok", task: "selectRowsV1" });
		expect(records).toHaveLength(0);
		for (let i = 0; i < 100; i++)
			complete()({
				elapsedMs: 2,
				status: i % 2 ? "error" : "cancelled",
				task: "secret SQL /private/path",
			});
		expect(records).toHaveLength(30);
		expect(records[0]).toMatchObject({
			status: "cancelled",
			task: "unknown",
			workerDurationMs: null,
		});
		expect(JSON.stringify(records)).not.toMatch(/secret|private/);
	});
	test("worker summaries retain unknown sizes and fixed domain task identities", () => {
		const records: SqlExecutionRecord[] = [];
		const diagnostics = new SqlExecutionDiagnostics((record) => records.push(record));
		diagnostics.scope("request", () => {
			for (const task of ["worktree-lifecycle-read-v1", "projectArchiveReadV1"]) {
				diagnostics.beginReadWorkerDiagnostic()({
					elapsedMs: 51,
					rows: 0,
					bytes: 0,
					task,
					status: "ok",
				});
			}
			diagnostics.beginReadWorkerDiagnostic()({ elapsedMs: 1, task: "selectRowsV1", status: "ok" });
			diagnostics.beginReadWorkerDiagnostic()({
				elapsedMs: 1,
				rows: 4,
				bytes: 32,
				task: "selectRowsV1",
				status: "ok",
			});
		});
		expect(records.slice(0, 2).map((record) => record.task)).toEqual([
			"worktree-lifecycle-read-v1",
			"projectArchiveReadV1",
		]);
		expect(records.at(-1)).toMatchObject({
			count: 4,
			rows: null,
			bytes: null,
			layer: "worker-task-wall-including-mapping-and-ack-wait",
		});
	});

	test("native transaction classification covers commits, nested rollback and thrown callbacks", () => {
		let time = 0;
		const { native, db, records, diagnostics } = fixture(() => time);
		try {
			db.insert(rows).values({ id: 1 }).run();
			const query = () =>
				db
					.select({
						value: sql`1`.mapWith(() => {
							time += 60;
							return 1;
						}),
					})
					.from(rows)
					.all();
			query();
			db.transaction((tx) => {
				query();
				expect(() =>
					tx.transaction((nested) => {
						query();
						nested.rollback();
					}),
				).toThrow();
				query();
			});
			query();
			const error = new Error("original transaction error");
			expect(() =>
				db.transaction(() => {
					query();
					throw error;
				}),
			).toThrow(error);
			query();
			diagnostics.execute("select", "all", () => {
				time += 60;
			});
			expect(records.map((record) => record.executionContext)).toEqual([
				"independent",
				"transaction",
				"transaction",
				"transaction",
				"independent",
				"transaction",
				"independent",
				"unknown",
			]);
			expect(native.inTransaction).toBe(false);
		} finally {
			native.close();
		}
	});

	test("await/then, prepared execute, all/get/values/run and repeated preparation count once", async () => {
		const { native, records, diagnostics, db } = fixture();
		try {
			installSqliteExecutionDiagnostics(db, diagnostics);
			await diagnostics.scope("background-task.listLegacyRows", async () => {
				expect(db.insert(rows).values({ id: 1, body: "private-body" }).run()).toMatchObject({
					changes: 1,
				});
				expect(await db.select().from(rows)).toEqual([{ id: 1, body: "private-body" }]);
				expect(
					await db
						.select()
						.from(rows)
						.then((result) => result.length),
				).toBe(1);
				expect(db.select().from(rows).all()).toHaveLength(1);
				expect(db.select().from(rows).get()?.id).toBe(1);
				expect(db.select().from(rows).values()).toEqual([[1, "private-body"]]);
				const prepared = db.select().from(rows).prepare();
				expect(await prepared.execute()).toHaveLength(1);
				expect(prepared.all()).toHaveLength(1);
				expect(prepared.all()).toHaveLength(1);
				expect(db.all(sql`select id from diagnostic_rows`)).toEqual([{ id: 1 }]);
				expect(db.get(sql`select id from diagnostic_rows`)).toEqual([1]);
				expect(db.values(sql`select id from diagnostic_rows`)).toEqual([[1]]);
				db.run(sql`update diagnostic_rows set body = ${"private-parameter"}`);
				expect(await db.query.rows.findMany()).toHaveLength(1);
			});
			expect(records).toHaveLength(1);
			expect(records[0]?.count).toBe(14);
			expect(JSON.stringify(records)).not.toContain("private-");
		} finally {
			native.close();
		}
	});

	test("reinitialization updates the collector for existing prepared queries without double wrapping", () => {
		const { native, records, diagnostics, db } = fixture();
		try {
			const prepared = db.select().from(rows).prepare();
			const fresh: SqlExecutionRecord[] = [];
			const next = new SqlExecutionDiagnostics((record) => fresh.push(record));
			installSqliteExecutionDiagnostics(db, next);
			next.scope("background-task.listLegacyRows", () => prepared.all());
			expect(fresh[0]?.count).toBe(1);
			expect(records).toHaveLength(0);
			installSqliteExecutionDiagnostics(db, diagnostics);
		} finally {
			native.close();
		}
	});

	test("transactions preserve commits, nested rollback and errors, and restore reentry depth", () => {
		const { native, records, diagnostics, db } = fixture();
		try {
			diagnostics.scope("narrator-messages.resolveAggregateScopeTx", () => {
				db.transaction((tx) => {
					tx.insert(rows).values({ id: 1 }).run();
					expect(() =>
						tx.transaction((nested) => {
							nested.insert(rows).values({ id: 2 }).run();
							nested.rollback();
						}),
					).toThrow();
				});
				expect(() =>
					db.transaction((tx) => {
						tx.insert(rows).values({ id: 3 }).run();
						throw new Error("original");
					}),
				).toThrow("original");
				const prepared = db.insert(rows).values({ id: 1 }).prepare();
				expect(() => prepared.run()).toThrow();
				expect(() => prepared.run()).toThrow();
				expect(db.select().from(rows).all()).toEqual([{ id: 1, body: null }]);
			});
			expect(records[0]?.count).toBe(8); // includes savepoint/rollback-to, not native BEGIN/COMMIT.
			expect(records[0]?.errors).toBe(2);
		} finally {
			native.close();
		}
	});

	test("concurrent ALS scopes isolate request IDs and nested background counts", async () => {
		const { native, records, diagnostics, db } = fixture();
		try {
			await Promise.all(
				["first", "second"].map((id) =>
					diagnostics.scope(
						"request",
						async () => {
							await Promise.resolve();
							db.select().from(rows).all();
							await diagnostics.scope("background-task.listPageByParent", async () => {
								await Promise.resolve();
								db.select().from(rows).all();
							});
						},
						id,
					),
				),
			);
			expect(records).toHaveLength(4);
			for (const id of ["first", "second"]) {
				expect(records.filter((record) => record.requestId === id)).toHaveLength(2);
			}
			expect(records.every((record) => record.count === 1)).toBe(true);
		} finally {
			native.close();
		}
	});

	test("slow background query and mapper emit immediately without HTTP and redact SQL/binds", () => {
		let time = 0;
		const { native, records, diagnostics, db } = fixture(() => time);
		try {
			db.insert(rows).values({ id: 1 }).run();
			diagnostics.scope("background-occupancy.scanNarrators", () => {
				expect(
					db
						.select({
							value: sql`${"secret /private/path"}`.mapWith((value) => {
								time += 55;
								return value;
							}),
						})
						.from(rows)
						.get(),
				).toEqual({ value: "secret /private/path" });
				expect(records[0]?.kind).toBe("sql-execution-slow");
				expect(records[0]?.durationMs).toBe(55);
				expect(records[0]?.requestId).toBeNull();
				expect(records[0]?.site).toBe("background-occupancy.scanNarrators");
				db.select({
					delayed: sql`1`.mapWith(() => {
						time += 60;
						return 1;
					}),
				})
					.from(rows)
					.all();
			});
			expect(
				records
					.filter((record) => record.kind === "sql-execution-slow")
					.map((record) => record.durationMs),
			).toEqual([55, 60]);
			expect(JSON.stringify(records)).not.toMatch(
				/secret|private|diagnostic_delay|select diagnostic/,
			);
			expect(records[0]?.startMs).toBe(0);
			expect(records[0]?.endMs).toBe(55);
		} finally {
			native.close();
		}
	});

	test("real isolated slow SQL has a standalone event before its background scope finishes", () => {
		const { native, records, diagnostics, db } = fixture();
		try {
			diagnostics.scope("background-task.listLegacyRows", () => {
				const result = db.values(
					sql`with recursive n(x) as (select 1 union all select x + 1 from n where x < 2000000) select sum(x) from n`,
				);
				expect(result).toEqual([[2000001000000]]);
				expect(records[0]?.kind).toBe("sql-execution-slow");
				expect(records[0]?.durationMs).toBeGreaterThanOrEqual(50);
				expect(records[0]?.site).toBe("background-task.listLegacyRows");
				expect(records[0]?.requestId).toBeNull();
			});
		} finally {
			native.close();
		}
	});

	test("quotas bound output and recover next minute; unknown scopes remain visible", () => {
		let time = 0;
		const records: SqlExecutionRecord[] = [];
		const diagnostics = new SqlExecutionDiagnostics(
			(record) => records.push(record),
			() => time,
		);
		for (let i = 0; i < 100; i++)
			diagnostics.scope("background-task.listLegacyRows", () =>
				diagnostics.execute("select", "all", () => {
					time += 51;
				}),
			);
		expect(records).toHaveLength(90);
		time += 60_000;
		diagnostics.execute("select", "values", () => {
			time += 51;
		});
		expect(records.at(-1)?.site).toBe("unknown");
		expect(records.at(-1)?.suppressed).toBeGreaterThan(0);
	});

	test("Postgres-like handles are untouched and diagnostic sink failure cannot replace errors", () => {
		const postgres = { session: { prepareQuery: () => "pg" } };
		expect(installSqliteExecutionDiagnostics(postgres)).toBe(postgres);
		expect(postgres.session.prepareQuery()).toBe("pg");
		let time = 0;
		const diagnostics = new SqlExecutionDiagnostics(
			() => {
				throw new Error("sink");
			},
			() => time,
		);
		expect(() =>
			diagnostics.execute("select", "all", () => {
				time += 51;
				throw new Error("original");
			}),
		).toThrow("original");
	});
});
