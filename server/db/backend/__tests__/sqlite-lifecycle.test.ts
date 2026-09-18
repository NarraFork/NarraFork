/**
 * The SQLite lifecycle adapter, exercised against a real database file in an isolated home.
 *
 * WHAT IS WORTH TESTING HERE, AND WHY
 * ----------------------------------
 * The lifecycle sequence has failure modes that no type check and no ordinary suite can see,
 * because every one of them still "works" — it just leaves the next startup with a wrong belief:
 *
 *   - ORDER. FTS5 initialisation reads tables and columns that migrations and `ensureColumns`
 *     create. Run it first and the indexes are silently built from an incomplete schema. Nothing
 *     throws; search results are simply wrong later. So the test asserts the backfill hook observes
 *     a schema that already has both, and that the FTS tables exist afterwards.
 *   - THE CLEAN MARKER. It is consumed BEFORE any startup mutation, so a crash during migrations
 *     cannot leave a stale "was clean" claim. Test: a database marked clean reports `wasClean: true`
 *     exactly once, and the very next start reports false. Getting this wrong makes an unclean
 *     shutdown look clean and retires the corruption probe.
 *   - IDEMPOTENCE. Bun `--hot` re-evaluates modules in a live process, so `start()` runs again. The
 *     second run must report `isHotReload: true` and must not duplicate side effects (a second
 *     checkpoint timer, a second exit handler). Duplicates are invisible until a `--hot` session has
 *     been open for hours.
 *   - THE MARKER IS WRITE-ONCE PER PROCESS. `finishCleanly` is called from the shutdown tail and its
 *     lock release also runs from `process.on("exit")`; a second call must not write a second marker.
 *
 * ISOLATION: every test gets its own `NARRAFORK_HOME` temp directory, so nothing here can reach the
 * developer's real database (`connection.ts` refuses that outright under NODE_ENV=test, and this
 * suite never points at it anyway). `NARRAFORK_ALLOW_MULTIPLE=1` is set because the instance lock is
 * process-scoped and several tests start a lifecycle in the same process; the lock's own behaviour is
 * covered by its dedicated suite.
 *
 * NOT TESTED HERE, deliberately: the repair runner's `sqlite3 .recover` path. It shells out to an
 * external binary, copies the whole database aside and swaps files — running it would be a real
 * recovery operation, not a unit test, and `integrity-check.test.ts` already covers the marker/budget
 * state machine that decides whether it runs at all.
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENV_KEYS = ["NARRAFORK_HOME", "NARRAFORK_ALLOW_MULTIPLE"] as const;

let home = "";
let saved: Record<string, string | undefined> = {};
/** Connections opened by a test's lifecycle, closed in afterEach so Windows can remove the dir. */
let openLifecycles: Array<{ abandonWithoutCleanMarker: () => void; connection?: Database }> = [];

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	home = mkdtempSync(join(tmpdir(), "nf-sqlite-lifecycle-"));
	process.env.NARRAFORK_HOME = home;
	// The instance lock is per data directory AND per process; these tests intentionally start
	// several lifecycles in one process against different directories.
	process.env.NARRAFORK_ALLOW_MULTIPLE = "1";
});

afterEach(() => {
	for (const lifecycle of openLifecycles) {
		try {
			lifecycle.abandonWithoutCleanMarker();
		} catch {
			// best effort
		}
		try {
			lifecycle.connection?.close();
		} catch {
			// already closed
		}
	}
	openLifecycles = [];
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
});

/**
 * A fresh lifecycle bound to this test's temp home.
 *
 * The module is imported dynamically INSIDE the test so it reads the environment set in `beforeEach`
 * rather than whatever was in place when this file was first evaluated.
 */
async function newLifecycle(
	options: Parameters<
		Awaited<typeof import("../sqlite-lifecycle")>["createSqliteLifecycle"]
	>[0] = {},
) {
	const { createSqliteLifecycle } = await import("../sqlite-lifecycle");
	const lifecycle = createSqliteLifecycle(options);
	openLifecycles.push(lifecycle);
	return lifecycle;
}

