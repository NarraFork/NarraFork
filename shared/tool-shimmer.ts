/**
 * tool-shimmer.ts — WHICH shimmer a tool call shows, and why.
 *
 * A shimmer is the sweeping light that tells the reader, at a glance and without
 * reading any text, what a tool call is doing right now. There are five states:
 *
 *   neutral  streaming   the model is still writing the call's arguments
 *   purple   reflecting  a reflection gate is deliberating about this call
 *   blue     running     the call is executing
 *   green    success     it just finished (one-shot, reverse sweep)
 *   red      failed      it just failed (one-shot, reverse sweep)
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
 */

import { IN_FLIGHT_TOOL_ROW_STATUSES } from "./tool-row-status";

/** A looping shimmer: the call is still in flight, in one of three ways. */
export type ToolShimmerPhase = "streaming" | "reflecting" | "running";

/** A one-shot closing sweep, played once as the call reaches a terminal state. */
export type ToolShimmerFlash = "success" | "failed";

/** Every shimmer a surface may need a class for. */
export type ToolShimmerKind = ToolShimmerPhase | ToolShimmerFlash;

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
 *   1. the model streams the call's arguments        → `initializing`
 *   2. the server finishes PARSING them and emits    → still `initializing`
 *      `tool_call` / `tool_started`
 *   3. `executeTool` runs the permission gate        → `running` when auto-allowed,
 *                                                      `pending` when it needs a
 *                                                      person or a reflection gate
 *   4. the gate passes and the tool actually runs    → `running`
 *   5. it finishes                                   → `success` / `fail`
 *
 * Only 4 is execution. `tool_started` fires at 2, which is why "started" must never
 * be read as "running": it means the arguments are complete, nothing more.
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
 */
export const TOOL_SHIMMER_PHASE_SETS = {
	nonExecuting: NON_EXECUTING_IN_FLIGHT_STATUSES,
	executing: EXECUTING_TOOL_STATUSES,
} as const;

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
 * 3. STREAMING and the other non-executing in-flight states get the neutral sweep.
 *    This is the fix for the most visible symptom: `tool_started` fires when the
 *    ARGUMENTS finish parsing, well before the permission gate, so a card in this
 *    phase used to claim it was executing.
 *
 * 4. Only an explicitly EXECUTING status gets blue.
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
 * compact row's own text. Same five states, different carriers (see either
 * stylesheet's header for why they must differ).
 */
export const CARD_SHIMMER_CLASS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "nf-card-shimmer--stream",
	reflecting: "nf-card-shimmer--reflect",
	running: "nf-card-shimmer--run",
	success: "nf-card-shimmer--done",
	failed: "nf-card-shimmer--fail",
};

export const TRACE_SHIMMER_CLASS: Readonly<Record<ToolShimmerKind, string>> = {
	streaming: "nf-trace-shimmer--stream",
	reflecting: "nf-trace-shimmer--reflect",
	running: "nf-trace-shimmer--run",
	success: "nf-trace-shimmer--done",
	failed: "nf-trace-shimmer--fail",
};
