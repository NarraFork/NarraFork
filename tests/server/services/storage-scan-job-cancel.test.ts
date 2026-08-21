/**
 * The storage scan job's cancel → rescan sequence.
 *
 * `abort()` only raises a flag: the scan notices it at its next checkpoint, so for a
 * moment afterwards the job is still `running`. Two things went wrong with that:
 *
 *   1. `cancelStorageScan()` returned the still-`running` state, so the HTTP response
 *      reported the exact status the caller had just cancelled;
 *   2. an immediate Rescan hit the "one job slot" dedupe (`running && abortController`)
 *      and was refused, so the button did nothing until clicked a second time. The
 *      job self-healed, which is precisely why nobody would have filed it as a bug.
 *
 * These drive the real module (the scan generator is mocked so a checkpoint can be
 * held open deliberately) and assert on the state a client would actually receive.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

/** Resolvers for the pending `next()` of the fake scan generator. */
let releaseStep: (() => void) | null = null;
/** How many times a scan generator has been started. */
let scanStarts = 0;

class FakeAbortedError extends Error {}

function fakeScanStorage(options: { signal?: AbortSignal } = {}) {
	scanStarts++;
	const { signal } = options;
	return (async function* () {
		for (;;) {
			// One checkpoint per step, held until the test releases it — this is the
			// window in which a cancel is requested but has not yet landed.
			await new Promise<void>((resolve) => {
				releaseStep = resolve;
			});
			if (signal?.aborted) throw new FakeAbortedError();
			yield { type: "progress" as const, message: "step" };
		}
	})();
}

mock.module("@server/services/storage-service", () => ({
	scanStorage: fakeScanStorage,
	StorageScanAbortedError: FakeAbortedError,
	storageService: {},
}));
mock.module("../../../server/services/storage-service", () => ({
	scanStorage: fakeScanStorage,
	StorageScanAbortedError: FakeAbortedError,
	storageService: {},
}));

const { cancelStorageScan, getStorageScanJob, startStorageScan } = await import(
	"../../../server/services/storage-scan-job"
);

/** Let the scan reach its next checkpoint. */
async function step() {
	for (let i = 0; i < 5 && !releaseStep; i++) await Promise.resolve();
	releaseStep?.();
	releaseStep = null;
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(async () => {
	// Drain any job left running by a previous case, so the slot starts free.
	if (getStorageScanJob().status === "running") {
		const done = cancelStorageScan();
		await step();
		await done;
	}
	scanStarts = 0;
});

describe("storage scan job — cancel settles before it answers", () => {
	it("returns a TERMINAL state, not the running one it just aborted", async () => {
		startStorageScan();
		await step();
		expect(getStorageScanJob().status).toBe("running");

		const pending = cancelStorageScan();
		// Still running at this instant: abort() has only set the flag.
		expect(getStorageScanJob().status).toBe("running");
		await step(); // the scan observes the abort here
		const state = await pending;
		expect(state.status).toBe("cancelled");
		// And the state a poller reads agrees with what cancel reported.
		expect(getStorageScanJob().status).toBe("cancelled");
	});

	it("starts a NEW scan immediately after a cancel, before the old one has landed", async () => {
		startStorageScan();
		await step();
		expect(scanStarts).toBe(1);

		// Cancel and do NOT wait: this is the "click Cancel, click Rescan" sequence,
		// where the outgoing scan is still sitting on its checkpoint.
		void cancelStorageScan();
		const second = startStorageScan();
		expect(second.started).toBe(true);
		expect(scanStarts).toBe(2);
		expect(getStorageScanJob().status).toBe("running");
	});

	it("does not let the cancelled scan overwrite the replacement's state", async () => {
		startStorageScan();
		await step();
		void cancelStorageScan();
		startStorageScan();
		// Release the OLD generator's checkpoint: it throws its abort here and would,
		// unguarded, publish `cancelled` over the new job's `running`.
		await step();
		await step();
		expect(getStorageScanJob().status).toBe("running");
	});

	it("still dedupes a plain double-start (no cancel involved)", async () => {
		startStorageScan();
		await step();
		const again = startStorageScan();
		expect(again.started).toBe(false);
		expect(scanStarts).toBe(1);
	});

	it("is a no-op when nothing is running", async () => {
		const state = await cancelStorageScan();
		expect(state.status).not.toBe("running");
		expect(scanStarts).toBe(0);
	});
});
