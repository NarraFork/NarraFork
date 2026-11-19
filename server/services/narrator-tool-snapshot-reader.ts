import type { Database } from "bun:sqlite";
import { getTableColumns } from "drizzle-orm";
import { narratorToolCalls } from "../db/schema";
import { DbReadError } from "../lib/db-worker/errors";
import type { NarratorRawRow } from "./narrator-message-snapshot-reader";

export interface NarratorToolRowsParams {
	toolCallIds: string[];
}
const sourceLimit = 128 * 1024 * 1024;
const bytesExpression = Object.values(getTableColumns(narratorToolCalls))
	.filter((column) => !column.generated)
	.map((column) => `coalesce(octet_length("${column.name}"),0)`)
	.join(" + ");

export function readNarratorToolRowsSnapshot(
	database: Database,
	input: NarratorToolRowsParams,
	signal?: AbortSignal,
): NarratorRawRow[] {
	if (!validateNarratorToolRows(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid tool snapshot request");
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Tool snapshot cancelled");
	const ids = [...new Set(input.toolCallIds)];
	if (!ids.length) return [];
	const slots = ids.map(() => "?").join(",");
	const sizeStatement = database.prepare(
		`SELECT coalesce(sum(${bytesExpression}),0) AS bytes FROM narrator_tool_calls WHERE id IN (${slots})`,
	);
	try {
		const size = sizeStatement.get(...ids) as { bytes: number };
		if (size.bytes > sourceLimit)
			throw new DbReadError("DB_READ_BUDGET", "Tool snapshot exceeds its source byte budget");
	} finally {
		sizeStatement.finalize();
	}
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Tool snapshot cancelled");
	const statement = database.prepare(
		`SELECT * FROM narrator_tool_calls WHERE id IN (${slots}) ORDER BY created_at, id`,
	);
	try {
		return statement.all(...ids) as NarratorRawRow[];
	} finally {
		statement.finalize();
	}
}

export function validateNarratorToolRows(input: unknown): input is NarratorToolRowsParams {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const row = input as Record<string, unknown>;
	return (
		Object.keys(row).length === 1 &&
		Array.isArray(row.toolCallIds) &&
		row.toolCallIds.length <= 128 &&
		row.toolCallIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
	);
}
