import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DbReadTaskTimeoutError,
	runReadTask,
	WorkersUnavailableError,
} from "../lib/db-worker/pool";
import { logger } from "../lib/logger";
import {
	BENCHMARK_CHUNK_BYTES,
	BENCHMARK_MAX_STREAMS,
	BENCHMARK_READ_TIMEOUT_MS,
	BenchmarkBudgetError,
} from "./benchmark-limits";
import type { BenchmarkRead } from "./benchmark-read";

let streams = 0;

type ReadConnection = { filename: string; inTransaction: boolean };

export function readSqliteBenchmark<T>(
	client: ReadConnection,
	read: BenchmarkRead,
	signal?: AbortSignal,
	spoolPath?: string,
) {
	if (!client.filename || client.filename === ":memory:" || client.inTransaction)
		throw new WorkersUnavailableError("unsupported_sqlite_connection");
	return runReadTask<T>(
		client.filename,
		{ kind: "benchmarkRead", read, spoolPath, deadlineAt: Date.now() + BENCHMARK_READ_TIMEOUT_MS },
		{ signal, timeoutMs: BENCHMARK_READ_TIMEOUT_MS, diagnosticSource: "benchmark.read" },
	);
}

/** Stage one bounded worker snapshot, then read one chunk per pull without holding a WAL reader. */
export async function createBenchmarkReadStream(
	client: ReadConnection,
	read: BenchmarkRead,
	requestSignal?: AbortSignal,
	timeoutMs = BENCHMARK_READ_TIMEOUT_MS,
): Promise<ReadableStream<Uint8Array> | null> {
	requestSignal?.throwIfAborted();
	if (streams >= BENCHMARK_MAX_STREAMS)
		throw new BenchmarkBudgetError("Too many active benchmark streams");
	streams++;
	const timeout = new AbortController();
	const timer = setTimeout(
		() => timeout.abort(new DbReadTaskTimeoutError("Benchmark response timed out")),
		Math.min(timeoutMs, BENCHMARK_READ_TIMEOUT_MS),
	);
	const signal = requestSignal ? AbortSignal.any([requestSignal, timeout.signal]) : timeout.signal;
	let directory: string | undefined;
	let file: FileHandle | undefined;
	let cleanup: Promise<void> | undefined;
	let pending: Promise<unknown> | undefined;
	let offset = 0;
	const finish = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		cleanup ??= (async () => {
			try {
				await pending?.catch(() => {});
				await file?.close();
			} finally {
				try {
					if (directory) await rm(directory, { recursive: true, force: true });
				} finally {
					streams--;
				}
			}
		})();
		return cleanup;
	};
	let controller: ReadableStreamDefaultController<Uint8Array>;
	function abort() {
		controller.error(signal.reason);
		void finish().catch(() => logger.warn("Could not clean up benchmark snapshot"));
	}
	try {
		directory = await mkdtemp(join(tmpdir(), "nf-benchmark-read-"));
		const path = join(directory, "snapshot.json");
		const length = await readSqliteBenchmark<number | null>(client, read, signal, path);
		if (length === null) {
			await finish();
			return null;
		}
		signal.throwIfAborted();
		const handle = await open(path, "r");
		file = handle;
		signal.throwIfAborted();
		return new ReadableStream<Uint8Array>(
			{
				start(value) {
					controller = value;
					signal.addEventListener("abort", abort, { once: true });
				},
				async pull(value) {
					try {
						signal.throwIfAborted();
						const chunk = new Uint8Array(Math.min(BENCHMARK_CHUNK_BYTES, length - offset));
						const reading = handle.read(chunk, 0, chunk.length, offset);
						pending = reading;
						const { bytesRead } = await reading;
						pending = undefined;
						signal.throwIfAborted();
						if (!bytesRead) throw new Error("Benchmark snapshot ended unexpectedly");
						offset += bytesRead;
						value.enqueue(chunk.subarray(0, bytesRead));
						if (offset === length) {
							await finish();
							value.close();
						}
					} catch (error) {
						await finish();
						throw error;
					}
				},
				cancel: finish,
			},
			{ highWaterMark: 0 },
		);
	} catch (error) {
		await finish();
		signal.throwIfAborted();
		throw error;
	}
}
