import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { repairMissingSpecTables, runMigrations, SpecSchemaDriftError } from "./run-migrations";

let sqlite: Database | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

/**
 * A database that already advanced past migration 0058 (so Drizzle will not re-run it)
 * but is missing the Living Work Spec tables. Includes the parent tables the Spec
 * foreign keys reference so structurally-complete Spec tables can be created.
 */
function createPostMigrationLegacyDatabase(): Database {
	const database = new Database(":memory:");
	database.run("PRAGMA foreign_keys = ON");
	database.run("CREATE TABLE narrators (id text PRIMARY KEY NOT NULL)");
	database.run("CREATE TABLE narrator_messages (id text PRIMARY KEY NOT NULL)");
	database.run(`
		CREATE TABLE __drizzle_migrations (
			id integer PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);
	// This timestamp is newer than migration 0058, reproducing an installation
	// where Drizzle skips that historical migration even though its Spec tables are absent.
	database.run(
		"INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('legacy', 1783303131388)",
	);
	return database;
}

/**
 * Structurally-complete `spec_namespaces` matching migration 0058 exactly (columns,
 * primary key, and both foreign keys with their ON DELETE actions). Used to model a
 * database whose Spec schema was only partially created — this table is valid but the
 * other three tables are still missing.
 */
function createCompleteSpecNamespaces(database: Database): void {
	database.run(`
		CREATE TABLE spec_namespaces (
			id text PRIMARY KEY NOT NULL,
			narrator_id text NOT NULL,
			forked_from_namespace_id text,
			created_at text NOT NULL,
			updated_at text NOT NULL,
			FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
			FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
		)
	`);
	database.run("CREATE UNIQUE INDEX idx_spec_namespaces_narrator ON spec_namespaces (narrator_id)");
	database.run(
		"CREATE INDEX idx_spec_namespaces_forked_from ON spec_namespaces (forked_from_namespace_id)",
	);
}

function indexExists(database: Database, name: string): boolean {
	return (
		database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !==
		null
	);
}

describe("Living Work Spec migration repair", () => {
	test("creates the missing Spec table group after migration history already advanced", () => {
		sqlite = createPostMigrationLegacyDatabase();

		expect(repairMissingSpecTables(sqlite)).toBe(true);

		const tables = sqlite
			.prepare(
				`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'spec_%'
				 ORDER BY name`,
			)
			.all() as Array<{ name: string }>;
		expect(tables.map((row) => row.name)).toEqual([
			"spec_file_revisions",
			"spec_namespace_files",
			"spec_namespaces",
			"spec_protected_tasks",
		]);

		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(
			`INSERT INTO spec_file_revisions
			 (id, namespace_id, path, content, content_hash, created_at)
			 VALUES ('revision-1', 'namespace-1', 'tasks.json', '{}', 'hash', 'now')`,
		);
		sqlite.run(
			`INSERT INTO spec_namespace_files
			 (id, namespace_id, path, revision_id, updated_at)
			 VALUES ('file-1', 'namespace-1', 'tasks.json', 'revision-1', 'now')`,
		);

		expect(repairMissingSpecTables(sqlite)).toBe(false);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespace_files").get() as {
					count: number;
				}
			).count,
		).toBe(1);
	});

	test("completes a partially-created Spec schema without deleting existing rows", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespaces").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_protected_tasks'",
				)
				.get(),
		).toBeTruthy();
	});

	test("re-creates missing indexes even when all four Spec table names exist", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);

		// Simulate a database whose tables exist but lost an index (e.g. created by an
		// older repair that only built tables). The repair must NOT short-circuit just
		// because the four table names are present.
		sqlite.run("DROP INDEX idx_spec_file_revisions_parent");
		sqlite.run("DROP INDEX idx_spec_protected_tasks_namespace_status");
		expect(indexExists(sqlite, "idx_spec_file_revisions_parent")).toBe(false);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(indexExists(sqlite, "idx_spec_file_revisions_parent")).toBe(true);
		expect(indexExists(sqlite, "idx_spec_protected_tasks_namespace_status")).toBe(true);

		// Fully complete again — nothing left to repair.
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});

	test("refuses to silently accept an extra unique index that changes write semantics", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);

		// All four expected indexes are present and correct, but an extra unique index
		// was added out of band. This must not be treated as "fully repaired" (false):
		// it silently narrows valid writes (e.g. rejecting distinct namespaces reusing a path).
		sqlite.run("CREATE UNIQUE INDEX legacy_unique_path ON spec_namespace_files (path)");

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/unexpected indexes/);
		expect(indexExists(sqlite, "legacy_unique_path")).toBe(true);
	});

	test("refuses to drop a same-named index owned by an unrelated table", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		sqlite.run("DROP INDEX idx_spec_file_revisions_parent");
		sqlite.run("CREATE TABLE unrelated_records (parent_revision_id text)");
		sqlite.run(
			"CREATE INDEX idx_spec_file_revisions_parent ON unrelated_records (parent_revision_id)",
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/unrelated table/);
		const owner = sqlite
			.prepare(
				"SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'idx_spec_file_revisions_parent'",
			)
			.get() as { tbl_name: string };
		expect(owner.tbl_name).toBe("unrelated_records");
	});

	test("returns false and is a no-op when the whole Spec schema is already valid", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});
});

describe("Living Work Spec schema drift repair", () => {
	test("rebuilds an empty table with the expected column types", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// narrator_id declared as integer instead of text.
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id integer NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const columns = sqlite.prepare("PRAGMA table_info(spec_namespaces)").all() as Array<{
			name: string;
			type: string;
		}>;
		expect(columns.find((column) => column.name === "narrator_id")?.type.toLowerCase()).toBe(
			"text",
		);
		expect(repairMissingSpecTables(sqlite)).toBe(false);
	});

	test("adds a missing required column when the drifted table is empty", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// content_hash column omitted.
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'assistant' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const columns = sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
			name: string;
		}>;
		expect(columns.some((column) => column.name === "content_hash")).toBe(true);
	});

	test("restores a drifted foreign-key action", () => {
		sqlite = createPostMigrationLegacyDatabase();
		// narrator_id foreign key without ON DELETE cascade (defaults to NO ACTION).
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id),
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(spec_namespaces)").all() as Array<{
			from: string;
			on_delete: string;
		}>;
		expect(foreignKeys.find((foreignKey) => foreignKey.from === "narrator_id")?.on_delete).toBe(
			"CASCADE",
		);
	});

	test("rebuilds an index whose uniqueness drifted", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		// Replace the unique narrator index with a non-unique one.
		sqlite.run("DROP INDEX idx_spec_namespaces_narrator");
		sqlite.run("CREATE INDEX idx_spec_namespaces_narrator ON spec_namespaces (narrator_id)");

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const indexes = sqlite.prepare("PRAGMA index_list(spec_namespaces)").all() as Array<{
			name: string;
			unique: number;
		}>;
		expect(indexes.find((index) => index.name === "idx_spec_namespaces_narrator")?.unique).toBe(1);
	});

	test("repairs a drifted column default", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				content_hash text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'system' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const createdBy = (
			sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
				name: string;
				dflt_value: string | null;
			}>
		).find((column) => column.name === "created_by");
		expect(createdBy?.dflt_value).toBe("'assistant'");
	});

	test("repairs an extra foreign key instead of accepting a partial match", () => {
		sqlite = createPostMigrationLegacyDatabase();
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id text NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null,
				FOREIGN KEY (created_at) REFERENCES narrators(id)
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const foreignKeys = sqlite.prepare("PRAGMA foreign_key_list(spec_namespaces)").all();
		expect(foreignKeys).toHaveLength(2);
	});

	test("rebuilds a partial index into the required full-table unique index", () => {
		sqlite = createPostMigrationLegacyDatabase();
		expect(repairMissingSpecTables(sqlite)).toBe(true);
		sqlite.run("DROP INDEX idx_spec_namespace_files_namespace_path");
		sqlite.run(`
			CREATE UNIQUE INDEX idx_spec_namespace_files_namespace_path
			ON spec_namespace_files(namespace_id, path)
			WHERE deleted = 0
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		const index = (
			sqlite.prepare("PRAGMA index_list(spec_namespace_files)").all() as Array<{
				name: string;
				partial: number;
			}>
		).find((row) => row.name === "idx_spec_namespace_files_namespace_path");
		expect(index?.partial).toBe(0);
	});

	test("refuses to discard populated unknown columns during a rebuild", () => {
		sqlite = createPostMigrationLegacyDatabase();
		sqlite.run(`
			CREATE TABLE spec_namespaces (
				id text PRIMARY KEY NOT NULL,
				narrator_id integer NOT NULL,
				forked_from_namespace_id text,
				created_at text NOT NULL,
				updated_at text NOT NULL,
				legacy_payload text NOT NULL,
				FOREIGN KEY (narrator_id) REFERENCES narrators(id) ON DELETE cascade,
				FOREIGN KEY (forked_from_namespace_id) REFERENCES spec_namespaces(id) ON DELETE set null
			)
		`);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces
			 (id, narrator_id, created_at, updated_at, legacy_payload)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now', 'keep-me')`,
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(/populated unknown columns/);
		const row = sqlite
			.prepare("SELECT legacy_payload FROM spec_namespaces WHERE id = 'namespace-1'")
			.get() as { legacy_payload: string };
		expect(row.legacy_payload).toBe("keep-me");
	});

	test("repairs a drifted empty table without mutating valid table data", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id integer PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				created_at text NOT NULL
			)
		`);

		expect(repairMissingSpecTables(sqlite)).toBe(true);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_namespaces").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		expect(
			sqlite
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_protected_tasks'",
				)
				.get(),
		).toBeTruthy();
	});

	test("rolls back when populated rows lack a required column with no safe fallback", () => {
		sqlite = createPostMigrationLegacyDatabase();
		createCompleteSpecNamespaces(sqlite);
		sqlite.run("INSERT INTO narrators (id) VALUES ('narrator-1')");
		sqlite.run(
			`INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at)
			 VALUES ('namespace-1', 'narrator-1', 'now', 'now')`,
		);
		sqlite.run(`
			CREATE TABLE spec_file_revisions (
				id text PRIMARY KEY NOT NULL,
				namespace_id text NOT NULL,
				path text NOT NULL,
				content text NOT NULL,
				parent_revision_id text,
				source_tool_use_id text,
				source_message_id text,
				created_by text DEFAULT 'assistant' NOT NULL,
				created_at text NOT NULL,
				FOREIGN KEY (namespace_id) REFERENCES spec_namespaces(id) ON DELETE cascade,
				FOREIGN KEY (parent_revision_id) REFERENCES spec_file_revisions(id) ON DELETE set null,
				FOREIGN KEY (source_message_id) REFERENCES narrator_messages(id) ON DELETE set null
			)
		`);
		sqlite.run(
			`INSERT INTO spec_file_revisions (id, namespace_id, path, content, created_at)
			 VALUES ('revision-1', 'namespace-1', 'tasks.json', '{}', 'now')`,
		);

		expect(() => repairMissingSpecTables(sqlite as Database)).toThrow(SpecSchemaDriftError);
		expect(
			(
				sqlite.prepare("SELECT COUNT(*) AS count FROM spec_file_revisions").get() as {
					count: number;
				}
			).count,
		).toBe(1);
		const columns = sqlite.prepare("PRAGMA table_info(spec_file_revisions)").all() as Array<{
			name: string;
		}>;
		expect(columns.some((column) => column.name === "content_hash")).toBe(false);
	});
});

describe("terminal_view_state cascade deletes (real migration replay)", () => {
	/**
	 * Replays every committed Drizzle migration against a throwaway in-memory database
	 * and seeds one parent row per referenced table plus one terminal_view_state row for
	 * each foreign key. Exercises the real 0091 migration, not a hand-written schema.
	 */
	async function migratedDatabaseWithViewStateRows(): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		database.run("PRAGMA foreign_keys = ON");

		database.run(
			"INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
			["user-1", "alice", "hash", "now"],
		);
		database.run("INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			"project-1",
			"Project",
			"now",
			"now",
		]);
		database.run(
			`INSERT INTO chapters (id, project_id, title, branch, base_branch, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			["chapter-1", "project-1", "Chapter", "branch-1", "main", "now", "now"],
		);
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"narrator-1",
			"now",
			"now",
		]);

		database.run(
			"INSERT INTO terminal_view_state (id, user_id, chapter_id, updated_at) VALUES (?, ?, ?, ?)",
			["view-chapter", "user-1", "chapter-1", "now"],
		);
		database.run(
			"INSERT INTO terminal_view_state (id, user_id, narrator_id, updated_at) VALUES (?, ?, ?, ?)",
			["view-narrator", "user-1", "narrator-1", "now"],
		);
		database.run("INSERT INTO terminal_view_state (id, user_id, updated_at) VALUES (?, ?, ?)", [
			"view-user",
			"user-1",
			"now",
		]);
		return database;
	}

	function viewStateExists(database: Database, id: string): boolean {
		return database.prepare("SELECT 1 FROM terminal_view_state WHERE id = ?").get(id) !== null;
	}

	test("the migrated foreign keys all declare ON DELETE cascade", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		const foreignKeys = sqlite
			.prepare("PRAGMA foreign_key_list(terminal_view_state)")
			.all() as Array<{ table: string; from: string; on_delete: string }>;

		const byColumn = new Map(foreignKeys.map((fk) => [fk.from, fk]));
		expect(byColumn.get("user_id")?.on_delete).toBe("CASCADE");
		expect(byColumn.get("chapter_id")?.on_delete).toBe("CASCADE");
		expect(byColumn.get("narrator_id")?.on_delete).toBe("CASCADE");
	});

	test("the migrated view-state indexes are preserved after the table rebuild", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		const indexes = (
			sqlite
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE type = 'index' AND tbl_name = 'terminal_view_state'
					   AND name NOT LIKE 'sqlite_%'
					 ORDER BY name`,
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(indexes).toEqual(["idx_view_state_user_chapter", "idx_view_state_user_narrator"]);
	});

	test("deleting a chapter cascades to its terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM chapters WHERE id = ?", ["chapter-1"]);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(false);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(true);
		expect(viewStateExists(sqlite, "view-user")).toBe(true);
	});

	test("deleting a narrator cascades to its terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM narrators WHERE id = ?", ["narrator-1"]);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(false);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(true);
		expect(viewStateExists(sqlite, "view-user")).toBe(true);
	});

	test("deleting a user cascades to all of that user's terminal_view_state rows", async () => {
		sqlite = await migratedDatabaseWithViewStateRows();
		sqlite.run("DELETE FROM users WHERE id = ?", ["user-1"]);
		expect(viewStateExists(sqlite, "view-user")).toBe(false);
		expect(viewStateExists(sqlite, "view-chapter")).toBe(false);
		expect(viewStateExists(sqlite, "view-narrator")).toBe(false);
	});
});
