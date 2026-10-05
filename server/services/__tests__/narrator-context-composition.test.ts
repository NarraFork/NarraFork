import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { ContextInputCharacters } from "@shared/context-usage";
import { z } from "zod";
import { countInputCharacters } from "../../lib/agent/input-characters";
import { countRuntimeSystemCharacters } from "../agent-runtime/prompt-characters";

// No user database is imported or opened by these tests.
mock.module("../../db", () => ({ activeDatabaseBackend: "sqlite", sqlite: null, db: null }));
const { createContextCharacterService } = await import("../narrator-context-composition");
let database: Database;
let service: ReturnType<typeof createContextCharacterService>;
beforeEach(() => {
	database = new Database(":memory:");
	// Deliberately omit every body column: accidentally reading a body fails at SQL preparation.
	database.run(`CREATE TABLE narrators (id TEXT PRIMARY KEY, type TEXT DEFAULT 'primary', variant TEXT DEFAULT 'primary', message_version INTEGER DEFAULT 0,
	 context_char_revision INTEGER DEFAULT 0, context_system_chars INTEGER DEFAULT 0,
	 context_summary_chars INTEGER DEFAULT 0, context_tools_chars INTEGER DEFAULT 0, context_char_cache_json TEXT, context_usage_snapshot_json TEXT);
	 CREATE TABLE narrator_message_refs (narrator_id TEXT, message_id TEXT, seq INTEGER, is_compact INTEGER DEFAULT 0, segment_compact_id TEXT);
	 CREATE INDEX refs_seq ON narrator_message_refs(narrator_id,seq);
	 CREATE INDEX refs_compact_seq ON narrator_message_refs(narrator_id,is_compact,seq);
	 CREATE TABLE narrator_messages (id TEXT PRIMARY KEY, role TEXT, parent_tool_use_id TEXT, context_chars_json TEXT);
	 CREATE TABLE narrator_tool_calls (id TEXT PRIMARY KEY, narrator_id TEXT, message_id TEXT, tool_use_id TEXT, execution_attempt INTEGER DEFAULT 0, created_at TEXT DEFAULT '2026-01-01', input_chars INTEGER DEFAULT 0, output_chars INTEGER DEFAULT 0);
	 CREATE INDEX tools_message ON narrator_tool_calls(message_id);
	 CREATE TABLE narrator_context_char_pages (id TEXT PRIMARY KEY, narrator_id TEXT, generation TEXT, page INTEGER, segments_json TEXT);
	 CREATE UNIQUE INDEX pages_generation ON narrator_context_char_pages(narrator_id,generation,page);
	 INSERT INTO narrators(id) VALUES ('n');`);
	service = createContextCharacterService(database, { debounceMs: 0 });
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
	const limited = createContextCharacterService(database, { budgetMs: 0, debounceMs: 0 });
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
	service = createContextCharacterService(database, { debounceMs: 0 });
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
	service = createContextCharacterService(database, { debounceMs: 0 });
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

test("real Anthropic formatter and final body callback project legacy fixed counts without losing classification", async () => {
	const { AnthropicProvider } = await import("../../lib/agent/anthropic-provider");
	const provider = new AnthropicProvider({
		id: "projection",
		name: "projection",
		prefix: "projection",
		apiKey: "test",
		baseUrl: "https://example.invalid/v1",
		defaultModel: "claude-sonnet-4-6",
		officialApi: true,
	});
	const summary = "旧总结😀";
	const prompt = `actual host\n${summary}\nend`;
	const systemOnly = countRuntimeSystemCharacters(prompt, summary);
	const nativeFetch = globalThis.fetch;
	try {
		for (const numberOfTools of [0, 1, 2]) {
			const tools = provider.formatTools(
				Array.from({ length: numberOfTools }, (_, i) => ({
					name: `Read${i}`,
					description: "read a file",
					parameters: z.object({ path: z.string() }),
					execute: async () => ({ output: "" }),
				})),
			);
			const oldToolsChars = JSON.stringify(tools).length;
			database
				.query(
					"UPDATE narrators SET context_system_chars=?,context_summary_chars=0,context_tools_chars=?,context_usage_snapshot_json=NULL,context_char_revision=context_char_revision+1 WHERE id='n'",
				)
				.run(systemOnly, oldToolsChars);
			if (numberOfTools === 0) message("known-variable", 1, [{ category: "user", chars: 5 }]);
			await ready();
			await service.settled();
			let received: ContextInputCharacters | null = null;
			let sent: unknown;
			globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
				sent = JSON.parse(String(init?.body));
				return new Response("controlled failure", { status: 500 });
			}) as unknown as typeof fetch;
			const history: unknown[] = [{ role: "user", content: [{ type: "text", text: "known" }] }];
			provider.injectSystemPrompt(history, prompt, "projection:claude-sonnet-4-6");
			try {
				for await (const _event of provider.chat({
					conversationId: "fixed-projection",
					content: "current",
					model: "projection:claude-sonnet-4-6",
					cwd: ".",
					history,
					tools,
					toolResults: [],
					signal: new AbortController().signal,
					onInputCharacters: (counts) => {
						received = counts;
						service.freeze(
							"n",
							counts,
							`request-real-${numberOfTools}`,
							"2026-10-05T00:00:00Z",
							prompt.length - systemOnly,
						);
					},
				})) {
					/* drain */
				}
			} catch {
				/* controlled HTTP failure comes after final-input callback */
			}
			const counts = received as ContextInputCharacters | null;
			expect(counts).not.toBeNull();
			if (!counts) throw new Error("final provider callback missing");
			expect(await countInputCharacters(sent)).toEqual(counts);
			expect((await countInputCharacters({ tools }))?.toolsChars).toBe(counts.toolsChars);
			expect(counts.toolsChars).not.toBe(oldToolsChars);
			const projected = await service.get("n");
			expect(projected.usage?.composition).not.toBeNull();
			expect(projected.totalChars).toBe(counts.systemChars + counts.toolsChars + 5);
			expect(projected.totals.find((item) => item.category === "summary")?.chars).toBe(
				summary.length,
			);
			expect(projected.totals.find((item) => item.category === "system")?.chars).toBe(
				counts.systemChars - summary.length,
			);
			expect(projected.totals.find((item) => item.category === "toolDefinition")?.chars).toBe(
				counts.toolsChars,
			);
			expect(
				database.query("SELECT context_summary_chars AS chars FROM narrators WHERE id='n'").get(),
			).toEqual({ chars: 0 });
			const all = [...projected.segments];
			let cursor = projected.nextCursor;
			while (cursor) {
				const next = await service.get("n", undefined, cursor);
				expect(next.segments.length).toBeLessThanOrEqual(128);
				all.push(...next.segments);
				cursor = next.nextCursor;
			}
			expect(all.reduce((sum, item) => sum + item.chars, 0)).toBe(projected.totalChars);
			expect(all.filter((item) => item.category === "user")).toEqual([
				{ category: "user", chars: 5 },
			]);
		}
	} finally {
		globalThis.fetch = nativeFetch;
	}
});

