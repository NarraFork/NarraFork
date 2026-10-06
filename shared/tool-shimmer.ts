/**
 * tool-shimmer.ts — WHICH shimmer a tool call shows, and why.
 *
 * A shimmer is the light that tells the reader, at a glance and without reading
 * any text, what a tool call is doing right now. There are six states:
 *
 *   neutral  streaming   the model is still writing the call's arguments
 *   orange   reflecting  a reflection gate is deliberating about this call
 *   blue     running     the call is executing
 *   slate    queued      arguments are ready, but an earlier call in the same
 *                        turn still owns the execution slot (NOT a sweep)
 *   green    success     it just finished (one-shot, reverse sweep)
 *   red      failed      it just failed (one-shot, reverse sweep)
 *
 * `pending` (awaiting a person) is a seventh case with NO shimmer at all: the
 * call is idle on an approve/deny form, and animating it would claim activity.
 *
 * FOUR render surfaces ask this module — the vlist tool card, the chunk tool card,
 * the vlist folded trace row and the chunk folded trace row. They cannot share
 * components (vlist must not import the chunk render path), so without one shared
 * rule they drift: that is exactly how "reflecting" ended up painted BLUE on both
 * cards, because a gate parks its tool at `pending` and `pending` reads as running.
 *
 * Pure + framework-free. It returns a PHASE or a FLASH kind, and each surface maps
 * that to its own class table — the two families are visually different by design
 * (a card tints its background, a folded row tints its own text), so sharing the
 * decision is the most that can be shared.
 *
 * ── WHY CANCELLED GETS NO RED FLASH ───────────────────────────────────────────
 * Cancellation is the user's own doing, not a failure to report back to them, and
 * it already carries a distinct orange ban glyph. A red flash would claim
 * something went wrong with an action they deliberately stopped.
 *
 * ── WHY QUEUED IS NOT A SWEEP ─────────────────────────────────────────────────
 * Streaming and running both move; a queued call has not started. The shared layer
 * only names the state; each stylesheet paints it as a parked slate mark rather
 * than a travelling highlight, so the motion itself carries the distinction.
 */

import { sharesParallelGroup, type ToolExecutionGroupItem } from "./tool-parallel-groups";
import { IN_FLIGHT_TOOL_ROW_STATUSES } from "./tool-row-status";

/**
 * A looping (or parked) in-flight presentation.
 *
 * `queued` is the only non-sweep phase: parameters are complete, but an earlier
 * call in the same assistant turn still owns the execution slot.
 */
export type ToolShimmerPhase = "streaming" | "reflecting" | "running" | "queued";

/** A one-shot closing sweep, played once as the call reaches a terminal state. */
export type ToolShimmerFlash = "success" | "failed";

/**
 * Leaving `queued`: a short fade-out of the parked slate mark.
 *
 * Not a phase (the call is no longer queued) and not an outcome flash. Cutting
 * the pulse keyframes mid-cycle snaps opacity to whatever the next rule
 * declares; this one-shot lets the wash finish dissolving before the next
 * phase's sweep starts. Render hooks hold it for
 * {@link TOOL_SHIMMER_QUEUED_EXIT_MS} after an observed queued → non-queued
 * transition.
 */
export type ToolShimmerQueuedExit = "queued_out";

/** Every shimmer a surface may need a class for. */
export type ToolShimmerKind = ToolShimmerPhase | ToolShimmerFlash | ToolShimmerQueuedExit;

/**
 * Statuses whose outcome is a FAILURE worth flashing red.
 *
 * A subset of the terminal set on purpose: `cancelled` / `aborted` / `denied` are
 * terminal but not failures (see the file header), and `success` / `completed` are
 * the green case below.
 */
const FAILED_TOOL_STATUSES: ReadonlySet<string> = new Set(["fail", "failed", "error", "timeout"]);

/** Statuses that mean the call finished as intended. */
const SUCCEEDED_TOOL_STATUSES: ReadonlySet<string> = new Set(["success", "completed"]);

