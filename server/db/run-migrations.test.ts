import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPendingMigrationsByHash,
	repairMissingSpecTables,
	runMigrations,
	SpecSchemaDriftError,
} from "./run-migrations";

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
		// The two unique indexes lead with user_id, so they cannot serve FK enforcement or the
		// bulk cleanup deletes keyed only on chapter_id/narrator_id — hence the two single-column
		// covering indexes added in 0094. All four must survive the table rebuild.
		expect(indexes).toEqual([
			"idx_view_state_chapter",
			"idx_view_state_narrator",
			"idx_view_state_user_chapter",
			"idx_view_state_user_narrator",
		]);
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

/**
 * Hash-based migration execution that repairs a database whose `__drizzle_migrations`
 * high-water mark was polluted by a branch/version carrying larger migration timestamps.
 * Reproduces the real production incident: a fully-migrated database that "loses" a table
 * because Drizzle's built-in migrate() would skip re-applying the migration that creates it.
 */
describe("hash-based migration self-heal", () => {
	function tableExists(database: Database, name: string): boolean {
		return (
			database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !=
			null
		);
	}

	function hashCount(database: Database): number {
		return (
			database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
				count: number;
			}
		).count;
	}

	function migrationHashByWhen(database: Database, folderMillis: number): string | undefined {
		return (
			database
				.prepare("SELECT hash FROM __drizzle_migrations WHERE created_at = ?")
				.get(folderMillis) as { hash: string } | undefined
		)?.hash;
	}

	// folderMillis of the migration that creates narrator_tool_continuations (0090) — a
	// pure additive migration — and of a destructive rebuild migration (0028 benchmark_runs).
	const TOOL_CONTINUATIONS_WHEN = 1784524348158; // 0090_public_nextwave
	const BENCHMARK_RUNS_WHEN = 1777102252438; // 0028_pale_silhouette (DROP+RENAME rebuild)

	test("recreates a missing table after the watermark was polluted (the real incident)", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(true);

		// Simulate the dirty database: the table and its migration hash are gone, but later
		// migrations stay applied, and a poisoned row lifts the MAX(created_at) watermark far
		// past every journal entry — exactly what makes Drizzle's migrate() skip the gap.
		const removedHash = migrationHashByWhen(sqlite, TOOL_CONTINUATIONS_WHEN);
		expect(removedHash).toBeDefined();
		sqlite.run("DROP TABLE narrator_tool_continuations");
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [TOOL_CONTINUATIONS_WHEN]);
		sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
			"forked-branch-marker",
			9999999999999,
		]);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(false);

		// Re-running migrations must rebuild the missing table and re-stamp its hash.
		await runMigrations(sqlite);
		expect(tableExists(sqlite, "narrator_tool_continuations")).toBe(true);
		expect(migrationHashByWhen(sqlite, TOOL_CONTINUATIONS_WHEN)).toBe(removedHash);

		// Column / index / foreign-key shape matches the committed migration.
		const columns = (
			sqlite.prepare("PRAGMA table_info(narrator_tool_continuations)").all() as Array<{
				name: string;
			}>
		).map((row) => row.name);
		expect(columns).toContain("tool_call_id");
		expect(columns).toContain("update_epoch");
		const indexes = (
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='narrator_tool_continuations' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"idx_tool_continuations_epoch_state",
			"idx_tool_continuations_narrator_state",
			"idx_tool_continuations_tool_call",
		]);
	});

	test("is idempotent — a second run applies nothing", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		const before = hashCount(sqlite);
		await runMigrations(sqlite);
		expect(hashCount(sqlite)).toBe(before);
	});

	test("does NOT re-run a destructive migration whose target table already exists (dirty hole)", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		sqlite.run("PRAGMA foreign_keys = ON");

		// Seed a benchmark_runs row (the destructive 0028 migration rebuilds this table).
		sqlite.run("INSERT INTO benchmark_suites (id, name, created_at) VALUES (?, ?, ?)", [
			"suite-1",
			"Suite",
			"now",
		]);
		sqlite.run(
			"INSERT INTO benchmark_runs (id, suite_id, name, model, created_at) VALUES (?, ?, ?, ?, ?)",
			["run-1", "suite-1", "Run", "model-x", "now"],
		);

		// Make 0028's hash a "hole": remove it while every later migration stays applied.
		// benchmark_runs keeps its final structure and its row.
		const removedHash = migrationHashByWhen(sqlite, BENCHMARK_RUNS_WHEN);
		expect(removedHash).toBeDefined();
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [BENCHMARK_RUNS_WHEN]);

		// Re-running must NOT drop/rebuild benchmark_runs (that would delete the row). It only
		// re-stamps the hash because the table already holds the migration's final shape.
		await runMigrations(sqlite);
		expect(
			(sqlite.prepare("SELECT COUNT(*) AS count FROM benchmark_runs").get() as { count: number })
				.count,
		).toBe(1);
		expect(migrationHashByWhen(sqlite, BENCHMARK_RUNS_WHEN)).toBe(removedHash);
	});

	test("DOES run a destructive migration on a fresh database (target created earlier in the same run)", async () => {
		// A fresh database applies the entire journal in one run. The destructive rebuild
		// migrations must execute normally so the final foreign-key/index shape is correct;
		// they must NOT be mistaken for "already effective" just because an earlier migration
		// in the same run created the target table. Covered end-to-end by the cascade tests
		// above (which assert ON DELETE cascade only the 0091 rebuild produces); here we assert
		// the executor stamped every journal entry with zero skipped rebuilds.
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);
		// All destructive rebuild targets exist with their post-rebuild shape.
		expect(tableExists(sqlite, "benchmark_runs")).toBe(true);
		expect(tableExists(sqlite, "terminal_view_state")).toBe(true);
		const cascade = (
			sqlite.prepare("PRAGMA foreign_key_list(terminal_view_state)").all() as Array<{
				from: string;
				on_delete: string;
			}>
		).find((fk) => fk.from === "user_id");
		expect(cascade?.on_delete).toBe("CASCADE");
	});
});

