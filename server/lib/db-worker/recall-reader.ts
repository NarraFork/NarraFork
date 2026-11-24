import type { Database } from "bun:sqlite";
import { isBashToolName } from "../agent/tool-name";
import { DbReadError } from "./errors";

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
		content_text: string | null;
		created_at: string;
		seq: number;
	}[];
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
export interface RecallConversationInput {
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
export function readRecallConversation(
	database: Database,
	input: RecallConversationInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): RecallConversationSnapshot {
	check(signal, deadlineAt);
	return database.transaction(() => {
		const narratorQuery = database.prepare(
			"SELECT id, title, model FROM narrators WHERE id = ? LIMIT 1",
		);
		let narrator: RecallConversationSnapshot["narrator"];
		try {
			narrator = (narratorQuery.get(input.narratorId) as typeof narrator) ?? null;
		} finally {
			narratorQuery.finalize();
		}
		const result: RecallConversationSnapshot = {
			narrator,
			messageMissing: false,
			rows: [],
			tools: [],
		};
		if (!narrator) return result;
		const columns =
			"m.id, m.role, substr(m.content_text, 1, 500) AS content_text, m.created_at, r.seq";
		let rowsQuery: ReturnType<Database["prepare"]>;
		if (input.messageId) {
			const refQuery = database.prepare(
				"SELECT seq FROM narrator_message_refs WHERE narrator_id = ? AND message_id = ? LIMIT 1",
			);
			let ref: { seq: number } | null;
			try {
				ref = refQuery.get(input.narratorId, input.messageId) as typeof ref;
			} finally {
				refQuery.finalize();
			}
			if (!ref) return { ...result, messageMissing: true };
			const half = Math.floor(input.limit / 2);
			rowsQuery = database.prepare(
				`SELECT ${columns} FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? AND r.seq >= ? AND r.seq <= ? ORDER BY r.seq ASC LIMIT 51`,
			);
			try {
				result.rows = rowsQuery.all(
					input.narratorId,
					ref.seq - half,
					ref.seq + input.limit - half,
				) as typeof result.rows;
			} finally {
				rowsQuery.finalize();
			}
		} else {
			rowsQuery = database.prepare(
				`SELECT ${columns} FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = ? ORDER BY r.seq DESC LIMIT ?`,
			);
			try {
				result.rows = (
					rowsQuery.all(input.narratorId, input.limit) as typeof result.rows
				).reverse();
			} finally {
				rowsQuery.finalize();
			}
		}
		if (!result.rows.length) return result;
		const ids = result.rows.map((row) => row.id);
		const toolsQuery = database.prepare(
			`SELECT id, tool_use_id, tool_name, status, message_id, created_at FROM narrator_tool_calls WHERE message_id IN (${ids.map(() => "?").join(",")}) AND narrator_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT 128`,
		);
		let time = "",
			id = "",
			bytes = 0;
		try {
			while (true) {
				check(signal, deadlineAt);
				const tools = toolsQuery.all(...ids, input.narratorId, time, id) as Array<{
					id: string;
					tool_use_id: string;
					tool_name: string;
					status: string;
					message_id: string;
					created_at: string;
				}>;
				for (const tool of tools) {
					if (result.tools.length >= 10_000)
						throw new DbReadError("DB_READ_BUDGET", "Recall tool count exceeds its source budget");
					const raw = textColumn(
						database,
						tool.id,
						"input_json",
						RECALL_CONVERSATION_INPUT_BYTES - bytes,
						signal,
						deadlineAt,
					);
					bytes += Buffer.byteLength(raw ?? "");
					let parsed: unknown = null;
					try {
						parsed = raw ? JSON.parse(raw) : null;
					} catch {
						/* Invalid JSON retains the tool-name summary. */
					}
					result.tools.push({
						tool_use_id: tool.tool_use_id,
						tool_name: tool.tool_name,
						status: tool.status,
						message_id: tool.message_id,
						summary: getToolCallSummary(tool.tool_name, parsed),
					});
				}
				if (tools.length < 128) break;
				time = tools[tools.length - 1].created_at;
				id = tools[tools.length - 1].id;
			}
		} finally {
			toolsQuery.finalize();
		}
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
