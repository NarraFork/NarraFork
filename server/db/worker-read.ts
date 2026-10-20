import type { Database, SQLQueryBindings } from "bun:sqlite";
import { entityKind, type SQLWrapper } from "drizzle-orm";
import * as drizzleUtils from "drizzle-orm/utils";
import { type RunReadTaskOptions, runReadTask } from "../lib/db-worker/pool";
import type { DbReadTaskParams, SelectRowsParams } from "../lib/db-worker/protocol";
import {
	beginReadWorkerDiagnostic,
	diagnosticReadQuerySite,
} from "../lib/sql-execution-diagnostics";

export interface ReadQueryOptions {
	site?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	dbPath?: string;
}

// This compatibility seam is deliberately limited to Drizzle's query-construction internals.
// No prepared statement is created on the main connection, and no query object crosses IPC.
// biome-ignore lint/suspicious/noExplicitAny: Drizzle's private preparation surface has no public structural type
type Internal = any;

// Drizzle exports this runtime helper but strips its @internal declaration from the .d.ts.
const { mapResultRow } = drizzleUtils as unknown as {
	mapResultRow(fields: unknown, row: unknown[], joins: unknown): unknown;
};

function connectionPath(value: Internal, options: ReadQueryOptions): string | undefined {
	return options.dbPath ?? value?.session?.client?.filename ?? value?.$client?.filename;
}

function isPostgresAdapter(value: Internal): boolean {
	return value?.dialect?.constructor?.[entityKind] === "PgDialect";
}

function allowOriginalAdapter(value: Internal): boolean {
	if (isPostgresAdapter(value)) return true;
	if (process.env.NARRAFORK_TEST === "1" && !value?.session?.client && !value?.$client) return true;
	throw new Error("Read query has no recognized database identity");
}

function isMemoryPath(path: string): boolean {
	return path === ":memory:" || path === "" || path.startsWith("file::memory:");
}

function allowMemoryTest(path: string): boolean {
	if (!isMemoryPath(path)) return false;
	if (process.env.NARRAFORK_TEST !== "1")
		throw new Error("Read workers require a file-backed SQLite database");
	return true;
}

async function readRows(
	sql: string,
	params: SQLQueryBindings[],
	mode: SelectRowsParams["mode"],
	options: ReadQueryOptions,
	onChunk: (rows: unknown[]) => void,
): Promise<void> {
	if (!options.dbPath || isMemoryPath(options.dbPath))
		throw new Error("Native worker reads require an explicit file-backed dbPath");
	const site = diagnosticReadQuerySite(options.site);
	let consumeMs = 0;
	const complete = beginReadWorkerDiagnostic(site);
	await runReadTask(
		options.dbPath,
		{
			kind: "selectRowsV1",
			sql,
			params: params as SelectRowsParams["params"],
			mode,
			...(site ? { diagnosticTiming: true as const } : {}),
		},
		{
			signal: options.signal,
			timeoutMs: options.timeoutMs,
			onChunk: site
				? (rows: unknown[]) => {
						const started = performance.now();
						try {
							onChunk(rows);
						} finally {
							consumeMs += performance.now() - started;
						}
					}
				: onChunk,
			onComplete: site ? (stats) => complete({ ...stats, consumeMs }) : complete,
		} as RunReadTaskOptions,
	);
}

