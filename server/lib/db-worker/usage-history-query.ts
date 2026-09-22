import type { Database } from "bun:sqlite";
import type { UsageHistoryQueryParams } from "./protocol";

export const USAGE_QUERY_MAX_ROWS = 10_000;
export const USAGE_QUERY_MAX_BYTES = 4 * 1024 * 1024;
const MAX_SQL_BYTES = 64 * 1024;
const MAX_PARAMS = 256;

/** Runs only inside the read worker (or an isolated test DB), never imports the app DB. */
export function runUsageHistoryQuery(sqlite: Database, input: UsageHistoryQueryParams) {
	if (
		!/^\s*select\b/i.test(input.sql) ||
		input.sql.includes(";") ||
		/\braw_dump_json\b/i.test(input.sql) ||
		Buffer.byteLength(input.sql) > MAX_SQL_BYTES ||
		input.params.length > MAX_PARAMS ||
		input.params.some(
			(value) => value !== null && typeof value !== "string" && typeof value !== "number",
		) ||
		Buffer.byteLength(JSON.stringify(input.params)) > MAX_SQL_BYTES ||
		!Number.isInteger(input.maxRows) ||
		input.maxRows < 1 ||
		input.maxRows > USAGE_QUERY_MAX_ROWS ||
		input.columns.length < 1 ||
		input.columns.length > 40 ||
		input.columns.some((column) => !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(column)) ||
		new Set(input.columns).size !== input.columns.length
	)
		throw new Error("Invalid or oversized usage history read query");

	// LIMIT bounds the result before collecting it. Grouping/scanning stays in this
	// worker; the pool enforces a cancellable deadline and terminates timed-out work.
	const aliases = input.columns.map((_, index) => `c${index}`);
	const statement = sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(
		`WITH usage_rows(${aliases.join(",")}) AS (${input.sql}) SELECT * FROM usage_rows LIMIT ${input.maxRows + 1}`,
	);
	let bytes = 2;
	const rows: Record<string, string | number | null>[] = [];
	for (const value of statement.iterate(...input.params)) {
		if (rows.length >= input.maxRows)
			throw new Error("Usage history query exceeded its row budget");
		const row: Record<string, string | number | null> = {};
		input.columns.forEach((column, index) => {
			const item = value[`c${index}`];
			if (item !== null && typeof item !== "string" && typeof item !== "number")
				throw new Error("Unexpected usage history value");
			row[column] = item as string | number | null;
		});
		bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
		if (bytes > USAGE_QUERY_MAX_BYTES)
			throw new Error("Usage history query exceeded its byte budget");
		rows.push(row);
	}
	return rows;
}
