import type { Database } from "bun:sqlite";
import {
	isNativeModelContextBlock,
	modelTextFromContentBlocks,
} from "../../../shared/native-injection";
import { isBashToolName } from "../agent/tool-name";
import { boundedBodyText, hasBlockStorage, hasBodyRevisions } from "../narrator-bodies";
import type {
	RecallConversationOptions,
	RecallMessageInput,
	RecallMessagePage,
	RecallPagination,
} from "../recall-contract";
import { DbReadError } from "./errors";

export { readRecallToolCallPage } from "./recall-tool-page";

export interface RecallToolCallRow {
	tool_use_id: string;
	tool_name: string;
	status: string;
	input_json: string | null;
	output_json: string | null;
	duration_ms: number | null;
	error_message: string | null;
	created_at: string;
	narrator_id: string;
	narrator_title: string | null;
}
export interface RecallConversationSnapshot {
	narrator: { id: string; title: string | null; model: string | null } | null;
	messageMissing: boolean;
	rows: {
		id: string;
		role: string;
		origin: string | null;
		truncated: boolean;
		content_text: string | null;
		created_at: string;
		seq: number;
	}[];
	pagination: RecallPagination;
	tools: {
		tool_use_id: string;
		tool_name: string;
		status: string;
		message_id: string;
		summary: string;
	}[];
}
export interface RecallToolCallDetailInput {
	toolCallId: string;
	narratorId: string | null;
}
export interface RecallConversationInput extends RecallConversationOptions {
	narratorId: string;
	messageId: string | null;
	limit: number;
}
export const RECALL_DETAIL_BYTES = 40 * 1024 * 1024;
export const RECALL_CONVERSATION_INPUT_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
function check(signal?: AbortSignal, deadlineAt = Number.POSITIVE_INFINITY) {
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Recall read cancelled");
	if (Date.now() >= deadlineAt)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall read deadline expired");
}
function budget(bytes: number, maximum: number) {
	if (!Number.isSafeInteger(bytes) || bytes > maximum)
		throw new DbReadError("DB_READ_BUDGET", "Recall source exceeds its byte budget");
}
function textColumn(
	database: Database,
	id: string,
	column: "input_json" | "output_json",
	remainingBytes: number,
	signal?: AbortSignal,
	deadlineAt?: number,
): string | null {
	check(signal, deadlineAt);
	const sizes = database.prepare(
		`SELECT octet_length(${column}) AS bytes FROM narrator_tool_calls WHERE id = ? LIMIT 1`,
	);
	let size: number | null;
	try {
		size = (sizes.get(id) as { bytes: number | null } | null)?.bytes ?? null;
	} finally {
		sizes.finalize();
	}
	if (size === null) return null;
	budget(size, remainingBytes);
	const chunks = database.prepare(
		`SELECT substr(CAST(${column} AS BLOB), ?, ?) AS chunk FROM narrator_tool_calls WHERE id = ? LIMIT 1`,
	);
	const decoder = new TextDecoder();
	const parts: string[] = [];
	try {
		for (let offset = 1; offset <= size; offset += CHUNK_BYTES) {
			check(signal, deadlineAt);
			const row = chunks.get(offset, CHUNK_BYTES, id) as { chunk: Uint8Array };
			parts.push(decoder.decode(row.chunk, { stream: true }));
		}
		parts.push(decoder.decode());
		return parts.join("");
	} finally {
		chunks.finalize();
	}
}
export function readRecallToolCallDetail(
	database: Database,
	input: RecallToolCallDetailInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): RecallToolCallRow | null {
	check(signal, deadlineAt);
	return database.transaction(() => {
		const sizes = database.prepare(
			`SELECT tc.id, coalesce(octet_length(tc.tool_use_id),0) + coalesce(octet_length(tc.tool_name),0) + coalesce(octet_length(tc.status),0) + coalesce(octet_length(tc.error_message),0) + coalesce(octet_length(tc.created_at),0) + coalesce(octet_length(tc.narrator_id),0) + coalesce(octet_length(n.title),0) + coalesce(octet_length(tc.input_json),0) + coalesce(octet_length(tc.output_json),0) + 1024 AS bytes FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id WHERE tc.tool_use_id = ? ${input.narratorId === null ? "" : "AND tc.narrator_id = ?"} LIMIT 1`,
		);
		let source: { id: string; bytes: number } | null;
		try {
			source = sizes.get(
				...(input.narratorId === null ? [input.toolCallId] : [input.toolCallId, input.narratorId]),
			) as typeof source;
		} finally {
			sizes.finalize();
		}
		if (!source) return null;
		budget(source.bytes, RECALL_DETAIL_BYTES);
		const query = database.prepare(
			`SELECT tc.id, tc.tool_use_id, tc.tool_name, tc.status, tc.duration_ms, tc.error_message, tc.created_at, tc.narrator_id, n.title AS narrator_title FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id WHERE tc.id = ? LIMIT 1`,
		);
		let row: (Omit<RecallToolCallRow, "input_json" | "output_json"> & { id: string }) | null;
		try {
			row = query.get(source.id) as typeof row;
		} finally {
			query.finalize();
		}
		if (!row) return null;
		const metadataBytes = Buffer.byteLength(JSON.stringify(row)) + 1024;
		budget(metadataBytes, RECALL_DETAIL_BYTES);
		const input_json = textColumn(
			database,
			row.id,
			"input_json",
			RECALL_DETAIL_BYTES - metadataBytes,
			signal,
			deadlineAt,
		);
		const output_json = textColumn(
			database,
			row.id,
			"output_json",
			RECALL_DETAIL_BYTES - metadataBytes - Buffer.byteLength(input_json ?? ""),
			signal,
			deadlineAt,
		);
		const { id: _id, ...metadata } = row;
		return { ...metadata, input_json, output_json };
	})();
}
export interface RecallQuery {
	sql: string;
	params: (string | number | null)[];
}
type QueryRows = Record<string, unknown>[];

