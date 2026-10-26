/**
 * Search once the envelope index has retired (docs/BLOCK_STORAGE-DESIGN.md §4.6, P3c): every
 * index path reads the block index, legacy envelopes (no blocks yet) are matched on their
 * text, and excerpts come from the message text or, where only a block matched, the block.
 *
 * The envelope index and its triggers are dropped here, so a path that still read it would
 * fail outright rather than quietly return its rows.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../../tests/setup";
import type { EntitySearchQuery } from "../types";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../../db")) };
mock.module("../../../db", () => ({
	...realDbModule,
	db,
	sqlite,
	activeDatabaseBackend: "sqlite",
}));

const { ensureFts } = await import("../../../db/fts");
ensureFts(sqlite, { skipUncleanShutdownRebuild: true });

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../../narrator-service");
const { narratorStore } = await import("../../narrator-store");
const blockSync = await import("../../narrator-block-sync");
const blockIndex = await import("../../narrator-block-index");
const { createSqliteSearchStore } = await import("../sqlite-store");
const store = createSqliteSearchStore(
	async (sql, params) => sqlite.prepare<Record<string, unknown>, typeof params>(sql).all(...params),
	{ blockOnly: () => true },
);

const NOW = "2026-10-01T00:00:00.000Z";
const ADMIN = { userId: "u1", isAdmin: true };
const ids: Record<string, string> = {};

beforeAll(async () => {
	sqlite.run(
		"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'Gardening', ?, ?)",
		[NOW, NOW],
	);
	sqlite.run(
		"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n2', 'Other', ?, ?)",
		[NOW, NOW],
	);
	ids.input = (await narratorStore.appendInput("n1", "how do tomatoes ripen indoors")).id;
	const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
	ids.step = step.id;
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "text",
		id: "t1",
		text: "Tomatoes ripen faster near bananas.",
		completed: true,
		outputIndex: 0,
	});
	const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
		type: "tool_use",
		id: "c1",
		name: "Grep",
		input: { pattern: "aubergine" },
		outputIndex: 1,
	});
	await narratorStore.settleTool(
		"c1",
		{ output: "notes/aubergine.md", status: "success" },
		step.id,
		toolCallId,
	);
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "text",
		id: "t2",
		text: "Keep them on the windowsill.",
		completed: true,
		outputIndex: 2,
	});
	blockSync.flushChangedEnvelopes();
	// The store queues the blocks' search text; the index job writes it.
	await blockIndex.drainBlockIndexQueue();
	// A legacy envelope: no blocks, only its text (an import the backfill has not converted).
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, content_text, created_at)
		 VALUES ('legacy', 'n2', 'user', '[]', 'tomatoes from the old archive', ?)`,
		[NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES ('rl', 'n2', 'legacy', 0)",
	);
	// What retirement leaves: no envelope index and nothing writing to it.
	for (const trigger of ["insert", "update", "delete"])
		sqlite.run(`DROP TRIGGER IF EXISTS narrator_messages_fts_${trigger}`);
	sqlite.run("DROP TABLE narrator_messages_fts");
});

afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../../db", () => realDbModule);
	sqlite.close();
});

function query(text: string, extra: Partial<EntitySearchQuery> = {}): EntitySearchQuery {
	return { text, strategy: "index", limit: 20, viewer: ADMIN, ...extra };
}

const blockOf = (messageId: string, kind: string, ordinal = 0) =>
	(
		sqlite
			.prepare(
				`SELECT id FROM narrator_blocks WHERE message_id = ? AND kind = ? ORDER BY ordinal LIMIT 1 OFFSET ?`,
			)
			.get(messageId, kind, ordinal) as { id: string }
	).id;

describe("global message search", () => {
	test("finds a message through its block, naming the block and excerpting the text", async () => {
		const rows = await store.searchMessages(query("bananas"));
		expect(rows.map((row) => [row.id, row.blockId])).toEqual([
			[ids.step, blockOf(ids.step, "output")],
		]);
		expect(rows[0].snippet).toContain("near bananas");
		expect(rows[0].rank).toBeLessThan(0);
	});

	test("a term only a tool holds is found there, excerpted from the tool", async () => {
		const [row] = await store.searchMessages(query("aubergine"));
		expect(row.id).toBe(ids.step);
		expect(row.blockId).toBe(blockOf(ids.step, "tool"));
		expect(row.snippet).toContain("aubergine");
	});

	test("legacy envelopes are matched on their text, after ranked hits", async () => {
		const rows = await store.searchMessages(query("tomatoes"));
		expect(rows.map((row) => row.id)).toEqual(
			[ids.input, ids.step, "legacy"].sort((a, b) =>
				a === "legacy" ? 1 : b === "legacy" ? -1 : 0,
			),
		);
		const legacy = rows.find((row) => row.id === "legacy");
		expect(legacy?.blockId).toBeUndefined();
		expect(legacy?.rank).toBe(0);
		expect(legacy?.snippet).toBe("tomatoes from the old archive");
	});

	test("every indexed term must be in one block; short terms filter the message text", async () => {
		// "bananas" and "windowsill" are in two text blocks of the same step.
		expect(await store.searchMessages(query("bananas windowsill"))).toEqual([]);
		expect((await store.searchMessages(query("bananas near"))).map((row) => row.id)).toEqual([
			ids.step,
		]);
		const short = await store.searchMessages(query("ripen ho"));
		expect(short.map((row) => row.id).sort()).toEqual([ids.input].sort());
	});

	test("the time sort and the substring path still work", async () => {
		const byTime = await store.searchMessages(query("tomatoes", { sort: "time" }));
		expect(byTime).toHaveLength(3);
		const substring = await store.searchMessages(query("ripen", { strategy: "substring" }));
		expect(substring.map((row) => row.id).sort()).toEqual([ids.input, ids.step].sort());
	});
});

describe("session search", () => {
	test("aggregates count each message once and hits carry their block", async () => {
		const aggregates = await store.searchSessionAggregates(query("tomatoes"));
		expect(aggregates.map((row) => [row.narratorId, row.hitCount]).sort()).toEqual([
			["n1", 2],
			["n2", 1],
		]);
		const hits = await store.searchSessionHits({
			...query("aubergine"),
			narratorIds: ["n1"],
			perSession: 5,
		});
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({
			id: ids.step,
			blockId: blockOf(ids.step, "tool"),
			toolUseId: "c1",
			toolName: "Grep",
		});
		expect(hits[0].snippet).toContain("aubergine");
	});
});

describe("timeline and Recall", () => {
	test("the timeline finds the narrator's own messages with a block and an excerpt", async () => {
		const rows = await store.searchTimeline({
			narratorId: "n1",
			text: "tomatoes",
			strategy: "index",
			limit: 10,
			inheritedScopes: [],
		});
		expect(rows.map((row) => row.messageId)).toEqual([ids.step, ids.input]);
		expect(rows[0].blockId).toBe(blockOf(ids.step, "output"));
		expect(rows[1].snippet).toContain("tomatoes ripen");
	});

	test("Recall marks the match, globally and within one narrator", async () => {
		const global = await store.searchRecallMessages({
			text: "bananas",
			strategy: "index",
			limit: 10,
			narratorId: null,
			previewChars: 200,
		});
		expect(global.map((row) => row.messageId)).toEqual([ids.step]);
		expect(global[0].snippet).toContain(">>>bananas<<<");
		const scoped = await store.searchRecallMessages({
			text: "tomatoes",
			strategy: "index",
			limit: 10,
			narratorId: "n2",
			previewChars: 200,
		});
		expect(scoped.map((row) => [row.messageId, row.narratorId])).toEqual([["legacy", "n2"]]);
		expect(scoped[0].snippet).toBe(">>>tomatoes<<< from the old archive");
	});
});
