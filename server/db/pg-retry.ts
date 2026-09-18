/**
 * Retry one whole PostgreSQL atomic section on transient failure.
 *
 * THE RETRY UNIT IS THE WHOLE SECTION
 * -----------------------------------
 * Retrying a single STATEMENT inside a transaction is unsound: after 40001/40P01/55P03 the
 * transaction is aborted, so the unit that can be replayed is the entire atomic section —
 * BEGIN through COMMIT. `fn` must therefore BE that section, and it must be idempotent under
 * whole-section replay: a section that already committed before the failure surfaced (e.g. a
 * serialization error raised at COMMIT) will run again, and any effect it produces twice is a
 * bug the caller owns. Side effects that are not replayable (event broadcasts, cache writes,
 * notifications) belong AFTER this function resolves — it resolves only once, which is the
 * exactly-once boundary for post-commit work.
 *
 * 23505 IS NOT A RETRYABLE ERROR HERE
 * -----------------------------------
 * A unique violation replayed is a unique violation repeated. It is classified apart (see
 * `pg-errors.ts`) and rethrown untouched on the first occurrence, so the idempotency-aware
 * caller decides whether "already exists" is the outcome it wanted. This function will never
 * turn a conflict into a success.
 *
 * Style continuity with `withDbRetry` (`server/lib/db-resilience.ts`): same `label` /
 * `maxRetries` surface and warn-then-error logging, but with the shorter 50/100/200 ms schedule
 * appropriate to a networked engine, full jitter, and one deliberate difference — `maxRetries`
 * here counts RETRIES AFTER the first attempt (withDbRetry's parameter counts attempts despite
 * its name), so the default 3 yields attempts 1+3 with backoffs 50, 100, 200 ms.
 */

import { logger } from "../lib/logger";
import { classifyPgError } from "./pg-errors";

export interface PgRetryOptions {
	/** Log label, e.g. the domain operation name. */
	readonly label?: string;
	/** Retries after the initial attempt. Default 3 → up to 4 attempts, backoffs 50/100/200 ms. */
	readonly maxRetries?: number;
	/** Test seam for the backoff wait; defaults to a real timer. */
	readonly sleep?: (ms: number) => Promise<void>;
}

const BASE_BACKOFF_MS = 50;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 50, 100, 200 — doubling, capped so a caller-raised maxRetries cannot wait unboundedly. */
function backoffBaseMs(retry: number): number {
	return BASE_BACKOFF_MS * 2 ** Math.min(retry - 1, 2);
}

/**
 * Run `fn`, replaying it whole while the failure is a retryable SQLSTATE and retries remain.
 *
 * Rejects with the ORIGINAL error object — never wrapped — both for non-retryable failures and
 * when retries are exhausted, because the identity of the final failure is diagnostic evidence.
 */
export async function withPgRetry<T>(
	fn: () => Promise<T>,
	options: PgRetryOptions = {},
): Promise<T> {
	const { label = "pg_write", maxRetries = 3, sleep = defaultSleep } = options;
	let retriesUsed = 0;

	for (;;) {
		try {
			return await fn();
		} catch (error) {
			const classification = classifyPgError(error);
			if (classification.kind !== "retryable") {
				// unique-violation, non-retryable and unrecognized all land here: no retry, no wrap.
				throw error;
			}
			if (retriesUsed >= maxRetries) {
				logger.error(`${label} failed after ${retriesUsed + 1} attempt(s)`, {
					error: error instanceof Error ? error.message : String(error),
					sqlstate: classification.sqlstate,
				});
				throw error;
			}

			retriesUsed += 1;
			const base = backoffBaseMs(retriesUsed);
			// Full jitter in [base, 2·base): spreads the retry of every transaction that lost the
			// same serialization race, so the losers do not collide again in lockstep.
			const delay = base + Math.floor(Math.random() * base);
			logger.warn(
				`${label} failed (attempt ${retriesUsed}/${maxRetries + 1}), retrying whole section…`,
				{
					error: error instanceof Error ? error.message : String(error),
					sqlstate: classification.sqlstate,
					delayMs: delay,
				},
			);
			await sleep(delay);
		}
	}
}
