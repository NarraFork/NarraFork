/**
 * narrator-block-backfill.ts — the background block jobs (docs/BLOCK_STORAGE-DESIGN.md
 * §10.3). Both resume from a durable cursor in `narrator_block_backfill`, run slice by
 * slice with the event loop free in between, and can be paused from the storage page.
 *
 *   - `convert` gives every legacy (`body_format = 1`) envelope its block rows. A read-only
 *     db-worker decodes a slice; the main thread inserts it in one short transaction and
 *     flips the envelope to `body_format = 2` last. The rows go in while the envelope is
 *     still legacy, so no revision trigger fires: the model's history, its caches and the
 *     envelope search index are untouched. An envelope that changed after the worker read
 *     it is flipped without rows instead, and the store's sync builds them.
 *   - `verify` then walks block-format envelopes and records any whose rows do not
 *     assemble to its stored content in `narrator_block_diagnostics`, re-syncing it.
 *   - `reindex` (P3c) then rewrites every block-format envelope's block search index text.
 *     A db-worker computes it as the sync would (rows assembled, planned with the ledger);
 *     the main thread only writes it, for envelopes unchanged since the read, and syncs the
 *     rare changed one itself. The envelope index retires once it has completed
 *     (`ensureFts`), which also starts it over when the block index has to be cleared.
 *
 * Two more are started from the storage page (P3b, §10.4), one at a time:
 *
 *   - `clear` drops the `content_json` projection of every verified block-format envelope
 *     whose rows assemble to it exactly, leaving it rows-only (`body_rows_only`); compact
 *     markers keep theirs. Only with `narratorBlocks.compactJson` in effect and convert and
 *     verify complete.
 *   - `restore` writes rows-only envelopes' projections back from their rows, so the
 *     switch can be turned off and block reads with it. Only with the switch off.
 *
 * Both are state-only writes (`state_revision`): the model's view and the rows stay as
 * they are, so nothing is bumped or queued. A worker reads; the main thread applies each
 * envelope only if it has not changed since.
 *
 * SQLite only, like the rest of block storage in this phase.
 */

