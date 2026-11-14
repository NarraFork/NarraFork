import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("generated memory migration is additive, indexed and preserves existing rows", () => {
	const db = new Database(":memory:");
	try {
		db.exec(`PRAGMA foreign_keys=ON;
			CREATE TABLE users (id TEXT PRIMARY KEY);
			CREATE TABLE projects (id TEXT PRIMARY KEY);
			CREATE TABLE narrators (id TEXT PRIMARY KEY);
			CREATE TABLE legacy_messages (id TEXT PRIMARY KEY, content TEXT NOT NULL);
			INSERT INTO users VALUES ('u');
			INSERT INTO projects VALUES ('p');
			INSERT INTO narrators VALUES ('n');
			INSERT INTO legacy_messages VALUES ('before', '既有内容');`);
		const sql = readFileSync(
			new URL("../../drizzle/0257_context_memories.sql", import.meta.url),
			"utf8",
		);
		db.exec(sql);
		expect(db.query("SELECT * FROM legacy_messages").all()).toEqual([
			{ id: "before", content: "既有内容" },
		]);
		expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
		const indexes = db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_context_memory_%'",
			)
			.all()
			.map((row) => row.name);
		expect(indexes).toContain("idx_context_memory_recall");
		expect(indexes).toContain("idx_context_memory_key");
		expect(indexes).toContain("idx_context_memory_event_version");
		const insert = db.query(
			"INSERT INTO context_memories (id,owner_user_id,scope,scope_key,key,content,content_hash,created_by_kind,created_at,updated_at) VALUES (?, 'u', ?, ?, 'key', 'body', 'hash', 'user', 'now', 'now')",
		);
		insert.run("m", "user", "user");
		expect(() => insert.run("duplicate", "user", "user")).toThrow();
		expect(() => insert.run("wrong-scope", "project", "project:p")).toThrow();
		db.exec(
			"INSERT INTO context_memory_events (id,memory_id,version,action,actor_user_id,actor_kind,content_hash,created_at) VALUES ('e','m',1,'propose','u','user','hash','now')",
		);
		db.exec("DELETE FROM context_memories WHERE id='m'");
		expect(db.query("SELECT id FROM context_memory_events").all()).toEqual([]);
		expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
	} finally {
		db.close();
	}
});
