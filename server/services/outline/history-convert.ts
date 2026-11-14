/**
 * The one-time placement conversion (pageless plan §二, first version): spaces written before
 * `outline_block_edges` existed get one open placement per live block, built from their CURRENT
 * blocks, and their history floor.
 *
 * WHAT A CONVERTED SPACE HOLDS
 * ----------------------------
 *   - every live block has exactly one open placement equal to its row (parent, order key),
 *     holding from seq 0, which reads as "since before the space's history";
 *   - no change marks for anything before the conversion;
 *   - `history_floor_seq` is the seq of its latest commit then, and `edges_ready` is set: reads
 *     by placement are right for every seq from the floor on, and a read below the floor is
 *     answered "history starts later" by the reader.
 * Nothing is deleted or rewritten here: block rows, versions and commits stay as they are.
 *
 * HOW IT RUNS
 * -----------
 * In the background after startup, never on a request path:
 *
 *   1. When any space is waiting, the outline's tables are first copied to a file the owner can
 *      keep (`history-backup.ts`; in another process). Without the copy nothing is converted.
 *   2. Space by space, {@link OUTLINE_HISTORY_CONVERT.rows} blocks per transaction, yielding to
 *      the event loop between transactions. A batch places only blocks that have no open
 *      placement, so it is safe to run again from the start after a stop or a crash (the
 *      batches already done read their blocks and write nothing): there is no stored cursor.
 *   3. When a space's blocks are all visited, one statement marks it ready and writes its floor.
 *
 * Commits keep landing meanwhile. A commit places the blocks it creates, moves or restores
 * itself (`applyCommit`), whether or not the conversion has reached them, and a batch leaves
 * such a block alone; a batch and a commit of one space never interleave (SQLite: both are
 * synchronous transactions; PostgreSQL: both hold the space's row). So when the last batch is
 * done every live block is placed where it is, and the floor, read in the marking statement,
 * is at or after every commit that landed during the conversion.
 *
 * A shutdown ({@link stopOutlineHistoryConversion}) stops it after the batch it is on.
 */
import { logger } from "@server/lib/logger";
import { outlineBackupFor } from "./history-backup";
import { outlineStore } from "./store";
import { OUTLINE_EDGE_BACKFILL_ROWS, type OutlineHistoryPort } from "./store/history-port";

export const OUTLINE_HISTORY_CONVERT = {
	/** Spaces read per listing. */
	spaceBatch: 20,
	/** Blocks one transaction visits. */
	rows: OUTLINE_EDGE_BACKFILL_ROWS,
} as const;

/** Timings of the conversion's retries. Mutable only so tests can change them. */
export const OUTLINE_HISTORY_CONVERT_TIMING: Record<
	"retryMinMs" | "retryMaxMs" | "maxRetries",
	number
> = {
	/** A run that left spaces (an error, a failed copy) runs again after this, doubling… */
	retryMinMs: 30_000,
	/** …up to this… */
	retryMaxMs: 10 * 60_000,
	/**
	 * …and at most this many times in a row (about an hour and a half in all). After that the
	 * process stops trying and says so; the next start tries again. A copy that cannot be made
	 * (no room, a file system that refuses) is not something to retry forever.
	 */
	maxRetries: 12,
};

/** What the conversion needs of a store. */
export type OutlineHistoryConvertStore = Pick<
	OutlineHistoryPort,
	"listSpacesPendingEdges" | "backfillEdges" | "finishEdgeBackfill"
>;

export interface OutlineHistoryConvertResult {
	/** Spaces converted by this run. */
	spaces: number;
	/** Blocks visited. */
	blocks: number;
	/** Placements written. */
	placed: number;
	/** Spaces left for a later run (an error, a stop). */
	left: number;
	/** The copy of the outline's tables this run rests on; null when the store has none to make. */
	backup: string | null;
	/** Wall-clock time of the run. */
	ms: number;
}

