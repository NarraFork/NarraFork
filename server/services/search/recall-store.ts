import { activeDatabaseBackend, postgresRuntime, sqlite } from "../../db";
import type { PgExecutor } from "../../db/pg-fts";
import { type ReadQueryOptions, readDomainTask } from "../../db/worker-read";
import type { ToolResult } from "../../lib/agent/types";
import { createDomainReadParams } from "../../lib/db-worker/domain-protocol";
import { DbReadError } from "../../lib/db-worker/errors";
import { readRecallMessagePg } from "../../lib/db-worker/recall-pg-message-reader";
import { runRecallPgProjection } from "../../lib/db-worker/recall-pg-projection-client";
import { readRecallToolCallPagePg } from "../../lib/db-worker/recall-tool-page";
import type {
	RecallMessageInput,
	RecallMessagePage,
	RecallToolCallPageInput,
} from "../../lib/recall-contract";
import {
	RECALL_DETAIL_BYTES,
	type RecallConversationInput,
	type RecallConversationSnapshot,
	type RecallToolCallDetailInput,
	type RecallToolCallRow,
	recallConversationQueries,
} from "./recall-reader";

function executor(): PgExecutor {
	if (!postgresRuntime || postgresRuntime.closed)
		throw new DbReadError("DB_READ_UNAVAILABLE", "Recall database unavailable");
	return postgresRuntime.executor;
}
function jsonText(value: unknown): string | null {
	return value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
}
type RecallReadOptions = Pick<ReadQueryOptions, "signal" | "deadlineAt" | "timeoutMs">;
function check(signal: AbortSignal | undefined, options: RecallReadOptions) {
	signal?.throwIfAborted();
	if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall read deadline expired");
}
function deadline(options: RecallReadOptions) {
	return Math.min(options.deadlineAt ?? Infinity, Date.now() + (options.timeoutMs ?? 30000));
}
export async function recallToolCallDetail(
	input: RecallToolCallDetailInput,
	signal?: AbortSignal,
	options: RecallReadOptions = {},
): Promise<RecallToolCallRow | null> {
	signal ??= options.signal;
	createDomainReadParams("recallToolCallDetail", input);
	check(signal, options);
	if (activeDatabaseBackend !== "postgres")
		return readDomainTask(sqlite, "recallToolCallDetail", input, {
			...options,
			executionPolicy: "worker-required",
			signal,
		});
	const pg = executor();
	const params = [input.toolCallId, input.narratorId];
	const scope = "tc.tool_use_id = $1 AND ($2::text IS NULL OR tc.narrator_id = $2)";
	const sizes = await pg.unsafe(
		`SELECT coalesce(octet_length(tc.input_json::text),0) + coalesce(octet_length(tc.output_json::text),0) + coalesce(octet_length(tc.error_message),0) + 4096 AS bytes FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id WHERE ${scope} LIMIT 1`,
		params,
	);
	check(signal, options);
	if (!sizes[0]) return null;
	if (Number(sizes[0].bytes) > RECALL_DETAIL_BYTES)
		throw new DbReadError("DB_READ_BUDGET", "Recall detail exceeds its source budget");
	const rows = await pg.unsafe(
		`SELECT tc.tool_use_id, tc.tool_name, tc.status, tc.input_json, tc.output_json, tc.duration_ms, tc.error_message, tc.created_at, tc.narrator_id, n.title AS narrator_title FROM narrator_tool_calls tc JOIN narrators n ON n.id = tc.narrator_id WHERE ${scope} AND coalesce(octet_length(tc.input_json::text),0) + coalesce(octet_length(tc.output_json::text),0) + coalesce(octet_length(tc.error_message),0) + 4096 <= $3 LIMIT 1`,
		[...params, RECALL_DETAIL_BYTES],
	);
	check(signal, options);
	if (!rows[0])
		throw new DbReadError("DB_READ_BUDGET", "Recall detail changed beyond its source budget");
	return {
		...rows[0],
		input_json: jsonText(rows[0].input_json),
		output_json: jsonText(rows[0].output_json),
	} as unknown as RecallToolCallRow;
}
export async function recallConversation(
	input: RecallConversationInput,
	signal?: AbortSignal,
	options: RecallReadOptions = {},
): Promise<RecallConversationSnapshot> {
	signal ??= options.signal;
	createDomainReadParams("recallConversation", input);
	check(signal, options);
	if (activeDatabaseBackend !== "postgres") {
		const result = await readDomainTask(sqlite, "recallConversation", input, {
			...options,
			executionPolicy: "worker-required",
			signal,
		});
		check(signal, options);
		return result;
	}
	const pg = executor(),
		deadlineAt = deadline(options);
	const plan = recallConversationQueries(input, true);
	let step = plan.next();
	while (!step.done) {
		check(signal, { deadlineAt });
		const query = step.value;
		const rows = query.sql.includes("recall_summary_input")
			? await runRecallPgProjection<Record<string, unknown>[]>(
					async (taskSignal, taskDeadline) => {
						check(taskSignal, { deadlineAt: taskDeadline });
						const rows = await pg.unsafe(query.sql, query.params);
						check(taskSignal, { deadlineAt: taskDeadline });
						if (rows.some((row) => row.recall_summary_oversized))
							throw new DbReadError("DB_READ_BUDGET", "Recall summary source exceeds budget");
						return { kind: "summaries", rows: rows as Record<string, unknown>[] };
					},
					signal,
					deadlineAt,
				)
			: await pg.unsafe(query.sql, query.params);
		check(signal, { deadlineAt });
		step = plan.next((rows ?? []) as Record<string, unknown>[]);
	}
	return step.value;
}
export async function recallToolCallPage(
	input: RecallToolCallPageInput,
	signal?: AbortSignal,
	options: RecallReadOptions = {},
): Promise<ToolResult | null> {
	signal ??= options.signal;
	createDomainReadParams("recallToolCallPage", input);
	check(signal, options);
	if (activeDatabaseBackend !== "postgres") {
		const result = await readDomainTask(sqlite, "recallToolCallPage", input, {
			...options,
			executionPolicy: "worker-required",
			signal,
		});
		check(signal, options);
		return result;
	}
	return readRecallToolCallPagePg(executor(), input, signal, deadline(options));
}
export async function recallMessage(
	input: RecallMessageInput,
	signal?: AbortSignal,
	options: RecallReadOptions = {},
): Promise<RecallMessagePage | null> {
	signal ??= options.signal;
	createDomainReadParams("recallMessage", input);
	check(signal, options);
	if (activeDatabaseBackend !== "postgres") {
		const result = await readDomainTask(sqlite, "recallMessage", input, {
			...options,
			executionPolicy: "worker-required",
			signal,
		});
		check(signal, options);
		return result;
	}
	return readRecallMessagePg(executor(), input, signal, deadline(options));
}
