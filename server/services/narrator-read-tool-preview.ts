import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { type AnyColumn, sql } from "drizzle-orm";
import { narratorToolCalls } from "../db/schema";

function boundedText(column: AnyColumn) {
	return sql<
		string | null
	>`CASE WHEN octet_length(${column}) <= ${FILE_CHANGE_LIMITS.metadataBytes} THEN ${column} ELSE NULL END`;
}

// Model edit strings are not historical evidence; bound JSON before extracting location.
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
	locationJson: sql<string | null>`CASE
		WHEN octet_length(${narratorToolCalls.outputJson}) <= ${64 * 1024}
		THEN CASE WHEN json_valid(${narratorToolCalls.outputJson})
			THEN json_extract(${narratorToolCalls.outputJson}, '$._metadata') END
		END`,
};
