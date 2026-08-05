/**
 * reflection-update-gate-deadlock.test.ts — a reflection loop's provider request
 * must never be parked behind the update gate.
 *
 * THE DEADLOCK
 *
 * A gate (danger / plan / task) runs INSIDE tool admission: the parent loop already
 * holds a `startGrant` from `preAdmitToolExecution` when the reflection sub-loop
 * starts, and the parent's own `responseActivity` is still open. Both are exactly
 * what `checkpointFenceIsStable()` waits for.
 *
 * So when an update reaches `quiescing_tools`:
 *   - the fence cannot become stable, because the paused tool still holds its grant
 *     and the parent response lease;
 *   - the reflection's request calls `beginNarratorResponseActivity`, sees phase two
 *     and parks in `waitUntilUpdateGateOpens`;
 *   - the gate only opens on failure/cancellation, which is what the fence wait is
 *     blocking on.
 *
 * Both waits are deliberately unbounded (see `cancelScheduledUpdate`), so the tool
 * row stays `pending`/`running` forever with a "still reflecting" card, and the
 * update never proceeds. Reported symptom: a danger reflection counting past 14h
 * that also blocked the scheduled update.
 *
 * THE INVARIANT
 *
 * A reflection request is not new work the fence needs to exclude — its tool row
 * already exists and is already inside the fence via the grant it runs under. It
 * must therefore be admitted immediately in any phase.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	beginNarratorResponseActivity,
	beginQuiescingTools,
	beginToolStartAdmission,
	checkpointFenceIsStableForTests,
	resetUpdateCoordinationForTests,
	scheduleUpdate,
} from "../update-coordinator";

/** Resolve/reject race helper: did `promise` settle within a macrotask? */
async function settledQuickly(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol("pending");
	const result = await Promise.race([
		promise.then(
			() => "settled",
			() => "settled",
		),
		new Promise((resolve) => setTimeout(() => resolve(marker), 20)),
	]);
	return result !== marker;
}

describe("reflection requests versus the update checkpoint fence", () => {
	beforeEach(() => {
		resetUpdateCoordinationForTests();
	});

	afterEach(() => {
		resetUpdateCoordinationForTests();
	});

	test("a reflection request is admitted while the fence is closed", async () => {
		// The parent tool is mid-admission: this grant is the fence blocker that a
		// paused gate holds for as long as it deliberates.
		const admission = beginToolStartAdmission("ordinary", "narrator-gate", "tool-use-gate");
		expect(admission.status).toBe("granted");
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		expect(checkpointFenceIsStableForTests()).toBe(false);

		const reflectionLease = beginNarratorResponseActivity("narrator-gate", undefined, {
			isReflection: true,
		});
		expect(await settledQuickly(reflectionLease)).toBe(true);
		(await reflectionLease).release();
	});

	test("an ordinary request is still held back by phase two", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();

		const ordinaryLease = beginNarratorResponseActivity("narrator-ordinary");
		// The existing quiescing guarantee must not regress: only reflections bypass it.
		expect(await settledQuickly(ordinaryLease)).toBe(false);
	});

	test("a reflection lease does not itself reopen the fence", async () => {
		scheduleUpdate("9.9.9");
		beginQuiescingTools();
		expect(checkpointFenceIsStableForTests()).toBe(true);

		const lease = await beginNarratorResponseActivity("narrator-gate", undefined, {
			isReflection: true,
		});
		// A reflection is inside the fence via its parent grant, so it must not be
		// counted a second time — otherwise it would block the checkpoint it just
		// bypassed, recreating the deadlock from the other side.
		expect(checkpointFenceIsStableForTests()).toBe(true);
		lease.release();
	});
});
