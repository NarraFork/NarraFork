/**
 * narrator-body-writes.ts — how a stored envelope's body is read for a rewrite and written
 * (docs/BLOCK_STORAGE-DESIGN.md §10.4, P3a).
 *
 * A block-format envelope keeps its body as block rows; `content_json` is the projection
 * written alongside them (D8), or `[]` when the envelope is rows-only (`body_rows_only`,
 * `narratorBlocks.compactJson`, P3b; `storedProjection` decides). A writer hands the body
 * it writes to these functions instead of the column, and the rows are built from what it
 * handed over, never read back from the column:
 *
 *   - `insertEnvelope` (`insertEnvelopeIfAbsent`): a new envelope with its body; its rows
 *     are built in the same transaction. `insertEnvelopeQueued` leaves a bulk copy's rows
 *     to the sync queue, which builds them from the complete column;
 *   - `writeEnvelopeBody`: replace an envelope's body, with the other columns that change
 *     with it; `updateEnvelope` for a set of columns that may include it;
 *   - `readEnvelope` / `readEnvelopeBody`: what a read-modify-write starts from, read as
 *     every reader reads it (`narrator-body-reads.ts`).
 *
 * All synchronous, inside the caller's transaction (bun:sqlite cannot await in one).
 */

import { redactToolPayloadElement } from "@shared/narrator-blocks/retention";
import { and, eq, type SQL } from "drizzle-orm";
import { activeDatabaseBackend, type db, sqlite } from "../db";
import { narratorMessages } from "../db/schema";
import {
	type BlockStamp,
	CLEARED_TOOL_OUTPUT_SQL,
	isEnvelopeHistoryProtected,
	type SyncMode,
	storedProjection,
	syncCopiedEnvelope,
	syncEnvelopeNow,
} from "./narrator-block-sync";
import { bodyColumns, contentJsonSql, fillBody } from "./narrator-body-reads";

export type BodyTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** A transaction, or the database outside one (a read needs no transaction). */
type BodyReader = Pick<BodyTx, "select" | "query">;
type Envelope = typeof narratorMessages.$inferSelect;
type NewEnvelope = typeof narratorMessages.$inferInsert;

/** How the rows of the written body read incomplete output, and what new rows carry. */
export interface BodySync {
	mode?: SyncMode;
	stamp?: BlockStamp;
	/** Only an explicit new human edit may replace a retention tombstone. */
	allowHistoryRewrite?: boolean;
	/** Internal retention write, not a new human body. */
	retentionClear?: boolean;
}

/**
 * Insert an envelope with its body and build its rows. `rows` writes what belongs with the
 * envelope (its ref, its ledger rows) before the blocks are built from both; `copyOf`
 * names the envelope it copies, whose blocks the new ones then descend from (§6.3).
 * Returns the row as stored, with the body it was given.
 */
export function insertEnvelope(tx: BodyTx, values: NewEnvelope, sync: InsertSync = {}): Envelope {
	return built(tx.insert(narratorMessages).values(stored(values)).returning().get(), values, sync);
}

/** `insertEnvelope` unless an envelope with its id exists already (then undefined). */
export function insertEnvelopeIfAbsent(
	tx: BodyTx,
	values: NewEnvelope,
	sync: InsertSync = {},
): Envelope | undefined {
	const row = tx
		.insert(narratorMessages)
		.values(stored(values))
		.onConflictDoNothing()
		.returning()
		.get();
	return row ? built(row, values, sync) : undefined;
}

/**
 * Insert an envelope whose rows the sync queue builds later, from the body stored with it
 * (its `content_json` projection stays complete until then): for a bulk copy (an
 * extraction of a whole history), whose inline sync would hold the main thread. The
 * insert queues it; readers read the column until the sweep has built its rows.
 */
export function insertEnvelopeQueued(tx: BodyTx, values: NewEnvelope): void {
	tx.insert(narratorMessages)
		.values({ ...values, bodyRowsOnly: 0 })
		.run();
}

/** The values an envelope is inserted with: its column as `storedProjection` decides. */
function stored(values: NewEnvelope): NewEnvelope {
	return { ...values, ...storedProjection(values.bodyFormat, values.contentJson) };
}

type InsertSync = BodySync & { rows?: () => void; copyOf?: string };

function built(row: Envelope, values: NewEnvelope, sync: InsertSync): Envelope {
	sync.rows?.();
	if (sync.copyOf) syncCopiedEnvelope(sync.copyOf, row.id, values.contentJson);
	else syncEnvelopeNow(row.id, sync.mode, sync.stamp, values.contentJson);
	return { ...row, contentJson: values.contentJson };
}

/**
 * Update an envelope's columns (none is fine) and rebuild its rows: through
 * `writeEnvelopeBody` when they include its body; otherwise in place, the rows then
 * rebuilt from its body as read (a role or text the blocks derive from may have moved,
 * or `mode` seals what streamed).
 */
