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

	test("unclean startup probes external content even when all triggers exist", () => {
		const sqlite = fixture();
		try {
			sqlite.exec("INSERT INTO narrators_fts(narrators_fts) VALUES('delete-all')");
			expect(matches(sqlite, "uniqueneedle")).toEqual([]);
			ensureFts(sqlite, { wasClean: false });
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
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
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
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
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
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
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
				CREATE TABLE chapters (id TEXT PRIMARY KEY, title TEXT, description TEXT);
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