/**
 * Statuses that mean "in flight but NOT executing".
 *
 * ── THE LIFECYCLE, AND WHY THIS SET EXISTS ────────────────────────────────────
 * A tool call passes through more phases than the blue/quiet split once assumed:
 *
 *   1. the model streams the call's arguments        → `streaming` / `initializing`
 *   2. the server finishes PARSING them and emits    → still `initializing`
 *      `tool_call` / `tool_started`
 *   3. the call waits for an earlier group/tool      → still `initializing`, and
 *      in the same turn to finish                       THIS is the queued phase
 *   4. `executeTool` runs the permission gate        → `running` when auto-allowed,
 *                                                      `pending` when it needs a
 *                                                      person or a reflection gate
 *   5. the gate passes and the tool actually runs    → `running`
 *   6. it finishes                                   → `success` / `fail`
 *
 * Only 5 is execution. `tool_started` fires at 2, which is why "started" must never
 * be read as "running": it means the arguments are complete, nothing more.
 * `initializing` after 2 may be either "about to admit" or "queued behind upstream";
 * `resolveToolShimmerPhase` separates them via `earlierTools`.
 *
 * `pending` is likewise never "queued": every write of it in narrator-permission.ts
 * and task-reflection.ts accompanies a `permissionStartedAt` stamp or an
 * `awaiting_user` reflection — i.e. it always means a PERSON is being waited on.
 */
const NON_EXECUTING_IN_FLIGHT_STATUSES: ReadonlySet<string> = new Set([
	"streaming",
	"initializing",
	"pending",
]);

/** Statuses that mean the tool's own work is actually under way. */
const EXECUTING_TOOL_STATUSES: ReadonlySet<string> = new Set(["running"]);

/**
 * The two sets above must PARTITION `IN_FLIGHT_TOOL_ROW_STATUSES`: every status the
 * row layer considers in flight has to be classified as either executing or not, or
 * a live call would silently get no shimmer at all. Asserted in the unit test rather
 * than derived here, so adding a status to the shared set fails loudly instead of
 * quietly going dark.
 *
 * Note: `queued` is not a DB status — it is a presentation of `initializing` when
 * an earlier sibling still owns the turn. The partition is about wire statuses.
 */
export const TOOL_SHIMMER_PHASE_SETS = {
	nonExecuting: NON_EXECUTING_IN_FLIGHT_STATUSES,
	executing: EXECUTING_TOOL_STATUSES,
} as const;

/**
 * A same-turn tool call that appears EARLIER in provider order, reduced to the
 * facts the queued detector needs. Callers must not pass the full tool payload.
 *
 * `toolName` / `input` are only read to decide whether the peer runs in the SAME
 * parallel group as the call being judged — a same-group sibling is concurrent,
 * not upstream. Omit them and the detector falls back to the conservative
 * assumption that every live earlier call blocks (see `isToolQueuedBehindUpstream`).
 */
export type ToolUpstreamPeer = {
	status?: string | null;
	isStreaming?: boolean;
	hasPendingPermission?: boolean;
	reflectionStatus?: string | null;
	toolName?: string | null;
	input?: Record<string, unknown> | null;
};

export interface ToolShimmerPhaseInput {
	/** The model is still streaming this call's arguments. */
	isStreaming?: boolean;
	/** Raw tool-call status. */
	status?: string | null;
	/** A reflection gate's status on this call, when one exists. */
	reflectionStatus?: string | null;
	/**
	 * The call is blocked on the user's permission decision.
	 *
	 * Suppresses every sweep: a card sitting on an approve/deny form is waiting for a
	 * person, and animating it at all claims activity that is not happening. Note the
	 * `pending` status alone already implies this (see the set above); the flag stays
	 * because a LIVE permission request is observable before the row's status has been
	 * re-read, and because the caller may know about a request the row does not.
	 */
	hasPendingPermission?: boolean;
	/**
	 * Earlier calls in the same assistant turn, in provider order.
	 *
	 * When present and an earlier call still owns the execution slot, an
	 * `initializing` this call resolves to `queued` rather than `streaming`.
	 * Omit the field when the surface cannot see siblings — the call then keeps
	 * the historical neutral treatment.
	 */
	earlierTools?: readonly ToolUpstreamPeer[];
	/**
	 * The already-computed answer, for a surface that cannot see siblings but was
	 * handed the verdict.
	 *
	 * The vlist renderers are in exactly that position: the adapter walks the real
	 * provider-order prefix once and reduces it to this boolean, which then travels
	 * through the measured payload. Re-deriving it there would mean synthesizing a
	 * fake peer list to feed back into the detector — the same answer laundered
	 * through invented data, in the render hot path.
	 *
	 * `earlierTools` wins when both are given: a caller holding real peers has the
	 * more precise input.
	 */
	queuedBehindUpstream?: boolean;
	/**
	 * This call's name/input — only used to ask whether it shares a parallel group
	 * with a live earlier peer. See `ToolUpstreamPeer`.
	 */
	toolName?: string | null;
	input?: Record<string, unknown> | null;
}

