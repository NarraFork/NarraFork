/**
 * narrator-block-page.ts — messages in the block-keyed protocol v2
 * (docs/BLOCK_STORAGE-DESIGN.md §8.1, §8.2, P2c-2; the only protocol since P3d).
 *
 * The page and WS emitters build each message as a row with its `contentJson` array (a
 * page nests child rows under `children`), the shape protocol v1 sent. Clients receive
 * the same rows as envelopes that name their blocks in order, plus the blocks:
 *
 *   - a block-format envelope's blocks are its rows: each row's `payload.raw` length says
 *     which elements it holds, and its id, kind, phase, revision and attempt come along;
 *   - a legacy envelope's blocks are what the decoder makes of its elements, under the
 *     decoded ids (`${messageId}:${index}`) the block-id API resolves while it is legacy.
 *
 * A block's elements are the row's elements exactly as v1 sends them (tool IO truncated,
 * ledger fields joined), so v2 reads nothing but the row layouts. An envelope whose sync
 * is still queued is synced first, so the ids sent are the ones its rows keep.
 */

import { splitEnvelope } from "@shared/narrator-blocks/storage";
import type { EnvelopeRole } from "@shared/narrator-blocks/types";
import * as database from "../db";
import { syncQueuedEnvelopeNow } from "./narrator-block-sync";

/** One block as protocol v2 sends it. */
export interface BlockDTO {
	id: string;
	messageId: string;
	ordinal: number;
	kind: string;
	subtype: string | null;
	phase: string;
	revision: number;
	wireId: string | null;
	attemptId: string | null;
	/** The stored elements the block holds, as v1 sends them in `contentJson`. */
	elements: unknown[];
	/** An edited output block keeps its body from before the first edit. */
	hasOriginal: boolean;
}

/** A message row without its body: the body is its blocks, named in order. */
export type EnvelopeDTO = Record<string, unknown> & {
	id: string;
	blockIds: string[];
	/** The row it was nested under in v1 (`children`); null for a row at the top. */
	parentMessageId: string | null;
};

interface RowLayout {
	id: string;
	ordinal: number;
	kind: string;
	subtype: string | null;
	phase: string;
	revision: number;
	wireId: string | null;
	attemptId: string | null;
	length: number;
	hasOriginal: number;
}

const ID_BATCH = 500;

/** Rebuild a queued envelope's rows (in a transaction of its own, or the caller's). */
function syncQueued(messageId: string): void {
	syncQueuedEnvelopeNow(messageId);
}

/**
 * The block rows of the block-format envelopes among `messageIds`, in ordinal order.
 * Envelopes still waiting on the block sync are synced first. Empty off SQLite, where
 * every envelope is legacy.
 */
export function blockLayouts(messageIds: readonly string[]): Map<string, RowLayout[]> {
	const layouts = new Map<string, RowLayout[]>();
	if (database.activeDatabaseBackend !== "sqlite" || messageIds.length === 0) return layouts;
	const unique = [...new Set(messageIds)];
	for (let start = 0; start < unique.length; start += ID_BATCH) {
		const ids = unique.slice(start, start + ID_BATCH);
		const marks = ids.map(() => "?").join(",");
		const queued = database.sqlite
			.prepare(
				`SELECT q.message_id AS id FROM narrator_block_sync_queue q
				 JOIN narrator_messages m ON m.id = q.message_id
				 WHERE q.message_id IN (${marks}) AND m.body_format = 2`,
			)
			.all(...ids) as Array<{ id: string }>;
		for (const { id } of queued) database.sqlite.transaction(() => syncQueued(id))();
		const rows = database.sqlite
			.prepare(
				`SELECT b.message_id AS messageId, b.id, b.ordinal, b.kind, b.subtype, b.phase,
					b.revision, b.wire_id AS wireId, b.attempt_id AS attemptId,
					coalesce(json_array_length(b.payload, '$.raw'), 0) AS length,
					b.original_payload IS NOT NULL AS hasOriginal
				 FROM narrator_blocks b JOIN narrator_messages m ON m.id = b.message_id
				 WHERE b.message_id IN (${marks}) AND m.body_format = 2
				 ORDER BY b.message_id, b.ordinal`,
			)
			.all(...ids) as Array<RowLayout & { messageId: string }>;
		for (const { messageId, ...row } of rows) {
			const list = layouts.get(messageId);
			if (list) list.push(row);
			else layouts.set(messageId, [row]);
		}
	}
	return layouts;
}

/**
 * The tool block a tool lifecycle frame is about: its ledger attempt's `block_id` when the
 * frame names the attempt (`toolCallId`), else the newest attempt of the call among the
 * narrators the frame concerns. Undefined off SQLite, or before the block has a row.
 */
