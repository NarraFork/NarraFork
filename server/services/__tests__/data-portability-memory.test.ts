import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { sqlite } from "../../db";
import { applyImport, clearData, exportData, previewImport } from "../data-portability";

const selection = { sessions: true, requests: false, providers: false };
const now = "2026-01-01T00:00:00.000Z";
const rows = () => sqlite.query("SELECT * FROM context_memories ORDER BY id").all();
const events = () => sqlite.query("SELECT * FROM context_memory_events ORDER BY id").all();

function narrator(id: string) {
	sqlite.run(
		"INSERT INTO narrators (id, owner_user_id, created_at, updated_at) VALUES (?, 'memory-owner', ?, ?)",
		[id, now, now],
	);
}
function memory(id: string, scope = "user", source: string | null = null, owner = "memory-owner") {
	const scopeId = scope === "project" ? "memory-project" : scope === "session" ? "s1" : null;
	sqlite.run(
		`INSERT INTO context_memories
		(id, owner_user_id, scope, scope_key, project_id, narrator_id, key, content, content_hash,
		status, version, source_narrator_id, created_by_kind, confirmed_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'hash', 'confirmed', 2, ?, 'user', ?, ?, ?)`,
		[
			id,
			owner,
			scope,
			scopeId ? `${scope}:${scopeId}` : "user",
			scope === "project" ? scopeId : null,
			scope === "session" ? scopeId : null,
			id,
			`记忆正文 ${id}`,
			source,
			now,
			now,
			now,
		],
	);
	for (const [version, action] of [
		[1, "propose"],
		[2, "confirm"],
	] as const) {
		sqlite.run(
			`INSERT INTO context_memory_events
			(id, memory_id, version, action, actor_user_id, actor_kind, content_hash, created_at)
			VALUES (?, ?, ?, ?, ?, 'user', 'hash', ?)`,
			[`${id}:${version}`, id, version, action, owner, now],
		);
	}
}
async function archive() {
	const result = await exportData(selection);
	const bytes = await readFile(result.zipPath);
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
async function restore(bytes: ArrayBuffer, conflictDefault: "skip" | "overwrite" = "skip") {
	const preview = await previewImport(bytes, "memory.zip");
	return applyImport(preview.token, { include: selection, conflictDefault });
}
beforeEach(async () => {
	// Explicit cleanup also makes the regression independent of the clear implementation.
	sqlite.run("DELETE FROM context_memories");
	await clearData("all");
	for (const id of ["memory-owner", "missing-owner"])
		sqlite.run(
			"INSERT OR IGNORE INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'hash', 'user', ?)",
			[id, id, now],
		);
	sqlite.run(
		"INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('memory-project', 'Project', ?, ?)",
		[now, now],
	);
	narrator("s1");
	narrator("s2");
});

test("real snapshot restores memory scopes, confirmed versions and the complete audit chain", async () => {
	memory("personal");
	memory("project", "project");
	memory("session", "session");
	memory("sourced", "user", "s1");
	const expected = rows();
	const audit = events();
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	await restore(bytes);
	expect(rows()).toEqual(expected);
	expect(events()).toEqual(audit);
	await restore(bytes, "overwrite");
	expect(rows()).toEqual(expected);
	expect(events()).toEqual(audit);
	expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("import preserves a locally diverged memory and never appends the archive's audit to it", async () => {
	memory("same-id");
	const bytes = await archive();
	sqlite.run("UPDATE context_memories SET content = 'local', content_hash = 'local', version = 3");
	sqlite.run("DELETE FROM context_memory_events");
	sqlite.run(`INSERT INTO context_memory_events
		(id, memory_id, version, action, actor_user_id, actor_kind, content_hash, created_at)
		VALUES ('local-event', 'same-id', 3, 'revise', 'memory-owner', 'user', 'local', '${now}')`);
	const local = rows();
	const audit = events();
	await restore(bytes, "overwrite");
	expect(rows()).toEqual(local);
	expect(events()).toEqual(audit);
});

test("skipped sessions exclude both their scoped memories and memories sourced from them", async () => {
	memory("session", "session");
	memory("sourced", "user", "s1");
	memory("independent");
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	narrator("s1");
	const result = await restore(bytes);
	expect(result.sessionsSkipped).toBe(1);
	expect(result.sessionsInserted).toBe(1);
	expect(rows().map((row) => (row as { id: string }).id)).toEqual(["independent"]);
	expect(events()).toHaveLength(2);
});

test("missing owners, projects or audit actors cannot become unowned imported memories", async () => {
	memory("valid");
	memory("missing-user", "user", null, "missing-owner");
	memory("missing-project", "project");
	memory("missing-actor");
	sqlite.run(
		"UPDATE context_memory_events SET actor_user_id = 'missing-owner' WHERE memory_id = 'missing-actor'",
	);
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	sqlite.run("DELETE FROM users WHERE id = 'missing-owner'");
	sqlite.run("DELETE FROM projects WHERE id = 'memory-project'");
	await restore(bytes);
	expect(rows().map((row) => (row as { id: string }).id)).toEqual(["valid"]);
	expect(events()).toHaveLength(2);
	expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("request-only import and clear leave memories untouched; session clear removes all scopes and audit", async () => {
	memory("user");
	memory("project", "project");
	memory("session", "session");
	const bytes = await archive();
	const expected = rows();
	await clearData("requests");
	expect(rows()).toEqual(expected);
	const preview = await previewImport(bytes, "requests-only.zip");
	await applyImport(preview.token, {
		include: { requests: true, sessions: false, providers: false },
	});
	expect(rows()).toEqual(expected);
	await clearData("sessions");
	expect(rows()).toEqual([]);
	expect(events()).toEqual([]);
});

test("old archives without either memory table still import without changing local memories", async () => {
	const bytes = await archive();
	const preview = await previewImport(bytes, "old.zip");
	const incoming = new Database(preview.snapshotPath);
	incoming.run("DROP TABLE IF EXISTS context_memory_events");
	incoming.run("DROP TABLE IF EXISTS context_memories");
	incoming.close();
	memory("keep");
	const expected = rows();
	await applyImport(preview.token, { include: selection, conflictDefault: "overwrite" });
	expect(rows()).toEqual(expected);
});

test("missing source messages are not restored as unpinned memories", async () => {
	memory("valid");
	memory("lost-source", "user", "s1");
	sqlite.run("UPDATE context_memories SET source_message_id = 'absent' WHERE id = 'lost-source'");
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	await restore(bytes);
	expect(rows().map((row) => (row as { id: string }).id)).toEqual(["valid"]);
	expect(events()).toHaveLength(2);
});

test("duplicate audit versions roll back newly imported memories and sessions together", async () => {
	memory("atomic");
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	const preview = await previewImport(bytes, "broken-audit.zip");
	const incoming = new Database(preview.snapshotPath);
	incoming.run(`INSERT INTO context_memory_events
		SELECT 'duplicate-audit', memory_id, version, action, actor_user_id, actor_kind, content_hash, created_at
		FROM context_memory_events WHERE version = 2`);
	incoming.close();
	await expect(applyImport(preview.token, { include: selection })).rejects.toThrow();
	expect(rows()).toEqual([]);
	expect(events()).toEqual([]);
	expect(sqlite.query("SELECT id FROM narrators").all()).toEqual([]);
});

test("a partial memory snapshot is rejected instead of silently discarding its audit", async () => {
	memory("partial");
	const bytes = await archive();
	sqlite.run("DELETE FROM context_memories");
	await clearData("sessions");
	const preview = await previewImport(bytes, "partial-memory.zip");
	const incoming = new Database(preview.snapshotPath);
	incoming.run("DROP TABLE context_memory_events");
	incoming.close();
	await expect(applyImport(preview.token, { include: selection })).rejects.toThrow(
		/incomplete memory/,
	);
	expect(rows()).toEqual([]);
	expect(sqlite.query("SELECT id FROM narrators").all()).toEqual([]);
});
