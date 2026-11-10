/** Read-only retention queries. This module must never bootstrap the database or settings. */
import type { Database } from "bun:sqlite";
import { clearedToolOutputSql } from "@shared/narrator-blocks/retention";
import { assembleContent } from "@shared/narrator-blocks/storage";
import {
	STORAGE_REPLAY_INPUT_TOOLS,
	type StorageHistoryCandidate,
	type StorageRetentionTarget,
} from "@shared/storage-retention";

export interface StorageHistoryBucket {
	day: string;
	count: number;
	approxBytes: number;
}
export type StorageHistoryReadParams =
	| {
			kind: "storageHistoryRead";
			mode: "buckets";
			target: StorageRetentionTarget;
			dayOffsetMs?: number;
	  }
	| {
			kind: "storageHistoryRead";
			mode: "candidates";
			target: StorageRetentionTarget;
			cutoffAt: string;
			afterRowid: number;
			limit: number;
	  };
export interface StorageHistoryBodyParams {
	kind: "storageHistoryBody";
	messageId: string;
	maxBytes: number;
	maxBlocks: number;
	holderIds?: string[];
}
export interface StorageHistoryBodyResult {
	revision: number;
	content: unknown[];
	compact: boolean;
	blocks: Array<{ id: string; revision: number; payload: unknown; state: unknown }>;
	/** Original edited body, under the same total read budget, for selective tool redaction. */
	originalContent?: unknown[] | null;
	contentText?: string | null;
	blocked?: boolean;
	holderIds?: string[];
}

const MAX_BUCKETS = 10_000;
export const STORAGE_HISTORY_CANDIDATE_LIMIT = 32;

/** Kept in one place so preview and candidate selection use identical semantics. */
function selection(target: StorageRetentionTarget) {
	if (target === "toolCallPayloads") {
		const replayTools = STORAGE_REPLAY_INPUT_TOOLS.map((name) => `'${name}'`).join(",");
		return {
			from: "narrator_tool_calls t",
			alias: "t",
			message: "t.message_id",
			revision: "t.model_revision",
			bytes: `CASE WHEN t.tool_name IN (${replayTools}) THEN 0
				ELSE length(CAST(coalesce(t.input_json, '') AS BLOB)) END +
				length(CAST(coalesce(t.output_json, '') AS BLOB))`,
			eligible: `t.is_file_history_checkpoint = 0 AND t.status IN ('success', 'fail')
				AND (t.input_json IS NOT NULL OR t.output_json IS NOT NULL)
				AND coalesce(${clearedToolOutputSql("t.output_json")}, 0) = 0`,
		};
	}
	return {
		from: "narrator_messages m",
		alias: "m",
		message: "m.id",
		revision: "m.body_revision",
		bytes: `CASE WHEN m.body_format = 2 THEN m.body_bytes ELSE 0 END +
			length(CAST(coalesce(m.content_json, '') AS BLOB)) +
			length(CAST(coalesce(m.content_text, '') AS BLOB)) +
			length(CAST(coalesce(m.original_content_json, '') AS BLOB)) +
			length(CAST(coalesce(m.composer_document, '') AS BLOB)) +
			length(CAST(coalesce(m.command_text, '') AS BLOB)) +
			coalesce((SELECT sum(length(CAST(coalesce(b.original_payload, '') AS BLOB)) +
				length(CAST(coalesce(b.provider_meta, '') AS BLOB)))
				FROM narrator_blocks b WHERE b.message_id = m.id), 0)`,
		eligible: `CASE WHEN json_valid(m.content_json)
			THEN coalesce(json_extract(m.content_json, '$[0].historyClearVersion'), 0) <> 1 ELSE 1 END
			AND NOT EXISTS (SELECT 1 FROM narrator_blocks b
				WHERE b.message_id = m.id AND b.ordinal = 0
				AND CASE WHEN json_valid(b.payload)
					THEN json_extract(b.payload, '$.raw[0].historyClearVersion') = 1 ELSE 0 END)
			AND (m.body_bytes > 0 OR m.content_json NOT IN ('[]', '', 'null'))`,
	};
}

