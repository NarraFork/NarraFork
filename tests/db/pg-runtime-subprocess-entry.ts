/**
 * Subprocess entry for the PostgreSQL production-wiring integration test.
 *
 * Boots the REAL database module (`server/db/index.ts`) in PG mode — instance lock, runtime
 * startup (connect → disk drizzle-postgres migrations → ensurePgFts) — composes the stores
 * through the single seam, reports a JSON descriptor on stdout, and exercises shutdown
 * (runtime close + executor gate + instance lock release).
 *
 * This deliberately does NOT import `server/main.ts` (no ports, no HTTP server) and never
 * touches an existing database: the parent test supplies an isolated NARRAFORK_HOME and the
 * throwaway container's NF_DATABASE_URL.
 */
import {
	activeDatabaseBackend,
	closePostgresRuntime,
	postgresRuntime,
	releaseDatabaseInstanceLockOnly,
	startupShutdownState,
} from "../../server/db";
import { composePostgresStores } from "../../server/services/postgres-composition";
import { registrationAccountStore } from "../../server/services/registration/store";
import { searchStore } from "../../server/services/search/backend";

if (!postgresRuntime) {
	throw new Error("postgresRuntime is null even though NF_DATABASE_BACKEND=postgres");
}

composePostgresStores(postgresRuntime);

const accounts = await registrationAccountStore.countAccounts();
const drift = await postgresRuntime.probeFtsDrift();
const migrations = await postgresRuntime.readMigrationState();

console.log(
	JSON.stringify({
		backend: activeDatabaseBackend,
		searchBackend: searchStore.backend,
		accounts,
		ftsDrifted: drift.drifted,
		missingTriggers: drift.missingTriggers,
		migrationCount: migrations.length,
		wasClean: startupShutdownState.wasClean,
	}),
);

await closePostgresRuntime();
let executorRejected = false;
try {
	await postgresRuntime.executor.unsafe("SELECT 1");
} catch {
	executorRejected = true;
}
releaseDatabaseInstanceLockOnly();
console.log(JSON.stringify({ executorRejectedAfterClose: executorRejected }));
process.exit(0);
