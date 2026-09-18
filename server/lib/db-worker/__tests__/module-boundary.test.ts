import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The database read worker runs in a thread of THIS process. If its module graph ever reaches
 * `server/db/index.ts`, that module is evaluated a second time inside the worker thread and:
 *
 *   - opens a second READ-WRITE connection to the same database,
 *   - re-runs migrations, column backfills and `ensureFts`,
 *   - registers a second WAL-checkpoint interval and exit handler,
 *   - calls `consumeCleanShutdownState`, which CLEARS the clean-shutdown marker — verified
 *     experimentally to flip a freshly marked database back to "unclean", so the next startup
 *     believes the process crashed and pays for a full background integrity probe.
 *
 * `acquireInstanceLock` does not protect against this: the pid matches, so it silently "reuses" the
 * lock instead of refusing. The failure is therefore invisible until data or startup behaviour is
 * already wrong.
 *
 * This test bundles the worker entry and asserts the bootstrap never made it in. It is the guard
 * that keeps a future well-meaning import from reintroducing the problem.
 */

const ROOT = join(import.meta.dir, "../../../..");
const WORKER_ENTRY = join(ROOT, "server/lib/db-worker/worker-entry.ts");

/** Identifiers that only exist in the DB bootstrap / ORM layer the worker must never pull in. */
const FORBIDDEN_SYMBOLS = [
	"consumeCleanShutdownState",
	"acquireInstanceLock",
	"markDatabaseCleanShutdown",
	"releaseDatabaseInstanceLockOnly",
	"startWalCheckpointInterval",
	"ensureFts",
	"runMigrations",
];

describe("db read worker module boundary", () => {
	test("worker entry bundles without reaching the database bootstrap", async () => {
		const build = await Bun.build({
			entrypoints: [WORKER_ENTRY],
			target: "bun",
		});

		expect(build.success).toBe(true);
		expect(build.outputs.length).toBeGreaterThan(0);

		const bundled = await build.outputs[0].text();
		const leaked = FORBIDDEN_SYMBOLS.filter((symbol) => bundled.includes(symbol));
		expect(leaked).toEqual([]);
	}, 60_000);

	test("worker entry does not bundle drizzle or the schema", async () => {
		const build = await Bun.build({ entrypoints: [WORKER_ENTRY], target: "bun" });
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();
		// Pulling in the ORM/schema would mean the worker is one import away from the bootstrap and
		// would also bloat every worker thread with the full table definitions.
		expect(bundled).not.toContain("drizzle-orm");
		expect(bundled).not.toContain("sqliteTable");
	}, 60_000);

	test("the shared query module itself stays free of the db singleton", async () => {
		const build = await Bun.build({
			entrypoints: [join(ROOT, "server/services/storage-scan-queries.ts")],
			target: "bun",
		});
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();
		for (const symbol of FORBIDDEN_SYMBOLS) {
			expect(bundled).not.toContain(symbol);
		}
	}, 60_000);

	/**
	 * The storage-scan port is a MAIN-THREAD abstraction, and it must stay on that side.
	 *
	 * Its SQLite adapter reaches `database-cleanup-service`, which imports `@server/db` — so the
	 * moment the worker's graph touches the port it inherits the whole bootstrap the tests above
	 * exist to keep out. The symbol checks would eventually catch that, but only as a confusing
	 * failure about `ensureFts`; naming the port here makes the actual mistake ("the worker imported
	 * the orchestration layer") legible at the point it is made.
	 */
	test("worker entry does not bundle the storage port or the cleanup service", async () => {
		const build = await Bun.build({ entrypoints: [WORKER_ENTRY], target: "bun" });
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();

		for (const symbol of [
			"databaseStoragePort",
			"sqliteDatabaseStoragePort",
			"enforceReportLimits",
			"runWithScanBudget",
			"databaseCleanupService",
			"scanDatabaseBreakdown",
		]) {
			expect(bundled, `worker entry must not bundle ${symbol}`).not.toContain(symbol);
		}
	}, 60_000);

	/**
	 * The port is dialect-free, so it must also be bootstrap-free.
	 *
	 * Asserted on the PORT rather than only on the adapter because the port is what a future
	 * PostgreSQL implementation imports: if the contract module itself dragged in the SQLite
	 * bootstrap, every backend would inherit it no matter how careful its own adapter was.
	 */
	test("the storage port carries neither the db bootstrap nor a driver", async () => {
		const build = await Bun.build({
			entrypoints: [join(ROOT, "server/services/storage/database-storage-port.ts")],
			target: "bun",
		});
		expect(build.success).toBe(true);
		const bundled = await build.outputs[0].text();

		for (const symbol of FORBIDDEN_SYMBOLS) {
			expect(bundled, `the port must not reach ${symbol}`).not.toContain(symbol);
		}
		expect(bundled).not.toContain("bun:sqlite");
		expect(bundled).not.toContain("drizzle-orm");
		// Guard against a vacuous pass: the bundle must actually contain the port's own code.
		expect(bundled).toContain("enforceReportLimits");
		expect(bundled).toContain("runWithScanBudget");
	}, 60_000);
});
