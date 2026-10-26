/**
 * Upgrading straight from a version without block storage (docs/BLOCK_STORAGE-DESIGN.md
 * §10.7): a database migrated only up to the migration before P1, holding legacy
 * envelopes and its envelope index, is started by this version.
 *
 * Before anything is converted, every reader serves the old messages (decoded on read);
 * the background jobs then convert, verify and reindex them without touching what the
 * model reads; and the next start retires the envelope index, after which search still
 * finds the same messages. No intermediate version is involved.
 */

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { applySqliteDataBackfills } from "../../db/data-backfills";
import { ensureColumns } from "../../db/ensure-columns";
import { ensureFts, isEnvelopeIndexRetired } from "../../db/fts";
import * as relations from "../../db/relations";
import { applyPendingMigrationsByHash, runMigrations } from "../../db/run-migrations";
import * as schema from "../../db/schema";

/** The first migration with block storage; the old version stopped before it. */
const FIRST_BLOCK_MIGRATION = "0213_";
const DRIZZLE = join(import.meta.dir, "../../../drizzle");

/** A migrations folder holding only the migrations before `prefix`. */
function migrationsBefore(prefix: string): string {
	const journal = JSON.parse(readFileSync(join(DRIZZLE, "meta/_journal.json"), "utf8")) as {
		entries: Array<{ tag: string }>;
	};
	const cut = journal.entries.findIndex((entry) => entry.tag.startsWith(prefix));
	expect(cut).toBeGreaterThan(0);
	const entries = journal.entries.slice(0, cut);
	const folder = mkdtempSync(join(tmpdir(), "nf-pre-blocks-"));
	mkdirSync(join(folder, "meta"));
	writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
	for (const { tag } of entries)
		writeFileSync(join(folder, `${tag}.sql`), readFileSync(join(DRIZZLE, `${tag}.sql`), "utf8"));
	return folder;
}

const NOW = "2026-01-01T00:00:00.000Z";

/** What an old version stored: content arrays and their ledger, no block rows. */
const LEGACY: Array<{
	id: string;
	role: string;
	origin: string | null;
	content: unknown[];
	text: string;
}> = [
	{
		id: "m1",
		role: "user",
		origin: "user",
		content: [{ type: "text", text: "where are the gooseberries" }],
		text: "where are the gooseberries",
	},
	{
		id: "m2",
		role: "assistant",
		origin: null,
		content: [
			{
				type: "reasoning",
				text: "look in the larder first",
				providerMetadata: { signatureSource: "anthropic", anthropic: { signature: "sig" } },
			},
			{ type: "text", text: "The gooseberries are in the cellar." },
			{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "quince" } },
		],
		text: "The gooseberries are in the cellar.",
	},
	{
		id: "m3",
		role: "user",
		origin: "system",
		content: [{ type: "text", text: "continue" }],
		text: "continue",
	},
	{
		id: "m4",
		role: "sys",
		origin: null,
		content: [
			{ type: "system_injection", source: "bg_agent", modelText: "the damsons job finished" },
		],
		text: "the damsons job finished",
	},
	{
		id: "m5",
		role: "assistant",
		origin: null,
		content: [{ type: "text", text: "Done with the damsons." }],
		text: "Done with the damsons.",
	},
];
const IDS = LEGACY.map((message) => message.id);

const sqlite = new Database(":memory:");
const oldMigrations = migrationsBefore(FIRST_BLOCK_MIGRATION);

