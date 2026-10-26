/**
 * Read side of the block jobs (docs/BLOCK_STORAGE-DESIGN.md §10.3), run in a read-only
 * db-worker so the main thread never decodes old message bodies:
 *
 *   - `blockBackfillSlice` plans the block rows of the next legacy (`body_format = 1`)
 *     envelopes; the main thread only inserts them.
 *   - `blockVerifySlice` checks block-format envelopes' rows against their stored content
 *     and names the ones that differ.
 *   - `blockReindexSlice` computes block-format envelopes' block search index text, as the
 *     sync would write it, for the main thread to write (P3c).
 *   - `blockIndexQueueSlice` computes the index text of the blocks the sync queued
 *     (`narrator_block_index_queue`), for the main thread to write.
 *   - `blockProjectionSlice` serves the admin-started projection jobs (P3b): `clear` names
 *     the envelopes whose rows assemble to their `content_json`, so the main thread can drop
 *     it; `restore` assembles rows-only envelopes' projections for it to write back.
 *
 * Each slice stops at whichever limit comes first: envelope count, source bytes, or time.
 * Like every worker module, this must not import `server/db/index.ts`.
 */

import type { Database } from "bun:sqlite";
import {
	adoptedLedger,
	blockAssets,
	blockIndexText,
	type PlanLedgerRow,
	parseStored,
	planEnvelopeBlocks,
} from "@shared/narrator-blocks/plan";
import { assembleContent, inAssembledOrder } from "@shared/narrator-blocks/storage";
import type { EnvelopeRole } from "@shared/narrator-blocks/types";
import { keepsProjection } from "../narrator-bodies";

export interface BlockSliceLimits {
	afterRowid: number;
	maxEnvelopes: number;
	maxSourceBytes: number;
	budgetMs: number;
}

export interface BlockBackfillSliceParams extends BlockSliceLimits {
	kind: "blockBackfillSlice";
}

export interface BlockVerifySliceParams extends BlockSliceLimits {
	kind: "blockVerifySlice";
}

export interface BlockReindexSliceParams extends BlockSliceLimits {
	kind: "blockReindexSlice";
	/** Index text a slice computes before it stops: what the main thread then writes. */
	maxIndexChars: number;
}

/** One envelope's blocks with the search text a sync gives them, as read. */
export interface ReindexEnvelope {
	id: string;
	rowid: number;
	/**
	 * In ordinal order. `text` is what to write for a block the index lacks (empty: it is still
	 * streaming and has an entry to drop); null leaves a block's entry as it is.
	 */
	blocks: Array<{ rowid: number; id: string; revision: number; text: string | null }>;
	/** Not computed here (queued for its sync, or its rows do not line up with its body):
	 *  the main thread syncs it itself. */
	resync: boolean;
}

export interface BlockIndexQueueSliceParams {
	kind: "blockIndexQueueSlice";
	/** Queued blocks a slice reads at most. */
	maxBlocks: number;
	/** Index text a slice computes before it stops (at least one envelope's). */
	maxIndexChars: number;
	budgetMs: number;
}

/** A queued block's index text as read: empty when the block has none (still streaming). */
export interface IndexQueueEntry {
	blockId: string;
	messageId: string;
	rowid: number;
	/** The queue entry's version when read; text from an older read is never written. */
	version: number;
	text: string;
}

export interface BlockIndexQueueSliceResult {
	entries: IndexQueueEntry[];
	/** Whether the queue held more than this slice read. */
	more: boolean;
}

export interface BlockReindexSliceResult {
	envelopes: ReindexEnvelope[];
	lastRowid: number;
	done: boolean;
}

export interface BlockProjectionSliceParams extends BlockSliceLimits {
	kind: "blockProjectionSlice";
	job: "clear" | "restore";
}

/** One planned row, ready to insert. */
export interface BackfillBlockRow {
	kind: string;
	subtype: string | null;
	phase: string;
	wireId: string | null;
	modelText: string | null;
	payload: string;
	state: string | null;
	modelChars: number;
	byteSize: number;
	/** Text for the block search index; null while the block is open (§4.6). */
	indexText: string | null;
	assets: Array<[assetId: string, role: string]>;
}