test("freeze pins numeric generation; rebuild and restart retain only published plus latest request", async () => {
	message("input", 1, [{ category: "user", chars: 10000 }]);
	database.run(
		"UPDATE narrators SET context_system_chars=7, context_summary_chars=11, context_tools_chars=13 WHERE id='n'",
	);
	const before = await ready();
	await service.settled();
	const counts = { totalChars: 1_000_000, systemChars: 18, toolsChars: 13 };
	const composition = service.freeze("n", counts, "req-one", "2026-10-05T00:00:00Z");
	expect(composition?.generation).toBe(before.generation ?? undefined);
	expect(composition?.totalChars).toBe(10031);
	service.storeUsage("n", {
		requestId: "req-one",
		startedAt: "2026-10-05T00:00:00Z",
		source: "upstream",
		percentage: 92.6,
		contextWindow: 1_000_000,
		occupiedTokens: 926000,
		inputCharacters: counts,
		composition,
	});
	message("output", 2, [{ category: "assistant", chars: 500 }]);
	await service.invalidate("n");
	await service.settled();
	const pinned = await service.get("n");
	expect(pinned.generation).toBe(before.generation);
	expect(pinned.totalChars).toBe(10031);
	expect(pinned.usage?.occupiedTokens).toBe(926000);
	expect(pinned.usage?.inputCharacters?.totalChars).toBe(1_000_000);
	await service.dispose();
	service = createContextCharacterService(database, { debounceMs: 0 });
	expect((await service.get("n")).generation).toBe(before.generation);
	await service.settled();
	expect(
		database
			.query(
				"SELECT count(DISTINCT generation) AS count FROM narrator_context_char_pages WHERE narrator_id='n'",
			)
			.get(),
	).toEqual({ count: 2 });
	const newer = service.freeze("n", counts, "req-two", "2026-10-05T00:01:00Z");
	expect(newer?.generation).not.toBe(before.generation);
	await service.get("n");
	await service.settled();
	expect(
		database
			.query(
				"SELECT count(DISTINCT generation) AS count FROM narrator_context_char_pages WHERE narrator_id='n'",
			)
			.get(),
	).toEqual({ count: 1 });
});

