/**
 * The block backfill (docs/BLOCK_STORAGE-DESIGN.md §10.3): legacy envelopes gain block
 * rows that assemble back to their stored content, without touching anything the model
 * reads or any revision that would invalidate its caches.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");
const { narratorPersistence } = await import("../narrator-persistence");
const { settings } = await import("../../lib/settings");
const blockSync = await import("../narrator-block-sync");
const backfill = await import("../narrator-block-backfill");
const blockIndex = await import("../narrator-block-index");
const { runBlockBackfillSlice, runBlockVerifySlice, runBlockReindexSlice } = await import(
	"../../lib/db-worker/block-backfill-query"
);

const NOW = "2026-10-01T00:00:00.000Z";

const { ensureFts } = await import("../../db/fts");
ensureFts(sqlite, { wasClean: true });

/** Read slices on the test connection, as the inline fallback does. */
const inline = {
	backfill: async (params: Parameters<typeof runBlockBackfillSlice>[1]) =>
		runBlockBackfillSlice(sqlite, params),
	verify: async (params: Parameters<typeof runBlockVerifySlice>[1]) =>
		runBlockVerifySlice(sqlite, params),
	reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) =>
		runBlockReindexSlice(sqlite, params),
};

/** Run the jobs to the end, then write the search text the store and the jobs queued. */
async function drain(): Promise<number> {
	await blockIndex.drainBlockIndexQueue();
	let slices = 0;
	while (await backfill.runBlockJobSlice(inline)) slices++;
	await blockIndex.drainBlockIndexQueue();
	return slices;
}

/** Write with block storage off: what a database from before P1 holds. */
async function legacy<T>(write: () => Promise<T>): Promise<T> {
	settings.narratorBlocks.write = false;
	try {
		return await write();
	} finally {
		settings.narratorBlocks.write = true;
	}
}

function envelope(messageId: string) {
	return sqlite
		.prepare(
			`SELECT body_format AS bodyFormat, body_revision AS bodyRevision, body_bytes AS bodyBytes,
				content_json AS contentJson
			 FROM narrator_messages WHERE id = ?`,
		)
		.get(messageId) as {
		bodyFormat: number;
		bodyRevision: number;
		bodyBytes: number;
		contentJson: string;
	};
}

