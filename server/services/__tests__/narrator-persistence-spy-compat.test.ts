/**
 * The `narratorPersistence` export must stay spyOn-replaceable.
 *
 * The PG partial-migration guard around its methods was once a get-trap Proxy, and
 * bun's `spyOn` does not penetrate ANY Proxy — not even a trapless forwarding one
 * (empirically: no set/defineProperty trap is ever invoked; the replacement is
 * silently dropped and calls keep reaching the real implementation). Four
 * subagent-resume/revert-admission tests failed that way. The guard is therefore
 * built as plain own-property wrapper functions; this suite is the regression
 * contract for that shape: spy replacement AND restore both work, and the
 * fail-closed PG guard still fires for methods outside the ported set.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import type { NarratorMessageRefsPort } from "../narrator-refs/port";
import { bindNarratorMessageRefs } from "../narrator-refs/store";

// narrator-service must be imported before narrator-persistence: the two form a
// module-init cycle and narrator-service binds persistence methods at evaluation.
await import("../narrator-service");
const { narratorPersistence } = await import("../narrator-persistence");

afterEach(() => {
	bindNarratorMessageRefs(undefined);
});

test("spyOn replaces, observes and restores a guarded method", async () => {
	const spy = spyOn(narratorPersistence, "isMessageSharedByMultipleNarrators").mockImplementation(
		async () => true,
	);
	expect(await narratorPersistence.isMessageSharedByMultipleNarrators("any")).toBe(true);
	expect(spy).toHaveBeenCalledWith("any");
	spy.mockRestore();
	// The restored method is the real, still-guarded implementation again.
	expect(await narratorPersistence.isMessageSharedByMultipleNarrators("missing-message")).toBe(
		false,
	);
	// Property access is a stable own-property wrapper, not a per-read proxy.
	expect(narratorPersistence.isMessageSharedByMultipleNarrators).toBe(
		narratorPersistence.isMessageSharedByMultipleNarrators,
	);
});

test("unported methods still fail closed once the PG port is bound", async () => {
	const unavailable = (): Promise<never> => Promise.reject(new Error("unused fixture"));
	const port: NarratorMessageRefsPort = {
		append: unavailable,
		insertBefore: unavailable,
		copyRefs: unavailable,
		page: unavailable,
		creator: unavailable,
	};
	bindNarratorMessageRefs({ backend: "postgres", port });
	await expect(narratorPersistence.isMessageSharedByMultipleNarrators("any")).rejects.toThrow(
		"unavailable",
	);
});