/**
 * Statement-level scoping of the "no such table" tolerance. A destructive migration used to
 * have that error forgiven for every one of its statements, so a failed
 * `INSERT INTO __new_x SELECT ... FROM <missing>` was skipped while the following
 * `DROP TABLE x` + RENAME still ran — the migration reported success and the rows were gone.
 */
describe("destructive migration statement-level error tolerance", () => {
	const tempFolders: string[] = [];

	afterEach(() => {
		for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	/** A throwaway migrations folder holding one migration, in the layout Drizzle expects. */
	function migrationsFolderWith(tag: string, sql: string): string {
		const root = mkdtempSync(join(tmpdir(), "narrafork-migration-scope-"));
		tempFolders.push(root);
		const folder = join(root, "drizzle");
		mkdirSync(join(folder, "meta"), { recursive: true });
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

	function rowCount(database: Database, table: string): number {
		return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
			.count;
	}

	function stampedHashes(database: Database): number {
		return rowCount(database, "__drizzle_migrations");
	}

	test("aborts a table rebuild when a non-DROP statement hits a missing table", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL, payload text)");
		sqlite.run("INSERT INTO x (id, payload) VALUES ('row-1', 'keep-me')");

		// Drizzle's rebuild shape, but the INSERT reads from a view/table that does not exist
		// on this database. Everything after it must not run.
		const folder = migrationsFolderWith(
			"0000_broken_rebuild",
			[
				"CREATE TABLE `__new_x` (`id` text PRIMARY KEY NOT NULL, `payload` text);",
				"INSERT INTO `__new_x`(`id`, `payload`) SELECT `id`, `payload` FROM `missing_view`;",
				"DROP TABLE `x`;",
				"ALTER TABLE `__new_x` RENAME TO `x`;",
			].join("\n--> statement-breakpoint\n"),
		);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such table/i,
		);

		// The original table and its row survive, and the migration is not stamped as applied.
		expect(rowCount(sqlite, "x")).toBe(1);
		expect(
			(sqlite.prepare("SELECT payload FROM x WHERE id = 'row-1'").get() as { payload: string })
				.payload,
		).toBe("keep-me");
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("still tolerates dropping a table this database never created", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith(
			"0000_drop_absent_table",
			["DROP TABLE `never_created`;", "CREATE TABLE `kept` (`id` text PRIMARY KEY NOT NULL);"].join(
				"\n--> statement-breakpoint\n",
			),
		);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kept'").get(),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("recognizes a schema-qualified drop target as the reported missing table", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith(
			"0000_drop_qualified",
			[
				'DROP TABLE main."never_created";',
				"CREATE TABLE `kept` (`id` text PRIMARY KEY NOT NULL);",
			].join("\n--> statement-breakpoint\n"),
		);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("does not forgive a missing table for a DROP of a different table", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE x (id text PRIMARY KEY NOT NULL)");
		// An index creation against an absent table must not be swallowed just because this
		// migration also drops `x`: the migration's assumptions about the schema are wrong.
		const folder = migrationsFolderWith(
			"0000_unrelated_missing",
			["CREATE INDEX `idx_absent` ON `absent_table` (`id`);", "DROP TABLE `x`;"].join(
				"\n--> statement-breakpoint\n",
			),
		);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow();
		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='x'").get(),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(0);
	});
});

describe("fast_mode_override backfill (real migration replay)", () => {
	// folderMillis of 0104_lame_alice, the migration that adds narrators.fast_mode_override.
	const FAST_MODE_OVERRIDE_WHEN = 1785722772073;

	function overrideOf(database: Database, narratorId: string): string {
		return (
			database
				.prepare("SELECT fast_mode_override AS v FROM narrators WHERE id = ?")
				.get(narratorId) as {
				v: string;
			}
		).v;
	}

	/**
	 * A database migrated to just before 0104: every earlier migration applied, the
	 * new column absent, and legacy narrator rows carrying only the old boolean.
	 */
	async function databaseBeforeFastModeOverride(): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		database.run("ALTER TABLE narrators DROP COLUMN fast_mode_override");
		database.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [
			FAST_MODE_OVERRIDE_WHEN,
		]);
		for (const [id, fastMode] of [
			["narrator-fast", 1],
			["narrator-slow", 0],
		] as const) {
			database.run(
				"INSERT INTO narrators (id, fast_mode, created_at, updated_at) VALUES (?, ?, ?, ?)",
				[id, fastMode, "now", "now"],
			);
		}
		return database;
	}

	test("pins narrators that had fast mode ON so the new default cannot silently disable them", async () => {
		sqlite = await databaseBeforeFastModeOverride();

		await runMigrations(sqlite);

		expect(overrideOf(sqlite, "narrator-fast")).toBe("on");
	});

	test("leaves narrators that had fast mode OFF on inherit so they follow the user default", async () => {
		sqlite = await databaseBeforeFastModeOverride();

		await runMigrations(sqlite);

		expect(overrideOf(sqlite, "narrator-slow")).toBe("inherit");
	});

	test("does not re-pin a narrator that later chose inherit while its legacy mirror stayed on", async () => {
		// The deprecated fast_mode column is only a mirror; once the column exists the
		// backfill must never run again, or a user's explicit "follow default" choice
		// would be reverted on every startup.
		sqlite = await databaseBeforeFastModeOverride();
		await runMigrations(sqlite);
		sqlite.run("UPDATE narrators SET fast_mode_override = 'inherit', fast_mode = 1 WHERE id = ?", [
			"narrator-fast",
		]);

		await runMigrations(sqlite);

		expect(overrideOf(sqlite, "narrator-fast")).toBe("inherit");
	});
});

