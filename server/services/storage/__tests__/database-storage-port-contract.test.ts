/**
 * The database-storage capability's contract, verified against real SQLite and against a second,
 * non-SQLite implementation of the same port.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * "Measure the database, or say you cannot" is the whole capability, and the interesting half is
 * the second clause:
 *
 *   - a backend that CAN measure returns a positive total, serializable detail, and a truthful
 *     `incomplete` flag;
 *   - a backend that CANNOT rejects with `DatabaseStorageUnsupportedError` — never an empty
 *     category list, never a zero total. That distinction is the reason the error type exists: a
 *     storage page rendering `0 B` for a multi-gigabyte database is not a degraded answer, it is a
 *     wrong one, and an operator acts on it;
 *   - cancellation and budget exhaustion are DIFFERENT failures, because one was requested and
 *     the other is a problem to report;
 *   - the report respects its output ceilings, and says so when it had to trim.
 *
 * WHY TWO BACKENDS
 * ----------------
 * A contract asserted against one implementation cannot show that the port is a contract at all.
 * The in-memory backends here share no storage code with the SQLite one; the unsupported one
 * exists specifically so "unsupported" is exercised as a real code path rather than as prose in a
 * doc comment — today's SQLite adapter can never take it.
 *
 * ISOLATION: the SQLite backend runs against `tests/preload`'s isolated NarraFork home. No real
 * database is touched, and no worker is spawned unless the pool is available in this environment.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type DatabaseStoragePort,
	type DatabaseStorageReport,
	DatabaseStorageScanCancelledError,
	DatabaseStorageScanTimedOutError,
	DatabaseStorageUnsupportedError,
	DEFAULT_DATABASE_STORAGE_REPORT_LIMITS,
	DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS,
	enforceReportLimits,
	runWithScanBudget,
} from "../database-storage-port";
import { sqliteDatabaseStoragePort } from "../sqlite-database-storage";
import { databaseStoragePort } from "../store";

// ─────────────────────────────────────────────────────────────────────────────
// Backend 2/3: the same port with no SQLite anywhere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A working non-SQLite backend, standing in for a future PostgreSQL adapter.
 *
 * Reports its own shape of detail (no pages, no freelist), which is the point: the port promises a
 * byte total and serializable detail, not SQLite's accounting model.
 *
 * It routes through `runWithScanBudget` exactly as the SQLite adapter does, because that is the
 * adapter's OBLIGATION rather than a convenience — an earlier revision of this backend measured
 * directly and happily returned a complete report for a call whose budget had already expired,
 * which is how "this call always settles inside its budget" degrades into a promise only one
 * backend keeps. The helper lives in the port so both adapters share one definition of the rule
 * while sharing no storage code.
 */
function createMeasurableBackend(): DatabaseStoragePort {
	return {
		capabilities: {
			backend: "in-memory",
			breakdown: true,
			// Deliberately false: this backend reclaims space online and has nothing to report here.
			// The contract test below checks that a false flag means "says nothing", not "says zero".
			freeSpaceAccounting: false,
			cleanupCandidates: false,
			offRequestThreadScan: true,
		},
		async scanBreakdown(options = {}) {
			const budgetMs = options.budgetMs ?? DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS;
			return runWithScanBudget(budgetMs, options.signal, async (linked) => {
				const tables = ["relation_a", "relation_b", "relation_c"];
				for (const [index, name] of tables.entries()) {
					if (linked.aborted) throw new DatabaseStorageScanCancelledError();
					options.onProgress?.({ done: index + 1, total: tables.length, tableName: name });
				}
				return {
					sizeBytes: 4_096 * 25,
					details: { relations: tables.length, topTables: tables.map((name) => ({ name })) },
					incomplete: false,
				};
			});
		},
	};
}

