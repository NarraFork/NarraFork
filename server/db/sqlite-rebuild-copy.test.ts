import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPendingMigrationsByHash } from "./run-migrations";

const databases: Database[] = [];
const tempFolders: string[] = [];
const migrationsPath = join(import.meta.dir, "../../drizzle");
const breakpoint = "\n--> statement-breakpoint\n";

afterEach(() => {
	for (const database of databases.splice(0)) database.close();
	for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function database(foreignKeys = true): Database {
	const db = new Database(":memory:");
	databases.push(db);
	db.run(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
	return db;
}

function migrationsWith(sql: string, tag = "0000_rebuild_copy"): string {
	const folder = mkdtempSync(join(tmpdir(), "narrafork-rebuild-copy-"));
	tempFolders.push(folder);
	mkdirSync(join(folder, "meta"));
	writeFileSync(
		join(folder, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "sqlite",
			entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag, breakpoints: true }],
		}),
	);
	writeFileSync(join(folder, `${tag}.sql`), sql);
	return folder;
}

function createLegacyX(db: Database, hasRows = true): void {
	db.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL, payload text)");
	if (hasRows) db.run("INSERT INTO x VALUES ('row-1', 'keep-me'), ('row-2', NULL)");
}

function rebuildX(columnSql: string, copySql: string): string {
	return [
		// Prove that failure rolls back statements before the copy as well as the scratch table.
		"CREATE TABLE migration_side_effect (id text);",
		`CREATE TABLE __new_x (id text PRIMARY KEY NOT NULL, payload text${columnSql});`,
		copySql,
		"DROP TABLE x;",
		"ALTER TABLE __new_x RENAME TO x;",
	].join(breakpoint);
}

function expectRollback(db: Database, folder: string, error: RegExp): void {
	const rows = db.query("SELECT * FROM x ORDER BY id").all();
	const schema = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get();
	const fkState = db.query("PRAGMA foreign_keys").get();
	expect(() => applyPendingMigrationsByHash(db, folder)).toThrow(error);
	expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual(rows);
	expect(db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get()).toEqual(schema);
	expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toEqual([]);
	expect(
		db
			.query("SELECT name FROM sqlite_master WHERE name IN ('__new_x', 'migration_side_effect')")
			.all(),
	).toEqual([]);
	expect(db.query("PRAGMA foreign_keys").get()).toEqual(fkState);
}