test("fixed-body match uses runtime system plus summary, not aggregate history injections", async () => {
	database.run(
		"UPDATE narrators SET context_system_chars=7, context_summary_chars=11, context_tools_chars=13 WHERE id='n'",
	);
	message("sys-injection", 1, [{ category: "system", chars: 100 }], "sys");
	message("segment-summary", 2, [{ category: "summary", chars: 20 }], "system");
	await ready();
	await service.settled();
	const composition = service.freeze(
		"n",
		{ totalChars: 1000000, systemChars: 18, toolsChars: 13 },
		"body-fixed",
		"2026-10-05T00:00:00Z",
		11,
	);
	expect(composition?.totalChars).toBe(151);
	expect(composition?.totals.find((item) => item.category === "system")?.chars).toBe(107);
	expect(composition?.totals.find((item) => item.category === "summary")?.chars).toBe(31);
});

test("request prefix pagination never overfills a 128-segment base page", async () => {
	for (let i = 0; i < 129; i++) message(`paged-${i}`, i, [{ category: "user", chars: 1 }]);
	await ready();
	await service.settled();
	service.freeze(
		"n",
		{ totalChars: 1000, systemChars: 12, toolsChars: 3 },
		"page-prefix",
		"2026-10-05T00:00:00Z",
		2,
	);
	let result = await service.get("n");
	expect(result.segments).toEqual([
		{ category: "system", chars: 10 },
		{ category: "summary", chars: 2 },
		{ category: "toolDefinition", chars: 3 },
	]);
	const all = [...result.segments];
	while (result.nextCursor) {
		result = await service.get("n", undefined, result.nextCursor);
		expect(result.segments.length).toBeLessThanOrEqual(128);
		all.push(...result.segments);
	}
	expect(all.reduce((sum, item) => sum + item.chars, 0)).toBe(144);
	expect(all.filter((item) => item.category === "user")).toHaveLength(129);
});

test("stale variable cache keeps only final fixed items and a lost prefix pin becomes unknown", async () => {
	message("unmatched-old", 1, [{ category: "user", chars: 10000 }]);
	await ready();
	await service.settled();
	database.run("UPDATE narrators SET context_char_revision=context_char_revision+1 WHERE id='n'");
	const cache = service.freeze(
		"n",
		{ totalChars: 1_000_000, systemChars: 100, toolsChars: 20 },
		"new-fixed-only",
		"2026-10-05T00:00:00Z",
		14,
	);
	expect(cache?.totalChars).toBe(120);
	const result = await service.get("n");
	expect(result.totals.find((item) => item.category === "user")?.chars).toBe(0);
	expect(result.segments).toEqual([
		{ category: "system", chars: 86 },
		{ category: "summary", chars: 14 },
		{ category: "toolDefinition", chars: 20 },
	]);
	expect(
		database.query("SELECT context_summary_chars AS chars FROM narrators WHERE id='n'").get(),
	).toEqual({ chars: 0 });
	await service.settled();
	database
		.query("DELETE FROM narrator_context_char_pages WHERE narrator_id='n' AND generation=?")
		.run(cache?.generation ?? "");
	expect((await service.get("n")).usage?.composition).toBeNull();
});

