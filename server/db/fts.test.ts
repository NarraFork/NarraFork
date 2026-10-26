import { Database } from "bun:sqlite";
import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { consumeCleanShutdownState, ensureFts, markCleanShutdown } from "./fts";

const migration = readFileSync(
	new URL("../../drizzle/0170_green_joshua_kane.sql", import.meta.url),
	"utf8",
);

/** Use the actual generated destination schema, then restore the retired source columns. */
function fixture(): Database {
	const sqlite = new Database(":memory:");
	const createStart = migration.indexOf("CREATE TABLE");
	const createEnd = migration.indexOf("--> statement-breakpoint", createStart);
	sqlite.exec(migration.slice(createStart, createEnd).replaceAll("__new_narrators", "narrators"));
	sqlite.exec(`
		PRAGMA foreign_keys=OFF;
		ALTER TABLE narrators ADD COLUMN prune_enabled INTEGER;
		ALTER TABLE narrators ADD COLUMN prune_boundary_message_id TEXT;
		ALTER TABLE narrators ADD COLUMN pruned_percent INTEGER;
		CREATE TABLE narrator_message_refs(id TEXT, pruned_percent INTEGER);
		CREATE TABLE chapters(id TEXT PRIMARY KEY, title TEXT, description TEXT);
		CREATE TABLE narrator_messages(id TEXT PRIMARY KEY, content_text TEXT);
		CREATE TABLE users(id TEXT PRIMARY KEY);
		CREATE TABLE projects(id TEXT PRIMARY KEY);
		CREATE TABLE oauth_grants(id TEXT PRIMARY KEY);
	`);
	ensureFts(sqlite, { wasClean: true });
	sqlite
		.query("INSERT INTO narrators(rowid,id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
		.run(20, "first", "uniqueneedle", "now", "now");
	sqlite
		.query("INSERT INTO narrators(rowid,id,title,created_at,updated_at) VALUES(?,?,?,?,?)")
		.run(40, "second", "anotherneedle", "now", "now");
	return sqlite;
}

function matches(sqlite: Database, query: string): string[] {
	return (
		sqlite
			.query(`
			SELECT n.id FROM narrators n JOIN narrators_fts f ON n.rowid=f.rowid
			WHERE narrators_fts MATCH ? ORDER BY n.id
		`)
			.all(query) as Array<{ id: string }>
	).map((row) => row.id);
}

function checkExternalContent(sqlite: Database): void {
	sqlite.exec("INSERT INTO narrators_fts(narrators_fts,rank) VALUES('integrity-check',1)");
}

describe("FTS recovery after generated content-table migrations", () => {
	for (const wasClean of [true, false]) {
		test(`0170 repairs rowid drift on ${wasClean ? "clean" : "unclean"} startup`, () => {
			const sqlite = fixture();
			try {
				if (wasClean) markCleanShutdown(sqlite);
				const state = consumeCleanShutdownState(sqlite);
				expect(state.wasClean).toBe(wasClean);
				sqlite.exec(migration);
				expect(sqlite.query("SELECT rowid FROM narrators WHERE id='first'").get()).toEqual({
					rowid: 1,
				});
				expect(matches(sqlite, "uniqueneedle")).toEqual([]);
				expect(() => checkExternalContent(sqlite)).toThrow();
				const run = spyOn(sqlite, "run");
				try {
					expect(ensureFts(sqlite, state).rebuilt).toBe(true);
					const rebuilds = run.mock.calls.filter(([sql]) => String(sql).includes("('rebuild')"));
					expect(rebuilds.map(([sql]) => sql)).toEqual([
						"INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')",
					]);
				} finally {
					run.mockRestore();
				}
				expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
				expect(matches(sqlite, "anotherneedle")).toEqual(["second"]);
				expect(() => checkExternalContent(sqlite)).not.toThrow();
				sqlite.exec("UPDATE narrators SET title='changedneedle' WHERE id='first'");
				expect(matches(sqlite, "uniqueneedle")).toEqual([]);
				expect(matches(sqlite, "changedneedle")).toEqual(["first"]);
				sqlite.exec("DELETE FROM narrators WHERE id='second'");
				expect(matches(sqlite, "anotherneedle")).toEqual([]);
				expect(() => checkExternalContent(sqlite)).not.toThrow();
			} finally {
				sqlite.close();
			}
		});
	}

	test("a subsequent healthy clean startup neither probes nor rebuilds content", () => {
		const sqlite = fixture();
		try {
			sqlite.exec(migration);
			ensureFts(sqlite, { wasClean: true });
			markCleanShutdown(sqlite);
			const state = consumeCleanShutdownState(sqlite);
			const run = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, state).rebuilt).toBe(false);
				expect(run.mock.calls.some(([sql]) => /rebuild|integrity-check/.test(String(sql)))).toBe(
					false,
				);
			} finally {
				run.mockRestore();
			}
		} finally {
			sqlite.close();
		}
	});

	test("failed repair keeps missing triggers as a retry signal", () => {
		const sqlite = fixture();
		try {
			sqlite.exec(migration);
			const originalRun = sqlite.run.bind(sqlite);
			const run = spyOn(sqlite, "run").mockImplementation((...args) => {
				if (String(args[0]).includes("narrators_fts) VALUES ('rebuild')")) {
					throw new Error("simulated rebuild failure");
				}
				return originalRun(...args);
			});
			try {
				expect(() => ensureFts(sqlite, { wasClean: true })).toThrow("simulated rebuild failure");
			} finally {
				run.mockRestore();
			}
			expect(
				sqlite
					.query(
						"SELECT name FROM sqlite_master WHERE type='trigger' AND name='narrators_fts_insert'",
					)
					.get(),
			).toBeNull();
			expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
			expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
			expect(() => checkExternalContent(sqlite)).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("an unclean startup reads no index; a background finding rebuilds the one it names", () => {
		const sqlite = fixture();
		try {
			// An index out of step with its content, all triggers in place.
			sqlite.exec("INSERT INTO narrators_fts(narrators_fts) VALUES('delete-all')");
			expect(matches(sqlite, "uniqueneedle")).toEqual([]);
			// Startup does not probe for it: that read the whole index before listening.
			ensureFts(sqlite, { wasClean: false });
			expect(matches(sqlite, "uniqueneedle")).toEqual([]);
			// The background check's finding, handed to the next startup, repairs it.
			expect(ensureFts(sqlite, { wasClean: true, repairFtsTables: ["narrators_fts"] })).toEqual({
				rebuilt: true,
			});
			expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
			expect(() => checkExternalContent(sqlite)).not.toThrow();
		} finally {
			sqlite.close();
		}
	});

	test("repopulates knowledge draft FTS on clean rowid drift before restoring triggers", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(`
				INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', '');
				INSERT INTO knowledge_entries VALUES ('e2', 'Entry two', '', '');
				INSERT INTO knowledge_drafts(rowid, id, entry_id, title, content)
				VALUES (10, 'd1', 'e1', 'Draft one', 'alpha needle');
				INSERT INTO knowledge_drafts(rowid, id, entry_id, title, content)
				VALUES (20, 'd2', 'e2', 'Draft two', 'beta needle');
			`);
			sqlite.exec(`
				DROP TRIGGER knowledge_drafts_fts_insert;
				DROP TRIGGER knowledge_drafts_fts_update;
				DROP TRIGGER knowledge_drafts_fts_delete;
				DROP TRIGGER knowledge_drafts_fts_entry_title;
				CREATE TABLE knowledge_drafts_new (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
				INSERT INTO knowledge_drafts_new SELECT id, entry_id, title, content FROM knowledge_drafts ORDER BY id DESC;
				DROP TABLE knowledge_drafts;
				ALTER TABLE knowledge_drafts_new RENAME TO knowledge_drafts;
			`);
			ensureFts(sqlite, { wasClean: true });
			expect(
				(
					sqlite
						.prepare(
							"SELECT d.id FROM knowledge_drafts d JOIN knowledge_drafts_fts f ON d.rowid=f.rowid WHERE knowledge_drafts_fts MATCH ? ORDER BY d.id",
						)
						.all("alpha") as Array<{ id: string }>
				).map((row) => row.id),
			).toEqual(["d1"]);
			sqlite.run("INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES (?, ?, ?, ?)", [
				"d3",
				"e1",
				"Draft three",
				"gamma needle",
			]);
			expect(
				(
					sqlite
						.prepare("SELECT rowid FROM knowledge_drafts_fts WHERE knowledge_drafts_fts MATCH ?")
						.all("gamma") as Array<{ rowid: number }>
				).length,
			).toBe(1);
		} finally {
			sqlite.close();
		}
	});

	test("repopulates drafts when only the entry-title trigger is missing", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Original title', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft title', 'draft body')",
			);
			sqlite.exec(
				"DELETE FROM knowledge_drafts_fts WHERE rowid = (SELECT rowid FROM knowledge_drafts)",
			);
			sqlite.exec("DROP TRIGGER knowledge_drafts_fts_entry_title");
			ensureFts(sqlite, { wasClean: true });
			expect(sqlite.query("SELECT title FROM knowledge_drafts_fts").get()).toEqual({
				title: "Original title",
			});
			sqlite.exec("UPDATE knowledge_entries SET title='Updated title' WHERE id='e1'");
			expect(sqlite.query("SELECT title FROM knowledge_drafts_fts").get()).toEqual({
				title: "Updated title",
			});
		} finally {
			sqlite.close();
		}
	});

	test("failed draft repair keeps the old index and retries while triggers remain missing", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft one', 'old needle')",
			);
			sqlite.exec("DROP TRIGGER knowledge_drafts_fts_insert");
			const originalRun = sqlite.run.bind(sqlite);
			const run = spyOn(sqlite, "run").mockImplementation((...args) => {
				if (String(args[0]).includes("INSERT INTO knowledge_drafts_fts(rowid")) {
					throw new Error("simulated draft refill failure");
				}
				return originalRun(...args);
			});
			try {
				expect(() => ensureFts(sqlite, { wasClean: true })).toThrow(
					"simulated draft refill failure",
				);
			} finally {
				run.mockRestore();
			}
			expect(sqlite.query("SELECT content FROM knowledge_drafts_fts").get()).toEqual({
				content: "old needle",
			});
			expect(
				sqlite
					.query(
						"SELECT name FROM sqlite_master WHERE type='trigger' AND name='knowledge_drafts_fts_insert'",
					)
					.get(),
			).toBeNull();
			expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
			expect(sqlite.query("SELECT content FROM knowledge_drafts_fts").get()).toEqual({
				content: "old needle",
			});
		} finally {
			sqlite.close();
		}
	});

	test("a second healthy clean draft startup does not refill the index", () => {
		const sqlite = new Database(":memory:");
		try {
			sqlite.exec(`
				CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
				CREATE TABLE narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
				CREATE TABLE knowledge_entries (id TEXT PRIMARY KEY, title TEXT, current_content TEXT, current_keywords TEXT);
				CREATE TABLE knowledge_drafts (id TEXT PRIMARY KEY, entry_id TEXT, title TEXT, content TEXT);
			`);
			ensureFts(sqlite, { wasClean: true });
			sqlite.exec(
				"INSERT INTO knowledge_entries VALUES ('e1', 'Entry one', '', ''); INSERT INTO knowledge_drafts(id, entry_id, title, content) VALUES ('d1', 'e1', 'Draft one', 'stable needle')",
			);
			const run = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(false);
				expect(
					run.mock.calls.some(([sql]) =>
						/SELECT d\.rowid, COALESCE\(e\.title|rebuild|integrity-check/.test(String(sql)),
					),
				).toBe(false);
			} finally {
				run.mockRestore();
			}
		} finally {
			sqlite.close();
		}
	});
});

