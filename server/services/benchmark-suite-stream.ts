import type { Database } from "bun:sqlite";
import { consumeReadDomainTask } from "../db/worker-read";
import { DbReadError } from "../lib/db-worker/errors";
import {
	BENCHMARK_SUITE_LIST_TIMEOUT_MS,
	BENCHMARK_SUITE_STREAM_CHUNK_BYTES,
} from "./benchmark-limits";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	void promise.catch(() => {});
	return { promise, resolve, reject };
}

/** SQLite list transport; PG keeps its native asynchronous driver. ACK follows consumption. */
export async function createBenchmarkSuiteListStream(
	client: Database,
	options: { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<ReadableStream<Uint8Array>> {
	options.signal?.throwIfAborted();
	const now = Date.now();
	if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
		throw new TypeError("Benchmark deadline must be finite");
	const deadlineAt = Math.min(
		options.deadlineAt ?? now + BENCHMARK_SUITE_LIST_TIMEOUT_MS,
		now + BENCHMARK_SUITE_LIST_TIMEOUT_MS,
	);
	if (deadlineAt <= now)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Benchmark list deadline expired");
	const cancellation = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, cancellation.signal])
		: cancellation.signal;
	const ready = deferred();
	let demand = deferred();
	let acknowledgement: ReturnType<typeof deferred> | undefined;
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let terminal = false;
	let cancelled = false;
	let first = true;
	let completion: Promise<void> = Promise.resolve();
	const fail = (error: unknown) => {
		ready.reject(error);
		demand.reject(error);
		acknowledgement?.reject(error);
		if (!terminal && !cancelled) {
			terminal = true;
			controller.error(error);
		}
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			pull() {
				acknowledgement?.resolve();
				acknowledgement = undefined;
				demand.resolve();
			},
			async cancel(reason) {
				cancelled = true;
				cancellation.abort(
					reason ?? new DbReadError("DB_READ_ABORTED", "Benchmark list cancelled"),
				);
				await completion;
			},
		},
		{ highWaterMark: 0 },
	);
	const onAbort = () => fail(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() =>
			cancellation.abort(
				new DbReadError("DB_READ_TASK_TIMEOUT", "Benchmark list deadline expired"),
			),
		Math.max(1, deadlineAt - Date.now()),
	);
	completion = Promise.resolve()
		.then(() =>
			consumeReadDomainTask(
				client,
				"benchmarkSuiteListSnapshot",
				{},
				async (bytes) => {
					if (
						!(bytes instanceof Uint8Array) ||
						!bytes.byteLength ||
						bytes.byteLength > BENCHMARK_SUITE_STREAM_CHUNK_BYTES
					)
						throw new DbReadError("DB_READ_BUDGET", "Invalid benchmark stream chunk");
					if (first) {
						if (
							!(
								bytes[0] === 91 &&
								(bytes.byteLength === 1 || (bytes.byteLength === 2 && bytes[1] === 93))
							)
						)
							throw new DbReadError("DB_READ_FAILED", "Invalid benchmark ready handshake");
						first = false;
						ready.resolve();
					}
					await demand.promise;
					signal.throwIfAborted();
					demand = deferred();
					const consumed = deferred();
					acknowledgement = consumed;
					controller.enqueue(bytes);
					await consumed.promise;
					signal.throwIfAborted();
				},
				{
					signal,
					executionPolicy: "worker-required",
					timeoutMs: Math.max(1, deadlineAt - Date.now()),
				},
			),
		)
		.then(() => {
			if (first)
				throw new DbReadError("DB_READ_FAILED", "Benchmark snapshot ended before readiness");
			if (!terminal && !cancelled) {
				terminal = true;
				controller.close();
			}
		})
		.catch((error: unknown) => {
			cancellation.abort(error);
			fail(error);
		})
		.finally(() => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		});
	try {
		await ready.promise;
		signal.throwIfAborted();
		return stream;
	} catch (error) {
		cancellation.abort(error);
		await completion;
		throw error;
	}
}
