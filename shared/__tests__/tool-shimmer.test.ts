/**
 * tool-shimmer.test.ts — the shimmer RULE, pinned where all four render surfaces
 * read it from.
 *
 * The bug that motivated this module: a reflection gate parks its tool call at
 * `pending`, and every in-flight check in the codebase reads `pending` as
 * "running" — so a card that was deliberating about a risky operation animated
 * BLUE, claiming work was under way while nothing was executing. The precedence
 * tests below are the guard against that returning.
 */

import { describe, expect, it } from "bun:test";
import { IN_FLIGHT_TOOL_ROW_STATUSES } from "../tool-row-status";
import {
	resolveToolShimmerFlash,
	resolveToolShimmerOutcome,
	resolveToolShimmerPhase,
	TOOL_SHIMMER_PHASE_SETS,
} from "../tool-shimmer";

describe("resolveToolShimmerPhase — looping shimmer precedence", () => {
	it("paints a running reflection PURPLE even though its tool sits at pending", () => {
		// The whole reason this module exists. `pending` is what a gate writes
		// (narrator-permission.ts / task-reflection.ts), and it is also an in-flight
		// status — so without the reflection check first this returns "running".
		expect(resolveToolShimmerPhase({ status: "pending", reflectionStatus: "running" })).toBe(
			"reflecting",
		);
	});

	it("lets reflection outrank an explicitly streaming call too", () => {
		// Ordering must be total, not just "reflection beats pending": a gate on a
		// call whose input is still arriving is still deliberating.
		expect(
			resolveToolShimmerPhase({
				isStreaming: true,
				status: "running",
				reflectionStatus: "running",
			}),
		).toBe("reflecting");
	});

	it("does not treat a RESOLVED reflection as reflecting", () => {
		// Only `running` is a live gate. A confirmed/cancelled gate has handed control
		// back, so the tool's own status decides the colour again.
		for (const reflectionStatus of ["confirmed", "cancelled", "aborted", "awaiting_user"]) {
			expect(resolveToolShimmerPhase({ status: "running", reflectionStatus })).toBe("running");
		}
	});

	it("prefers streaming over running when the input is still arriving", () => {
		// A synthetic streaming row's persisted status lags its live input, so the
		// explicit flag is the more current fact.
		expect(resolveToolShimmerPhase({ isStreaming: true, status: "running" })).toBe("streaming");
	});

	it("reads a bare `streaming` status as streaming without the flag", () => {
		// `tool_use_chunk` labels a call `streaming` on the wire; a surface that only
		// has the status (a folded row) must still get the neutral sweep.
		expect(resolveToolShimmerPhase({ status: "streaming" })).toBe("streaming");
	});

	it("keeps `initializing` NEUTRAL — arguments parsed is not execution started", () => {
		// The most visible bug this chain had. `tool_started` fires when the server
		// finishes PARSING the input; `executeTool` only then runs the permission gate,
		// which is what writes `running`. Treating the in-flight status as executing made
		// a card whose arguments had just landed — or one about to prompt for approval —
		// animate blue as though work were under way.
		expect(resolveToolShimmerPhase({ status: "initializing" })).toBe("streaming");
	});

	it("silences a call AWAITING THE USER, with or without the explicit flag", () => {
		// `pending` means "a person is being waited on" at every write site in
		// narrator-permission.ts / task-reflection.ts (each one stamps
		// `permissionStartedAt` or an `awaiting_user` reflection). It is never "queued".
		//
		// Both forms matter: a full card is told via `hasPendingPermission` from the live
		// permission list, but a FOLDED ROW only ever has the status — so deriving the
		// silence from `pending` itself is what fixes the row.
		expect(resolveToolShimmerPhase({ status: "pending" })).toBeNull();
		expect(resolveToolShimmerPhase({ status: "pending", hasPendingPermission: true })).toBeNull();
		// The flag also wins over a status that would otherwise sweep: a live request can
		// be observed before the row's own status has been re-read.
		expect(resolveToolShimmerPhase({ status: "running", hasPendingPermission: true })).toBeNull();
		expect(
			resolveToolShimmerPhase({ status: "initializing", hasPendingPermission: true }),
		).toBeNull();
		expect(resolveToolShimmerPhase({ isStreaming: true, hasPendingPermission: true })).toBeNull();
	});

	it("reserves BLUE for a status that actually means executing", () => {
		expect(resolveToolShimmerPhase({ status: "running" })).toBe("running");
	});

	it("classifies EVERY in-flight status, so no live call can go dark", () => {
		// The partition guard. `IN_FLIGHT_TOOL_ROW_STATUSES` is shared with the row-status
		// layer; if someone adds a status there and not to one of the two sets here, the
		// resolver would fall through to `null` and a genuinely live call would show no
		// shimmer at all — a silent regression a colour test cannot see.
		for (const status of IN_FLIGHT_TOOL_ROW_STATUSES) {
			const classified =
				TOOL_SHIMMER_PHASE_SETS.nonExecuting.has(status) ||
				TOOL_SHIMMER_PHASE_SETS.executing.has(status);
			expect(classified).toBe(true);
		}
		// And the two sets must not overlap — a status cannot be both.
		for (const status of TOOL_SHIMMER_PHASE_SETS.executing) {
			expect(TOOL_SHIMMER_PHASE_SETS.nonExecuting.has(status)).toBe(false);
		}
	});

	it("still reflects while a permission is pending", () => {
		// The gate's sweep must survive the permission suppression: a running gate parks
		// its tool at `pending` AND a live request can be observed at the same time.
		// Reflection is checked first precisely so this case stays purple rather than
		// falling silent.
		expect(
			resolveToolShimmerPhase({
				status: "pending",
				reflectionStatus: "running",
				hasPendingPermission: true,
			}),
		).toBe("reflecting");
	});

	it("gives a terminal or unknown status no looping shimmer", () => {
		for (const status of ["success", "completed", "fail", "cancelled", "somethingNew", "", null]) {
			expect(resolveToolShimmerPhase({ status })).toBeNull();
		}
		expect(resolveToolShimmerPhase({})).toBeNull();
	});
});

