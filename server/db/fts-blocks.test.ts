/**
 * Block storage FTS (docs/BLOCK_STORAGE-DESIGN.md §4.6): the versioned envelope update trigger
 * and the contentless block index the store writes through `replaceBlockIndexText`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
	BLOCK_INDEX_MAX_CHARS,
	blockIndexWriter,
	ensureFts,
	removeBlockIndexText,
	replaceBlockIndexText,
} from "./fts";

const V1_ENVELOPE_UPDATE = `
	CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_update AFTER UPDATE ON narrator_messages BEGIN
		INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text)
		VALUES ('delete', OLD.rowid, OLD.content_text);
		INSERT INTO narrator_messages_fts(rowid, content_text)
		VALUES (NEW.rowid, NEW.content_text);
	END
`;

function fixture(options: { blocks?: boolean } = {}): Database {
	const sqlite = new Database(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE narrators(id TEXT PRIMARY KEY, title TEXT);
		CREATE TABLE narrator_messages(
			id TEXT PRIMARY KEY, content_text TEXT, body_revision INTEGER NOT NULL DEFAULT 0
		);
	`);
	if (options.blocks !== false)
		sqlite.exec(`
			CREATE TABLE narrator_blocks(
				id TEXT PRIMARY KEY,
				message_id TEXT NOT NULL REFERENCES narrator_messages(id) ON DELETE CASCADE
			);
		`);
	return sqlite;
}

function blockHits(sqlite: Database, query: string): string[] {
	return (
		sqlite
			.query(
				`SELECT b.id FROM narrator_blocks_fts JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
				 WHERE narrator_blocks_fts MATCH ? ORDER BY b.id`,
			)
			.all(query) as Array<{ id: string }>
	).map((row) => row.id);
}

function envelopeHits(sqlite: Database, query: string): string[] {
	return (
		sqlite
			.query(
				`SELECT m.id FROM narrator_messages_fts JOIN narrator_messages m ON m.rowid = narrator_messages_fts.rowid
				 WHERE narrator_messages_fts MATCH ? ORDER BY m.id`,
			)
			.all(query) as Array<{ id: string }>
	).map((row) => row.id);
}

function triggerSql(sqlite: Database, name: string): string | undefined {
	return (
		sqlite.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) as
			| { sql: string }
			| undefined
	)?.sql;
}

describe("envelope FTS update trigger v2", () => {
	test("an installed v1 definition is replaced, and only once", () => {
		const sqlite = fixture();
		sqlite.exec(`
			CREATE VIRTUAL TABLE narrator_messages_fts USING fts5(
				content_text, content='narrator_messages', content_rowid=rowid, tokenize='trigram'
			);
			${V1_ENVELOPE_UPDATE};
		`);
		ensureFts(sqlite, { wasClean: true });
		const installed = triggerSql(sqlite, "narrator_messages_fts_update");
		expect(installed).toContain("AFTER UPDATE OF content_text ON narrator_messages");
		expect(installed).toContain("narrafork:trigger-version 2");
		ensureFts(sqlite, { wasClean: true });
		expect(triggerSql(sqlite, "narrator_messages_fts_update")).toBe(installed);
	});

	test("a changed content_text is re-indexed and other columns are not watched", () => {
		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		sqlite.run("INSERT INTO narrator_messages (id, content_text) VALUES ('m1', 'original words')");
		sqlite.run("UPDATE narrator_messages SET content_text = 'replacement words' WHERE id = 'm1'");
		expect(envelopeHits(sqlite, "original")).toEqual([]);
		expect(envelopeHits(sqlite, "replacement")).toEqual(["m1"]);
		// A revision bump leaves the index alone: deleting the index row first would otherwise
		// be undone by a v1-style delete + re-insert.
		sqlite.run(
			"INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text) SELECT 'delete', rowid, content_text FROM narrator_messages WHERE id = 'm1'",
		);
		sqlite.run("UPDATE narrator_messages SET body_revision = body_revision + 1 WHERE id = 'm1'");
		sqlite.run("UPDATE narrator_messages SET content_text = content_text WHERE id = 'm1'");
		expect(envelopeHits(sqlite, "replacement")).toEqual([]);
	});
});

describe("block FTS index", () => {
	test("is created only once block storage exists", () => {
		const legacy = fixture({ blocks: false });
		ensureFts(legacy, { wasClean: true });
		expect(
			legacy.query("SELECT name FROM sqlite_master WHERE name = 'narrator_blocks_fts'").get(),
		).toBeNull();
		// The helpers are no-ops on a connection without the index.
		expect(() => replaceBlockIndexText(legacy, "b1", "text")).not.toThrow();

		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		const sql = (
			sqlite.query("SELECT sql FROM sqlite_master WHERE name = 'narrator_blocks_fts'").get() as {
				sql: string;
			}
		).sql;
		expect(sql).toContain("trigram");
		expect(sql).toContain("contentless_delete=1");
		expect(triggerSql(sqlite, "narrator_blocks_fts_delete")).toBeDefined();
	});

	test("replaces, removes and caps a block's text by block id", () => {
		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		sqlite.exec(`
			INSERT INTO narrator_messages (id, content_text) VALUES ('m1', '');
			INSERT INTO narrator_blocks (id, message_id) VALUES ('b1', 'm1'), ('b2', 'm1');
		`);
		replaceBlockIndexText(sqlite, "b1", 'Read {"path":"src/needle.ts"}');
		replaceBlockIndexText(sqlite, "b2", "an unrelated answer");
		expect(blockHits(sqlite, "needle")).toEqual(["b1"]);
		replaceBlockIndexText(sqlite, "b1", "the settled result");
		expect(blockHits(sqlite, "needle")).toEqual([]);
		expect(blockHits(sqlite, "settled")).toEqual(["b1"]);
		removeBlockIndexText(sqlite, "b1");
		expect(blockHits(sqlite, "settled")).toEqual([]);
		// Empty text leaves the block unsearchable; an unknown block is not indexed.
		replaceBlockIndexText(sqlite, "b2", "");
		expect(blockHits(sqlite, "unrelated")).toEqual([]);
		replaceBlockIndexText(sqlite, "missing", "ghost text");
		expect(blockHits(sqlite, "ghost")).toEqual([]);
		// The writer narrator-block-sync registers does the same.
		const writer = blockIndexWriter(sqlite);
		writer.write("b2", `${"x".repeat(BLOCK_INDEX_MAX_CHARS)}overflowtail`);
		expect(blockHits(sqlite, "xxx")).toEqual(["b2"]);
		expect(blockHits(sqlite, "overflowtail")).toEqual([]);
		writer.drop("b2");
		expect(blockHits(sqlite, "xxx")).toEqual([]);
	});

	test("a deleted block leaves the index, cascades included, so a reused rowid starts empty", () => {
		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		sqlite.exec(`
			INSERT INTO narrator_messages (id, content_text) VALUES ('m1', ''), ('m2', '');
			INSERT INTO narrator_blocks (id, message_id) VALUES ('b1', 'm1'), ('b2', 'm2');
		`);
		replaceBlockIndexText(sqlite, "b1", "first needle");
		replaceBlockIndexText(sqlite, "b2", "second needle");
		sqlite.run("DELETE FROM narrator_messages WHERE id = 'm2'");
		expect(blockHits(sqlite, "needle")).toEqual(["b1"]);
		// b3 takes b2's rowid (the largest one was freed).
		sqlite.run("INSERT INTO narrator_blocks (id, message_id) VALUES ('b3', 'm1')");
		expect(blockHits(sqlite, "second")).toEqual([]);
		sqlite.run("DELETE FROM narrator_blocks WHERE id = 'b1'");
		expect(blockHits(sqlite, "needle")).toEqual([]);
	});

	test("an index whose delete trigger is gone is cleared before the trigger returns", () => {
		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		sqlite.exec(`
			INSERT INTO narrator_messages (id, content_text) VALUES ('m1', '');
			INSERT INTO narrator_blocks (id, message_id) VALUES ('b1', 'm1');
		`);
		replaceBlockIndexText(sqlite, "b1", "stale needle");
		// A generated table rebuild drops the table's triggers and may renumber its rowids.
		sqlite.run("DROP TRIGGER narrator_blocks_fts_delete");
		expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(true);
		expect(blockHits(sqlite, "needle")).toEqual([]);
		expect(triggerSql(sqlite, "narrator_blocks_fts_delete")).toBeDefined();
		replaceBlockIndexText(sqlite, "b1", "fresh needle");
		expect(ensureFts(sqlite, { wasClean: true }).rebuilt).toBe(false);
		expect(blockHits(sqlite, "needle")).toEqual(["b1"]);
	});

	test("an unclean shutdown leaves the index alone; a background finding empties it", () => {
		const sqlite = fixture();
		ensureFts(sqlite, { wasClean: true });
		sqlite.exec(`
			INSERT INTO narrator_messages (id, content_text) VALUES ('m1', '');
			INSERT INTO narrator_blocks (id, message_id) VALUES ('b1', 'm1');
		`);
		replaceBlockIndexText(sqlite, "b1", "durable needle");
		expect(ensureFts(sqlite, { wasClean: false }).rebuilt).toBe(false);
		expect(blockHits(sqlite, "needle")).toEqual(["b1"]);
		// Its text comes from the store, so a corrupt index is recreated empty for the reindex.
		expect(
			ensureFts(sqlite, { wasClean: true, repairFtsTables: ["narrator_blocks_fts"] }).rebuilt,
		).toBe(true);
		expect(blockHits(sqlite, "needle")).toEqual([]);
		replaceBlockIndexText(sqlite, "b1", "fresh needle");
		expect(blockHits(sqlite, "needle")).toEqual(["b1"]);
	});
});
