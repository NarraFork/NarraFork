/**
 * The PostgreSQL write path must never touch a `bun:sqlite` handle — proven, not
 * asserted by convention.
 *
 * WHY BUNDLING IS THE PROOF
 * -------------------------
 * A text search of one file cannot see an import three modules deep. The PG
 * counterpart modules are what the second backend's write path is made of; if any
 * of them drags in `bun:sqlite`, the SQLite drizzle dialect, the raw-handle
 * vocabulary (`$client`/`nativeClient`, `total_changes`, `INDEXED BY`,
 * `PRAGMA busy_timeout`) or the startup bootstrap, then the "PG path" quietly
 * shares state with the SQLite one and every equivalence result built on it is
 * void. So each module is BUNDLED (`Bun.build` follows the whole import graph)
 * and the bundle is searched — the same proof shape as
 * `server/db/backend/__tests__/port-purity.test.ts`.
 *
 * WHAT IS CHECKED PER MODULE
 * --------------------------
 *   1. no `bun:sqlite` and no `drizzle-orm/bun-sqlite` anywhere in the graph;
 *   2. none of the connection-scoped vocabulary the SQLite-only services are
 *      built on (`$client`, `nativeClient`, `total_changes`, `INDEXED BY`,
 *      `PRAGMA busy_timeout`, `data_version`);
 *   3. none of the startup bootstrap symbols — the hazard
 *      `port-purity.test.ts` documents (a second bootstrap inside the wrong
 *      thread/process has already burned this repository once);
 *   4. the check is not vacuous: the bundle really contains the module's own
 *      domain vocabulary.
 *
 * The SQLite-only declarations being mirrored here live in the capability
 * headers of `revert-selection-service.ts`, `revert-history-commit.ts`,
 * `revert-transaction-service.ts` and `revert-planner-service.ts` — the modules
 * whose connection-stamp design has no PG counterpart (see requirement: those
 * four are the documented SQLite-only capability set).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

/** Every PostgreSQL counterpart module shipped by batch E. */
const PG_MODULES: ReadonlyArray<readonly [path: string, ownVocabulary: string]> = [
	["server/services/postgres-revert-plan-store.ts", "PostgresRevertPlanStore"],
	["server/services/postgres-revert-journal-store.ts", "PostgresRevertMutationJournal"],
	["server/services/postgres-file-change-evidence-store.ts", "PostgresFileChangeEvidenceStore"],
	["server/services/postgres-file-change-blob-catalog.ts", "PostgresFileChangeBlobCatalog"],
	["server/services/postgres-workspace-lease-store.ts", "PostgresWorkspaceLeaseStore"],
	[
		"server/services/project-archive/postgres-main-store.ts",
		"createPostgresProjectArchiveMainStore",
	],
	["server/services/chapter-write/postgres-write-store.ts", "createPostgresChapterWriteStore"],
];

/** The connection-scoped SQLite vocabulary that must never reach a PG path. */
const FORBIDDEN_MARKERS = [
	"bun:sqlite",
	"drizzle-orm/bun-sqlite",
	"$client",
	"nativeClient",
	"total_changes",
	"last_insert_rowid",
	"INDEXED BY",
	"PRAGMA busy_timeout",
	"data_version",
	"schema_version",
] as const;

/** Startup bootstrap symbols, same list `port-purity.test.ts` guards. */
const BOOTSTRAP_SYMBOLS = [
	"consumeCleanShutdownState",
	"acquireInstanceLock",
	"markDatabaseCleanShutdown",
	"releaseDatabaseInstanceLockOnly",
	"createWalUpkeepTick",
	"ensureFts",
	"runMigrations",
	"ensureColumns",
] as const;

async function bundle(relativePath: string): Promise<string> {
	const build = await Bun.build({ entrypoints: [join(ROOT, relativePath)], target: "bun" });
	expect(build.success, `${relativePath} must bundle`).toBe(true);
	expect(build.outputs.length).toBeGreaterThan(0);
	return await build.outputs[0].text();
}

describe("the PostgreSQL write path never touches bun:sqlite", () => {
	for (const [module, ownVocabulary] of PG_MODULES) {
		test(`${module} bundles free of the SQLite driver, the raw-handle vocabulary and the bootstrap`, async () => {
			const bundled = await bundle(module);
			for (const marker of FORBIDDEN_MARKERS) {
				expect(bundled, `${module} must not reach ${marker}`).not.toContain(marker);
			}
			for (const symbol of BOOTSTRAP_SYMBOLS) {
				expect(bundled, `${module} must not reach the bootstrap symbol ${symbol}`).not.toContain(
					symbol,
				);
			}
			// Not vacuous: the bundle really contains the module itself.
			expect(bundled).toContain(ownVocabulary);
		}, 60_000);
	}
});
