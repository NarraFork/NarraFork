/**
 * Run a Drizzle SQLite SELECT on the read-worker pool instead of the main thread.
 *
 * Only the compiled SQL and its parameters cross to the worker; rows come back positionally and are
 * mapped here with Drizzle's own `mapResultRow`, so JSON/timestamp/boolean columns and joined
 * (nested) selections decode exactly as `await query` would. Nothing is prepared on the main
 * connection.
 *
 * Runs inline (plain `await query`) when the worker cannot give the same answer or is not worth it:
 * - not a SQLite select builder (set operators, relational `db.query.*`, PostgreSQL builders);
 * - an in-memory database, which a worker cannot open;
 * - inside a transaction: the worker only sees committed data, so it would miss this
 *   transaction's own writes.
 *
 * These are pre-dispatch compatibility paths, not error recovery. Once a read is dispatched to
 * the worker pool, every failure propagates; it is never re-run on the main connection.
 *
 * Use it for reads that are actually slow; a point lookup costs more as a worker round trip than
 * it does inline. The worker caches its readonly handle per file, so do not point it at database
 * files that get deleted or replaced (project databases).
 */

import type { Database } from "bun:sqlite";
import * as drizzle from "drizzle-orm";
import { SQLiteSelectBase } from "drizzle-orm/sqlite-core";
import { runReadTask, WorkersUnavailableError } from "../lib/db-worker/pool";
import {
	SELECT_ROWS_MAX_ROWS,
	type SelectRowsParams,
	type SelectRowsResult,
} from "../lib/db-worker/protocol";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ReadQueryOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Row budget; exceeding it fails the read instead of truncating. */
	maxRows?: number;
}

/** Drizzle internals; an unrecognized connection shape must fail, never select inline execution. */
interface SelectInternals {
	config: { fields: Record<string, unknown> };
	joinsNotNullableMap: Record<string, boolean>;
	session?: { client?: Database };
}

/** Runtime exports of drizzle-orm that its published typings mark internal. */
const { mapResultRow, orderSelectedFields } = drizzle as unknown as {
	orderSelectedFields(fields: Record<string, unknown>): unknown[];
	mapResultRow(fields: unknown[], row: unknown[], joins: Record<string, boolean>): unknown;
};

export async function readQuery<T>(
	query: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
	options: ReadQueryOptions = {},
): Promise<T[]> {
	if (!drizzle.is(query, SQLiteSelectBase)) return await query;
	const internals = query as unknown as SelectInternals;
	const client = internals.session?.client;
	if (!client || typeof client.filename !== "string")
		throw new WorkersUnavailableError("unsupported_sqlite_connection");
	if (client.filename === ":memory:" || client.filename === "" || client.inTransaction)
		return await query;

	const compiled = query.toSQL();
	const result = await runReadTask<SelectRowsResult>(
		client.filename,
		{
			kind: "selectRows",
			sql: compiled.sql,
			params: compiled.params as SelectRowsParams["params"],
			maxRows: options.maxRows ?? SELECT_ROWS_MAX_ROWS,
		},
		{ signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
	);

	const fields = orderSelectedFields(internals.config.fields);
	return result.rows.map((row) => mapResultRow(fields, row, internals.joinsNotNullableMap) as T);
}
