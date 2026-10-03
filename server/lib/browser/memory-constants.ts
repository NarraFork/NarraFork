/** Shared operation budgets; timeout covers the whole operation, not each CDP command. */
export const MEMORY_METRICS_DEFAULT_TIMEOUT_MS = 10_000;
export const MEMORY_METRICS_MAX_TIMEOUT_MS = 30_000;
export const HEAP_SNAPSHOT_DEFAULT_TIMEOUT_MS = 60_000;
export const HEAP_SNAPSHOT_MAX_TIMEOUT_MS = 120_000;
/** Session lifecycle waits long enough for worker cancellation/termination plus file cleanup. */
export const MEMORY_CLEANUP_TIMEOUT_MS = 5_000;
export const MAX_HEAP_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const HEAP_SNAPSHOT_PENDING_BYTES = 8 * 1024 * 1024;
/** Each worker cleanup step is independently bounded; the supervisor also terminates it. */
export const HEAP_SNAPSHOT_WORKER_CLEANUP_MS = 1_000;
