import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";

// No user database is imported or opened by these tests.
mock.module("../../db", () => ({ activeDatabaseBackend: "sqlite", sqlite: null }));
const { createContextCharacterService } = await import("../narrator-context-composition");
let database: Database;
let service: ReturnType<typeof createContextCharacterService>;
beforeEach(() => {
	database = new Database(":memory:");
	// Deliberately omit every body column: accidentally reading a body fails at SQL preparation.
	database.run(`CREATE TABLE narrators (id TEXT PRIMARY KEY, type TEXT DEFAULT 'primary', variant TEXT DEFAULT 'primary', message_version INTEGER DEFAULT 0,
	 context_char_revision INTEGER DEFAULT 0, context_system_chars INTEGER DEFAULT 0,
	 context_summary_chars INTEGER DEFAULT 0, context_tools_chars INTEGER DEFAULT 0, context_char_cache_json TEXT);
	 CREATE TABLE narrator_message_refs (narrator_id TEXT, message_id TEXT, seq INTEGER, is_compact INTEGER DEFAULT 0, segment_compact_id TEXT);
	 CREATE INDEX refs_seq ON narrator_message_refs(narrator_id,seq);
	 CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, role TEXT, parent_tool_use_id TEXT, context_chars_json TEXT);
	 CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, tool_use_id TEXT, execution_attempt INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-01-01', input_chars INTEGER DEFAULT 0, output_chars INTEGER DEFAULT 0);
	 CREATE INDEX tools_message ON narrator_tool_calls(message_id);
	 CREATE TABLE narrator_context_char_pages (id TEXT PRIMARY KEY, narrator_id TEXT, generation TEXT, page INTEGER, segments_json TEXT);
	 CREATE UNIQUE INDEX pages_generation ON narrator_context_char_pages(narrator_id,generation,page);
	 INSERT INTO narrators(id) VALUES ('n');`);
	service = createContextCharacterService(database);
});
afterEach(async () => {
	await service.settled();
	database.close();
});
function message(id: string, seq: number, segments: unknown = null, role = "user") {
	database
		.query("INSERT INTO narrator_messages(id,role,context_chars_json) VALUES (?,?,?)")
		.run(id, role, segments === null ? null : JSON.stringify({ segments }));
	database
		.query("INSERT INTO narrator_message_refs(narrator_id,message_id,seq) VALUES ('n',?,?)")
		.run(id, seq);
}
async function ready() {
	await service.get("n");
	await service.settled();
	return service.get("n");
}

test("legacy NULL statistics are zero without selecting any message/prompt/tool body", async () => {
	message("legacy", 1);
	expect(await service.get("n")).toMatchObject({ totalChars: 0, pending: true, generation: null });
	const result = await ready();
	expect(result.totalChars).toBe(0);
	expect(result.pending).toBe(false);
	expect(result.totals).toHaveLength(9);
});

test("full ordered history is paged at 128 and totals include every page", async () => {
	database.run(
		"UPDATE narrators SET context_system_chars=7, context_summary_chars=11, context_tools_chars=13 WHERE id='n'",
	);
	for (let i = 0; i < 300; i++)
		message(`m${i}`, i, [{ category: i % 2 ? "assistant" : "user", chars: i + 1 }]);
	let result = await ready();
	expect(result.totalChars).toBe(7 + 11 + 13 + (300 * 301) / 2);
	expect(result.segments.slice(0, 3).map((s) => s.category)).toEqual([
		"system",
		"summary",
		"toolDefinition",
	]);
	const all = [...result.segments];
	while (result.nextCursor) {
		expect(result.segments.length).toBeLessThanOrEqual(128);
		expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256 * 1024);
		result = await service.get("n", undefined, result.nextCursor);
		all.push(...result.segments);
	}
	expect(all).toHaveLength(303);
	expect(all.reduce((sum, s) => sum + s.chars, 0)).toBe(result.totalChars);
});

test("latest full compact boundary and segment compact exclusion leave only active numeric history", async () => {
	message("old", 1, [{ category: "user", chars: 1000 }]);
	message("compact", 2, [{ category: "summary", chars: 100 }], "system");
	database.run("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='compact'");
	message("hidden", 3, [{ category: "user", chars: 2000 }]);
	database.run(
		"UPDATE narrator_message_refs SET segment_compact_id='seg-summary' WHERE message_id='hidden'",
	);
	message("seg-summary", 4, [{ category: "summary", chars: 20 }], "system");
	message("visible", 5, [{ category: "user", chars: 3 }]);
	message("display", 6, [{ category: "other", chars: 5000 }], "disp");
	database.run("UPDATE narrators SET context_summary_chars=100 WHERE id='n'");
	const result = await ready();
	expect(result.totalChars).toBe(123);
	expect(result.segments.map((s) => s.chars)).toEqual([100, 20, 3]);
});

