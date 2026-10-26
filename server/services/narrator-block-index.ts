/**
 * narrator-block-index.ts — the block search index text the sync owes, written off the
 * writer's transaction (docs/BLOCK_STORAGE-DESIGN.md §4.6).
 *
 * Tokenizing a block's text into the trigram index costs time in proportion to it (tens of
 * milliseconds for a large tool result), so the sync does not write it: it queues the block
 * (`narrator_block_index_queue`) and this job writes it.
 *   - A db-worker computes the queued blocks' text from a read-only connection, exactly as
 *     the sync would (`runBlockIndexQueueSlice`); the main thread only writes it.
 *   - Writes go in short transactions, sized by how long the last one took, each followed by
 *     a pause in proportion to it, like the block jobs (narrator-block-backfill.ts).
 *   - A queue entry's `version` moves on every re-queue; text read before the last one is
 *     never written. An envelope queued for its sync is left until the sync has run.
 *
 * Search therefore trails a write by the job's delay (a few hundred milliseconds when idle).
 * SQLite only, like the rest of block storage.
 */

import * as database from "../db";
import { getDbPath } from "../db/connection";
import { replaceBlockIndexRow } from "../db/fts";
import {
	type BlockIndexQueueSliceParams,
	type BlockIndexQueueSliceResult,
	type IndexQueueEntry,
	runBlockIndexQueueSlice,
} from "../lib/db-worker/block-backfill-query";
import { runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";

/** Wait after a queued block before the job starts: writes nearby coalesce into one slice. */
const START_DELAY_MS = 250;
/** After a failure, the next attempt. */
const RETRY_DELAY_MS = 30_000;
/** Entries the last slice could not write (their envelope waits on its sync) wait this long. */
const BLOCKED_DELAY_MS = 2_000;
const SLICE_BLOCKS = 200;
const SLICE_INDEX_CHARS = 256 * 1024;
const SLICE_BUDGET_MS = 1_000;
const WORKER_TIMEOUT_MS = 30_000;
/** Without workers the main thread computes the text, so slices stay small. */
const INLINE_SLICE_BLOCKS = 20;
const INLINE_SLICE_INDEX_CHARS = 64 * 1024;
/** A write transaction should stay under this, commit included. */
const APPLY_TARGET_MS = 50;
/** After a write transaction of T ms the next waits this many times T (a quarter of the time). */
const APPLY_PACE_FACTOR = 3;
const MAX_PACE_MS = 30_000;
/** Index text one transaction writes, sized by how long the last one took (FTS5 cost). */
const TX_CHARS = { initial: 32 * 1024, min: 4 * 1024, max: 256 * 1024 };
const SLOW_LOG_INTERVAL_MS = 60_000;

let queueTable: boolean | undefined;

/** Whether this database has the index queue (SQLite with block storage). */
function hasIndexQueue(): boolean {
	if (database.activeDatabaseBackend !== "sqlite") return false;
	queueTable ??= !!database.sqlite
		.prepare(
			"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'narrator_block_index_queue'",
		)
		.get();
	return queueTable;
}

/** Owe a sealed block's index text; inside the caller's transaction. */
export function queueBlockIndex(blockId: string): void {
	if (!hasIndexQueue()) return;
	database.sqlite
		.query(
			`INSERT INTO narrator_block_index_queue (block_id) VALUES (?)
			 ON CONFLICT (block_id) DO UPDATE SET version = version + 1`,
		)
		.run(blockId);
	scheduleBlockIndex();
}

/** Drop what a block was owed (it is streaming again, so it has no text). */
export function unqueueBlockIndex(blockId: string): void {
	if (!hasIndexQueue()) return;
	database.sqlite.query("DELETE FROM narrator_block_index_queue WHERE block_id = ?").run(blockId);
}

/** How a slice is read: by a db-worker (production) or inline on the main connection. */
export type IndexQueueReader = (
	params: BlockIndexQueueSliceParams,
) => Promise<BlockIndexQueueSliceResult>;

const inlineParams = (params: BlockIndexQueueSliceParams): BlockIndexQueueSliceParams => ({
	...params,
	maxBlocks: Math.min(params.maxBlocks, INLINE_SLICE_BLOCKS),
	maxIndexChars: Math.min(params.maxIndexChars, INLINE_SLICE_INDEX_CHARS),
});

const workerReader: IndexQueueReader = async (params) => {
	// A worker opens the database file: an in-memory connection (tests) is read inline.
	if (database.sqlite.filename === ":memory:" || !database.sqlite.filename)
		return runBlockIndexQueueSlice(database.sqlite, inlineParams(params));
	try {
		return await runReadTask<BlockIndexQueueSliceResult>(getDbPath(), params, {
			timeoutMs: WORKER_TIMEOUT_MS,
		});
	} catch (error) {
		if (!(error instanceof WorkersUnavailableError) || error.reason === "pool_shutdown")
			throw error;
		return runBlockIndexQueueSlice(database.sqlite, inlineParams(params));
	}
};

export const inlineIndexQueueReader: IndexQueueReader = async (params) =>
	runBlockIndexQueueSlice(database.sqlite, inlineParams(params));

const runner = hotSafe("narrator-block-index:runner", () => ({
	/** Tests write the queue themselves (`drainBlockIndexQueue`), when they choose. */
	autoRun: process.env.NODE_ENV !== "test",
	running: false,
	timer: undefined as ReturnType<typeof setTimeout> | undefined,
	notBefore: 0,
	txChars: TX_CHARS.initial,
	slowAt: 0,
	slowSuppressed: 0,
}));

/** Start the job after `delayMs`, unless it runs or is due already. */
export function scheduleBlockIndex(delayMs = START_DELAY_MS): void {
	if (!runner.autoRun || runner.running || runner.timer) return;
	runner.timer = setTimeout(() => {
		runner.timer = undefined;
		void runBlockIndex();
	}, delayMs);
	runner.timer.unref?.();
}

/** Stop the job (process shutdown, tests); queued entries stay for the next start. */
export function stopBlockIndex(): void {
	if (runner.timer) clearTimeout(runner.timer);
	runner.timer = undefined;
}

/** Startup: write what an earlier process left owed. */
export function recoverBlockIndex(): void {
	if (!hasIndexQueue()) return;
	if (database.sqlite.query("SELECT 1 FROM narrator_block_index_queue LIMIT 1").get())
		scheduleBlockIndex();
}

/** Run slices until the queue is empty; a failure retries later. Exported for tests. */
export async function runBlockIndex(reader: IndexQueueReader = workerReader): Promise<void> {
	if (runner.running || !hasIndexQueue()) return;
	runner.running = true;
	let last = { more: false, written: 0 };
	try {
		do last = await indexSlice(reader);
		while (last.more && last.written > 0);
	} catch (error) {
		const closed = /closed/i.test(String(error));
		if (!closed) {
			logger.warn("Block index job failed; it retries", { error: String(error) });
			runner.running = false;
			scheduleBlockIndex(RETRY_DELAY_MS);
		}
		return;
	} finally {
		runner.running = false;
	}
	// Entries queued while the last slice was being written, or ones it could not write yet
	// (their envelope queued for its sync): those wait a little, not a busy loop.
	if (database.sqlite.query("SELECT 1 FROM narrator_block_index_queue LIMIT 1").get())
		scheduleBlockIndex(last.written > 0 ? START_DELAY_MS : BLOCKED_DELAY_MS);
}

/** One slice: read the next queued blocks' text, write it in paced transactions. */
async function indexSlice(reader: IndexQueueReader): Promise<{ more: boolean; written: number }> {
	const slice = await reader({
		kind: "blockIndexQueueSlice",
		maxBlocks: SLICE_BLOCKS,
		maxIndexChars: SLICE_INDEX_CHARS,
		budgetMs: SLICE_BUDGET_MS,
	});
	// FTS5 flushes its pending terms whenever a write goes back to a lower rowid.
	const entries = [...slice.entries].sort((a, b) => a.rowid - b.rowid);
	let at = 0;
	let written = 0;
	while (at < entries.length) {
		await applyTurn();
		const budget = runner.txChars;
		const started = performance.now();
		const done = database.sqlite.transaction(() => writeEntries(entries, at, started, budget))();
		at = done.next;
		written += done.written;
		const elapsedMs = performance.now() - started;
		runner.notBefore = performance.now() + Math.min(MAX_PACE_MS, elapsedMs * APPLY_PACE_FACTOR);
		if (elapsedMs > APPLY_TARGET_MS) {
			runner.txChars = Math.max(TX_CHARS.min, Math.floor(budget / 2));
			if (elapsedMs > 2 * APPLY_TARGET_MS) noteSlow(elapsedMs, done.chars);
		} else if (elapsedMs < APPLY_TARGET_MS / 2 && done.chars >= budget)
			runner.txChars = Math.min(TX_CHARS.max, Math.ceil(budget * 1.25));
	}
	return { more: slice.more, written };
}

async function applyTurn(): Promise<void> {
	const wait = runner.notBefore - performance.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Write a slice's text from `at` on, inside the caller's transaction, until done, at
 * `maxChars`, or past `APPLY_TARGET_MS` (at least one entry). An entry re-queued since the
 * read, whose block moved, or whose envelope waits on its sync is skipped: it stays queued.
 */
function writeEntries(
	entries: readonly IndexQueueEntry[],
	at: number,
	started: number,
	maxChars: number,
): { next: number; written: number; chars: number } {
	const version = database.sqlite.prepare(
		"SELECT version FROM narrator_block_index_queue WHERE block_id = ?",
	);
	const syncQueued = database.sqlite.prepare(
		"SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?",
	);
	const block = database.sqlite.prepare("SELECT rowid FROM narrator_blocks WHERE id = ?");
	const done = database.sqlite.prepare("DELETE FROM narrator_block_index_queue WHERE block_id = ?");
	let next = at;
	let written = 0;
	let chars = 0;
	while (next < entries.length) {
		if (next > at && (chars >= maxChars || performance.now() - started > APPLY_TARGET_MS)) break;
		const entry = entries[next++];
		const queued = version.get(entry.blockId) as { version: number } | null;
		if (queued?.version !== entry.version) continue;
		if (syncQueued.get(entry.messageId)) continue;
		const current = block.get(entry.blockId) as { rowid: number } | null;
		if (current?.rowid !== entry.rowid) continue;
		replaceBlockIndexRow(database.sqlite, entry.rowid, entry.text);
		done.run(entry.blockId);
		written++;
		chars += entry.text.length;
	}
	return { next, written, chars };
}

/** At most one line a minute. */
function noteSlow(elapsedMs: number, chars: number): void {
	const now = Date.now();
	if (now - runner.slowAt < SLOW_LOG_INTERVAL_MS) {
		runner.slowSuppressed++;
		return;
	}
	logger.warn("Slow block index write", {
		elapsedMs: Math.round(elapsedMs),
		chars,
		nextChars: runner.txChars,
		suppressed: runner.slowSuppressed,
	});
	runner.slowAt = now;
	runner.slowSuppressed = 0;
}

/**
 * Write everything queued now, on the main connection and unpaced: for tests, and for a
 * caller that must read the index it just changed. Returns the entries written.
 */
export async function drainBlockIndexQueue(
	reader: IndexQueueReader = inlineIndexQueueReader,
): Promise<number> {
	if (!hasIndexQueue()) return 0;
	let total = 0;
	for (;;) {
		const before = total;
		const slice = await reader({
			kind: "blockIndexQueueSlice",
			maxBlocks: SLICE_BLOCKS,
			maxIndexChars: SLICE_INDEX_CHARS,
			budgetMs: SLICE_BUDGET_MS,
		});
		const entries = [...slice.entries].sort((a, b) => a.rowid - b.rowid);
		for (let at = 0; at < entries.length; ) {
			const done = database.sqlite.transaction(() =>
				writeEntries(entries, at, performance.now(), Number.POSITIVE_INFINITY),
			)();
			at = done.next;
			total += done.written;
		}
		if (!slice.more || total === before) return total;
	}
}

/** Let the job start itself after writes, in a test that exercises that. */
export function setBlockIndexAutoRunForTests(enabled: boolean): void {
	runner.autoRun = enabled;
	if (!enabled) stopBlockIndex();
}

/** Reset the job's pacing and sizing, for tests. */
export function resetBlockIndexForTests(): void {
	stopBlockIndex();
	runner.running = false;
	runner.notBefore = 0;
	runner.txChars = TX_CHARS.initial;
	queueTable = undefined;
}
