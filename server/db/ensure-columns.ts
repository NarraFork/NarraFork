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
				ddl += ` NOT NULL DEFAULT ${formatDefault(col.default, col.dataType)}`;
			} else if (col.notNull) {
				ddl += ` NOT NULL DEFAULT ${defaultForType(sqlType, col.dataType)}`;
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

/**
 * Serialize a column default for `ALTER TABLE ... ADD COLUMN`.
 *
 * `dataType === "json"` is checked FIRST and deliberately. A JSON-mode column
 * (`text("traits", { mode: "json" }).default([])`) carries its default as a plain JS
 * value — `[]` — and the generic fallback below stringifies it, and `String([])` is `""`.
 * That produced `TEXT NOT NULL DEFAULT ''`: a syntactically fine ALTER TABLE whose every
 * existing row then held `''`, which is not JSON. Drizzle's row mapper calls `JSON.parse`
 * on every JSON-mode value it reads, so `db.query.<table>.findFirst()` threw
 * "JSON Parse error: Unexpected EOF" for the whole table, taking every reader down with it.
 * The default must therefore be a JSON LITERAL, not the value's `String()` form.
 */
function formatDefault(value: unknown, dataType?: string): string {
	if (dataType === "json") return formatJsonDefault(value);
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

/**
 * A JSON-mode default, as a quoted JSON literal.
 *
 * A drizzle `sql` default cannot be read back (the same limitation the generic branch
 * above admits), so it falls back to `'[]'`: the one value that is valid JSON for every
 * JSON column shape declared in this schema, and the empty case those columns mean when
 * they are unset. Every caller here is a `notNull` column, so "no value" is not an option.
 */
function formatJsonDefault(value: unknown): string {
	if (value instanceof SQL) return "'[]'";
	return `'${JSON.stringify(value ?? null).replace(/'/g, "''")}'`;
}

function defaultForType(sqlType: string, dataType?: string): string {
	if (dataType === "json") return "'[]'";
	if (sqlType === "INTEGER") return "0";
	return "''";
}
