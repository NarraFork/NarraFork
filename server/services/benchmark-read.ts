import type { Database } from "bun:sqlite";
import { closeSync, openSync, writeSync } from "node:fs";
import type { benchmarkTaskResults } from "../db/schema";
import {
	BENCHMARK_CHUNK_BYTES,
	BENCHMARK_MAX_RESPONSE_BYTES,
	BENCHMARK_MAX_ROWS,
	BenchmarkBudgetError,
	MAX_SUITE_JSON_CHARS,
	MAX_TASKS_PER_SUITE,
} from "./benchmark-limits";

export type BenchmarkRead =
	| { type: "suites" }
	| { type: "runs"; suiteId?: string }
	| { type: "suite" | "suiteName" | "run" | "runSummary" | "results" | "resultMetrics"; id: string }
	| { type: "narratorMetrics"; id: string };

export interface BenchmarkReadParams {
	kind: "benchmarkRead";
	read: BenchmarkRead;
	deadlineAt: number;
	spoolPath?: string;
}

type Row = Record<string, unknown>;
type KeyRow = { id: string; bytes: number };

export interface BenchmarkTaskMetrics {
	id: string;
	taskId: string;
	status: typeof benchmarkTaskResults.$inferSelect.status;
	score: number | null;
	costUsd: number | null;
	tokensIn: number | null;
	tokensOut: number | null;
	durationMs: number | null;
}

export interface BenchmarkNarratorMetrics {
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	toolCallCount: number;
	messageCount: number;
	lastAssistantText: string;
}

const suiteColumns = "id name version description tasksJson createdAt";
const runColumns = [
	"id suiteId name model systemPrompt permissionMode status config",
	"totalTasks completedTasks passedTasks failedTasks totalCostUsd totalTokensIn totalTokensOut",
	"totalDurationMs startedAt completedAt createdAt",
].join(" ");
const resultColumns = [
	"id runId taskId taskName narratorId status score maxScore output evalOutput errorMessage",
	"tokensIn tokensOut costUsd durationMs toolCallCount messageCount metadata",
	"startedAt completedAt createdAt",
].join(" ");
const metricsColumns = "id taskId status score costUsd tokensIn tokensOut durationMs";

export function benchmarkReadPlan(read: Exclude<BenchmarkRead, { type: "narratorMetrics" }>) {
	switch (read.type) {
		case "suites":
			return plan("benchmark_suites", suiteColumns, undefined, "created_at, id", ["tasksJson"]);
		case "suite":
			return plan("benchmark_suites", suiteColumns, ["id", read.id], "", ["tasksJson"]);
		case "suiteName":
			return plan("benchmark_suites", "name", ["id", read.id], "", []);
		case "runs":
			return plan(
				"benchmark_runs",
				runColumns,
				read.suiteId ? ["suite_id", read.suiteId] : undefined,
				"created_at, id",
				["config"],
			);
		case "run":
			return plan("benchmark_runs", runColumns, ["id", read.id], "", ["config"]);
		case "runSummary":
			return plan("benchmark_runs", "suiteId status model", ["id", read.id], "", []);
		case "results":
			return plan("benchmark_task_results", resultColumns, ["run_id", read.id], "", ["metadata"]);
		case "resultMetrics":
			return plan("benchmark_task_results", metricsColumns, ["run_id", read.id], "", []);
		default:
			throw new Error("Invalid benchmark read");
	}
}

function plan(
	table: string,
	columns: string,
	filter: [string, string] | undefined,
	order: string,
	jsonKeys: string[],
) {
	const fields = columns
		.split(" ")
		.map((key) => [key, key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]);
	return {
		table,
		projection: fields.map(([key, column]) => `${column} AS "${key}"`).join(", "),
		size: fields
			.map(([, column]) => `coalesce(octet_length(cast(${column} AS text)), 0)`)
			.join(" + "),
		filter,
		order: order ? ` ORDER BY ${order}` : "",
		single: filter?.[0] === "id",
		decode(row: Row) {
			for (const key of jsonKeys) {
				const value = row[key];
				if (typeof value !== "string") continue;
				if (key === "tasksJson" && value.length > MAX_SUITE_JSON_CHARS)
					throw new BenchmarkBudgetError("Benchmark suite exceeds its character budget");
				const decoded: unknown = JSON.parse(value);
				if (
					key === "tasksJson" &&
					decoded !== null &&
					(!Array.isArray(decoded) || decoded.length > MAX_TASKS_PER_SUITE)
				)
					throw new BenchmarkBudgetError("Benchmark suite exceeds its task budget");
				row[key] = decoded;
			}
			return row;
		},
	};
}

