/**
 * Worker-backed runtime reads with Drizzle's column and relational result mapping.
 * PostgreSQL keeps its async driver. SQLite memory/transaction compatibility is decided before
 * dispatch so reads retain transaction visibility; worker-required reads reject those sources.
 * Once dispatched, failures propagate and never re-execute the query on the main connection.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { is, type SQLWrapper } from "drizzle-orm";
import { SQLiteSelectBase } from "drizzle-orm/sqlite-core";
import { SQLiteRelationalQuery } from "drizzle-orm/sqlite-core/query-builders/query";
import { bindReadDatabase } from "../lib/db-worker/database-identity";
import {
	createDomainReadParams,
	DOMAIN_READ_STREAM_CHUNK_BYTES,
	DOMAIN_READ_STREAM_TIMEOUT_MS,
	DOMAIN_STREAM_BYTE_LIMITS,
	type DomainReadStreamResult,
	type DomainReadTaskMap,
	type StreamDomainReadTaskKind,
	type SyncDomainReadTaskKind,
} from "../lib/db-worker/domain-protocol";
import { DbReadError, readAborted } from "../lib/db-worker/errors";
import {
	runReadTask,
	runShortReadTask,
	runTrackedEphemeralReadTask,
	WorkersUnavailableError,
} from "../lib/db-worker/pool";
import type {
	SelectDigestBatchEntry,
	SelectDigestBatchParams,
	SelectDigestBatchResult,
} from "../lib/db-worker/protocol";
import {
	type ReadBind,
	SELECT_ROWS_MAX_ROWS,
	type SelectChunk,
	type SelectChunksResult,
	type SelectRowsResult,
} from "../lib/db-worker/protocol";
import { type ReadTaskDiagnostics, warnReadQueryRejected } from "../lib/db-worker/read-diagnostics";
import {
	validateSelectDigestBatch,
	validateSelectDigestBatchResult,
} from "../lib/db-worker/select-digest-batch";
import { encodeReadBinds } from "../lib/db-worker/select-extended";
import { validateSelectRows } from "../lib/db-worker/select-rows";
import {
	beginReadFanoutSpan,
	countReadFanout,
	finishReadFanoutSpan,
	isReadFanoutCaptureActive,
	type ReadFanoutSpan,
	recordReadFanoutSql,
	timeReadFanoutSync,
} from "../lib/read-fanout-diagnostics";
import {
	adaptReadQuery,
	compileDbAll,
	getSourceClient,
	isPostgresQuery,
	isPostgresSource,
	type SqlReadSource,
} from "./worker-read-adapter";

const DEFAULT_TIMEOUT_MS = 30_000;
const FANOUT_OWNER = Symbol("read-fanout-logical-owner");
export interface ReadQueryOptions {
	[FANOUT_OWNER]?: ReadFanoutSpan | true;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Absolute caller budget shared by queue, worker startup and execution. */
	deadlineAt?: number;
	/** Server-owned scheduling contract, accepted only for selectRows. */
	schedulingHint?: "auth-session";
	/** Observational row threshold; business SQL controls pagination and explicit limits. */
	maxRows?: number;
	/**
	 * Run on the reserved short-read pool (5 s cap, small queue) instead of the ordinary read
	 * queue. Only for indexed point lookups on a hot path; `maxRows` defaults to 1.
	 */
	shortRead?: boolean;
	executionPolicy?: "compatible" | "worker-required";
	/** Static diagnostic label only; never include bound values or other user content. */
	diagnosticSource?: string;
	/** Internal owner for one logical paged read and its postprocessing observations. */
	diagnosticContext?: ReadTaskDiagnostics;
}
function fanoutSpan(options: ReadQueryOptions): ReadFanoutSpan | undefined {
	const owner = options[FANOUT_OWNER];
	return owner === true ? undefined : owner;
}
async function observeBridge<T>(
	options: ReadQueryOptions,
	work: (options: ReadQueryOptions) => Promise<T>,
): Promise<T> {
	// An explicit options marker follows only bridge-to-bridge delegation, not unrelated reads
	// started by a business callback in the same ALS context.
	if (options[FANOUT_OWNER] || !isReadFanoutCaptureActive()) return work(options);
	const span = beginReadFanoutSpan("logical");
	try {
		const result = await work({ ...options, [FANOUT_OWNER]: span ?? true });
		finishReadFanoutSpan(span);
		return result;
	} catch (error) {
		finishReadFanoutSpan(span, error);
		throw error;
	}
}
function validateReadRequest<T>(
	sql: string,
	binds: readonly unknown[],
	options: ReadQueryOptions,
	validate: () => T,
): T {
	try {
		return validate();
	} catch (error) {
		if (error instanceof DbReadError && error.code === "DB_READ_INVALID") {
			try {
				warnReadQueryRejected(error, sql, binds, options);
			} catch {
				// Diagnostics must never replace the original validation error.
			}
		}
		throw error;
	}
}
function inlineReason(client: Database | undefined): string | undefined {
	if (!client || typeof client.filename !== "string") return "unsupported_database";
	if (!client.filename || client.filename === ":memory:") return "memory_database";
	if (client.inTransaction) return "transaction_visibility";
}
function requireSupported(reason: string, options: ReadQueryOptions): void {
	if (options.executionPolicy === "worker-required")
		throw new DbReadError("DB_READ_UNSUPPORTED", `database read requires a worker: ${reason}`);
}
function taskOptions(options: ReadQueryOptions) {
	if (options.signal?.aborted) throw readAborted();
	return {
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		deadlineAt: options.deadlineAt,
		schedulingHint: options.schedulingHint,
		diagnosticSource: options.diagnosticSource,
		diagnosticContext: options.diagnosticContext,
	};
}
export function readQuery<T>(
	query: PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } },
	options?: ReadQueryOptions,
): Promise<T>;
export function readQuery<T>(
	query: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
	options?: ReadQueryOptions,
): Promise<T[]>;
export async function readQuery<T>(
	query: PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } },
	options: ReadQueryOptions = {},
): Promise<T> {
	return observeBridge(options, async (options) => {
		const observation = fanoutSpan(options);
		// PostgreSQL retains its own async driver, before any SQLite identity/path work.
		if (isPostgresQuery(query)) {
			countReadFanout(observation, "postgresReads");
			countReadFanout(observation, "logicalTemplateUnknown");
			return await query;
		}
		const execution = taskOptions(options);
		if (is(query, SQLiteSelectBase) || is(query, SQLiteRelationalQuery)) {
			const client = (query as unknown as { session?: { client?: Database } }).session?.client;
			if (!client || typeof client.filename !== "string")
				throw new WorkersUnavailableError("unsupported_sqlite_connection");
		}
		const adapter = adaptReadQuery(query);
		const reason = adapter ? inlineReason(adapter.client) : "unsupported_query";
		if (reason) {
			requireSupported(reason, options);
			countReadFanout(observation, "inlineReads");
			countReadFanout(observation, "logicalTemplateUnknown");
			return await query;
		}
		if (!adapter?.client) throw new DbReadError("DB_READ_UNSUPPORTED", "Unsupported database read");
		const identity = bindReadDatabase(adapter.client);
		const compiled = timeReadFanoutSync(observation, "compileSync", () => adapter.compile());
		recordReadFanoutSql(observation, compiled.sql);
		const extended = compiled.params.some(
			(value) =>
				typeof value === "boolean" || typeof value === "bigint" || value instanceof Uint8Array,
		);
		const params = validateReadRequest(compiled.sql, compiled.params, options, () => {
			const params = extended
				? {
						kind: "selectValues" as const,
						sql: compiled.sql,
						params: encodeReadBinds(compiled.params as ReadBind[]),
						maxRows: options.maxRows ?? (options.shortRead ? 1 : SELECT_ROWS_MAX_ROWS),
					}
				: {
						kind: "selectRows" as const,
						sql: compiled.sql,
						params: compiled.params as Array<string | number | null>,
						maxRows: options.maxRows ?? (options.shortRead ? 1 : SELECT_ROWS_MAX_ROWS),
					};
			validateSelectRows({
				...params,
				kind: "selectRows",
				params: extended ? [] : (compiled.params as Array<string | number | null>),
			});
			return params;
		});
		const result =
			options.shortRead && params.kind === "selectRows"
				? await runShortReadTask(identity.path, params, execution)
				: await runReadTask<SelectRowsResult>(identity.path, params, execution);
		if (!result.rows.length)
			return timeReadFanoutSync(observation, "mapSync", () => adapter.map([])) as T;
		const mapped: unknown[] = [];
		for (let offset = 0; offset < result.rows.length; offset += 128) {
			if (options.signal?.aborted) throw readAborted();
			const batch = timeReadFanoutSync(observation, "mapSync", () =>
				adapter.map(result.rows.slice(offset, offset + 128)),
			);
			if (!Array.isArray(batch)) return batch as T;
			mapped.push(...batch);
			if (offset + 128 < result.rows.length)
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		return mapped as T;
	});
}
export async function readQueryFirst<T>(
	query: PromiseLike<T[]> & { toSQL(): { sql: string; params: unknown[] } },
	options: ReadQueryOptions = {},
): Promise<T | undefined> {
	return (await readQuery(query, options))[0];
}
export async function readNativeValues(
	client: Database,
	sql: string,
	binds: readonly ReadBind[] = [],
	options: ReadQueryOptions = {},
): Promise<unknown[][]> {
	return observeBridge(
		options,
		async (options) => (await nativeResult(client, sql, binds, options)).rows,
	);
}
async function nativeResult(
	client: Database,
	sql: string,
	binds: readonly ReadBind[],
	options: ReadQueryOptions,
): Promise<SelectRowsResult> {
	const observation = fanoutSpan(options);
	recordReadFanoutSql(observation, sql);
	const execution = taskOptions(options);
	const reason = inlineReason(client);
	const inline = () => {
		countReadFanout(observation, "inlineReads");
		const statement = client.prepare(sql);
		try {
			return {
				columns: statement.columnNames,
				rows: statement.values(
					...(binds.map((v) => (typeof v === "boolean" ? Number(v) : v)) as SQLQueryBindings[]),
				),
			};
		} finally {
			statement.finalize();
		}
	};
	if (reason) {
		requireSupported(reason, options);
		return inline();
	}
	const identity = bindReadDatabase(client);
	const params = validateReadRequest(sql, binds, options, () => {
		const params = {
			kind: "selectValues" as const,
			sql,
			params: encodeReadBinds(binds),
			maxRows: options.maxRows ?? SELECT_ROWS_MAX_ROWS,
		};
		validateSelectRows({ ...params, kind: "selectRows", params: [] });
		return params;
	});
	return runReadTask<SelectRowsResult>(identity.path, params, execution);
}
async function objectRows<T>(
	result: SelectRowsResult,
	signal?: AbortSignal,
	observation?: ReadFanoutSpan,
): Promise<T[]> {
	const rows: T[] = [];
	for (let offset = 0; offset < result.rows.length; offset += 128) {
		if (signal?.aborted) throw readAborted();
		timeReadFanoutSync(observation, "mapSync", () => {
			for (const row of result.rows.slice(offset, offset + 128))
				rows.push(Object.fromEntries(result.columns.map((name, index) => [name, row[index]])) as T);
		});
		if (offset + 128 < result.rows.length)
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	if (signal?.aborted) throw readAborted();
	return rows;
}
export async function readNativeRows<T = Record<string, unknown>>(
	client: Database,
	sql: string,
	binds: readonly ReadBind[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	return observeBridge(options, async (options) =>
		objectRows<T>(
			await nativeResult(client, sql, binds, options),
			options.signal,
			fanoutSpan(options),
		),
	);
}
export async function readSqlValues(
	source: Database | SqlReadSource,
	sql: string,
	binds: readonly ReadBind[] = [],
	options: ReadQueryOptions = {},
): Promise<unknown[][]> {
	return observeBridge(options, async (options) => {
		const client = getSourceClient(source);
		if (!client)
			throw new DbReadError(
				"DB_READ_UNSUPPORTED",
				"Raw SQL reads require a SQLite source; use the PostgreSQL driver",
			);
		return readNativeValues(client, sql, binds, options);
	});
}
export async function readSqlRows<T = Record<string, unknown>>(
	source: Database | SqlReadSource,
	sql: string,
	binds: readonly ReadBind[] = [],
	options: ReadQueryOptions = {},
): Promise<T[]> {
	return observeBridge(options, async (options) => {
		const client = getSourceClient(source);
		if (!client)
			throw new DbReadError(
				"DB_READ_UNSUPPORTED",
				"Raw SQL reads require a SQLite source; use the PostgreSQL driver",
			);
		return readNativeRows<T>(client, sql, binds, options);
	});
}
export async function readDbAll<T = Record<string, unknown>>(
	source: SqlReadSource,
	query: SQLWrapper,
	options: ReadQueryOptions = {},
): Promise<T[]> {
	return observeBridge(options, async (options) => {
		const observation = fanoutSpan(options);
		if (isPostgresSource(source)) {
			countReadFanout(observation, "postgresReads");
			countReadFanout(observation, "logicalTemplateUnknown");
			if (!source.all && !source.execute)
				throw new DbReadError("DB_READ_UNSUPPORTED", "Unsupported PostgreSQL read source");
			const result = source.all ? await source.all(query) : await source.execute?.(query);
			if (Array.isArray(result)) return result as T[];
			if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows))
				return result.rows as T[];
			throw new DbReadError("DB_READ_FAILED", "Unsupported PostgreSQL result shape");
		}
		const client = getSourceClient(source);
		if (!client) {
			requireSupported("unsupported_database", options);
			if (!source.all)
				throw new DbReadError("DB_READ_UNSUPPORTED", "Unsupported database read source");
			countReadFanout(observation, "inlineReads");
			countReadFanout(observation, "logicalTemplateUnknown");
			return (await source.all(query)) as T[];
		}
		const compiled = timeReadFanoutSync(observation, "compileSync", () =>
			compileDbAll(source, query),
		);
		return readNativeRows<T>(client, compiled.sql, compiled.params as ReadBind[], options);
	});
}
export async function readDomainTask<K extends SyncDomainReadTaskKind>(
	client: Database,
	task: K,
	input: DomainReadTaskMap[K]["params"],
	options: ReadQueryOptions = {},
): Promise<DomainReadTaskMap[K]["result"]> {
	return observeBridge(options, async (options) => {
		countReadFanout(fanoutSpan(options), "domainTasks");
		countReadFanout(fanoutSpan(options), "logicalTemplateUnknown");
		const reason = inlineReason(client);
		if (reason)
			throw new DbReadError("DB_READ_UNSUPPORTED", `domain reads require a worker: ${reason}`);
		const identity = bindReadDatabase(client);
		return runReadTask(identity.path, createDomainReadParams(task, input), taskOptions(options));
	});
}

/** Consumer completion acknowledges a frame; the bridge never retains payloads. */
export async function consumeReadDomainTask<K extends StreamDomainReadTaskKind>(
	client: Database,
	task: K,
	input: DomainReadTaskMap[K]["params"],
	consume: (bytes: Uint8Array) => void | Promise<void>,
	options: ReadQueryOptions = {},
): Promise<DomainReadStreamResult<DomainReadTaskMap[K]["result"]>> {
	return observeBridge(options, async (options) => {
		countReadFanout(fanoutSpan(options), "domainTasks");
		countReadFanout(fanoutSpan(options), "logicalTemplateUnknown");
		const startedAt = Date.now();
		const execution = taskOptions(options);
		const timeoutMs = Math.min(execution.timeoutMs, DOMAIN_READ_STREAM_TIMEOUT_MS);
		if (!Number.isFinite(execution.timeoutMs) || timeoutMs <= 0)
			throw new DbReadError("DB_READ_TASK_TIMEOUT", "Domain stream deadline expired");
		if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
			throw new DbReadError("DB_READ_INVALID", "Invalid domain stream deadline");
		const deadlineAt = Math.min(startedAt + timeoutMs, options.deadlineAt ?? Infinity);
		const reason = inlineReason(client);
		if (reason)
			throw new DbReadError("DB_READ_UNSUPPORTED", `domain streams require a worker: ${reason}`);
		if (typeof consume !== "function")
			throw new DbReadError("DB_READ_INVALID", "Domain stream requires a consumer");
		const params = createDomainReadParams(task, input);
		const { path } = bindReadDatabase(client);
		const maxBytes = DOMAIN_STREAM_BYTE_LIMITS[task];
		let receivedBytes = 0;
		let receivedChunks = 0;
		const handle = runTrackedEphemeralReadTask<
			DomainReadStreamResult<DomainReadTaskMap[K]["result"]>
		>(path, params, {
			...execution,
			timeoutMs,
			deadlineAt,
			onChunk: async (frame) => {
				const bytes = frame.rows?.[0]?.[0];
				if (
					!Array.isArray(frame.columns) ||
					frame.columns.length !== 1 ||
					frame.columns[0] !== "bytes" ||
					!Array.isArray(frame.rows) ||
					frame.rows.length !== 1 ||
					!Array.isArray(frame.rows[0]) ||
					frame.rows[0].length !== 1 ||
					!(bytes instanceof Uint8Array) ||
					bytes.byteLength === 0 ||
					bytes.buffer.byteLength > DOMAIN_READ_STREAM_CHUNK_BYTES ||
					receivedBytes + bytes.byteLength > maxBytes
				)
					throw new DbReadError("DB_READ_PROTOCOL", "Invalid domain stream frame");
				const size = bytes.byteLength;
				await consume(bytes);
				receivedBytes += size;
				receivedChunks++;
			},
		});
		const timeout = () =>
			new DbReadError("DB_READ_TASK_TIMEOUT", "Domain stream exceeded its deadline");
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				handle.result.finally(() => handle.released),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(timeout()), Math.max(0, deadlineAt - Date.now()));
				}),
			]);
			if (Date.now() >= deadlineAt) throw timeout();
			if (
				!result ||
				!Object.hasOwn(result, "metadata") ||
				result.bytes !== receivedBytes ||
				result.chunks !== receivedChunks
			)
				throw new DbReadError("DB_READ_PROTOCOL", "Invalid domain stream completion");
			return result;
		} finally {
			clearTimeout(timer);
		}
	});
}

