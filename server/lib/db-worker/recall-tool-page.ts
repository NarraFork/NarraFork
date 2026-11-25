import type { Database } from "bun:sqlite";
import type { PgExecutor } from "../../db/pg-fts";
import type { ToolResult } from "../agent/types";
import {
	RECALL_LIMITS,
	type RecallTextPage,
	type RecallToolCallPageInput,
} from "../recall-contract";
import { DbReadError } from "./errors";

const SOURCE_BYTES = 40 * 1024 * 1024;
const RESULT_BYTES = 512 * 1024;
const FROM = `FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id
LEFT JOIN narrator_questions q ON q.tool_call_id = tc.id AND q.narrator_id = tc.narrator_id`;
const COLUMNS = `tc.id, tc.tool_use_id, tc.tool_name, tc.status, tc.duration_ms,
tc.error_message, tc.created_at, tc.narrator_id, n.title AS narrator_title,
tc.permission_decided_by, tc.permission_decided_at,
q.id AS question_id, q.status AS question_status, q.origin AS question_origin,
q.answer_message_id, q.decided_by AS question_decided_by, q.decided_at AS question_decided_at`;
const SOURCE_COLUMNS = [
	"tc.id",
	"tc.tool_use_id",
	"tc.tool_name",
	"tc.status",
	"tc.error_message",
	"tc.created_at",
	"tc.narrator_id",
	"n.title",
	"tc.permission_decided_by",
	"tc.permission_decided_at",
	"tc.input_json",
	"tc.output_json",
	"q.id",
	"q.status",
	"q.origin",
	"q.answer_message_id",
	"q.decided_by",
	"q.decided_at",
	"q.questions_json",
	"q.answers_json",
];
interface Row {
	id: string;
	tool_use_id: string;
	tool_name: string;
	status: string;
	duration_ms: number | null;
	error_message: string | null;
	created_at: string;
	narrator_id: string;
	narrator_title: string | null;
	permission_decided_by: string | null;
	permission_decided_at: string | null;
	question_id: string | null;
	question_status: string | null;
	question_origin: string | null;
	answer_message_id: string | null;
	question_decided_by: string | null;
	question_decided_at: string | null;
}
interface Pages {
	input: RecallTextPage | null;
	output: RecallTextPage | null;
	questions: RecallTextPage | null;
	answers: RecallTextPage | null;
}
function check(signal?: AbortSignal, deadlineAt = Number.POSITIVE_INFINITY): void {
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Recall read cancelled");
	if (Date.now() >= deadlineAt)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall read deadline expired");
}
function budget(bytes: number, maximum: number, kind: string): void {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximum)
		throw new DbReadError("DB_READ_BUDGET", `Recall tool call ${kind} exceeds its byte budget`);
}
function validate(input: RecallToolCallPageInput): void {
	if (
		typeof input.toolCallId !== "string" ||
		!input.toolCallId ||
		(input.narratorId !== null && (typeof input.narratorId !== "string" || !input.narratorId)) ||
		!["both", "input", "output"].includes(input.part) ||
		!Number.isSafeInteger(input.offset) ||
		input.offset < 0 ||
		!Number.isSafeInteger(input.maxChars) ||
		input.maxChars < 1 ||
		input.maxChars > RECALL_LIMITS.maxPageChars
	)
		throw new DbReadError("DB_READ_INVALID", "Invalid Recall tool call page request");
	budget(
		Buffer.byteLength(input.toolCallId) + Buffer.byteLength(input.narratorId ?? ""),
		4096,
		"reference",
	);
}
function page(
	text: string | null,
	input: RecallToolCallPageInput,
	verify: () => void,
): RecallTextPage | null {
	if (text === null) return null;
	let totalChars = 0;
	const parts: string[] = [];
	for (const point of text) {
		if ((totalChars & 16383) === 0) verify();
		if (totalChars >= input.offset && totalChars - input.offset < input.maxChars) parts.push(point);
		totalChars++;
	}
	const hasMore = totalChars > input.offset + parts.length;
	return {
		text: parts.join(""),
		offset: input.offset,
		totalChars,
		hasMore,
		nextOffset: hasMore ? input.offset + parts.length : null,
	};
}
function emptyPage(offset: number): RecallTextPage {
	return { text: "", offset, totalChars: 0, hasMore: false, nextOffset: null };
}
function format(row: Row, pages: Pages, input: RecallToolCallPageInput): ToolResult {
	const question =
		row.tool_name === "AskUserQuestion" || row.question_id !== null
			? {
					id: row.question_id,
					status: row.question_status,
					origin: row.question_origin,
					questions: pages.questions,
					answers: pages.answers,
					answerMessageId: row.answer_message_id,
					decidedBy: row.question_id === null ? row.permission_decided_by : row.question_decided_by,
					decidedAt: row.question_id === null ? row.permission_decided_at : row.question_decided_at,
				}
			: null;
	const lines = [
		`Tool: ${row.tool_name} (${row.tool_use_id})`,
		`Status: ${row.status}${row.duration_ms === null ? "" : ` (${row.duration_ms}ms)`}`,
		`Narrator: ${row.narrator_title ?? row.narrator_id} (${row.narrator_id})`,
		`Created: ${row.created_at}`,
		`Permission decided by: ${row.permission_decided_by ?? "unknown"}; at: ${row.permission_decided_at ?? "unknown"}`,
	];
	if (row.error_message) lines.push(`Error: ${row.error_message}`);
	const addPage = (label: string, value: RecallTextPage | null) => {
		if (value === null) {
			lines.push(`\n--- ${label} ---\n(none)`);
			return;
		}
		lines.push(
			`\n--- ${label} [offset ${value.offset}; ${value.totalChars} code points total] ---`,
			value.text,
		);
		if (value.hasMore) lines.push(`(truncated; next_offset: ${value.nextOffset})`);
	};
	if (input.part !== "output") addPage("Input (stored JSON or text)", pages.input);
	if (input.part !== "input") addPage("Output (stored JSON or text)", pages.output);
	if (question) {
		lines.push(
			`\nQuestion evidence; decided by: ${question.decidedBy ?? "unknown"}; at: ${question.decidedAt ?? "unknown"}`,
		);
		if (question.id)
			lines.push(
				`Question: ${question.id}; answer_message_id: ${question.answerMessageId ?? "none"}`,
			);
		addPage("Original questions (JSON)", pages.questions);
		addPage("Saved answers (JSON; not resolve.note)", pages.answers);
	}
	const result: ToolResult = {
		output: lines.join("\n"),
		title: `${row.tool_name}: ${row.tool_use_id}`,
		truncated: Object.values(pages).some((value) => value?.hasMore),
		metadata: {
			action: "read_tool_call",
			toolCallId: row.id,
			toolUseId: row.tool_use_id,
			toolName: row.tool_name,
			status: row.status,
			durationMs: row.duration_ms,
			narratorId: row.narrator_id,
			narratorTitle: row.narrator_title,
			createdAt: row.created_at,
			errorMessage: row.error_message,
			permissionDecidedBy: row.permission_decided_by,
			permissionDecidedAt: row.permission_decided_at,
			part: input.part,
			textFormat: "stored_json_or_text",
			pages: {
				...(input.part !== "output" ? { input: pages.input ?? emptyPage(input.offset) } : {}),
				...(input.part !== "input" ? { output: pages.output ?? emptyPage(input.offset) } : {}),
			},
			question,
		},
	};
	budget(Buffer.byteLength(JSON.stringify(result)), RESULT_BYTES, "result");
	return result;
}