function readNarratorMetrics(
	db: Database,
	id: string,
	check: () => void,
): BenchmarkNarratorMetrics {
	const messages = db.prepare<
		{
			id: string;
			tokens_in: number | null;
			output_tokens: number | null;
			reasoning_tokens: number | null;
			cost_usd: number | null;
			hasText: number;
		},
		[string]
	>(
		"SELECT id, tokens_in, output_tokens, reasoning_tokens, cost_usd, role = 'assistant' AND octet_length(content_text) > 0 AS hasText FROM narrator_messages WHERE narrator_id = ?",
	);
	const tools = db.prepare<{ count: number }, [string]>(
		"SELECT count(*) AS count FROM narrator_tool_calls WHERE narrator_id = ?",
	);
	const answer = db.prepare<{ text: string | null }, [number, string]>(
		"SELECT CASE WHEN octet_length(content_text) <= ? THEN content_text END AS text FROM narrator_messages WHERE id = ?",
	);
	try {
		let lastId: string | undefined;
		let tokensIn = 0,
			tokensOut = 0,
			costUsd = 0,
			messageCount = 0;
		for (const row of messages.iterate(id)) {
			check();
			tokensIn += row.tokens_in ?? 0;
			tokensOut += (row.output_tokens ?? 0) + (row.reasoning_tokens ?? 0);
			costUsd += row.cost_usd ?? 0;
			messageCount++;
			if (row.hasText) lastId = row.id;
		}
		const lastAssistantText = lastId ? answer.get(BENCHMARK_MAX_RESPONSE_BYTES, lastId)?.text : "";
		if (lastAssistantText == null)
			throw new BenchmarkBudgetError("Benchmark assistant output exceeds its byte budget");
		return {
			tokensIn,
			tokensOut,
			costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
			messageCount,
			toolCallCount: tools.get(id)?.count ?? 0,
			lastAssistantText,
		};
	} finally {
		messages.finalize();
		tools.finalize();
		answer.finalize();
	}
}

/** One read transaction covers selection, size checks, and rendering, including under WAL edits. */
export function runBenchmarkRead(db: Database, input: BenchmarkReadParams, signal: AbortSignal) {
	const check = () => {
		signal.throwIfAborted();
		if (Date.now() >= input.deadlineAt)
			throw Object.assign(new Error("Benchmark read timed out"), { code: "DB_READ_TASK_TIMEOUT" });
	};
	check();
	const { read } = input;
	if (read.type === "narratorMetrics")
		return db.transaction(() => readNarratorMetrics(db, read.id, check))();
	const { table, filter, size, projection, order, single, decode } = benchmarkReadPlan(read);
	const rowLimit = benchmarkReadRowLimit(read);
	const where = filter ? ` WHERE ${filter[0]} = ?` : "";
	const keys = db.prepare<KeyRow, string[]>(
		`SELECT id, (${size}) AS bytes FROM ${table}${where}${order} LIMIT ${rowLimit + 1}`,
	);
	const body = db.prepare<Row, [string]>(`SELECT ${projection} FROM ${table} WHERE id = ?`);
	let fd: number | undefined;
	try {
		return db.transaction(() => {
			let sourceBytes = 0,
				encodedBytes = 0,
				count = 0;
			const rows: Row[] = [];
			const write = (text: string) => {
				if (fd === undefined) return;
				check();
				const size = Buffer.byteLength(text);
				encodedBytes += size;
				if (encodedBytes > BENCHMARK_MAX_RESPONSE_BYTES)
					throw new BenchmarkBudgetError("Benchmark response exceeds its byte budget");
				const bytes = Buffer.from(text);
				for (let offset = 0; offset < size; ) {
					check();
					const written = writeSync(
						fd,
						bytes,
						offset,
						Math.min(BENCHMARK_CHUNK_BYTES, size - offset),
					);
					if (!written) throw new Error("Benchmark snapshot write did not advance");
					offset += written;
				}
			};
			for (const key of keys.iterate(...(filter ? [filter[1]] : []))) {
				check();
				if (++count > rowLimit)
					throw new BenchmarkBudgetError("Benchmark response exceeds its row budget");
				sourceBytes += key.bytes;
				if (sourceBytes > BENCHMARK_MAX_RESPONSE_BYTES)
					throw new BenchmarkBudgetError("Benchmark response exceeds its source byte budget");
				const row = body.get(key.id);
				if (!row) throw new Error("Benchmark snapshot row missing");
				decode(row);
				if (!input.spoolPath) rows.push(row);
				else {
					fd ??= openSync(input.spoolPath, "wx", 0o600);
					if (!single) write(count === 1 ? "[" : ",");
					write(JSON.stringify(row));
				}
			}
			if (!input.spoolPath) return single ? (rows[0] ?? null) : rows;
			if (!count && single) return null;
			fd ??= openSync(input.spoolPath, "wx", 0o600);
			if (!single) write(count ? "]" : "[]");
			return encodedBytes;
		})();
	} finally {
		keys.finalize();
		body.finalize();
		if (fd !== undefined) closeSync(fd);
	}
}

export function benchmarkReadRowLimit(read: BenchmarkRead): number {
	if ("id" in read && read.type !== "resultMetrics" && read.type !== "results") return 1;
	return read.type === "resultMetrics" || read.type === "results"
		? MAX_TASKS_PER_SUITE
		: BENCHMARK_MAX_ROWS;
}
