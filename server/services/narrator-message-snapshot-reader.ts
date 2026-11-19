import type { Database } from "bun:sqlite";
import { getTableColumns } from "drizzle-orm";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { NARRATOR_MESSAGE_SOURCE_MAX_BYTES } from "../lib/db-worker/domain-limits";
import { DbReadError } from "../lib/db-worker/errors";
import {
	bodyLengthSql,
	bodySql,
	boundedBodyText,
	hasBlockStorage,
	readBodies,
} from "../lib/narrator-bodies";

export type NarratorRawRow = Record<string, string | number | null | Uint8Array>;
export interface NarratorMessageRowsParams {
	messageIds: string[];
	includeTools: boolean;
	includeCreator: boolean;
}
export interface NarratorMessageRowsResult {
	messages: NarratorRawRow[];
	tools: NarratorRawRow[];
	authors: { id: string; title: string | null }[];
	creators: {
		id: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	}[];
}
export interface NarratorBodyTextsParams {
	entries: Array<{ id: string; maxBytes: number; exactBytes?: number }>;
}
export function validateNarratorBodyTexts(input: unknown): input is NarratorBodyTextsParams {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const entries = (input as Record<string, unknown>).entries;
	if (!Array.isArray(entries) || entries.length > 128 || Object.keys(input).length !== 1)
		return false;
	let bytes = 0;
	return entries.every((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			!entry.id ||
			entry.id.length > 256 ||
			!Number.isSafeInteger(entry.maxBytes) ||
			entry.maxBytes < 0 ||
			(entry.exactBytes !== undefined &&
				(!Number.isSafeInteger(entry.exactBytes) ||
					entry.exactBytes < 0 ||
					entry.exactBytes > entry.maxBytes)) ||
			Object.keys(entry).some((key) => !["id", "maxBytes", "exactBytes"].includes(key))
		)
			return false;
		bytes += entry.maxBytes;
		return bytes <= NARRATOR_MESSAGE_SOURCE_MAX_BYTES;
	});
}
export function readNarratorBodyTextsSnapshot(
	database: Database,
	input: NarratorBodyTextsParams,
	signal?: AbortSignal,
): Array<{ id: string; body: string | null }> {
	if (!validateNarratorBodyTexts(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid bounded body request");
	const blocks = hasBlockStorage(database);
	return input.entries.map((entry) => {
		signal?.throwIfAborted();
		return { id: entry.id, body: boundedBodyText(database, entry.id, blocks, entry) ?? null };
	});
}
const SOURCE_ROWS = 10_000;
const toolBytes = Object.values(getTableColumns(narratorToolCalls))
	.filter((column) => !column.generated)
	.map((column) => `coalesce(octet_length("${column.name}"),0)`)
	.join(" + ");

/** Synchronous, explicit-connection reader; the registry owns the readonly snapshot. */
export function readNarratorMessageRowsSnapshot(
	database: Database,
	input: NarratorMessageRowsParams,
	signal?: AbortSignal,
): NarratorMessageRowsResult {
	signal?.throwIfAborted();
	if (!validateNarratorMessageRows(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid narrator snapshot request");
	const ids = [...new Set(input.messageIds)];
	const result: NarratorMessageRowsResult = { messages: [], tools: [], creators: [], authors: [] };
	if (!ids.length) return result;
	const marks = ids.map(() => "?").join(",");
	const blocks = hasBlockStorage(database);
	const columns = Object.values(getTableColumns(narratorMessages)).filter(
		(column) => column.name !== "content_json",
	);
	const messageBytes = [
		...columns.map((column) => `coalesce(octet_length(m."${column.name}"),0)`),
		`coalesce(${bodyLengthSql("m", blocks)},0)`,
	].join(" + ");
	const messageSize = database
		.query<{ rows: number; bytes: number }, string[]>(
			`SELECT count(*) AS rows, coalesce(sum(${messageBytes}),0) AS bytes
			 FROM narrator_messages m WHERE m.id IN (${marks})`,
		)
		.get(...ids);
	const toolSize = input.includeTools
		? database
				.query<{ rows: number; bytes: number }, string[]>(
					`SELECT count(*) AS rows, coalesce(sum(${toolBytes}),0) AS bytes
					 FROM narrator_tool_calls WHERE message_id IN (${marks})`,
				)
				.get(...ids)
		: null;
	if (
		(messageSize?.rows ?? 0) + (toolSize?.rows ?? 0) > SOURCE_ROWS ||
		(messageSize?.bytes ?? 0) + (toolSize?.bytes ?? 0) > NARRATOR_MESSAGE_SOURCE_MAX_BYTES
	)
		throw new DbReadError("DB_READ_BUDGET", "Narrator message snapshot exceeds its source budget");
	signal?.throwIfAborted();
	const raw = database
		.query<NarratorRawRow & { id: string; body: string | null }, string[]>(
			`SELECT ${columns.map((column) => `m."${column.name}"`).join(",")},
			 ${bodySql("m", blocks)} AS body FROM narrator_messages m
			 WHERE m.id IN (${marks}) ORDER BY m.id LIMIT ${SOURCE_ROWS + 1}`,
		)
		.all(...ids);
	// Rows-only content_json='[]' is a storage marker, not the body. Assemble before IPC.
	const bodies = readBodies(database, raw);
	result.messages = raw.map(({ body: _body, ...row }) => ({
		...row,
		content_json: JSON.stringify(bodies.get(String(row.id)) ?? []),
	}));
	if (input.includeTools)
		result.tools = database
			.query<NarratorRawRow, string[]>(
				`SELECT * FROM narrator_tool_calls WHERE message_id IN (${marks})
				 ORDER BY created_at, id LIMIT ${SOURCE_ROWS + 1}`,
			)
			.all(...ids);
	if (input.includeCreator) {
		const creators = [
			...new Set(
				result.messages.flatMap((row) =>
					typeof row.created_by === "string" ? [row.created_by] : [],
				),
			),
		];
		if (creators.length)
			result.creators = database
				.query<NarratorMessageRowsResult["creators"][number], string[]>(
					`SELECT id, username, avatar_color AS avatarColor, avatar_image_id AS avatarImageId
					 FROM users WHERE id IN (${creators.map(() => "?").join(",")}) LIMIT 128`,
				)
				.all(...creators);
	}
	const authors = [
		...new Set(
			result.messages.flatMap((row) =>
				typeof row.narrator_id === "string" ? [row.narrator_id] : [],
			),
		),
	];
	if (authors.length)
		result.authors = database
			.query<NarratorMessageRowsResult["authors"][number], string[]>(
				`SELECT id, title FROM narrators WHERE id IN (${authors.map(() => "?").join(",")}) LIMIT 128`,
			)
			.all(...authors);
	signal?.throwIfAborted();
	return result;
}

export function validateNarratorMessageRows(input: unknown): input is NarratorMessageRowsParams {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const row = input as Record<string, unknown>;
	return (
		Object.keys(row).length === 3 &&
		Object.keys(row).every((key) =>
			["messageIds", "includeTools", "includeCreator"].includes(key),
		) &&
		typeof row.includeTools === "boolean" &&
		typeof row.includeCreator === "boolean" &&
		Array.isArray(row.messageIds) &&
		row.messageIds.length <= 128 &&
		row.messageIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
	);
}