test("stale cache or missing/incorrect full-input counts never calibrate old known buckets", async () => {
	message("known", 1, [{ category: "user", chars: 10000 }]);
	await ready();
	await service.settled();
	const date = "2026-10-05T00:00:00Z";
	expect(service.freeze("n", null, "no-counts", date)).toBeNull();
	expect(
		service.freeze(
			"n",
			{ totalChars: 1000000, systemChars: 1, toolsChars: 0 },
			"fixed-mismatch",
			date,
		),
	).toMatchObject({ totalChars: 10001 });
	database.run("UPDATE narrators SET context_char_revision=context_char_revision+1 WHERE id='n'");
	expect(
		service.freeze("n", { totalChars: 1000000, systemChars: 0, toolsChars: 0 }, "stale", date),
	).toMatchObject({ totalChars: 0 });
	expect((await service.get("n")).totals.find((item) => item.category === "user")?.chars).toBe(0);
});

test("warm 1000 refs rereads only one dirty contribution, fresh GET never rebuilds", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, {
		debounceMs: 0,
		onMetrics: (item) => metrics.push(item),
	});
	for (let i = 0; i < 1000; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	expect((await ready()).totalChars).toBe(1000);
	metrics.length = 0;
	database
		.query("UPDATE narrator_messages SET context_chars_json=? WHERE id='m500'")
		.run(JSON.stringify({ segments: [{ category: "user", chars: 41 }] }));
	await service.invalidateBatch("n", ["m500"]);
	expect((await service.get("n")).pending).toBe(true);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(1040);
	expect(metrics).toHaveLength(1);
	expect(metrics[0]).toMatchObject({ mode: "incremental", rows: 1 });
	expect(metrics[0].queries).toBeLessThan(30);
	await service.get("n");
	await service.settled();
	expect(metrics).toHaveLength(1);
});

test("production debounce coalesces burst and freezes fixed-only while dirty", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, { onMetrics: (item) => metrics.push(item) });
	message("m", 1, [{ category: "user", chars: 1 }]);
	await ready();
	metrics.length = 0;
	for (let i = 0; i < 10; i++) await service.invalidateBatch("n", ["m"]);
	expect((await service.get("n")).pending).toBe(true);
	expect(metrics).toHaveLength(0);
	expect(
		service.freeze(
			"n",
			{ totalChars: 50, systemChars: 3, toolsChars: 2 },
			"dirty",
			"2026-10-05T00:00:00Z",
		)?.totalChars,
	).toBe(5);
	await service.settled();
	expect(metrics).toHaveLength(1);
	expect(metrics[0]).toMatchObject({ mode: "incremental", rows: 1 });
	expect(metrics[0].waitMs).toBeGreaterThanOrEqual(80);
});

test("dirty removal and unnotified append tail converge without scanning old refs", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, {
		debounceMs: 0,
		onMetrics: (item) => metrics.push(item),
	});
	for (let i = 0; i < 1000; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	await ready();
	metrics.length = 0;
	database.run("DELETE FROM narrator_message_refs WHERE message_id='m500'");
	message("tail", 1000, [{ category: "assistant", chars: 9 }]);
	await service.invalidateBatch("n", ["m500"]);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(1008);
	expect(metrics[0]).toMatchObject({ mode: "incremental", rows: 1 });
});

test("five actors share two jobs and page staging yields heartbeat opportunities", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, { onMetrics: (item) => metrics.push(item) });
	for (let i = 0; i < 1000; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	for (const id of ["a", "b", "c", "d"]) {
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		database
			.query(
				"INSERT INTO narrator_message_refs SELECT ?,message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
			)
			.run(id);
	}
	for (const id of ["n", "a", "b", "c", "d"]) await service.get(id);
	let maxStaged = 0,
		beats = 0;
	const heartbeat = setInterval(() => {
		beats++;
		const rows = database
			.query<{ id: string }, []>(
				"SELECT DISTINCT narrator_id AS id FROM narrator_context_char_pages",
			)
			.all();
		const unpublished = rows.filter(
			(row) =>
				!database
					.query<{ cache: string | null }, [string]>(
						"SELECT context_char_cache_json AS cache FROM narrators WHERE id=?",
					)
					.get(row.id)?.cache,
		);
		maxStaged = Math.max(maxStaged, unpublished.length);
	}, 1);
	await service.settled();
	clearInterval(heartbeat);
	expect(maxStaged).toBeLessThanOrEqual(2);
	expect(maxStaged).toBeGreaterThan(0);
	expect(beats).toBeGreaterThan(10);
	expect(Math.max(...metrics.map((item) => item.activeJobs))).toBe(2);
	for (const id of ["n", "a", "b", "c", "d"]) expect((await service.get(id)).totalChars).toBe(1000);
});

