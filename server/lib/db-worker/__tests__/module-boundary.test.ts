import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { safeSpawn } from "../../spawn";

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

const APPROVED_WORKER_MODULES = new Set([
	"server/lib/sql-trace.ts",
	"server/services/benchmark-read.ts",
	"server/services/agent-runtime/publication-reader.ts",
	"server/lib/runtime-target.ts",
	"server/services/storage-scan-queries.ts",
	"server/lib/narrator-bodies.ts",
	"shared/file-change-protocol.ts",
	"server/lib/agent/recall-tool-summary.ts",
	"server/lib/narrator-project-sql.ts",
	"server/lib/validators/runtime-registration.ts",
	"server/services/agent-runtime/limits.ts",
	"server/services/agent-runtime/publication-result.ts",
	"server/services/agent-runtime/publication-key.ts",
	"shared/compact-message.ts",
	"server/lib/agent/tool-name.ts",
	"server/lib/narrafork-home.ts",
	"server/services/benchmark-limits.ts",
	"server/lib/tool-execution-target-projection.ts",
	"shared/narrator-blocks/retention.ts",
	"server/lib/agent/file-reference-projection.ts",
	"shared/composer-document.ts",
	"shared/media-attachments.ts",
	"shared/pretext-layout/tool-io-projection.ts",
	"shared/gen-ui-tool-policy.ts",
	"server/lib/agent/tools/outline-names.ts",
	"shared/file-reference.ts",
	"server/services/agent-runtime/model-history-json.ts",
	"server/lib/narrator-utils.ts",
	"shared/storage-retention.ts",
	"shared/subagent-tool-summary.ts",
	"shared/narrator-blocks/storage.ts",
	"server/lib/errors.ts",
	"shared/narrator-blocks/decode.ts",
	"shared/error-catalog.ts",
	"shared/native-injection.ts",
	"shared/prefix-context.ts",
	"shared/agent-protocol/tool-output.ts",
	"shared/sidecar-body.ts",
	"shared/outline-task-notice.ts",
	"shared/narrator-blocks/plan.ts",
	"shared/knowledge-excerpt.ts",
	"server/lib/narrator-body-length.ts",
]);
function modulePath(path: string): string {
	return relative(ROOT, resolve(ROOT, path)).split(sep).join("/");
}
function sourceViolations(meta: Bun.BuildMetafile, entries: string[] = []): string[] {
	const allowedEntries = new Set(entries.map(modulePath));
	return Object.keys(meta.inputs)
		.map(modulePath)
		.filter((path) => {
			if (
				path.startsWith("node_modules/") ||
				path.includes("/node_modules/") ||
				allowedEntries.has(path)
			)
				return false;
			if (
				path.startsWith("server/lib/db-worker/") &&
				!path.includes("/__tests__/") &&
				!path.endsWith(".test.ts")
			)
				return false;
			return !APPROVED_WORKER_MODULES.has(path);
		});
}

describe("db read worker module boundary", () => {
	test("numeric observation helper has no initialization dependencies or logging sink", async () => {
		const entry = join(ROOT, "server/lib/db-worker/read-budget.ts");
		const build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true });
		expect(build.success).toBe(true);
		if (!build.metafile) throw new Error("Observation helper did not produce a dependency graph");
		expect(Object.keys(build.metafile.inputs).map(modulePath)).toEqual([
			"server/lib/db-worker/read-budget.ts",
		]);
	});
	test("compiled reader executes the embedded worker outside the source tree", async () => {
		mkdirSync(join(ROOT, ".narrafork"), { recursive: true });
		const source = mkdtempSync(join(ROOT, ".narrafork/reader-compile-"));
		const output = mkdtempSync(join(tmpdir(), "nf-reader-binary-"));
		const databasePath = join(output, "fixture.db");
		const database = new Database(databasePath);
		database.run("CREATE TABLE marker(value TEXT)");
		database.run("INSERT INTO marker VALUES ('embedded')");
		database.close();
		try {
			const entry = join(source, "probe.ts");
			writeFileSync(
				entry,
				`import { runReadTask, drainDbWorkerPool } from "../../server/lib/db-worker/pool";
const probe = await runReadTask(process.argv[2], { kind: "domainRead", task: "readerProbe", input: null }, { timeoutMs: 10000 });
const rows = await runReadTask(process.argv[2], { kind: "selectRows", sql: "SELECT value FROM marker", params: [], maxRows: 1 }, { timeoutMs: 10000 });
console.log(JSON.stringify({ probe, rows }));
await drainDbWorkerPool({ timeoutMs: 5000 });
`,
			);
			const executable = join(output, process.platform === "win32" ? "reader.exe" : "reader");
			const build = await safeSpawn({
				cmd: [process.execPath, "build", "--compile", "--outfile", executable, entry, WORKER_ENTRY],
				cwd: ROOT,
				timeout: 60000,
				maxOutputBytes: 1024 * 1024,
			});
			expect(build.exitCode, build.stderr).toBe(0);
			const run = await safeSpawn({
				cmd: [executable, databasePath],
				cwd: output,
				timeout: 20000,
				maxOutputBytes: 64 * 1024,
				env: { ...process.env, NARRAFORK_DB_WORKER: "on", NARRAFORK_DB_WORKER_CONCURRENCY: "2" },
			});
			expect(run.exitCode, run.stderr).toBe(0);
			expect(JSON.parse(run.stdout.trim())).toEqual({
				probe: { ready: true },
				rows: { columns: ["value"], rows: [["embedded"]] },
			});
		} finally {
			rmSync(source, { recursive: true, force: true });
			rmSync(output, { recursive: true, force: true });
		}
	}, 90000);

	test("worker graph resolves only approved dependencies", async () => {
		const build = await Bun.build({ entrypoints: [WORKER_ENTRY], target: "bun", metafile: true });
		expect(build.success).toBe(true);
		if (!build.metafile) throw new Error("Worker build did not produce a dependency graph");
		expect(sourceViolations(build.metafile)).toEqual([]);
	}, 60_000);

	test("dependency allowlist rejects real settings and database-bootstrap imports", async () => {
		mkdirSync(join(ROOT, ".narrafork"), { recursive: true });
		const fixture = mkdtempSync(join(ROOT, ".narrafork/reader-boundary-"));
		try {
			for (const forbidden of ["server/lib/settings/index.ts", "server/db/index.ts"]) {
				const entry = join(fixture, "probe.ts");
				writeFileSync(
					entry,
					`import * as forbidden from ${JSON.stringify(join(ROOT, forbidden))}; console.log(forbidden);`,
				);
				const build = await Bun.build({ entrypoints: [entry], target: "bun", metafile: true });
				expect(build.success).toBe(true);
				if (!build.metafile) throw new Error("Negative probe did not produce a dependency graph");
				expect(sourceViolations(build.metafile, [entry])).toContain(forbidden);
			}
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	}, 60_000);

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
