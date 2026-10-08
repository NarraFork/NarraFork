/**
 * JSON-mode column defaults MUST be valid JSON.
 *
 * `ensureColumns` patches a column an older build never created. For a JSON-mode column
 * it must write a JSON LITERAL: a generic stringify turns `[]` into `""`, and
 * `String([])` is `""` — so `text("traits", { mode: "json" }).default([])` became
 * `TEXT NOT NULL DEFAULT ''`. Every existing row then held `''`.
 *
 * That is not a degraded field, it is an unreadable ROW: drizzle's row mapper runs
 * `JSON.parse` on every JSON-mode value it selects, and `JSON.parse("")` throws
 * "JSON Parse error: Unexpected EOF". One bad value took down every reader of the table
 * — `db.query.userPreferences.findFirst()` included, which is why admin preferences
 * could be neither read nor saved. In production it ran silently for five weeks.
 *
 * These tests pin the two halves of the repair: the DDL default that is written, and the
 * normalization of rows already damaged.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { getTableColumns, SQL, sql } from "drizzle-orm";
import { applySqliteDataBackfills } from "../data-backfills";
import { ensureColumns } from "../ensure-columns";
import { runMigrations } from "../run-migrations";
import * as schema from "../schema";

const databases: Database[] = [];

function openDatabase(): Database {
	const database = new Database(":memory:");
	databases.push(database);
	return database;
}

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
});

/**
 * `PRAGMA table_info` reports the default as the raw SQL LITERAL, so a correct one reads
 * `'[]'` — quotes included. Unwrap exactly that outer layer before parsing. The failure
 * mode this guards is the literal `''`: valid SQL, and not JSON at all.
 */
function expectValidJsonLiteral(value: string | null): void {
	const literal = String(value);
	expect(literal).not.toBe("''");
	const inner = literal.startsWith("'") && literal.endsWith("'") ? literal.slice(1, -1) : literal;
	expect(JSON.parse(inner)).toEqual([]);
}