/** Whether an earlier same-turn call still occupies the execution slot. */
function earlierToolOwnsTurn(peer: ToolUpstreamPeer): boolean {
	if (peer.reflectionStatus === "running") return true;
	if (peer.hasPendingPermission === true) return true;
	if (peer.isStreaming === true) return true;
	const status = peer.status;
	if (status == null || status === "") return false;
	if (status === "pending") return true;
	if (status === "running") return true;
	if (status === "streaming" || status === "initializing") return true;
	return false;
}

/**
 * Reduce a peer (or the judged call) to the shape `sharesParallelGroup` reads.
 * Returns null when the caller did not supply a tool name — the grouping rule is
 * name/input based and cannot be guessed.
 */
function groupItem(
	toolName: string | null | undefined,
	input: Record<string, unknown> | null | undefined,
): ToolExecutionGroupItem | null {
	if (!toolName) return null;
	return { toolName, input: input ?? {} };
}

/**
 * Whether the judged call STARTS TOGETHER with a live earlier peer, rather than
 * waiting for it.
 *
 * `earlierTools` is the provider-order prefix, so the slice from the blocking peer
 * to this call is contiguous — exactly what `sharesParallelGroup` needs. Any serial
 * barrier in between (a default Bash, a plan-mode tool, an Agent→Await boundary)
 * breaks the group and the call really is queued.
 *
 * Missing tool names mean the caller cannot answer this question; the conservative
 * result is false ("not concurrent" → queued), because painting a genuinely blocked
 * call as neutral hides the wait, while the reverse mislabels concurrent work.
 */
function startsConcurrentlyWithUpstream(
	input: {
		toolName?: string | null;
		input?: Record<string, unknown> | null;
	},
	earlier: readonly ToolUpstreamPeer[],
	blockingIndex: number,
): boolean {
	const self = groupItem(input.toolName, input.input);
	if (!self) return false;
	const slice: ToolExecutionGroupItem[] = [];
	for (let i = blockingIndex; i < earlier.length; i++) {
		const peer = earlier[i];
		if (!peer) return false;
		const item = groupItem(peer.toolName, peer.input);
		if (!item) return false;
		slice.push(item);
	}
	slice.push(self);
	return sharesParallelGroup(slice);
}

/**
 * true ⇔ this call's arguments are complete, but an earlier call in the same turn
 * still owns the execution slot.
 *
 * Deliberately narrow: streaming input, a live permission, a reflection gate and an
 * already-executing status all return false — those belong to other phases (or to
 * silence). Only `initializing` (post-parse, pre-admission) can be queued.
 *
 * `pending` on THIS call is never queued — it means a person is being waited on.
 * `pending` on an EARLIER call does make later calls queued: the turn is stuck on
 * that approval, and the later call has not started.
 *
 * ⚠️ A LIVE EARLIER CALL IS NOT ENOUGH. The loop executes one parallel GROUP at a
 * time, so `initializing` beside a `running` sibling means "queued" only when the
 * two are in DIFFERENT groups; inside one group both are starting together, and
 * calling that "parked" misreports concurrent work as blocked. When peers carry
 * `toolName`, the shared grouping rule decides; without it the detector keeps the
 * older, coarser answer (see `startsConcurrentlyWithUpstream`).
 *
 * Two ways to supply the upstream fact: real `earlierTools` (a caller that can see
 * the provider-order prefix), or a pre-computed `queuedBehindUpstream` (a render
 * surface handed the adapter's verdict). Real peers win when both are present.
 */
