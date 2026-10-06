import { openDatabase } from "./connection";
import { resolveDatabaseBackendConfig, runPostgresMigrationsOnce } from "./postgres-runtime";
import { runMigrations } from "./run-migrations";

// The backend comes from the same fail-closed resolution the server uses
// (`server/db/postgres-runtime.ts`): explicit selector + URL, default SQLite. A PostgreSQL
// run applies the disk `drizzle-postgres` dispatch AND the search catalog — the server
// startup path would fail its own FTS stage against a database migrated without it.
const databaseConfig = resolveDatabaseBackendConfig();

if (databaseConfig.backend === "postgres") {
	try {
		await runPostgresMigrationsOnce(databaseConfig);
		console.log("PostgreSQL migrations complete.");
		process.exit(0);
	} catch (err) {
		// PostgresStartupError messages are stage-prefixed and credential-scrubbed already.
		console.error("Migration failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}
}

const sqlite = openDatabase();

try {
	const result = await runMigrations(sqlite);
	if (result.source === "embedded") {
		console.log(`Using embedded migrations: ${result.folder}`);
	}
	console.log("Migrations complete.");
	process.exit(0);
} catch (err) {
	console.error("Migration failed:", err instanceof Error ? err.message : err);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
}