export function ledgerBlockId(
	toolCallId: string | null | undefined,
	toolUseId: string,
	narratorIds: readonly string[],
): string | undefined {
	if (database.activeDatabaseBackend !== "sqlite") return undefined;
	if (toolCallId) {
		const row = database.sqlite
			.prepare("SELECT block_id AS blockId FROM narrator_tool_calls WHERE id = ?")
			.get(toolCallId) as { blockId: string | null } | null;
		if (row) return row.blockId ?? undefined;
	}
	if (!narratorIds.length) return undefined;
	const row = database.sqlite
		.prepare(
			`SELECT block_id AS blockId FROM narrator_tool_calls
			 WHERE tool_use_id = ? AND narrator_id IN (${narratorIds.map(() => "?").join(",")})
				AND block_id IS NOT NULL
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
		)
		.get(toolUseId, ...narratorIds) as { blockId: string } | null;
	return row?.blockId;
}

// biome-ignore lint/suspicious/noExplicitAny: message rows are dynamic JSON on both protocols
type MessageRow = Record<string, any> & { id: string };

/** The blocks of one row: its block rows when they hold its elements, else decoded. */
function blocksOf(message: MessageRow, rows: RowLayout[] | undefined): BlockDTO[] {
	const elements: unknown[] = Array.isArray(message.contentJson) ? message.contentJson : [];
	if (rows?.length && rows.reduce((sum, row) => sum + row.length, 0) === elements.length) {
		let from = 0;
		return rows.map((row) => {
			const to = from + row.length;
			const block: BlockDTO = {
				id: row.id,
				messageId: message.id,
				ordinal: row.ordinal,
				kind: row.kind,
				subtype: row.subtype,
				phase: row.phase,
				revision: row.revision,
				wireId: row.wireId,
				attemptId: row.attemptId,
				elements: elements.slice(from, to),
				hasOriginal: !!row.hasOriginal,
			};
			from = to;
			return block;
		});
	}
	const { blocks } = splitEnvelope({
		id: message.id,
		narratorId: message.narratorId,
		role: message.role as EnvelopeRole,
		contentJson: elements,
		contentText: message.contentText ?? null,
		parentToolUseId: message.parentToolUseId ?? null,
		messageUuid: message.messageUuid ?? null,
		origin: message.origin ?? null,
		provider: message.provider ?? null,
	});
	let from = 0;
	return blocks.map((draft, ordinal) => {
		const to = from + draft.payload.raw.length;
		const block: BlockDTO = {
			id: draft.canonical?.id ?? `${message.id}:${from}`,
			messageId: message.id,
			ordinal,
			kind: draft.kind,
			subtype: draft.subtype,
			phase: draft.phase,
			revision: 0,
			wireId: draft.wireId,
			attemptId: null,
			elements: elements.slice(from, to),
			hasOriginal: false,
		};
		from = to;
		return block;
	});
}

/** The rows in the order v2 lists them: each row, then the rows nested under it. */
function flatten(
	messages: readonly MessageRow[],
	parentMessageId: string | null = null,
	into: Array<{ row: MessageRow; parentMessageId: string | null }> = [],
): Array<{ row: MessageRow; parentMessageId: string | null }> {
	for (const message of messages) {
		into.push({ row: message, parentMessageId });
		if (Array.isArray(message.children)) flatten(message.children, message.id, into);
	}
	return into;
}

/**
 * v1 message rows (with nested `children`, as a page has them) as v2 envelopes and
 * blocks. Rows keep every field but their body and nesting; an envelope names the row it
 * was nested under (`parentMessageId`), so a client can rebuild the v1 tree exactly.
 */
export function toEnvelopes(messages: readonly MessageRow[]): {
	messages: EnvelopeDTO[];
	blocks: BlockDTO[];
} {
	const rows = flatten(messages);
	const layouts = blockLayouts(rows.map(({ row }) => row.id));
	const envelopes: EnvelopeDTO[] = [];
	const blocks: BlockDTO[] = [];
	for (const { row, parentMessageId } of rows) {
		const { contentJson: _body, children: _children, ...envelope } = row;
		const own = blocksOf(row, layouts.get(row.id));
		envelopes.push({
			...envelope,
			id: row.id,
			blockIds: own.map((block) => block.id),
			parentMessageId,
		});
		blocks.push(...own);
	}
	return { messages: envelopes, blocks };
}

/** A v1 page (`getPretextDocumentPage`) in protocol v2. */
export function toBlockPage<T extends { messages: MessageRow[] }>(
	page: T,
): Omit<T, "messages"> & { protocol: 2; messages: EnvelopeDTO[]; blocks: BlockDTO[] } {
	const { messages, ...rest } = page;
	return { ...rest, protocol: 2, ...toEnvelopes(messages) };
}
