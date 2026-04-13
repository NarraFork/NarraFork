/**
 * Test setup: in-memory SQLite database with full schema.
 *
 * Instead of maintaining a hand-written DDL (which drifts from the real schema),
 * we read the latest Drizzle migration SQL files and replay them against an
 * in-memory database. This guarantees the test DB always matches production.
 *
 * Usage:
 *   import { getTestDb, cleanDb } from "../setup";
 *   const { db, sqlite } = getTestDb();
 *   afterEach(() => cleanDb(sqlite));
 */

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../server/db/relations";
import * as schema from "../server/db/schema";

const DRIZZLE_DIR = join(import.meta.dir, "..", "drizzle");

/** Read and sort all migration SQL files from drizzle/ directory. */
function getMigrationSql(): string {
	const files = readdirSync(DRIZZLE_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort(); // lexicographic sort matches Drizzle's migration order
	return files.map((f) => readFileSync(join(DRIZZLE_DIR, f), "utf-8")).join("\n");
}

const MIGRATION_SQL = getMigrationSql();

export function getTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.run("PRAGMA foreign_keys = OFF");
	sqlite.exec(MIGRATION_SQL);
	sqlite.run("PRAGMA foreign_keys = ON");
	const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
	return { db, sqlite };
}

/** Delete all rows from all tables (order matters for FK constraints). */
export function cleanDb(sqlite: Database) {
	sqlite.run("PRAGMA foreign_keys = OFF");
	const tables = sqlite
		.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
		.all() as Array<{ name: string }>;
	for (const { name } of tables) {
		sqlite.run(`DELETE FROM "${name}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
}
