import { getDbPath } from "../../db/connection";
import { runReadTask } from "../../lib/db-worker/pool";
import { SEARCH_QUERY_MAX_ROWS, type SearchQueryParams } from "../../lib/db-worker/protocol";
import { validateSearchQuery } from "../../lib/db-worker/search-query";
import { AppError } from "../../lib/errors";
import { hotSafe } from "../../lib/hot-safe";
import { logger } from "../../lib/logger";

export const SEARCH_QUERY_TIMEOUT_MS = 30_000;
export const SEARCH_MAX_OUTSTANDING = 32;

export interface SearchQueryExecutionOptions {
	signal?: AbortSignal;
	operation?: string;
}

export type SearchQueryExecutor = (
	sql: string,
	params: Array<string | number | null>,
	options?: SearchQueryExecutionOptions,
) => Promise<Record<string, unknown>[]>;

type SearchTaskRunner = (
	dbPath: string,
	query: SearchQueryParams,
	options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<Record<string, unknown>[]>;

interface AdmissionState {
	outstanding: number;
}

/** Explicit transport injection is for isolated fixtures, not a production inline fallback. */
export function createSqliteSearchQueryExecutor(
	dbPath: string | (() => string),
	options: {
		runTask?: SearchTaskRunner;
		timeoutMs?: number;
		maxOutstanding?: number;
		admission?: AdmissionState;
	} = {},
): SearchQueryExecutor {
	const runTask: SearchTaskRunner = options.runTask ?? runReadTask;
	const admission = options.admission ?? { outstanding: 0 };
	const timeoutMs = options.timeoutMs ?? SEARCH_QUERY_TIMEOUT_MS;
	const maxOutstanding = options.maxOutstanding ?? SEARCH_MAX_OUTSTANDING;
	return async (sql, params, execution = {}) => {
		if (execution.signal?.aborted) {
			throw new AppError("Search was cancelled", 499, "SEARCH_QUERY_CANCELLED");
		}
		const query: SearchQueryParams = {
			kind: "searchQuery",
			sql,
			params,
			maxRows: SEARCH_QUERY_MAX_ROWS,
		};
		try {
			validateSearchQuery(query);
		} catch {
			throw new AppError("Invalid or oversized search query", 413, "SEARCH_QUERY_BUDGET_EXCEEDED");
		}
		if (admission.outstanding >= maxOutstanding) {
			throw new AppError("Search is busy; please retry", 503, "SEARCH_QUERY_BUSY");
		}
		admission.outstanding++;
		const startedAt = Date.now();
		let rowCount = 0;
		let timedOut = false;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		execution.signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		let rejectCancelled: (() => void) | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			rejectCancelled = () => reject(new Error("Search execution cancelled"));
			controller.signal.addEventListener("abort", rejectCancelled, { once: true });
		});
		try {
			// The pool observes aborts while queued/running. The race also bounds cold-worker
			// readiness, which can outlive a caller's deadline before any SQL is dispatched.
			const rows = await Promise.race([
				runTask(typeof dbPath === "function" ? dbPath() : dbPath, query, {
					timeoutMs,
					signal: controller.signal,
				}),
				cancelled,
			]);
			rowCount = rows.length;
			return rows;
		} catch {
			// Never log SQL, bound values, or raw driver errors: they may contain transcript text.
			const cancelled = execution.signal?.aborted;
			logger.warn("Search worker query failed", { cancelled: !!cancelled, timedOut });
			throw new AppError(
				timedOut
					? "Search timed out"
					: cancelled
						? "Search was cancelled"
						: "Search is temporarily unavailable",
				timedOut ? 504 : cancelled ? 499 : 503,
				timedOut
					? "SEARCH_QUERY_TIMEOUT"
					: cancelled
						? "SEARCH_QUERY_CANCELLED"
						: "SEARCH_QUERY_UNAVAILABLE",
			);
		} finally {
			clearTimeout(timer);
			execution.signal?.removeEventListener("abort", onAbort);
			if (rejectCancelled) controller.signal.removeEventListener("abort", rejectCancelled);
			admission.outstanding--;
			const durationMs = Date.now() - startedAt;
			if (durationMs > 1000) {
				logger.warn("Slow search worker query", {
					durationMs,
					rowCount,
					operation: execution.operation?.slice(0, 64) ?? "search",
				});
			}
		}
	};
}

// Shared across hot reloads so old in-flight tasks still count towards the admission cap.
const admission = hotSafe<AdmissionState>("narrafork.searchWorkerAdmission", () => ({
	outstanding: 0,
}));
export const executeSqliteSearchQuery = createSqliteSearchQueryExecutor(getDbPath, { admission });
