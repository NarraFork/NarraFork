import { getTableColumns } from "drizzle-orm";
import { sqlite } from "../db";
import { narratorToolCalls } from "../db/schema";
import { readDomainTaskText } from "../db/worker-read";
import { WorkersUnavailableError } from "../lib/db-worker/pool";
import { isCurrentToolDetail } from "../lib/db-worker/tool-detail-query";
import type { ToolDetailReference } from "../lib/db-worker/tool-detail-selection";
import { AppError, NotFoundError, ValidationError } from "../lib/errors";

export function validateToolDetailReference(reference?: ToolDetailReference): void {
	for (const value of [reference?.toolCallId, reference?.messageId]) {
		if (
			value !== undefined &&
			(typeof value !== "string" || value.length === 0 || value.length > 128)
		) {
			throw new ValidationError(
				"Tool detail references must be non-empty IDs of at most 128 characters",
			);
		}
	}
}

export function toolDetailSelectionRequired(): AppError {
	return new AppError(
		"Tool detail selection is ambiguous or exceeds the metadata budget; specify toolCallId or messageId.",
		409,
		"TOOL_CALL_DETAIL_SELECTION_REQUIRED",
	);
}

const columns = Object.entries(getTableColumns(narratorToolCalls)).map(([key, column]) => ({
	key,
	name: column.name,
	type: column.dataType,
	virtual: Boolean(column.generated),
}));

export async function readCommittedToolDetail(
	narratorId: string,
	toolUseId: string,
	reference: ToolDetailReference,
	signal: AbortSignal,
	authorizeCurrent: () => Promise<unknown>,
) {
	validateToolDetailReference(reference);
	signal.throwIfAborted();
	if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction) {
		throw new WorkersUnavailableError("requires_committed_file");
	}
	const { metadata: result, text } = await readDomainTaskText(
		sqlite,
		"toolDetailSnapshot",
		{ narratorId, toolUseId, reference, columns },
		{ diagnosticSource: "narrator.tool-detail", timeoutMs: 15_000, signal },
	);
	signal.throwIfAborted();
	await authorizeCurrent();
	signal.throwIfAborted();
	switch (result.kind) {
		case "notFound":
			throw new NotFoundError("ToolCall", toolUseId);
		case "ambiguous":
			throw toolDetailSelectionRequired();
		case "tooLarge":
			throw new AppError(
				"Tool detail exceeds the payload byte limit",
				413,
				"TOOL_CALL_DETAIL_TOO_LARGE",
			);
		case "found":
			if (!isCurrentToolDetail(sqlite, narratorId, toolUseId, result.identity)) {
				throw new NotFoundError("ToolCall", toolUseId);
			}
			return text();
	}
}