export function updateEnvelope(
	tx: BodyTx,
	messageId: string,
	set: Partial<NewEnvelope>,
	sync: BodySync = {},
): void {
	if (Object.hasOwn(set, "contentJson")) {
		writeEnvelopeBody(tx, messageId, set.contentJson, { ...sync, set });
		return;
	}
	if (!sync.allowHistoryRewrite && isEnvelopeHistoryProtected(messageId)) {
		const {
			contentText: _text,
			originalContentJson: _original,
			composerDocument: _doc,
			commandText: _command,
			contextCharsJson: _chars,
			...metadata
		} = set;
		set = metadata;
	}
	if (Object.keys(set).length)
		tx.update(narratorMessages).set(set).where(eq(narratorMessages.id, messageId)).run();
	syncEnvelopeNow(messageId, sync.mode, sync.stamp);
}

/**
 * Replace an envelope's body (`set` names the columns that change with it) and rebuild
 * its rows from it; `rows` writes what belongs with it (a new call's ledger row) before
 * they are. `where` narrows the write (a compare-and-set); nothing else happens when it
 * does not match. Returns whether the envelope was written.
 */
export function writeEnvelopeBody(
	tx: BodyTx,
	messageId: string,
	content: unknown,
	options: BodySync & { set?: Partial<NewEnvelope>; where?: SQL; rows?: () => void } = {},
): boolean {
	const wasCleared = isEnvelopeHistoryProtected(messageId);
	if (wasCleared && !options.allowHistoryRewrite) return false;
	if (
		wasCleared &&
		!options.retentionClear &&
		Array.isArray(content) &&
		content[0] &&
		typeof content[0] === "object"
	) {
		// Keep the independent audit ledger from becoming ledger-only model calls again.
		const { historyClearVersion: _version, historyClearedAt: _at, ...first } = content[0];
		content = [{ historyToolsSuppressed: true, ...first }, ...content.slice(1)];
	}
	const hasToolCopies = [content, options.set?.originalContentJson].some(
		(value) =>
			Array.isArray(value) &&
			value.some(
				(element) =>
					element &&
					typeof element === "object" &&
					["tool_use", "tool_result"].includes(element.type),
			),
	);
	if (activeDatabaseBackend === "sqlite" && hasToolCopies) {
		const calls = sqlite
			.query<
				{ toolUseId: string },
				[string]
			>(`SELECT tool_use_id AS toolUseId FROM narrator_tool_calls t
			WHERE message_id = ? AND ${CLEARED_TOOL_OUTPUT_SQL} AND NOT EXISTS (
			SELECT 1 FROM narrator_tool_calls newer WHERE newer.message_id = t.message_id
			AND newer.tool_use_id = t.tool_use_id AND (newer.execution_attempt, newer.created_at, newer.id)
			> (t.execution_attempt, t.created_at, t.id)) LIMIT 1025`)
			.all(messageId);
		if (calls.length > 1024) return false;
		if (calls.length) {
			const cleared = new Set(calls.map((call) => call.toolUseId));
			if (Array.isArray(content))
				content = content.map((element) => redactToolPayloadElement(element, cleared));
			if (Array.isArray(options.set?.originalContentJson)) {
				options = {
					...options,
					set: {
						...options.set,
						originalContentJson: options.set.originalContentJson.map((element) =>
							redactToolPayloadElement(element, cleared),
						),
					},
				};
			}
		}
	}
	const target = eq(narratorMessages.id, messageId);
	const bodyFormat =
		options.set?.bodyFormat ??
		tx
			.select({ bodyFormat: narratorMessages.bodyFormat })
			.from(narratorMessages)
			.where(target)
			.get()?.bodyFormat;
	const written = tx
		.update(narratorMessages)
		.set({ ...options.set, ...storedProjection(bodyFormat, content) })
		.where(options.where ? and(target, options.where) : target)
		.returning({ id: narratorMessages.id })
		.get();
	if (!written) return false;
	options.rows?.();
	syncEnvelopeNow(messageId, options.mode, options.stamp, content);
	return true;
}

/** Every column of an envelope, `contentJson` its body as readers read it. */
export function readEnvelope(tx: BodyReader, messageId: string): Envelope | undefined {
	return fillBody(
		tx.query.narratorMessages
			.findFirst({ ...bodyColumns(), where: eq(narratorMessages.id, messageId) })
			.sync(),
	);
}

/** An envelope's body as readers read it; undefined when there is no such envelope. */
export function readEnvelopeBody(tx: BodyReader, messageId: string): unknown {
	return fillBody(
		tx
			.select({ id: narratorMessages.id, contentJson: contentJsonSql() })
			.from(narratorMessages)
			.where(eq(narratorMessages.id, messageId))
			.get(),
	)?.contentJson;
}