/** One query plan, driven synchronously in SQLite's Worker and asynchronously on PG. */
export function* recallConversationQueries(
	input: RecallConversationInput,
	postgres = false,
): Generator<RecallQuery, RecallConversationSnapshot, QueryRows> {
	const query = (sql: string, params: RecallQuery["params"] = []): RecallQuery => {
		let i = 0;
		return { sql: postgres ? sql.replace(/\?/g, () => `$${++i}`) : sql, params };
	};
	const narratorSource = (yield query(
		"SELECT id, CASE WHEN octet_length(title) <= 262144 THEN title END AS title, CASE WHEN octet_length(model) <= 262144 THEN model END AS model, coalesce(octet_length(title),0) + coalesce(octet_length(model),0) AS source_bytes FROM narrators WHERE id = ? LIMIT 1",
		[input.narratorId],
	))[0];
	if (narratorSource) budget(Number(narratorSource.source_bytes), 256 * 1024);
	const narrator = narratorSource
		? { id: narratorSource.id, title: narratorSource.title, model: narratorSource.model }
		: null;
	const result: RecallConversationSnapshot = {
		narrator: (narrator as unknown as RecallConversationSnapshot["narrator"]) ?? null,
		messageMissing: false,
		rows: [],
		tools: [],
		pagination: { hasOlder: false, hasNewer: false, olderCursor: null, newerCursor: null },
	};
	if (!narrator) return result;
	budget(Buffer.byteLength(JSON.stringify(narrator)), 256 * 1024);
	const params: RecallQuery["params"] = [input.narratorId];
	const where = ["r.narrator_id = ?"];
	if (input.roles) {
		where.push(`m.role IN (${input.roles.map(() => "?").join(",")})`);
		params.push(...input.roles);
	}
	if (input.origins) {
		const known = input.origins.filter((origin) => origin !== "unknown");
		const terms = known.length ? [`m.origin IN (${known.map(() => "?").join(",")})`] : [];
		params.push(...known);
		if (input.origins.includes("unknown")) terms.push("m.origin IS NULL");
		where.push(`(${terms.join(" OR ")})`);
	}
	if (input.createdFrom) {
		where.push("m.created_at >= ?");
		params.push(input.createdFrom);
	}
	if (input.createdTo) {
		where.push("m.created_at <= ?");
		params.push(input.createdTo);
	}
	const scope = `FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE ${where.join(" AND ")}`;
	const columns = `m.id, m.role, m.origin, ${postgres ? "substr(m.content_text, 1, 501)" : "substr(CAST(m.content_text AS BLOB), 1, 2004)"} AS content_prefix, ${postgres ? "length(m.content_text) > 500" : "length(CAST(m.content_text AS BLOB)) > 2004"} AS truncated, m.created_at, r.seq`;
	const select = (extra: string, order: string, count: number, values: number[] = []) =>
		query(`SELECT ${columns} ${scope} ${extra} ORDER BY r.seq ${order} LIMIT ?`, [
			...params,
			...values,
			count,
		]);
	const direction = input.direction ?? (input.messageId ? "around" : "older");
	let rows: QueryRows;
	if (direction === "around") {
		const anchor = (yield query(
			"SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ? LIMIT 1",
			[input.narratorId, input.messageId],
		))[0];
		if (!anchor) return { ...result, messageMissing: true };
		const seq = Number(anchor.seq);
		const before = yield select("AND r.seq < ?", "DESC", Math.floor(input.limit / 2), [seq]);
		const after = yield select("AND r.seq >= ?", "ASC", input.limit - before.length, [seq]);
		if (before.length + after.length < input.limit) {
			const tail = before.length ? Number(before[before.length - 1].seq) : seq;
			before.push(
				...(yield select("AND r.seq < ?", "DESC", input.limit - before.length - after.length, [
					tail,
				])),
			);
		}
		rows = [...before.reverse(), ...after];
	} else {
		const newer = direction === "newer";
		rows = yield select(
			input.cursor === undefined ? "" : `AND r.seq ${newer ? ">" : "<"} ?`,
			newer ? "ASC" : "DESC",
			input.limit,
			input.cursor === undefined ? [] : [input.cursor],
		);
		if (!newer) rows.reverse();
	}
	result.rows = rows.map(({ content_prefix, ...row }) => {
		const chars = Array.from(
			typeof content_prefix === "string"
				? content_prefix
				: content_prefix instanceof Uint8Array
					? new TextDecoder().decode(content_prefix)
					: "",
		);
		return {
			...row,
			content_text: content_prefix == null ? null : chars.slice(0, 500).join(""),
			origin: row.origin ?? null,
			seq: Number(row.seq),
			truncated: Boolean(row.truncated) || chars.length > 500,
		};
	}) as RecallConversationSnapshot["rows"];
	if (!rows.length) return result;
	const first = Number(rows[0].seq),
		last = Number(rows[rows.length - 1].seq);
	result.pagination = {
		hasOlder:
			(yield query(`SELECT 1 ${scope} AND r.seq < ? LIMIT 1`, [...params, first])).length > 0,
		hasNewer:
			(yield query(`SELECT 1 ${scope} AND r.seq > ? LIMIT 1`, [...params, last])).length > 0,
		olderCursor: first,
		newerCursor: last,
	};
	if (!input.includeToolCalls) return result;
	const ids = result.rows.map((row) => row.id);
	const toolScope = `FROM narrator_tool_calls WHERE narrator_id = ? AND message_id IN (${ids.map(() => "?").join(",")})`;
	const admission = (yield query(
		`SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes, coalesce(max(metadata_bytes),0) AS max_metadata_bytes FROM (SELECT coalesce(octet_length(input_json${postgres ? "::text" : ""}),0) + octet_length(tool_use_id) + octet_length(tool_name) + octet_length(status) AS bytes, octet_length(tool_use_id) + octet_length(tool_name) + octet_length(status) AS metadata_bytes ${toolScope} LIMIT 10001) AS tool_sizes`,
		[input.narratorId, ...ids],
	))[0];
	if (Number(admission.count) > 10000)
		throw new DbReadError("DB_READ_BUDGET", "Recall tool count exceeds its source budget");
	budget(Number(admission.bytes), RECALL_CONVERSATION_INPUT_BYTES);
	budget(Number(admission.max_metadata_bytes), 4096);
	const keys = [
		"file_path",
		"filePath",
		"path",
		"pattern",
		"command",
		"query",
		"url",
		"mode",
		"description",
		"prompt",
		"message",
		"action",
	];
	const fields = keys.map(
		(key) =>
			`substr(${postgres ? `(input_json::jsonb ->> '${key}')` : `CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.${key}') END`}, 1, 512) AS "${key}"`,
	);
	fields.push(
		`substr(${postgres ? "(input_json::jsonb #>> '{questions,0,header}')" : "CASE WHEN json_valid(input_json) THEN json_extract(input_json, '$.questions[0].header') END"}, 1, 512) AS question_header`,
	);
	let time = "",
		id = "",
		resultBytes = Buffer.byteLength(JSON.stringify(result));
	while (true) {
		const tools = yield query(
			`SELECT id, created_at, tool_use_id, tool_name, status, message_id, ${fields.join(",")} ${toolScope} AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 128`,
			[input.narratorId, ...ids, time, id],
		);
		for (const tool of tools) {
			const item = {
				tool_use_id: String(tool.tool_use_id),
				tool_name: String(tool.tool_name),
				status: String(tool.status),
				message_id: String(tool.message_id),
				summary: getToolCallSummary(String(tool.tool_name), {
					...tool,
					questions: [{ header: tool.question_header }],
				}).slice(0, 80),
			};
			resultBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
			budget(resultBytes, 4 * 1024 * 1024);
			result.tools.push(item);
		}
		if (tools.length < 128) break;
		time = String(tools[tools.length - 1].created_at);
		id = String(tools[tools.length - 1].id);
	}
	return result;
}