/** Worker-only: bounded source JSON parsing must not be called as an inline fallback. */
export function readRecallToolCallPage(
	database: Database,
	input: RecallToolCallPageInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): ToolResult | null {
	validate(input);
	const verify = () => check(signal, deadlineAt);
	verify();
	return database.transaction(() => {
		const where = `WHERE tc.tool_use_id = ? ${input.narratorId === null ? "" : "AND tc.narrator_id = ?"} LIMIT 1`;
		const params =
			input.narratorId === null ? [input.toolCallId] : [input.toolCallId, input.narratorId];
		const sizes = database.prepare(
			`SELECT ${SOURCE_COLUMNS.map((column) => `coalesce(octet_length(${column}),0)`).join(" + ")} + 1024 AS bytes ${FROM} ${where}`,
		);
		let size: { bytes: number } | null;
		try {
			size = sizes.get(...params) as typeof size;
		} finally {
			sizes.finalize();
		}
		if (!size) return null;
		budget(size.bytes, SOURCE_BYTES, "source");
		verify();
		const query = database.prepare(
			`SELECT ${COLUMNS}, tc.input_json, tc.output_json, q.questions_json, q.answers_json ${FROM} ${where}`,
		);
		let row:
			| (Row & {
					input_json: string | null;
					output_json: string | null;
					questions_json: string | null;
					answers_json: string | null;
			  })
			| null;
		try {
			row = query.get(...params) as typeof row;
		} finally {
			query.finalize();
		}
		if (!row) return null;
		verify();
		return projectRecallToolCallRow(row, input, verify);
	})();
}

