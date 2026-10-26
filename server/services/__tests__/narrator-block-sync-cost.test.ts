/**
 * What a block sync costs (docs/BLOCK_STORAGE-DESIGN.md §4.6, §5): a ledger change
 * re-derives only the tool blocks whose attempt moved, a write syncs only what it queued,
 * and search text is written by the index job, not the writer.
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
const blockIndex = await import("../narrator-block-index");
const { runBlockIndexQueueSlice } = await import("../../lib/db-worker/block-backfill-query");
const { ensureFts } = await import("../../db/fts");

const NOW = "2026-10-01T00:00:00.000Z";
ensureFts(sqlite, { wasClean: true });

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("DELETE FROM narrator_blocks_fts");
	blockIndex.resetBlockIndexForTests();
	for (const id of ["n1", "n2"])
		sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
			id,
			`Narrator ${id}`,
			NOW,
			NOW,
		]);
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	settings.narratorBlocks.compactJson = false;
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

/** Every column the sync writes, of every block, assets and ledger bindings included. */
function snapshot(messageId: string) {
	return {
		blocks: sqlite
			.prepare(
				`SELECT id, ordinal, kind, subtype, phase, revision, wire_id, model_chars, byte_size,
					completed_at, model_text, payload, state, ledger_revision
				 FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal`,
			)
			.all(messageId),
		assets: sqlite
			.prepare(
				`SELECT a.block_id, a.asset_id, a.role FROM narrator_block_assets a
				 JOIN narrator_blocks b ON b.id = a.block_id WHERE b.message_id = ?
				 ORDER BY a.block_id, a.asset_id`,
			)
			.all(messageId),
		ledger: sqlite
			.prepare("SELECT id, block_id FROM narrator_tool_calls WHERE message_id = ? ORDER BY id")
			.all(messageId),
	};
}

const owed = () =>
	(
		sqlite
			.prepare("SELECT block_id AS id FROM narrator_block_index_queue ORDER BY block_id")
			.all() as Array<{ id: string }>
	).map((row) => row.id);

const queued = () =>
	(
		sqlite
			.prepare("SELECT message_id AS id FROM narrator_block_sync_queue ORDER BY message_id")
			.all() as Array<{ id: string }>
	).map((row) => row.id);

const toolBlock = (messageId: string, wireId: string) =>
	(
		sqlite
			.prepare("SELECT id FROM narrator_blocks WHERE message_id = ? AND wire_id = ?")
			.get(messageId, wireId) as { id: string }
	).id;

const indexed = (term: string) =>
	(
		sqlite
			.prepare(
				`SELECT b.id FROM narrator_blocks_fts JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
				 WHERE narrator_blocks_fts MATCH ? ORDER BY b.id`,
			)
			.all(`"${term}"`) as Array<{ id: string }>
	).map((row) => row.id);

/** A step with `count` parallel tool calls, none settled yet. */
async function parallelTools(count: number, narratorId = "n1") {
	const step = await narratorStore.openStep(narratorId, { uuid: "u", session_id: "s" });
	await narratorStore.writeStepItem(step.id, narratorId, {
		type: "text",
		id: "t1",
		text: "Looking at the orchard.",
		completed: true,
		outputIndex: 0,
	});
	const calls: Array<{ toolUseId: string; toolCallId: string | undefined }> = [];
	for (let i = 0; i < count; i++) {
		const toolUseId = `c${i}`;
		const toolCallId = await narratorStore.writeStepItem(step.id, narratorId, {
			type: "tool_use",
			id: toolUseId,
			name: "Read",
			input: { file_path: `/orchard/tree-${i}.md` },
			outputIndex: i + 1,
		});
		calls.push({ toolUseId, toolCallId });
	}
	return { stepId: step.id, calls };
}