export interface BackfillEnvelope {
	id: string;
	rowid: number;
	createdAt: string;
	/** What the plan was read at; the apply skips an envelope that changed since. */
	bodyRevision: number;
	/** A state-only write (§5.4) moves this, not `bodyRevision`. */
	stateRevision: number;
	ledgerFingerprint: string;
	bodyBytes: number;
	/** Null when the stored content could not be read as an array of elements. */
	blocks: BackfillBlockRow[] | null;
}

export interface BlockBackfillSliceResult {
	envelopes: BackfillEnvelope[];
	/** The last rowid the slice looked at; the job resumes after it. */
	lastRowid: number;
	/** No envelopes are left after `lastRowid`. */
	done: boolean;
}

export interface BlockVerifySliceResult {
	/** Block-format envelopes whose rows do not assemble to their stored content. */
	mismatched: string[];
	checked: number;
	lastRowid: number;
	done: boolean;
}

/** An envelope a projection slice read, at the revisions it was read at. */
export interface ProjectionEnvelope {
	id: string;
	bodyRevision: number;
	stateRevision: number;
	/** `restore`: the array its rows assemble to, serialized. */
	json?: string;
	/** `restore`: `rowsSignature` of the rows it was assembled from. */
	rows?: string;
}

export interface BlockProjectionSliceResult {
	/** `clear`: envelopes whose rows assemble to their column. `restore`: their projections. */
	envelopes: ProjectionEnvelope[];
	/** `clear`: envelopes whose rows do not assemble to their column. */
	mismatched: string[];
	checked: number;
	lastRowid: number;
	done: boolean;
}

interface EnvelopeSource {
	rowid: number;
	id: string;
	narratorId: string;
	role: EnvelopeRole;
	contentJson: string | null;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid: string | null;
	origin: string | null;
	provider: string | null;
	createdAt: string;
	bodyRevision: number;
	stateRevision: number;
}

type Candidate = { rowid: number; bytes: number };

/** Rowids and sizes of the next candidates; bodies are read one at a time within the budget. */
function candidates(db: Database, params: BlockSliceLimits, bodyFormat: 1 | 2): Candidate[] {
	return db
		.query(
			// A literal format, so convert's candidates come from idx_messages_legacy_body.
			// Verify compares rows with the column, which a rows-only envelope (P3b) has none of.
			`SELECT rowid, coalesce(length(CAST(content_json AS BLOB)), 0) AS bytes
			 FROM narrator_messages WHERE rowid > ? AND body_format = ${bodyFormat === 1 ? 1 : 2}
				${bodyFormat === 1 ? "" : "AND body_rows_only = 0"}
			 ORDER BY rowid LIMIT ?`,
		)
		.all(params.afterRowid, params.maxEnvelopes) as Candidate[];
}

/** The next rows-only envelopes (through `idx_messages_rows_only`), sized by their body. */
function rowsOnlyCandidates(db: Database, params: BlockSliceLimits): Candidate[] {
	return db
		.query(
			`SELECT rowid, body_bytes AS bytes FROM narrator_messages
			 WHERE body_rows_only = 1 AND rowid > ? ORDER BY rowid LIMIT ?`,
		)
		.all(params.afterRowid, params.maxEnvelopes) as Candidate[];
}

/** Walk candidates within the slice's byte and time budget; at least one is always taken. */
function withinBudget<T>(
	params: BlockSliceLimits,
	rows: Candidate[],
	visit: (rowid: number) => T,
): { results: T[]; lastRowid: number; done: boolean } {
	const started = performance.now();
	const results: T[] = [];
	let lastRowid = params.afterRowid;
	let bytes = 0;
	for (const row of rows) {
		if (
			results.length > 0 &&
			(bytes + row.bytes > params.maxSourceBytes || performance.now() - started > params.budgetMs)
		)
			return { results, lastRowid, done: false };
		results.push(visit(row.rowid));
		bytes += row.bytes;
		lastRowid = row.rowid;
	}
	return { results, lastRowid, done: rows.length < params.maxEnvelopes };
}

