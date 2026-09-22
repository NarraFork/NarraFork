/**
 * tool-shimmer.test.ts — the shimmer RULE, pinned where all four render surfaces
 * read it from.
 *
 * The bug that motivated this module: a reflection gate parks its tool call at
 * `pending`, and every in-flight check in the codebase reads `pending` as
 * "running" — so a card that was deliberating about a risky operation animated
 * BLUE, claiming work was under way while nothing was executing. The precedence
 * tests below are the guard against that returning.
 *
 * A second conflation this suite pins: `initializing` after `tool_started` used to
 * always map to the neutral streaming sweep, even when an earlier call in the same
 * turn still owned the slot. That state is now `queued`.
 */

import { describe, expect, it } from "bun:test";
import { IN_FLIGHT_TOOL_ROW_STATUSES } from "../tool-row-status";
import {
	CARD_SHIMMER_CLASS,
	isToolQueuedBehindUpstream,
	resolveToolShimmerFlash,
	resolveToolShimmerOutcome,
	resolveToolShimmerPhase,
	TOOL_SHIMMER_PHASE_SETS,
	type ToolUpstreamPeer,
	TRACE_SHIMMER_CLASS,
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
		//
		// Without `earlierTools`, initializing stays neutral: the surface cannot see
		// siblings, so it must not invent a queue.
		expect(resolveToolShimmerPhase({ status: "initializing" })).toBe("streaming");
		expect(resolveToolShimmerPhase({ status: "initializing", earlierTools: [] })).toBe("streaming");
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
		// Even with an earlier running sibling, a call awaiting the person stays silent.
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				hasPendingPermission: true,
				earlierTools: [{ status: "running" }],
			}),
		).toBeNull();
	});

	it("reserves BLUE for a status that actually means executing", () => {
		expect(resolveToolShimmerPhase({ status: "running" })).toBe("running");
		// Parallel siblings running is not "this call is queued" — this call is already
		// executing too.
		expect(
			resolveToolShimmerPhase({
				status: "running",
				earlierTools: [{ status: "running" }],
			}),
		).toBe("running");
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
			// Even with an earlier running sibling, a settled call must not animate.
			expect(
				resolveToolShimmerPhase({
					status,
					earlierTools: [{ status: "running" }],
				}),
			).toBeNull();
		}
		expect(resolveToolShimmerPhase({})).toBeNull();
	});
});