export async function readSqlRows<T = Record<string, unknown>>(
	sql: string,
	params: SQLQueryBindings[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	const rows: T[] = [];
	await readRows(sql, params, "objects", options, (chunk) => {
		for (const row of chunk) rows.push(row as T);
	});
	return rows;
}

export async function readSqlValues<T extends unknown[] = unknown[]>(
	sql: string,
	params: SQLQueryBindings[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	const rows: T[] = [];
	await readRows(sql, params, "values", options, (chunk) => {
		for (const row of chunk) rows.push(row as T);
	});
	return rows;
}

export async function readNativeRows<T = Record<string, unknown>>(
	database: Database,
	sql: string,
	params: SQLQueryBindings[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	const path = options.dbPath ?? database.filename;
	if (allowMemoryTest(path)) return database.query<T, SQLQueryBindings[]>(sql).all(...params);
	return readSqlRows<T>(sql, params, { ...options, dbPath: path });
}

export async function readNativeValues<T extends unknown[] = unknown[]>(
	database: Database,
	sql: string,
	params: SQLQueryBindings[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	const path = options.dbPath ?? database.filename;
	if (allowMemoryTest(path)) return database.query(sql).values(...params) as T[];
	return readSqlValues<T>(sql, params, { ...options, dbPath: path });
}

/** Explicit asynchronous read boundary; never use inside a write transaction. */
export async function readQuery<T>(
	query: PromiseLike<T>,
	options: ReadQueryOptions = {},
): Promise<T> {
	const source = query as Internal;
	if (isPostgresAdapter(source)) return await query;
	const path = connectionPath(source, options);
	// PostgreSQL keeps its original async driver. Tests may inject a promise-only adapter.
	if (path === undefined) {
		allowOriginalAdapter(source);
		return await query;
	}
	if (allowMemoryTest(path)) return await query;
	if (typeof source._prepare !== "function")
		throw new Error("Unsupported SQLite read query preparation");
	let captured: Internal;
	const capture = (
		sql: Internal,
		fields: Internal,
		method: string,
		_arrayMode: boolean,
		mapper: Internal,
	) => {
		captured = { sql, fields, method, mapper };
		return captured;
	};
	const copy = Object.create(source);
	copy.session = { prepareQuery: capture, prepareOneTimeQuery: capture };
	copy._prepare();
	if (!captured || !/^\s*(?:select|with)\b/i.test(captured.sql.sql))
		throw new Error("readQuery accepts SELECT queries only");
	const results: unknown[] = [];
	await readRows(
		captured.sql.sql,
		captured.sql.params,
		"values",
		{ ...options, dbPath: path },
		(rows) => {
			if (captured.mapper) {
				const mapped = captured.mapper(rows);
				if (captured.method === "get") {
					if (mapped !== undefined) results.push(mapped);
				} else for (const row of mapped) results.push(row);
			} else {
				for (const row of rows)
					results.push(
						mapResultRow(captured.fields, row as unknown[], captured.joinsNotNullableMap),
					);
			}
		},
	);
	return (captured.method === "get" ? results[0] : results) as T;
}

export async function readQueryFirst<T>(
	query: PromiseLike<T[]>,
	options?: ReadQueryOptions,
): Promise<T | undefined> {
	return (await readQuery(query, options))[0];
}

/** SQLWrapper equivalent of db.all(); callers retain their existing PG implementation. */
export async function readDbAll<T = unknown>(
	database: unknown,
	query: SQLWrapper,
	options: ReadQueryOptions = {},
): Promise<T[]> {
	const source = database as Internal;
	if (isPostgresAdapter(source)) return await source.all(query);
	const path = connectionPath(source, options);
	if (path === undefined) {
		allowOriginalAdapter(source);
		return await source.all(query);
	}
	if (allowMemoryTest(path)) return await source.all(query);
	const built = source.dialect.sqlToQuery(query.getSQL());
	return readSqlRows<T>(built.sql, built.params, { ...options, dbPath: path });
}

/** Versioned, statically registered worker tasks preserve whole read-transaction snapshots. */
export interface ReadTransactionTaskOptions extends ReadQueryOptions {
	onChunk?: RunReadTaskOptions["onChunk"];
}

export async function readTransactionTask<T>(
	database: unknown,
	task: DbReadTaskParams,
	testFallback: () => T | Promise<T>,
	options: ReadTransactionTaskOptions = {},
): Promise<T> {
	if (isPostgresAdapter(database))
		throw new Error("SQLite domain read tasks require a SQLite connection");
	const path = connectionPath(database, options);
	if (path === undefined) {
		allowOriginalAdapter(database);
		return await testFallback();
	}
	if (allowMemoryTest(path)) return await testFallback();
	return runReadTask<T>(path, task, { ...options, onComplete: beginReadWorkerDiagnostic() });
}
