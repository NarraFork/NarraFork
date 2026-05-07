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
function getMigrationFiles(): string[] {
	return readdirSync(DRIZZLE_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort(); // lexicographic sort matches Drizzle's migration order
}

interface MigrationStatement {
	file: string;
	sql: string;
}

function getMigrationStatements(): MigrationStatement[] {
	return getMigrationFiles().flatMap((file) =>
		readFileSync(join(DRIZZLE_DIR, file), "utf-8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean)
			.map((sql) => ({ file, sql })),
	);
}

const MIGRATION_STATEMENTS = getMigrationStatements();

function isKnownAlreadyAppliedMigrationError(statement: MigrationStatement, err: unknown): boolean {
	const message = String(err);
	if (!message.includes("already exists")) return false;
	if (statement.file !== "0021_goofy_master_mold.sql") return false;
	return [
		"CREATE TABLE `gateway_session_mappings`",
		"CREATE UNIQUE INDEX `idx_gsm_platform_chat_user`",
		"CREATE INDEX `idx_gsm_narrator`",
	].some((prefix) => statement.sql.startsWith(prefix));
}

function applyMigrations(sqlite: Database): void {
	for (const statement of MIGRATION_STATEMENTS) {
		try {
			sqlite.run(statement.sql);
		} catch (err) {
			if (isKnownAlreadyAppliedMigrationError(statement, err)) continue;
			throw err;
		}
	}
}

export function getTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.run("PRAGMA foreign_keys = OFF");
	applyMigrations(sqlite);
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