describe("resolveToolShimmerPhase — queued behind an earlier same-turn call", () => {
	const blockingPeers: ToolUpstreamPeer[][] = [
		[{ status: "running" }],
		[{ status: "pending" }],
		[{ status: "initializing" }],
		[{ isStreaming: true }],
		[{ reflectionStatus: "running" }],
		[{ hasPendingPermission: true }],
		[{ status: "success" }, { status: "running" }],
	];

	it("maps initializing behind a live earlier call to QUEUED, not streaming", () => {
		for (const earlierTools of blockingPeers) {
			expect(resolveToolShimmerPhase({ status: "initializing", earlierTools })).toBe("queued");
		}
	});

	it("queues behind a permission-gated earlier call even when tool names are known", () => {
		// Regression: the first tool sitting on an approve/deny (or a running danger
		// reflection) must park EVERY later non-started call — including when peers
		// carry names and the parallel-group check runs. Default Bash is serial and
		// Edit is not parallel-safe, so they are NOT concurrent.
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				toolName: "Edit",
				input: { file_path: "a.ts", old_string: "a", new_string: "b" },
				earlierTools: [
					{
						status: "pending",
						toolName: "Bash",
						input: { command: "rm -f x" },
						reflectionStatus: "running",
					},
				],
			}),
		).toBe("queued");
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				toolName: "Edit",
				input: {},
				earlierTools: [
					{
						status: "pending",
						toolName: "Bash",
						input: {},
						hasPendingPermission: true,
					},
				],
			}),
		).toBe("queued");
	});

	it("does NOT queue a same-group parallel sibling that is merely initializing", () => {
		// Two Reads start together; the second is not "parked behind" the first.
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				toolName: "Read",
				input: { file_path: "b.ts" },
				earlierTools: [{ status: "running", toolName: "Read", input: { file_path: "a.ts" } }],
			}),
		).toBe("streaming");
	});

	it("honours a precomputed queuedBehindUpstream when no peer list is available", () => {
		expect(resolveToolShimmerPhase({ status: "initializing", queuedBehindUpstream: true })).toBe(
			"queued",
		);
		expect(resolveToolShimmerPhase({ status: "initializing", queuedBehindUpstream: false })).toBe(
			"streaming",
		);
	});

	it("keeps initializing NEUTRAL when earlier calls are settled or absent", () => {
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				earlierTools: [{ status: "success" }, { status: "fail" }],
			}),
		).toBe("streaming");
	});

	it("prefers STREAMING over queued while this call's arguments are still arriving", () => {
		// Arguments arriving is the more current fact for THIS call — even if an
		// earlier sibling is also live. Otherwise a model writing tool #2's input
		// would paint #2 as parked.
		expect(
			resolveToolShimmerPhase({
				isStreaming: true,
				status: "initializing",
				earlierTools: [{ status: "running" }],
			}),
		).toBe("streaming");
		expect(
			resolveToolShimmerPhase({
				status: "streaming",
				earlierTools: [{ status: "running" }],
			}),
		).toBe("streaming");
	});

	it("lets a live reflection outrank queued even with an earlier runner", () => {
		expect(
			resolveToolShimmerPhase({
				status: "initializing",
				reflectionStatus: "running",
				earlierTools: [{ status: "running" }],
			}),
		).toBe("reflecting");
	});

	it("exposes matching class names for the queued phase", () => {
		expect(CARD_SHIMMER_CLASS.queued).toBe("nf-card-shimmer--queued");
		expect(TRACE_SHIMMER_CLASS.queued).toBe("nf-trace-shimmer--queued");
	});
});

describe("isToolQueuedBehindUpstream — pure detector", () => {
	it("is true only for initializing with a live earlier sibling", () => {
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				earlierTools: [{ status: "running" }],
			}),
		).toBe(true);
		expect(isToolQueuedBehindUpstream({ status: "initializing" })).toBe(false);
		expect(
			isToolQueuedBehindUpstream({
				status: "running",
				earlierTools: [{ status: "running" }],
			}),
		).toBe(false);
		expect(
			isToolQueuedBehindUpstream({
				status: "pending",
				earlierTools: [{ status: "running" }],
			}),
		).toBe(false);
	});
});

/**
 * The approximation this suite pins down: a live earlier sibling is NOT by itself
 * evidence of queueing. The loop runs one parallel GROUP at a time, so two
 * parallel-safe calls next to each other START TOGETHER — the later one is
 * concurrent, not parked. Both cases look the same on the wire (`initializing`
 * beside `running`), and only the grouping rule separates them.
 */