export function readRecallConversation(
	database: Database,
	input: RecallConversationInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30000,
): RecallConversationSnapshot {
	return database.transaction(() => {
		const plan = recallConversationQueries(input);
		let step = plan.next();
		while (!step.done) {
			check(signal, deadlineAt);
			const statement = database.prepare(step.value.sql);
			let rows: QueryRows;
			try {
				rows = statement.all(...step.value.params) as QueryRows;
			} finally {
				statement.finalize();
			}
			step = plan.next(rows);
		}
		check(signal, deadlineAt);
		return step.value;
	})();
}

export function readRecallMessage(
	database: Database,
	input: RecallMessageInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30000,
): RecallMessagePage | null {
	check(signal, deadlineAt);
	return database.transaction(() => {
		const row = database
			.query(
				`SELECT m.id AS messageId, r.narrator_id AS narratorId, n.title AS narratorTitle, m.role, m.origin, m.origin_label AS originLabel, m.created_at AS createdAt, r.seq, ${hasBodyRevisions(database) ? "m.body_revision" : "0"} AS bodyRevision FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id JOIN narrators n ON n.id = r.narrator_id WHERE r.narrator_id = ? AND r.message_id = ? LIMIT 1`,
			)
			.get(input.narratorId, input.messageId) as Omit<
			RecallMessagePage,
			"text" | "offset" | "totalChars" | "hasMore" | "nextOffset"
		> | null;
		if (!row) return null;
		const raw = boundedBodyText(database, input.messageId, hasBlockStorage(database), {
			maxBytes: RECALL_DETAIL_BYTES,
		});
		if (raw === undefined)
			throw new DbReadError(
				"DB_READ_BUDGET",
				"Recall body unavailable or exceeds its source budget",
			);
		check(signal, deadlineAt);
		let blocks: unknown;
		try {
			blocks = JSON.parse(raw);
		} catch {
			throw new DbReadError("DB_READ_PROTOCOL", "Recall body is not valid stored JSON");
		}
		if (!Array.isArray(blocks))
			throw new DbReadError("DB_READ_PROTOCOL", "Recall body is not a content-block array");
		const omittedBlocks: string[] = [];
		for (const value of blocks) {
			const block = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
			if (
				!(block.type === "text" && typeof block.text === "string") &&
				!isNativeModelContextBlock(block)
			)
				omittedBlocks.push(String(block.type ?? "unknown"));
		}
		const text = Array.from(modelTextFromContentBlocks(blocks));
		const end = Math.min(text.length, input.offset + input.maxChars);
		const tools = database
			.query(
				"SELECT tool_use_id AS toolUseId, tool_name AS toolName, status, tool_name AS summary FROM narrator_tool_calls WHERE narrator_id = ? AND message_id = ? ORDER BY created_at, id LIMIT 10001",
			)
			.all(input.narratorId, input.messageId) as NonNullable<RecallMessagePage["toolCalls"]>;
		if (tools.length > 10000)
			throw new DbReadError("DB_READ_BUDGET", "Recall message tool count exceeds budget");
		const result: RecallMessagePage = {
			...row,
			origin: row.origin ?? null,
			originLabel: row.originLabel ?? null,
			text: text.slice(input.offset, end).join(""),
			offset: input.offset,
			totalChars: text.length,
			hasMore: end < text.length,
			nextOffset: end < text.length ? end : null,
			omittedBlocks,
			toolCalls: tools,
		};
		budget(Buffer.byteLength(JSON.stringify(result)), 512 * 1024);
		check(signal, deadlineAt);
		return result;
	})();
}