test("continuous updates collect another bounded round and settle at the last numeric value", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, {
		debounceMs: 0,
		onMetrics: (item) => metrics.push(item),
	});
	for (let i = 0; i < 1000; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	await ready();
	metrics.length = 0;
	for (let value = 2; value <= 12; value++) {
		database
			.query("UPDATE narrator_messages SET context_chars_json=? WHERE id='m500'")
			.run(JSON.stringify({ segments: [{ category: "user", chars: value }] }));
		await service.invalidateBatch("n", ["m500"]);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(1011);
	expect(metrics.every((item) => item.mode === "incremental")).toBe(true);
	expect(metrics.every((item) => item.rows <= 1)).toBe(true);
	expect(metrics.length).toBeLessThanOrEqual(12);
});

test("removing a compact marker forces cold visibility recovery", async () => {
	message("old", 1, [{ category: "user", chars: 10 }]);
	message("compact", 2, [], "system");
	database.run("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='compact'");
	message("new", 3, [{ category: "user", chars: 1 }]);
	expect((await ready()).totalChars).toBe(1);
	database.run("DELETE FROM narrator_message_refs WHERE message_id='compact'");
	await service.invalidateBatch("n", ["compact"]);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(11);
});

test("batch shared holders receive one epoch and their own dirty subset", async () => {
	message("first", 1, [{ category: "user", chars: 1 }]);
	message("second", 2, [{ category: "user", chars: 2 }]);
	database.run(
		"INSERT INTO narrators(id) VALUES ('fork'); INSERT INTO narrator_message_refs SELECT 'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
	);
	await ready();
	await service.get("fork");
	await service.settled();
	await service.invalidateBatch("n", ["first", "second", "first"]);
	await service.settled();
	expect(
		database.query("SELECT context_char_revision AS revision FROM narrators WHERE id='fork'").get(),
	).toEqual({ revision: 1 });
	expect((await service.get("fork")).totalChars).toBe(3);
});

test("freeze during shared-holder fanout cannot pin a not-yet-invalidated fork", async () => {
	message("shared", 1, [{ category: "user", chars: 8 }]);
	database.run(
		"INSERT INTO narrators(id) VALUES ('fork'); INSERT INTO narrator_message_refs SELECT 'fork',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
	);
	await ready();
	await service.get("fork");
	await service.settled();
	const notifying = service.invalidateBatch("n", ["shared"]);
	expect(
		service.freeze(
			"fork",
			{ totalChars: 100, systemChars: 3, toolsChars: 2 },
			"fanout",
			"2026-10-05T00:00:00Z",
		)?.totalChars,
	).toBe(5);
	await notifying;
	await service.settled();
});

test("pending actor overflow converges via bounded cold keyset recovery", async () => {
	for (let i = 0; i < 1030; i++) {
		const id = `overflow-${String(i).padStart(4, "0")}`;
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		await service.invalidate(id);
	}
	await service.settled();
	expect(
		database
			.query(
				"SELECT COUNT(*) AS count FROM narrators WHERE id LIKE 'overflow-%' AND context_char_cache_json IS NOT NULL",
			)
			.get(),
	).toEqual({ count: 1030 });
});

test("cancel tombstone backpressure stops its active overflow round without resurrecting cancelled actors", async () => {
	for (let i = 0; i < 1000; i++) message(`m${i}`, i, [{ category: "user", chars: 1 }]);
	database.run(
		"INSERT INTO narrators(id) VALUES ('busy'); INSERT INTO narrator_message_refs SELECT 'busy',message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
	);
	await service.get("n");
	await service.get("busy");
	await new Promise((resolve) => setTimeout(resolve, 2));
	expect(
		database.query("SELECT context_char_cache_json AS cache FROM narrators WHERE id='busy'").get(),
	).toEqual({ cache: null });
	for (let i = 0; i < 1030; i++) {
		const id = `cancel-overflow-${String(i).padStart(4, "0")}`;
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		await service.invalidate(id);
	}
	for (let i = 0; i < 1025; i++)
		await service.cancel(`cancel-overflow-${String(i).padStart(4, "0")}`);
	await service.settled();
	expect(
		database
			.query(
				"SELECT COUNT(*) AS count FROM narrators WHERE id LIKE 'cancel-overflow-%' AND context_char_cache_json IS NOT NULL",
			)
			.get(),
	).toEqual({ count: 0 });
	expect((await service.get("n")).totalChars).toBe(1000);
	expect((await service.get("busy")).totalChars).toBe(1000);
	// Explicit future invalidation is allowed to recover stale actors after backpressure.
	await service.invalidate("cancel-overflow-0000");
	await service.settled();
	expect((await service.get("cancel-overflow-0000")).pending).toBe(false);
});

