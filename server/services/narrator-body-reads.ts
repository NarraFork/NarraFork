/**
 * narrator-body-reads.ts — message bodies for main-thread Drizzle readers
 * (docs/BLOCK_STORAGE-DESIGN.md §10.1, P2).
 *
 * The Drizzle form of `server/lib/narrator-bodies.ts`. A reader reads the body through
 * one of these, then passes the rows to `fillBodies`:
 *
 *   - a core select puts `contentJsonSql()` where it put `narratorMessages.contentJson`;
 *   - a relational query spreads `bodyColumns(...)` where it had `columns` (or nothing).
 *
 * A block-format envelope whose rows are current comes back NULL and `fillBodies`
 * assembles it from its rows; every other envelope reads `content_json`. With block reads
 * off, and on PG, both return exactly the plain column / `columns` option, and
 * `fillBodies` has nothing to fill.
 */

import type { AnyColumn, SQL } from "drizzle-orm";
import { getTableColumns, sql } from "drizzle-orm";
import * as database from "../db";
import { narratorMessages } from "../db/schema";
import { blockBodies, boundedBodyText } from "../lib/narrator-bodies";
import { assembledBodyLengthSql } from "../lib/narrator-body-length";
import { blockReadsEnabled } from "./narrator-block-scans";
import { readNarratorBodyTexts } from "./narrator-message-reader";

/** The envelope columns the expression reads: `narratorMessages`, or a relational alias of it. */
interface EnvelopeColumns {
	id: AnyColumn;
	bodyFormat: AnyColumn;
	bodyRowsOnly: AnyColumn;
	contentJson: AnyColumn;
}

/**
 * What a reader selects in place of `content_json`: NULL for an envelope whose block rows
 * are current, the column otherwise, decoded like the column. Without block reads, the
 * column itself.
 */
export function contentJsonSql(table: EnvelopeColumns = narratorMessages): SQL<unknown> {
	if (!blockReadsEnabled()) return table.contentJson as unknown as SQL<unknown>;
	return sql`CASE WHEN ${blocksCurrent(table)} THEN NULL ELSE ${table.contentJson} END`.mapWith(
		table.contentJson,
	);
}

/** Whether the envelope's block rows are current, so they hold its body. */
export function bodyInBlocksSql(table: EnvelopeColumns = narratorMessages): SQL {
	return blocksCurrent(table);
}

function blocksCurrent(table: EnvelopeColumns): SQL {
	return sql`(${table.bodyFormat} = 2 AND (${table.bodyRowsOnly} = 1
		OR (NOT EXISTS (SELECT 1 FROM narrator_block_sync_queue q WHERE q.message_id = ${table.id})
			AND EXISTS (SELECT 1 FROM narrator_blocks b WHERE b.message_id = ${table.id}))))`;
}

/**
 * Whether the envelope stores an element of `type` (top-level `type` of an array
 * element), read from its block payloads when they hold its body.
 */
export function hasStoredElementSql(
	type: string,
	table: EnvelopeColumns = narratorMessages,
): SQL<boolean> {
	const inColumn = sql`EXISTS (
		SELECT 1 FROM json_each(${table.contentJson}) AS stored_element
		WHERE json_extract(stored_element.value, '$.type') = ${type}
	)`;
	if (!blockReadsEnabled()) return sql<boolean>`(${inColumn})`;
	return sql<boolean>`(CASE WHEN ${blocksCurrent(table)} THEN EXISTS (
		SELECT 1 FROM narrator_blocks b, json_each(b.payload, '$.raw') AS stored_element
		WHERE b.message_id = ${table.id} AND json_extract(stored_element.value, '$.type') = ${type}
	) ELSE ${inColumn} END)`;
}

/**
 * The size in bytes of the envelope's body, for limits on it (a composer document's cap,
 * history recovery's thresholds): of the array its rows assemble to when they hold it
 * (`assembledBodyLengthSql`, exactly what `content_json` measures), of `content_json`
 * otherwise. Not `body_bytes`, which counts an input's text twice.
 */
export function storedBodyBytesSql(table: EnvelopeColumns = narratorMessages): SQL<number> {
	const json = sql`length(CAST(${table.contentJson} AS BLOB))`;
	if (!blockReadsEnabled()) return sql<number>`${json}`;
	const marker = "{{envelope}}";
	const assembled = sql.join(
		assembledBodyLengthSql(marker, "bytes")
			.split(marker)
			.map((part) => sql.raw(part)),
		sql`${table.id}`,
	);
	return sql<number>`(CASE WHEN ${blocksCurrent(table)} THEN ${assembled} ELSE ${json} END)`;
}

/**
 * The stored size of an envelope row for a budget on rows read or copied: every column but
 * the body, and the body where it is kept (`body_bytes` when its rows hold it, as
 * `bodyBytesSql` sizes read batches; the column's length otherwise).
 */
export function envelopeStoredBytesSql(): SQL<number> {
	const { contentJson: body, ...columns } = getTableColumns(narratorMessages);
	const sized = Object.values(columns)
		.filter((column) => !column.generated)
		.map((column) => sql`coalesce(octet_length(${column}), 0)`);
	const json = sql`coalesce(octet_length(${body}), 0)`;
	const stored = blockReadsEnabled()
		? sql`(CASE WHEN ${blocksCurrent(narratorMessages)} THEN ${narratorMessages.bodyBytes} ELSE ${json} END)`
		: json;
	return sql<number>`${sql.join([...sized, stored], sql` + `)}`;
}