export interface OutlineHistoryConvertOptions {
	store?: OutlineHistoryConvertStore;
	/**
	 * Copies the outline's tables before the first space is converted and resolves with the
	 * copy's path (null: this store has nothing to copy). A rejection stops the run before any
	 * space is touched. Called only when a space is waiting.
	 */
	backup?: ((signal?: AbortSignal) => Promise<string | null>) | null;
	signal?: AbortSignal;
	/** Blocks per transaction (tests lower it). */
	rows?: number;
	/** Called after every transaction (tests interleave commits here). */
	onBatch?: (progress: { spaceId: string; scanned: number; inserted: number }) => void;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Shutdown asked the conversion to stop: no new run, no new batch. */
let stopping = false;

async function convertSpace(
	store: OutlineHistoryConvertStore,
	spaceId: string,
	options: OutlineHistoryConvertOptions,
	result: OutlineHistoryConvertResult,
): Promise<boolean> {
	const limit = options.rows ?? OUTLINE_HISTORY_CONVERT.rows;
	let afterSid: string | null = null;
	for (;;) {
		if (stopping || options.signal?.aborted) return false;
		const batch = await store.backfillEdges(spaceId, { afterSid, limit });
		result.blocks += batch.scanned;
		result.placed += batch.inserted;
		options.onBatch?.({ spaceId, scanned: batch.scanned, inserted: batch.inserted });
		await yieldToEventLoop();
		if (batch.nextSid === null) break;
		afterSid = batch.nextSid;
	}
	if (stopping || options.signal?.aborted) return false;
	await store.finishEdgeBackfill(spaceId);
	return true;
}

/** Convert every space that is waiting; see the module header. */
export async function convertOutlineHistory(
	options: OutlineHistoryConvertOptions = {},
): Promise<OutlineHistoryConvertResult> {
	const store = options.store ?? outlineStore;
	const started = performance.now();
	const result: OutlineHistoryConvertResult = {
		spaces: 0,
		blocks: 0,
		placed: 0,
		left: 0,
		backup: null,
		ms: 0,
	};
	const done = () => {
		result.ms = Math.round(performance.now() - started);
		return result;
	};
	let copied = false;
	let after: string | null = null;
	for (;;) {
		const spaces = await store.listSpacesPendingEdges({
			after,
			limit: OUTLINE_HISTORY_CONVERT.spaceBatch,
		});
		if (spaces.length > 0 && !copied) {
			// The copy comes first: a failure here leaves every space as it was.
			if (options.backup) result.backup = await options.backup(options.signal);
			copied = true;
		}
		for (const space of spaces) {
			if (stopping || options.signal?.aborted) {
				result.left++;
				continue;
			}
			try {
				if (await convertSpace(store, space.id, options, result)) result.spaces++;
				else result.left++;
			} catch (error) {
				result.left++;
				logger.warn("Outline placement conversion failed for a space", {
					spaceId: space.id,
					error: String(error),
				});
			}
		}
		const last = spaces.at(-1);
		if (!last || spaces.length < OUTLINE_HISTORY_CONVERT.spaceBatch) break;
		if (stopping || options.signal?.aborted) break;
		// Converted spaces leave the listing; the cursor passes those left behind.
		after = last.id;
	}
	return done();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scheduling: one run at startup, again later while spaces are left
// ─────────────────────────────────────────────────────────────────────────────

let running: Promise<OutlineHistoryConvertResult | null> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 0;
let retries = 0;
/** Aborts the run in progress: its batches, and the copy the other process is making. */
let abort: AbortController | null = null;

function runAgainIn(delayMs: number): void {
	if (stopping || timer) return;
	timer = setTimeout(() => {
		timer = null;
		void scheduleOutlineHistoryConversion();
	}, delayMs);
	timer.unref?.();
}

/**
 * The startup run for the process's store (one at a time). A run that left spaces, could not
 * make the copy or failed is tried again later, backing off from
 * {@link OUTLINE_HISTORY_CONVERT_TIMING.retryMinMs}, at most
 * {@link OUTLINE_HISTORY_CONVERT_TIMING.maxRetries} times in a row. Resolves with the run's
 * result (null when it failed).
 */
export function scheduleOutlineHistoryConversion(): Promise<OutlineHistoryConvertResult | null> {
	if (running) return running;
	if (stopping) return Promise.resolve(null);
	const store = outlineStore;
	const controller = new AbortController();
	abort = controller;
	const run = (async () => {
		let result: OutlineHistoryConvertResult | null = null;
		try {
			result = await convertOutlineHistory({
				store,
				backup: outlineBackupFor(store),
				signal: controller.signal,
			});
			if (result.spaces || result.left)
				logger.info("Outline placements built for spaces written before them", { ...result });
		} catch (error) {
			if (!stopping)
				logger.warn("Outline placement conversion did not run", { error: String(error) });
		}
		if (stopping) return result;
		if (result !== null && result.left === 0) {
			retryMs = 0;
			retries = 0;
			return result;
		}
		if (retries >= OUTLINE_HISTORY_CONVERT_TIMING.maxRetries) {
			logger.error(
				"Outline placement conversion gave up for this run of the server; spaces written before placements stay unconverted until the next start",
				{ retries },
			);
			return result;
		}
		retries++;
		retryMs = Math.min(
			OUTLINE_HISTORY_CONVERT_TIMING.retryMaxMs,
			retryMs > 0 ? retryMs * 2 : OUTLINE_HISTORY_CONVERT_TIMING.retryMinMs,
		);
		runAgainIn(retryMs);
		return result;
	})().finally(() => {
		running = null;
		if (abort === controller) abort = null;
	});
	running = run;
	return run;
}

/**
 * Stop for shutdown: no run starts from now on, a scheduled one is cancelled, and a run in
 * progress is aborted: it ends after the batch it is on, and a copy being made in the other
 * process is stopped (its partial file removed) rather than waited for. Resolves when the run
 * has ended.
 */
export async function stopOutlineHistoryConversion(): Promise<void> {
	stopping = true;
	if (timer) clearTimeout(timer);
	timer = null;
	abort?.abort();
	await running?.catch(() => {});
}

/** Test hook: allow runs again after a stop. */
export function resumeOutlineHistoryConversionForTests(): void {
	stopping = false;
	retryMs = 0;
	retries = 0;
}