test("only latest tool execution attempt counts, not duplicate tool blocks in message stats", async () => {
	message("m", 1, [
		{ category: "assistant", chars: 9 },
		{ category: "toolCall", chars: 900 },
		{ category: "toolResult", chars: 999 },
	]);
	database.run(`INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,execution_attempt,input_chars,output_chars) VALUES
	 ('a','n','m','call',0,100,200), ('b','n','m','call',1,3,5), ('c','n','m','other',0,7,0);`);
	const result = await ready();
	expect(result.totalChars).toBe(24);
	expect(result.segments).toEqual([
		{ category: "assistant", chars: 9 },
		{ category: "toolCall", chars: 3 },
		{ category: "toolCall", chars: 7 },
		{ category: "toolResult", chars: 5 },
	]);
});

test("interleaved assistant text, attachments and tool markers retain order, results follow the block", async () => {
	message(
		"m",
		1,
		[
			{ category: "assistant", chars: 2 },
			{ category: "toolCall", chars: 0, toolUseId: "second" },
			{ category: "assistant", chars: 3 },
			{ category: "attachment", chars: 5 },
			{ category: "assistant", chars: 7 },
			{ category: "toolCall", chars: 0, toolUseId: "first" },
			{ category: "toolCall", chars: 0, toolUseId: "second" },
			{ category: "toolResult", chars: 999 },
		],
		"assistant",
	);
	database.run(`INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,execution_attempt,created_at,input_chars,output_chars) VALUES
	 ('z','n','m','first',0,'2026-01-01T00:00:01',11,13),
	 ('y-old','n','m','second',0,'2026-01-01T00:00:02',1000,2000),
	 ('y','n','m','second',1,'2026-01-01T00:00:03',17,19),
	 ('x','n','m','unmarked',0,'2026-01-01T00:00:04',23,29);`);
	const result = await ready();
	expect(result.segments).toEqual([
		{ category: "assistant", chars: 2 },
		{ category: "toolCall", chars: 17 },
		{ category: "assistant", chars: 3 },
		{ category: "attachment", chars: 5 },
		{ category: "assistant", chars: 7 },
		{ category: "toolCall", chars: 11 },
		{ category: "toolCall", chars: 23 },
		{ category: "toolResult", chars: 13 },
		{ category: "toolResult", chars: 19 },
		{ category: "toolResult", chars: 29 },
	]);
	expect(result.totalChars).toBe(129);
	expect(JSON.stringify(result)).not.toContain("toolUseId");
});

test("legacy system role ignores ordinary content but keeps segment summary; sys remains model content", async () => {
	message(
		"legacy-system",
		1,
		[
			{ category: "system", chars: 1000 },
			{ category: "attachment", chars: 500 },
		],
		"system",
	);
	message("segment", 2, [{ category: "summary", chars: 13 }], "system");
	message("live-injection", 3, [{ category: "system", chars: 17 }], "sys");
	const result = await ready();
	expect(result.segments).toEqual([
		{ category: "summary", chars: 13 },
		{ category: "system", chars: 17 },
	]);
	expect(result.totalChars).toBe(30);
});

test("primary excludes linked child trees while subagent keeps its own projected refs", async () => {
	message("top", 1, [{ category: "user", chars: 3 }]);
	message("child-tree", 2, [{ category: "assistant", chars: 5 }], "assistant");
	database.run(`UPDATE narrator_messages SET parent_tool_use_id='parent-tool' WHERE id='child-tree';
	 INSERT INTO narrator_tool_calls(id,narrator_id,message_id,tool_use_id,input_chars,output_chars) VALUES ('nested-tool','child','child-tree','bash',7,11);
	 INSERT INTO narrators(id,type,variant) VALUES ('child','subagent','primary');
	 INSERT INTO narrator_message_refs SELECT 'child',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n';`);
	expect((await ready()).totalChars).toBe(3);
	await service.get("child");
	await service.settled();
	expect((await service.get("child")).totalChars).toBe(26);
	// Profile itself participates in the cache fingerprint even without a version bump.
	database.run("UPDATE narrators SET variant='subagent:general' WHERE id='n'");
	expect((await service.get("n")).pending).toBe(true);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(26);
});