/**
 * The ordinal of the envelope's tool block for the call `wireId`, when its block rows hold
 * its body (NULL otherwise, or without such a block): the position the call's `tool_use`
 * element has among the stored elements, in the same order.
 */
export function toolBlockOrdinalSql(
	table: EnvelopeColumns,
	wireId: AnyColumn | SQL,
): SQL<number | null> {
	if (!blockReadsEnabled()) return sql<number | null>`NULL`;
	return sql<number | null>`(CASE WHEN ${blocksCurrent(table)} THEN (
		SELECT b.ordinal FROM narrator_blocks b
		WHERE b.message_id = ${table.id} AND b.kind = 'tool' AND b.wire_id = ${wireId}
		ORDER BY b.ordinal LIMIT 1
	) END)`;
}

/**
 * Relational queries return `extras` undecoded, so the body comes back as stored text
 * under its own key and `fillBodies` decodes it (as the column would) into `contentJson`.
 */
const STORED_BODY = "storedBody";
const bodyExtras = (table: EnvelopeColumns) => ({
	[STORED_BODY]: sql`CASE WHEN ${blocksCurrent(table)} THEN NULL ELSE ${table.contentJson} END`.as(
		"stored_body",
	),
});

/**
 * Relational-query options reading the body as `contentJsonSql` does (as stored text, which
 * `fillBodies` decodes). Spread in place of the query's `columns`: with none, every column;
 * with some, those (`id` and `contentJson` among them). Typed as the plain option, so the
 * result type is what `fillBodies` leaves.
 */
export function bodyColumns(): Record<never, never>;
export function bodyColumns<const C extends { id: true; contentJson: true }>(
	columns: C,
): { columns: C };
export function bodyColumns(columns?: Record<string, boolean>): object {
	if (!blockReadsEnabled()) return columns ? { columns } : {};
	const rest = columns && Object.entries(columns).filter(([key]) => key !== "contentJson");
	return {
		columns: rest ? Object.fromEntries(rest) : { contentJson: false },
		extras: bodyExtras,
	};
}

/**
 * Complete the bodies read through `contentJsonSql` or `bodyColumns`, in place: decode
 * the stored text a relational query returned, and assemble the NULL ones from their block
 * rows. Stored `content_json` is never NULL, so a NULL is always an envelope whose rows
 * hold its body.
 */
export function fillBodies<T extends { id: string; contentJson: unknown }>(rows: T[]): T[] {
	for (const row of rows) {
		const record = row as Record<string, unknown>;
		if (!Object.hasOwn(record, STORED_BODY)) continue;
		const stored = record[STORED_BODY];
		delete record[STORED_BODY];
		row.contentJson = typeof stored === "string" ? JSON.parse(stored) : null;
	}
	const missing = rows.filter((row) => row.contentJson === null).map((row) => row.id);
	if (missing.length === 0) return rows;
	const bodies = blockBodies(database.sqlite, missing);
	for (const row of rows) if (row.contentJson === null) row.contentJson = bodies.get(row.id) ?? [];
	return rows;
}

/**
 * One envelope's body as stored text, measured before it is read and read only within
 * `maxBytes` (`boundedBodyText`): for a reader on the HTTP thread that parses it.
 */
export function boundedStoredBody(messageId: string, maxBytes: number): string | undefined {
	return boundedBodyText(database.sqlite, messageId, blockReadsEnabled(), { maxBytes });
}

/** One envelope's body assembled from its block rows (for a reader that saw it NULL). */
export function blockBody(messageId: string): unknown[] {
	return blockBodies(database.sqlite, [messageId]).get(messageId) ?? [];
}

/** Async read-side assembly. Synchronous fillBodies remains exclusively for write boundaries. */
export async function fillBodiesAsync<T extends { id: string; contentJson: unknown }>(
	rows: T[],
	signal?: AbortSignal,
): Promise<T[]> {
	for (const row of rows) {
		const record = row as Record<string, unknown>;
		if (!Object.hasOwn(record, STORED_BODY)) continue;
		const stored = record[STORED_BODY];
		delete record[STORED_BODY];
		row.contentJson = typeof stored === "string" ? JSON.parse(stored) : null;
	}
	const missing = rows.filter((row) => row.contentJson === null);
	if (!missing.length) return rows;
	const bodies = await readNarratorBodyTexts(
		missing.map((row) => ({ id: row.id, maxBytes: 128 * 1024 * 1024 })),
		signal,
	);
	for (const row of missing) {
		const body = bodies.get(row.id);
		if (body == null) throw new Error("Message body changed or exceeded its read budget");
		row.contentJson = JSON.parse(body);
	}
	return rows;
}
export async function fillBodyAsync<T extends { id: string; contentJson: unknown }>(
	row: T | undefined,
	signal?: AbortSignal,
): Promise<T | undefined> {
	if (row) await fillBodiesAsync([row], signal);
	return row;
}

/** `fillBodies` for one row, or none. */
export function fillBody<T extends { id: string; contentJson: unknown }>(row: T): T;
export function fillBody<T extends { id: string; contentJson: unknown }>(
	row: T | undefined,
): T | undefined;
export function fillBody<T extends { id: string; contentJson: unknown }>(
	row: T | undefined,
): T | undefined {
	if (row) fillBodies([row]);
	return row;
}