function assembled(messageId: string): unknown[] {
	const rows = sqlite
		.prepare("SELECT payload, state FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
		.all(messageId) as Array<{ payload: string; state: string | null }>;
	return assembleContent(
		rows.map((row) => ({
			payload: JSON.parse(row.payload),
			state: row.state ? JSON.parse(row.state) : null,
		})),
	);
}

const historyRevision = () =>
	(
		sqlite.prepare("SELECT model_history_revision AS n FROM narrators WHERE id = 'n1'").get() as {
			n: number;
		}
	).n;

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('n1', 'N', ?, ?)", [
		NOW,
		NOW,
	]);
	sqlite.run("DELETE FROM narrator_block_backfill");
	sqlite.run("DELETE FROM narrator_block_diagnostics");
	backfill.resetBlockJobPacingForTests();
});
afterEach(() => {
	settings.narratorBlocks.write = true;
});
afterAll(() => {
	blockSync.stopBlockSyncSweep();
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("block backfill", () => {
	test("legacy envelopes gain rows equal to their content, and nothing the model reads moves", async () => {
		const { input, step, toolCallId } = await legacy(async () => {
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
			await narratorStore.settleTool(
				"c1",
				{ output: "a.txt", status: "success" },
				step.id,
				toolCallId,
			);
			return { input, step, toolCallId };
		});
		expect(envelope(input.id).bodyFormat).toBe(1);
		const revisions = [envelope(input.id).bodyRevision, envelope(step.id).bodyRevision];
		const history = historyRevision();

		await drain();

		for (const id of [input.id, step.id]) {
			expect(envelope(id).bodyFormat).toBe(2);
			expect(assembled(id)).toEqual(JSON.parse(envelope(id).contentJson));
			expect(envelope(id).bodyBytes).toBeGreaterThan(0);
		}
		// Storage changed shape only: no revision moved, so no cache was invalidated.
		expect([envelope(input.id).bodyRevision, envelope(step.id).bodyRevision]).toEqual(revisions);
		expect(historyRevision()).toBe(history);
		const tool = sqlite
			.prepare("SELECT id, phase FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'")
			.get(step.id) as { id: string; phase: string };
		expect(tool.phase).toBe("done");
		expect(
			sqlite
				.prepare("SELECT block_id AS blockId FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId ?? ""),
		).toEqual({ blockId: tool.id });
		// The block search index covers the converted rows.
		expect(
			sqlite
				.prepare("SELECT count(*) AS n FROM narrator_blocks_fts WHERE narrator_blocks_fts MATCH ?")
				.get('"list the files"'),
		).toEqual({ n: 1 });
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_sync_queue").get()).toEqual({
			n: 0,
		});
		expect(backfill.blockBackfillStatus().convert).toMatchObject({ complete: true, processed: 2 });
		// Running again finds nothing to do.
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
	});

	test("an envelope that changed after the worker read it is converted from what it holds now", async () => {
		const input = await legacy(() => narratorStore.appendInput("n1", "before"));
		const stale = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		sqlite.run("UPDATE narrator_messages SET content_json = ?, content_text = ? WHERE id = ?", [
			JSON.stringify([{ type: "text", text: "after" }]),
			"after",
			input.id,
		]);
		await backfill.runBlockJobSlice({ ...inline, backfill: async () => stale });
		expect(envelope(input.id).bodyFormat).toBe(2);
		expect(assembled(input.id)).toEqual([{ type: "text", text: "after" }]);
	});

	test("a state-only write after the worker read the envelope is not lost", async () => {
		const step = await legacy(async () => {
			const opened = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
			await narratorStore.writeStepItem(opened.id, "n1", {
				type: "reasoning",
				id: "r1",
				text: "thinking",
				completed: true,
				outputIndex: 0,
			});
			return opened;
		});
		const stale = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		// A translation lands while the slice is in flight: state moves, the body does not.
		const { bodyRevision } = envelope(step.id);
		expect(await narratorPersistence.patchReasoningTranslation(step.id, 0, "思考")).toBeTruthy();
		expect(envelope(step.id).bodyRevision).toBe(bodyRevision);
		await backfill.runBlockJobSlice({ ...inline, backfill: async () => stale });
		expect(envelope(step.id).bodyFormat).toBe(2);
		expect(assembled(step.id)).toEqual(JSON.parse(envelope(step.id).contentJson));
		expect(JSON.stringify(assembled(step.id))).toContain("思考");
	});

	test("unreadable content is recorded and left legacy; the job moves past it", async () => {
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('odd', 'n1', 'user', '"not an array"', ?)`,
			[NOW],
		);
		await drain();
		expect(envelope("odd").bodyFormat).toBe(1);
		expect(
			sqlite.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = 'odd'").get(),
		).toEqual({ kind: "undecodable" });
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
	});

	test("verify records and repairs block rows that drifted from their envelope", async () => {
		const input = await narratorStore.appendInput("n1", "dual-written");
		sqlite.run("UPDATE narrator_blocks SET payload = ? WHERE message_id = ?", [
			JSON.stringify({ raw: [{ type: "text", text: "drifted" }] }),
			input.id,
		]);
		await drain();
		expect(
			sqlite
				.prepare("SELECT kind FROM narrator_block_diagnostics WHERE message_id = ?")
				.get(input.id),
		).toEqual({ kind: "mismatch" });
		expect(assembled(input.id)).toEqual(JSON.parse(envelope(input.id).contentJson));
		expect(backfill.blockBackfillStatus().verify?.complete).toBe(true);
	});

	test("a paused job runs no slices until resumed", async () => {
		const input = await legacy(() => narratorStore.appendInput("n1", "waiting"));
		backfill.setBlockBackfillPaused(true);
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		expect(envelope(input.id).bodyFormat).toBe(1);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0");
		await drain();
		expect(envelope(input.id).bodyFormat).toBe(2);
	});

	test("content holding reader-only fields mid-element converts and verifies clean", async () => {
		// Written before block storage: `isLatest` between other fields, not after them.
		const card = {
			type: "merge_summary",
			sourceChapterId: "ch1",
			isLatest: true,
			summary: "s",
			modelText: "merged",
		};
		sqlite.run(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('card', 'n1', 'system', ?, ?)`,
			[JSON.stringify([card]), NOW],
		);
		await drain();
		expect(envelope("card").bodyFormat).toBe(2);
		// Same content; the rows put reader-only fields last, as the store writes them.
		expect(assembled("card")).toEqual([card]);
		expect(Object.keys(assembled("card")[0] as object).at(-1)).toBe("isLatest");
		expect(sqlite.prepare("SELECT count(*) AS n FROM narrator_block_diagnostics").get()).toEqual({
			n: 0,
		});
		expect(blockSync.auditRecentEnvelopes()).toEqual([]);
	});

	test("legacy envelopes written after convert finished send it back to them", async () => {
		await legacy(() => narratorStore.appendInput("n1", "first"));
		await drain();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
		// Written while block writes were off: the job does not convert while they are off.
		settings.narratorBlocks.write = false;
		const later = await narratorStore.appendInput("n1", "later");
		backfill.rearmBlockConvert();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(false);
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		expect(envelope(later.id).bodyFormat).toBe(1);
		settings.narratorBlocks.write = true;
		await drain();
		expect(envelope(later.id).bodyFormat).toBe(2);
		expect(assembled(later.id)).toEqual(JSON.parse(envelope(later.id).contentJson));
		// Nothing left to convert: re-arming is a no-op.
		backfill.rearmBlockConvert();
		expect(backfill.blockBackfillStatus().convert?.complete).toBe(true);
	});

	test("slices stop at the envelope limit and resume from the cursor", async () => {
		const ids: string[] = [];
		await legacy(async () => {
			for (let index = 0; index < 7; index++)
				ids.push((await narratorStore.appendInput("n1", `message ${index}`)).id);
		});
		const first = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: 0,
			maxEnvelopes: 3,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		expect(first.envelopes.map((planned) => planned.id)).toEqual(ids.slice(0, 3));
		expect(first.done).toBe(false);
		const rest = await inline.backfill({
			kind: "blockBackfillSlice",
			afterRowid: first.lastRowid,
			maxEnvelopes: 100,
			maxSourceBytes: 1 << 22,
			budgetMs: 1000,
		});
		expect(rest.envelopes.map((planned) => planned.id)).toEqual(ids.slice(3));
		expect(rest.done).toBe(true);
	});
});