export function isToolQueuedBehindUpstream(input: {
	status?: string | null;
	isStreaming?: boolean;
	hasPendingPermission?: boolean;
	reflectionStatus?: string | null;
	earlierTools?: readonly ToolUpstreamPeer[];
	queuedBehindUpstream?: boolean;
	toolName?: string | null;
	input?: Record<string, unknown> | null;
}): boolean {
	if (input.reflectionStatus === "running") return false;
	if (input.hasPendingPermission === true) return false;
	if (input.isStreaming === true) return false;
	const status = input.status;
	if (status === "pending") return false;
	if (status === "running") return false;
	if (status !== "initializing") return false;
	const earlier = input.earlierTools;
	// The gates above still apply to a pre-computed verdict: a stale `true` must not
	// outrank this call's own live permission / reflection / execution state.
	if (!earlier || earlier.length === 0) return input.queuedBehindUpstream === true;
	// The FIRST live earlier call is the one that would own the slot; anything before
	// it has settled and blocks nothing.
	const blockingIndex = earlier.findIndex(earlierToolOwnsTurn);
	if (blockingIndex === -1) return false;
	return !startsConcurrentlyWithUpstream(input, earlier, blockingIndex);
}

/**
 * The looping shimmer for a call, or `null` for "no shimmer".
 *
 * The order below is a precedence chain, and each step earns its place:
 *
 * 1. ⚠️ REFLECTION WINS over everything. A gate parks its tool at `pending`, which
 *    every in-flight test in this codebase reads as "running" — asking about
 *    `status` first is precisely what painted a deliberating gate blue.
 *
 * 2. AWAITING THE USER silences the row entirely. A call blocked on an approve/deny
 *    form is not doing anything; a sweep there animates the reader's own inaction
 *    back at them.
 *
 * 3. STREAMING (input still arriving) gets the neutral sweep — even when an earlier
 *    sibling is also live. Arguments arriving is the more current fact for THIS call.
 *
 * 4. QUEUED: `initializing` with an earlier same-turn call still owning the slot.
 *    This is what separates "waiting for my turn" from "still receiving arguments"
 *    without inventing a DB status.
 *
 * 5. Other non-executing in-flight statuses get the neutral sweep.
 *
 * 6. Only an explicitly EXECUTING status gets blue.
 *
 * The default is silence: an unrecognised status produces no sweep rather than a
 * guess, so a provider status this frontend has never heard of cannot animate
 * forever.
 */
export function resolveToolShimmerPhase(input: ToolShimmerPhaseInput): ToolShimmerPhase | null {
	if (input.reflectionStatus === "running") return "reflecting";
	if (input.hasPendingPermission === true) return null;
	const status = input.status;
	// `pending` IS "awaiting a person" at every write site (see the set's doc), so it
	// silences the row even when the caller passed no explicit permission flag — which
	// is the case for every folded trace row.
	if (status === "pending") return null;
	if (input.isStreaming === true) return "streaming";
	if (status == null || status === "") return null;
	if (status === "initializing" || status === "streaming") {
		if (isToolQueuedBehindUpstream(input)) return "queued";
		return "streaming";
	}
	if (NON_EXECUTING_IN_FLIGHT_STATUSES.has(status)) return "streaming";
	if (EXECUTING_TOOL_STATUSES.has(status)) return "running";
	return null;
}

/**
 * The one-shot closing sweep for a status TRANSITION, or `null` for none.
 *
 * `prev == null` deliberately returns null — a fresh mount is not a transition. In
 * a virtual list rows and cards mount and unmount constantly as the reader
 * scrolls, so treating a mount as "it just finished" would flash the whole screen
 * green while merely scrolling through history. Surfaces that CAN distinguish a
 * genuine just-finished mount (the chunk card inspects `startedAt` + a 2s window)
 * may add that on top; this function only reports what a transition proves.
 */
