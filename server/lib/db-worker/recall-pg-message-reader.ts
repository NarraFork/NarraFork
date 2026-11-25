import type { PgExecutor } from "../../db/pg-fts";
import type { RecallMessageInput, RecallMessagePage } from "../recall-contract";
import { DbReadError } from "./errors";
import {
	guardRecallEffectiveRefsQuery,
	recallEffectiveRefsQueries,
	unwrapRecallEffectiveRefsRows,
} from "./recall-effective-refs";
import type { RecallPgMessageSource } from "./recall-pg-projection";
import { runRecallPgProjection } from "./recall-pg-projection-client";

const SOURCE_BYTES = 40 * 1024 * 1024;
const METADATA_BYTES = 128 * 1024;
const RESULT_BYTES = 512 * 1024;

/** No JSON casts: PostgreSQL TEXT may contain valid JSON with escaped U+0000. */
export function readRecallMessagePg(
	pg: PgExecutor,
	input: RecallMessageInput,
	signal?: AbortSignal,
	deadlineAt = Date.now() + 30_000,
): Promise<RecallMessagePage | null> {
	return runRecallPgProjection<RecallMessagePage>(
		async (taskSignal, taskDeadline) => {
			const verify = () => {
				if (taskSignal.aborted) throw new DbReadError("DB_READ_ABORTED", "Recall read cancelled");
				if (Date.now() >= taskDeadline)
					throw new DbReadError("DB_READ_TASK_TIMEOUT", "Recall read deadline expired");
			};
			const lineage = recallEffectiveRefsQueries(input.narratorId, true);
			let step = lineage.next();
			while (!step.done) {
				verify();
				const rows = await pg.unsafe(step.value.sql, step.value.params);
				verify();
				step = lineage.next(rows as Record<string, unknown>[]);
			}
			const refs = step.value;
			let index = 0;
			const metadata = ["m.id", "n.id", "n.title", "m.role", "m.origin", "m.created_at"]
				.map((column) => `coalesce(octet_length(${column}),0)::bigint`)
				.join(" + ");
			const source = `WITH recall_body AS MATERIALIZED (
			SELECT m.id AS "messageId",n.id AS "narratorId",n.title AS "narratorTitle",m.role,m.origin,
			m.created_at AS "createdAt",r.seq,m.body_revision AS "bodyRevision",m.content_json AS "contentJson",
			octet_length(m.content_json)::bigint AS bytes, ${metadata} AS metadata_bytes
			FROM effective_recall_refs r JOIN narrator_messages m ON m.id=r.message_id
			JOIN narrators n ON n.id=? WHERE r.message_id=? LIMIT 1
		), admitted AS MATERIALIZED (
			SELECT * FROM recall_body WHERE bytes <= ${SOURCE_BYTES} AND metadata_bytes <= ${METADATA_BYTES}
		) SELECT admitted.*,recall_body.bytes,recall_body.metadata_bytes
		FROM recall_body LEFT JOIN admitted ON admitted."messageId"=recall_body."messageId"`;
			const guarded = guardRecallEffectiveRefsQuery(refs, source, [
				input.narratorId,
				input.messageId,
			]);
			const rows = await pg.unsafe(
				guarded.sql.replace(/\?/g, () => `$${++index}`),
				guarded.params,
			);
			verify();
			const row = unwrapRecallEffectiveRefsRows(rows)[0];
			if (!row) return null;
			if (
				!Number.isSafeInteger(Number(row.bytes)) ||
				Number(row.bytes) > SOURCE_BYTES ||
				!Number.isSafeInteger(Number(row.metadata_bytes)) ||
				Number(row.metadata_bytes) > METADATA_BYTES
			)
				throw new DbReadError(
					"DB_READ_BUDGET",
					"Recall body or metadata exceeds its source budget",
				);
			const tools = await pg.unsafe(
				`WITH tool_source AS MATERIALIZED (
			SELECT tool_use_id AS "toolUseId", tool_name AS "toolName", status, tool_name AS summary
			FROM narrator_tool_calls WHERE narrator_id=$1 AND message_id=$2 ORDER BY created_at,id LIMIT 10001
		), totals AS (
			SELECT count(*) AS count,coalesce(sum((octet_length("toolUseId")::bigint + 2*octet_length("toolName")::bigint + octet_length(status))*6+128),0) AS bytes FROM tool_source
		), admitted AS (
			SELECT tool_source.* FROM tool_source,totals WHERE totals.count<=10000 AND totals.bytes<=${RESULT_BYTES}
		) SELECT admitted.*,totals.count,totals.bytes FROM totals LEFT JOIN admitted ON true`,
				[input.narratorId, input.messageId],
			);
			verify();
			if (tools.some((tool) => Number(tool.count) > 10000 || Number(tool.bytes) > RESULT_BYTES))
				throw new DbReadError("DB_READ_BUDGET", "Recall message tool metadata exceeds budget");
			return {
				kind: "message",
				input,
				row: {
					...row,
					toolCalls: tools
						.filter((tool) => tool.toolUseId !== null)
						.map((tool) => ({
							toolUseId: tool.toolUseId,
							toolName: tool.toolName,
							status: tool.status,
							summary: tool.summary,
						})),
				} as unknown as RecallPgMessageSource,
			};
		},
		signal,
		deadlineAt,
	);
}
