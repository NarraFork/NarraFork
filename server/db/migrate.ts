import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { db } from "./index";

try {
	migrate(db, { migrationsFolder: "./drizzle" });
	console.log("Migrations complete.");
	process.exit(0);
} catch (err) {
	console.error(
		"Migration failed:",
		err instanceof Error ? err.message : err,
	);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
}
