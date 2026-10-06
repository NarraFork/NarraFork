import type { Database } from "bun:sqlite";
import {
	SEARCH_QUERY_MAX_BYTES,
	SEARCH_QUERY_MAX_PARAMS,
	SEARCH_QUERY_MAX_PARAMS_BYTES,
	SEARCH_QUERY_MAX_ROWS,
	SEARCH_QUERY_MAX_SQL_BYTES,
	type SearchQueryParams,
} from "./protocol";

export function validateSearchQuery(input: SearchQueryParams): void {
	if (
		typeof input.sql !== "string" ||
		Buffer.byteLength(input.sql) > SEARCH_QUERY_MAX_SQL_BYTES ||
		!/^\s*(?:select|with)\b/i.test(input.sql) ||
		input.sql.includes(";") ||
		!Array.isArray(input.params) ||
		input.params.length > SEARCH_QUERY_MAX_PARAMS ||
		!Number.isInteger(input.maxRows) ||
		input.maxRows < 1 ||
		input.maxRows > SEARCH_QUERY_MAX_ROWS
	)
		throw new Error("Invalid or oversized search read query");

	// Stop before serializing an entire oversized parameter array on the HTTP thread.
	// for..of also observes holes as undefined, rather than skipping malformed sparse arrays.
	let bytes = 2;
	let separatorBytes = 0;
	for (const value of input.params) {
		if (
			value !== null &&
			((typeof value !== "string" && typeof value !== "number") ||
				(typeof value === "number" && !Number.isFinite(value)) ||
				(typeof value === "string" && Buffer.byteLength(value) > SEARCH_QUERY_MAX_PARAMS_BYTES))
		)
			throw new Error("Invalid or oversized search read query");
		bytes += Buffer.byteLength(JSON.stringify(value)) + separatorBytes;
		separatorBytes = 1;
		if (bytes > SEARCH_QUERY_MAX_PARAMS_BYTES)
			throw new Error("Invalid or oversized search read query");
	}
}

/** Worker-only bounded SELECT executor, with no application DB/bootstrap dependencies. */
export function runSearchQuery(
	sqlite: Database,
	input: SearchQueryParams,
): Record<string, unknown>[] {
	validateSearchQuery(input);

	// A subquery accepts only SELECT/WITH SELECT, including when the WITH prefix disguises a write.
	// Keep snippet() in the original FTS SELECT context: do not move it to the outer projection.
	// LIMIT bounds iteration even if the internal query accidentally omits its own result limit.
	const statement = sqlite.prepare<Record<string, unknown>, Array<string | number | null>>(
		`SELECT * FROM (${input.sql}) LIMIT ${input.maxRows + 1}`,
	);
	const rows: Record<string, unknown>[] = [];
	let bytes = 2; // JSON array brackets, plus commas added below.
	try {
		for (const row of statement.iterate(...input.params)) {
			if (rows.length >= input.maxRows) throw new Error("Search query exceeded its row budget");
			for (const value of Object.values(row)) {
				if (
					value !== null &&
					((typeof value !== "string" && typeof value !== "number") ||
						(typeof value === "number" && !Number.isFinite(value)))
				)
					throw new Error("Unexpected search query value");
				if (typeof value === "string" && Buffer.byteLength(value) > SEARCH_QUERY_MAX_BYTES - bytes)
					throw new Error("Search query exceeded its byte budget");
			}
			bytes += Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
			if (bytes > SEARCH_QUERY_MAX_BYTES) throw new Error("Search query exceeded its byte budget");
			rows.push(row);
		}
		return rows;
	} finally {
		statement.finalize();
	}
}
