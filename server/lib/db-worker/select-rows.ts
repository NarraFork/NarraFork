import type { Database, SQLQueryBindings } from "bun:sqlite";
import { DbReadError } from "./errors";
import {
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
	type SelectRowsParams,
	type SelectRowsResult,
} from "./protocol";
import { jsonStringBytes, type ReadBudgetMeter, readRowBytes } from "./read-budget";

export function validateSelectRows(input: SelectRowsParams, meter?: ReadBudgetMeter): void {
	if (
		typeof input.sql !== "string" ||
		!/^\s*(?:select|with)\b/i.test(input.sql) ||
		input.sql.includes(";") ||
		!Array.isArray(input.params) ||
		!Number.isInteger(input.maxRows) ||
		input.maxRows < 1
	)
		throw new DbReadError("DB_READ_INVALID", "Invalid read query");

	meter?.observe("sqlBytes", Buffer.byteLength(input.sql), SELECT_ROWS_MAX_SQL_BYTES, "input");
	meter?.observe("parameterCount", input.params.length, SELECT_ROWS_MAX_PARAMS, "input");
	// for..of observes holes as undefined, rejecting malformed sparse arrays.
	let bytes = 2;
	let separatorBytes = 0;
	for (const value of input.params) {
		if (
			value !== null &&
			((typeof value !== "string" && typeof value !== "number") ||
				(typeof value === "number" && !Number.isFinite(value)))
		)
			throw new DbReadError("DB_READ_INVALID", "Invalid read query");
		bytes +=
			(typeof value === "string" ? jsonStringBytes(value) : String(value).length) + separatorBytes;
		separatorBytes = 1;
	}
	meter?.observe("parameterBytes", bytes, SELECT_ROWS_MAX_PARAMS_BYTES, "input");
}

/**
 * Worker-only readonly SELECT executor, with no application DB/bootstrap dependencies.
 * Positional aliases preserve duplicate columns, and the CTE rejects WITH-disguised writes.
 * The historical function name remains compatible; numeric budgets are observations only.
 */
export function withBoundedSelectRows<T>(
	sqlite: Database,
	input: SelectRowsParams,
	consume: (columns: string[], rows: Iterable<unknown[]>) => T,
	bindings: readonly SQLQueryBindings[] = input.params,
	meter?: ReadBudgetMeter,
): T {
	validateSelectRows(input, meter);
	const inner = sqlite.prepare(input.sql);
	let columns: string[];
	try {
		columns = inner.columnNames;
	} finally {
		inner.finalize();
	}
	const aliases = columns.map((_, index) => `c${index}`);
	const statement = sqlite.prepare<Record<string, unknown>, SQLQueryBindings[]>(
		`WITH nf_rows(${aliases.join(",")}) AS (${input.sql}) SELECT * FROM nf_rows`,
	);
	function* observed(): Generator<unknown[]> {
		let count = 0,
			bytes = 0;
		for (const record of statement.iterate(...bindings)) {
			const row = aliases.map((alias) => record[alias]);
			bytes += readRowBytes(row);
			count++;
			meter?.observe("rows", count, Math.min(input.maxRows, SELECT_ROWS_MAX_ROWS), "result");
			meter?.observe("resultBytes", bytes, SELECT_ROWS_MAX_BYTES, "result");
			yield row;
		}
	}
	try {
		const result = consume(columns, observed());
		if (result && typeof result === "object" && "then" in result)
			throw new DbReadError("DB_READ_INVALID", "Bounded SELECT consumers must be synchronous");
		return result;
	} finally {
		statement.finalize();
	}
}
export function runSelectRows(
	sqlite: Database,
	input: SelectRowsParams,
	meter?: ReadBudgetMeter,
): SelectRowsResult {
	return withBoundedSelectRows(
		sqlite,
		input,
		(columns, rows) => ({ columns, rows: [...rows] }),
		input.params,
		meter,
	);
}
