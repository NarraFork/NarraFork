import { activeDatabaseBackend, postgresRuntime, sqlite } from "../../db";
import type { PgExecutor } from "../../db/pg-fts";
import { type ReadQueryOptions, readDomainTask } from "../../db/worker-read";
import { createDomainReadParams } from "../../lib/db-worker/domain-protocol";
import { DbReadError } from "../../lib/db-worker/errors";
import {
	getToolCallSummary,
	RECALL_CONVERSATION_INPUT_BYTES,
	RECALL_DETAIL_BYTES,
	type RecallConversationInput,
	type RecallConversationSnapshot,
	type RecallToolCallDetailInput,
	type RecallToolCallRow,
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
	if (activeDatabaseBackend !== "postgres")
		return readDomainTask(sqlite, "recallConversation", input, {
			...options,
			executionPolicy: "worker-required",
			signal,
		});
	const pg = executor();
	const narrator = await pg.unsafe("SELECT id, title, model FROM narrators WHERE id = $1 LIMIT 1", [
		input.narratorId,
	]);
	check(signal, options);
	const result: RecallConversationSnapshot = {
		narrator: (narrator[0] as RecallConversationSnapshot["narrator"]) ?? null,
		messageMissing: false,
		rows: [],
		tools: [],
	};
	if (!result.narrator) return result;
	const columns =
		"m.id, m.role, substr(m.content_text, 1, 500) AS content_text, m.created_at, r.seq";
	if (input.messageId) {
		const refs = await pg.unsafe(
			"SELECT seq FROM narrator_message_refs WHERE narrator_id = $1 AND message_id = $2 LIMIT 1",
			[input.narratorId, input.messageId],
		);
		check(signal, options);
		if (!refs[0]) return { ...result, messageMissing: true };
		const half = Math.floor(input.limit / 2),
			seq = Number(refs[0].seq);
		result.rows = (await pg.unsafe(
			`SELECT ${columns} FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = $1 AND r.seq >= $2 AND r.seq <= $3 ORDER BY r.seq LIMIT 51`,
			[input.narratorId, seq - half, seq + input.limit - half],
		)) as unknown as typeof result.rows;
	} else {
		result.rows = (
			(await pg.unsafe(
				`SELECT ${columns} FROM narrator_message_refs r JOIN narrator_messages m ON m.id = r.message_id WHERE r.narrator_id = $1 ORDER BY r.seq DESC LIMIT $2`,
				[input.narratorId, input.limit],
			)) as unknown as typeof result.rows
		).reverse();
	}
	check(signal, options);
	result.rows = result.rows.map((row) => ({ ...row, seq: Number(row.seq) }));
	const ids = result.rows.map((row) => row.id);
	if (!ids.length) return result;
	let time = "",
		id = "",
		bytes = 0;
	while (true) {
		const tools = await pg.unsafe(
			`SELECT id, tool_use_id, tool_name, status, message_id, created_at, octet_length(input_json::text) AS bytes FROM narrator_tool_calls WHERE message_id = ANY($1::text[]) AND narrator_id = $2 AND (created_at, id) > ($3, $4) ORDER BY created_at, id LIMIT 128`,
			[ids, input.narratorId, time, id],
		);
		check(signal, options);
		for (const tool of tools) {
			const size = Number(tool.bytes ?? 0);
			if (bytes + size > RECALL_CONVERSATION_INPUT_BYTES || result.tools.length >= 10_000)
				throw new DbReadError("DB_READ_BUDGET", "Recall conversation exceeds its source budget");
			const values = await pg.unsafe(
				"SELECT input_json FROM narrator_tool_calls WHERE id = $1 AND coalesce(octet_length(input_json::text),0) <= $2 LIMIT 1",
				[tool.id, RECALL_CONVERSATION_INPUT_BYTES - bytes],
			);
			check(signal, options);
			if (!values[0])
				throw new DbReadError("DB_READ_BUDGET", "Recall input changed beyond its source budget");
			const raw = jsonText(values[0].input_json);
			bytes += Buffer.byteLength(raw ?? "");
			let parsed: unknown = null;
			try {
				parsed = raw ? JSON.parse(raw) : null;
			} catch {
				/* Invalid JSON retains the tool-name summary. */
			}
			result.tools.push({
				tool_use_id: String(tool.tool_use_id),
				tool_name: String(tool.tool_name),
				status: String(tool.status),
				message_id: String(tool.message_id),
				summary: getToolCallSummary(String(tool.tool_name), parsed),
			});
		}
		if (tools.length < 128) break;
		time = String(tools[tools.length - 1].created_at);
		id = String(tools[tools.length - 1].id);
	}
	return result;
}
