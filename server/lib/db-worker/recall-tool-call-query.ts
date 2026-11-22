import type { Database } from "bun:sqlite";
import { getToolCallSummary } from "../agent/recall-tool-summary";
import type { ToolResult } from "../agent/types";
import { SELECT_ROWS_MAX_PARAMS_BYTES } from "./protocol";

export interface RecallToolCallParams {
	kind: "recallToolCall";
	toolUseId: string;
	narratorId: string | null;
}

interface ToolCallRow {
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

const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_RESULT_BYTES = 48 * 1024 * 1024;
const MAX_TOOL_CALL_OUTPUT = 4000;

export function readRecallToolCall(
	sqlite: Database,
	params: RecallToolCallParams,
	signal: AbortSignal,
): ToolResult | null {
	signal.throwIfAborted();
	const { toolUseId, narratorId } = params;
	if (Buffer.byteLength(toolUseId) > SELECT_ROWS_MAX_PARAMS_BYTES) {
		throw new Error("Recall tool call reference exceeds its byte budget");
	}

	const row = sqlite.transaction(() => {
		const candidate = sqlite
			.query<{ id: string; bytes: number }, string[]>(
				`SELECT tc.id, octet_length(tc.id) + octet_length(tc.tool_use_id) +
					octet_length(tc.tool_name) + octet_length(tc.status) + octet_length(tc.created_at) +
					octet_length(tc.narrator_id) + coalesce(octet_length(n.title), 0) +
					coalesce(octet_length(tc.error_message), 0) + coalesce(octet_length(tc.input_json), 0) +
					coalesce(octet_length(tc.output_json), 0) AS bytes
				FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id
				WHERE tc.tool_use_id = ? ${narratorId === null ? "" : "AND tc.narrator_id = ?"} LIMIT 1`,
			)
			.get(...(narratorId === null ? [toolUseId] : [toolUseId, narratorId]));
		if (!candidate) return null;
		if (candidate.bytes > MAX_SOURCE_BYTES) {
			throw new Error("Recall tool call source exceeds its byte budget");
		}
		signal.throwIfAborted();
		return sqlite
			.query<ToolCallRow, [string]>(
				`SELECT tc.tool_use_id, tc.tool_name, tc.status, tc.input_json, tc.output_json,
					tc.duration_ms, tc.error_message, tc.created_at, tc.narrator_id, n.title AS narrator_title
				FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id
				WHERE tc.id = ?`,
			)
			.get(candidate.id);
	})();
	if (!row) return null;
	signal.throwIfAborted();
	const result = formatToolCall(row);
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES) {
		throw new Error("Recall tool call result exceeds its byte budget");
	}
	signal.throwIfAborted();
	return result;
}

function formatToolCall(tc: ToolCallRow): ToolResult {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	let inputParsed: any = null;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON
	let outputParsed: any = null;
	try {
		inputParsed = tc.input_json ? JSON.parse(tc.input_json) : null;
	} catch {
		// keep raw
	}
	try {
		outputParsed = tc.output_json ? JSON.parse(tc.output_json) : null;
	} catch {
		// keep raw
	}

	const summary = getToolCallSummary(tc.tool_name, inputParsed);

	const lines: string[] = [
		`Tool: ${tc.tool_name} — ${summary}`,
		`Status: ${tc.status}${tc.duration_ms != null ? ` (${tc.duration_ms}ms)` : ""}`,
		`Narrator: ${tc.narrator_title ?? tc.narrator_id}`,
		`Created: ${tc.created_at}`,
	];

	if (tc.error_message) {
		lines.push(`\nError: ${tc.error_message}`);
	}

	// Input
	lines.push("\n--- Input ---");
	const inputStr = inputParsed ? JSON.stringify(inputParsed, null, 2) : (tc.input_json ?? "(none)");
	lines.push(
		inputStr.length > MAX_TOOL_CALL_OUTPUT
			? `${inputStr.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${inputStr.length} chars total)`
			: inputStr,
	);

	// Output
	lines.push("\n--- Output ---");
	if (outputParsed) {
		// outputJson may have _text (common for bash/read results)
		const textContent = typeof outputParsed._text === "string" ? outputParsed._text : null;
		const outputStr = textContent ?? JSON.stringify(outputParsed, null, 2);
		lines.push(
			outputStr.length > MAX_TOOL_CALL_OUTPUT
				? `${outputStr.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${outputStr.length} chars total)`
				: outputStr,
		);
	} else {
		const raw = tc.output_json ?? "(none)";
		lines.push(
			raw.length > MAX_TOOL_CALL_OUTPUT
				? `${raw.slice(0, MAX_TOOL_CALL_OUTPUT)}\n... (truncated, ${raw.length} chars total)`
				: raw,
		);
	}

	return {
		output: lines.join("\n"),
		title: `${tc.tool_name}: ${summary}`,
		metadata: {
			action: "read_tool_call",
			toolUseId: tc.tool_use_id,
			toolName: tc.tool_name,
			status: tc.status,
			durationMs: tc.duration_ms,
			narratorId: tc.narrator_id,
			narratorTitle: tc.narrator_title,
			input: inputParsed,
			output: outputParsed,
		},
	};
}