function envelopeAt(db: Database, rowid: number): EnvelopeSource {
	return db
		.query(
			`SELECT rowid, id, narrator_id AS narratorId, role, content_json AS contentJson,
				content_text AS contentText, parent_tool_use_id AS parentToolUseId,
				sdk_message_uuid AS messageUuid, origin, provider, created_at AS createdAt,
				body_revision AS bodyRevision, state_revision AS stateRevision
			 FROM narrator_messages WHERE rowid = ?`,
		)
		.get(rowid) as EnvelopeSource;
}

function ledgerOf(db: Database, messageId: string): PlanLedgerRow[] {
	return db
		.query(
			`SELECT tool_use_id AS toolUseId, tool_name AS toolName, input_json AS inputJson,
				output_json AS outputJson, status
			 FROM narrator_tool_calls WHERE message_id = ? AND is_internal = 0
			 ORDER BY tool_use_id, execution_attempt, created_at, id`,
		)
		.all(messageId) as PlanLedgerRow[];
}

/** Changes whenever a ledger row of the message is added, removed or rewritten. */
export function ledgerFingerprint(db: Database, messageId: string): string {
	const row = db
		.query(
			`SELECT count(*) AS n, coalesce(sum(model_revision), 0) AS revisions
			 FROM narrator_tool_calls WHERE message_id = ?`,
		)
		.get(messageId) as { n: number; revisions: number };
	return `${row.n}:${row.revisions}`;
}

function planBackfill(db: Database, rowid: number): BackfillEnvelope {
	const source = envelopeAt(db, rowid);
	const base = {
		id: source.id,
		rowid: source.rowid,
		createdAt: source.createdAt,
		bodyRevision: source.bodyRevision,
		stateRevision: source.stateRevision,
		ledgerFingerprint: ledgerFingerprint(db, source.id),
	};
	const content = parseStored(source.contentJson);
	if (!Array.isArray(content)) return { ...base, bodyBytes: 0, blocks: null };
	const planned = planEnvelopeBlocks(
		{
			id: source.id,
			narratorId: source.narratorId,
			role: source.role,
			contentJson: content,
			contentText: source.contentText,
			parentToolUseId: source.parentToolUseId,
			messageUuid: source.messageUuid,
			origin: source.origin,
			provider: source.provider,
		},
		adoptedLedger(ledgerOf(db, source.id)),
	);
	return {
		...base,
		bodyBytes: planned.bodyBytes,
		blocks: planned.blocks.map((block) => ({
			kind: block.draft.kind,
			subtype: block.draft.subtype,
			phase: block.draft.phase,
			wireId: block.draft.wireId,
			modelText: block.draft.modelText,
			payload: block.payload,
			state: block.state,
			modelChars: block.modelChars,
			byteSize: block.byteSize,
			indexText:
				block.draft.phase === "open" ? null : blockIndexText(block.draft.canonical, block.output),
			assets: blockAssets(block.draft, block.output),
		})),
	};
}

export function runBlockBackfillSlice(
	db: Database,
	params: BlockBackfillSliceParams,
): BlockBackfillSliceResult {
	const { results, lastRowid, done } = withinBudget(params, candidates(db, params, 1), (rowid) =>
		planBackfill(db, rowid),
	);
	return { envelopes: results, lastRowid, done };
}

/** What an envelope's block rows assemble to. */
function assembledRows(db: Database, messageId: string): unknown[] {
	const rows = db
		.query("SELECT payload, state FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal")
		.all(messageId) as Array<{ payload: string; state: string | null }>;
	return assembleContent(
		rows.map((row) => ({ payload: parseStored(row.payload), state: parseStored(row.state) })),
	);
}

/** Whether rows assemble to exactly the stored array. */
function assemblesTo(db: Database, messageId: string, stored: unknown[]): boolean {
	return JSON.stringify(assembledRows(db, messageId)) === JSON.stringify(inAssembledOrder(stored));
}

