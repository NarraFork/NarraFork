import type { Database, SQLQueryBindings } from "bun:sqlite";
import { DbReadError, readAborted } from "./errors";
import {
	type EncodedReadBind,
	type ReadBind,
	SELECT_CHUNK_MAX_BYTES,
	SELECT_CHUNK_MAX_ROWS,
	SELECT_ROWS_MAX_BYTES,
	SELECT_ROWS_MAX_PARAMS,
	SELECT_ROWS_MAX_PARAMS_BYTES,
	SELECT_ROWS_MAX_ROWS,
	type SelectChunk,
	type SelectChunksResult,
	type SelectRowsResult,
	type SelectValuesParams,
} from "./protocol";
import { jsonStringBytes, type ReadBudgetMeter, readRowBytes } from "./read-budget";
import { validateSelectRows } from "./select-rows";

const invalid = () => new DbReadError("DB_READ_INVALID", "Invalid read query");
function bindBytes(value: ReadBind): number {
	if (value instanceof Uint8Array) return value.byteLength + 32;
	if (typeof value === "bigint") {
		if (value < -(1n << 63n) || value >= 1n << 63n) throw invalid();
		return 64;
	}
	if (typeof value === "boolean") return 2;
	if (value === null) return 5;
	if (typeof value === "number" && Number.isFinite(value)) return String(value).length + 1;
	if (typeof value === "string") return jsonStringBytes(value) + 1;
	throw invalid();
}
function observeBinds(values: readonly ReadBind[], meter?: ReadBudgetMeter): void {
	if (!Array.isArray(values)) throw invalid();
	let bytes = 2;
	for (const value of values) bytes += bindBytes(value);
	meter?.observe("parameterCount", values.length, SELECT_ROWS_MAX_PARAMS, "input");
	meter?.observe("parameterBytes", bytes, SELECT_ROWS_MAX_PARAMS_BYTES, "input");
}
export function encodeReadBinds(
	values: readonly ReadBind[],
	meter?: ReadBudgetMeter,
): EncodedReadBind[] {
	observeBinds(values, meter);
	return values.map((value) => {
		if (value instanceof Uint8Array) return { type: "blob", value: new Uint8Array(value) };
		if (typeof value === "bigint") return { type: "bigint", value: String(value) };
		if (typeof value === "boolean") return value ? 1 : 0;
		return value;
	});
}
export function decodeReadBinds(input: SelectValuesParams, meter?: ReadBudgetMeter): ReadBind[] {
	validateSelectRows({ ...input, kind: "selectRows", params: [] }, meter);
	if (!Array.isArray(input.params)) throw invalid();
	for (let index = 0; index < input.params.length; index++)
		if (!(index in input.params)) throw invalid();
	const values = input.params.map((value): ReadBind => {
		if (value && typeof value === "object") {
			if (value.type === "blob" && value.value instanceof Uint8Array)
				return new Uint8Array(value.value);
			if (
				value.type === "bigint" &&
				typeof value.value === "string" &&
				/^-?[0-9]{1,20}$/.test(value.value)
			)
				return BigInt(value.value);
			throw invalid();
		}
		return value;
	});
	observeBinds(values, meter);
	return values;
}
function prepare(sqlite: Database, input: SelectValuesParams, meter?: ReadBudgetMeter) {
	const binds = decodeReadBinds(input, meter);
	const inner = sqlite.prepare(input.sql);
	let columns: string[];
	try {
		columns = inner.columnNames;
	} finally {
		inner.finalize();
	}
	const aliases = columns.map((_, i) => `c${i}`);
	const statement = sqlite.prepare<Record<string, unknown>, SQLQueryBindings[]>(
		`WITH nf_rows(${aliases.join(",")}) AS (${input.sql}) SELECT * FROM nf_rows`,
	);
	return { statement, aliases, columns, binds };
}
export function runSelectValues(
	sqlite: Database,
	input: SelectValuesParams,
	meter?: ReadBudgetMeter,
): SelectRowsResult {
	const { statement, aliases, columns, binds } = prepare(sqlite, input, meter);
	const rows: unknown[][] = [];
	let bytes = 0;
	try {
		for (const record of statement.iterate(...binds)) {
			const row = aliases.map((alias) => record[alias]);
			bytes += readRowBytes(row);
			rows.push(row);
			meter?.observe("rows", rows.length, Math.min(input.maxRows, SELECT_ROWS_MAX_ROWS), "result");
			meter?.observe("resultBytes", bytes, SELECT_ROWS_MAX_BYTES, "result");
		}
		return { columns, rows };
	} finally {
		statement.finalize();
	}
}
export async function runSelectChunks(
	sqlite: Database,
	input: SelectValuesParams,
	signal: AbortSignal,
	deadlineAt: number,
	emit: (chunk: SelectChunk) => Promise<void>,
	meter?: ReadBudgetMeter,
): Promise<SelectChunksResult> {
	const { statement, aliases, columns, binds } = prepare(sqlite, input, meter);
	const headerBytes = columns.reduce((sum, column) => sum + Buffer.byteLength(column) + 8, 32);
	let rows: unknown[][] = [];
	let chunkBytes = headerBytes;
	let bytes = 0;
	let rowCount = 0;
	let sequence = 0;
	const observe = () => {
		meter?.observe("rows", rowCount, Math.min(input.maxRows, SELECT_ROWS_MAX_ROWS), "result");
		meter?.observe("resultBytes", bytes, SELECT_ROWS_MAX_BYTES, "result");
	};
	const check = () => {
		if (signal.aborted) throw readAborted();
		if (Date.now() >= deadlineAt)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "database read task timed out");
	};
	const flush = async () => {
		check();
		bytes += headerBytes;
		observe();
		await emit({ columns, rows, sequence: sequence++ });
		check();
		rows = [];
		chunkBytes = headerBytes;
	};
	try {
		for (const record of statement.iterate(...binds)) {
			check();
			const row = aliases.map((alias) => record[alias]);
			const size = readRowBytes(row);
			if (
				rows.length &&
				(rows.length >= SELECT_CHUNK_MAX_ROWS || chunkBytes + size > SELECT_CHUNK_MAX_BYTES)
			)
				await flush();
			rowCount++;
			bytes += size;
			rows.push(row);
			chunkBytes += size;
			observe();
			// An oversized row owns its chunk, with the same consumer ACK barrier.
			if (chunkBytes > SELECT_CHUNK_MAX_BYTES) await flush();
		}
		if (rows.length) await flush();
		return { rowCount, bytes };
	} finally {
		statement.finalize();
	}
}