describe("a ledger change re-derives only the tool blocks whose attempt moved", () => {
	test("settling one tool queues only its block's search text", async () => {
		const { stepId, calls } = await parallelTools(4);
		await blockIndex.drainBlockIndexQueue();
		expect(owed()).toEqual([]);
		for (const [i, call] of calls.entries()) {
			await narratorStore.settleTool(
				call.toolUseId,
				{ output: `pear variety ${i}`, status: "success" },
				stepId,
				call.toolCallId,
			);
			expect(owed()).toEqual([toolBlock(stepId, call.toolUseId)]);
			await blockIndex.drainBlockIndexQueue();
		}
		expect(queued()).toEqual([]);
		for (let i = 0; i < calls.length; i++) expect(indexed(`variety ${i}`)).toHaveLength(1);
	});

	test("what the ledger pass derives is what a full sync derives", async () => {
		const { stepId, calls } = await parallelTools(3);
		await narratorStore.settleTool(
			"c0",
			{
				output: {
					_text: "a picture of the orchard",
					_images: [{ imageId: "img-1", mediaType: "image/png", uploadNarratorId: "n1" }],
				},
				status: "success",
			},
			stepId,
			calls[0].toolCallId,
		);
		await narratorStore.settleTool(
			"c1",
			{ output: { _text: "bad input", _broken: true }, status: "fail" },
			stepId,
			calls[1].toolCallId,
		);
		// c2 is still running.
		const viaLedger = snapshot(stepId);
		expect(viaLedger.blocks.map((block) => (block as { phase: string }).phase)).toEqual([
			"done",
			"done",
			"failed",
			"open",
		]);
		expect(viaLedger.assets).toEqual([
			{ block_id: toolBlock(stepId, "c0"), asset_id: "img-1", role: "tool_image" },
		]);
		// Rebuilt from scratch, block by block, through the whole envelope.
		sqlite.transaction(() => blockSync.syncEnvelopeNow(stepId))();
		expect(snapshot(stepId)).toEqual(viaLedger);
	});

	test("a settle reads no other block: the rows are taken as the content they were built from", async () => {
		const { stepId, calls } = await parallelTools(2);
		const column = (
			sqlite
				.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
				.get(stepId) as {
				c: string;
			}
		).c;
		expect(
			(
				sqlite
					.prepare("SELECT blocks_content_hash AS h FROM narrator_messages WHERE id = ?")
					.get(stepId) as { h: string }
			).h,
		).toBe(blockSync.contentHash(column));
		// A row a full sync would rebuild from the column; the ledger pass never reads it.
		sqlite.run(
			"UPDATE narrator_blocks SET model_chars = 999 WHERE message_id = ? AND kind = 'output'",
			[stepId],
		);
		await narratorStore.settleTool(
			"c0",
			{ output: "sloe", status: "success" },
			stepId,
			calls[0].toolCallId,
		);
		const output = sqlite
			.prepare(
				"SELECT model_chars AS chars FROM narrator_blocks WHERE message_id = ? AND kind = 'output'",
			)
			.get(stepId) as { chars: number };
		expect(output.chars).toBe(999);
		// A full sync does rebuild it.
		sqlite.transaction(() => blockSync.syncEnvelopeNow(stepId))();
		expect(
			(
				sqlite
					.prepare(
						"SELECT model_chars AS chars FROM narrator_blocks WHERE message_id = ? AND kind = 'output'",
					)
					.get(stepId) as { chars: number }
			).chars,
		).toBe("Looking at the orchard.".length);
	});

	test("a ledger write outside the store is re-derived by its queued sync, content unread", async () => {
		const { stepId, calls } = await parallelTools(2);
		await blockIndex.drainBlockIndexQueue();
		sqlite.run("UPDATE narrator_tool_calls SET status = 'success', output_json = ? WHERE id = ?", [
			JSON.stringify("quince jelly"),
			calls[1].toolCallId ?? "",
		]);
		expect(queued()).toEqual([stepId]);
		blockSync.flushChangedEnvelopes();
		expect(queued()).toEqual([]);
		expect(owed()).toEqual([toolBlock(stepId, "c1")]);
		const before = snapshot(stepId);
		sqlite.transaction(() => blockSync.syncEnvelopeNow(stepId))();
		expect(snapshot(stepId)).toEqual(before);
	});

	test("a content write outside the store is a full sync", async () => {
		const { stepId } = await parallelTools(1);
		const content = JSON.parse(
			(
				sqlite
					.prepare("SELECT content_json AS c FROM narrator_messages WHERE id = ?")
					.get(stepId) as {
					c: string;
				}
			).c,
		) as Array<Record<string, unknown>>;
		content[0] = { ...content[0], text: "Looking at the vineyard." };
		sqlite.run("UPDATE narrator_messages SET content_json = ? WHERE id = ?", [
			JSON.stringify(content),
			stepId,
		]);
		blockSync.flushChangedEnvelopes();
		const output = sqlite
			.prepare("SELECT payload FROM narrator_blocks WHERE message_id = ? AND kind = 'output'")
			.get(stepId) as { payload: string };
		expect(output.payload).toContain("vineyard");
	});

	test("rows-only envelopes take the ledger pass too", async () => {
		settings.narratorBlocks.compactJson = true;
		try {
			const { stepId, calls } = await parallelTools(2);
			expect(
				(
					sqlite
						.prepare("SELECT body_rows_only AS r FROM narrator_messages WHERE id = ?")
						.get(stepId) as { r: number }
				).r,
			).toBe(1);
			await narratorStore.settleTool(
				"c0",
				{ output: "medlar", status: "success" },
				stepId,
				calls[0].toolCallId,
			);
			const viaLedger = snapshot(stepId);
			sqlite.transaction(() => blockSync.syncEnvelopeNow(stepId))();
			expect(snapshot(stepId)).toEqual(viaLedger);
		} finally {
			settings.narratorBlocks.compactJson = false;
		}
	});
});

