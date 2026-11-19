import type { Database } from "bun:sqlite";
import { DbReadError } from "../lib/db-worker/errors";
import {
	BENCHMARK_SNAPSHOT_TIMEOUT_MS,
	BENCHMARK_SUITE_LIST_TIMEOUT_MS,
	BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES,
	BENCHMARK_SUITE_STREAM_CHUNK_BYTES,
	MAX_SUITE_JSON_CHARS,
	MAX_TASKS_PER_SUITE,
} from "./benchmark-limits";
import { readNarratorMessageRowsSnapshot } from "./narrator-message-snapshot-reader";

export interface BenchmarkSuiteSnapshotInput {
	suiteId: string;
	format: "raw" | "json";
}
export interface RawBenchmarkSuite {
	id: string;
	name: string;
	version: string | null;
	description: string | null;
	tasksJson: string | null;
	createdAt: string;
}
export type BenchmarkSuiteSnapshotResult = RawBenchmarkSuite | string | null;
export function validateBenchmarkSuiteSnapshotInput(
	value: unknown,
): value is BenchmarkSuiteSnapshotInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		Object.keys(row).length === 2 &&
		typeof row.suiteId === "string" &&
		row.suiteId.length > 0 &&
		Buffer.byteLength(row.suiteId) <= 256 &&
		(row.format === "raw" || row.format === "json")
	);
}
function check(signal?: AbortSignal, deadlineAt = Number.POSITIVE_INFINITY) {
	if (signal?.aborted) throw new DbReadError("DB_READ_ABORTED", "Benchmark read cancelled");
	if (Date.now() >= deadlineAt)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Benchmark read deadline expired");
}
export function readBenchmarkSuiteSnapshot(
	database: Database,
	input: BenchmarkSuiteSnapshotInput,
	signal?: AbortSignal,
	deadlineAt?: number,
): BenchmarkSuiteSnapshotResult {
	if (!validateBenchmarkSuiteSnapshotInput(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid benchmark suite input");
	check(signal, deadlineAt);
	return database.transaction(() => {
		const size = database.prepare(
			`SELECT coalesce(octet_length(id),0) + coalesce(octet_length(name),0) + coalesce(octet_length(version),0) + coalesce(octet_length(description),0) + coalesce(octet_length(tasks_json),0) + coalesce(octet_length(created_at),0) AS bytes FROM benchmark_suites WHERE id = ? LIMIT 1`,
		);
		const body = database.prepare(
			"SELECT id, name, version, description, tasks_json AS tasksJson, created_at AS createdAt FROM benchmark_suites WHERE id = ? LIMIT 1",
		);
		try {
			const metadata = size.get(input.suiteId) as { bytes: number } | null;
			if (!metadata) return null;
			if (metadata.bytes > BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES - 4096)
				throw new DbReadError("DB_READ_BUDGET", "Benchmark suite exceeds its source byte budget");
			check(signal, deadlineAt);
			const row = body.get(input.suiteId) as RawBenchmarkSuite | null;
			if (!row) throw new DbReadError("DB_READ_FAILED", "Benchmark suite disappeared");
			if (row.tasksJson !== null && row.tasksJson.length > MAX_SUITE_JSON_CHARS)
				throw new DbReadError("DB_READ_BUDGET", "Benchmark suite exceeds its character contract");
			const tasks: unknown = row.tasksJson === null ? null : JSON.parse(row.tasksJson);
			if (tasks !== null && (!Array.isArray(tasks) || tasks.length > MAX_TASKS_PER_SUITE))
				throw new DbReadError("DB_READ_BUDGET", "Benchmark suite exceeds its task contract");
			if (input.format === "raw") return row;
			const json = JSON.stringify({ ...row, tasksJson: tasks });
			if (Buffer.byteLength(json) > BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES - 4096)
				throw new DbReadError("DB_READ_BUDGET", "Benchmark suite exceeds its encoded byte budget");
			return json;
		} finally {
			size.finalize();
			body.finalize();
		}
	})();
}

export interface BenchmarkMetricsSnapshotParams {
	narratorId: string;
}
export interface BenchmarkMetricsSnapshotResult {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	toolCallCount: number;
	messageCount: number;
	lastAssistantText: string;
}
export function validateBenchmarkMetricsSnapshotInput(
	value: unknown,
): value is BenchmarkMetricsSnapshotParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		Object.keys(row).length === 1 &&
		typeof row.narratorId === "string" &&
		row.narratorId.length > 0 &&
		Buffer.byteLength(row.narratorId) <= 256
	);
}
export function readBenchmarkMetricsSnapshot(
	database: Database,
	input: BenchmarkMetricsSnapshotParams,
	signal?: AbortSignal,
	deadlineAt = Date.now() + BENCHMARK_SNAPSHOT_TIMEOUT_MS,
): BenchmarkMetricsSnapshotResult {
	if (!validateBenchmarkMetricsSnapshotInput(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid benchmark metrics input");
	return database.transaction(() => {
		// Keep the upstream scan order: metrics select the last matching assistant in that order.
		const messages = database.prepare(
			`SELECT id, role, tokens_in AS tokensIn, output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, cost_usd AS costUsd, coalesce(octet_length(content_text),0) > 0 AS hasText FROM narrator_messages WHERE narrator_id = ?`,
		);
		const tools = database.prepare(
			"SELECT count(*) AS count FROM narrator_tool_calls WHERE narrator_id = ?",
		);
		try {
			let tokensIn = 0,
				tokensOut = 0,
				costUsd = 0,
				messageCount = 0;
			let lastAssistantId: string | null = null;
			for (const row of messages.iterate(input.narratorId) as Iterable<{
				id: string;
				role: string;
				tokensIn: number | null;
				outputTokens: number | null;
				reasoningTokens: number | null;
				costUsd: number | null;
				hasText: number;
			}>) {
				check(signal, deadlineAt);
				tokensIn += row.tokensIn ?? 0;
				tokensOut += (row.outputTokens ?? 0) + (row.reasoningTokens ?? 0);
				costUsd += row.costUsd ?? 0;
				messageCount++;
				if (row.role === "assistant" && row.hasText) lastAssistantId = row.id;
			}
			const snapshot = lastAssistantId
				? readNarratorMessageRowsSnapshot(
						database,
						{ messageIds: [lastAssistantId], includeTools: false, includeCreator: false },
						signal,
					)
				: null;
			check(signal, deadlineAt);
			return {
				tokensIn,
				tokensOut,
				costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
				messageCount,
				toolCallCount: (tools.get(input.narratorId) as { count: number }).count,
				lastAssistantText: String(snapshot?.messages[0]?.content_text ?? ""),
			};
		} finally {
			messages.finalize();
			tools.finalize();
		}
	})();
}

export type BenchmarkSuiteListSnapshotInput = Record<string, never>;
export interface BenchmarkSuiteListSnapshotResult {
	rowCount: number;
	bytes: number;
	chunks: number;
}
export interface BenchmarkSuiteListSnapshotContext {
	signal: AbortSignal;
	deadlineAt: number;
	emit: (bytes: Uint8Array) => Promise<void>;
}
export function validateBenchmarkSuiteListSnapshotInput(
	value: unknown,
): value is BenchmarkSuiteListSnapshotInput {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
		Object.keys(value).length === 0
	);
}
/** Holds one readonly snapshot through every consumer ACK; only one bounded row is encoded at a time. */
export async function readBenchmarkSuiteListSnapshot(
	database: Database,
	input: BenchmarkSuiteListSnapshotInput,
	context: BenchmarkSuiteListSnapshotContext,
): Promise<BenchmarkSuiteListSnapshotResult> {
	if (!validateBenchmarkSuiteListSnapshotInput(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid benchmark list input");
	const deadlineAt = Math.min(context.deadlineAt, Date.now() + BENCHMARK_SUITE_LIST_TIMEOUT_MS);
	if (database.inTransaction)
		throw new DbReadError("DB_READ_BUSY", "Benchmark stream already owns a snapshot");
	let owned = false;
	let cleanupFailed = false;
	let failure: { error: unknown } | undefined;
	let result: BenchmarkSuiteListSnapshotResult | undefined;
	try {
		check(context.signal, deadlineAt);
		database.run("BEGIN");
		owned = true;
		const count = database.prepare("SELECT count(*) AS count FROM benchmark_suites");
		let n: number;
		try {
			n = (count.get() as { count: number }).count;
		} finally {
			count.finalize();
		}
		const byteBound = 2 + n * (BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES + 1);
		if (!Number.isSafeInteger(byteBound))
			throw new DbReadError("DB_READ_BUDGET", "Benchmark list source counters exceed safe bounds");
		let rowCount = 0,
			bytes = 0,
			chunks = 0;
		const emit = async (part: Uint8Array) => {
			check(context.signal, deadlineAt);
			if (
				!part.byteLength ||
				part.byteLength > BENCHMARK_SUITE_STREAM_CHUNK_BYTES ||
				bytes + part.byteLength > byteBound
			)
				throw new DbReadError(
					"DB_READ_BUDGET",
					"Benchmark list transfer exceeds its snapshot bound",
				);
			await context.emit(part);
			check(context.signal, deadlineAt);
			bytes += part.byteLength;
			chunks++;
		};
		const candidates = database.prepare("SELECT id FROM benchmark_suites ORDER BY created_at ASC");
		const encoder = new TextEncoder();
		try {
			for (const row of candidates.iterate() as Iterable<{ id: string }>) {
				const json = readBenchmarkSuiteSnapshot(
					database,
					{ suiteId: row.id, format: "json" },
					context.signal,
					deadlineAt,
				);
				if (typeof json !== "string" || rowCount >= n)
					throw new DbReadError("DB_READ_FAILED", "Benchmark list snapshot changed");
				const encoded = encoder.encode(json);
				await emit(encoder.encode(rowCount === 0 ? "[" : ","));
				for (let offset = 0; offset < encoded.length; offset += BENCHMARK_SUITE_STREAM_CHUNK_BYTES)
					await emit(encoded.subarray(offset, offset + BENCHMARK_SUITE_STREAM_CHUNK_BYTES));
				rowCount++;
			}
			if (rowCount !== n)
				throw new DbReadError("DB_READ_FAILED", "Benchmark list snapshot incomplete");
			await emit(encoder.encode(n === 0 ? "[]" : "]"));
			result = { rowCount, bytes, chunks };
		} finally {
			candidates.finalize();
		}
	} catch (error) {
		failure = { error };
	} finally {
		try {
			if (owned && database.inTransaction) database.run("ROLLBACK");
		} catch {
			cleanupFailed = true;
		}
	}
	if (cleanupFailed)
		throw new DbReadError(
			"DB_READ_SNAPSHOT_CLEANUP_FAILED",
			"Benchmark read snapshot release failed",
		);
	if (failure) throw failure.error;
	if (!result) throw new DbReadError("DB_READ_FAILED", "Benchmark stream produced no completion");
	return result;
}
export { BENCHMARK_SUITE_STREAM_CHUNK_BYTES } from "./benchmark-limits";