test("child compact marker cannot advance the primary compact boundary", async () => {
	message("top-before", 1, [{ category: "user", chars: 3 }]);
	message("child-compact", 2, [], "system");
	message("top-after", 3, [{ category: "assistant", chars: 5 }], "assistant");
	database.run(`UPDATE narrator_messages SET parent_tool_use_id='parent-tool' WHERE id='child-compact';
	 UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='child-compact';`);
	expect((await ready()).totalChars).toBe(8);
});

test("cancel removes unpublished pages and a later refresh rebuilds the complete total", async () => {
	for (let i = 0; i < 300; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	await service.get("n");
	let staged = false;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()) {
			staged = true;
			break;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	expect(staged).toBe(true);
	await service.cancel("n");
	expect(
		database.query("SELECT context_char_cache_json AS cache FROM narrators WHERE id='n'").get(),
	).toEqual({ cache: null });
	expect(database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()).toBeNull();
	expect((await ready()).totalChars).toBe(300);
});

test("background budget expiry preserves the old complete generation, not a truncated total", async () => {
	message("old", 1, [{ category: "user", chars: 10 }]);
	const old = await ready();
	for (let i = 0; i < 100; i++) message(`m${i}`, i + 2, [{ category: "user", chars: 1 }]);
	database.run("UPDATE narrators SET message_version=message_version+1 WHERE id='n'");
	const limited = createContextCharacterService(database, { budgetMs: 8 });
	expect((await limited.get("n")).pending).toBe(true);
	await limited.settled();
	const row = database
		.query<{ cache: string }, []>(
			"SELECT context_char_cache_json AS cache FROM narrators WHERE id='n'",
		)
		.get();
	expect(JSON.parse(row?.cache ?? "null").generation).toBe(old.generation);
	expect(JSON.parse(row?.cache ?? "null").totalChars).toBe(10);
	await limited.dispose();
	expect((await ready()).totalChars).toBe(110);
});

test("dispose cancels queued jobs and rejects new reads", async () => {
	message("m", 1, [{ category: "user", chars: 5 }]);
	await service.get("n");
	await service.dispose();
	expect(
		database.query("SELECT context_char_cache_json AS cache FROM narrators WHERE id='n'").get(),
	).toEqual({ cache: null });
	expect(database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()).toBeNull();
	await expect(service.get("n")).rejects.toThrow("disposed");
});

test("restart reads persisted pages directly and fullfork derives counts from shared refs", async () => {
	message("m", 1, [{ category: "user", chars: 5 }]);
	const before = await ready();
	const restarted = createContextCharacterService(database);
	expect(await restarted.get("n")).toEqual(before);
	database.run(
		"INSERT INTO narrators(id) VALUES ('fork'); INSERT INTO narrator_message_refs SELECT 'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
	);
	expect((await restarted.get("fork")).pending).toBe(true);
	await restarted.settled();
	expect((await restarted.get("fork")).totalChars).toBe(5);
	await restarted.dispose();
});

test("shared message invalidation refreshes existing fullfork numeric caches", async () => {
	message("shared", 1, [{ category: "user", chars: 5 }]);
	await ready();
	database.run(
		"INSERT INTO narrators(id) VALUES ('fork'); INSERT INTO narrator_message_refs SELECT 'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
	);
	await service.get("fork");
	await service.settled();
	expect((await service.get("fork")).totalChars).toBe(5);
	database
		.query("UPDATE narrator_messages SET context_chars_json=? WHERE id='shared'")
		.run(JSON.stringify({ segments: [{ category: "user", chars: 23 }] }));
	await service.invalidate("n", "shared");
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(23);
	expect((await service.get("fork")).totalChars).toBe(23);
});

test("actor removal interrupts a background rebuild and removes its staged generation", async () => {
	for (let i = 0; i < 150; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	await service.get("n");
	for (let attempt = 0; attempt < 200; attempt++) {
		if (database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()) break;
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
	}
	expect(database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()).not.toBeNull();
	database.run("DELETE FROM narrators WHERE id='n'");
	await service.settled();
	expect(database.query("SELECT id FROM narrator_context_char_pages LIMIT 1").get()).toBeNull();
});

test("version competition rejects stale background publication and coalesces refreshes", async () => {
	for (let i = 0; i < 80; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	await service.get("n");
	// Let rebuilding consume at least one message, then mutate during its async yield.
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	database
		.query("UPDATE narrator_messages SET context_chars_json=? WHERE id='m0'")
		.run(JSON.stringify({ segments: [{ category: "user", chars: 30 }] }));
	database.run("UPDATE narrators SET message_version=message_version+1 WHERE id='n'");
	await service.storeRuntime("n", { systemChars: 7, toolsChars: 11 });
	await service.invalidate("n");
	await service.settled();
	const result = await service.get("n");
	expect(result.pending).toBe(false);
	expect(result.totalChars).toBe(127);
	const generations = database
		.query<{ generation: string }, []>(
			"SELECT DISTINCT generation FROM narrator_context_char_pages",
		)
		.all();
	expect(generations).toEqual([{ generation: result.generation as string }]);
});

test("message version change schedules refresh; old cursor restarts new generation", async () => {
	message("m", 1, [{ category: "user", chars: 4 }]);
	const old = await ready();
	database.run(
		"DELETE FROM narrator_message_refs; UPDATE narrators SET message_version=1 WHERE id='n'",
	);
	expect((await service.get("n")).pending).toBe(true);
	await service.settled();
	const fresh = await service.get("n", undefined, `${old.generation}:1`);
	expect(fresh.totalChars).toBe(0);
	expect(fresh.generation).not.toBe(old.generation);
	expect(fresh.pending).toBe(false);
});

test("malformed cursor, missing narrator and cancelled signal fail clearly", async () => {
	const result = await ready();
	await expect(service.get("n", undefined, "bad")).rejects.toThrow("Invalid context cursor");
	await expect(service.get("n", undefined, `${result.generation}:999`)).rejects.toThrow(
		"out of range",
	);
	await expect(service.get("missing")).rejects.toThrow();
	await expect(service.get("n", AbortSignal.abort(new Error("cancelled")))).rejects.toThrow(
		"cancelled",
	);
});

test("restart rebuild reclaims every unpublished generation in bounded batches", async () => {
	message("new", 1, [{ category: "user", chars: 7 }]);
	const insert = database.query(
		"INSERT INTO narrator_context_char_pages(id,narrator_id,generation,page,segments_json) VALUES (?,?,?,?,?)",
	);
	for (let i = 0; i < 140; i++)
		insert.run(`orphan-${i}`, "n", `interrupted-${i % 2}`, i, "not-json");
	database.run("INSERT INTO narrators(id) VALUES ('other')");
	insert.run("other-page", "other", "other-generation", 0, "[]");
	await service.dispose();
	service = createContextCharacterService(database);
	const result = await ready();
	expect(result.totalChars).toBe(7);
	expect(
		database
			.query(
				"SELECT COUNT(*) AS count FROM narrator_context_char_pages WHERE narrator_id='n' AND generation!=?",
			)
			.get(result.generation),
	).toEqual({ count: 0 });
	expect(
		database
			.query("SELECT COUNT(*) AS count FROM narrator_context_char_pages WHERE narrator_id='n'")
			.get(),
	).toEqual({ count: 1 });
	expect(
		database.query("SELECT id FROM narrator_context_char_pages WHERE narrator_id='other'").get(),
	).toEqual({ id: "other-page" });
});
test("restart with an already current cache preserves published pages while reclaiming old debris", async () => {
	for (let i = 0; i < 150; i++) message(`valid-${i}`, i, [{ category: "user", chars: 1 }]);
	const before = await ready();
	await service.settled();
	const insert = database.query(
		"INSERT INTO narrator_context_char_pages(id,narrator_id,generation,page,segments_json) VALUES (?,?,?,?,?)",
	);
	for (let i = 0; i < 140; i++) insert.run(`leftover-${i}`, "n", "previous-unreferenced", i, "[]");
	await service.dispose();
	service = createContextCharacterService(database);
	const first = await service.get("n");
	expect(first.pending).toBe(false);
	expect(first.generation).toBe(before.generation);
	await service.settled();
	expect(
		database
			.query(
				"SELECT COUNT(*) AS count FROM narrator_context_char_pages WHERE narrator_id='n' AND generation!=?",
			)
			.get(before.generation),
	).toEqual({ count: 0 });
	const second = await service.get("n", undefined, first.nextCursor ?? undefined);
	expect(second.generation).toBe(before.generation);
	expect(second.totalChars).toBe(150);
	expect(first.segments.length + second.segments.length).toBe(150);
});
