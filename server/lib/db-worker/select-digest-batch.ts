import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { DbReadError, readAborted } from "./errors";
import {
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	SELECT_ROWS_MAX_SQL_BYTES,
	type SelectDigestBatchParams,
	type SelectDigestBatchResult,
} from "./protocol";
import { ReadBudgetMeter } from "./read-budget";
import { decodeReadBinds } from "./select-extended";
import { withBoundedSelectRows } from "./select-rows";

/** Exact row-order/property-order JSON plus newline SHA256 commitment. */
export function sourceRowsCommitment(rows: Iterable<unknown>, accept?: (encoded: string) => void) {
	const hash = createHash("sha256");
	let count = 0;
	let bytes = 0;
	for (const row of rows) {
		const encoded = JSON.stringify(row);
		if (encoded === undefined)
			throw new DbReadError("DB_READ_INVALID", "Invalid SELECT commitment row");
		accept?.(encoded);
		bytes += Buffer.byteLength(encoded) + 1;
		count++;
		hash.update(encoded).update("\n");
	}
	return { digest: hash.digest("hex"), rows: count, bytes };
}

/** Observation threshold; callers may retain their existing 16-entry scheduling window. */
export const SELECT_DIGEST_BATCH_MAX_ENTRIES = 16;
const invalid = () => new DbReadError("DB_READ_INVALID", "Invalid SELECT digest batch");
function shape(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		keys.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => keys.includes(key))
	);
}
export function validateSelectDigestBatch(
	input: unknown,
	meter?: ReadBudgetMeter,
): asserts input is SelectDigestBatchParams {
	if (
		!shape(input, ["kind", "entries"]) ||
		input.kind !== "selectDigestBatch" ||
		!Array.isArray(input.entries)
	)
		throw invalid();
	meter?.observe("digestEntries", input.entries.length, SELECT_DIGEST_BATCH_MAX_ENTRIES, "input");
	let sqlBytes = 0,
		paramCount = 0,
		paramBytes = 0,
		expectedRows = 0,
		expectedBytes = 0,
		previous = -1;
	for (const entry of input.entries) {
		if (
			!shape(entry, ["ordinal", "query", "params", "digest", "rows", "bytes"]) ||
			!Number.isSafeInteger(entry.ordinal) ||
			(entry.ordinal as number) <= previous ||
			typeof entry.query !== "string" ||
			typeof entry.digest !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.digest) ||
			!Number.isSafeInteger(entry.rows) ||
			(entry.rows as number) < 0 ||
			!Number.isSafeInteger(entry.bytes) ||
			(entry.bytes as number) < 0 ||
			!Array.isArray(entry.params)
		)
			throw invalid();
		const entryMeter = new ReadBudgetMeter();
		decodeReadBinds(
			{
				kind: "selectValues",
				sql: entry.query,
				params: entry.params,
				maxRows: SELECT_ROWS_MAX_ROWS,
			},
			entryMeter,
		);
		previous = entry.ordinal as number;
		sqlBytes += Buffer.byteLength(entry.query);
		paramCount += entry.params.length;
		paramBytes += entryMeter.snapshot().find((item) => item.kind === "parameterBytes")?.actual ?? 0;
		expectedRows += entry.rows as number;
		expectedBytes += entry.bytes as number;
		meter?.observe("sqlBytes", sqlBytes, SELECT_ROWS_MAX_SQL_BYTES, "input");
		meter?.observe("parameterCount", paramCount, SELECT_ROWS_MAX_PARAMS, "input");
		meter?.observe("parameterBytes", paramBytes, SELECT_ROWS_MAX_PARAMS_BYTES, "input");
		meter?.observe("digestExpectedRows", expectedRows, SELECT_ROWS_MAX_ROWS, "input");
		meter?.observe("digestExpectedBytes", expectedBytes, SELECT_ROWS_MAX_BYTES, "input");
	}
}
export function validateSelectDigestBatchResult(
	result: unknown,
	input: SelectDigestBatchParams,
): asserts result is SelectDigestBatchResult {
	if (
		!shape(result, ["matches", "entries"]) ||
		typeof result.matches !== "boolean" ||
		!Array.isArray(result.entries) ||
		result.entries.length !== input.entries.length
	)
		throw new DbReadError("DB_READ_PROTOCOL", "Invalid SELECT digest batch result");
	let matches = true;
	for (let index = 0; index < result.entries.length; index++) {
		const entry = result.entries[index];
		if (
			!shape(entry, ["ordinal", "matches"]) ||
			entry.ordinal !== input.entries[index].ordinal ||
			typeof entry.matches !== "boolean"
		)
			throw new DbReadError("DB_READ_PROTOCOL", "Invalid SELECT digest batch ordinal");
		matches = matches && entry.matches;
	}
	if (matches !== result.matches)
		throw new DbReadError("DB_READ_PROTOCOL", "Invalid SELECT digest batch completion");
}
/** Synchronous snapshot; the original frozen commitments are never rewritten. */
export function runSelectDigestBatch(
	sqlite: Database,
	input: SelectDigestBatchParams,
	signal: AbortSignal,
	deadlineAt: number,
	meter?: ReadBudgetMeter,
): SelectDigestBatchResult {
	validateSelectDigestBatch(input, meter);
	const check = () => {
		if (signal.aborted) throw readAborted();
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "SELECT digest batch deadline expired");
	};
	check();
	const result = sqlite.transaction(() => {
		let rows = 0,
			bytes = 0;
		const entries: SelectDigestBatchResult["entries"] = [];
		for (const entry of input.entries) {
			check();
			const binds = decodeReadBinds({
				kind: "selectValues",
				sql: entry.query,
				params: entry.params,
				maxRows: SELECT_ROWS_MAX_ROWS,
			});
			const commitment = withBoundedSelectRows(
				sqlite,
				{ kind: "selectRows", sql: entry.query, params: [], maxRows: SELECT_ROWS_MAX_ROWS },
				(columns, values) => {
					function* records() {
						for (const value of values)
							yield Object.fromEntries(columns.map((column, index) => [column, value[index]]));
					}
					return sourceRowsCommitment(records(), (encoded) => {
						check();
						const nextBytes = Buffer.byteLength(encoded) + 1;
						rows++;
						bytes += nextBytes;
						meter?.observe("rows", rows, SELECT_ROWS_MAX_ROWS, "result");
						meter?.observe("resultBytes", bytes, SELECT_ROWS_MAX_BYTES, "result");
					});
				},
				binds,
			);
			entries.push({
				ordinal: entry.ordinal,
				matches:
					commitment.digest === entry.digest &&
					commitment.rows === entry.rows &&
					commitment.bytes === entry.bytes,
			});
		}
		check();
		return { matches: entries.every((entry) => entry.matches), entries };
	})();
	validateSelectDigestBatchResult(result, input);
	return result;
}
