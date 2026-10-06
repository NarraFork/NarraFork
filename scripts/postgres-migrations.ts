import {
	executePostgresMigrations,
	type PostgresMigrationOperation,
} from "./lib/postgres-migration-transaction";

export { executePostgresMigrations } from "./lib/postgres-migration-transaction";

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	if (!command || !["baseline", "generate", "check", "resume"].includes(command)) {
		console.error(
			"Usage: bun scripts/postgres-migrations.ts <baseline|generate|check|resume> [--dry-run|--name NAME|--custom]",
		);
		process.exitCode = 1;
	} else {
		try {
			const result = await executePostgresMigrations(command as PostgresMigrationOperation, args);
			console.log(JSON.stringify(result));
			if (command === "baseline")
				console.log(
					"Baseline is structural snapshot convergence; SQL and journal are not squashed or rewritten.",
				);
		} catch (error) {
			console.error(
				`PostgreSQL migration ${command} failed:`,
				error instanceof Error ? error.message : error,
			);
			process.exitCode = 1;
		}
	}
}
