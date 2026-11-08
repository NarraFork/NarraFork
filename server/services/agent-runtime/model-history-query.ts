import type { Database } from "bun:sqlite";
import { assembleContent } from "@shared/narrator-blocks/storage";
import { bodyBytesSql, bodySql } from "../../lib/narrator-bodies";
import { ModelHistoryBudget } from "./model-history-json";

export const MODEL_HISTORY_REF_BATCH = 200;
export const MODEL_HISTORY_BATCH_BYTES = 4 * 1024 * 1024;
export const MODEL_HISTORY_MAX_BYTES = 128 * 1024 * 1024;

export interface ModelHistoryQueryOptions {
	narratorId: string;
	limit?: number;
	signal?: AbortSignal;
	maxBytes?: number;
	/** In-memory unit fixtures have no worker identity; reject large inline JSON before decoding. */
	inlineRowBytes?: number;
	versioned?: boolean;
	/** Read block-format bodies from `narrator_blocks` (SQLite with `narratorBlocks.read`). */
	bodiesFromBlocks?: boolean;
}
export interface ModelHistoryCounters {
	refQueries: number;
	bodyQueries: number;
	toolQueries: number;
	refs: number;
	toolRows: number;
	sourceBytes: number;
	maxRefsPerQuery: number;
	maxBodyBatchBytes: number;
	maxToolBatchBytes: number;
	preparedBytes: number;
	reusedBodies?: number;
	reusedTools?: number;
}
/** Parsed JSON shared across requests; consumers own only their projection containers. */
export type ModelHistoryJson =
	| null
	| boolean
	| number
	| string
	| readonly ModelHistoryJson[]
	| { readonly [key: string]: ModelHistoryJson };

export type ModelSourceRow = Readonly<{
	id: string;
	seq: number;
	bodyRevision: number;
	/** Stored UTF-8 body bytes for this revision, reused without rereading its text. */
	rawBytes?: number;
	jsonContainerBytes?: number;
	narratorId: string;
	authorNarratorId: string | null;
	role: "user" | "assistant" | "system" | "sys" | "disp";
	contentJson: ModelHistoryJson;
	contentText: string | null;
	parentToolUseId: string | null;
	messageUuid: string | null;
	createdBy: string | null;
	origin: string | null;
	originLabel: string | null;
	creator: Readonly<{ username: string }> | null;
	narrator: Readonly<{ title: string | null }> | null;
	toolCalls: readonly ModelToolSourceRow[];
}>;
/** Only the loader owns this tool container while assembling a row. */
export type ModelSourceRowBuilder = Omit<ModelSourceRow, "toolCalls"> & {
	toolCalls: ModelToolSourceRow[];
};
export type ModelToolSourceRow = Readonly<{
	id: string;
	modelRevision: number;
	/** Stored UTF-8 body bytes for this revision, reused without rereading its text. */
	rawBytes?: number;
	jsonContainerBytes?: number;
	executionAttempt: number;
	createdAt: string;
	toolUseId: string;
	toolName: string;
	inputJson: ModelHistoryJson;
	outputJson: ModelHistoryJson;
	status: string;
}>;
export type HistoryQuery = <T>(sql: string, parameters?: unknown[]) => Promise<T[]>;
export interface ModelHistorySource {
	readonly messages: readonly ModelSourceRow[];
	readonly counters: Readonly<ModelHistoryCounters>;
	readonly compactSeq?: number | null;
}

/** SQLite work runs in a read-only worker; this adapter is also useful for tiny in-memory tests. */
export function sqliteHistoryQuery(sqlite: Database): HistoryQuery {
	return async <T>(sql: string, parameters: unknown[] = []) =>
		sqlite.query(sql).all(...(parameters as Array<string | number | null>)) as T[];
}

/** Each block payload/state reserves graph allocations before parsing, across the entire batch. */
export async function assembleBlockBodies(
	query: HistoryQuery,
	ids: readonly string[],
	budget: ModelHistoryBudget,
): Promise<Map<string, { content: unknown[]; jsonContainerBytes: number }>> {
	budget.check();
	const bodies = new Map<
		string,
		{ rows: Array<{ payload: unknown; state: unknown }>; bytes: number }
	>();
	if (!ids.length) return new Map();
	const rows = await query<{ messageId: string; payload: string; state: string | null }>(
		`SELECT message_id AS "messageId", payload, state FROM narrator_blocks
		 WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY message_id, ordinal`,
		[...ids],
	);
	for (const row of rows) {
		const body = bodies.get(row.messageId) ?? { rows: [], bytes: 0 };
		const payload = budget.parse(row.payload);
		const state = budget.parse(row.state);
		body.bytes += payload.jsonContainerBytes + state.jsonContainerBytes;
		body.rows.push({ payload: payload.value, state: state.value });
		bodies.set(row.messageId, body);
	}
	budget.check();
	return new Map(
		ids.map((id) => {
			const body = bodies.get(id);
			return [
				id,
				{ content: assembleContent(body?.rows ?? []), jsonContainerBytes: body?.bytes ?? 0 },
			];
		}),
	);
}

