/**
 * Unit tests for the legacy todo → spec://tasks.json migration backfill.
 *
 * These exercise captureLegacyTodos / backfillLegacyTodosToSpec against an
 * in-memory SQLite database that mimics the pre-Dynamic-Spec schema, simulating
 * the destructive column drop between capture and backfill.
 *
 * Run: bun test server/db/__tests__/legacy-todo-backfill.test.ts
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { backfillLegacyTodosToSpec, captureLegacyTodos } from "../run-migrations";

/** Build a minimal pre-migration schema: narrators (with todos_json) + spec tables. */
function makeDb(): Database {
	const db = new Database(":memory:");
	db.run(`CREATE TABLE narrators (
		id TEXT PRIMARY KEY NOT NULL,
		todos_json TEXT,
		todos_tool_use_id TEXT,
		created_at TEXT,
		updated_at TEXT
	)`);
	db.run(`CREATE TABLE spec_namespaces (
		id TEXT PRIMARY KEY NOT NULL,
		narrator_id TEXT NOT NULL,
		forked_from_namespace_id TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`);
	db.run(`CREATE TABLE spec_namespace_files (
		id TEXT PRIMARY KEY NOT NULL,
		namespace_id TEXT NOT NULL,
		path TEXT NOT NULL,
		revision_id TEXT,
		deleted INTEGER NOT NULL DEFAULT 0,
		updated_at TEXT NOT NULL
	)`);
	db.run(`CREATE TABLE spec_file_revisions (
		id TEXT PRIMARY KEY NOT NULL,
		namespace_id TEXT NOT NULL,
		path TEXT NOT NULL,
		content TEXT NOT NULL,
		content_hash TEXT NOT NULL,
		parent_revision_id TEXT,
		source_tool_use_id TEXT,
		source_message_id TEXT,
		created_by TEXT NOT NULL DEFAULT 'assistant',
		created_at TEXT NOT NULL
	)`);
	return db;
}

function insertNarrator(db: Database, id: string, todosJson: string | null): void {
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO narrators (id, todos_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
	).run(id, todosJson, now, now);
}

/** Read the current tasks.json content for a narrator, or null if none. */
function readTasksJson(db: Database, narratorId: string): string | null {
	const row = db
		.prepare(
			`SELECT r.content AS content
			 FROM spec_namespaces n
			 JOIN spec_namespace_files f ON f.namespace_id = n.id
			 JOIN spec_file_revisions r ON r.id = f.revision_id
			 WHERE n.narrator_id = ? AND f.path = 'tasks.json' AND f.deleted = 0`,
		)
		.get(narratorId) as { content: string } | undefined;
	return row?.content ?? null;
}

/** Simulate the destructive Dynamic Spec migration dropping the legacy column. */
function dropTodosColumn(db: Database): void {
	db.run("ALTER TABLE narrators DROP COLUMN todos_json");
	db.run("ALTER TABLE narrators DROP COLUMN todos_tool_use_id");
}

let db: Database;
beforeEach(() => {
	db = makeDb();
});

describe("captureLegacyTodos", () => {
	test("returns [] when todos_json column is absent (already migrated)", () => {
		dropTodosColumn(db);
		expect(captureLegacyTodos(db)).toEqual([]);
	});

	test("skips null / empty / '[]' todos_json", () => {
		insertNarrator(db, "n-null", null);
		insertNarrator(db, "n-empty", "");
		insertNarrator(db, "n-emptyarr", "[]");
		expect(captureLegacyTodos(db)).toEqual([]);
	});

	test("captures narrators with non-empty todos", () => {
		insertNarrator(db, "n1", JSON.stringify([{ content: "task a", status: "pending" }]));
		const captured = captureLegacyTodos(db);
		expect(captured).toHaveLength(1);
		expect(captured[0].narratorId).toBe("n1");
		expect(captured[0].todos).toHaveLength(1);
	});
});

