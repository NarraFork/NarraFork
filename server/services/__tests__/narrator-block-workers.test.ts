import { afterAll, expect, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { sqlite } from "../../db";
import {
	getDbWorkerPoolStats,
	resetDbWorkerPoolForTest,
	shutdownDbWorkerPool,
} from "../../lib/db-worker/pool";
import { settings } from "../../lib/settings";

// Keep the store's existing import-cycle order, but use the real isolated file database.
await import("../narrator-service");
const backfill = await import("../narrator-block-backfill");
const blockIndex = await import("../narrator-block-index");
const blockSync = await import("../narrator-block-sync");
const { narratorStore } = await import("../narrator-store");
const before = { ...settings.narratorBlocks };
const previousWorker = process.env.NARRAFORK_DB_WORKER;
const previousConcurrency = process.env.NARRAFORK_DB_WORKER_CONCURRENCY;

afterAll(async () => {
	blockIndex.setBlockIndexAutoRunForTests(false);
	blockSync.stopBlockSyncSweep();
	await shutdownDbWorkerPool();
	Object.assign(settings.narratorBlocks, before);
	if (previousWorker === undefined) delete process.env.NARRAFORK_DB_WORKER;
	else process.env.NARRAFORK_DB_WORKER = previousWorker;
	if (previousConcurrency === undefined) delete process.env.NARRAFORK_DB_WORKER_CONCURRENCY;
	else process.env.NARRAFORK_DB_WORKER_CONCURRENCY = previousConcurrency;
});

async function finish(run: () => Promise<boolean>): Promise<void> {
	for (let slices = 0; slices < 20; slices++) if (!(await run())) return;
	throw new Error("fixture job did not complete within 20 slices");
}

test("default production block readers convert, verify, reindex, index, clear and restore on real workers", async () => {
	cleanDb(sqlite);
	delete process.env.NARRAFORK_DB_WORKER;
	process.env.NARRAFORK_DB_WORKER_CONCURRENCY = "1";
	await resetDbWorkerPoolForTest();
	blockIndex.setBlockIndexAutoRunForTests(false);
	Object.assign(settings.narratorBlocks, { write: true, read: true, compactJson: false });
	const at = "2026-10-01T00:00:00.000Z";
	const content = JSON.stringify([{ type: "text", text: "legacy persimmon content" }]);
	sqlite.run(
		"INSERT INTO narrators (id, title, created_at, updated_at) VALUES ('worker-n', 'Worker', ?, ?)",
		[at, at],
	);
	sqlite.run(
		`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
		VALUES ('worker-message', 'worker-n', 'user', ?, ?)`,
		[content, at],
	);
	sqlite.run("DELETE FROM narrator_block_backfill");
	await finish(() => backfill.runBlockJobSlice());
	expect(
		sqlite
			.query("SELECT body_format AS f FROM narrator_messages WHERE id = 'worker-message'")
			.get(),
	).toEqual({ f: 2 });
	expect(
		sqlite.query("SELECT id FROM narrator_blocks WHERE message_id = 'worker-message'").all(),
	).toHaveLength(1);
	for (const job of ["convert", "verify", "reindex"] as const)
		expect(backfill.blockBackfillStatus()[job]).toMatchObject({ complete: true });

	const input = await narratorStore.appendInput("worker-n", "fresh quince text");
	expect(
		sqlite.query("SELECT block_id FROM narrator_block_index_queue").all().length,
	).toBeGreaterThan(0);
	await blockIndex.runBlockIndex();
	expect(sqlite.query("SELECT block_id FROM narrator_block_index_queue").all()).toEqual([]);
	expect(
		sqlite
			.query("SELECT rowid FROM narrator_blocks_fts WHERE narrator_blocks_fts MATCH 'quince'")
			.all(),
	).toHaveLength(1);

	settings.narratorBlocks.compactJson = true;
	sqlite.run("UPDATE narrator_block_backfill SET paused = 0, complete = 0 WHERE job = 'clear'");
	await finish(() => backfill.runProjectionSlice());
	for (const id of ["worker-message", input.id])
		expect(
			sqlite
				.query("SELECT content_json AS c, body_rows_only AS r FROM narrator_messages WHERE id = ?")
				.get(id),
		).toEqual({ c: "[]", r: 1 });
	expect(backfill.blockBackfillStatus().clear).toMatchObject({ complete: true });

	settings.narratorBlocks.compactJson = false;
	sqlite.run(
		`INSERT INTO narrator_block_backfill (job, paused, updated_at) VALUES ('restore', 0, ?)
		ON CONFLICT(job) DO UPDATE SET paused = 0, complete = 0`,
		[at],
	);
	await finish(() => backfill.runProjectionSlice());
	expect(
		sqlite
			.query(
				"SELECT content_json AS c, body_rows_only AS r FROM narrator_messages WHERE id = 'worker-message'",
			)
			.get(),
	).toEqual({ c: content, r: 0 });
	expect(backfill.blockBackfillStatus().restore).toMatchObject({ complete: true });
	expect(getDbWorkerPoolStats().workers).toBeGreaterThan(0);
}, 30_000);