/** Whether a block-format envelope's rows assemble to exactly what it stores. */
function rowsMatch(db: Database, rowid: number): { id: string; matches: boolean } {
	const envelope = db
		.query("SELECT id, content_json AS contentJson FROM narrator_messages WHERE rowid = ?")
		.get(rowid) as { id: string; contentJson: string | null };
	const stored = parseStored(envelope.contentJson);
	// Non-array content keeps no rows by design.
	if (!Array.isArray(stored)) return { id: envelope.id, matches: true };
	return { id: envelope.id, matches: assemblesTo(db, envelope.id, stored) };
}

export function runBlockVerifySlice(
	db: Database,
	params: BlockVerifySliceParams,
): BlockVerifySliceResult {
	const { results, lastRowid, done } = withinBudget(params, candidates(db, params, 2), (rowid) =>
		rowsMatch(db, rowid),
	);
	return {
		mismatched: results.filter((result) => !result.matches).map((result) => result.id),
		checked: results.length,
		lastRowid,
		done,
	};
}

type ProjectionVisit = { envelope?: ProjectionEnvelope; mismatched?: string };

/**
 * `clear`: an envelope whose projection can go — an array that is not a compact marker,
 * not waiting on its sync, whose rows assemble to it exactly. A mismatch is named instead.
 */
function clearable(db: Database, rowid: number): ProjectionVisit {
	const row = db
		.query(
			`SELECT m.id, m.content_json AS contentJson, m.body_revision AS bodyRevision,
				m.state_revision AS stateRevision,
				EXISTS (SELECT 1 FROM narrator_block_sync_queue q WHERE q.message_id = m.id) AS queued
			 FROM narrator_messages m WHERE m.rowid = ?`,
		)
		.get(rowid) as {
		id: string;
		contentJson: string | null;
		bodyRevision: number;
		stateRevision: number;
		queued: number;
	};
	// A queued envelope's rows are about to be rebuilt; a later run sees it settled.
	if (row.queued) return {};
	const stored = parseStored(row.contentJson);
	if (!Array.isArray(stored) || keepsProjection(stored)) return {};
	if (!assemblesTo(db, row.id, stored)) return { mismatched: row.id };
	const { id, bodyRevision, stateRevision } = row;
	return { envelope: { id, bodyRevision, stateRevision } };
}

/**
 * What an envelope's rows are, without reading their bodies: each row's id, revision (it
 * moves with the payload) and state size, in order. A state rewrite by the sync moves no
 * revision of the envelope's, so `restore` checks this too before writing what it read.
 */
export function rowsSignature(db: Database, messageId: string): string {
	return (
		(
			db
				.query(
					`SELECT group_concat(sig, ',') AS sig FROM (
					SELECT id || '.' || revision || '.' || coalesce(octet_length(state), -1) AS sig
					FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal)`,
				)
				.get(messageId) as { sig: string | null }
		).sig ?? ""
	);
}

/** `restore`: a rows-only envelope's projection, assembled from its rows. */
function restorable(db: Database, rowid: number): ProjectionVisit {
	const row = db
		.query(
			`SELECT id, body_revision AS bodyRevision, state_revision AS stateRevision
			 FROM narrator_messages WHERE rowid = ?`,
		)
		.get(rowid) as { id: string; bodyRevision: number; stateRevision: number };
	// Reads here are separate snapshots: rows that moved while being assembled are skipped
	// (a later run reads them settled), and revisions read before them make a stale apply fail.
	const rows = rowsSignature(db, row.id);
	const json = JSON.stringify(assembledRows(db, row.id));
	if (rowsSignature(db, row.id) !== rows) return {};
	return { envelope: { ...row, rows, json } };
}

export function runBlockProjectionSlice(
	db: Database,
	params: BlockProjectionSliceParams,
): BlockProjectionSliceResult {
	const { results, lastRowid, done } =
		params.job === "clear"
			? withinBudget(params, candidates(db, params, 2), (rowid) => clearable(db, rowid))
			: withinBudget(params, rowsOnlyCandidates(db, params), (rowid) => restorable(db, rowid));
	return {
		envelopes: results.flatMap((result) => (result.envelope ? [result.envelope] : [])),
		mismatched: results.flatMap((result) => (result.mismatched ? [result.mismatched] : [])),
		checked: results.length,
		lastRowid,
		done,
	};
}

