/**
 * Readers of message bodies with block reads on (docs/BLOCK_STORAGE-DESIGN.md §10.1, P2):
 * a block-format envelope's body comes from its block rows, and reads exactly as its
 * `content_json` did; an envelope whose rows are not current still reads `content_json`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const { queryModelHistory, sqliteHistoryQuery } = await import(
	"../agent-runtime/model-history-query"
);
const { queryModelHistoryDelta } = await import("../agent-runtime/model-history-delta");
const { runDisplayPageQuery } = await import("../../lib/db-worker/display-page-query");
const { readBodies, bodySql } = await import("../../lib/narrator-bodies");

const NOW = "2026-10-01T00:00:00.000Z";

async function conversation(): Promise<string[]> {
	const input = await narratorStore.appendInput("n1", "list the files");
	const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
	await narratorStore.writeStepItem(step.id, "n1", {
		type: "reasoning",
		id: "r1",
		text: "thinking",
		completed: true,
		outputIndex: 0,
	});
	const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
		type: "tool_use",
		id: "c1",
		name: "Bash",
		input: { command: "ls" },
		outputIndex: 1,
	});
	await narratorStore.settleTool("c1", { output: "a.txt", status: "success" }, step.id, toolCallId);
	return [input.id, step.id];
}

async function modelBodies(fromBlocks: boolean): Promise<Map<string, unknown>> {
	const source = await queryModelHistory(sqliteHistoryQuery(sqlite), {
		narratorId: "n1",
		versioned: true,
		bodiesFromBlocks: fromBlocks,
	});
	return new Map(source.messages.map((row) => [row.id, row.contentJson]));
}

async function deltaBodies(fromBlocks: boolean): Promise<Map<string, unknown>> {
	const bodies = new Map<string, unknown>();
	await queryModelHistoryDelta(
		sqliteHistoryQuery(sqlite),
		{
			narratorId: "n1",
			versioned: true,
			bodiesFromBlocks: fromBlocks,
		},
		{ compactSeq: null, messages: [] },
		async (message) => {
			const page = message as { type: string; rows?: Array<{ id: string; contentJson: unknown }> };
			if (page.type === "page")
				for (const row of page.rows ?? []) bodies.set(row.id, row.contentJson);
		},
	);
	return bodies;
}

function displayBodies(ids: string[], fromBlocks: boolean): Map<string, unknown> {
	const page = runDisplayPageQuery(sqlite, {
		kind: "displayPageMessages",
		messageIds: ids,
		ioBudget: 1000,
		deadlineAt: Date.now() + 10_000,
		bodiesFromBlocks: fromBlocks,
	});
	return new Map(page.messages.map((message) => [message.id, message.contentJson]));
}

function stored(id: string): unknown {
	const row = sqlite
		.prepare("SELECT content_json AS json FROM narrator_messages WHERE id = ?")
		.get(id) as { json: string };
	return JSON.parse(row.json);
}

/** Make an input's block row say something `content_json` does not, to see which is read. */
function driftBlocks(id: string): void {
	sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ? AND kind = 'input'", [
		JSON.stringify({ raw: [{ type: "text", text: "from blocks" }] }),
		id,
	]);
}

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
	settings.narratorBlocks.write = true;
});
afterAll(() => {
	settings.narratorBlocks.write = true;
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("block body reads", () => {
	test("every reader returns the same bodies from blocks as from content_json", async () => {
		const ids = await conversation();
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
		const formats = sqlite
			.prepare("SELECT DISTINCT body_format AS f FROM narrator_messages WHERE narrator_id = 'n1'")
			.all();
		expect(formats).toEqual([{ f: 2 }]);

		const expected = new Map(ids.map((id) => [id, stored(id)]));
		expect(await modelBodies(true)).toEqual(expected);
		expect(await modelBodies(false)).toEqual(expected);
		expect(await deltaBodies(true)).toEqual(expected);
		expect(await deltaBodies(false)).toEqual(expected);
		expect(displayBodies(ids, true)).toEqual(displayBodies(ids, false));
		const rows = sqlite
			.prepare(`SELECT m.id, ${bodySql("m", true)} AS body FROM narrator_messages m`)
			.all() as Array<{ id: string; body: string | null }>;
		expect(rows.every((row) => row.body === null)).toBe(true);
		expect(readBodies(sqlite, rows)).toEqual(expected);
	});

	test("with reads on, a block-format envelope's body comes from its rows", async () => {
		const [inputId] = await conversation();
		driftBlocks(inputId);
		const fromBlocks = [{ type: "text", text: "from blocks" }];
		expect((await modelBodies(true)).get(inputId)).toEqual(fromBlocks);
		expect((await deltaBodies(true)).get(inputId)).toEqual(fromBlocks);
		expect(displayBodies([inputId], true).get(inputId)).toEqual(fromBlocks);
		// Reads off: content_json, as before P2.
		expect((await modelBodies(false)).get(inputId)).toEqual(stored(inputId));
		expect(displayBodies([inputId], false).get(inputId)).toEqual(stored(inputId));
	});

	test("an envelope whose rows wait in the sync queue reads content_json", async () => {
		const [inputId] = await conversation();
		driftBlocks(inputId);
		sqlite.run("INSERT INTO narrator_block_sync_queue (message_id) VALUES (?)", [inputId]);
		expect((await modelBodies(true)).get(inputId)).toEqual(stored(inputId));
		expect((await deltaBodies(true)).get(inputId)).toEqual(stored(inputId));
		expect(displayBodies([inputId], true).get(inputId)).toEqual(stored(inputId));
	});

	test("legacy envelopes read content_json", async () => {
		settings.narratorBlocks.write = false;
		const ids = await conversation();
		settings.narratorBlocks.write = true;
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_blocks").get()).toEqual({ n: 0 });
		const expected = new Map(ids.map((id) => [id, stored(id)]));
		expect(await modelBodies(true)).toEqual(expected);
		expect(displayBodies(ids, true)).toEqual(displayBodies(ids, false));
	});
});