describe("canonical Drizzle rebuild-copy compatibility", () => {
	test("real 0153 preserves two legacy 13-column attributions, NULLs seven new columns and repairs user deletion", () => {
		const db = database();
		// 0.6.6→0.7.2 failed here: Drizzle CHECKs name `__new_file_attributions.lines_added`,
		// and legacy ALTER TABLE does not rewrite that qualifier on RENAME.
		db.run("PRAGMA legacy_alter_table = ON");
		db.run("CREATE TABLE users (id text PRIMARY KEY NOT NULL)");
		db.run("CREATE TABLE narrators (id text PRIMARY KEY NOT NULL)");
		for (const table of ["file_change_operations", "file_change_effects", "file_change_scopes"]) {
			db.run(`CREATE TABLE ${table} (id text PRIMARY KEY NOT NULL)`);
		}
		db.exec(readFileSync(join(migrationsPath, "0044_bizarre_phalanx.sql"), "utf8"));
		db.run("ALTER TABLE file_attributions ADD device_id text DEFAULT 'local' NOT NULL");
		db.exec(readFileSync(join(migrationsPath, "0146_mysterious_phalanx.sql"), "utf8"));
		db.exec(readFileSync(join(migrationsPath, "0147_easy_grey_gargoyle.sql"), "utf8"));
		expect(db.query("PRAGMA table_info(file_attributions)").all()).toHaveLength(13);
		expect(db.query("PRAGMA foreign_key_list(file_attributions)").all()).toContainEqual(
			expect.objectContaining({ from: "user_id", on_delete: "NO ACTION" }),
		);

		db.run("INSERT INTO users VALUES ('user-1'), ('user-2')");
		db.run("INSERT INTO narrators VALUES ('narrator-1'), ('narrator-2')");
		db.run(`INSERT INTO file_attributions
			(id, device_id, workspace_path, file_path, narrator_id, user_id, subagent_type,
			 action, tool_name, tool_use_id, lines_added, lines_removed, changed_at)
			VALUES
			('attr-1', 'local', '/work/one', 'src/one.ts', 'narrator-1', 'user-1', 'general',
			 'edit', 'Edit', 'tool-1', 12, 4, '2026-09-01T10:00:00Z'),
			('attr-2', 'remote-2', '/work/two', 'src/two.ts', 'narrator-2', 'user-2', NULL,
			 'write', 'Write', 'tool-2', 0, NULL, '2026-09-02T11:00:00Z')`);
		// Fresh statements across DDL: Bun's query() cache can retain SELECT * result column names.
		const oldRows = db.prepare("SELECT * FROM file_attributions ORDER BY id").all() as Array<
			Record<string, string | number | null>
		>;
		const newColumns = {
			operation_id: null,
			effect_id: null,
			scope_id: null,
			file_key: null,
			actor_subject_key: null,
			actor_snapshot_json: null,
			attribution_grade: null,
		};
		const sql = readFileSync(join(migrationsPath, "0153_tan_bushwacker.sql"), "utf8");
		// Exact committed bytes go only to a temporary fixture; never patch drizzle/ or its journal.
		const folder = migrationsWith(sql, "0153_tan_bushwacker");
		applyPendingMigrationsByHash(db, folder);

		expect(db.query("PRAGMA table_info(file_attributions)").all()).toHaveLength(20);
		expect(db.prepare("SELECT * FROM file_attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, ...newColumns })),
		);
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		expect(db.query("PRAGMA foreign_key_check(file_attributions)").all()).toEqual([]);
		expect(db.query("SELECT hash FROM __drizzle_migrations").all()).toEqual([
			{ hash: createHash("sha256").update(sql).digest("hex") },
		]);
		applyPendingMigrationsByHash(db, folder);
		expect(db.prepare("SELECT * FROM file_attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, ...newColumns })),
		);
		db.run("DELETE FROM users WHERE id = 'user-1'");
		expect(db.query("SELECT id, user_id FROM file_attributions ORDER BY id").all()).toEqual([
			{ id: "attr-1", user_id: null },
			{ id: "attr-2", user_id: "user-2" },
		]);
		db.run("DELETE FROM users WHERE id = 'user-2'");
		expect(db.prepare("SELECT * FROM file_attributions ORDER BY id").all()).toEqual(
			oldRows.map((row) => ({ ...row, ...newColumns, user_id: null })),
		);
	});

	test("real 0153 renames under legacy_alter_table because CHECK no longer names __new_file_attributions", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		db.run("CREATE TABLE users (id text PRIMARY KEY NOT NULL)");
		db.run("CREATE TABLE narrators (id text PRIMARY KEY NOT NULL)");
		for (const table of ["file_change_operations", "file_change_effects", "file_change_scopes"]) {
			db.run(`CREATE TABLE ${table} (id text PRIMARY KEY NOT NULL)`);
		}
		db.exec(readFileSync(join(migrationsPath, "0044_bizarre_phalanx.sql"), "utf8"));
		db.run("ALTER TABLE file_attributions ADD device_id text DEFAULT 'local' NOT NULL");
		db.exec(readFileSync(join(migrationsPath, "0146_mysterious_phalanx.sql"), "utf8"));
		db.exec(readFileSync(join(migrationsPath, "0147_easy_grey_gargoyle.sql"), "utf8"));
		db.run(`INSERT INTO file_attributions
			(id, device_id, workspace_path, file_path, narrator_id, user_id, subagent_type,
			 action, tool_name, tool_use_id, lines_added, lines_removed, changed_at)
			VALUES
			('attr-1', 'local', '/work/one', 'src/one.ts', null, null, null,
			 'edit', 'Edit', 'tool-1', 12, 4, '2026-09-01T10:00:00Z')`);
		const sql = readFileSync(join(migrationsPath, "0153_tan_bushwacker.sql"), "utf8");
		applyPendingMigrationsByHash(db, migrationsWith(sql, "0153_tan_bushwacker"));

		const created = db
			.query("SELECT sql FROM sqlite_master WHERE name = 'file_attributions'")
			.get() as {
			sql: string;
		};
		expect(created.sql).not.toContain("__new_file_attributions");
		expect(created.sql).toContain("ck_file_attr_line_counts");
		expect(db.query("SELECT id, lines_added, lines_removed FROM file_attributions").all()).toEqual([
			{ id: "attr-1", lines_added: 12, lines_removed: 4 },
		]);
		expect(() =>
			db.run(`INSERT INTO file_attributions
				(id, device_id, workspace_path, file_path, action, changed_at, lines_added)
				VALUES ('attr-bad', 'local', '/work', 'x.ts', 'edit', '2026-09-01T10:00:00Z', -1)`),
		).toThrow(/ck_file_attr_line_counts|CHECK constraint/i);
		expect(db.query("PRAGMA legacy_alter_table").get()).toEqual({ legacy_alter_table: 1 });
	});

	test("strips this __new_ table's CHECK qualifier without rewriting the same text inside a string", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		createLegacyX(db);
		const sql = [
			`CREATE TABLE __new_x (
				id text PRIMARY KEY NOT NULL,
				payload text,
				added text,
				CONSTRAINT ck_own CHECK("__new_x"."added" IS NULL OR "__new_x"."added" <> 'no'),
				CONSTRAINT ck_literal CHECK(payload IS NULL OR payload <> '__new_x.payload / other_table.payload')
			);`,
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		const created = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get() as {
			sql: string;
		};
		expect(created.sql).not.toMatch(/"__new_x"\s*\.\s*"added"/);
		expect(created.sql).toContain("__new_x.payload / other_table.payload");
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", added: null },
			{ id: "row-2", payload: null, added: null },
		]);
	});

	test("rewrites IF NOT EXISTS rebuild CHECKs the same way", () => {
		const db = database();
		db.run("PRAGMA legacy_alter_table = ON");
		createLegacyX(db);
		const sql = [
			`CREATE TABLE IF NOT EXISTS __new_x (
				id text PRIMARY KEY NOT NULL,
				payload text,
				added text,
				CONSTRAINT ck_own CHECK("__new_x"."added" IS NULL OR "__new_x"."added" <> 'no')
			);`,
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		const created = db.query("SELECT sql FROM sqlite_master WHERE name = 'x'").get() as {
			sql: string;
		};
		expect(created.sql).not.toMatch(/"__new_x"\s*\.\s*"added"/);
		expect(created.sql).toContain("ck_own");
		expect(db.query("SELECT id FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1" },
			{ id: "row-2" },
		]);
	});

	test("omits new columns so text, numeric and expression defaults apply to every copied row", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", label text NOT NULL DEFAULT 'ready', amount integer NOT NULL DEFAULT 7, computed text DEFAULT (upper('ok'))",
			'INSERT INTO __new_x("id", "payload", "label", "amount", "computed") SELECT "id", "payload", "label", "amount", "computed" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", label: "ready", amount: 7, computed: "OK" },
			{ id: "row-2", payload: null, label: "ready", amount: 7, computed: "OK" },
		]);
	});

	test("permits a new required column without a default when the source is empty", () => {
		const db = database();
		createLegacyX(db, false);
		const sql = rebuildX(
			", required text NOT NULL",
			'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([]);
		expect(db.query("PRAGMA table_info(x)").all()).toContainEqual(
			expect.objectContaining({ name: "required", notnull: 1, dflt_value: null }),
		);
	});

	for (const foreignKeys of [true, false]) {
		test(`refuses missing required data and restores foreign_keys=${foreignKeys}`, () => {
			const db = database(foreignKeys);
			createLegacyX(db);
			const sql = rebuildX(
				", required text NOT NULL",
				'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
			);
			expectRollback(db, migrationsWith(sql), /required.*default/i);
		});
	}

	test("keeps existing source values and explicit renames while omitting only the new column", () => {
		const db = database();
		createLegacyX(db);
		db.run("ALTER TABLE x ADD label text");
		db.run("UPDATE x SET label = 'already-stored' WHERE id = 'row-1'");
		const sql = [
			"CREATE TABLE __new_x (id text PRIMARY KEY NOT NULL, renamed text, label text DEFAULT 'wrong', added text);",
			'INSERT INTO __new_x("id", "renamed", "label", "added") SELECT "id", "payload", "label", "added" FROM x;',
			"DROP TABLE x;",
			"ALTER TABLE __new_x RENAME TO x;",
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", renamed: "keep-me", label: "already-stored", added: null },
			{ id: "row-2", renamed: null, label: null, added: null },
		]);
	});

	test("refuses a missing source column with a different target mapping instead of copying a DQS literal", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "missing_payload", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("never suppresses a mapping error whose column name contains an already-exists phrase", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "already exists", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("refuses a copy from a different existing table rather than replacing the original rows", () => {
		const db = database();
		createLegacyX(db);
		db.run("CREATE TABLE another_source (id text, payload text)");
		db.run("INSERT INTO another_source VALUES ('wrong-id', 'wrong-payload')");
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", "added" FROM another_source;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("lets SQLite reject an unusable explicit NULL default without dropping original data", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", required text NOT NULL DEFAULT NULL",
			'INSERT INTO __new_x("id", "payload", "required") SELECT "id", "payload", "required" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /NOT NULL constraint/i);
	});

	test("never tolerates a repaired-copy constraint error as an already-existing object", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			', "already exists" text NOT NULL DEFAULT NULL',
			'INSERT INTO __new_x("id", "payload", "already exists") SELECT "id", "payload", "already exists" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /NOT NULL constraint/i);
	});

	test("allows an empty copy with no remaining source-backed columns", () => {
		const db = database();
		createLegacyX(db, false);
		const sql = rebuildX(
			", added text NOT NULL",
			'INSERT INTO __new_x("added") SELECT "added" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([]);
		expect(db.query("PRAGMA table_info(x)").all()).toContainEqual(
			expect.objectContaining({ name: "added", notnull: 1 }),
		);
	});

	test("refuses to invent rows when no source-backed column remains", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(", added text", 'INSERT INTO __new_x("added") SELECT "added" FROM x;');
		expectRollback(db, migrationsWith(sql), /no source-backed column mapping/i);
	});

	test("refuses an unknown destination column rather than suppressing SQLite column errors", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			"",
			'INSERT INTO __new_x("id", "payload", "missing") SELECT "id", "payload", "missing" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /column|mapping/i);
	});

	test("rolls back a missing source table without running later DROP statements", () => {
		const db = database();
		createLegacyX(db);
		const sql = [
			"CREATE TABLE __new_missing_source (id text, added text);",
			'INSERT INTO __new_missing_source("id", "added") SELECT "id", "added" FROM missing_source;',
			"DROP TABLE x;",
		].join(breakpoint);
		expectRollback(db, migrationsWith(sql), /no such table|missing source table/i);
		expect(
			db.query("SELECT name FROM sqlite_master WHERE name = '__new_missing_source'").get(),
		).toBeNull();
	});

	test("rejects mismatched list lengths instead of inventing column mappings", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping|values.*columns/i);
	});

	test("rejects duplicate destination mappings even when SQLite would silently ignore one", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "payload", "added") SELECT "id", "payload", "payload", "added" FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /mapping/i);
	});

	test("does not rewrite complex expressions, aliases or clauses", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			`INSERT INTO __new_x("id", "payload", "added") SELECT "id", upper("payload"), 'explicit' AS added FROM x WHERE id = 'row-1';`,
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x").all()).toEqual([
			{ id: "row-1", payload: "KEEP-ME", added: "explicit" },
		]);
	});

	test("does not guess a missing identifier inside a complex expression", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text",
			'INSERT INTO __new_x("id", "payload", "added") SELECT "id", "payload", upper(`added`) FROM x;',
		);
		expectRollback(db, migrationsWith(sql), /no such column/i);
	});

	test("does not treat unquoted SQL constants as missing source identifiers", () => {
		const db = database();
		createLegacyX(db);
		const sql = rebuildX(
			", added text DEFAULT 'wrong', flag integer DEFAULT 0",
			'INSERT INTO __new_x("id", "payload", "added", "flag") SELECT "id", "payload", NULL, TRUE FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", added: null, flag: 1 },
			{ id: "row-2", payload: null, added: null, flag: 1 },
		]);
	});

	test("does not mistake a different Unicode case for an existing SQLite identifier", () => {
		const db = database();
		createLegacyX(db);
		db.run('ALTER TABLE x ADD "Ä" text');
		db.run(`UPDATE x SET "Ä" = 'keep-unicode'`);
		const sql = rebuildX(
			', "Ä" text, "ä" text',
			'INSERT INTO __new_x("id", "payload", "Ä", "ä") SELECT "id", "payload", "Ä", "ä" FROM x;',
		);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
			{ id: "row-1", payload: "keep-me", Ä: "keep-unicode", ä: null },
			{ id: "row-2", payload: null, Ä: "keep-unicode", ä: null },
		]);
	});

	test("preserves non-rebuild INSERT SELECT statements verbatim", () => {
		const db = database();
		createLegacyX(db);
		const sql = [
			"CREATE TABLE archive (id text, label text);",
			'INSERT INTO archive("id", "label") SELECT "id", "literal_label" FROM x;',
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query("SELECT * FROM archive ORDER BY id").all()).toEqual([
			{ id: "row-1", label: "literal_label" },
			{ id: "row-2", label: "literal_label" },
		]);
	});

	test("handles quoted commas and escaped quotes as identifiers, not list separators", () => {
		const db = database();
		db.run('CREATE TABLE "Odd,table" ("ID" text, "pay""load" text)');
		db.run(`INSERT INTO "Odd,table" VALUES ('row-1', 'keep-me')`);
		const sql = [
			'CREATE TABLE "__new_Odd,table" ("ID" text, "pay""load" text, "new,col" text);',
			'INSERT INTO "__new_Odd,table"("id", "pay""load", "new,col") SELECT "id", "pay""load", "new,col" FROM "Odd,table";',
			'DROP TABLE "Odd,table";',
			'ALTER TABLE "__new_Odd,table" RENAME TO "Odd,table";',
		].join(breakpoint);
		applyPendingMigrationsByHash(db, migrationsWith(sql));
		expect(db.query('SELECT * FROM "Odd,table"').all()).toEqual([
			{ ID: "row-1", 'pay"load': "keep-me", "new,col": null },
		]);
	});

	for (const quote of [
		(name: string) => name,
		(name: string) => `[${name}]`,
		(name: string) => `\`${name}\``,
	]) {
		test(`accepts canonical identifiers quoted as ${quote("column")}`, () => {
			const db = database();
			createLegacyX(db);
			const columns = ["id", "payload", "added"].map(quote).join(", ");
			const sql = rebuildX(
				", added text",
				`INSERT INTO ${quote("__new_x")}(${columns}) SELECT ${columns} FROM ${quote("x")};`,
			);
			applyPendingMigrationsByHash(db, migrationsWith(sql));
			expect(db.query("SELECT * FROM x ORDER BY id").all()).toEqual([
				{ id: "row-1", payload: "keep-me", added: null },
				{ id: "row-2", payload: null, added: null },
			]);
		});
	}
});