export function resolveToolShimmerFlash(
	prev: string | null | undefined,
	next: string | null | undefined,
): ToolShimmerFlash | null {
	if (prev == null || prev === "") return null;
	if (next == null || next === "") return null;
	// Only a call that WAS in flight can have just reached an outcome. Without this
	// a re-render that merely re-reports the same terminal status would replay the
	// sweep on every frame.
	if (!IN_FLIGHT_TOOL_ROW_STATUSES.has(prev)) return null;
	return resolveToolShimmerOutcome(next);
}

/**
 * The outcome flash a TERMINAL status deserves, ignoring any transition.
 *
 * Split out so a surface with its own "did this just finish" evidence (the chunk
 * card's `startedAt` window) can reuse the same colour mapping instead of
 * re-deriving it — the drift this module exists to prevent.
 */
export function resolveToolShimmerOutcome(
	status: string | null | undefined,
): ToolShimmerFlash | null {
	if (status == null || status === "") return null;
	if (SUCCEEDED_TOOL_STATUSES.has(status)) return "success";
	if (FAILED_TOOL_STATUSES.has(status)) return "failed";
	// Cancelled / denied / aborted, and anything unrecognised: no flash. Guessing
	// here would put a red sweep on a state nobody has interpreted.
	return null;
}

/**
 * CSS class per shimmer kind, for the two carriers.
 *
 * The rules live in global stylesheets (`frontend/styles/card-shimmer.css` and
 * `trace-shimmer.css`) because both render paths need them and vlist cannot import
 * the chunk path. The NAMES live here, beside the decision that selects them, so a
 * renamed class cannot leave one of the four surfaces silently unstyled — every
 * call site resolves its class through these tables.
 *
 * CARD = a sweeping overlay across a card's face. TRACE = a gradient clipped to a
 * compact row's own text. Same states, different carriers (see either stylesheet's
 * header for why they must differ).
 */
export const CARD_SHIMMER_CLASS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "nf-card-shimmer--stream",
	reflecting: "nf-card-shimmer--reflect",
	running: "nf-card-shimmer--run",
	queued: "nf-card-shimmer--queued",
	queued_out: "nf-card-shimmer--queued-out",
	success: "nf-card-shimmer--done",
	failed: "nf-card-shimmer--fail",
};

export const TRACE_SHIMMER_CLASS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "nf-trace-shimmer--stream",
	reflecting: "nf-trace-shimmer--reflect",
	running: "nf-trace-shimmer--run",
	queued: "nf-trace-shimmer--queued",
	queued_out: "nf-trace-shimmer--queued-out",
	success: "nf-trace-shimmer--done",
	failed: "nf-trace-shimmer--fail",
};

/**
 * How long the queued wash keeps dissolving after the call leaves `queued`, in ms —
 * the SAME number both stylesheets declare for `--queued-out`.
 *
 * Long enough to read as a fade rather than a flicker; short enough that the next
 * phase's sweep is not noticeably late. Pinned against the stylesheets in
 * `RenderToolRun.shimmer.test.tsx`.
 */
export const TOOL_SHIMMER_QUEUED_EXIT_MS = 450;

/**
 * Duration of the folded row's closing sweep, in ms — the SAME number
 * `trace-shimmer.css` declares for `.nf-trace-shimmer--done` / `--fail`.
 *
 * It lives here for the reason the class names do: both row paths mount the class,
 * neither can import the other, and the CSS is a third place. Pinned against the
 * stylesheet in `RenderToolRun.shimmer.test.tsx`.
 *
 * Deliberately slower than the card's 600ms overlay sweep. A card's sweep is a
 * translated overlay the eye catches anywhere on a large face; a row's is a
 * highlight travelling one 18.8px line of dimmed text, and at 600ms it registered
 * as a flicker rather than a report.
 */
export const TRACE_SHIMMER_FLASH_MS = 900;

/**
 * How long a row keeps its closing-sweep class, in ms.
 *
 * ⚠️ Must exceed `TRACE_SHIMMER_FLASH_MS`. Dropping the class while the animation
 * is still running cuts the highlight off wherever it happens to be — the green
 * appears to die mid-row instead of leaving it, which is one of the two ways this
 * sweep has already looked broken (the other was two-pass keyframes; see the
 * stylesheet).
 */
export const TRACE_SHIMMER_FLASH_HOLD_MS = TRACE_SHIMMER_FLASH_MS + 60;