test("duplicate cancellation at a full tombstone budget does not terminate overflow recovery", async () => {
	for (let i = 0; i < 1030; i++) {
		const id = `duplicate-cancel-${String(i).padStart(4, "0")}`;
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		await service.invalidate(id);
	}
	for (let i = 0; i < 1024; i++)
		await service.cancel(`duplicate-cancel-${String(i).padStart(4, "0")}`);
	await service.cancel("duplicate-cancel-0000");
	await service.settled();
	expect(
		database
			.query(
				"SELECT COUNT(*) AS count FROM narrators WHERE id LIKE 'duplicate-cancel-%' AND context_char_cache_json IS NOT NULL",
			)
			.get(),
	).toEqual({ count: 6 });
	expect(
		database
			.query(
				"SELECT context_char_cache_json AS cache FROM narrators WHERE id='duplicate-cancel-0000'",
			)
			.get(),
	).toEqual({ cache: null });
});

test("warm primary ignores removal of a linked child compact but detects a new root compact", async () => {
	await service.dispose();
	const metrics: import("../narrator-context-composition").ContextRebuildMetrics[] = [];
	service = createContextCharacterService(database, {
		debounceMs: 0,
		onMetrics: (item) => metrics.push(item),
	});
	message("before", 1, [{ category: "user", chars: 3 }]);
	message("linked-compact", 2, [], "system");
	message("after", 3, [{ category: "assistant", chars: 5 }], "assistant");
	database.run(
		"UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='linked-compact'; UPDATE narrator_messages SET parent_tool_use_id='child-tool' WHERE id='linked-compact'",
	);
	expect((await ready()).totalChars).toBe(8);
	metrics.length = 0;
	database.run("DELETE FROM narrator_message_refs WHERE message_id='linked-compact'");
	await service.invalidateBatch("n", ["linked-compact"]);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(8);
	expect(metrics[0]).toMatchObject({ mode: "incremental", rows: 0 });
	metrics.length = 0;
	message("root-compact", 4, [], "system");
	database.run("UPDATE narrator_message_refs SET is_compact=1 WHERE message_id='root-compact'");
	await service.invalidateBatch("n", ["root-compact"]);
	await service.settled();
	expect((await service.get("n")).totalChars).toBe(0);
	expect(metrics[0].mode).toBe("cold");
});

test("throwing metrics observer cannot break queued jobs, cancellation or settled", async () => {
	await service.dispose();
	service = createContextCharacterService(database, {
		debounceMs: 0,
		onMetrics: () => {
			throw new Error("observer fixture");
		},
	});
	for (const id of ["observer-a", "observer-b", "observer-c"]) {
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		await service.get(id);
	}
	await service.settled();
	for (const id of ["observer-a", "observer-b", "observer-c"])
		expect((await service.get(id)).pending).toBe(false);
	await service.cancel("observer-a");
});

