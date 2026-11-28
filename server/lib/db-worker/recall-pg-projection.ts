import { isNativeModelContextBlock } from "../../../shared/native-injection";
import type { ToolResult } from "../agent/types";
import type {
	RecallMessageInput,
	RecallMessagePage,
	RecallToolCallPageInput,
} from "../recall-contract";
import { DbReadError } from "./errors";
import { projectRecallToolCallRow, type RecallToolPageSource } from "./recall-tool-page";

export const RECALL_PG_SOURCE_BYTES = 40 * 1024 * 1024;
export const RECALL_PG_RESULT_BYTES = 512 * 1024;
export interface RecallPgMessageSource {
	messageId: string;
	narratorId: string;
	narratorTitle: string | null;
	role: string;
	origin: string | null;
	createdAt: string;
	seq: number | string;
	bodyRevision: number | string;
	contentJson: string;
	toolCalls: NonNullable<RecallMessagePage["toolCalls"]>;
}
export type RecallPgProjectionRequest =
	| { kind: "message"; input: RecallMessageInput; row: RecallPgMessageSource }
	| { kind: "tool"; input: RecallToolCallPageInput; row: RecallToolPageSource }
	| { kind: "summaries"; rows: Record<string, unknown>[] };
export type RecallPgProjectionResult = RecallMessagePage | ToolResult | Record<string, unknown>[];

const SUMMARY_KEYS = [
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
function projectSummaries(rows: Record<string, unknown>[], verify: () => void) {
	if (rows.length > 128)
		throw new DbReadError("DB_READ_BUDGET", "Recall summary batch exceeds budget");
	let bytes = 0;
	const result = rows.map(
		({ recall_summary_input: raw, recall_summary_oversized: oversized, ...metadata }) => {
			verify();
			if (oversized)
				throw new DbReadError("DB_READ_BUDGET", "Recall summary source exceeds budget");
			bytes += typeof raw === "string" ? Buffer.byteLength(raw) : 0;
			if (bytes > 64 * 1024 * 1024 || Buffer.byteLength(JSON.stringify(metadata)) > 8192)
				throw new DbReadError("DB_READ_BUDGET", "Recall summary source exceeds budget");
			let parsed: unknown;
			try {
				parsed = typeof raw === "string" ? JSON.parse(raw) : null;
			} catch {
				// Same behavior as SQLite's json_valid guard for legacy non-JSON input.
				parsed = null;
			}
			const value =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: {};
			const clip = (item: unknown) => {
				if (item === undefined || item === null) return null;
				const text = typeof item === "string" ? item : JSON.stringify(item);
				let result = "",
					count = 0;
				for (const point of text) {
					if (count++ === 512) break;
					result += point;
				}
				return result;
			};
			for (const key of SUMMARY_KEYS) metadata[key] = clip(value[key]);
			const question = Array.isArray(value.questions) ? value.questions[0] : null;
			metadata.question_header = clip(
				question && typeof question === "object" ? question.header : null,
			);
			return metadata;
		},
	);
	if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024)
		throw new DbReadError("DB_READ_BUDGET", "Recall summary result exceeds budget");
	verify();
	return result;
}

/** Pure Worker core. Production callers must dispatch through recall-pg-projection-client. */
export function projectRecallPg(
	request: RecallPgProjectionRequest,
	deadlineAt: number,
): RecallPgProjectionResult {
	const verify = () => {
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall projection deadline expired");
	};
	verify();
	if (request.kind === "summaries") return projectSummaries(request.rows, verify);
	if (request.kind === "tool") return projectRecallToolCallRow(request.row, request.input, verify);
	const { row, input } = request;
	if (Buffer.byteLength(row.contentJson) > RECALL_PG_SOURCE_BYTES)
		throw new DbReadError("DB_READ_BUDGET", "Recall body exceeds its source budget");
	let blocks: unknown;
	try {
		blocks = JSON.parse(row.contentJson);
	} catch {
		throw new DbReadError("DB_READ_PROTOCOL", "Recall body is not valid stored JSON");
	}
	if (!Array.isArray(blocks))
		throw new DbReadError("DB_READ_PROTOCOL", "Recall body is not a content-block array");
	verify();
	let totalChars = 0;
	let visibleBlocks = 0;
	let omissionBytes = 2;
	const parts: string[] = [];
	const omittedBlocks: string[] = [];
	const append = (text: string) => {
		for (const point of text) {
			if ((totalChars & 16383) === 0) verify();
			if (totalChars >= input.offset && totalChars - input.offset < input.maxChars)
				parts.push(point);
			totalChars++;
		}
	};
	for (const value of blocks) {
		verify();
		const block = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		const text =
			block.type === "text" && typeof block.text === "string"
				? block.text
				: isNativeModelContextBlock(block)
					? block.modelText
					: null;
		if (text !== null) {
			if (visibleBlocks++) append("\n");
			append(text);
		} else {
			const type = String(block.type ?? "unknown");
			omissionBytes += Buffer.byteLength(JSON.stringify(type)) + 1;
			if (omissionBytes > 128 * 1024)
				throw new DbReadError("DB_READ_BUDGET", "Recall omitted-block metadata exceeds budget");
			omittedBlocks.push(type);
		}
	}
	const hasMore = totalChars > input.offset + parts.length;
	// Explicit projection: never forward origin_label or other raw persisted fields.
	const result: RecallMessagePage = {
		messageId: row.messageId,
		narratorId: row.narratorId,
		narratorTitle: row.narratorTitle,
		role: row.role,
		origin: row.origin ?? null,
		createdAt: row.createdAt,
		seq: Number(row.seq),
		bodyRevision: Number(row.bodyRevision),
		text: parts.join(""),
		offset: input.offset,
		totalChars,
		hasMore,
		nextOffset: hasMore ? input.offset + parts.length : null,
		omittedBlocks,
		toolCalls: row.toolCalls,
	};
	if (Buffer.byteLength(JSON.stringify(result)) > RECALL_PG_RESULT_BYTES)
		throw new DbReadError("DB_READ_BUDGET", "Recall message result exceeds budget");
	verify();
	return result;
}
