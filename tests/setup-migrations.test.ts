/**
 * The harness must replay the journal exactly as the production runner does, whatever the
 * platform's SQLite defaults are. Apple's SQLite ships `PRAGMA legacy_alter_table = ON` while
 * stock SQLite (Linux CI) defaults to OFF: with ON, Drizzle's `ALTER TABLE __new_x RENAME TO x`
 * does not rewrite the CHECK qualifiers, so 0153 used to die with `no such column:
 * __new_file_attributions.lines_added` before any macOS test could run.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "./setup";

const databases: Database[] = [];
afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

/** Replay the whole journal the way `getTestDb()` does, under a chosen pragma default. */
function replayed(legacyAlterTable: "ON" | "OFF"): Database {
	const sqlite = new Database(":memory:");
	databases.push(sqlite);
	sqlite.run("PRAGMA foreign_keys = OFF");
	sqlite.run(`PRAGMA legacy_alter_table = ${legacyAlterTable}`);
	applyMigrations(sqlite);
	return sqlite;
}

const catalog = (sqlite: Database) =>
	sqlite
		.query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
			"SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name",
		)
		.all();

const definition = (sqlite: Database, name: string) =>
	sqlite
		.query<{ sql: string | null }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?")
		.get(name)?.sql ?? "";

describe("test database migration replay", () => {
	test("replays the whole journal under Apple's legacy_alter_table default", () => {
		const sqlite = replayed("ON");

		// The guard is worthless if the replay merely pinned the pragma back to stock.
		expect(sqlite.prepare("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 1 });
		// A rebuild whose RENAME never completed leaves the scratch table in place.
		expect(
			sqlite.prepare("SELECT name FROM sqlite_master WHERE name GLOB '__new_*'").all(),
		).toEqual([]);

		const table = definition(sqlite, "file_attributions");
		expect(table).toContain("ck_file_attr_line_counts");
		expect(table).not.toContain("__new_file_attributions");

		sqlite.run("PRAGMA foreign_keys = ON");
		sqlite.run(
			`INSERT INTO file_attributions (id,workspace_path,file_path,action,lines_added,changed_at)
			 VALUES ('attr-ok','/ws','a.ts','edit',3,'now')`,
		);
		expect(() =>
			sqlite.run(
				`INSERT INTO file_attributions (id,workspace_path,file_path,action,lines_added,changed_at)
				 VALUES ('attr-negative','/ws','a.ts','edit',-1,'now')`,
			),
		).toThrow(/ck_file_attr_line_counts|CHECK constraint/i);

		expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	test("the platform's pragma default cannot change the schema the harness builds", () => {
		const strict = catalog(replayed("OFF"));
		const apple = catalog(replayed("ON"));

		// Guard against a vacuous pass if the replay ever stops producing a schema.
		expect(strict.length).toBeGreaterThan(100);
		expect(apple).toEqual(strict);
	});
});
