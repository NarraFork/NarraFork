import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "./relations";
import * as schema from "./schema";

const narraforkDir = resolve(homedir(), ".narrafork");
mkdirSync(narraforkDir, { recursive: true });

const dbPath = resolve(narraforkDir, "narrafork.db");
const sqlite = new Database(dbPath);

sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

// FTS5 virtual tables for full-text search (Phase 5)
// Use trigram tokenizer for CJK (Chinese/Japanese/Korean) support
// Migrate: drop old default-tokenizer tables and recreate with trigram
const ftsTablesRecreated: string[] = [];
for (const table of ["chapters_fts", "narrator_messages_fts", "narrators_fts"]) {
	const info = sqlite
		.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
		.get(table) as { sql: string } | undefined;
	if (info && !info.sql.includes("trigram")) {
		sqlite.run(`DROP TABLE IF EXISTS ${table}`);
		ftsTablesRecreated.push(table);
	}
}

sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
    title, description, content='chapters', content_rowid=rowid, tokenize='trigram'
  )
`);
sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS narrator_messages_fts USING fts5(
    content_text, content='narrator_messages', content_rowid=rowid, tokenize='trigram'
  )
`);
sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS narrators_fts USING fts5(
    title, content='narrators', content_rowid=rowid, tokenize='trigram'
  )
`);

// FTS sync triggers — keep FTS index up to date with source tables
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS chapters_fts_insert AFTER INSERT ON chapters BEGIN
    INSERT INTO chapters_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS chapters_fts_update AFTER UPDATE ON chapters BEGIN
    INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
    INSERT INTO chapters_fts(rowid, title, description)
    VALUES (NEW.rowid, NEW.title, NEW.description);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS chapters_fts_delete AFTER DELETE ON chapters BEGIN
    INSERT INTO chapters_fts(chapters_fts, rowid, title, description)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.description);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_insert AFTER INSERT ON narrator_messages BEGIN
    INSERT INTO narrator_messages_fts(rowid, content_text)
    VALUES (NEW.rowid, NEW.content_text);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_update AFTER UPDATE ON narrator_messages BEGIN
    INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text)
    VALUES ('delete', OLD.rowid, OLD.content_text);
    INSERT INTO narrator_messages_fts(rowid, content_text)
    VALUES (NEW.rowid, NEW.content_text);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrator_messages_fts_delete AFTER DELETE ON narrator_messages BEGIN
    INSERT INTO narrator_messages_fts(narrator_messages_fts, rowid, content_text)
    VALUES ('delete', OLD.rowid, OLD.content_text);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrators_fts_insert AFTER INSERT ON narrators
  WHEN NEW.title IS NOT NULL BEGIN
    INSERT INTO narrators_fts(rowid, title) VALUES (NEW.rowid, NEW.title);
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrators_fts_update AFTER UPDATE OF title ON narrators BEGIN
    INSERT INTO narrators_fts(narrators_fts, rowid, title)
    VALUES ('delete', OLD.rowid, COALESCE(OLD.title, ''));
    INSERT INTO narrators_fts(rowid, title)
    VALUES (NEW.rowid, COALESCE(NEW.title, ''));
  END
`);
sqlite.run(`
  CREATE TRIGGER IF NOT EXISTS narrators_fts_delete AFTER DELETE ON narrators
  WHEN OLD.title IS NOT NULL BEGIN
    INSERT INTO narrators_fts(narrators_fts, rowid, title)
    VALUES ('delete', OLD.rowid, OLD.title);
  END
`);

// Rebuild FTS indexes only after migration (table was recreated with new tokenizer)
if (ftsTablesRecreated.length > 0) {
	sqlite.run("INSERT INTO chapters_fts(chapters_fts) VALUES ('rebuild')");
	sqlite.run("INSERT INTO narrator_messages_fts(narrator_messages_fts) VALUES ('rebuild')");
	sqlite.run("INSERT INTO narrators_fts(narrators_fts) VALUES ('rebuild')");
}
export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