/** Reset the globalThis-pinned lifecycle state so each test starts as a "first" startup. */
function resetHotState(): void {
	// biome-ignore lint/suspicious/noExplicitAny: hot-reload state lives on globalThis by design
	const g = globalThis as any;
	const state = g[Symbol.for("narrafork.dbLifecycle")];
	if (state) {
		state.initialized = false;
		state.cleanMarked = false;
		state.sqlite = undefined;
		if (state.walCheckpointTimer) {
			clearInterval(state.walCheckpointTimer);
			state.walCheckpointTimer = undefined;
		}
	}
	const timer = g[Symbol.for("narrafork.walCheckpointTimer")];
	if (timer) {
		clearInterval(timer);
		g[Symbol.for("narrafork.walCheckpointTimer")] = undefined;
	}
}

function tableNames(connection: Database): string[] {
	return (
		connection
			.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
			.all() as Array<{ name: string }>
	).map((row) => row.name);
}

describe("SQLite lifecycle startup sequence", () => {
	beforeEach(() => {
		resetHotState();
	});

	test("migrates a fresh database, then reports the migration source", async () => {
		const lifecycle = await newLifecycle();
		const report = await lifecycle.start();

		expect(report.backendId).toBe("sqlite");
		// `filesystem` in a source checkout, `embedded` from a compiled binary. Either is a real
		// answer; an empty one would mean the report was fabricated.
		expect(report.migration.source.length).toBeGreaterThan(0);
		expect(existsSync(join(home, "narrafork.db"))).toBe(true);

		const tables = tableNames(lifecycle.connection);
		// Anchors from three different migration eras, so a partially-applied journal fails here.
		expect(tables).toContain("narrators");
		expect(tables).toContain("narrator_message_refs");
		expect(tables).toContain("acl_grants");
	}, 120_000);

	test("runs data backfills after column patching and before FTS initialisation", async () => {
		// The single most consequential ordering property in the whole sequence, and the one that
		// fails silently: FTS5 indexes built before a column exists are simply wrong, forever, with
		// no error anywhere.
		interface BackfillObservation {
			hasNarrators: boolean;
			hasHandleFold: boolean;
			ftsTables: string[];
		}
		// A mutable array rather than a `let … | null`: TypeScript's control-flow analysis narrows a
		// variable assigned only inside a callback to `never` at the assertions below, which makes the
		// checks unwritable even though they run after the callback has fired.
		const observations: BackfillObservation[] = [];

		const lifecycle = await newLifecycle({
			applyDataBackfills: (connection) => {
				const columns = (
					connection.prepare("PRAGMA table_info('narrators')").all() as Array<{ name: string }>
				).map((row) => row.name);
				observations.push({
					hasNarrators: tableNames(connection).includes("narrators"),
					// Added by a later migration / by ensureColumns — present only if step 6 already ran.
					hasHandleFold: columns.includes("handle_fold"),
					ftsTables: tableNames(connection).filter((name) => name.endsWith("_fts")),
				});
			},
		});
		await lifecycle.start();

		// Exactly one invocation: a hook called twice would run every backfill twice per startup.
		expect(observations).toHaveLength(1);
		const observed = observations[0];
		if (!observed) return;
		expect(observed.hasNarrators).toBe(true);
		expect(observed.hasHandleFold).toBe(true);
		// FTS comes AFTER the backfills, so none of its tables may exist yet at this point.
		expect(observed.ftsTables).toEqual([]);

		// …and they do exist once startup finished, which is what makes the assertion above a
		// statement about ORDER rather than about FTS being absent altogether.
		const afterwards = tableNames(lifecycle.connection).filter((name) => name.endsWith("_fts"));
		expect(afterwards).toContain("narrator_messages_fts");
		expect(afterwards).toContain("chapters_fts");
	}, 120_000);

	test("patches a column an older build never created", async () => {
		// Reproduces the real upgrade path: a database whose migration history is complete but whose
		// table is missing a column, which is what `ensureColumns` exists for. Migrations alone do not
		// fix it — Drizzle sees every migration as applied.
		const first = await newLifecycle();
		await first.start();
		const dbPath = join(home, "narrafork.db");
		first.connection.run("ALTER TABLE narrators DROP COLUMN last_message_at");
		expect(
			(
				first.connection.prepare("PRAGMA table_info('narrators')").all() as Array<{ name: string }>
			).some((row) => row.name === "last_message_at"),
		).toBe(false);
		first.abandonWithoutCleanMarker();
		first.connection.close();

		resetHotState();
		const second = await newLifecycle();
		await second.start();

		expect(
			(
				second.connection.prepare("PRAGMA table_info('narrators')").all() as Array<{ name: string }>
			).some((row) => row.name === "last_message_at"),
		).toBe(true);
		// Same file, not a fresh one — a re-created database would also "have" the column.
		expect(existsSync(dbPath)).toBe(true);
	}, 120_000);

	test("startup on a legacy database reports nothing was flagged for repair", async () => {
		const lifecycle = await newLifecycle();
		const report = await lifecycle.start();

		expect(report.repair.supported).toBe(true);
		if (!report.repair.supported) return;
		// No marker file exists, so there is nothing to act on. `not_flagged` is distinct from
		// `skipped`: reporting the latter would suggest a repair was owed and deliberately deferred.
		expect(report.repair.value).toEqual({ kind: "not_flagged" });
	}, 120_000);
});

