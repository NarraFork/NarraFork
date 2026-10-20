import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SelectRowsParams } from "./protocol";

/** Transport batch sizes, not limits on a query's accepted input or complete output. */
const CHUNK_ROWS = 128;
const CHUNK_BYTES = 256 * 1024;

function valueBytes(value: unknown): number {
	if (typeof value === "string") return Buffer.byteLength(value);
	if (value instanceof Uint8Array) return value.byteLength;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + valueBytes(item), 0);
	if (value && typeof value === "object")
		return Object.values(value).reduce<number>((sum, item) => sum + valueBytes(item), 0);
	return 8;
}

/** One cursor and one connection remain alive until the consumer acknowledges each batch. */
export async function streamSelectRows(
	db: Database,
	params: SelectRowsParams,
	signal: AbortSignal,
	consume: (rows: unknown[], bytes: number) => Promise<void>,
): Promise<{
	rows: number;
	bytes: number;
	workerActiveMs?: number;
	workerAckWaitMs?: number;
}> {
	const started = params.diagnosticTiming ? performance.now() : 0;
	let ackWaitMs = 0;
	if (!/^\s*(?:select|with)\b/i.test(params.sql)) {
		throw new Error("Read worker requires a server-built SELECT query");
	}
	// Explicit positional aliases preserve duplicates without relying on columnNames order:
	// older Bun versions report wide-table columnNames in a different order from values().
	const original = db.prepare(
		params.mode === "values" ? `SELECT * FROM (${params.sql.replace(/;\s*$/, "")})` : params.sql,
	);
	const names = Array.from(
		{ length: original.columnNames.length },
		(_, index) => `nf_col_${index}`,
	);
	let statement = original;
	if (params.mode === "values") {
		original.finalize();
		statement = db.prepare(
			`WITH nf_read_values(${names.join(",")}) AS (${params.sql.replace(/;\s*$/, "")}) SELECT * FROM nf_read_values`,
		);
	}
	try {
		const cursor = statement.iterate(...(params.params as SQLQueryBindings[]));
		let chunk: unknown[] = [];
		let chunkBytes = 0;
		let rows = 0;
		let bytes = 0;
		for (const record of cursor) {
			const row =
				params.mode === "values"
					? names.map((name) => (record as Record<string, unknown>)[name])
					: record;
			if (signal.aborted) throw new Error("database read task aborted");
			const size = valueBytes(row);
			chunk.push(row);
			chunkBytes += size;
			rows++;
			bytes += size;
			if (chunk.length >= CHUNK_ROWS || chunkBytes >= CHUNK_BYTES) {
				const ackStarted = params.diagnosticTiming ? performance.now() : 0;
				await consume(chunk, chunkBytes);
				if (params.diagnosticTiming) ackWaitMs += performance.now() - ackStarted;
				chunk = [];
				chunkBytes = 0;
			}
		}
		if (chunk.length) {
			const ackStarted = params.diagnosticTiming ? performance.now() : 0;
			await consume(chunk, chunkBytes);
			if (params.diagnosticTiming) ackWaitMs += performance.now() - ackStarted;
		}
		return {
			rows,
			bytes,
			...(params.diagnosticTiming
				? {
						// Preparation, cursor stepping, row conversion and byte sizing, NOT pure SQL.
						workerActiveMs: Math.max(0, performance.now() - started - ackWaitMs),
						workerAckWaitMs: ackWaitMs,
					}
				: {}),
		};
	} finally {
		statement.finalize();
	}
}