describe("a write syncs only what it queued", () => {
	test("another narrator's backlog stays for the sweep", async () => {
		const { stepId, calls } = await parallelTools(1);
		// A ledger write outside the store, as the permission flow makes.
		sqlite.run("UPDATE narrator_tool_calls SET status = 'running' WHERE id = ?", [
			calls[0].toolCallId ?? "",
		]);
		expect(queued()).toEqual([stepId]);
		const input = await narratorStore.appendInput("n2", "unrelated");
		expect(queued()).toEqual([stepId]);
		expect(
			sqlite.prepare("SELECT 1 FROM narrator_blocks WHERE message_id = ?").get(input.id),
		).toBeTruthy();
		blockSync.flushChangedEnvelopes();
		expect(queued()).toEqual([]);
	});
});

describe("the index job", () => {
	test("text read before a re-queue is not written over it", async () => {
		const { stepId, calls } = await parallelTools(1);
		await narratorStore.settleTool(
			"c0",
			{ output: "damson", status: "success" },
			stepId,
			calls[0].toolCallId,
		);
		let raced = false;
		const written = await blockIndex.drainBlockIndexQueue(async (params) => {
			const slice = runBlockIndexQueueSlice(sqlite, params);
			if (!raced) {
				raced = true;
				// Changed after the read: the store queues the block again.
				sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE tool_use_id = 'c0'", [
					JSON.stringify("greengage"),
				]);
				blockSync.flushChangedEnvelopes();
			}
			return slice;
		});
		expect(written).toBeGreaterThan(0);
		await blockIndex.drainBlockIndexQueue();
		expect(indexed("greengage")).toHaveLength(1);
		expect(indexed("damson")).toEqual([]);
		expect(owed()).toEqual([]);
	});

	test("started by a write, it writes what is owed in paced slices", async () => {
		const { stepId, calls } = await parallelTools(3);
		blockIndex.setBlockIndexAutoRunForTests(true);
		try {
			for (const [i, call] of calls.entries())
				await narratorStore.settleTool(
					call.toolUseId,
					{ output: `cherry ${i}`, status: "success" },
					stepId,
					call.toolCallId,
				);
			const deadline = Date.now() + 5_000;
			while (owed().length && Date.now() < deadline)
				await new Promise((resolve) => setTimeout(resolve, 50));
		} finally {
			blockIndex.setBlockIndexAutoRunForTests(false);
		}
		expect(owed()).toEqual([]);
		for (let i = 0; i < calls.length; i++) expect(indexed(`cherry ${i}`)).toHaveLength(1);
	});

	test("a block that streams again owes no text", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "t1",
			text: "Plum",
			completed: true,
			outputIndex: 0,
		});
		expect(owed()).toHaveLength(1);
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "t1",
			text: "Plums and",
			completed: false,
			outputIndex: 0,
		});
		expect(owed()).toEqual([]);
	});
});
