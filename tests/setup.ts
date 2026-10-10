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
import { ensureColumns } from "../server/db/ensure-columns";
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
	ensureColumns(sqlite);
	// PR6's identity tables have no generated migration yet. Only add in-memory
	// fixtures here; production databases and migration files are never changed.
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS user_git_identities (
			id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name TEXT NOT NULL, email TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_user_git_identities_user ON user_git_identities(user_id, created_at);
		CREATE TABLE IF NOT EXISTS narrator_git_identity_bindings (
			id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL REFERENCES narrators(id) ON DELETE CASCADE,
			user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			identity_id TEXT NOT NULL REFERENCES user_git_identities(id) ON DELETE CASCADE,
			updated_at TEXT NOT NULL
		);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_narrator_git_identity_unique ON narrator_git_identity_bindings(narrator_id, user_id);
		CREATE INDEX IF NOT EXISTS idx_narrator_git_identity_user ON narrator_git_identity_bindings(user_id);
	`);
	sqlite.run("PRAGMA foreign_keys = ON");
	const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
	return { db, sqlite };
}

/**
 * Delete all rows from every ordinary table (FK enforcement is off for the duration).
 *
 * Virtual tables and the shadow tables backing them are skipped. SQLite refuses
 * direct writes to an FTS5 shadow table (`<name>_data`, `_idx`, `_content`, …),
 * so a test that mirrors production by calling `ensureFts` would otherwise fail
 * here. Deleting the base-table rows is enough: the FTS sync triggers keep the
 * index in step.
 */
export function cleanDb(sqlite: Database) {
	sqlite.run("PRAGMA foreign_keys = OFF");
	const allTables = (
		sqlite
			.prepare(
				"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
			)
			.all() as Array<{ name: string; sql: string | null }>
	).map((row) => ({
		name: row.name,
		isVirtual: /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ""),
	}));

	const virtualNames = allTables.filter((t) => t.isVirtual).map((t) => t.name);
	const isShadowTable = (name: string) =>
		virtualNames.some((virtualName) => name.startsWith(`${virtualName}_`));

	for (const { name, isVirtual } of allTables) {
		if (isVirtual || isShadowTable(name)) continue;
		sqlite.run(`DELETE FROM "${name}"`);
	}
	sqlite.run("PRAGMA foreign_keys = ON");
}
