/**
 * Block hits merged into message search (docs/BLOCK_STORAGE-DESIGN.md §4.6): while both indexes
 * are live, an envelope hit gains the block the match is in, and a message only its blocks
 * match (a tool's input or result) is found too. Substring matches and envelopes without
 * blocks are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { FULL_MESSAGE_SCOPE } from "../../../server/services/search/types";
import { getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();
mock.module("../../../server/db", () => ({ db, sqlite, activeDatabaseBackend: "sqlite" }));

const { createSqliteSearchStore } = await import("../../../server/services/search/sqlite-store");
const searchStore = createSqliteSearchStore(async (sql, params) =>
	sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(sql).all(...params),
);
mock.module("../../../server/services/search/backend", () => ({ searchStore }));

const { ensureFts, replaceBlockIndexText } = await import("../../../server/db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

const { clearSessionSearchCache, searchService } = await import(
	"../../../server/services/search-service"
);

const NOW = "2026-10-22T00:00:00.000Z";
const ADMIN = { userId: "block-search-admin", isAdmin: true };

function envelope(id: string, seq: number, bodyFormat: 1 | 2, contentText: string) {
	sqlite.run(
		"INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, body_format, created_at) VALUES (?, 'n1', 'assistant', '[]', ?, ?, ?)",
		[id, contentText, bodyFormat, `2026-10-22T00:00:0${seq}.000Z`],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'n1', ?, ?)",
		[`ref-${id}`, id, seq],
	);
}

function block(
	id: string,
	messageId: string,
	ordinal: number,
	kind: "output" | "tool",
	text: string,
) {
	sqlite.run(
		"INSERT INTO narrator_blocks (id, message_id, ordinal, kind, subtype, phase, wire_id, payload, created_at) VALUES (?, ?, ?, ?, ?, 'done', ?, '{}', ?)",
		[
			id,
			messageId,
			ordinal,
			kind,
			kind === "tool" ? "Read" : null,
			kind === "tool" ? `call-${id}` : null,
			NOW,
		],
	);
	replaceBlockIndexText(sqlite, id, text);
}

beforeEach(() => {
	sqlite.exec(`
		INSERT INTO projects (id, name, git_path, created_at, updated_at)
		VALUES ('p1', 'Proj', '/tmp/repo', '${NOW}', '${NOW}');
		INSERT INTO narrators (id, context_project_id, type, inherit_mode, created_at, updated_at)
		VALUES ('n1', 'p1', 'primary', 'fresh', '${NOW}', '${NOW}');
	`);
	envelope("legacy", 1, 1, "zebra crossing in a legacy body");
	envelope("native", 2, 2, "zebra crossing in the answer");
	block("native-reasoning", "native", 0, "output", "thinking it over");
	block("native-output", "native", 1, "output", "zebra crossing in the answer");
	envelope("tooling", 3, 2, "");
	block("tooling-call", "tooling", 0, "tool", 'Read\n{"path":"giraffe.ts"}\nexport const giraffe');
});

afterEach(() => {
	clearSessionSearchCache();
	sqlite.run("PRAGMA foreign_keys = OFF");
	for (const table of [
		"narrator_tool_calls",
		"narrator_block_sync_queue",
		"narrator_blocks",
		"narrator_message_refs",
		"narrator_messages",
		"narrators",
		"projects",
	])
		sqlite.run(`DELETE FROM "${table}"`);
	sqlite.run("PRAGMA foreign_keys = ON");
});

/**
 * Every matching message, across all content kinds. Global search groups hits per narrator,
 * so the messages are read from each group's `hits`, best first.
 */
async function messageHits(query: string, sort?: "time" | "relevance") {
	const groups = await searchService.search({
		query,
		entities: ["messages"],
		principal: ADMIN,
		sort,
		scope: FULL_MESSAGE_SCOPE,
	});
	return groups.flatMap((group) =>
		(group.hits ?? []).map((hit) => ({ id: hit.id, blockId: hit.blockId })),
	);
}

describe("global message search with block hits", () => {
	it("names the block of an envelope hit and leaves legacy hits as they were", async () => {
		const hits = await messageHits("zebra crossing", "time");
		expect(hits).toEqual([
			{ id: "native", blockId: "native-output" },
			{ id: "legacy", blockId: undefined },
		]);
	});

	it("finds a message only its blocks match", async () => {
		expect(await messageHits("giraffe")).toEqual([{ id: "tooling", blockId: "tooling-call" }]);
	});

	it("excerpts a tool-only hit from the tool's stored output and names the tool call", async () => {
		sqlite.run(
			`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, output_json, block_id, created_at)
			 VALUES ('tc1', 'n1', 'tooling', 'call-tooling-call', 'Read', ?, 'tooling-call', ?)`,
			[JSON.stringify({ text: 'line one\nexport const giraffe = "tall"' }), NOW],
		);
		const [group] = await searchService.search({
			query: "giraffe",
			entities: ["messages"],
			principal: ADMIN,
			scope: FULL_MESSAGE_SCOPE,
		});
		expect(group?.id).toBe("tooling");
		const sections = await searchService.searchSections({
			query: "giraffe",
			sections: ["sessions"],
			principal: ADMIN,
			limits: { sessions: 10 },
			scope: FULL_MESSAGE_SCOPE,
			fullHistory: true,
		});
		const hit = sections.sessions?.items[0]?.hits[0];
		expect(hit).toMatchObject({ id: "tooling", toolUseId: "call-tooling-call", toolName: "Read" });
		// Read back from the stored JSON with its escapes undone, not the empty message text.
		expect(hit?.snippet).toContain('export const giraffe = "tall"');
		expect(hit?.snippet).not.toContain("\\n");
	});

	it("skips block-only hits when a term is too short for the index to check", async () => {
		// The block index is contentless, so "长颈" (two characters, no trigram) cannot be
		// verified against the tool block; the hit is dropped rather than returned unchecked.
		expect(await messageHits("giraffe")).toEqual([{ id: "tooling", blockId: "tooling-call" }]);
		expect(await messageHits("giraffe 长颈")).toEqual([]);
	});

	it("leaves substring matches without a block", async () => {
		expect(await messageHits("ze", "time")).toEqual([
			{ id: "native", blockId: undefined },
			{ id: "legacy", blockId: undefined },
		]);
	});
});

describe("timeline search with block hits", () => {
	it("merges in timeline order and names each hit's first matching block", async () => {
		block("native-tail", "native", 2, "output", "a second zebra crossing");
		const hits = await searchService.searchNarratorMessages("n1", "zebra");
		expect(hits.map((hit) => [hit.seq, hit.messageId, hit.blockId])).toEqual([
			[2, "native", "native-output"],
			[1, "legacy", undefined],
		]);
		const tool = await searchService.searchNarratorMessages("n1", "giraffe");
		expect(tool.map((hit) => [hit.seq, hit.messageId, hit.blockId, hit.snippet])).toEqual([
			[3, "tooling", "tooling-call", ""],
		]);
	});

	it("keeps the limit across both indexes", async () => {
		expect(
			(await searchService.searchNarratorMessages("n1", "crossing", 1)).map((hit) => hit.messageId),
		).toEqual(["native"]);
	});

	it("drops a deleted block's text with it", async () => {
		sqlite.run("DELETE FROM narrator_message_refs WHERE message_id = 'tooling'");
		// Its blocks go by ON DELETE CASCADE.
		sqlite.run("DELETE FROM narrator_messages WHERE id = 'tooling'");
		expect(await searchService.searchNarratorMessages("n1", "giraffe")).toEqual([]);
	});
});
