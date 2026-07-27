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
});
