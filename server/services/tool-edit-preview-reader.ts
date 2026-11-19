import type { Database } from "bun:sqlite";
import { type AnyColumn, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { FILE_CHANGE_LIMITS } from "../../shared/file-change-protocol";
import {
	fileChangeEffects,
	fileChangeOperations,
	fileChangeScopes,
	narratorToolCalls,
} from "../db/schema";

function boundedText(column: AnyColumn) {
	return sql<
		string | null
	>`CASE WHEN octet_length(${column}) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN ${column} ELSE NULL END`;
}
/** Only bounded evidence/location metadata, never model edit strings. */
export const toolEditPreviewColumns = {
	id: narratorToolCalls.id,
	narratorId: narratorToolCalls.narratorId,
	messageId: narratorToolCalls.messageId,
	toolUseId: narratorToolCalls.toolUseId,
	toolName: narratorToolCalls.toolName,
	executionIdentityVersion: narratorToolCalls.executionIdentityVersion,
	executionOriginToolCallId: narratorToolCalls.executionOriginToolCallId,
	executionAttempt: narratorToolCalls.executionAttempt,
	fileChangeOperationId: narratorToolCalls.fileChangeOperationId,
	executionDeviceId: boundedText(narratorToolCalls.executionDeviceId),
	executionCwd: boundedText(narratorToolCalls.executionCwd),
	executionPathFlavor: narratorToolCalls.executionPathFlavor,
	resolvedFilePath: boundedText(narratorToolCalls.resolvedFilePath),
	canonicalFilePath: boundedText(narratorToolCalls.canonicalFilePath),
	runtimeGeneration: narratorToolCalls.runtimeGeneration,
	treeHashBefore: boundedText(narratorToolCalls.treeHashBefore),
	treeHashAfter: boundedText(narratorToolCalls.treeHashAfter),
	locationJson: sql<
		string | null
	>`CASE WHEN octet_length(${narratorToolCalls.outputJson}) <= ${64 * 1024}
		THEN CASE WHEN json_valid(${narratorToolCalls.outputJson}) THEN json_extract(${narratorToolCalls.outputJson}, '$._metadata') END END`,
};
export interface ToolPreviewReadInput {
	toolCallId: string;
}
export function readToolEditEvidence(
	client: Database,
	input: ToolPreviewReadInput,
	signal?: AbortSignal,
) {
	signal?.throwIfAborted();
	const database = drizzle(client);
	const origin = (id: string) =>
		database
			.select(toolEditPreviewColumns)
			.from(narratorToolCalls)
			.where(eq(narratorToolCalls.id, id))
			.limit(1)
			.get() ?? null;
	const row = origin(input.toolCallId);
	const original = row?.executionOriginToolCallId ? origin(row.executionOriginToolCallId) : null;
	const operation = row?.fileChangeOperationId
		? (database
				.select()
				.from(fileChangeOperations)
				.where(eq(fileChangeOperations.id, row.fileChangeOperationId))
				.limit(1)
				.get() ?? null)
		: null;
	const effects = operation
		? database
				.select()
				.from(fileChangeEffects)
				.where(eq(fileChangeEffects.operationId, operation.id))
				.orderBy(asc(fileChangeEffects.fileKey), asc(fileChangeEffects.phase))
				.limit(3)
				.all()
		: [];
	const scope = effects[0]
		? (database
				.select()
				.from(fileChangeScopes)
				.where(eq(fileChangeScopes.id, effects[0].scopeId))
				.limit(1)
				.get() ?? null)
		: null;
	signal?.throwIfAborted();
	return { row, original, operation, effects, scope };
}
export type ToolPreviewReadSnapshot = ReturnType<typeof readToolEditEvidence>;
