import type { Database } from "bun:sqlite";
import { and, eq, getTableColumns, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { narratorMessages, narratorToolCalls, narratorToolContinuations } from "../db/schema";
import { blocksCurrentSql, bodyLengthSql, bodySql, hasBlockStorage } from "../lib/narrator-bodies";

export interface ContinuationRecoveryPageInput {
	epochs: string[];
	rows: { id: string; bytes: number; inputBytes: number; contentBytes: number }[];
}
const payloadBytes = sql<number>`coalesce(length(cast(${narratorToolContinuations.payloadJson} as blob)), 0)`;
const toolInputBytes = sql<number>`coalesce(length(cast(${narratorToolCalls.inputJson} as blob)), 0)`;
/** Recovery ordering uses persisted block ordinals; only legacy envelopes need their body. */
export function readContinuationRecoveryPageTask(
	sqlite: Database,
	input: ContinuationRecoveryPageInput,
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	if (!input.rows.length || !input.epochs.length) return [];
	const database = drizzle(sqlite);
	const blocks = hasBlockStorage(sqlite);
	const messageContentBytes = sql.raw(`coalesce(${bodyLengthSql("narrator_messages", blocks)},0)`);
	const rows = database
		.select({
			record: getTableColumns(narratorToolContinuations),
			messageId: narratorToolCalls.messageId,
			messageCreatedAt: narratorMessages.createdAt,
			toolCallCreatedAt: narratorToolCalls.createdAt,
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			body: sql<string | null>`${sql.raw(bodySql("narrator_messages", blocks))}`,
			blockOrder: blocks
				? sql<number | null>`(CASE WHEN ${sql.raw(blocksCurrentSql("narrator_messages"))} THEN (
				SELECT b.ordinal FROM narrator_blocks b WHERE b.message_id = ${narratorMessages.id}
				AND b.kind = 'tool' AND b.wire_id = ${narratorToolCalls.toolUseId}
				ORDER BY b.ordinal LIMIT 1) END)`
				: sql<number | null>`NULL`,
		})
		.from(narratorToolContinuations)
		.innerJoin(narratorToolCalls, eq(narratorToolContinuations.toolCallId, narratorToolCalls.id))
		.innerJoin(narratorMessages, eq(narratorToolCalls.messageId, narratorMessages.id))
		.where(
			and(
				inArray(narratorToolContinuations.updateEpoch, input.epochs),
				or(
					...input.rows.map((row) =>
						and(
							eq(narratorToolContinuations.id, row.id),
							lte(payloadBytes, row.bytes),
							lte(toolInputBytes, row.inputBytes),
							lte(messageContentBytes, row.contentBytes),
						),
					),
				),
			),
		)
		.limit(input.rows.length)
		.all();
	signal.throwIfAborted();
	return rows.map(({ body, ...row }) => ({
		...row,
		contentJson: body === null ? null : (JSON.parse(body) as unknown),
	}));
}
