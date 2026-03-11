import type { Database } from "bun:sqlite";
import { SQL } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { logger } from "../lib/logger";
import * as schema from "./schema";

/**
 * Ensure all columns defined in the Drizzle schema exist in the actual database.
 *
 * This handles upgrades where a user's existing database was created by an older
 * version that didn't have certain columns. Drizzle migrations only run CREATE TABLE
 * for new databases — they don't ALTER TABLE for existing ones when the migration
 * history diverges (common with compiled single-binary releases).
 *
 * Runs after migrations, before the app starts serving requests.
 */
export function ensureColumns(sqlite: Database): void {
	// Collect all Drizzle table definitions from the schema module
	const tables = Object.values(schema).filter(
		(v) => v != null && typeof v === "object" && "getSQL" in v,
	);

	let addedCount = 0;

	for (const table of tables) {
		let config: ReturnType<typeof getTableConfig>;
		try {
			config = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
		} catch {
			continue;
		}

		const tableName = config.name;

		// Check if the table exists at all — skip if not (will be created by migration)
		const tableExists = sqlite
			.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
			.get(tableName);
		if (!tableExists) continue;

		// Get existing columns from the database
		const existingCols = new Set(
			(sqlite.prepare(`PRAGMA table_info("${tableName}")`).all() as { name: string }[]).map(
				(r) => r.name,
			),
		);

		for (const col of config.columns) {
			if (existingCols.has(col.name)) continue;

			// Build ALTER TABLE ADD COLUMN statement
			const sqlType = mapDrizzleColumnType(col.columnType, col.dataType);
			let ddl = `ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${sqlType}`;

			// SQLite requires a default for NOT NULL columns added via ALTER TABLE
			if (col.default !== undefined) {
				ddl += ` NOT NULL DEFAULT ${formatDefault(col.default)}`;
			} else if (col.notNull) {
				ddl += ` NOT NULL DEFAULT ${defaultForType(sqlType)}`;
			}

			try {
				sqlite.run(ddl);
				addedCount++;
				logger.info("Added missing column to database", {
					table: tableName,
					column: col.name,
				});
			} catch (err) {
				// "duplicate column name" means it was added concurrently — safe to ignore
				if (String(err).includes("duplicate column")) continue;
				logger.error("Failed to add missing column", {
					table: tableName,
					column: col.name,
					ddl,
					error: String(err),
				});
			}
		}
	}

	if (addedCount > 0) {
		logger.info(`Schema patched: added ${addedCount} missing column(s)`);
	}
}

function mapDrizzleColumnType(columnType: string, dataType: string): string {
	const ct = columnType.toLowerCase();
	if (
		ct.includes("integer") ||
		ct.includes("boolean") ||
		dataType === "number" ||
		dataType === "boolean"
	)
		return "INTEGER";
	if (ct.includes("real")) return "REAL";
	return "TEXT";
}

function formatDefault(value: unknown): string {
	if (value instanceof SQL) {
		// Can't easily serialize arbitrary SQL defaults — fall back to type default
		return "''";
	}
	if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	if (value === null || value === undefined) return "NULL";
	return `'${String(value).replace(/'/g, "''")}'`;
}

function defaultForType(sqlType: string): string {
	if (sqlType === "INTEGER") return "0";
	return "''";
}
