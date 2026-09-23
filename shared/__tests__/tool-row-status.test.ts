/**
 * tool-row-status.test.ts — WHICH mark a compact row draws, and the guarantee that
 * it cannot contradict the shimmer painted on the same row.
 *
 * THE BUG THIS PINS. A folded trace row resolved its 12px glyph from `status` alone,
 * so a call sitting at `initializing` while an earlier sibling held the execution
 * slot drew a spinning blue loader — directly beside shimmer text reading "waiting
 * for earlier tools". One row, two answers: the shimmer received
 * `queuedBehindUpstream` and the glyph structurally could not see it.
 *
 * The consistency block at the bottom is the load-bearing part. `tool-shimmer`
 * imports from this module, so this module cannot import it back to derive the
 * answer (that is a cycle). The two rules therefore stay aligned by TEST, the same
 * device `TOOL_SHIMMER_PHASE_SETS` uses for its partition claim — and unlike an
 * eyeballed agreement, this fails when one side moves.
 */

import { describe, expect, it } from "bun:test";
import { resolveToolRowStatusMark, type ToolRowStatusMark } from "../tool-row-status";
import { resolveToolShimmerPhase } from "../tool-shimmer";

describe("resolveToolRowStatusMark — in-flight is not one state", () => {
	it("marks a call queued behind an upstream sibling as QUEUED, not running", () => {
		// The reported bug, in one assertion. `initializing` + a held slot means the
		// call has not executed for a single millisecond; a spinner claims it has.
		expect(resolveToolRowStatusMark("initializing", { queuedBehindUpstream: true })).toBe("queued");
		expect(resolveToolRowStatusMark("streaming", { queuedBehindUpstream: true })).toBe("queued");
	});

	it("keeps a plain in-flight call RUNNING when nothing says it is parked", () => {
		// The no-regression half: without the context (or with an explicit false) the
		// historical answer stands, so every row that was correct stays correct.
		expect(resolveToolRowStatusMark("initializing")).toBe("running");
		expect(resolveToolRowStatusMark("initializing", { queuedBehindUpstream: false })).toBe(
			"running",
		);
		expect(resolveToolRowStatusMark("running", { queuedBehindUpstream: true })).toBe("running");
	});

	it("marks a call waiting on a PERSON as awaiting, not running", () => {
		// `pending` accompanies a `permissionStartedAt` stamp at every write site: it
		// always means a human is being waited on. A spinner there animates the
		// reader's own inaction back at them.
		expect(resolveToolRowStatusMark("pending")).toBe("awaiting");
	});

	it("lets a live reflection gate outrank the tool's own status", () => {
		// A gate parks its tool at `pending`, but it can also be observed while the
		// tool still reads `running` — the gate is the more current fact either way.
		expect(resolveToolRowStatusMark("pending", { reflectionStatus: "running" })).toBe("awaiting");
		expect(resolveToolRowStatusMark("running", { reflectionStatus: "running" })).toBe("awaiting");
	});

	it("does not treat a RESOLVED gate as awaiting", () => {
		// Only `running` is a live gate; a settled one has handed control back, so the
		// tool's own status decides again.
		for (const reflectionStatus of ["confirmed", "cancelled", "aborted", "awaiting_user"]) {
			expect(resolveToolRowStatusMark("running", { reflectionStatus })).toBe("running");
		}
	});
});

describe("resolveToolRowStatusMark — the unmarked cases survive", () => {
	it("leaves success bare, with or without a context", () => {
		// A column of green checks is the noise this module exists to avoid.
		for (const status of ["success", "completed"]) {
			expect(resolveToolRowStatusMark(status)).toBeNull();
			expect(resolveToolRowStatusMark(status, { queuedBehindUpstream: true })).toBeNull();
		}
	});

	it("withholds a mark for an empty or unrecognised status", () => {
		// Drawing nothing admits we do not know; a spinner would claim a finished call
		// is still running, forever.
		for (const status of [null, undefined, "", "somethingNew"]) {
			expect(resolveToolRowStatusMark(status)).toBeNull();
			expect(resolveToolRowStatusMark(status, { queuedBehindUpstream: true })).toBeNull();
		}
	});

	it("still reports the two terminal deviations", () => {
		for (const status of ["fail", "failed", "error", "timeout"]) {
			expect(resolveToolRowStatusMark(status)).toBe("failed");
		}
		for (const status of ["cancelled", "canceled", "aborted", "denied"]) {
			expect(resolveToolRowStatusMark(status)).toBe("cancelled");
		}
	});
});

describe("the mark and the shimmer cannot contradict each other", () => {
	/**
	 * The only mark that MOVES. A spinner is the strongest activity signal a 12px
	 * slot has; the other four marks are static by design.
	 */
	const SPINNING_MARKS: ReadonlySet<ToolRowStatusMark> = new Set(["running"]);

	/**
	 * Shimmer outcomes that say "this call is NOT moving".
	 *
	 * `queued` paints a parked pulse rather than a travelling highlight, and `null`
	 * (which `pending` produces) paints nothing at all — both deliberate statements
	 * that no work is under way. The looping phases (`streaming`, `reflecting`,
	 * `running`) are the moving ones.
	 */
	function shimmerSaysParked(input: Parameters<typeof resolveToolShimmerPhase>[0]): boolean {
		const phase = resolveToolShimmerPhase(input);
		return phase === null || phase === "queued";
	}

	// Every in-flight shape the render layer can hand both rules: one status plus the
	// two context facts.
	const CASES = [
		{ status: "initializing", queuedBehindUpstream: true },
		{ status: "streaming", queuedBehindUpstream: true },
		{ status: "initializing", queuedBehindUpstream: false },
		{ status: "running", queuedBehindUpstream: false },
		{ status: "pending", queuedBehindUpstream: false },
		{ status: "pending", queuedBehindUpstream: true },
		{ status: "pending", reflectionStatus: "running" },
		{ status: "running", reflectionStatus: "running" },
		{ status: "streaming", queuedBehindUpstream: false },
		{ status: "initializing", reflectionStatus: null },
	] as const;

	it("never spins a glyph on a row whose shimmer says the call is parked", () => {
		// The exact shape of the shipped bug, as an invariant rather than one example:
		// a row must not animate a spinner while the light beside it reports waiting.
		//
		// ONE-DIRECTIONAL on purpose. The reverse pairing is legitimate and in use: a
		// deliberating gate draws a static pause glyph beside a MOVING purple sweep,
		// because the gate is working while the tool is parked. The two rules also
		// differ in granularity — the glyph has a single spinner for every
		// executing-or-arriving state, where shimmer separates neutral streaming from
		// blue running. Requiring symmetry would force one of those distinctions away.
		for (const input of CASES) {
			const mark = resolveToolRowStatusMark(input.status, input);
			const spins = mark != null && SPINNING_MARKS.has(mark);
			expect({ ...input, spinsWhileParked: spins && shimmerSaysParked(input) }).toEqual({
				...input,
				spinsWhileParked: false,
			});
		}
	});

	it("agrees specifically on QUEUED — the case that shipped broken", () => {
		const input = { status: "initializing", queuedBehindUpstream: true } as const;
		expect(resolveToolRowStatusMark(input.status, input)).toBe("queued");
		expect(resolveToolShimmerPhase(input)).toBe("queued");
	});

	it("agrees that a deliberating gate is not executing", () => {
		const input = { status: "pending", reflectionStatus: "running" } as const;
		expect(resolveToolRowStatusMark(input.status, input)).toBe("awaiting");
		expect(resolveToolShimmerPhase(input)).toBe("reflecting");
	});
});