function basename(path: string) {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}
function extractStr(value: unknown, ...keys: string[]) {
	if (!value || typeof value !== "object") return "";
	for (const key of keys) {
		const field = (value as Record<string, unknown>)[key];
		if (typeof field === "string") return field;
	}
	return "";
}
export function getToolCallSummary(toolName: string, input: unknown): string {
	if (!input || typeof input !== "object") return toolName;
	if (["Read", "Write", "Edit", "Glob"].includes(toolName)) {
		const path = extractStr(input, "file_path", "filePath", "path", "pattern");
		return path ? basename(path) : toolName;
	}
	if (isBashToolName(toolName)) {
		const command = extractStr(input, "command");
		return command ? (command.length > 80 ? `${command.slice(0, 77)}...` : command) : toolName;
	}
	if (toolName === "Grep") {
		const pattern = extractStr(input, "pattern");
		return pattern ? (pattern.length > 60 ? `${pattern.slice(0, 57)}...` : pattern) : toolName;
	}
	if (toolName === "WebSearch") {
		const query = extractStr(input, "query");
		return query ? (query.length > 60 ? `${query.slice(0, 57)}...` : query) : "Web Search";
	}
	if (toolName === "WebFetch") {
		const url = extractStr(input, "url");
		const mode = extractStr(input, "mode");
		if (!url) return mode || "WebFetch";
		const short = url.length > 50 ? `${url.slice(0, 47)}...` : url;
		return mode ? `${mode}: ${short}` : short;
	}
	if (toolName === "Agent" || toolName === "Send")
		return extractStr(input, "description", "prompt", "message").slice(0, 60) || toolName;
	if (toolName === "Terminal") return extractStr(input, "action") || "Terminal";
	if (toolName === "ShareFile") {
		const path = extractStr(input, "path");
		return path ? basename(path) : "Share";
	}
	if (toolName === "AskUserQuestion") {
		const questions = (input as Record<string, unknown>).questions;
		if (Array.isArray(questions) && questions.length)
			return extractStr(questions[0], "header") || "Question";
	}
	if (toolName === "TaskCreate") return "Update todos";
	if (toolName === "EnterPlanMode") return "Enter plan mode";
	if (toolName === "ExitPlanMode") return "Plan ready";
	return toolName;
}