import * as database from "../db";
import { getDbPath } from "../db/connection";
import { replaceBlockIndexRow, replaceBlockIndexText } from "../db/fts";
import {
	type BackfillEnvelope,
	type BlockBackfillSliceParams,
	type BlockBackfillSliceResult,
	type BlockProjectionSliceParams,
	type BlockProjectionSliceResult,
	type BlockReindexSliceParams,
	type BlockReindexSliceResult,
	type BlockVerifySliceParams,
	type BlockVerifySliceResult,
	ledgerFingerprint,
	type ReindexEnvelope,
	rowsSignature,
	runBlockBackfillSlice,
	runBlockProjectionSlice,
	runBlockReindexSlice,
	runBlockVerifySlice,
} from "../lib/db-worker/block-backfill-query";
import { runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { hasRowsOnlyBodies } from "../lib/narrator-bodies";
import { settings } from "../lib/settings";
import { noteRowsOnlyEnvelopes, rowsOnlyEnvelopesExist } from "./narrator-block-scans";
import {
	reindexEnvelope,
	resyncFromColumn,
	rowsOnlyWrites,
	syncEnvelopeNow,
	watchSyncs,
} from "./narrator-block-sync";

/** The admin-started jobs that drop or write back envelopes' projections (P3b). */
export type ProjectionJob = "clear" | "restore";
export type BlockJob = "convert" | "verify" | "reindex" | ProjectionJob;
const PROJECTION_JOBS: readonly ProjectionJob[] = ["clear", "restore"];

const MAX_SLICE_ENVELOPES = 100;
const MIN_SLICE_ENVELOPES = 1;
const MAX_SLICE_SOURCE_BYTES = 4 * 1024 * 1024;
const SLICE_BUDGET_MS = 1_000;
/**
 * A write transaction should stay under this, commit included. Past it, a slice written in
 * one transaction halves the next slice, and `reindex` halves its index text per transaction.
 */
const APPLY_TARGET_MS = 50;
/**
 * The jobs' share of the main thread: after a write transaction of T ms, the next one waits
 * this many times T (at most a quarter of the time is theirs), up to `MAX_PACE_MS`. The next
 * slice is read meanwhile.
 */
const APPLY_PACE_FACTOR = 3;
const MAX_PACE_MS = 30_000;
/** Without workers the main thread decodes, so slices shrink to stay short. */
const INLINE_SLICE_ENVELOPES = 10;
const INLINE_SLICE_SOURCE_BYTES = 256 * 1024;
const WORKER_TIMEOUT_MS = 30_000;
/** Index text one reindex slice computes; the main thread writes it in short transactions. */
const REINDEX_SLICE_INDEX_CHARS = 256 * 1024;
/**
 * Index text one reindex transaction writes, sized by how long the last one took. FTS5
 * tokenizes as rows are written but flushes the segment, and does the merge work it owes for
 * it, at commit: about nine tenths of the time, roughly proportional to the text written.
 */
const REINDEX_TX_CHARS = { initial: 32 * 1024, min: 4 * 1024, max: 256 * 1024 };
const SLOW_LOG_INTERVAL_MS = 60_000;

/** How a slice is read: by a db-worker (production) or inline on a given connection. */
export interface SliceReader {
	backfill(params: BlockBackfillSliceParams): Promise<BlockBackfillSliceResult>;
	verify(params: BlockVerifySliceParams): Promise<BlockVerifySliceResult>;
	reindex(params: BlockReindexSliceParams): Promise<BlockReindexSliceResult>;
}

async function readInWorker<T>(
	params:
		| BlockBackfillSliceParams
		| BlockVerifySliceParams
		| BlockReindexSliceParams
		| BlockProjectionSliceParams,
	inline: () => T,
): Promise<T> {
	try {
		return await runReadTask<T>(getDbPath(), params, { timeoutMs: WORKER_TIMEOUT_MS });
	} catch (error) {
		if (!(error instanceof WorkersUnavailableError) || error.reason === "pool_shutdown")
			throw error;
		return inline();
	}
}

const inlineLimits = <T extends { maxEnvelopes: number; maxSourceBytes: number }>(params: T) => ({
	...params,
	maxEnvelopes: Math.min(params.maxEnvelopes, INLINE_SLICE_ENVELOPES),
	maxSourceBytes: Math.min(params.maxSourceBytes, INLINE_SLICE_SOURCE_BYTES),
});

const workerReader: SliceReader = {
	backfill: (params) =>
		readInWorker(params, () => runBlockBackfillSlice(database.sqlite, inlineLimits(params))),
	verify: (params) =>
		readInWorker(params, () => runBlockVerifySlice(database.sqlite, inlineLimits(params))),
	reindex: (params) =>
		readInWorker(params, () => runBlockReindexSlice(database.sqlite, inlineLimits(params))),
};

/** How a projection job's slice is read: by a db-worker, or inline on a given connection. */
export type ProjectionReader = (
	params: BlockProjectionSliceParams,
) => Promise<BlockProjectionSliceResult>;

const workerProjectionReader: ProjectionReader = (params) =>
	readInWorker(params, () => runBlockProjectionSlice(database.sqlite, inlineLimits(params)));

const state = hotSafe("narrator-block-backfill:state", () => ({
	running: false,
	sliceEnvelopes: MAX_SLICE_ENVELOPES,
}));

/** When the jobs' next write transaction may start. */
const pace = hotSafe("narrator-block-backfill:pace", () => ({ notBefore: 0 }));
const reindexBudget = hotSafe("narrator-block-backfill:reindex-budget", () => ({
	chars: REINDEX_TX_CHARS.initial,
}));

/** Back to how a fresh process paces and sizes the jobs. */
export function resetBlockJobPacingForTests(): void {
	pace.notBefore = 0;
	reindexBudget.chars = REINDEX_TX_CHARS.initial;
	state.sliceEnvelopes = MAX_SLICE_ENVELOPES;
}

/** Wait until the jobs may take the main thread again (`APPLY_PACE_FACTOR`). */
async function applyTurn(): Promise<void> {
	const wait = pace.notBefore - performance.now();
	if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

const projection = hotSafe("narrator-block-backfill:projection", () => ({
	running: false,
	/**
	 * The current `restore` pass: whether it began at the first envelope, and how many it
	 * wrote back. A whole pass that wrote none stops the job.
	 */
	pass: { fromStart: false, restored: 0 },
}));

let schema: boolean | undefined;

function hasSchema(): boolean {
	if (database.activeDatabaseBackend !== "sqlite") return false;
	schema ??= !!database.sqlite
		.prepare(
			"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'narrator_block_backfill'",
		)
		.get();
	return schema;
}

export interface BlockJobState {
	cursor: number;
	complete: boolean;
	paused: boolean;
	processed: number;
	updatedAt: string;
}

function jobState(job: BlockJob): BlockJobState {
	// A projection job only runs once started: its row starts out paused.
	database.sqlite
		.prepare(
			"INSERT OR IGNORE INTO narrator_block_backfill (job, paused, updated_at) VALUES (?, ?, ?)",
		)
		.run(job, PROJECTION_JOBS.includes(job as ProjectionJob) ? 1 : 0, new Date().toISOString());
	const row = database.sqlite
		.prepare(
			`SELECT cursor, complete, paused, processed, updated_at AS updatedAt
			 FROM narrator_block_backfill WHERE job = ?`,
		)
		.get(job) as {
		cursor: number;
		complete: number;
		paused: number;
		processed: number;
		updatedAt: string;
	};
	return { ...row, complete: !!row.complete, paused: !!row.paused };
}

function advance(job: BlockJob, cursor: number, handled: number, complete: boolean): void {
	database.sqlite
		.prepare(
			`UPDATE narrator_block_backfill SET cursor = ?, processed = processed + ?, complete = ?,
				updated_at = ? WHERE job = ?`,
		)
		.run(cursor, handled, complete ? 1 : 0, new Date().toISOString(), job);
}

function recordDiagnostic(messageId: string, kind: "mismatch" | "undecodable", detail: string) {
	database.sqlite
		.prepare(
			`INSERT INTO narrator_block_diagnostics (message_id, kind, detail, created_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (message_id) DO UPDATE SET kind = excluded.kind, detail = excluded.detail,
				created_at = excluded.created_at`,
		)
		.run(messageId, kind, detail, new Date().toISOString());
}

/** Outcome of one envelope of a convert slice. */
type Applied = "converted" | "changed" | "gone" | "undecodable";

function applyEnvelope(envelope: BackfillEnvelope): Applied {
	const current = database.sqlite
		.prepare(
			`SELECT body_format AS bodyFormat, body_revision AS bodyRevision,
				state_revision AS stateRevision
			 FROM narrator_messages WHERE id = ?`,
		)
		.get(envelope.id) as { bodyFormat: number; bodyRevision: number; stateRevision: number } | null;
	// Deleted, or converted by a write since the worker read it.
	if (!current || current.bodyFormat !== 1) return "gone";
	if (!envelope.blocks) {
		recordDiagnostic(envelope.id, "undecodable", "content_json is not an array of elements");
		return "undecodable";
	}
	if (
		current.bodyRevision !== envelope.bodyRevision ||
		current.stateRevision !== envelope.stateRevision ||
		ledgerFingerprint(database.sqlite, envelope.id) !== envelope.ledgerFingerprint
	) {
		// The plan is stale. Flip without rows: the sync queue trigger fires on the flip and
		// the store builds the rows from what the envelope holds now.
		database.sqlite
			.prepare("UPDATE narrator_messages SET body_format = 2 WHERE id = ? AND body_format = 1")
			.run(envelope.id);
		return "changed";
	}
	const insertBlock = database.sqlite.prepare(
		`INSERT INTO narrator_blocks (id, message_id, ordinal, kind, subtype, phase, revision, wire_id,
			model_chars, byte_size, created_at, completed_at, model_text, payload, state)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const addAsset = database.sqlite.prepare(
		"INSERT OR IGNORE INTO narrator_block_assets (block_id, asset_id, role) VALUES (?, ?, ?)",
	);
	const bindLedger = database.sqlite.prepare(
		`UPDATE narrator_tool_calls SET block_id = ?
		 WHERE message_id = ? AND tool_use_id = ? AND is_internal = 0`,
	);
	// A legacy envelope keeps no rows; clear any a crash left behind before writing its own.
	database.sqlite.prepare("DELETE FROM narrator_blocks WHERE message_id = ?").run(envelope.id);
	for (const [ordinal, block] of envelope.blocks.entries()) {
		const id = generateId();
		insertBlock.run(
			id,
			envelope.id,
			ordinal,
			block.kind,
			block.subtype,
			block.phase,
			block.wireId,
			block.modelChars,
			block.byteSize,
			envelope.createdAt,
			block.phase === "open" ? null : envelope.createdAt,
			block.modelText,
			block.payload,
			block.state,
		);
		for (const [assetId, role] of block.assets) addAsset.run(id, assetId, role);
		if (block.kind === "tool" && block.wireId) bindLedger.run(id, envelope.id, block.wireId);
		if (block.indexText) replaceBlockIndexText(database.sqlite, id, block.indexText);
	}
	// Last: the flip queues a sync, which these rows already are.
	database.sqlite
		.prepare(
			"UPDATE narrator_messages SET body_bytes = ?, body_format = 2 WHERE id = ? AND body_format = 1",
		)
		.run(envelope.bodyBytes, envelope.id);
	database.sqlite
		.prepare("DELETE FROM narrator_block_sync_queue WHERE message_id = ?")
		.run(envelope.id);
	return "converted";
}

const slowLog = hotSafe("narrator-block-backfill:slow-log", () => ({ at: 0, suppressed: 0 }));

/** Hold the jobs' next write transaction back in proportion to this one (`applyTurn`). */
function paceAfter(elapsedMs: number): void {
	pace.notBefore = performance.now() + Math.min(MAX_PACE_MS, elapsedMs * APPLY_PACE_FACTOR);
}

/** At most one line a minute: a run of large envelopes would otherwise log every slice. */
function noteSlow(job: BlockJob, elapsedMs: number, detail: Record<string, number>): void {
	const now = Date.now();
	if (now - slowLog.at < SLOW_LOG_INTERVAL_MS) {
		slowLog.suppressed++;
		return;
	}
	logger.warn("Slow block backfill transaction", {
		job,
		elapsedMs: Math.round(elapsedMs),
		...detail,
		suppressedSinceLast: slowLog.suppressed,
	});
	slowLog.at = now;
	slowLog.suppressed = 0;
}

/** After a slice's one write transaction: pace, and size the next slice by how long it took. */
function adapt(job: BlockJob, elapsedMs: number, envelopes: number): void {
	paceAfter(elapsedMs);
	if (elapsedMs > APPLY_TARGET_MS) {
		state.sliceEnvelopes = Math.max(MIN_SLICE_ENVELOPES, Math.floor(state.sliceEnvelopes / 2));
		noteSlow(job, elapsedMs, { envelopes, nextSlice: state.sliceEnvelopes });
	} else {
		state.sliceEnvelopes = Math.min(MAX_SLICE_ENVELOPES, state.sliceEnvelopes * 2);
	}
}

async function convertSlice(reader: SliceReader): Promise<void> {
	const job = jobState("convert");
	const slice = await reader.backfill({
		kind: "blockBackfillSlice",
		afterRowid: job.cursor,
		maxEnvelopes: state.sliceEnvelopes,
		maxSourceBytes: MAX_SLICE_SOURCE_BYTES,
		budgetMs: SLICE_BUDGET_MS,
	});
	await applyTurn();
	const started = performance.now();
	const outcomes = database.sqlite.transaction(() => {
		const applied = slice.envelopes.map(applyEnvelope);
		advance("convert", slice.lastRowid, slice.envelopes.length, slice.done);
		return applied;
	})();
	adapt("convert", performance.now() - started, slice.envelopes.length);
	// Stale plans were flipped for the store to build; let it do so now, a few at a time.
	if (outcomes.includes("changed"))
		database.sqlite.transaction(() => {
			for (const [index, envelope] of slice.envelopes.entries())
				if (outcomes[index] === "changed") syncEnvelopeNow(envelope.id);
		})();
}

async function verifySlice(reader: SliceReader): Promise<void> {
	const job = jobState("verify");
	const slice = await reader.verify({
		kind: "blockVerifySlice",
		afterRowid: job.cursor,
		maxEnvelopes: state.sliceEnvelopes,
		maxSourceBytes: MAX_SLICE_SOURCE_BYTES,
		budgetMs: SLICE_BUDGET_MS,
	});
	await applyTurn();
	const started = performance.now();
	database.sqlite.transaction(() => {
		const pending = database.sqlite.prepare(
			"SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?",
		);
		for (const id of slice.mismatched) {
			// Queued envelopes are about to be synced; they are not a dual-write failure.
			if (pending.get(id)) continue;
			recordDiagnostic(id, "mismatch", "block rows did not assemble to content_json");
			resyncFromColumn(id);
		}
		advance("verify", slice.lastRowid, slice.checked, slice.done);
	})();
	adapt("verify", performance.now() - started, slice.checked);
	if (slice.mismatched.length)
		logger.warn("Block rows differed from their envelope; recorded and re-synced", {
			messageIds: slice.mismatched,
		});
}

/** How far a reindex slice's writes have got: an envelope, and a block of it. */
interface ReindexPosition {
	envelope: number;
	block: number;
}

/**
 * One slice of `reindex`: a db-worker computes the index text the next envelopes' blocks lack
 * (entries the store wrote are right as they are); the main thread writes it a block at a
 * time, in transactions that end at their index text budget (`REINDEX_TX_CHARS`) or past
 * `APPLY_TARGET_MS` and are paced like every job's, so an envelope with megabytes of tool
 * output spans several. The cursor moves past an envelope once all of it is written; a
 * restart redoes a partial one.
 */
async function reindexSlice(reader: SliceReader): Promise<void> {
	const job = jobState("reindex");
	// Before the read: a sync the worker cannot have seen is recorded from here on.
	const watch = watchSyncs();
	try {
		const slice = await reader.reindex({
			kind: "blockReindexSlice",
			afterRowid: job.cursor,
			maxEnvelopes: MAX_SLICE_ENVELOPES,
			maxSourceBytes: MAX_SLICE_SOURCE_BYTES,
			maxIndexChars: REINDEX_SLICE_INDEX_CHARS,
			budgetMs: SLICE_BUDGET_MS,
		});
		const at: ReindexPosition = { envelope: 0, block: 0 };
		let cursor = job.cursor;
		do {
			await applyTurn();
			const budget = reindexBudget.chars;
			const started = performance.now();
			const written = database.sqlite.transaction(() => {
				// Paused, or sent back to the start, while this slice was being written.
				const current = jobState("reindex");
				if (current.paused || current.complete || current.cursor !== cursor) return null;
				const done = writeReindexed(slice.envelopes, at, watch.synced, started, budget);
				if (done.envelopes > 0) cursor = slice.envelopes[at.envelope - 1].rowid;
				const complete = slice.done && at.envelope === slice.envelopes.length;
				if (complete) cursor = slice.lastRowid;
				advance("reindex", cursor, done.envelopes, complete);
				return done;
			})();
			if (!written) return;
			const elapsedMs = performance.now() - started;
			paceAfter(elapsedMs);
			// Sized by the whole transaction, its commit included; grown only by one that used
			// its budget.
			if (elapsedMs > APPLY_TARGET_MS)
				reindexBudget.chars = Math.max(REINDEX_TX_CHARS.min, Math.floor(budget / 2));
			else if (elapsedMs < APPLY_TARGET_MS / 2 && written.indexChars >= budget)
				reindexBudget.chars = Math.min(REINDEX_TX_CHARS.max, Math.ceil(budget * 1.25));
			// One well past the target: a merge fell due at its commit, or one block or one
			// envelope's sync took that long.
			if (elapsedMs > 2 * APPLY_TARGET_MS)
				noteSlow("reindex", elapsedMs, { ...written, nextChars: reindexBudget.chars });
		} while (at.envelope < slice.envelopes.length);
	} finally {
		watch.stop();
	}
}

/**
 * Write a reindex slice's text from `at` on, inside the caller's transaction, until done, at
 * `maxChars` of index text, or past `APPLY_TARGET_MS` (at least one block or envelope each
 * time). An envelope synced or queued since the read began, or whose rows moved, is synced
 * here instead, which computes the same text from what it holds now (rare: only envelopes
 * written while the slice was read or written). Every envelope is checked again in each
 * transaction that writes some of it.
 */
function writeReindexed(
	envelopes: ReindexEnvelope[],
	at: ReindexPosition,
	synced: ReadonlySet<string>,
	started: number,
	maxChars: number,
): { envelopes: number; blocks: number; indexChars: number; resynced: number } {
	const rows = database.sqlite.prepare(
		"SELECT rowid, id, revision FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal",
	);
	const queued = database.sqlite.prepare(
		"SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?",
	);
	// A block owed its text is the index queue's to write, from what it holds then.
	const owed = database.sqlite.prepare(
		"SELECT 1 FROM narrator_block_index_queue WHERE block_id = ?",
	);
	const done = { envelopes: 0, blocks: 0, indexChars: 0, resynced: 0 };
	const spent = () =>
		done.envelopes + done.blocks > 0 &&
		(done.indexChars >= maxChars || performance.now() - started > APPLY_TARGET_MS);
	while (at.envelope < envelopes.length && !spent()) {
		const envelope = envelopes[at.envelope];
		const current = rows.all(envelope.id) as Array<{ rowid: number; id: string; revision: number }>;
		const asRead =
			!envelope.resync &&
			!synced.has(envelope.id) &&
			!queued.get(envelope.id) &&
			current.length === envelope.blocks.length &&
			current.every((row, ordinal) => {
				const block = envelope.blocks[ordinal];
				return row.rowid === block.rowid && row.id === block.id && row.revision === block.revision;
			});
		if (asRead) {
			// Only the entries the index lacks, in rowid order: FTS5 flushes its pending terms
			// whenever a write goes back.
			const blocks = envelope.blocks
				.filter((block): block is typeof block & { text: string } => block.text !== null)
				.sort((a, b) => a.rowid - b.rowid);
			while (at.block < blocks.length && !spent()) {
				const block = blocks[at.block++];
				if (owed.get(block.id)) continue;
				replaceBlockIndexRow(database.sqlite, block.rowid, block.text);
				done.blocks++;
				done.indexChars += block.text.length;
			}
			if (at.block < blocks.length) break;
		} else {
			reindexEnvelope(envelope.id);
			done.resynced++;
		}
		at.envelope++;
		at.block = 0;
		done.envelopes++;
	}
	return done;
}

/**
 * Run one slice of whichever job has work: convert first, then verify, then reindex.
 * Returns whether a slice ran (false when all are complete or paused).
 */
export async function runBlockJobSlice(reader: SliceReader = workerReader): Promise<boolean> {
	if (!hasSchema()) return false;
	const convert = jobState("convert");
	if (!convert.complete) {
		// Block writes off is the rollback switch: no envelope becomes block-format.
		if (convert.paused || !settings.narratorBlocks.write) return false;
		await convertSlice(reader);
		return true;
	}
	const verify = jobState("verify");
	if (!verify.complete) {
		if (verify.paused) return false;
		await verifySlice(reader);
		return true;
	}
	const reindex = jobState("reindex");
	if (reindex.complete || reindex.paused) return false;
	await reindexSlice(reader);
	return true;
}

/**
 * Legacy envelopes can appear after convert finished: written while block writes were off,
 * or imported. Send the job back to the first one it can convert; the ones it could not
 * read stay legacy for good and do not count.
 */
export function rearmBlockConvert(): void {
	if (!jobState("convert").complete) return;
	const first = database.sqlite
		.prepare(
			`SELECT min(m.rowid) AS rowid FROM narrator_messages m INDEXED BY idx_messages_legacy_body
			 WHERE m.body_format = 1 AND NOT EXISTS (
				SELECT 1 FROM narrator_block_diagnostics d
				WHERE d.message_id = m.id AND d.kind = 'undecodable')`,
		)
		.get() as { rowid: number | null };
	if (first.rowid === null) return;
	database.sqlite
		.prepare(
			"UPDATE narrator_block_backfill SET cursor = ?, complete = 0, updated_at = ? WHERE job = 'convert'",
		)
		.run(first.rowid - 1, new Date().toISOString());
}

/** Start the jobs in the background, if they have work; a no-op while they already run. */
export function startBlockBackfill(): void {
	if (!hasSchema()) return;
	// A projection job started before a restart resumes where it was.
	startProjectionRunner();
	if (state.running) return;
	rearmBlockConvert();
	state.running = true;
	const next = () => {
		runBlockJobSlice()
			.then((ran) => {
				if (ran) setTimeout(next, 0);
				else state.running = false;
			})
			.catch((error) => {
				state.running = false;
				logger.warn("Block backfill stopped; it resumes at the next start", {
					error: String(error),
				});
			});
	};
	setTimeout(next, 0);
}

export interface BlockBackfillStatus {
	available: boolean;
	convert: BlockJobState | null;
	verify: BlockJobState | null;
	reindex: BlockJobState | null;
	clear: BlockJobState | null;
	restore: BlockJobState | null;
	/** What a projection job needs that is missing (`projectionBlocked`), or null. */
	blocked: { clear: ProjectionBlock | null; restore: ProjectionBlock | null };
	/** Some envelope is rows-only: block reads stay on whatever the read switch says. */
	rowsOnly: boolean;
	projectionRunning: boolean;
	/** The newest `narrator_messages.rowid`: cursors are read as progress against it. */
	maxRowid: number;
	diagnostics: number;
	running: boolean;
}

export function blockBackfillStatus(): BlockBackfillStatus {
	if (!hasSchema())
		return {
			available: false,
			convert: null,
			verify: null,
			reindex: null,
			clear: null,
			restore: null,
			blocked: { clear: "unavailable", restore: "unavailable" },
			rowsOnly: false,
			projectionRunning: false,
			maxRowid: 0,
			diagnostics: 0,
			running: false,
		};
	const maxRowid =
		(
			database.sqlite.prepare("SELECT max(rowid) AS n FROM narrator_messages").get() as {
				n: number | null;
			}
		).n ?? 0;
	const diagnostics = (
		database.sqlite
			.prepare("SELECT count(*) AS n FROM (SELECT 1 FROM narrator_block_diagnostics LIMIT 10000)")
			.get() as { n: number }
	).n;
	return {
		available: true,
		convert: jobState("convert"),
		verify: jobState("verify"),
		reindex: jobState("reindex"),
		clear: jobState("clear"),
		restore: jobState("restore"),
		blocked: { clear: projectionBlocked("clear"), restore: projectionBlocked("restore") },
		rowsOnly: rowsOnlyEnvelopesExist(),
		projectionRunning: projection.running,
		maxRowid,
		diagnostics,
		running: state.running,
	};
}

/** Pause or resume the background jobs; resuming restarts them. */
export function setBlockBackfillPaused(paused: boolean): BlockBackfillStatus {
	if (hasSchema()) {
		jobState("convert");
		jobState("verify");
		jobState("reindex");
		database.sqlite
			.prepare(
				"UPDATE narrator_block_backfill SET paused = ?, updated_at = ? WHERE job IN ('convert', 'verify', 'reindex')",
			)
			.run(paused ? 1 : 0, new Date().toISOString());
		if (!paused) startBlockBackfill();
	}
	return blockBackfillStatus();
}

/** Why a projection job cannot run now. */
export type ProjectionBlock =
	| "unavailable"
	| "compact_json_off"
	| "compact_json_on"
	| "backfill_incomplete";

/**
 * What `job` needs that is missing: `clear` runs only where new envelopes are written
 * rows-only too (`rowsOnlyWrites`) and every envelope's rows were built and verified;
 * `restore` only where they are not, or it would never finish.
 */
function projectionBlocked(job: ProjectionJob): ProjectionBlock | null {
	if (!hasSchema()) return "unavailable";
	if (job === "restore") return rowsOnlyWrites() ? "compact_json_on" : null;
	if (!rowsOnlyWrites()) return "compact_json_off";
	return jobState("convert").complete && jobState("verify").complete ? null : "backfill_incomplete";
}

function pauseProjection(job: ProjectionJob): void {
	database.sqlite
		.prepare("UPDATE narrator_block_backfill SET paused = 1, updated_at = ? WHERE job = ?")
		.run(new Date().toISOString(), job);
}

/**
 * Start (or resume) a projection job in the background; the other one stops where it is.
 * A finished job starts over from the first envelope. `read` replaces the db-worker (tests).
 */
export function startProjectionJob(
	job: ProjectionJob,
	read: ProjectionReader = workerProjectionReader,
): BlockBackfillStatus {
	const blocked = projectionBlocked(job);
	if (blocked)
		throw new AppError(`Cannot ${job} projections: ${blocked}`, 409, "BLOCK_PROJECTION_BLOCKED");
	for (const name of PROJECTION_JOBS) jobState(name);
	pauseProjection(job === "clear" ? "restore" : "clear");
	database.sqlite
		.prepare(
			`UPDATE narrator_block_backfill SET paused = 0, updated_at = ?,
				cursor = CASE WHEN complete THEN 0 ELSE cursor END,
				processed = CASE WHEN complete THEN 0 ELSE processed END, complete = 0
			 WHERE job = ?`,
		)
		.run(new Date().toISOString(), job);
	startProjectionRunner(read);
	return blockBackfillStatus();
}

/** Stop whichever projection job runs, where it is; starting it again resumes it. */
export function stopProjectionJobs(): BlockBackfillStatus {
	if (hasSchema()) for (const job of PROJECTION_JOBS) pauseProjection(job);
	return blockBackfillStatus();
}

/** The projection job that was started and has not finished, if any. */
function activeProjection(): ProjectionJob | undefined {
	return PROJECTION_JOBS.find((job) => {
		const current = jobState(job);
		return !current.complete && !current.paused;
	});
}

/** After a read: the job was not stopped meanwhile, and still has what it needs. */
function stillRunning(job: ProjectionJob): boolean {
	return activeProjection() === job && !projectionBlocked(job);
}

async function clearSlice(read: ProjectionReader): Promise<void> {
	const job = jobState("clear");
	const slice = await read({
		kind: "blockProjectionSlice",
		job: "clear",
		afterRowid: job.cursor,
		maxEnvelopes: state.sliceEnvelopes,
		maxSourceBytes: MAX_SLICE_SOURCE_BYTES,
		budgetMs: SLICE_BUDGET_MS,
	});
	await applyTurn();
	if (!stillRunning("clear")) return;
	const started = performance.now();
	const cleared = database.sqlite.transaction(() => {
		// Only as read: not rewritten, not waiting on its sync, still with its projection.
		const clear = database.sqlite.prepare(
			`UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1,
				state_revision = state_revision + 1
			 WHERE id = ? AND body_format = 2 AND body_rows_only = 0 AND body_revision = ?
				AND state_revision = ?
				AND NOT EXISTS (SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?)`,
		);
		let count = 0;
		for (const envelope of slice.envelopes)
			count += clear.run(
				envelope.id,
				envelope.bodyRevision,
				envelope.stateRevision,
				envelope.id,
			).changes;
		const pending = database.sqlite.prepare(
			"SELECT 1 FROM narrator_block_sync_queue WHERE message_id = ?",
		);
		for (const id of slice.mismatched) {
			if (pending.get(id)) continue;
			recordDiagnostic(id, "mismatch", "block rows did not assemble to content_json");
			resyncFromColumn(id);
		}
		advance("clear", slice.lastRowid, count, slice.done);
		return count;
	})();
	if (cleared) noteRowsOnlyEnvelopes(true);
	adapt("clear", performance.now() - started, slice.envelopes.length);
}

async function restoreSlice(read: ProjectionReader): Promise<void> {
	const job = jobState("restore");
	if (job.cursor === 0) projection.pass = { fromStart: true, restored: 0 };
	const slice = await read({
		kind: "blockProjectionSlice",
		job: "restore",
		afterRowid: job.cursor,
		maxEnvelopes: state.sliceEnvelopes,
		maxSourceBytes: MAX_SLICE_SOURCE_BYTES,
		budgetMs: SLICE_BUDGET_MS,
	});
	await applyTurn();
	if (!stillRunning("restore")) return;
	const started = performance.now();
	const outcome = database.sqlite.transaction(() => {
		// Only as read: the same revisions and the same rows (a state rewrite by the sync
		// moves neither revision), and still rows-only (a write since stored its own).
		const write = database.sqlite.prepare(
			`UPDATE narrator_messages SET content_json = ?, body_rows_only = 0,
				state_revision = state_revision + 1
			 WHERE id = ? AND body_rows_only = 1 AND body_revision = ? AND state_revision = ?`,
		);
		let count = 0;
		for (const envelope of slice.envelopes)
			if (rowsSignature(database.sqlite, envelope.id) === envelope.rows)
				count += write.run(
					envelope.json ?? "[]",
					envelope.id,
					envelope.bodyRevision,
					envelope.stateRevision,
				).changes;
		projection.pass.restored += count;
		if (!slice.done) {
			advance("restore", slice.lastRowid, count, false);
			return "more";
		}
		// The end of a pass: done once none is left. Ones that changed under it are taken by
		// another pass, as long as passes make progress.
		if (!hasRowsOnlyBodies(database.sqlite)) {
			advance("restore", slice.lastRowid, count, true);
			return "complete";
		}
		const { fromStart, restored } = projection.pass;
		advance("restore", 0, count, false);
		return fromStart && restored === 0 ? "stuck" : "more";
	})();
	adapt("restore", performance.now() - started, slice.envelopes.length);
	if (outcome === "complete") noteRowsOnlyEnvelopes(undefined);
	if (outcome === "stuck") {
		pauseProjection("restore");
		logger.warn("Projection restore made no progress in a full pass; stopped", {});
	}
}

/**
 * Run one slice of the started projection job. Returns whether one ran (false when none is
 * started, or what it needs went away — then it stops where it is).
 */
export async function runProjectionSlice(
	read: ProjectionReader = workerProjectionReader,
): Promise<boolean> {
	if (!hasSchema()) return false;
	const job = activeProjection();
	if (!job) return false;
	const blocked = projectionBlocked(job);
	if (blocked) {
		pauseProjection(job);
		logger.warn("Projection job stopped: what it needs is missing", { job, blocked });
		return false;
	}
	if (job === "clear") await clearSlice(read);
	else await restoreSlice(read);
	return true;
}

function startProjectionRunner(read: ProjectionReader = workerProjectionReader): void {
	if (projection.running || !hasSchema() || !activeProjection()) return;
	projection.running = true;
	const next = () => {
		runProjectionSlice(read)
			.then((ran) => {
				if (ran) setTimeout(next, 0);
				else projection.running = false;
			})
			.catch((error) => {
				projection.running = false;
				logger.warn("Projection job stopped; start it again from the storage page", {
					error: String(error),
				});
			});
	};
	setTimeout(next, 0);
}