/**
 * Upgrading from a release that still had chapters (and a chapter search index).
 *
 * The migration drops `chapters` (SQLite drops its triggers with it) and rebuilds `narrators`
 * without `chapter_id`, which drops the narrators FTS triggers and renumbers rowids. What it
 * cannot touch is the chapter index this module created at runtime: `chapters_fts` and its
 * shadow tables. Startup must remove those and repair the narrators index.
 */
describe("upgrade from a release with chapter search", () => {
	/** The released chapter index, as the previous `ensureFts` installed it. */
	const RELEASED_CHAPTER_FTS = `
		CREATE VIRTUAL TABLE chapters_fts USING fts5(
			title, description, content='chapters', content_rowid=rowid, tokenize='trigram'
		);
		CREATE TRIGGER chapters_fts_insert AFTER INSERT ON chapters BEGIN
			INSERT INTO chapters_fts(rowid, title, description)
			VALUES (NEW.rowid, NEW.title, NEW.description);
		END;
		CREATE TRIGGER chapters_fts_update AFTER UPDATE ON chapters BEGIN
			INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
			VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
			INSERT INTO chapters_fts(rowid, title, description)
			VALUES (NEW.rowid, NEW.title, NEW.description);
		END;
		CREATE TRIGGER chapters_fts_delete AFTER DELETE ON chapters BEGIN
			INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
			VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
		END;
	`;

	/** Same shape as the generated rebuild: drop the parent, then copy/drop/rename narrators. */
	const CHAPTER_REMOVAL_MIGRATION = `
		PRAGMA foreign_keys=OFF;
		DROP TABLE chapters;
		CREATE TABLE __new_narrators (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
		INSERT INTO __new_narrators(id, title, created_at, updated_at)
		SELECT id, title, created_at, updated_at FROM narrators;
		DROP TABLE narrators;
		ALTER TABLE __new_narrators RENAME TO narrators;
		PRAGMA foreign_keys=ON;
	`;

	function releasedDatabase(): Database {
		const sqlite = new Database(":memory:");
		sqlite.exec(`
			CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
			CREATE TABLE narrators (
				id TEXT PRIMARY KEY, chapter_id TEXT REFERENCES chapters(id), title TEXT,
				created_at TEXT, updated_at TEXT
			);
			CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, content_text TEXT);
		`);
		ensureFts(sqlite, { wasClean: true });
		sqlite.exec(RELEASED_CHAPTER_FTS);
		sqlite.exec(`
			INSERT INTO chapters VALUES ('c1', 'chapterneedle', 'chapter body');
			INSERT INTO narrators(rowid, id, chapter_id, title, created_at, updated_at)
			VALUES (20, 'first', 'c1', 'uniqueneedle', 'now', 'now');
			INSERT INTO narrators(rowid, id, chapter_id, title, created_at, updated_at)
			VALUES (40, 'second', NULL, 'anotherneedle', 'now', 'now');
		`);
		return sqlite;
	}

	function chapterObjects(sqlite: Database): string[] {
		return (
			sqlite
				.query("SELECT name FROM sqlite_master WHERE name LIKE 'chapters%' ORDER BY name")
				.all() as Array<{ name: string }>
		).map((row) => row.name);
	}

	test("drops the orphaned chapter index and repairs the rebuilt narrators index", () => {
		const sqlite = releasedDatabase();
		try {
			sqlite.exec(CHAPTER_REMOVAL_MIGRATION);
			// The migration leaves the runtime index (and its shadow tables) behind, but not its
			// triggers, and the narrators index now points at renumbered rowids.
			expect(chapterObjects(sqlite)).toEqual([
				"chapters_fts",
				"chapters_fts_config",
				"chapters_fts_data",
				"chapters_fts_docsize",
				"chapters_fts_idx",
			]);
			expect(() => checkExternalContent(sqlite)).toThrow();

			const run = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
				const rebuilds = run.mock.calls.filter(([sql]) => String(sql).includes("('rebuild')"));
				expect(rebuilds.map(([sql]) => sql)).toEqual([
					"INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')",
				]);
			} finally {
				run.mockRestore();
			}
			expect(chapterObjects(sqlite)).toEqual([]);
			expect(matches(sqlite, "uniqueneedle")).toEqual(["first"]);
			expect(matches(sqlite, "anotherneedle")).toEqual(["second"]);
			expect(() => checkExternalContent(sqlite)).not.toThrow();
			sqlite.exec("UPDATE narrators SET title='changedneedle' WHERE id='first'");
			expect(matches(sqlite, "changedneedle")).toEqual(["first"]);
			expect(sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

			// The next clean start finds nothing to drop and nothing to repair.
			const second = spyOn(sqlite, "run");
			try {
				expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(false);
				expect(second.mock.calls.some(([sql]) => /chapters_fts|rebuild/.test(String(sql)))).toBe(
					false,
				);
			} finally {
				second.mockRestore();
			}
		} finally {
			sqlite.close();
		}
	});

	test("drops the chapter triggers before the index they write to", () => {
		const sqlite = releasedDatabase();
		try {
			// A chapters table that is still there must not keep triggers into a dropped index.
			ensureFts(sqlite, { wasClean: true });
			expect(chapterObjects(sqlite)).toEqual(["chapters"]);
			expect(() =>
				sqlite.exec("INSERT INTO chapters VALUES ('c2', 'later', 'still writable')"),
			).not.toThrow();
		} finally {
			sqlite.close();
		}
	});
});