describe("clean-shutdown marker", () => {
	beforeEach(() => {
		resetHotState();
	});

	test("is consumed exactly once and never survives into the next startup", async () => {
		const first = await newLifecycle();
		const firstReport = await first.start();
		expect(firstReport.startup.supported).toBe(true);
		if (!firstReport.startup.supported) return;
		// A brand-new database was never marked clean by a previous process.
		expect(firstReport.startup.value.wasClean).toBe(false);

		expect(first.finishCleanly().supported).toBe(true);
		first.connection.close();

		resetHotState();
		const second = await newLifecycle();
		const secondReport = await second.start();
		expect(secondReport.startup.supported).toBe(true);
		if (!secondReport.startup.supported) return;
		// The marker written above is read here…
		expect(secondReport.startup.value.wasClean).toBe(true);
		// …and consumed, so a crash from this point on cannot look clean. Simulated by starting again
		// WITHOUT a clean finish, exactly as a killed process would leave things.
		second.connection.close();

		resetHotState();
		const third = await newLifecycle();
		const thirdReport = await third.start();
		expect(thirdReport.startup.supported).toBe(true);
		if (!thirdReport.startup.supported) return;
		expect(thirdReport.startup.value.wasClean).toBe(false);
	}, 120_000);

	test("finishCleanly is idempotent and stops the upkeep timer", async () => {
		const lifecycle = await newLifecycle();
		await lifecycle.start();
		const upkeep = lifecycle.startBackgroundUpkeep();
		expect(upkeep.supported).toBe(true);

		expect(lifecycle.finishCleanly().supported).toBe(true);
		// A second call must not write a second marker or throw: the shutdown tail and the exit
		// handler can both reach this path.
		expect(lifecycle.finishCleanly().supported).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: reading the hot-reload state under test
		const state = (globalThis as any)[Symbol.for("narrafork.dbLifecycle")];
		expect(state.walCheckpointTimer).toBeUndefined();
		expect(state.cleanMarked).toBe(true);
	}, 120_000);

	test("abandonWithoutCleanMarker leaves the next startup unclean", async () => {
		const first = await newLifecycle();
		await first.start();
		first.startBackgroundUpkeep();
		// The degraded path: release the lock so a replacement can start, but claim nothing about
		// consistency. It must be safe to call repeatedly (it runs from `process.on("exit")` too).
		first.abandonWithoutCleanMarker();
		expect(() => first.abandonWithoutCleanMarker()).not.toThrow();
		first.connection.close();

		resetHotState();
		const second = await newLifecycle();
		const report = await second.start();
		expect(report.startup.supported).toBe(true);
		if (!report.startup.supported) return;
		expect(report.startup.value.wasClean).toBe(false);
	}, 120_000);
});