/**
 * The index text the sync gives an envelope's blocks, for the blocks `wanted` picks: its body
 * assembled from its rows and planned with its ledger exactly as `syncEnvelope` plans it, each
 * planned block matched to the row at its ordinal. Undefined for an envelope queued for its
 * sync, or whose plan does not line up with its rows: the main thread's own sync handles it.
 */
function plannedTexts(
	db: Database,
	messageId: string,
	wanted: (row: { rowid: number; id: string; phase: string }) => boolean,
):
	| {
			rows: Array<{ rowid: number; id: string; revision: number; kind: string; phase: string }>;
			texts: Array<string | null>;
	  }
	| undefined {
	const source = db
		.query(
			`SELECT m.id, m.narrator_id AS narratorId, m.role, m.content_text AS contentText,
				m.parent_tool_use_id AS parentToolUseId, m.sdk_message_uuid AS messageUuid,
				m.origin, m.provider,
				EXISTS (SELECT 1 FROM narrator_block_sync_queue q WHERE q.message_id = m.id) AS queued
			 FROM narrator_messages m WHERE m.id = ?`,
		)
		.get(messageId) as
		| (Omit<
				EnvelopeSource,
				"rowid" | "contentJson" | "createdAt" | "bodyRevision" | "stateRevision"
		  > & { queued: number })
		| null;
	if (!source || source.queued) return undefined;
	// The columns before the payload: no block body is read for an envelope with nothing wanted.
	const rows = db
		.query(
			`SELECT rowid, id, revision, kind, phase FROM narrator_blocks
			 WHERE message_id = ? ORDER BY ordinal`,
		)
		.all(messageId) as Array<{
		rowid: number;
		id: string;
		revision: number;
		kind: string;
		phase: string;
	}>;
	const picked = rows.map(wanted);
	if (!picked.includes(true)) return { rows, texts: rows.map(() => null) };
	const bodies = db
		.query(
			"SELECT rowid, payload, state FROM narrator_blocks WHERE message_id = ? ORDER BY ordinal",
		)
		.all(messageId) as Array<{ rowid: number; payload: string; state: string | null }>;
	if (bodies.length !== rows.length || bodies.some((body, i) => body.rowid !== rows[i].rowid))
		return undefined;
	const content = assembleContent(
		bodies.map((body) => ({ payload: parseStored(body.payload), state: parseStored(body.state) })),
	);
	const { queued: _queued, ...message } = source;
	const planned = planEnvelopeBlocks(
		{ ...message, contentJson: content },
		adoptedLedger(ledgerOf(db, messageId)),
	).blocks;
	if (
		planned.length !== rows.length ||
		planned.some((plan, ordinal) => plan.draft.kind !== rows[ordinal].kind)
	)
		return undefined;
	return {
		rows,
		texts: rows.map((row, ordinal) =>
			!picked[ordinal]
				? null
				: row.phase === "open"
					? ""
					: blockIndexText(planned[ordinal].draft.canonical, planned[ordinal].output),
		),
	};
}

/**
 * An envelope's blocks with the text the sync's index write gives them, for the blocks whose
 * entry is missing (or, still streaming, should not be there). A block whose entry is owed is
 * queued (`narrator_block_index_queue`) and written by that queue's job, so an entry that
 * exists is right unless queued; what can be missing is a lost index's. An envelope with
 * nothing missing is not read further.
 */
function reindexPlan(
	db: Database,
	rowid: number,
	indexed: (blockRowid: number) => boolean,
): ReindexEnvelope {
	const { id } = db.query("SELECT id FROM narrator_messages WHERE rowid = ?").get(rowid) as {
		id: string;
	};
	const envelope = { id, rowid, blocks: [] as ReindexEnvelope["blocks"], resync: true };
	const planned = plannedTexts(db, id, (row) => indexed(row.rowid) === (row.phase === "open"));
	if (!planned) return envelope;
	return {
		...envelope,
		resync: false,
		blocks: planned.rows.map((row, ordinal) => ({
			rowid: row.rowid,
			id: row.id,
			revision: row.revision,
			text: planned.texts[ordinal],
		})),
	};
}

