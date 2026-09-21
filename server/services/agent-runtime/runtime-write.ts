/**
 * agent-runtime/runtime-write.ts — the single seam for the runtime queue's atomic
 * write sections (mailbox, publication outbox, subagent/background-task recovery).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Every `db.transaction((tx) => …)` in the agent-runtime write path now passes through
 * {@link runAtomicWrite}. One seam buys three things:
 *
 *   1. THE SYNC-ATOMICITY GUARD IS ENFORCED, NOT HOPED FOR. Under `bun:sqlite` the
 *      transaction commits when the callback RETURNS; a section that yields a Promise
 *      committed at its first `await` and everything after ran in autocommit (see
 *      `server/db/transaction-atomicity-contract.test.ts`). The guard runs INSIDE the
 *      callback, so a thenable section rolls its writes back and fails loudly instead
 *      of committing half a section.
 *   2. CONFLICTS CROSS AS VOCABULARY. A uniqueness conflict — SQLSTATE 23505 on
 *      PostgreSQL, `UNIQUE constraint failed` from bun:sqlite — is translated to
 *      `WriteConflictError` (`server/db/backend/write-port.ts`) before it crosses the
 *      boundary, so the idempotency-aware caller never recognizes a driver error
 *      shape. Retryable PostgreSQL failures (40001/40P01/55P03) are rethrown
 *      UNTOUCHED: replaying them is the whole-section retry unit's business
 *      (`server/db/pg-retry.ts`), never this seam's.
 *   3. THE POSTGRESQL ADAPTER GETS ONE HINGE. The SQLite body here is strictly
 *      synchronous and returns the committed value directly, because every caller of
 *      these stores is itself synchronous inside an outer section. The PostgreSQL
 *      sibling keeps the same DOMAIN operations but exposes them as Promises from its
 *      own module — genuinely async sections with `withPgRetry` around the WHOLE
 *      section, post-commit side effects after resolve — wired at the composition
 *      root the way `services/registration/store.ts` wires its account store. What
 *      must NOT happen is an `await` inside THIS body: that would be the silent data
 *      loss the guard exists to catch.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * Not a generic `transaction(callback)` port for new domain code — anonymous callback
 * ports are how engine coupling re-enters a domain module (see write-port.ts). New
 * runtime queue capabilities belong behind named domain operations; this seam serves
 * the sections that already exist.
 */

import { WriteConflictError } from "../../db/backend/write-port";
import { classifyPgError } from "../../db/pg-errors";
import { withSeqFloorRaiseScope } from "../narrator-refs/seq-store";
import type { RuntimeDb, RuntimeTx } from "./mailbox-types";

/** bun:sqlite reports a uniqueness conflict only through this message shape. */
const SQLITE_UNIQUE_VIOLATION = /^UNIQUE constraint failed: (.+)$/;

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { then?: unknown }).then === "function"
	);
}

/**
 * Translate a driver failure into the write-path vocabulary where a translation
 * exists, and pass everything else through with its identity intact.
 *
 *   - unique violation (PG 23505 or SQLite `UNIQUE constraint failed`) →
 *     `WriteConflictError`, carrying the constrained columns as the constraint
 *     identity (SQLite never reports the index name, only its columns);
 *   - retryable PostgreSQL SQLSTATE (40001/40P01/55P03) → rethrown untouched —
 *     the whole-section retry unit owns the replay decision and needs the ORIGINAL
 *     error object;
 *   - anything else → rethrown untouched. An unrecognized error is never upgraded
 *     into a verdict it did not earn.
 */
export function translateWriteError(error: unknown, label: string): unknown {
	const classification = classifyPgError(error);
	if (classification.kind === "unique-violation") {
		return new WriteConflictError(`Atomic write "${label}" conflicts with an existing fact`, {
			cause: error,
		});
	}
	if (error instanceof Error) {
		const sqliteUnique = SQLITE_UNIQUE_VIOLATION.exec(error.message);
		if (sqliteUnique) {
			return new WriteConflictError(`Atomic write "${label}" conflicts with an existing fact`, {
				constraint: sqliteUnique[1] ?? null,
				cause: error,
			});
		}
	}
	return error;
}

/**
 * How a recovery write loop should treat a failure from one attempt.
 *
 *   - `conflict`  A uniqueness conflict (PG 23505 / SQLite UNIQUE). NEVER retried —
 *                 replaying produces the same conflict forever — and surfaced as
 *                 `WriteConflictError` so the caller decides whether "already exists"
 *                 is the outcome it wanted.
 *   - `retryable` PG 40001/40P01/55P03: the transaction failed through no fault of
 *                 its content and the WHOLE section may be replayed.
 *   - `fatal`     A recognized PostgreSQL verdict that is neither: the server
 *                 answered and replay cannot help (constraint, syntax, permission).
 *   - `ordinary`  No readable SQLSTATE — every SQLite driver error lands here, so
 *                 existing SQLite behavior (including existing retry loops) is
 *                 preserved exactly.
 */
export type RuntimeWriteErrorVerdict =
	| { readonly kind: "conflict"; readonly error: WriteConflictError }
	| { readonly kind: "retryable"; readonly sqlstate: string }
	| { readonly kind: "fatal"; readonly sqlstate: string }
	| { readonly kind: "ordinary" };

/** Classify one failed recovery-write attempt; see {@link RuntimeWriteErrorVerdict}. */
export function classifyRuntimeWriteError(error: unknown, label: string): RuntimeWriteErrorVerdict {
	const translated = translateWriteError(error, label);
	if (translated instanceof WriteConflictError) return { kind: "conflict", error: translated };
	const classification = classifyPgError(error);
	if (classification.kind === "retryable" && classification.sqlstate)
		return { kind: "retryable", sqlstate: classification.sqlstate };
	if (classification.kind === "non-retryable" && classification.sqlstate)
		return { kind: "fatal", sqlstate: classification.sqlstate };
	return { kind: "ordinary" };
}

/**
 * Run one indivisible runtime-queue write section against the SQLite store.
 *
 * STRICTLY SYNCHRONOUS, end to end: the section must contain no `await` (enforced —
 * a thenable result rolls the section back and throws), and the returned value has
 * already committed when this function returns. Callers that need a Promise boundary
 * (the write-port shape) put `async` on their OWN method and return this call's
 * result; the Promise then wraps an already-committed value, never a pending one.
 *
 * `label` names the domain operation ("mailbox.enqueue") so the guard and the
 * conflict vocabulary can say WHICH fact failed.
 */
export function runAtomicWrite<T>(
	database: RuntimeDb,
	label: string,
	section: (tx: RuntimeTx) => T,
): T {
	try {
		// Commit-then-mark for narrator seq floors: sections may claim/shift refs;
		// `raiseSeqFloorForClaim` records into this scope, and marks apply only after
		// the synchronous transaction returns (committed).
		return withSeqFloorRaiseScope(() =>
			database.transaction((tx) => {
				const result = section(tx);
				if (isThenable(result)) {
					// Throwing INSIDE the callback rolls the section's writes back; returning the
					// thenable would have committed whatever ran before its first await.
					throw new Error(
						`Atomic write section "${label}" returned a Promise: under bun:sqlite the ` +
							"transaction commits when the callback returns, so an async section silently " +
							"commits its prefix. Keep the section synchronous; the PostgreSQL adapter " +
							"gets its own genuinely-async sibling.",
					);
				}
				return result;
			}),
		);
	} catch (error) {
		throw translateWriteError(error, label);
	}
}
