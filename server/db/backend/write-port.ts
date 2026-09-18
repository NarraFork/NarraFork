/**
 * The write-side port base: the vocabulary every domain write port is built on.
 *
 * WHY THIS EXISTS
 * ---------------
 * The read side already has its adapters; the write side needs the same discipline before the
 * first business capability moves. This module is the base layer ONLY — the contract types every
 * domain write port inherits, and the error vocabulary that crosses port boundaries. No business
 * capability lives here (the first one is batch A's), and deliberately no generic
 * `transaction(callback)` either: an anonymous callback port is how callers re-invent engine
 * coupling inside a domain module. Domain ports expose DOMAIN operations
 * (`createAccount(draft)` in `server/services/registration/account-store.ts` is the model), and
 * each operation owns its atomic section internally.
 *
 * THE CONTRACT EVERY DOMAIN WRITE PORT INHERITS
 * ---------------------------------------------
 * 1. Domain-facing methods return PROMISES. The caller must never know — or be able to tell —
 *    which backend it holds, because the two implementations are shaped differently on purpose:
 *
 *      SQLite      runs its atomic section STRICTLY SYNCHRONOUSLY inside the implementation,
 *                  because `bun:sqlite` commits when the transaction callback returns — an
 *                  `await` between BEGIN and COMMIT is silent data loss (see
 *                  `server/db/transaction-atomicity-contract.test.ts`). The Promise on the
 *                  boundary is a wrapper around an already-committed result, never a promise
 *                  of one.
 *      PostgreSQL  runs a genuinely async section on its own adapter — an `await` on a
 *                  networked driver is safe — with `withPgRetry` (`server/db/pg-retry.ts`)
 *                  around the WHOLE section as the retry unit.
 *
 * 2. ATOMICITY IS PART OF THE CONTRACT, NOT OF THE IMPLEMENTATION. Each domain operation is
 *    all-or-nothing: it either returns its result with every write committed, or rejects having
 *    written nothing. How a backend achieves that is its own business; that it does is not
 *    negotiable.
 *
 * 3. CONFLICTS CROSS THE BOUNDARY AS VOCABULARY, NOT AS DRIVER ERRORS. A uniqueness conflict
 *    (SQLSTATE 23505) is translated into {@link WriteConflictError} by the implementation that
 *    saw it, so the idempotency-aware caller — the only code that knows whether "already exists"
 *    is the desired outcome — never has to recognize a driver error shape. Driver errors must
 *    not leak past a domain port: recognizing them here is what keeps batch A from importing
 *    `pg-errors.ts` in every service.
 */

import type { DatabaseBackendId } from "./capability";

/**
 * Diagnostic identity of a write port, for logs and error text ONLY.
 *
 * Same rule as the lifecycle/maintenance ports: nothing may BRANCH on `backendId` — a caller
 * that writes `if (backendId === "sqlite")` has re-created the engine coupling the port exists
 * to remove. Ask the domain operation; let the implementation answer.
 */
export interface WritePortIdentity {
	readonly backendId: DatabaseBackendId;
}

/**
 * One indivisible unit of write work, expressed against the backend's transaction handle.
 *
 * Neutral about synchrony on purpose: for the SQLite implementation `TResult` is a plain value
 * and the section is synchronous end to end; for the PostgreSQL implementation `TResult` is
 * itself a Promise and the section awaits its driver. The DOMAIN method that owns the section
 * hides this difference behind its own `Promise`-returning signature — which is why this type
 * appears in implementations, never in a caller-facing port interface.
 */
export type AtomicWriteSection<TTx, TResult> = (tx: TTx) => TResult;

/**
 * A uniqueness conflict surfaced by a write port.
 *
 * Raised ONLY by the implementation that observed SQLSTATE 23505 (or the SQLite equivalent),
 * before the driver error can cross the port boundary. Carries the violated constraint when the
 * backend reported one, because "which fact already exists" is usually the difference between
 * an idempotent no-op and a real conflict — and the idempotency-aware caller decides which.
 */
export class WriteConflictError extends Error {
	/** The violated constraint name, or null when the backend did not report one. */
	readonly constraint: string | null;

	constructor(message: string, options: { constraint?: string | null; cause?: unknown } = {}) {
		super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "WriteConflictError";
		this.constraint = options.constraint ?? null;
	}
}
