import type { Database } from "bun:sqlite";
import { clearedToolOutputSql } from "@shared/narrator-blocks/retention";
import {
	buildSubagentSummarySqlExpr,
	normalizeSubagentToolInputSummary,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import type { SubagentActivityToolCall } from "../../services/narrator-messages";

export interface SubagentActivityParams {
	kind: "subagentActivity";
	narratorIds: string[];
}

export type SubagentActivityRows = Array<[string, SubagentActivityToolCall[]]>;

export const SUBAGENT_ACTIVITY_LIMIT = 3;
const MAX_OWNERS = 500;
const MAX_RESULT_BYTES = 16 * 1024 * 1024;

// Only capped, whitelisted leaves enter JS. Invalid or retained inputs are never parsed.
export const SUBAGENT_ACTIVITY_SUMMARY_SQL = `CASE
	WHEN NOT (${clearedToolOutputSql()}) THEN ${buildSubagentSummarySqlExpr("input_json")} END`;

interface ActivityRow {
	toolCallId: string;
	executionAttempt: number | null;
	toolUseId: string;
	toolName: string;
	status: string;
	createdAt: string | null;
	streamStartedAt: string | number | null;
	streamCompletedAt: string | number | null;
	permissionStartedAt: string | number | null;
	executionStartedAt: string | number | null;
	completedAt: string | number | null;
	durationMs: number | null;
	inputSummary: string | null;
}

function parseSummary(encoded: string | null): SubagentToolInputSummary | null {
	try {
		return encoded ? normalizeSubagentToolInputSummary(JSON.parse(encoded)) : null;
	} catch {
		return null;
	}
}

export function projectActivityRow(row: ActivityRow): SubagentActivityToolCall {
	const {
		toolCallId,
		executionAttempt,
		toolUseId,
		toolName,
		status,
		createdAt,
		inputSummary: encoded,
		...timing
	} = row;
	const inputSummary = parseSummary(encoded);
	return {
		toolCallId: toolCallId ?? null,
		...(executionAttempt != null ? { executionAttempt } : {}),
		toolUseId,
		toolName,
		status,
		createdAt: createdAt ?? null,
		timing: Object.values(timing).some((value) => value != null) ? timing : null,
		...(inputSummary ? { inputSummary } : {}),
	};
}

export function readSubagentActivity(
	sqlite: Database,
	{ narratorIds }: SubagentActivityParams,
	signal: AbortSignal,
): SubagentActivityRows {
	if (narratorIds.length > MAX_OWNERS) throw new Error("Subagent activity owner budget exceeded");
	const query = sqlite.query<ActivityRow, [string]>(`
		SELECT id AS toolCallId, tool_use_id AS toolUseId, tool_name AS toolName, status,
			execution_attempt AS executionAttempt,
			created_at AS createdAt, stream_started_at AS streamStartedAt,
			stream_completed_at AS streamCompletedAt, permission_started_at AS permissionStartedAt,
			execution_started_at AS executionStartedAt, completed_at AS completedAt,
			duration_ms AS durationMs, ${SUBAGENT_ACTIVITY_SUMMARY_SQL} AS inputSummary
		FROM narrator_tool_calls
		WHERE narrator_id = ? AND is_file_history_checkpoint = 0
			AND EXISTS (SELECT 1 FROM narrator_message_refs r
				WHERE r.narrator_id = narrator_tool_calls.narrator_id
				AND r.message_id = narrator_tool_calls.message_id)
		ORDER BY created_at DESC, id DESC LIMIT ${SUBAGENT_ACTIVITY_LIMIT}`);
	return sqlite.transaction(() => {
		const activity: SubagentActivityRows = [];
		let bytes = 2;
		for (const id of new Set(narratorIds)) {
			signal.throwIfAborted();
			const item = [
				id,
				query.all(id).reverse().map(projectActivityRow),
			] as SubagentActivityRows[number];
			bytes += 1 + Buffer.byteLength(JSON.stringify(item));
			if (bytes > MAX_RESULT_BYTES) throw new Error("Subagent activity result budget exceeded");
			activity.push(item);
		}
		return activity;
	})();
}