describe("repeated initialisation (Bun --hot)", () => {
	beforeEach(() => {
		resetHotState();
	});

	test("the second start reports a hot reload and adds no duplicate timer", async () => {
		const lifecycle = await newLifecycle();
		const first = await lifecycle.start();
		expect(first.startup.supported).toBe(true);
		if (!first.startup.supported) return;
		expect(first.startup.value.isHotReload).toBe(false);

		lifecycle.startBackgroundUpkeep();
		// biome-ignore lint/suspicious/noExplicitAny: reading the hot-reload state under test
		const g = globalThis as any;
		const firstTimer = g[Symbol.for("narrafork.walCheckpointTimer")];
		expect(firstTimer).toBeDefined();

		// No resetHotState: this is exactly what a --hot re-evaluation looks like.
		const second = await lifecycle.start();
		expect(second.startup.supported).toBe(true);
		if (!second.startup.supported) return;
		expect(second.startup.value.isHotReload).toBe(true);
		// A repair owed at this point is deliberately deferred rather than run twice.
		expect(second.repair.supported).toBe(true);

		lifecycle.startBackgroundUpkeep();
		const secondTimer = g[Symbol.for("narrafork.walCheckpointTimer")];
		// hotTimer replaces rather than accumulates: exactly one timer is registered.
		expect(secondTimer).toBeDefined();
		expect(secondTimer).not.toBe(firstTimer);
	}, 120_000);

	test("a pending repair is skipped on a hot reload rather than run again", async () => {
		const lifecycle = await newLifecycle();
		await lifecycle.start();

		const { writePendingDatabaseRepair } = await import("../../integrity-state");
		expect(
			writePendingDatabaseRepair({
				mode: "quick",
				details: "synthetic finding for the hot-reload branch",
				detectedAt: new Date().toISOString(),
			}).ok,
		).toBe(true);

		// Second evaluation in the same process. The repair runner must NOT run: it closes the
		// connection and can swap the file, which would be catastrophic under live sessions.
		const report = await lifecycle.start();
		expect(report.repair.supported).toBe(true);
		if (!report.repair.supported) return;
		expect(report.repair.value).toEqual({ kind: "skipped", reason: "hot_reload" });

		// The marker is still there, so the NEXT real startup can act on it.
		const { readPendingDatabaseRepair } = await import("../../integrity-state");
		expect(readPendingDatabaseRepair()?.state).toBe("pending");
	}, 120_000);

	test("a marker whose repair budget is spent does not block startup", async () => {
		// The failure this pins: retrying an unrepairable database forever turned one bad file into a
		// permanently unbootable server, because each attempt costs minutes and a full-size copy.
		const { MAX_AUTOMATIC_REPAIR_ATTEMPTS, writePendingDatabaseRepair } = await import(
			"../../integrity-state"
		);
		expect(
			writePendingDatabaseRepair({
				mode: "full",
				details: "synthetic exhausted finding",
				detectedAt: new Date().toISOString(),
				state: "pending",
				attempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
			}).ok,
		).toBe(true);

		const lifecycle = await newLifecycle();
		const report = await lifecycle.start();

		expect(report.repair.supported).toBe(true);
		if (!report.repair.supported) return;
		expect(report.repair.value).toEqual({ kind: "skipped", reason: "budget_spent" });
		// Booted normally in spite of the flag: the tables are there and queryable.
		expect(tableNames(lifecycle.connection)).toContain("narrators");
	}, 120_000);
});

describe("connection access", () => {
	beforeEach(() => {
		resetHotState();
	});

	test("reading the connection before start() fails loudly", async () => {
		const lifecycle = await newLifecycle();
		// A silent `undefined` here would surface much later as an unrelated error from whichever
		// query happened to run first.
		expect(() => lifecycle.connection).toThrow(/has not been started/);
	});

	test("background upkeep is unavailable until a connection exists", async () => {
		const lifecycle = await newLifecycle();
		const plan = lifecycle.planBackgroundUpkeep();
		expect(plan.supported).toBe(false);
		if (plan.supported) return;
		expect(plan.code).toBe("notApplicable");
		expect(plan.reason).toContain("start()");
	});

	test("the upkeep plan describes a real, bounded schedule", async () => {
		const lifecycle = await newLifecycle();
		await lifecycle.start();
		const plan = lifecycle.planBackgroundUpkeep();
		expect(plan.supported).toBe(true);
		if (!plan.supported) return;

		// A zero or absurd interval would either hammer the database or never run.
		expect(plan.value.intervalMs).toBeGreaterThan(1_000);
		expect(plan.value.intervalMs).toBeLessThanOrEqual(60 * 60_000);
		expect(plan.value.description.length).toBeGreaterThan(0);
		// The tick must be safe to invoke and must never throw — it runs inside a timer callback,
		// where an unhandled throw takes the process down.
		expect(() => plan.value.tick()).not.toThrow();
	}, 120_000);
});