describe("JSON-mode column defaults", () => {
	test("every JSON column default is a serializable literal, including cleanup policy objects", () => {
		// Literal objects and arrays must retain their declared shape. SQL expressions are
		// unknown to ensureColumns and are tested separately for a safe, parseable fallback.
		const offenders: string[] = [];
		for (const [tableName, table] of Object.entries(schema)) {
			if (table == null || typeof table !== "object" || !("getSQL" in table)) continue;
			let columns: Record<string, Record<string, unknown>>;
			try {
				columns = getTableColumns(table as never) as Record<string, Record<string, unknown>>;
			} catch {
				continue;
			}
			for (const [columnName, column] of Object.entries(columns)) {
				if (column?.dataType !== "json" || !column.hasDefault) continue;
				if (column.default instanceof SQL) {
					offenders.push(`${tableName}.${columnName}=unknown SQL default`);
					continue;
				}
				const encoded = JSON.stringify(column.default);
				if (encoded === undefined || JSON.stringify(JSON.parse(encoded)) !== encoded)
					offenders.push(`${tableName}.${columnName}=${encoded}`);
			}
		}
		expect(offenders).toEqual([]);
		expect(schema.scheduledTasks.cleanupPolicy.default).toEqual({ mode: "none" });
	});

	test("an older table receives its declared JSON object default for existing and new rows", () => {
		const database = openDatabase();
		database.run("CREATE TABLE scheduled_tasks (id text PRIMARY KEY NOT NULL)");
		database.run("INSERT INTO scheduled_tasks(id) VALUES ('existing')");
		ensureColumns(database);
		database.run("INSERT INTO scheduled_tasks(id) VALUES ('new')");
		const info = database
			.query<{ name: string; dflt_value: string }, []>("PRAGMA table_info('scheduled_tasks')")
			.all();
		expect(info.find((column) => column.name === "cleanup_policy")?.dflt_value).toBe(
			'\'{"mode":"none"}\'',
		);
		const rows = database
			.query<{ cleanup_policy: string }, []>(
				"SELECT cleanup_policy FROM scheduled_tasks ORDER BY id",
			)
			.all();
		expect(rows.map((row) => JSON.parse(row.cleanup_policy))).toEqual([
			{ mode: "none" },
			{ mode: "none" },
		]);
	});

	test("an unknown SQL JSON default is not executed and falls back to a parseable array", () => {
		const database = openDatabase();
		database.run("CREATE TABLE projects (id text PRIMARY KEY NOT NULL, name text NOT NULL)");
		database.run("INSERT INTO projects(id, name) VALUES ('existing', 'demo')");
		const column = schema.projects.traits;
		const previous = column.default;
		try {
			expect(Reflect.set(column, "default", sql`unrecognized_json_default('do not execute')`)).toBe(
				true,
			);
			ensureColumns(database);
		} finally {
			expect(Reflect.set(column, "default", previous)).toBe(true);
		}
		const row = database.query<{ traits: string }, []>("SELECT traits FROM projects").get();
		expect(row?.traits).toBe("[]");
		expect(JSON.parse(row?.traits ?? "")).toEqual([]);
	});

	test("a column an older build never created is added with a parseable JSON default", () => {
		const database = openDatabase();
		// An older `projects` table: present, but predating the JSON-mode `traits` column.
		database.run("CREATE TABLE projects (id text PRIMARY KEY NOT NULL, name text NOT NULL)");

		ensureColumns(database);

		const info = database.prepare("PRAGMA table_info('projects')").all() as Array<{
			name: string;
			dflt_value: string | null;
		}>;
		const traits = info.find((column) => column.name === "traits");
		expect(traits).toBeDefined();
		expectValidJsonLiteral(traits?.dflt_value ?? null);

		// And the value a row actually receives must survive the mapper that reads it.
		database.run("INSERT INTO projects (id, name) VALUES ('p1', 'demo')");
		const stored = (
			database
				.query<{ traits: string }, []>("SELECT traits FROM projects WHERE id = 'p1'")
				.get() as {
				traits: string;
			}
		).traits;
		expect(stored).toBe("[]");
		expect(() => JSON.parse(stored)).not.toThrow();
	});

	test("normalization repairs every table carrying the JSON traits column", async () => {
		const database = openDatabase();
		await runMigrations(database);

		// The damage as found in the wild: `''` from the bad ALTER TABLE default, plus a
		// malformed value, alongside a legitimate one that must be left alone.
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES ('n1','now','now')");
		database.run(
			"INSERT INTO projects (id, name, created_at, updated_at) VALUES ('p1','demo','now','now')",
		);
		database.run(
			`INSERT INTO user_preferences (id, user_id, created_at, updated_at)
			 VALUES ('pref-admin','admin','now','now'), ('pref-bot','bot','now','now'), ('pref-ok','ok','now','now')`,
		);
		database.run("UPDATE narrators SET traits = ''");
		database.run("UPDATE projects SET traits = CAST('' AS TEXT)");
		database.run("UPDATE user_preferences SET traits = '' WHERE user_id = 'admin'");
		database.run("UPDATE user_preferences SET traits = 'broken-json' WHERE user_id = 'bot'");
		database.run("UPDATE user_preferences SET traits = '[\"kept\"]' WHERE user_id = 'ok'");

		await applySqliteDataBackfills(database);

		// No table may retain an unreadable value...
		for (const table of ["narrators", "projects", "user_preferences"]) {
			const bad = (
				database
					.query<{ c: number }, []>(
						`SELECT COUNT(*) AS c FROM "${table}" WHERE traits IS NULL OR traits = '' OR json_valid(traits) = 0`,
					)
					.get() as { c: number }
			).c;
			expect(bad).toBe(0);
		}
		// ...and a legitimate array is not overwritten.
		const kept = (
			database
				.query<{ traits: string }, []>("SELECT traits FROM user_preferences WHERE user_id = 'ok'")
				.get() as { traits: string }
		).traits;
		expect(kept).toBe('["kept"]');
	});
});