export async function readDomainTaskText<K extends StreamDomainReadTaskKind>(
	client: Database,
	task: K,
	input: DomainReadTaskMap[K]["params"],
	options: ReadQueryOptions = {},
) {
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const parts: string[] = [];
	const result = await consumeReadDomainTask(
		client,
		task,
		input,
		(bytes) => {
			parts.push(decoder.decode(bytes, { stream: true }));
		},
		options,
	);
	parts.push(decoder.decode());
	return { ...result, text: () => parts.join("") };
}
/** Internal generic SELECT batch: ordered immutable commitments, never returned source bodies. */
export async function readSelectDigestBatch(
	source: Database | SqlReadSource,
	entries: readonly SelectDigestBatchEntry[],
	options: ReadQueryOptions = {},
): Promise<SelectDigestBatchResult> {
	return observeBridge(options, async (options) => {
		countReadFanout(fanoutSpan(options), "logicalTemplateUnknown");
		if (options.signal?.aborted) throw readAborted();
		if (!Array.isArray(entries))
			throw new DbReadError("DB_READ_INVALID", "Invalid SELECT digest batch");
		const client = getSourceClient(source);
		const reason = inlineReason(client);
		if (reason || !client)
			throw new DbReadError(
				"DB_READ_UNSUPPORTED",
				`SELECT digest batches require a worker: ${reason}`,
			);
		const params: SelectDigestBatchParams = {
			kind: "selectDigestBatch",
			entries: entries.map((entry) => ({
				ordinal: entry.ordinal,
				query: entry.query,
				params: encodeReadBinds(entry.params),
				digest: entry.digest,
				rows: entry.rows,
				bytes: entry.bytes,
			})),
		};
		validateSelectDigestBatch(params);
		const identity = bindReadDatabase(client);
		const result = await runReadTask<SelectDigestBatchResult>(
			identity.path,
			params,
			taskOptions(options),
		);
		validateSelectDigestBatchResult(result, params);
		return result;
	});
}

/** Consumer completion is the ACK. Failures abort the task; no hidden result accumulation. */
export async function consumeReadSqlValues(
	source: Database | SqlReadSource,
	sql: string,
	binds: readonly ReadBind[],
	onChunk: (chunk: SelectChunk) => void | Promise<void>,
	options: ReadQueryOptions = {},
): Promise<SelectChunksResult> {
	return observeBridge(options, async (options) => {
		recordReadFanoutSql(fanoutSpan(options), sql);
		const client = getSourceClient(source);
		const reason = inlineReason(client);
		if (reason || !client)
			throw new DbReadError("DB_READ_UNSUPPORTED", `chunk reads require a worker: ${reason}`);
		const identity = bindReadDatabase(client);
		const params = validateReadRequest(sql, binds, options, () => {
			const params = {
				kind: "selectChunks" as const,
				sql,
				params: encodeReadBinds(binds),
				maxRows: options.maxRows ?? SELECT_ROWS_MAX_ROWS,
			};
			validateSelectRows({ ...params, kind: "selectRows", params: [] });
			return params;
		});
		return runReadTask(identity.path, params, { ...taskOptions(options), onChunk });
	});
}