describe("resolveToolShimmerFlash — one-shot closing sweep", () => {
	it("flashes green on in-flight → success", () => {
		expect(resolveToolShimmerFlash("running", "success")).toBe("success");
		expect(resolveToolShimmerFlash("pending", "completed")).toBe("success");
		expect(resolveToolShimmerFlash("streaming", "success")).toBe("success");
	});

	it("flashes red on in-flight → failure", () => {
		for (const next of ["fail", "failed", "error", "timeout"]) {
			expect(resolveToolShimmerFlash("running", next)).toBe("failed");
		}
	});

	it("never flashes on a FRESH MOUNT (prev is null)", () => {
		// The invariant that keeps scrolling quiet. Virtual-list rows mount and unmount
		// constantly; treating a mount as "just finished" would flash the whole screen
		// green while merely scrolling through history.
		expect(resolveToolShimmerFlash(null, "success")).toBeNull();
		expect(resolveToolShimmerFlash(undefined, "fail")).toBeNull();
		expect(resolveToolShimmerFlash("", "success")).toBeNull();
	});

	it("does not replay when a terminal status is merely re-reported", () => {
		// A re-render carrying the same settled status is not a transition. Without the
		// in-flight check on `prev` the sweep would restart on every frame.
		expect(resolveToolShimmerFlash("success", "success")).toBeNull();
		expect(resolveToolShimmerFlash("fail", "fail")).toBeNull();
	});

	it("treats CANCELLATION as no flash at all", () => {
		// The user stopped it; that is not a failure to report back to them, and it
		// already has its own orange ban glyph.
		for (const next of ["cancelled", "canceled", "aborted", "denied"]) {
			expect(resolveToolShimmerFlash("running", next)).toBeNull();
		}
	});

	it("withholds a flash for an unrecognised outcome instead of guessing", () => {
		expect(resolveToolShimmerFlash("running", "somethingNew")).toBeNull();
		expect(resolveToolShimmerFlash("running", null)).toBeNull();
	});
});

describe("resolveToolShimmerOutcome — colour mapping without a transition", () => {
	it("maps outcomes for a surface with its own just-finished evidence", () => {
		// The chunk card proves "just finished" from `startedAt` + a 2s window rather
		// than from a transition, and must reuse THIS mapping instead of re-deriving it.
		expect(resolveToolShimmerOutcome("success")).toBe("success");
		expect(resolveToolShimmerOutcome("completed")).toBe("success");
		expect(resolveToolShimmerOutcome("error")).toBe("failed");
		expect(resolveToolShimmerOutcome("cancelled")).toBeNull();
		expect(resolveToolShimmerOutcome("running")).toBeNull();
		expect(resolveToolShimmerOutcome(null)).toBeNull();
	});
});
