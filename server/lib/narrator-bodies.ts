/**
 * narrator-bodies.ts — where a stored envelope's body is read from
 * (docs/BLOCK_STORAGE-DESIGN.md §10.1, P2).
 *
 * A block-format envelope (`body_format = 2`) keeps its body as block rows, which
 * readers assemble. `content_json` holds the same content while both are written, and is
 * still the body of legacy envelopes; a rows-only envelope (`body_rows_only = 1`, P3b)
 * keeps `[]` there and its rows are its only copy. A reader selects `bodySql(alias)` where
 * it used to select `content_json`, and `readBodies` fills in what that left out:
 *
 *   - `bodySql` is NULL for an envelope whose rows hold its body — a rows-only one always,
 *     any other block-format one once its rows are current — and `content_json`
 *     otherwise: a legacy envelope, one whose sync is still queued (a write outside the
 *     store, rows not rebuilt yet), or one without rows (empty or unreadable content);
 *   - `readBodies` assembles the NULL ones from their rows in one query per batch.
 *
 * With the read switch off (`fromBlocks` false) both reduce to plain `content_json`.
 * Takes an explicit connection, so it runs in db-workers too.
 */

import type { Database } from "bun:sqlite";
import { parseStored } from "@shared/narrator-blocks/plan";
import { isHistoryProtectedContent } from "@shared/narrator-blocks/retention";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { assembledBodyLengthSql } from "./narrator-body-length";

const blockStorage = new WeakMap<Database, boolean>();

/**
 * Whether the database has block storage at all; a connection to a schema predating it
 * (or a test fixture without it) keeps reading `content_json`.
 */
export function hasBlockStorage(db: Database): boolean {
	let known = blockStorage.get(db);
	if (known === undefined) {
		known = !!db
			.query(
				"SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'narrator_block_sync_queue' LIMIT 1",
			)
			.get();
		blockStorage.set(db, known);
	}
	return known;
}

/**
 * Whether a block-format body keeps its `content_json` projection with rows-only writes on:
 * a compact marker (compact, plan, clear, segment compact), whose lifecycle is read from
 * the column (the `compact_pending` column behind startup recovery and fork exclusion),
 * or a retention fence, which late/checkpoint writers must check without reading a large body.
 */
export function keepsProjection(content: unknown[]): boolean {
	const type = (content[0] as { type?: unknown } | undefined)?.type;
	return type === "compact" || type === "segment_compact" || isHistoryProtectedContent(content);
}

/**
 * Whether the database holds rows-only envelopes (P3b): their `content_json` holds no body,
 * so they are read from their rows whatever the read switch says. Answered by the partial
 * index `idx_messages_rows_only`, which holds exactly these.
 */
export function hasRowsOnlyBodies(db: Database): boolean {
	return (
		hasBlockStorage(db) &&
		!!db.query("SELECT 1 FROM narrator_messages WHERE body_rows_only = 1 LIMIT 1").get()
	);
}

/**
 * Whether the envelope at `alias` reads from its block rows: it is rows-only, or its rows
 * are current (no write outside the store waits on the sync, and it has rows).
 */
export function blocksCurrentSql(alias: string): string {
	return `(${alias}.body_format = 2 AND (${alias}.body_rows_only = 1
		OR (NOT EXISTS (SELECT 1 FROM narrator_block_sync_queue q WHERE q.message_id = ${alias}.id)
			AND EXISTS (SELECT 1 FROM narrator_blocks b WHERE b.message_id = ${alias}.id))))`;
}

/** The column a reader selects in place of `content_json` (see the module comment). */
export function bodySql(alias: string, fromBlocks: boolean): string {
	if (!fromBlocks) return `${alias}.content_json`;
	return `CASE WHEN ${blocksCurrentSql(alias)} THEN NULL ELSE ${alias}.content_json END`;
}

/**
 * The stored size of an envelope's body, for sizing read batches: `body_bytes` for a
 * block-format envelope (the sum of its rows), so `content_json` is not read just to be
 * measured; the length of `content_json` otherwise. `body_bytes` may exceed what the body
 * measures (an input's text is stored again as its model text), which only makes batches
 * smaller; a limit on the body itself uses `storedBodyBytesSql`, which is exact.
 */
