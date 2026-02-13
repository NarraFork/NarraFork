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
sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chapters_fts USING fts5(
    title, description, content='chapters', content_rowid=rowid
  )
`);
sqlite.run(`
  CREATE VIRTUAL TABLE IF NOT EXISTS narrator_messages_fts USING fts5(
    content_text, content='narrator_messages', content_rowid=rowid
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

export const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
export { sqlite };