describe("block reindex", () => {
	/** Every block id the block index finds for `term`. */
	const indexed = (term: string) =>
		(
			sqlite
				.prepare(
					`SELECT b.id FROM narrator_blocks_fts JOIN narrator_blocks b ON b.rowid = narrator_blocks_fts.rowid
					 WHERE narrator_blocks_fts MATCH ? ORDER BY b.id`,
				)
				.all(`"${term}"`) as Array<{ id: string }>
		).map((row) => row.id);

	async function conversation(): Promise<string> {
		await narratorStore.appendInput("n1", "where are the gooseberries");
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		await narratorStore.writeStepItem(step.id, "n1", {
			type: "text",
			id: "t1",
			text: "The gooseberries are in the cellar.",
			completed: true,
			outputIndex: 0,
		});
		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "c1",
			name: "Grep",
			input: { pattern: "quince" },
			outputIndex: 1,
		});
		await narratorStore.settleTool(
			"c1",
			{ output: "jam/quince.md", status: "success" },
			step.id,
			toolCallId,
		);
		// The store queues the search text; the index job writes it.
		await blockIndex.drainBlockIndexQueue();
		return step.id;
	}

	test("runs after verify and leaves every revision where it was", async () => {
		await conversation();
		const revisions = () =>
			sqlite
				.prepare("SELECT id, body_revision, state_revision FROM narrator_messages ORDER BY id")
				.all();
		const before = revisions();
		const history = historyRevision();
		await drain();
		const status = backfill.blockBackfillStatus();
		expect([status.convert?.complete, status.verify?.complete, status.reindex?.complete]).toEqual([
			true,
			true,
			true,
		]);
		expect(status.reindex?.processed).toBe(2);
		expect(revisions()).toEqual(before);
		expect(historyRevision()).toBe(history);
	});

	test("rebuilds a cleared block index as the store wrote it", async () => {
		await conversation();
		const terms = ["gooseberries", "cellar", "quince", "Grep"];
		const written = terms.map(indexed);
		expect(written.every((ids) => ids.length > 0)).toBe(true);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		expect(terms.map(indexed)).toEqual(terms.map(() => []));
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		await drain();
		expect(terms.map(indexed)).toEqual(written);
	});

	test("reaches rows-only envelopes too", async () => {
		const stepId = await conversation();
		await drain();
		sqlite.run(
			"UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = ?",
			[stepId],
		);
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		await drain();
		expect(indexed("quince")).toHaveLength(1);
		expect(indexed("cellar")).toHaveLength(1);
	});
	const reindexParams = {
		kind: "blockReindexSlice" as const,
		afterRowid: 0,
		maxEnvelopes: 100,
		maxSourceBytes: 1 << 22,
		maxIndexChars: 1 << 20,
		budgetMs: 1000,
	};

	test("the worker computes every missing block's text; none falls back to the main thread", async () => {
		const stepId = await conversation();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(slice.done).toBe(true);
		expect(slice.envelopes.map((envelope) => envelope.resync)).toEqual([false, false]);
		const step = slice.envelopes.find((envelope) => envelope.id === stepId);
		expect(step?.blocks.map((block) => /cellar|quince/.test(block.text ?? ""))).toEqual([
			true,
			true,
		]);
	});

	/** Rows of the block index's own storage: any write to the index adds or changes some. */
	const indexStorage = () =>
		sqlite.prepare("SELECT id, block FROM narrator_blocks_fts_data ORDER BY id").all();

	test("entries already in the index are left as they are", async () => {
		await conversation();
		const before = indexStorage();
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(
			slice.envelopes.flatMap((envelope) => envelope.blocks.map((block) => block.text)),
		).toEqual([null, null, null]);
		await drain();
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 2 });
		expect(indexStorage()).toEqual(before);
	});

	test("a block missing from the index regains its entry; its neighbours are left", async () => {
		const stepId = await conversation();
		await drain();
		const tool = sqlite
			.prepare("SELECT rowid FROM narrator_blocks WHERE message_id = ? AND kind = 'tool'")
			.get(stepId) as { rowid: number };
		sqlite.run("DELETE FROM narrator_blocks_fts WHERE rowid = ?", [tool.rowid]);
		expect(indexed("quince")).toEqual([]);
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		const step = slice.envelopes.find((envelope) => envelope.id === stepId);
		expect(step?.blocks.map((block) => block.text === null)).toEqual([true, false]);
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
		await drain();
		expect(indexed("quince")).toHaveLength(1);
		expect(indexed("cellar")).toHaveLength(1);
	});

	test("an envelope rewritten after the read is reindexed from what it holds now", async () => {
		const stepId = await conversation();
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		let raced = false;
		const racing = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				if (!raced) {
					raced = true;
					sqlite.run(
						`UPDATE narrator_blocks SET revision = revision + 1,
							payload = json_set(payload, '$.raw[0].text', 'The persimmons are in the attic.')
						 WHERE message_id = ? AND kind = 'output'`,
						[stepId],
					);
				}
				return slice;
			},
		};
		while (await backfill.runBlockJobSlice(racing));
		await blockIndex.drainBlockIndexQueue();
		expect(indexed("persimmons")).toHaveLength(1);
		expect(indexed("cellar")).toEqual([]);
		expect(indexed("quince")).toHaveLength(1);
	});

	test("a ledger change synced after the read is reindexed from what it holds now", async () => {
		await conversation();
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run("UPDATE narrator_block_backfill SET cursor = 0, complete = 0 WHERE job = 'reindex'");
		let raced = false;
		const racing = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				if (!raced) {
					raced = true;
					// The tool's block row stays as read; only the ledger moves, and its sync runs.
					sqlite.run("UPDATE narrator_tool_calls SET output_json = ? WHERE tool_use_id = 'c1'", [
						JSON.stringify("jam/medlar.md"),
					]);
					blockSync.flushChangedEnvelopes();
				}
				return slice;
			},
		};
		while (await backfill.runBlockJobSlice(racing));
		await blockIndex.drainBlockIndexQueue();
		expect(indexed("medlar")).toHaveLength(1);
		expect(indexed("jam/quince")).toEqual([]);
	});

	/** Five envelopes (six blocks) whose index was lost, with reindex set to start over. */
	async function lostIndex(): Promise<void> {
		await conversation();
		for (const text of ["damsons", "greengages", "loquats"])
			await narratorStore.appendInput("n1", `where are the ${text}`);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
	}

	/** A reader after which every clock reading is 60ms on: each write takes the whole budget. */
	function slowWrites() {
		let clock: ReturnType<typeof spyOn> | undefined;
		const reader = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				let now = performance.now();
				clock ??= spyOn(performance, "now").mockImplementation(() => (now += 60));
				return slice;
			},
		};
		return { reader, restore: () => clock?.mockRestore() };
	}

	const indexedOnce = ["cellar", "quince", "damsons", "greengages", "loquats"];

	test("a slice is written a block at a time, in short transactions", async () => {
		await lostIndex();
		const slow = slowWrites();
		const transactions = spyOn(sqlite, "transaction");
		let count = 0;
		try {
			expect(await backfill.runBlockJobSlice(slow.reader)).toBe(true);
			count = transactions.mock.calls.length;
		} finally {
			slow.restore();
			transactions.mockRestore();
		}
		// Five envelopes, six blocks: the step's two blocks went in two transactions.
		expect(count).toBe(6);
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const term of indexedOnce) expect(indexed(term)).toHaveLength(1);
	}, 20_000);

	test("a transaction stops at its index text budget, which grows while commits stay short", async () => {
		const fruits = ["apricots", "bilberries", "cloudberries", "dewberries", "elderberries"];
		for (const fruit of fruits)
			await narratorStore.appendInput("n1", `${fruit} ${"x".repeat(20_000)}`);
		await drain();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		sqlite.run(
			"UPDATE narrator_block_backfill SET cursor = 0, complete = 0, processed = 0 WHERE job = 'reindex'",
		);
		backfill.resetBlockJobPacingForTests();
		let clock: ReturnType<typeof spyOn> | undefined;
		const frozen = {
			...inline,
			reindex: async (params: Parameters<typeof runBlockReindexSlice>[1]) => {
				const slice = await inline.reindex(params);
				// Every transaction takes no time: only the text budget ends one.
				clock ??= spyOn(performance, "now").mockReturnValue(performance.now());
				return slice;
			},
		};
		const transactions = spyOn(sqlite, "transaction");
		let count = 0;
		try {
			expect(await backfill.runBlockJobSlice(frozen)).toBe(true);
			count = transactions.mock.calls.length;
		} finally {
			clock?.mockRestore();
			transactions.mockRestore();
		}
		// 32K characters: two 20K blocks. Grown to 40K, which two more do not reach: the other
		// three. Without the growth the last one would take a third transaction.
		expect(count).toBe(2);
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const fruit of fruits) expect(indexed(fruit)).toHaveLength(1);
	});

	test("pausing between a slice's transactions stops it where it is", async () => {
		await lostIndex();
		const slow = slowWrites();
		const transaction = sqlite.transaction.bind(sqlite);
		let calls = 0;
		const transactions = spyOn(sqlite, "transaction").mockImplementation((write) => {
			if (++calls === 3)
				sqlite.run("UPDATE narrator_block_backfill SET paused = 1 WHERE job = 'reindex'");
			return transaction(write);
		});
		try {
			expect(await backfill.runBlockJobSlice(slow.reader)).toBe(true);
		} finally {
			slow.restore();
			transactions.mockRestore();
		}
		// The input and the step's first block were written; the cursor stays before the step.
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({
			complete: false,
			paused: true,
			processed: 1,
		});
		expect(await backfill.runBlockJobSlice(inline)).toBe(false);
		sqlite.run("UPDATE narrator_block_backfill SET paused = 0 WHERE job = 'reindex'");
		await drain();
		expect(backfill.blockBackfillStatus().reindex).toMatchObject({ complete: true, processed: 5 });
		for (const term of indexedOnce) expect(indexed(term)).toHaveLength(1);
	}, 20_000);

	test("a slice stops at its index text budget, and a queued envelope is left to the sync", async () => {
		const stepId = await conversation();
		sqlite.run("DELETE FROM narrator_blocks_fts");
		const first = runBlockReindexSlice(sqlite, { ...reindexParams, maxIndexChars: 1 });
		expect(first.envelopes).toHaveLength(1);
		expect(first.done).toBe(false);
		sqlite.run("INSERT OR IGNORE INTO narrator_block_sync_queue (message_id) VALUES (?)", [stepId]);
		const slice = runBlockReindexSlice(sqlite, reindexParams);
		expect(slice.envelopes.find((envelope) => envelope.id === stepId)).toMatchObject({
			resync: true,
			blocks: [],
		});
	});
});
