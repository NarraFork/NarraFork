export const MAX_TASKS_PER_SUITE = 1_000;
export const MAX_SUITE_JSON_CHARS = 20_000_000;
export const BENCHMARK_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const BENCHMARK_MAX_ROWS = 10_000;
export const BENCHMARK_READ_TIMEOUT_MS = 30_000;
export const BENCHMARK_CHUNK_BYTES = 64 * 1024;
export const BENCHMARK_MAX_STREAMS = 4;
export const BENCHMARK_MAX_COMPARE_RUNS = 32;

export class BenchmarkBudgetError extends Error {
	readonly code = "BENCHMARK_READ_BUDGET";
}