describe("isToolQueuedBehindUpstream — same parallel group is concurrency, not a queue", () => {
	const running = (toolName: string, input: Record<string, unknown> = {}) => ({
		status: "running",
		toolName,
		input,
	});

	it("does NOT park a call that shares its group with the running sibling", () => {
		// Read + Read are both parallel-safe and adjacent → one group → concurrent.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Read",
				input: {},
				earlierTools: [running("Read")],
			}),
		).toBe(false);
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Grep",
				input: {},
				earlierTools: [running("Glob")],
			}),
		).toBe(false);
	});

	it("parks a call behind a SERIAL tool", () => {
		// Default Bash is a serial barrier, so the next call waits for it.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Read",
				input: {},
				earlierTools: [running("Bash", { command: "sleep 5" })],
			}),
		).toBe(true);
	});

	it("parks a serial call behind a running parallel group", () => {
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Bash",
				input: { command: "ls" },
				earlierTools: [running("Read")],
			}),
		).toBe(true);
	});

	it("treats an opted-in parallel Bash as a group member", () => {
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Bash",
				input: { command: "ls", parallel: true },
				earlierTools: [running("Read")],
			}),
		).toBe(false);
		// strict_serial always wins over the opt-in.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Bash",
				input: { command: "ls", parallel: true, strict_serial: true },
				earlierTools: [running("Read")],
			}),
		).toBe(true);
	});

	it("respects the Agent → Await barrier", () => {
		// Await after an Agent opens a new group so the spawned child is observable.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Await",
				input: {},
				earlierTools: [running("Agent")],
			}),
		).toBe(true);
		// Agent + Agent stays parallel.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Agent",
				input: {},
				earlierTools: [running("Agent")],
			}),
		).toBe(false);
	});

	it("parks when a serial barrier sits BETWEEN the runner and this call", () => {
		// Read(running) · Bash(settled serial) · Read(judged): the Bash splits the groups,
		// so the last Read cannot be starting with the first.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Read",
				input: {},
				earlierTools: [
					running("Read"),
					{ status: "success", toolName: "Bash", input: { command: "ls" } },
				],
			}),
		).toBe(true);
	});

	it("ignores settled peers BEFORE the blocking one when judging the group", () => {
		// A settled Bash ahead of the runner is history; it must not split a group that
		// starts at the runner.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				toolName: "Read",
				input: {},
				earlierTools: [
					{ status: "success", toolName: "Bash", input: { command: "ls" } },
					running("Read"),
				],
			}),
		).toBe(false);
	});

	it("falls back to the coarse answer when tool names are absent", () => {
		// A caller that cannot supply names gets the conservative result: showing a wait
		// that may not exist is better than hiding one that does.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				earlierTools: [{ status: "running" }],
			}),
		).toBe(true);
		// Partial data (peer named, judged call not) is still incomplete.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				earlierTools: [running("Read")],
			}),
		).toBe(true);
	});
});

describe("isToolQueuedBehindUpstream — pre-computed verdict", () => {
	it("accepts the adapter's boolean when no peers are visible", () => {
		expect(isToolQueuedBehindUpstream({ status: "initializing", queuedBehindUpstream: true })).toBe(
			true,
		);
		expect(
			isToolQueuedBehindUpstream({ status: "initializing", queuedBehindUpstream: false }),
		).toBe(false);
	});

	it("still applies this call's own gates to a stale verdict", () => {
		// A verdict computed one frame ago must not outrank what this call is doing now.
		for (const override of [
			{ hasPendingPermission: true },
			{ reflectionStatus: "running" },
			{ isStreaming: true },
			{ status: "running" },
			{ status: "pending" },
			{ status: "success" },
		]) {
			expect(
				isToolQueuedBehindUpstream({
					status: "initializing",
					queuedBehindUpstream: true,
					...override,
				}),
			).toBe(false);
		}
	});

	it("lets real peers win over the pre-computed boolean", () => {
		// Peers are the more precise input: a `false` verdict cannot suppress a real queue.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				queuedBehindUpstream: false,
				toolName: "Read",
				input: {},
				earlierTools: [{ status: "running", toolName: "Bash", input: { command: "ls" } }],
			}),
		).toBe(true);
		// ...and a `true` verdict cannot invent one.
		expect(
			isToolQueuedBehindUpstream({
				status: "initializing",
				queuedBehindUpstream: true,
				toolName: "Read",
				input: {},
				earlierTools: [{ status: "running", toolName: "Read", input: {} }],
			}),
		).toBe(false);
	});
});

describe("resolveToolShimmerFlash — one-shot closing sweep", () => {
	it("flashes green on in-flight → success", () => {
		expect(resolveToolShimmerFlash("running", "success")).toBe("success");
		expect(resolveToolShimmerFlash("pending", "completed")).toBe("success");
		expect(resolveToolShimmerFlash("streaming", "success")).toBe("success");
		expect(resolveToolShimmerFlash("initializing", "success")).toBe("success");
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