export function runStorageHistoryRead(
	db: Database,
	params: StorageHistoryReadParams,
): StorageHistoryBucket[] | StorageHistoryCandidate[] {
	const s = selection(params.target);
	const fields = `count(*) AS count, coalesce(sum(${s.bytes}), 0) AS approxBytes`;
	if (params.mode === "buckets") {
		const offset = Math.max(0, Math.min(86_399_999, params.dayOffsetMs ?? 0));
		// Align buckets with the selected local midnight. Subsequent date changes reuse
		// the whole histogram rather than rescanning an unindexed partial UTC day.
		const rows = db
			.query(`SELECT strftime('%Y-%m-%d', ${s.alias}.created_at, ?) AS day, ${fields}
				FROM ${s.from} WHERE ${s.eligible}
				GROUP BY day ORDER BY day LIMIT ${MAX_BUCKETS + 1}`)
			.all(`-${offset / 1000} seconds`) as StorageHistoryBucket[];
		if (rows.length > MAX_BUCKETS) throw new Error("History date statistics exceeded their budget");
		return rows;
	}
	const limit = Math.max(1, Math.min(STORAGE_HISTORY_CANDIDATE_LIMIT, params.limit));
	return db
		.query(`SELECT ${s.alias}.rowid AS rowid, ${s.alias}.id AS id,
			${s.message} AS messageId, ${s.revision} AS revision, (${s.bytes}) AS approxBytes
			FROM ${s.from} WHERE ${s.eligible} AND ${s.alias}.rowid > ?
			AND ${s.alias}.created_at < ? ORDER BY ${s.alias}.rowid LIMIT ?`)
		.all(params.afterRowid, params.cutoffAt, limit) as StorageHistoryCandidate[];
}

/** Prepare a bounded authoritative body outside the HTTP/agent event loop. */
export function runStorageHistoryBody(
	db: Database,
	params: StorageHistoryBodyParams,
): StorageHistoryBodyResult | null {
	return db.transaction(() => readStorageHistoryBody(db, params))();
}

