import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { closeDbWorkerConnections } from "../../../server/lib/db-worker/pool";

const directory = mkdtempSync(join(tmpdir(), "recall-worker-"));
const path = join(directory, "fixture.sqlite");
const sqlite = new Database(path);
sqlite.exec(`
	PRAGMA journal_mode=WAL;
	CREATE TABLE narrators(id TEXT PRIMARY KEY, title TEXT, chapter_id TEXT, model TEXT);
	CREATE TABLE narrator_messages(id TEXT PRIMARY KEY, role TEXT, content_text TEXT, created_at TEXT);
	CREATE TABLE narrator_message_refs(narrator_id TEXT, message_id TEXT, seq INTEGER);
	CREATE TABLE narrator_tool_calls(tool_use_id TEXT, tool_name TEXT, status TEXT,
		input_json TEXT, output_json TEXT, duration_ms INTEGER, error_message TEXT,
		created_at TEXT, narrator_id TEXT, message_id TEXT);
`);
const db = drizzle(sqlite);
mock.module("../../../server/db", () => ({ db, sqlite }));
mock.module("../../../server/services/search/backend", () => ({ searchStore: {} }));
const { recallTool } = await import("../../../server/lib/agent/tools/recall");

const prepare = sqlite.prepare.bind(sqlite);
let mainReadGuard: ReturnType<typeof spyOn> | undefined;
beforeEach(() => {
	sqlite.exec(`
		DELETE FROM narrator_tool_calls;
		DELETE FROM narrator_message_refs;
		DELETE FROM narrator_messages;
		DELETE FROM narrators;
		INSERT INTO narrators VALUES ('self', 'Self', NULL, 'model'), ('other', 'Other', NULL, NULL);
		INSERT INTO narrator_messages VALUES
			('m1', 'user', 'first', '2026-01-01'),
			('m2', 'assistant', 'second', '2026-01-02'),
			('m3', 'assistant', 'third', '2026-01-03'),
			('foreign', 'assistant', 'private', '2026-01-04');
		INSERT INTO narrator_message_refs VALUES ('self', 'm1', 1), ('self', 'm2', 2),
			('self', 'm3', 3), ('other', 'foreign', 1), ('other', 'm2', 2);
		INSERT INTO narrator_tool_calls VALUES
			('own-tool', 'Bash', 'completed', '{"command":"pwd"}', '{"_text":"/workspace"}',
			12, NULL, '2026-01-02', 'self', 'm2'),
			('foreign-tool', 'Read', 'completed', '{"file_path":"secret.txt"}', '{"_text":"secret"}',
			3, NULL, '2026-01-04', 'other', 'm2');
	`);
	mainReadGuard = spyOn(sqlite, "prepare").mockImplementation(
		(...args: Parameters<typeof sqlite.prepare>) => {
			if (/^\s*(select|with)\b/i.test(args[0])) throw new Error("Main-thread SELECT forbidden");
			return prepare(...args);
		},
	);
});
afterEach(() => mainReadGuard?.mockRestore());
afterAll(async () => {
	await closeDbWorkerConnections(path);
	sqlite.close();
	rmSync(directory, { recursive: true, force: true });
});

function recall(args: Record<string, unknown>, signal?: AbortSignal) {
	return recallTool.execute(args, { narratorId: "self", signal } as never);
}

test("file-backed worker returns latest messages in conversation order and scopes tool summaries", async () => {
	const result = await recall({ action: "read_conversation", limit: 2 });
	expect(result.isError).not.toBe(true);
	expect(result.metadata).toMatchObject({
		narratorId: "self",
		messages: [
			{ id: "m2", seq: 2, toolCalls: [{ toolUseId: "own-tool", summary: "pwd" }] },
			{ id: "m3", seq: 3 },
		],
	});
	expect(result.output).not.toContain("foreign-tool");
});

test("centered reads preserve the inclusive sequence window and reject foreign refs", async () => {
	const result = await recall({ action: "read_conversation", message_id: "m2", limit: 2 });
	expect(result.metadata).toMatchObject({ messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] });
	expect((await recall({ action: "read_conversation", message_id: "foreign" })).isError).toBe(true);
});

test("conversation scope expands only when all_narrators is explicitly set", async () => {
	expect((await recall({ action: "read_conversation", narrator_id: "other" })).isError).toBe(true);
	const result = await recall({
		action: "read_conversation",
		narrator_id: "other",
		all_narrators: true,
	});
	expect(result.metadata).toMatchObject({
		narratorId: "other",
		messages: [{ id: "foreign" }, { id: "m2" }],
	});
	expect(
		(await recall({ action: "read_conversation", narrator_id: "missing", all_narrators: true }))
			.isError,
	).toBe(true);
});

test("tool detail retains decoded JSON and requires explicit cross-narrator scope", async () => {
	const own = await recall({ action: "read_tool_call", tool_call_id: "own-tool" });
	expect(own.metadata).toMatchObject({
		narratorId: "self",
		durationMs: 12,
		input: { command: "pwd" },
		output: { _text: "/workspace" },
	});
	expect((await recall({ action: "read_tool_call", tool_call_id: "foreign-tool" })).isError).toBe(
		true,
	);
	const foreign = await recall({
		action: "read_tool_call",
		tool_call_id: "foreign-tool",
		all_narrators: true,
	});
	expect(foreign.metadata).toMatchObject({
		narratorId: "other",
		input: { file_path: "secret.txt" },
	});
});

test("fresh reads observe committed changes rather than reuse a prior result", async () => {
	await recall({ action: "read_conversation" });
	await recall({ action: "read_tool_call", tool_call_id: "own-tool" });
	sqlite.exec(`UPDATE narrator_messages SET content_text = 'updated' WHERE id = 'm3';
		UPDATE narrator_tool_calls SET output_json = '{"_text":"changed"}' WHERE tool_use_id = 'own-tool';`);
	expect((await recall({ action: "read_conversation", limit: 1 })).metadata).toMatchObject({
		messages: [{ id: "m3", text: "updated" }],
	});
	expect(
		(await recall({ action: "read_tool_call", tool_call_id: "own-tool" })).metadata,
	).toMatchObject({ output: { _text: "changed" } });
});

test("cancelled reads reject and leave subsequent worker reads usable", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(recall({ action: "read_conversation" }, controller.signal)).rejects.toThrow();
	await expect(
		recall({ action: "read_tool_call", tool_call_id: "own-tool" }, controller.signal),
	).rejects.toThrow();
	expect((await recall({ action: "read_tool_call", tool_call_id: "own-tool" })).isError).not.toBe(
		true,
	);
});