/** No ORM relation joins: both message bodies and tools have their own metadata/byte preflight. */
export async function queryModelHistory(
	query: HistoryQuery,
	options: ModelHistoryQueryOptions,
	onPage?: (rows: readonly ModelSourceRow[]) => void | Promise<void>,
	onTools?: (
		rows: ReadonlyArray<ModelToolSourceRow & { readonly messageId: string }>,
	) => void | Promise<void>,
): Promise<ModelHistorySource> {
	const counters: ModelHistoryCounters = {
		refQueries: 0,
		bodyQueries: 0,
		toolQueries: 0,
		refs: 0,
		toolRows: 0,
		sourceBytes: 0,
		maxRefsPerQuery: 0,
		maxBodyBatchBytes: 0,
		maxToolBatchBytes: 0,
		preparedBytes: 0,
	};
	const maxBytes = Math.min(options.maxBytes ?? MODEL_HISTORY_MAX_BYTES, MODEL_HISTORY_MAX_BYTES);
	const fromBlocks = options.bodiesFromBlocks === true;
	const budget = new ModelHistoryBudget(maxBytes, options.signal);
	const check = budget.check;
	check();
	const boundary = await query<{ seq: number }>(
		"SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND is_compact = 1 ORDER BY seq DESC LIMIT 1",
		[options.narratorId],
	);
	let cursor = boundary[0]?.seq ?? Number.MIN_SAFE_INTEGER;
	let remaining =
		options.limit == null
			? Number.POSITIVE_INFINITY
			: Math.min(Math.max(Math.trunc(options.limit), 1), 2000);
	const messages: ModelSourceRow[] = [];
	while (remaining > 0) {
		check();
		const refs = await query<{ messageId: string; seq: number; bytes: number }>(
			`SELECT r.message_id AS "messageId", r.seq,
			 coalesce(${bodyBytesSql("m", fromBlocks)}, 0) + coalesce(length(CAST(m.content_text AS BLOB)), 0) AS bytes
			 FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id
			 WHERE r.narrator_id = ? AND r.seq > ? AND r.segment_compact_id IS NULL AND m.role <> 'disp'
			 ORDER BY r.seq LIMIT ?`,
			[options.narratorId, cursor, Math.min(MODEL_HISTORY_REF_BATCH, remaining)],
		);
		counters.refQueries++;
		counters.maxRefsPerQuery = Math.max(counters.maxRefsPerQuery, refs.length);
		if (!refs.length) break;
		let offset = 0;
		while (offset < refs.length) {
			let end = offset;
			let batchBytes = 0;
			while (
				end < refs.length &&
				(end === offset || batchBytes + Number(refs[end].bytes) <= MODEL_HISTORY_BATCH_BYTES)
			) {
				batchBytes += Number(refs[end++].bytes);
			}
			if (
				options.inlineRowBytes != null &&
				refs
					.slice(offset, end)
					.some((row) => Number(row.bytes) > (options.inlineRowBytes ?? Number.POSITIVE_INFINITY))
			)
				throw new Error("Model history large JSON requires a read-only worker");
			budget.reserve(batchBytes, end - offset);
			counters.sourceBytes += batchBytes;
			counters.maxBodyBatchBytes = Math.max(counters.maxBodyBatchBytes, batchBytes);
			const batchRefs = refs.slice(offset, end);
			const ids = batchRefs.map((ref) => ref.messageId);
			const refById = new Map(batchRefs.map((ref) => [ref.messageId, ref]));
			const placeholders = ids.map(() => "?").join(",");
			const bodies = await query<
				Omit<ModelSourceRow, "creator" | "narrator" | "toolCalls"> & {
					username: string | null;
					title: string | null;
				}
			>(
				`SELECT m.id, ${options.versioned ? "m.body_revision" : "0"} AS "bodyRevision", m.narrator_id AS "narratorId",
				 m.author_narrator_id AS "authorNarratorId", m.role, ${bodySql("m", fromBlocks)} AS "contentJson",
				 m.content_text AS "contentText", m.parent_tool_use_id AS "parentToolUseId",
				 m.sdk_message_uuid AS "messageUuid", m.created_by AS "createdBy", m.origin,
				 m.origin_label AS "originLabel", u.username, n.title
				 FROM narrator_messages m LEFT JOIN users u ON u.id = m.created_by
				 LEFT JOIN narrators n ON n.id = coalesce(m.author_narrator_id, m.narrator_id)
				 WHERE m.id IN (${placeholders})`,
				ids,
			);
			counters.bodyQueries++;
			if (bodies.length !== ids.length)
				throw new Error("Model history snapshot contains missing messages");
			const fromRows = await assembleBlockBodies(
				query,
				bodies.filter((body) => body.contentJson === null).map((body) => body.id),
				budget,
			);
			const byId = new Map<string, ModelSourceRowBuilder>();
			for (const { username, title, ...body } of bodies) {
				const assembled = fromRows.get(body.id);
				const parsed = assembled
					? { value: assembled.content, jsonContainerBytes: assembled.jsonContainerBytes }
					: budget.parse(body.contentJson);
				const ref = refById.get(body.id);
				byId.set(body.id, {
					...body,
					rawBytes: ref ? Number(ref.bytes) : undefined,
					jsonContainerBytes: parsed.jsonContainerBytes,
					seq: ref?.seq ?? 0,
					contentJson: parsed.value as ModelHistoryJson,
					creator: username == null ? null : { username },
					narrator: { title },
					toolCalls: [],
				});
			}
			const page = batchRefs.map((ref) => byId.get(ref.messageId) as ModelSourceRow);
			// Worker transport sends body and tool pages independently, so one tool-heavy
			// message cannot turn an otherwise 4MiB page into a giant structured clone.
			if (onTools && onPage) await onPage(page);
			let toolMessageId = "";
			let toolId = "";
			for (;;) {
				check();
				const toolMeta = await query<{ id: string; messageId: string; bytes: number }>(
					`SELECT id, message_id AS "messageId",
					 coalesce(length(CAST(input_json AS BLOB)), 0) + coalesce(length(CAST(output_json AS BLOB)), 0) AS bytes
					 FROM narrator_tool_calls WHERE message_id IN (${placeholders})
					 AND (message_id > ? OR (message_id = ? AND id > ?))
					 ORDER BY message_id, id LIMIT ${MODEL_HISTORY_REF_BATCH}`,
					[...ids, toolMessageId, toolMessageId, toolId],
				);
				counters.toolQueries++;
				if (!toolMeta.length) break;
				// Consume the whole metadata page in soft byte batches; never refetch its tail.
				for (let toolOffset = 0; toolOffset < toolMeta.length; ) {
					let selected = toolOffset;
					let toolBytes = 0;
					while (
						selected < toolMeta.length &&
						(selected === toolOffset ||
							toolBytes + Number(toolMeta[selected].bytes) <= MODEL_HISTORY_BATCH_BYTES)
					) {
						toolBytes += Number(toolMeta[selected++].bytes);
					}
					const selectedMeta = toolMeta.slice(toolOffset, selected);
					if (
						options.inlineRowBytes != null &&
						selectedMeta.some(
							(row) => Number(row.bytes) > (options.inlineRowBytes ?? Number.POSITIVE_INFINITY),
						)
					)
						throw new Error("Model history large JSON requires a read-only worker");
					budget.reserve(toolBytes, selectedMeta.length);
					counters.sourceBytes += toolBytes;
					counters.maxToolBatchBytes = Math.max(counters.maxToolBatchBytes, toolBytes);
					const selectedIds = selectedMeta.map((row) => row.id);
					const rawBytesById = new Map(selectedMeta.map((row) => [row.id, Number(row.bytes)]));
					const tools = await query<ModelToolSourceRow & { messageId: string }>(
						`SELECT id, ${options.versioned ? "model_revision" : "0"} AS "modelRevision", message_id AS "messageId", execution_attempt AS "executionAttempt", created_at AS "createdAt",
						 tool_use_id AS "toolUseId", tool_name AS "toolName", input_json AS "inputJson", output_json AS "outputJson", status
						 FROM narrator_tool_calls WHERE id IN (${selectedIds.map(() => "?").join(",")})`,
						selectedIds,
					);
					counters.toolQueries++;
					if (tools.length !== selectedIds.length)
						throw new Error("Model history snapshot contains missing tool rows");
					const decodedTools = tools.map((tool) => {
						const input = budget.parse(tool.inputJson);
						const output = budget.parse(tool.outputJson);
						return {
							...tool,
							rawBytes: rawBytesById.get(tool.id),
							jsonContainerBytes: input.jsonContainerBytes + output.jsonContainerBytes,
							inputJson: input.value as ModelHistoryJson,
							outputJson: output.value as ModelHistoryJson,
						};
					});
					if (onTools) await onTools(decodedTools);
					else
						for (const { messageId, ...tool } of decodedTools)
							byId.get(messageId)?.toolCalls.push(tool);
					counters.toolRows += tools.length;
					toolOffset = selected;
				}
				const tail = toolMeta[toolMeta.length - 1];
				toolMessageId = tail.messageId;
				toolId = tail.id;
			}
			counters.refs += page.length;
			if (onPage && !onTools) await onPage(page);
			else if (!onPage) messages.push(...page);
			offset = end;
		}
		cursor = refs[refs.length - 1].seq;
		remaining -= refs.length;
	}
	check();
	counters.preparedBytes = budget.preparedBytes;
	return { messages, counters, compactSeq: boundary[0]?.seq ?? null };
}

/** Shared SQL has no dialect-specific JSON parsing; PG byte preflight stays server-side. */
export function postgresHistorySql(sql: string): string {
	let parameter = 0;
	return sql
		.replace(/\?/g, () => `$${++parameter}`)
		.replace(/length\(CAST\(([^)]+) AS BLOB\)\)/g, "octet_length(CAST($1 AS TEXT))");
}