function loadHistoryHolders(db: Database, messageId: string): string[] | null {
	const rows = db
		.query(`WITH RECURSIVE holders(id, seq) AS (
		SELECT narrator_id, seq FROM narrator_message_refs WHERE message_id = ?
		UNION SELECT n.id, h.seq FROM narrators n JOIN holders h ON n.refs_inherited_from = h.id
		WHERE n.refs_backfill_cursor IS NOT NULL AND h.seq < n.refs_backfill_cursor
	), affected(id) AS (
		SELECT id FROM holders UNION SELECT narrator_id FROM narrator_messages WHERE id = ?
		UNION SELECT n.parent_narrator_id FROM narrators n JOIN affected a ON n.id = a.id
		WHERE n.parent_narrator_id IS NOT NULL
	) SELECT id FROM affected LIMIT 513`)
		.all(messageId, messageId) as Array<{ id: string }>;
	return rows.length > 512 ? null : rows.map((row) => row.id);
}
function historyProtectionBlocked(db: Database, params: StorageHistoryBodyParams): boolean {
	if (params.holderIds === undefined) return false;
	if (
		params.holderIds.length > 512 ||
		params.holderIds.some((id) => typeof id !== "string" || id.length > 64)
	)
		throw new Error("History protection lookup exceeded its holder budget");
	const ids = [...new Set(params.holderIds)];
	if (
		db
			.query("SELECT 1 FROM narrator_blocks WHERE message_id = ? AND phase = 'open' LIMIT 1")
			.get(params.messageId)
	)
		return true;
	if (
		db
			.query(`SELECT 1 FROM narrator_tool_calls WHERE message_id = ?
		AND status IN ('initializing', 'pending', 'running') LIMIT 1`)
			.get(params.messageId)
	)
		return true;
	const unfinished = `c.state <> 'cancelled' AND
		coalesce(json_extract(c.payload_json, '$.recoveryPhase'), '') <> 'owner_continuation_started'`;
	if (
		ids.length &&
		db
			.query(`SELECT 1 FROM narrator_tool_continuations c
		WHERE c.narrator_id IN (${ids.map(() => "?").join(",")}) AND ${unfinished} LIMIT 1`)
			.get(...ids)
	)
		return true;
	// Start from the much smaller continuation ledger, then resolve each tool by PK.
	// CROSS JOIN fixes SQLite's loop order; an unindexed result_message_id must not
	// make this probe walk the million-row tool payload table for every message.
	return !!db
		.query(`SELECT 1 FROM narrator_tool_continuations c
		CROSS JOIN narrator_tool_calls t WHERE t.id = c.tool_call_id
		AND ${unfinished} AND t.result_message_id = ? LIMIT 1`)
		.get(params.messageId);
}
function readStorageHistoryBody(
	db: Database,
	params: StorageHistoryBodyParams,
): StorageHistoryBodyResult | null {
	const maxBytes = Math.max(1, Math.min(4 * 1024 * 1024, params.maxBytes));
	const maxBlocks = Math.max(1, Math.min(1024, params.maxBlocks));
	const meta = db
		.query(`SELECT body_revision AS revision, body_format AS format, body_rows_only AS rowsOnly,
			length(CAST(content_json AS BLOB)) AS jsonBytes,
			coalesce(length(CAST(original_content_json AS BLOB)), 0) AS originalBytes,
			coalesce(length(CAST(content_text AS BLOB)), 0) AS textBytes,
			EXISTS(SELECT 1 FROM narrator_blocks b WHERE b.message_id = m.id) AS hasBlocks,
			EXISTS(SELECT 1 FROM narrator_block_sync_queue q WHERE q.message_id = m.id) AS queued
			FROM narrator_messages m WHERE id = ?`)
		.get(params.messageId) as {
		revision: number;
		format: number;
		rowsOnly: number;
		jsonBytes: number;
		originalBytes: number;
		textBytes: number;
		hasBlocks: number;
		queued: number;
	} | null;
	if (!meta || meta.originalBytes + meta.textBytes > maxBytes) return null;
	const holderIds = params.holderIds ?? loadHistoryHolders(db, params.messageId);
	if (!holderIds || historyProtectionBlocked(db, { ...params, holderIds })) {
		return {
			revision: meta.revision,
			content: [],
			compact: false,
			blocks: [],
			blocked: true,
			holderIds: holderIds ?? [],
		};
	}
	const bodyBudget = maxBytes - meta.originalBytes - meta.textBytes;
	const textRow = db
		.query("SELECT content_text AS text FROM narrator_messages WHERE id = ?")
		.get(params.messageId) as { text: string | null };
	const contentText = textRow.text;
	let originalContent: unknown[] | null = null;
	if (meta.originalBytes) {
		const original = db
			.query("SELECT original_content_json AS body FROM narrator_messages WHERE id = ?")
			.get(params.messageId) as { body: string };
		const parsed: unknown = JSON.parse(original.body);
		if (!Array.isArray(parsed)) return null;
		originalContent = parsed;
	}
	let content: unknown;
	let blocks: StorageHistoryBodyResult["blocks"] = [];
	if (meta.rowsOnly || (meta.format === 2 && meta.hasBlocks && !meta.queued)) {
		const size = db
			.query(`SELECT count(*) AS count,
				coalesce(sum(length(CAST(payload AS BLOB)) + length(CAST(coalesce(state, '') AS BLOB))), 0) AS bytes
				FROM narrator_blocks WHERE message_id = ?`)
			.get(params.messageId) as { count: number; bytes: number };
		if (size.count > maxBlocks || size.bytes > bodyBudget) return null;
		const rows = db
			.query(`SELECT id, revision, payload, state FROM narrator_blocks
				WHERE message_id = ? ORDER BY ordinal LIMIT ?`)
			.all(params.messageId, maxBlocks) as Array<{
			id: string;
			revision: number;
			payload: string;
			state: string | null;
		}>;
		blocks = rows.map((r) => ({
			id: r.id,
			revision: r.revision,
			payload: JSON.parse(r.payload),
			state: r.state ? JSON.parse(r.state) : null,
		}));
		content = assembleContent(blocks);
	} else {
		if (meta.jsonBytes > bodyBudget) return null;
		const row = db
			.query("SELECT content_json AS content FROM narrator_messages WHERE id = ?")
			.get(params.messageId) as { content: string };
		content = JSON.parse(row.content);
	}
	if (!Array.isArray(content)) return null;
	const type = (content[0] as { type?: string } | undefined)?.type;
	return {
		revision: meta.revision,
		content,
		compact: type === "compact" || type === "segment_compact",
		blocks,
		originalContent,
		contentText,
		holderIds,
	};
}