describe("backfillLegacyTodosToSpec", () => {
	test("migrates todos with correct status mapping (keeps completed)", () => {
		insertNarrator(
			db,
			"n1",
			JSON.stringify([
				{ content: "pending task", status: "pending" },
				{ content: "in progress task", status: "in_progress" },
				{ content: "done task", status: "completed" },
			]),
		);
		const captured = captureLegacyTodos(db);
		dropTodosColumn(db);
		backfillLegacyTodosToSpec(db, captured);

		const content = readTasksJson(db, "n1");
		expect(content).not.toBeNull();
		const doc = JSON.parse(content as string) as {
			tasks: { text: string; status: string }[];
		};
		expect(doc.tasks).toEqual([
			{ text: "pending task", status: "todo" },
			{ text: "in progress task", status: "doing" },
			{ text: "done task", status: "done" },
		]);
		// Serialized with tab indent + trailing newline (matches serializeSpecTasksDocument).
		expect(content).toBe(`${JSON.stringify(doc, null, "\t")}\n`);
	});

	test("uses activeForm when content is missing, dedupes, and defaults status to todo", () => {
		insertNarrator(
			db,
			"n1",
			JSON.stringify([
				{ activeForm: "from active form" },
				{ content: "dup" },
				{ content: "dup" },
				{ content: "   " },
			]),
		);
		const captured = captureLegacyTodos(db);
		dropTodosColumn(db);
		backfillLegacyTodosToSpec(db, captured);

		const doc = JSON.parse(readTasksJson(db, "n1") as string) as {
			tasks: { text: string; status: string }[];
		};
		expect(doc.tasks).toEqual([
			{ text: "from active form", status: "todo" },
			{ text: "dup", status: "todo" },
		]);
	});

	test("is idempotent: does not overwrite an already-populated tasks.json", () => {
		insertNarrator(db, "n1", JSON.stringify([{ content: "legacy", status: "pending" }]));
		const captured = captureLegacyTodos(db);
		dropTodosColumn(db);

		// Simulate the narrator already having Dynamic Spec tasks (user/agent produced).
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO spec_namespaces (id, narrator_id, created_at, updated_at) VALUES ('ns1','n1',?,?)",
		).run(now, now);
		const existing = `${JSON.stringify({ tasks: [{ text: "new task", status: "doing" }] }, null, "\t")}\n`;
		db.prepare(
			`INSERT INTO spec_file_revisions (id, namespace_id, path, content, content_hash, created_by, created_at)
			 VALUES ('rev1','ns1','tasks.json',?,'hash','user',?)`,
		).run(existing, now);
		db.prepare(
			`INSERT INTO spec_namespace_files (id, namespace_id, path, revision_id, deleted, updated_at)
			 VALUES ('f1','ns1','tasks.json','rev1',0,?)`,
		).run(now);

		backfillLegacyTodosToSpec(db, captured);

		// Unchanged — legacy data must not clobber existing tasks.
		expect(readTasksJson(db, "n1")).toBe(existing);
	});

	test("running the backfill twice does not duplicate (second capture is empty)", () => {
		insertNarrator(db, "n1", JSON.stringify([{ content: "task a", status: "pending" }]));
		const captured = captureLegacyTodos(db);
		dropTodosColumn(db);
		backfillLegacyTodosToSpec(db, captured);

		// After the drop, a fresh capture yields nothing → no re-run.
		expect(captureLegacyTodos(db)).toEqual([]);

		const doc = JSON.parse(readTasksJson(db, "n1") as string) as { tasks: unknown[] };
		expect(doc.tasks).toHaveLength(1);
	});

	test("caps at 100 tasks", () => {
		const many = Array.from({ length: 150 }, (_, i) => ({
			content: `task ${i}`,
			status: "pending",
		}));
		insertNarrator(db, "n1", JSON.stringify(many));
		const captured = captureLegacyTodos(db);
		dropTodosColumn(db);
		backfillLegacyTodosToSpec(db, captured);

		const doc = JSON.parse(readTasksJson(db, "n1") as string) as { tasks: unknown[] };
		expect(doc.tasks).toHaveLength(100);
	});

	test("skips orphan todos whose narrator no longer exists", () => {
		const captured = [{ narratorId: "ghost", todos: [{ content: "x", status: "pending" }] }];
		// No narrator row inserted for "ghost".
		backfillLegacyTodosToSpec(db, captured);
		expect(readTasksJson(db, "ghost")).toBeNull();
	});
});
