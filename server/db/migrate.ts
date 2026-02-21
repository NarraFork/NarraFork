import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openDatabase } from "./connection";

const sqlite = openDatabase();

/**
 * Handle legacy databases that were created with the old hand-written 0000_init.sql
 * and runtime schema patches in db/index.ts.
 *
 * This runs BEFORE Drizzle's migrate() so the DB state is compatible with the new
 * auto-generated migration set.
 */
function applyLegacyCompat() {
	// Check if __drizzle_migrations exists (i.e. this is an existing database)
	const hasMigrationsTable = sqlite
		.prepare(
			"SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'",
		)
		.get() as { c: number };

	if (hasMigrationsTable.c === 0) {
		// Fresh database — no compat needed
		return;
	}

	// Check if the old migration was applied (old hand-written 0000_init had timestamp 1771690820000)
	const oldMigration = sqlite
		.prepare("SELECT id FROM __drizzle_migrations WHERE created_at = 1771690820000")
		.get() as { id: number } | undefined;

	if (!oldMigration) {
		// Not a legacy database
		return;
	}

	console.log("Legacy database detected — applying compatibility fixes...");

	// 1. Rename sdk_plan_mode → plan_mode if the old column still exists
	const narratorCols = sqlite.prepare("PRAGMA table_info(narrators)").all() as {
		name: string;
	}[];
	if (narratorCols.some((c) => c.name === "sdk_plan_mode")) {
		sqlite.run("ALTER TABLE narrators RENAME COLUMN sdk_plan_mode TO plan_mode");
		console.log("  Renamed narrators.sdk_plan_mode → plan_mode");
	}

	// 2. Handle legacy claude_session_id → api_conversation_id (pre-0000 databases)
	for (const table of ["narrators", "conversation_branches"]) {
		const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
		if (cols.some((c) => c.name === "claude_session_id")) {
			sqlite.run(`ALTER TABLE ${table} RENAME COLUMN claude_session_id TO api_conversation_id`);
			console.log(`  Renamed ${table}.claude_session_id → api_conversation_id`);
		}
	}

	// 3. Update the migration record timestamp so Drizzle sees it as the new 0000_init
	//    The new auto-generated 0000_init has a different timestamp in _journal.json.
	//    We read the actual timestamp from the journal and update the record.
	const journalPath = resolve(import.meta.dir, "../../drizzle/meta/_journal.json");
	const journal = JSON.parse(readFileSync(journalPath, "utf-8"));
	const newTimestamp = journal.entries[0]?.when;

	if (newTimestamp && newTimestamp !== 1771690820000) {
		sqlite.run("UPDATE __drizzle_migrations SET created_at = ? WHERE id = ?", [
			newTimestamp,
			oldMigration.id,
		]);
		console.log(`  Updated migration timestamp: 1771690820000 → ${newTimestamp}`);
	}

	console.log("Legacy compatibility fixes applied.");
}

try {
	applyLegacyCompat();

	const db = drizzle({ client: sqlite });
	migrate(db, { migrationsFolder: "./drizzle" });
	console.log("Migrations complete.");
	process.exit(0);
} catch (err) {
	console.error("Migration failed:", err instanceof Error ? err.message : err);
	if (err instanceof Error && err.stack) {
		console.error(err.stack);
	}
	process.exit(1);
}
