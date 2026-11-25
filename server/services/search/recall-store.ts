import { activeDatabaseBackend, postgresRuntime, sqlite } from "../../db";
import type { PgExecutor } from "../../db/pg-fts";
import { type ReadQueryOptions, readDomainTask } from "../../db/worker-read";
import type { ToolResult } from "../../lib/agent/types";
import { createDomainReadParams } from "../../lib/db-worker/domain-protocol";
import { DbReadError } from "../../lib/db-worker/errors";
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
		const rows = await pg.unsafe(step.value.sql, step.value.params);
		check(signal, { deadlineAt });
		step = plan.next(rows as Record<string, unknown>[]);
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
	// PG body readers use the persisted content_json projection (block-row reads are SQLite-only).
	// All JSON decoding, joining and code-point slicing stays in PostgreSQL, not this thread.
	const pg = executor(),
		deadlineAt = deadline(options);
	const params = [input.narratorId, input.messageId];
	const scope =
		"FROM narrator_message_refs r JOIN narrator_messages m ON m.id=r.message_id JOIN narrators n ON n.id=r.narrator_id WHERE r.narrator_id=$1 AND r.message_id=$2";
	const sizes = await pg.unsafe(
		`SELECT octet_length(m.content_json::text) AS bytes, coalesce(octet_length(n.title),0) + coalesce(octet_length(m.origin_label),0) AS metadata_bytes ${scope} LIMIT 1`,
		params,
	);
	check(signal, { deadlineAt });
	if (!sizes[0]) return null;
	if (
		Number(sizes[0].bytes) > RECALL_DETAIL_BYTES ||
		Number(sizes[0].metadata_bytes ?? 0) > 128 * 1024
	)
		throw new DbReadError("DB_READ_BUDGET", "Recall body or metadata exceeds its source budget");
	const native =
		"'system_injection','spec_continuation','spec_blocked_continuation','knowledge_hint','container_ready','browser_session_lost','merge_summary'";
	const text = `CASE WHEN b.value->>'type'='text' AND jsonb_typeof(b.value->'text')='string' THEN b.value->>'text' WHEN b.value->>'type' IN (${native}) AND jsonb_typeof(b.value->'modelText')='string' THEN b.value->>'modelText' END`;
	const rows = await pg.unsafe(
		`WITH body AS (SELECT m.id AS "messageId",r.narrator_id AS "narratorId",n.title AS "narratorTitle",m.role,m.origin,m.origin_label AS "originLabel",m.created_at AS "createdAt",r.seq,m.body_revision AS "bodyRevision",m.content_json::jsonb AS content ${scope} AND octet_length(m.content_json::text) <= $3 AND coalesce(octet_length(n.title),0) + coalesce(octet_length(m.origin_label),0) <= 131072 LIMIT 1), projected AS (SELECT body.*, coalesce((SELECT string_agg(${text}, E'\\n' ORDER BY b.ordinal) FROM jsonb_array_elements(body.content) WITH ORDINALITY b(value,ordinal) WHERE ${text} IS NOT NULL),'') AS text, ARRAY(SELECT coalesce(b.value->>'type','unknown') FROM jsonb_array_elements(body.content) b(value) WHERE ${text} IS NULL) AS "omittedBlocks" FROM body) SELECT "messageId","narratorId","narratorTitle",role,origin,"originLabel","createdAt",seq,"bodyRevision",CASE WHEN octet_length(array_to_json("omittedBlocks")::text) <= 131072 THEN "omittedBlocks" END AS "omittedBlocks",octet_length(array_to_json("omittedBlocks")::text) > 131072 AS "omissionsOversized",substr(text,$4+1,$5) AS text,length(text) AS "totalChars" FROM projected`,
		// Source UTF-8 bytes bound its code-point count too. Clamp only the SQL offset,
		// so substr's int4 start ($4 + 1) cannot overflow for a valid safe-integer request.
		[...params, RECALL_DETAIL_BYTES, Math.min(input.offset, RECALL_DETAIL_BYTES), input.maxChars],
	);
	check(signal, { deadlineAt });
	if (!rows[0])
		throw new DbReadError("DB_READ_BUDGET", "Recall body changed beyond its source budget");
	const tools = await pg.unsafe(
		'SELECT tool_use_id AS "toolUseId",tool_name AS "toolName",status,tool_name AS summary FROM narrator_tool_calls WHERE narrator_id=$1 AND message_id=$2 ORDER BY created_at,id LIMIT 10001',
		params,
	);
	check(signal, { deadlineAt });
	if (tools.length > 10000)
		throw new DbReadError("DB_READ_BUDGET", "Recall tool count exceeds budget");
	if (rows[0].omissionsOversized)
		throw new DbReadError("DB_READ_BUDGET", "Recall omitted-block metadata exceeds result budget");
	const { omissionsOversized: _omissionsOversized, ...row } = rows[0];
	const totalChars = Number(row.totalChars),
		next = Math.min(totalChars, input.offset + input.maxChars);
	const result = {
		...row,
		seq: Number(row.seq),
		bodyRevision: Number(row.bodyRevision),
		totalChars,
		offset: input.offset,
		hasMore: next < totalChars,
		nextOffset: next < totalChars ? next : null,
		toolCalls: tools,
	} as unknown as RecallMessagePage;
	if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
		throw new DbReadError("DB_READ_BUDGET", "Recall message result exceeds budget");
	return result;
}