export interface RecallToolPageSource extends Row {
	input_json: string | null;
	output_json: string | null;
	questions_json: string | null;
	answers_json: string | null;
}

/** Worker-only pure projection, shared by SQLite reads and the isolated PG projector. */
export function projectRecallToolCallRow(
	row: RecallToolPageSource,
	input: RecallToolCallPageInput,
	verify: () => void,
): ToolResult {
	validate(input);
	verify();
	budget(
		Object.values(row).reduce<number>(
			(bytes, value) => bytes + (typeof value === "string" ? Buffer.byteLength(value) : 16),
			1024,
		),
		SOURCE_BYTES,
		"source",
	);
	let questions = row.questions_json;
	let answers = row.answers_json;
	if (row.tool_name === "AskUserQuestion" && row.question_id === null && row.input_json !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(row.input_json);
		} catch {
			throw new DbReadError("DB_READ_FAILED", "Saved question input is not valid JSON");
		}
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const value = parsed as Record<string, unknown>;
			questions = value.questions === undefined ? null : JSON.stringify(value.questions);
			answers = value.answers === undefined ? null : JSON.stringify(value.answers);
		}
	}
	verify();
	const result = format(
		row,
		{
			input: input.part === "output" ? null : page(row.input_json, input, verify),
			output: input.part === "input" ? null : page(row.output_json, input, verify),
			questions: page(questions, input, verify),
			answers: page(answers, input, verify),
		},
		input,
	);
	verify();
	return result;
}

/** PG transfers only admitted raw TEXT; JSON decoding and paging remain in a Worker. */
export async function readRecallToolCallPagePg(
	pg: PgExecutor,
	input: RecallToolCallPageInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): Promise<ToolResult | null> {
	validate(input);
	const verify = () => check(signal, deadlineAt);
	verify();
	const where = `WHERE tc.tool_use_id = $1 ${input.narratorId === null ? "" : "AND tc.narrator_id = $2"} LIMIT 1`;
	const params: unknown[] =
		input.narratorId === null ? [input.toolCallId] : [input.toolCallId, input.narratorId];
	const sizeExpression = SOURCE_COLUMNS.map(
		(column) => `coalesce(octet_length(${column}::text),0)::bigint`,
	).join(" + ");
	const metadataBytes = SOURCE_COLUMNS.filter((column) => !column.endsWith("_json"))
		.map((column) => `coalesce(octet_length(${column}::text),0)::bigint`)
		.join(" + ");
	const { runRecallPgProjection } = await import("./recall-pg-projection-client");
	return runRecallPgProjection<ToolResult>(
		async (taskSignal, taskDeadline) => {
			const taskCheck = () => check(taskSignal, taskDeadline);
			taskCheck();
			const source = `SELECT ${COLUMNS}, tc.input_json::text AS input_json, tc.output_json::text AS output_json,
		q.questions_json::text AS questions_json, q.answers_json::text AS answers_json,
		${sizeExpression} + 1024 AS source_bytes, ${metadataBytes} AS metadata_bytes ${FROM} ${where}`;
			// Materialized admission keeps even concurrent source changes bounded before transfer.
			const result = await pg.unsafe(
				`WITH source AS MATERIALIZED (${source}), admitted AS MATERIALIZED (
			SELECT * FROM source WHERE source_bytes <= ${SOURCE_BYTES} AND metadata_bytes <= ${RESULT_BYTES}
		) SELECT admitted.*, source.source_bytes, source.metadata_bytes
		FROM source LEFT JOIN admitted ON admitted.id = source.id`,
				params,
			);
			taskCheck();
			const row = result[0];
			if (!row) return null;
			budget(Number(row.source_bytes), SOURCE_BYTES, "source");
			budget(Number(row.metadata_bytes), RESULT_BYTES, "result metadata");
			return { kind: "tool", input, row: row as unknown as RecallToolPageSource };
		},
		signal,
		deadlineAt,
	);
}