test("global overflow shares one bounded mark sweep and invalidates every shared holder", async () => {
	await service.dispose();
	const markSizes: number[] = [];
	const bounded = new Proxy(database, {
		get(target, key) {
			if (key === "query")
				return (sql: string) => {
					const statement = target.query(sql);
					if (!sql.startsWith("UPDATE narrators SET context_char_revision")) return statement;
					return new Proxy(statement, {
						get(stmt, field) {
							if (field === "run")
								return (...args: unknown[]) => {
									markSizes.push(args.length);
									return Reflect.apply(stmt.run, stmt, args);
								};
							const value = Reflect.get(stmt, field);
							return typeof value === "function" ? value.bind(stmt) : value;
						},
					});
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	service = createContextCharacterService(bounded, { debounceMs: 0 });
	message("shared", 1, [{ category: "user", chars: 1 }]);
	for (let i = 0; i < 130; i++) {
		const id = `holder-${String(i).padStart(3, "0")}`;
		database.query("INSERT INTO narrators(id) VALUES (?)").run(id);
		database
			.query(
				"INSERT INTO narrator_message_refs SELECT ?,message_id,seq,is_compact,segment_compact_id FROM narrator_message_refs WHERE narrator_id='n'",
			)
			.run(id);
	}
	await ready();
	await service.get("holder-000");
	await service.settled();
	database
		.query("UPDATE narrator_messages SET context_chars_json=? WHERE id='shared'")
		.run(JSON.stringify({ segments: [{ category: "user", chars: 9 }] }));
	const sweep = service.invalidateOverflow();
	expect(service.invalidateOverflow()).toBe(sweep);
	expect((await service.get("n")).pending).toBe(true);
	expect(
		service.freeze(
			"holder-000",
			{ totalChars: 100, systemChars: 3, toolsChars: 2 },
			"sweep",
			"2026-10-05T00:00:00Z",
		)?.totalChars,
	).toBe(5);
	await sweep;
	await service.settled();
	expect(markSizes).toEqual([64, 64, 3]);
	expect(
		database
			.query(
				"SELECT MIN(context_char_revision) AS min, MAX(context_char_revision) AS max FROM narrators",
			)
			.get(),
	).toEqual({ min: 1, max: 1 });
	expect((await service.get("n")).totalChars).toBe(9);
	for (const row of database
		.query<{ cache: string }, []>("SELECT context_char_cache_json AS cache FROM narrators")
		.all())
		expect(JSON.parse(row.cache).totalChars).toBe(9);
	await service.invalidateOverflow();
	await service.settled();
	expect(
		database
			.query(
				"SELECT MIN(context_char_revision) AS min, MAX(context_char_revision) AS max FROM narrators",
			)
			.get(),
	).toEqual({ min: 2, max: 2 });
});

test("cancellation backpressure stops global sweep enqueueing but never skips DB epoch marking", async () => {
	for (let i = 0; i < 1100; i++)
		database
			.query("INSERT INTO narrators(id) VALUES (?)")
			.run(`sweep-cancel-${String(i).padStart(4, "0")}`);
	const sweep = service.invalidateOverflow();
	for (let i = 0; i < 1025; i++) await service.cancel(`sweep-cancel-${String(i).padStart(4, "0")}`);
	await sweep;
	await service.settled();
	expect(
		database
			.query(
				"SELECT MIN(context_char_revision) AS min, MAX(context_char_revision) AS max FROM narrators",
			)
			.get(),
	).toEqual({ min: 1, max: 1 });
	expect(
		database
			.query("SELECT COUNT(*) AS count FROM narrators WHERE context_char_cache_json IS NOT NULL")
			.get(),
	).toEqual({ count: 0 });
	await service.invalidate("sweep-cancel-0000");
	await service.settled();
	expect((await service.get("sweep-cancel-0000")).pending).toBe(false);
});

test("dispose stops and awaits a running global mark sweep before closing its SQLite fixture", async () => {
	for (let i = 0; i < 1100; i++)
		database
			.query("INSERT INTO narrators(id) VALUES (?)")
			.run(`dispose-sweep-${String(i).padStart(4, "0")}`);
	const sweep = service.invalidateOverflow();
	for (let attempt = 0; attempt < 100; attempt++) {
		if (
			(database
				.query<{ count: number }, []>(
					"SELECT COUNT(*) AS count FROM narrators WHERE context_char_revision > 0",
				)
				.get()?.count ?? 0) > 0
		)
			break;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	await service.dispose();
	await sweep;
	const marked =
		database
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM narrators WHERE context_char_revision > 0",
			)
			.get()?.count ?? 0;
	expect(marked).toBeGreaterThan(0);
	expect(marked).toBeLessThan(1101);
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(
		database.query("SELECT COUNT(*) AS count FROM narrators WHERE context_char_revision > 0").get(),
	).toEqual({ count: marked });
	await service.settled();
});
