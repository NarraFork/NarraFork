import { openDatabase } from "./connection";
import { runMigrations } from "./run-migrations";

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