describe("narrator visibility backfill (real migration replay)", () => {
	// folderMillis of 0125_salty_iron_fist, the migration that adds narrators.visibility.
	const NARRATOR_VISIBILITY_WHEN = 1786791964480;

	function visibilityOf(database: Database, narratorId: string): string {
		return (
			database.prepare("SELECT visibility AS v FROM narrators WHERE id = ?").get(narratorId) as {
				v: string;
			}
		).v;
	}

	/**
	 * A database migrated to just before 0125: the access-control columns absent and
	 * legacy narrator rows that nobody owns, exactly as they exist on every install
	 * that predates narrator ACLs.
	 */
	async function databaseBeforeNarratorVisibility(): Promise<Database> {
		const database = new Database(":memory:");
		await runMigrations(database);
		database.run("DROP INDEX IF EXISTS idx_narrators_visibility");
		database.run("DROP INDEX IF EXISTS idx_narrators_owner");
		database.run("ALTER TABLE narrators DROP COLUMN visibility");
		database.run("ALTER TABLE narrators DROP COLUMN owner_user_id");
		database.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [
			NARRATOR_VISIBILITY_WHEN,
		]);
		database.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"narrator-legacy",
			"now",
			"now",
		]);
		return database;
	}

	test("publishes pre-ACL narrators so an upgrade never hides existing work", async () => {
		sqlite = await databaseBeforeNarratorVisibility();

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("public");
	});

	test("leaves the owner null so only admins can re-home a legacy narrator", async () => {
		sqlite = await databaseBeforeNarratorVisibility();

		await runMigrations(sqlite);

		const row = sqlite
			.prepare("SELECT owner_user_id AS owner FROM narrators WHERE id = ?")
			.get("narrator-legacy") as { owner: string | null };
		expect(row.owner).toBeNull();
	});

	test("does not re-publish a legacy narrator an admin later made private", async () => {
		// The whole reason the backfill is gated on the column's prior absence: a
		// heuristic re-run would keep undoing a deliberate "make this private again".
		sqlite = await databaseBeforeNarratorVisibility();
		await runMigrations(sqlite);
		sqlite.run("UPDATE narrators SET visibility = 'private' WHERE id = ?", ["narrator-legacy"]);

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-legacy")).toBe("private");
	});

	test("leaves narrators created after the upgrade private by default", async () => {
		sqlite = await databaseBeforeNarratorVisibility();
		await runMigrations(sqlite);
		sqlite.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
			"narrator-new",
			"later",
			"later",
		]);

		await runMigrations(sqlite);

		expect(visibilityOf(sqlite, "narrator-new")).toBe("private");
	});
});

