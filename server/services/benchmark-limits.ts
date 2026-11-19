/** Producer/read contracts; this module has no application bootstrap dependencies. */
export const MAX_TASKS_PER_SUITE = 1_000;
export const MAX_SUITE_JSON_CHARS = 20_000_000;
export const BENCHMARK_SUITE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;
export const BENCHMARK_SUITE_STREAM_CHUNK_BYTES = 64 * 1024;
export const BENCHMARK_SNAPSHOT_TIMEOUT_MS = 30_000;
export const BENCHMARK_SUITE_LIST_TIMEOUT_MS = BENCHMARK_SNAPSHOT_TIMEOUT_MS;
