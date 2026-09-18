/**
 * Counterexamples for a FALSE claim that `transaction-atomicity-contract.test.ts` once made.
 *
 * That file asserted, in prose, that a wrapper typed `transaction<T>(work: (tx: Q) => T): T`
 * "cannot accept an async function — tsgo rejects it", and therefore that the type system
 * enforced the synchronous-atomic-section contract at every call site. It does not. Two ordinary
 * TypeScript rules defeat it, and a claim about the compiler must be settled by the compiler:
 *
 *   1. `=> T` is a type PARAMETER. An async callback infers `T = Promise<…>`; there is no
 *      conflict to report.
 *   2. `=> void` accepts a function with ANY return type. This is deliberate — it is what makes
 *      `arr.forEach(async …)` and other return-ignoring callback positions compile.
 *
 * Everything below therefore type-checks CLEANLY under `strict`, which is exactly the point: each
 * assignment is an async callback reaching a "synchronous-looking" transaction parameter. If a
 * future TypeScript version starts rejecting any of these, this file stops compiling and the gate's
 * documented reasoning gets revisited deliberately instead of silently becoming true by accident.
 *
 * Scope is deliberately minimal: local declarations only, no import from the real modules, no
 * runtime behavior, nothing exported that anything can call. It is compiled by `tsgo --noEmit`
 * along with the rest of the repo, and read by
 * `transaction-atomicity-contract.test.ts` (which asserts the counterexamples are present).
 */

/** Stands in for a Drizzle transaction handle. */
interface ProbeTx {
	run(): void;
}

/** The production wrapper shape: a generic, synchronous-looking passthrough. */
interface ProbeDb {
	transaction<T>(work: (tx: ProbeTx) => T): T;
}

declare const probeDb: ProbeDb;

async function probeAsyncCallback(tx: ProbeTx): Promise<string> {
	await Promise.resolve();
	tx.run();
	return "not synchronous";
}

// CLAIM 1 — `(tx: Q) => T` rejects async callbacks. FALSE: T is inferred as Promise<string>.
const inferredAsPromise: Promise<string> = probeDb.transaction(probeAsyncCallback);

// The same hole through a wrapper that only forwards, which is the production shape.
function probeGenericForwarder<T>(work: (tx: ProbeTx) => T): T {
	return probeDb.transaction(work);
}
const forwardedAsPromise: Promise<string> = probeGenericForwarder(probeAsyncCallback);

// CLAIM 2 — `=> void` rejects async callbacks. FALSE: void accepts any return type.
declare function probeVoidParameter(work: (tx: ProbeTx) => void): void;
probeVoidParameter(probeAsyncCallback);

// An inline async arrow is equally accepted in both positions.
const inlineInferredAsPromise: Promise<void> = probeGenericForwarder(async (tx: ProbeTx) => {
	await Promise.resolve();
	tx.run();
});

// Referenced so nothing above is dead code an unused-symbol rule might delete.
export type ProbeEvidence = {
	inferredAsPromise: typeof inferredAsPromise;
	forwardedAsPromise: typeof forwardedAsPromise;
	inlineInferredAsPromise: typeof inlineInferredAsPromise;
};