/** A backend that cannot answer. The whole reason `DatabaseStorageUnsupportedError` exists. */
function createUnsupportedBackend(): DatabaseStoragePort {
	return {
		capabilities: {
			backend: "unsupported-stub",
			breakdown: false,
			freeSpaceAccounting: false,
			cleanupCandidates: false,
			offRequestThreadScan: false,
		},
		async scanBreakdown() {
			throw new DatabaseStorageUnsupportedError("unsupported-stub", "breakdown");
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The contract, run against every backend that claims it can measure
// ─────────────────────────────────────────────────────────────────────────────

const measurableBackends: Array<{ name: string; port: DatabaseStoragePort }> = [
	{ name: "sqlite (production adapter)", port: sqliteDatabaseStoragePort },
	{ name: "in-memory (stand-in for a second dialect)", port: createMeasurableBackend() },
];

for (const backend of measurableBackends) {
	describe(`DatabaseStoragePort contract — ${backend.name}`, () => {
		test("reports capabilities with a named backend and a measurable breakdown", () => {
			const capabilities = backend.port.capabilities;
			expect(capabilities.backend.length).toBeGreaterThan(0);
			expect(capabilities.breakdown).toBe(true);
			expect(typeof capabilities.offRequestThreadScan).toBe("boolean");
		});

		test("measures a positive total with serializable detail", async () => {
			const report = await backend.port.scanBreakdown();

			expect(report.sizeBytes).toBeGreaterThan(0);
			expect(typeof report.incomplete).toBe("boolean");
			// Plain data, by contract: a handle or a lazy accessor would not survive this.
			expect(() => JSON.stringify(report.details)).not.toThrow();
			expect(JSON.parse(JSON.stringify(report.details))).toEqual(report.details);
		}, 120_000);

		test("reports free-space accounting if and only if it claims the capability", async () => {
			// The falsifiable half of the capability flags: a backend must not advertise page-level
			// free-space accounting it does not deliver, nor silently deliver it while denying it.
			const { freeSpaceAccounting } = backend.port.capabilities;
			const report = await backend.port.scanBreakdown();
			const hasFreelist = "freelistBytes" in report.details;
			expect(hasFreelist).toBe(freeSpaceAccounting);
		}, 120_000);

		test("reports cleanup candidates if and only if it claims the capability", async () => {
			const { cleanupCandidates } = backend.port.capabilities;
			const report = await backend.port.scanBreakdown();
			expect("cleanupCandidates" in report.details).toBe(cleanupCandidates);
		}, 120_000);

		test("streams progress that never exceeds its own total", async () => {
			const seen: Array<{ done: number; total: number; tableName: string }> = [];
			await backend.port.scanBreakdown({ onProgress: (progress) => seen.push(progress) });

			// Progress is coalesced by callers, so the exact count is not part of the contract —
			// but every event that IS delivered has to be internally coherent.
			for (const progress of seen) {
				expect(progress.done).toBeGreaterThan(0);
				expect(progress.done).toBeLessThanOrEqual(progress.total);
				expect(progress.tableName.length).toBeGreaterThan(0);
			}
		}, 120_000);

		test("an already-aborted signal is a cancellation, not a zeroed report", async () => {
			const controller = new AbortController();
			controller.abort();

			// The failure mode this rules out: returning `{ sizeBytes: 0 }` for a cancelled scan,
			// which the storage page would render as a measurement.
			await expect(
				backend.port.scanBreakdown({ signal: controller.signal }),
			).rejects.toBeInstanceOf(DatabaseStorageScanCancelledError);
		});

		test("an exhausted budget is a timeout, distinct from a cancellation", async () => {
			// `budgetMs: 0` is "the budget is already gone", which must not be silently treated as
			// "no budget" — that is how an unbounded scan slips back in.
			const failure = await backend.port.scanBreakdown({ budgetMs: 0 }).catch((error) => error);

			expect(failure).toBeInstanceOf(DatabaseStorageScanTimedOutError);
			// Cancellation and timeout mean opposite things to a caller (asked to stop vs. failed),
			// so one must never be an instance of the other.
			expect(failure).not.toBeInstanceOf(DatabaseStorageScanCancelledError);
		}, 30_000);
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Unsupported is an explicit refusal
// ─────────────────────────────────────────────────────────────────────────────

describe("an unsupported backend refuses explicitly", () => {
	const port = createUnsupportedBackend();

	test("rejects with the unsupported error instead of an empty result", async () => {
		const failure = await port.scanBreakdown().catch((error) => error);

		expect(failure).toBeInstanceOf(DatabaseStorageUnsupportedError);
		expect(failure.code).toBe("DATABASE_STORAGE_UNSUPPORTED");
		expect(failure.backend).toBe("unsupported-stub");
		expect(failure.capability).toBe("breakdown");
	});

	test("its capability flag agrees with its behaviour", async () => {
		// A backend claiming `breakdown: false` while returning a report — or the reverse — would
		// make the flags unusable for gating anything.
		expect(port.capabilities.breakdown).toBe(false);
		await expect(port.scanBreakdown()).rejects.toBeInstanceOf(DatabaseStorageUnsupportedError);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The budget, on its own
// ─────────────────────────────────────────────────────────────────────────────

describe("runWithScanBudget", () => {
	test("passes a successful result through untouched", async () => {
		const result = await runWithScanBudget(5_000, undefined, async () => "measured");
		expect(result).toBe("measured");
	});

	test("aborts the work when the budget expires, and reports a timeout", async () => {
		let observedAbort = false;
		const failure = await runWithScanBudget(30, undefined, async (linked) => {
			await new Promise<void>((resolve) => {
				linked.addEventListener("abort", () => {
					observedAbort = true;
					resolve();
				});
			});
			throw new Error("backend gave up");
		}).catch((error) => error);

		// Cancelling the WORK, not merely rejecting the caller: an abandoned scan would otherwise
		// keep read workers busy producing a result nobody waits for.
		expect(observedAbort).toBe(true);
		expect(failure).toBeInstanceOf(DatabaseStorageScanTimedOutError);
		expect(failure.budgetMs).toBe(30);
	});

	/**
	 * The regression this helper exists for.
	 *
	 * A backend that ignores its linked signal can still RETURN successfully after the budget has
	 * expired. Handing that result back would make the budget advisory — true of a cooperative
	 * adapter and quietly false of the next one. The contract test above caught exactly this on a
	 * second backend, so the rule is enforced here rather than trusted.
	 */
	test("discards a result produced after the budget expired", async () => {
		const failure = await runWithScanBudget(0, undefined, async () => "ignored the signal").catch(
			(error) => error,
		);
		expect(failure).toBeInstanceOf(DatabaseStorageScanTimedOutError);
	});

	test("a caller abort is a cancellation, not a timeout", async () => {
		const controller = new AbortController();
		const running = runWithScanBudget(10_000, controller.signal, async (linked) => {
			await new Promise<void>((resolve) => linked.addEventListener("abort", () => resolve()));
			throw new Error("stopped");
		});
		controller.abort();

		const failure = await running.catch((error) => error);
		expect(failure).toBeInstanceOf(DatabaseStorageScanCancelledError);
		expect(failure).not.toBeInstanceOf(DatabaseStorageScanTimedOutError);
	});

	test("a genuine failure propagates unchanged, even when its message mentions aborting", async () => {
		// The dangerous direction of message sniffing: classifying by text would report this as a
		// cancellation and silently swallow a real error. Nobody asked to stop, so it must surface.
		const failure = await runWithScanBudget(5_000, undefined, async () => {
			throw new Error("read aborted by the storage engine: disk I/O error");
		}).catch((error) => error);

		expect(failure).not.toBeInstanceOf(DatabaseStorageScanCancelledError);
		expect(failure).not.toBeInstanceOf(DatabaseStorageScanTimedOutError);
		expect(failure.message).toContain("disk I/O error");
	});

	test("does not start the work at all for an already-aborted caller", async () => {
		const controller = new AbortController();
		controller.abort();
		let started = false;

		await expect(
			runWithScanBudget(5_000, controller.signal, async () => {
				started = true;
				return "should not run";
			}),
		).rejects.toBeInstanceOf(DatabaseStorageScanCancelledError);
		expect(started).toBe(false);
	});

	test("clears its timer so a completed scan leaves nothing pending", async () => {
		// A leaked timer would keep the event loop alive and, worse, could abort a LATER controller
		// if the closure outlived its scan.
		const controller = new AbortController();
		await runWithScanBudget(50, controller.signal, async () => "fast");
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(controller.signal.aborted).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Output ceilings
// ─────────────────────────────────────────────────────────────────────────────

describe("report limits are enforced and the trimming is visible", () => {
	function reportWith(overrides: Record<string, unknown>): DatabaseStorageReport {
		return { sizeBytes: 1, incomplete: false, details: overrides };
	}

	test("trims topTables and records what was dropped", () => {
		const tables = Array.from({ length: 40 }, (_, i) => ({ name: `t${i}`, totalBytes: 40 - i }));
		const limited = enforceReportLimits(reportWith({ topTables: tables }));

		expect((limited.details.topTables as unknown[]).length).toBe(
			DEFAULT_DATABASE_STORAGE_REPORT_LIMITS.maxTopTables,
		);
		expect(limited.details.truncatedByPortLimits).toEqual({
			topTables: { kept: DEFAULT_DATABASE_STORAGE_REPORT_LIMITS.maxTopTables, dropped: 28 },
		});
		// Order is preserved: the caller sorted by size, so trimming must keep the largest.
		expect((limited.details.topTables as Array<{ name: string }>)[0].name).toBe("t0");
	});

	test("trims failing table NAMES but keeps the count exact", () => {
		const names = Array.from({ length: 137 }, (_, i) => `failed_${i}`);
		const limited = enforceReportLimits(
			reportWith({ readFailures: { tableCount: 137, tableNames: names } }),
		);

		const failures = limited.details.readFailures as { tableCount: number; tableNames: string[] };
		expect(failures.tableNames.length).toBe(
			DEFAULT_DATABASE_STORAGE_REPORT_LIMITS.maxFailedTableNames,
		);
		// The reason the count is not clamped: the UI has to be able to say "20 of 137 shown".
		// Clamping it would under-report how much of the database went unmeasured.
		expect(failures.tableCount).toBe(137);
	});

	test("leaves a report already inside the limits untouched", () => {
		const original = reportWith({
			topTables: [{ name: "small" }],
			readFailures: { tableCount: 0, tableNames: [] },
		});
		const limited = enforceReportLimits(original);

		expect(limited.details).toEqual(original.details);
		expect(limited.details.truncatedByPortLimits).toBeUndefined();
	});

	test("does not mutate the report it was given", () => {
		// The report reaches a shared cache other requests read, so trimming in place would rewrite
		// a payload someone else is already holding.
		const tables = Array.from({ length: 30 }, (_, i) => ({ name: `t${i}` }));
		const original = reportWith({ topTables: tables });
		enforceReportLimits(original);

		expect((original.details.topTables as unknown[]).length).toBe(30);
		expect(original.details.truncatedByPortLimits).toBeUndefined();
	});

	test("respects custom limits", () => {
		const limited = enforceReportLimits(
			reportWith({ topTables: [{ name: "a" }, { name: "b" }, { name: "c" }] }),
			{ maxTopTables: 1, maxFailedTableNames: 1 },
		);
		expect(limited.details.topTables).toEqual([{ name: "a" }]);
	});

	test("the production adapter's own report is within the limits", async () => {
		const report = await sqliteDatabaseStoragePort.scanBreakdown();
		const topTables = report.details.topTables as unknown[] | undefined;
		const failures = report.details.readFailures as { tableNames: string[] } | undefined;

		expect(topTables?.length ?? 0).toBeLessThanOrEqual(
			DEFAULT_DATABASE_STORAGE_REPORT_LIMITS.maxTopTables,
		);
		expect(failures?.tableNames.length ?? 0).toBeLessThanOrEqual(
			DEFAULT_DATABASE_STORAGE_REPORT_LIMITS.maxFailedTableNames,
		);
	}, 120_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// The port stays dialect-free
// ─────────────────────────────────────────────────────────────────────────────

describe("the port carries no storage dependency", () => {
	const PORT_DIR = join(import.meta.dir, "..");

	/** Import specifiers only — prose mentioning SQLite is documentation, not coupling. */
	function importSpecifiers(file: string): string[] {
		const source = readFileSync(join(PORT_DIR, file), "utf8");
		return [...source.matchAll(/\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/g)].map(
			(m) => m[1] ?? m[2],
		);
	}

	test("database-storage-port.ts imports nothing at all", () => {
		// Stronger than "nothing database-specific": this file is pure types plus one pure
		// function, so the honest assertion is that it has no dependencies whatsoever. A future
		// import is then a deliberate decision rather than a slow slide back into coupling.
		expect(importSpecifiers("database-storage-port.ts")).toEqual([]);
	});

	test("the port's code names no driver, ORM or engine type", () => {
		const source = readFileSync(join(PORT_DIR, "database-storage-port.ts"), "utf8");
		// Strip comments: the file explains at length WHY it must not depend on these, and matching
		// its own rationale would make the assertion fail for saying the right thing.
		const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

		// Deliberately NOT a ban on the substring "Database": the port's own vocabulary is
		// `DatabaseStoragePort`, `DatabaseStorageReport`, … — an earlier revision of this test
		// banned it and failed on the port's own type names, which is a test asserting a rule
		// nobody meant. What must not appear are ENGINE types and driver/ORM module names, i.e.
		// the things that would make the contract implementable by only one backend.
		for (const forbidden of ["bun:sqlite", "drizzle", "sqlite", "postgres", "db-worker"]) {
			expect(code.toLowerCase(), `the port must not name ${forbidden}`).not.toContain(forbidden);
		}
		// A bare `Database` / `Statement` TYPE reference (as opposed to `DatabaseStorage…` names)
		// would mean a live handle crosses the boundary, which is the one thing the port promises
		// cannot happen.
		expect(code).not.toMatch(/\bDatabase\b(?!Storage)/);
		expect(code).not.toMatch(/\bStatement\b/);
	});

	test("the selector is wired to the SQLite implementation today", () => {
		// Phase 0's baseline says SQLite is the only backend; the selector must agree, and a second
		// dialect becoming reachable has to be a visible edit rather than a default.
		expect(databaseStoragePort).toBe(sqliteDatabaseStoragePort);
	});

	test("the default budget bounds the measurement without competing with its internals", () => {
		// A backstop against a scan that never returns, not a performance target: it must sit above
		// the pool's own 120s per-shard budget, or the port would cancel healthy scans.
		expect(DEFAULT_DATABASE_STORAGE_SCAN_BUDGET_MS).toBeGreaterThan(120_000);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The SQLite adapter's own honesty about where the work runs
// ─────────────────────────────────────────────────────────────────────────────

describe("the SQLite adapter reports where the scan actually runs", () => {
	const previous = process.env.NARRAFORK_DB_WORKER;

	beforeEach(() => {
		delete process.env.NARRAFORK_DB_WORKER;
	});

	afterEach(() => {
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
	});

	test("loses offRequestThreadScan when read workers are disabled", () => {
		// Read at access time on purpose. A frozen `true` would keep claiming the request thread is
		// protected in exactly the states where it is not — workers off by configuration, or the
		// pool torn down for a VACUUM maintenance window.
		process.env.NARRAFORK_DB_WORKER = "off";
		expect(sqliteDatabaseStoragePort.capabilities.offRequestThreadScan).toBe(false);

		delete process.env.NARRAFORK_DB_WORKER;
		expect(sqliteDatabaseStoragePort.capabilities.offRequestThreadScan).toBe(true);
	});

	test("still measures with workers disabled, degrading rather than failing", async () => {
		// The existing SQLite fallback, preserved: a serial main-thread scan is slow, but a slow
		// report beats a broken settings page.
		process.env.NARRAFORK_DB_WORKER = "off";
		const report = await sqliteDatabaseStoragePort.scanBreakdown();
		expect(report.sizeBytes).toBeGreaterThan(0);
		expect(report.details.scanMode).toBeDefined();
	}, 120_000);
});