/**
 * `blockIndexQueueSlice`: the index text of the next queued blocks, oldest queued first,
 * computed per envelope as `plannedTexts` computes it. An envelope still queued for its sync
 * is skipped (its blocks stay queued). Stops at `maxIndexChars` or `budgetMs`, after at
 * least one envelope.
 */
export function runBlockIndexQueueSlice(
	db: Database,
	params: BlockIndexQueueSliceParams,
): BlockIndexQueueSliceResult {
	const queued = db
		.query(
			`SELECT q.block_id AS blockId, q.version, b.message_id AS messageId
			 FROM narrator_block_index_queue q JOIN narrator_blocks b ON b.id = q.block_id
			 ORDER BY q.rowid LIMIT ?`,
		)
		.all(params.maxBlocks + 1) as Array<{ blockId: string; version: number; messageId: string }>;
	const more = queued.length > params.maxBlocks;
	const byMessage = new Map<string, Map<string, number>>();
	for (const entry of queued.slice(0, params.maxBlocks)) {
		const versions = byMessage.get(entry.messageId) ?? new Map<string, number>();
		versions.set(entry.blockId, entry.version);
		byMessage.set(entry.messageId, versions);
	}
	const started = performance.now();
	const entries: IndexQueueEntry[] = [];
	let chars = 0;
	let read = 0;
	for (const [messageId, versions] of byMessage) {
		if (
			read > 0 &&
			(chars >= params.maxIndexChars || performance.now() - started > params.budgetMs)
		)
			return { entries, more: true };
		read++;
		const planned = plannedTexts(db, messageId, (row) => versions.has(row.id));
		if (!planned) continue;
		planned.rows.forEach((row, ordinal) => {
			const text = planned.texts[ordinal];
			const version = versions.get(row.id);
			if (text === null || version === undefined) return;
			entries.push({ blockId: row.id, messageId, rowid: row.rowid, version, text });
			chars += text.length;
		});
	}
	return { entries, more };
}

/**
 * `reindex`: the next block-format envelopes' missing index text, within the slice's envelope,
 * body byte, index text and time budgets (at least one envelope). Only envelopes whose body
 * was read count their `body_bytes` (which a rows-only envelope's column would not show).
 */
export function runBlockReindexSlice(
	db: Database,
	params: BlockReindexSliceParams,
): BlockReindexSliceResult {
	const rows = db
		.query(
			`SELECT rowid, body_bytes AS bytes FROM narrator_messages
			 WHERE rowid > ? AND body_format = 2 ORDER BY rowid LIMIT ?`,
		)
		.all(params.afterRowid, params.maxEnvelopes) as Candidate[];
	const index = db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'narrator_blocks_fts'")
		.get()
		? db.query("SELECT 1 FROM narrator_blocks_fts WHERE rowid = ?")
		: null;
	const indexed = (blockRowid: number) => !!index?.get(blockRowid);
	const started = performance.now();
	const envelopes: ReindexEnvelope[] = [];
	let lastRowid = params.afterRowid;
	let bytes = 0;
	let chars = 0;
	for (const row of rows) {
		if (
			envelopes.length > 0 &&
			(bytes >= params.maxSourceBytes ||
				chars >= params.maxIndexChars ||
				performance.now() - started > params.budgetMs)
		)
			return { envelopes, lastRowid, done: false };
		const envelope = reindexPlan(db, row.rowid, indexed);
		envelopes.push(envelope);
		if (envelope.blocks.some((block) => block.text !== null)) bytes += row.bytes;
		for (const block of envelope.blocks) chars += block.text?.length ?? 0;
		lastRowid = row.rowid;
	}
	return { envelopes, lastRowid, done: rows.length < params.maxEnvelopes };
}