// The old version: its schema, its envelope index, its messages.
applyPendingMigrationsByHash(sqlite, oldMigrations);
ensureFts(sqlite, { wasClean: true });
sqlite.run(
	"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'Orchard', ?, ?)",
	[NOW, NOW],
);
for (const [seq, message] of LEGACY.entries()) {
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, origin, content_json, content_text, created_at)
		 VALUES (?, 'n1', ?, ?, ?, ?, ?)`,
		[message.id, message.role, message.origin, JSON.stringify(message.content), message.text, NOW],
	);
	sqlite.run(
		"INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq) VALUES (?, 'n1', ?, ?)",
		[`r${seq}`, message.id, seq],
	);
}
sqlite.run(
	`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, input_json,
		output_json, status, created_at)
	 VALUES ('tc1', 'n1', 'm2', 'toolu_1', 'Grep', ?, ?, 'success', ?)`,
	[JSON.stringify({ pattern: "quince" }), JSON.stringify("jam/quince.md"), NOW],
);

// This version starts on it, as the SQLite lifecycle does.
await runMigrations(sqlite);
ensureColumns(sqlite);
await applySqliteDataBackfills(sqlite);
ensureFts(sqlite, { wasClean: true });

const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const blockSync = await import("../narrator-block-sync");
const backfill = await import("../narrator-block-backfill");
const { runBlockBackfillSlice, runBlockVerifySlice, runBlockReindexSlice } = await import(
	"../../lib/db-worker/block-backfill-query"
);
const { queryModelHistory, sqliteHistoryQuery } = await import(
	"../agent-runtime/model-history-query"
);
const { runDisplayPageQuery } = await import("../../lib/db-worker/display-page-query");
const { toEnvelopes } = await import("../narrator-block-page");
const { createSqliteSearchStore } = await import("../search/sqlite-store");

afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
	rmSync(oldMigrations, { recursive: true, force: true });
});

const inline = {
	backfill: async (params: Parameters<typeof runBlockBackfillSlice>[1]) =>
		runBlockBackfillSlice(sqlite, params),
	verify: async (params: Parameters<typeof runBlockVerifySlice>[1]) =>
		runBlockVerifySlice(sqlite, params),
	reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) =>
		runBlockReindexSlice(sqlite, params),
};

/** Each message's body as the model history reads it, serialized to compare bytes. */
async function modelBodies(): Promise<Record<string, string>> {
	const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
		narratorId: "n1",
		deadline: Date.now() + 10_000,
		versioned: true,
		bodiesFromBlocks: true,
	});
	return Object.fromEntries(
		source.messages.map((row) => [row.id, JSON.stringify(row.contentJson)]),
	);
}

/** The v2 page's blocks: what the frontend renders, without the ids. */
function pageBlocks(): Array<[string, string, string | null, unknown[]]> {
	const page = runDisplayPageQuery(sqlite, {
		kind: "displayPageMessages",
		messageIds: IDS,
		ioBudget: 1000,
		deadlineAt: Date.now() + 10_000,
		bodiesFromBlocks: true,
	});
	return toEnvelopes(page.messages).blocks.map((block) => [
		block.messageId,
		block.kind,
		block.subtype,
		block.elements,
	]);
}

/** The message ids a global index search for each term finds, in the current search mode. */
async function searchHits(terms: string[]): Promise<Record<string, string[]>> {
	const store = createSqliteSearchStore(async (sql, params) =>
		sqlite.prepare<Record<string, unknown>, typeof params>(sql).all(...params),
	);
	const hits: Record<string, string[]> = {};
	for (const term of terms) {
		const rows = await store.searchMessages({
			text: term,
			strategy: "index",
			limit: 20,
			viewer: { userId: "admin", isAdmin: true },
		});
		hits[term] = rows.map((row) => row.id).sort();
	}
	return hits;
}

const formats = () =>
	(
		sqlite
			.prepare("SELECT DISTINCT body_format AS f FROM narrator_messages ORDER BY f")
			.all() as Array<{ f: number }>
	).map((row) => row.f);
const historyRevision = () =>
	(
		sqlite.prepare("SELECT model_history_revision AS n FROM narrators WHERE id = 'n1'").get() as {
			n: number;
		}
	).n;
const TERMS = ["gooseberries", "cellar", "damsons", "continue"];

describe("a database from before block storage, upgraded directly", () => {
	let modelBefore: Record<string, string>;
	let pageBefore: ReturnType<typeof pageBlocks>;
	let hitsBefore: Record<string, string[]>;
	let revisionBefore: number;

	test("is usable at once: every reader serves the old messages, decoded on read", async () => {
		expect(formats()).toEqual([1]);
		expect(isEnvelopeIndexRetired()).toBe(false);

		modelBefore = await modelBodies();
		expect(modelBefore).toEqual(
			Object.fromEntries(LEGACY.map((message) => [message.id, JSON.stringify(message.content)])),
		);

		pageBefore = pageBlocks();
		expect(pageBefore.map(([messageId, kind, subtype]) => [messageId, kind, subtype])).toEqual([
			["m1", "input", null],
			["m2", "reasoning", null],
			["m2", "output", null],
			["m2", "tool", "Grep"],
			["m3", "context", "system_text"],
			["m4", "context", "system_injection"],
			["m5", "output", null],
		]);

		hitsBefore = await searchHits(TERMS);
		expect(hitsBefore).toEqual({
			gooseberries: ["m1", "m2"],
			cellar: ["m2"],
			damsons: ["m4", "m5"],
			continue: ["m3"],
		});
		revisionBefore = historyRevision();
	});

	test("the background jobs convert, verify and reindex it without moving what the model reads", async () => {
		let slices = 0;
		while (await backfill.runBlockJobSlice(inline)) slices++;
		expect(slices).toBeGreaterThan(0);
		const status = backfill.blockBackfillStatus();
		expect([status.convert?.complete, status.verify?.complete, status.reindex?.complete]).toEqual([
			true,
			true,
			true,
		]);
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_diagnostics").get()).toEqual({
			n: 0,
		});
		expect(formats()).toEqual([2]);
		expect(await modelBodies()).toEqual(modelBefore);
		expect(historyRevision()).toBe(revisionBefore);
		expect(pageBlocks()).toEqual(pageBefore);
		// Retirement waits for the next start.
		expect(isEnvelopeIndexRetired()).toBe(false);
		expect(await searchHits(TERMS)).toEqual(hitsBefore);
	});

	test("the next start retires the envelope index; search finds the same messages in blocks", async () => {
		ensureFts(sqlite, { wasClean: true });
		expect(isEnvelopeIndexRetired()).toBe(true);
		expect(
			sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'narrator_messages_fts'").get(),
		).toBeNull();
		expect(await searchHits(TERMS)).toEqual(hitsBefore);
		expect(await modelBodies()).toEqual(modelBefore);
		expect(pageBlocks()).toEqual(pageBefore);
	});
});