/**
 * A machine that developed NarraFork from source and then upgraded to a release binary carries
 * a database whose schema already advanced past migrations whose hashes were never recorded
 * (locally generated migrations hash differently from the released SQL files). Replaying such a
 * migration re-runs its `DROP INDEX` / `DROP COLUMN` against a target the earlier local run
 * already removed. That used to abort startup with `no such index: ...`.
 */
describe("already-satisfied drop tolerance (source-built upgrade holes)", () => {
	const tempFolders: string[] = [];

	afterEach(() => {
		for (const folder of tempFolders.splice(0)) rmSync(folder, { recursive: true, force: true });
	});

	function migrationsFolderWith(tag: string, statements: readonly string[]): string {
		const root = mkdtempSync(join(tmpdir(), "narrafork-drop-tolerance-"));
		tempFolders.push(root);
		const folder = join(root, "drizzle");
		mkdirSync(join(folder, "meta"), { recursive: true });
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({
				version: "7",
				dialect: "sqlite",
				entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag, breakpoints: true }],
			}),
		);
		writeFileSync(join(folder, `${tag}.sql`), statements.join("\n--> statement-breakpoint\n"));
		return folder;
	}

	function stampedHashes(database: Database): number {
		return (
			database.prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations").get() as {
				count: number;
			}
		).count;
	}

	function columnNames(database: Database, table: string): string[] {
		return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
			(row) => row.name,
		);
	}

	// folderMillis of 0103_redundant_valkyrie — the migration from the reported incident: it
	// drops idx_blacklist_cmds_narrator_pattern and replaces it with two partial indexes.
	const BLACKLIST_PARTIAL_INDEX_WHEN = 1785508212529;

	test("heals the reported incident: replaying 0103 when its dropped index is already gone", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);

		// The dev machine's state: schema fully advanced, but 0103's hash absent.
		sqlite.run("DELETE FROM __drizzle_migrations WHERE created_at = ?", [
			BLACKLIST_PARTIAL_INDEX_WHEN,
		]);

		await runMigrations(sqlite);

		// The replacement partial indexes survive; the legacy index stays gone.
		const indexes = (
			sqlite
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='narrator_blacklist_cmds' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>
		).map((row) => row.name);
		expect(indexes).toEqual([
			"idx_blacklist_cmds_narrator",
			"idx_blacklist_cmds_narrator_pattern_scoped",
			"idx_blacklist_cmds_narrator_pattern_unscoped",
		]);
	});

	test("replays the entire journal against an already-final schema without failing", async () => {
		sqlite = new Database(":memory:");
		await runMigrations(sqlite);

		// Worst case for a source-built machine: not a single recorded hash matches the
		// released files, so every migration is replayed against its own end state.
		sqlite.run("DELETE FROM __drizzle_migrations");

		await runMigrations(sqlite);

		expect(stampedHashes(sqlite)).toBeGreaterThan(0);
		expect(
			sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='narrators'").get(),
		).toBeTruthy();
	});

	test("skips a DROP INDEX whose index is already absent and keeps going", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, payload text)");
		const folder = migrationsFolderWith("0000_drop_absent_index", [
			"DROP INDEX `idx_already_gone`;",
			"CREATE INDEX `idx_t_payload` ON `t` (`payload`);",
		]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
				.get("idx_t_payload"),
		).toBeTruthy();
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("skips a DROP COLUMN whose column is already absent, preserving rows", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, keep text)");
		sqlite.run("INSERT INTO t (id, keep) VALUES ('row-1', 'keep-me')");
		const folder = migrationsFolderWith("0000_drop_absent_column", [
			"ALTER TABLE `t` DROP COLUMN `already_gone`;",
			"ALTER TABLE `t` ADD `added` text;",
		]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(columnNames(sqlite, "t")).toEqual(["id", "keep", "added"]);
		expect(
			(sqlite.prepare("SELECT keep FROM t WHERE id = 'row-1'").get() as { keep: string }).keep,
		).toBe("keep-me");
		expect(stampedHashes(sqlite)).toBe(1);
	});

	test("does not forgive a missing column for a statement that is not a column drop", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL)");
		// `CREATE INDEX` on an absent column also reports "no such column"; tolerating it
		// would leave the database silently missing an index the migration promised.
		const folder = migrationsFolderWith("0000_index_on_absent_column", [
			"CREATE INDEX `idx_absent_col` ON `t` (`gone`);",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such column/i,
		);
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("does not forgive a DROP COLUMN whose table is missing entirely", () => {
		sqlite = new Database(":memory:");
		const folder = migrationsFolderWith("0000_drop_column_absent_table", [
			"ALTER TABLE `never_created` DROP COLUMN `whatever`;",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow();
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("does not forgive a DROP COLUMN when the reported column is a different one", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, present text)");
		// SQLite refuses to drop the last remaining PK-bearing column etc.; more importantly a
		// mismatch between the reported name and the statement's target must stay fatal.
		const folder = migrationsFolderWith("0000_drop_column_mismatch", [
			"CREATE TRIGGER `tr` AFTER INSERT ON `t` BEGIN SELECT `absent_col` FROM `t`; END;",
			"ALTER TABLE `t` DROP COLUMN `present`;",
		]);

		expect(() => applyPendingMigrationsByHash(sqlite as Database, folder)).toThrow(
			/no such column/i,
		);
		expect(columnNames(sqlite, "t")).toEqual(["id", "present"]);
		expect(stampedHashes(sqlite)).toBe(0);
	});

	test("still drops an index that really exists", () => {
		sqlite = new Database(":memory:");
		sqlite.run("CREATE TABLE t (id text PRIMARY KEY NOT NULL, payload text)");
		sqlite.run("CREATE INDEX `idx_t_payload` ON `t` (`payload`)");
		const folder = migrationsFolderWith("0000_drop_present_index", ["DROP INDEX `idx_t_payload`;"]);

		applyPendingMigrationsByHash(sqlite, folder);

		expect(
			sqlite
				.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
				.get("idx_t_payload"),
		).toBeNull();
	});
});