export function bodyBytesSql(alias: string, fromBlocks: boolean): string {
	const json = `length(CAST(${alias}.content_json AS BLOB))`;
	if (!fromBlocks) return json;
	return `CASE WHEN ${alias}.body_format = 2 AND ${alias}.body_bytes > 0
		THEN ${alias}.body_bytes ELSE ${json} END`;
}

/**
 * The UTF-8 length of the envelope's body as readers read it: of the array its rows
 * assemble to when they hold it (`assembledBodyLengthSql`, exactly what `content_json`
 * measures), of `content_json` otherwise.
 */
export function bodyLengthSql(alias: string, fromBlocks: boolean): string {
	const json = `octet_length(${alias}.content_json)`;
	if (!fromBlocks) return json;
	return `(CASE WHEN ${blocksCurrentSql(alias)} THEN ${assembledBodyLengthSql(`${alias}.id`, "bytes")} ELSE ${json} END)`;
}

/**
 * An envelope's body as stored text, read as readers read it and only within bounds:
 * `content_json`, or its rows assembled and serialized (the same length, `bodyLengthSql`).
 * The length is checked before the body is read; `exactBytes` also requires that length.
 * Undefined when there is no such envelope or its body is outside the bounds.
 */
export function boundedBodyText(
	db: Database,
	messageId: string,
	fromBlocks: boolean,
	bounds: { maxBytes: number; exactBytes?: number },
): string | undefined {
	const measured = db
		.query<{ inBlocks: number; bytes: number | null }, [string]>(
			`SELECT ${fromBlocks ? blocksCurrentSql("m") : "0"} AS inBlocks,
				${bodyLengthSql("m", fromBlocks)} AS bytes
			 FROM narrator_messages m WHERE m.id = ? LIMIT 1`,
		)
		.get(messageId);
	const within = (bytes: number | null | undefined): bytes is number =>
		typeof bytes === "number" &&
		bytes <= bounds.maxBytes &&
		(bounds.exactBytes === undefined || bytes === bounds.exactBytes);
	if (!measured || !within(measured.bytes)) return undefined;
	if (!measured.inBlocks)
		return (
			db
				.query<{ body: string }, [string, number]>(
					"SELECT content_json AS body FROM narrator_messages WHERE id = ? AND octet_length(content_json) = ? LIMIT 1",
				)
				.get(messageId, measured.bytes)?.body ?? undefined
		);
	const text = JSON.stringify(blockBodies(db, [messageId]).get(messageId) ?? []);
	return Buffer.byteLength(text) === measured.bytes ? text : undefined;
}

const ID_BATCH = 500;

/**
 * Each envelope's block rows, assembled into the array they store, by message id.
 * `charge` sees each stored payload and state before it is parsed, for readers that
 * budget what they decode.
 */
export function blockBodies(
	db: Database,
	messageIds: readonly string[],
	charge?: (stored: string) => void,
): Map<string, unknown[]> {
	const rows = new Map<string, Array<{ payload: unknown; state: unknown }>>();
	for (let start = 0; start < messageIds.length; start += ID_BATCH) {
		const ids = messageIds.slice(start, start + ID_BATCH);
		const batch = db
			.query(
				`SELECT message_id AS messageId, payload, state FROM narrator_blocks
				 WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, ordinal`,
			)
			.all(...ids) as Array<{ messageId: string; payload: string; state: string | null }>;
		for (const row of batch) {
			if (charge) {
				charge(row.payload);
				if (row.state !== null) charge(row.state);
			}
			const list = rows.get(row.messageId) ?? [];
			list.push({ payload: parseStored(row.payload), state: parseStored(row.state) });
			rows.set(row.messageId, list);
		}
	}
	return new Map([...rows].map(([id, list]) => [id, assembleContent(list)]));
}

/**
 * The parsed body of each row that selected `bodySql`: assembled from block rows where
 * it came back NULL, parsed from `content_json` otherwise.
 */
export function readBodies(
	db: Database,
	rows: ReadonlyArray<{ id: string; body: string | null }>,
): Map<string, unknown> {
	const fromBlocks = rows.filter((row) => row.body === null).map((row) => row.id);
	const assembled = fromBlocks.length ? blockBodies(db, fromBlocks) : new Map();
	return new Map(
		rows.map((row) => [
			row.id,
			row.body === null ? (assembled.get(row.id) ?? []) : parseStored(row.body),
		]),
	);
}
