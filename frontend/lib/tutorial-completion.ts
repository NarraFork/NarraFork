/**
 * Step-completion detection for the interactive tutorial.
 *
 * Every predicate here reads state the product ALREADY publishes: narrator
 * status, the existing `/ws/narrator` frames, chapter edges, spec files. That is
 * deliberate — a tutorial-only signal would let the tutorial report success while
 * the feature it teaches is broken, which is the one outcome worse than a tutorial
 * that gets stuck.
 *
 * Pure by design: no React, no WebSocket, no DOM. The failure mode these guard
 * against is "a step can never be completed", which in a component would only
 * surface as a user staring at an un-advancing step list; as a function it is a
 * three-line test.
 */

import type { TutorialCompletion, TutorialStep } from "@shared/tutorial/lessons";

/**
 * WS frame types a step may be judged on.
 *
 * Lives here rather than in the hook because it is not a subscription detail: the
 * manager filters by type, so a frame missing from this list never reaches the
 * predicates below and its step can never tick. Keeping the list beside the
 * predicates is what lets a test assert the two agree — the original split let
 * three types go missing, and each one silently disabled a lesson:
 *
 * - `user_message` is the user's own turn (`message` carries assistant rows), so
 *   without it `userSentMessage` never becomes true, which also blocks every
 *   `narratorIdle` step.
 * - `subagent_started` is the only frame reporting a spawn on the PARENT narrator.
 * - `plan_reflection_resolved` is what the plan gate emits instead of
 *   `permission_resolved`.
 */
export const TUTORIAL_FRAME_TYPES = [
	"status_change",
	"tool_completed",
	"permission_resolved",
	"plan_reflection_resolved",
	"subagent_started",
	"message",
	"user_message",
] as const;

/**
 * Frame types each completion kind reads, for the guard test.
 *
 * Kinds judged on polled state rather than frames map to an empty list.
 */
export const COMPLETION_FRAME_TYPES: Record<TutorialCompletion["kind"], readonly string[]> = {
	manual: [],
	userSentMessage: ["user_message"],
	narratorIdle: ["status_change", "user_message"],
	permissionResolved: ["permission_resolved", "plan_reflection_resolved"],
	toolCompleted: ["tool_completed"],
	subagentSpawned: ["subagent_started"],
	chapterForked: [],
	chapterMerged: [],
	specTaskWritten: [],
};

/** The subset of a narrator WS frame these predicates read. */
export interface TutorialObservedFrame {
	type: string;
	narratorId?: string;
	/**
	 * `permission_resolved` / `plan_reflection_resolved`.
	 *
	 * The plan gate can also report `"aborted"` (the turn ended before the user
	 * answered), which is why this is not just allow/deny: a step pinned to one
	 * decision must not treat an abort as that decision.
	 */
	decision?: "allow" | "deny" | "aborted";
	/** `tool_completed` */
	toolName?: string;
	status?: string;
	/** Set on `subagent_started`, whose `narratorId` is the PARENT. */
	subagentNarratorId?: string;
}

/** Everything a step's completion may be judged against. */
export interface TutorialObservations {
	/** The lesson narrator's id; frames for other narrators are ignored. */
	narratorId: string;
	/** Latest known narrator status (`idle` / `working` / `waiting` / …). */
	narratorStatus?: string;
	/** True once the user has submitted at least one message this session. */
	userSentMessage?: boolean;
	/** Frames observed since the lesson started, oldest first. */
	frames: readonly TutorialObservedFrame[];
	/** Chapter edge kinds observed for the sandbox chapter. */
	chapterEdgeKinds?: readonly string[];
	/** Number of tasks currently in `spec://tasks.json`. */
	specTaskCount?: number;
}

/**
 * Whether the lesson narrator has produced at least one turn.
 *
 * `narratorIdle` must not be satisfied by the initial idle state: a freshly
 * created narrator is idle before it has done anything, so a step asking the user
 * to "wait for the turn to finish" would complete instantly and skip the whole
 * point. Requiring a prior user message is what distinguishes "idle again" from
 * "idle still".
 */
function hasReturnedToIdle(observations: TutorialObservations): boolean {
	if (!observations.userSentMessage) return false;
	return observations.narratorStatus === "idle";
}

function framesForLesson(observations: TutorialObservations): TutorialObservedFrame[] {
	return observations.frames.filter((frame) => {
		// A frame with no narratorId is a broadcast the tutorial does not judge on.
		if (!frame.narratorId) return false;
		// Subagent frames are re-broadcast on the parent with `subagentNarratorId`
		// set. Those count for `subagentSpawned` but must not satisfy, say, "approve a
		// permission" — the user approved it in the child, which is a different lesson.
		return frame.narratorId === observations.narratorId;
	});
}

/** Whether one completion condition is currently satisfied. */
export function isCompletionSatisfied(
	completion: TutorialCompletion,
	observations: TutorialObservations,
): boolean {
	switch (completion.kind) {
		case "manual":
			// Advanced by the user clicking through; never auto-satisfied.
			return false;
		case "userSentMessage":
			return observations.userSentMessage === true;
		case "narratorIdle":
			return hasReturnedToIdle(observations);
		case "permissionResolved":
			return framesForLesson(observations).some((frame) => {
				// Two frames mean "the user decided". A tool permission emits
				// `permission_resolved`; the plan gate emits `plan_reflection_resolved` and
				// never the former, so the plan-mode lesson would wait forever on a
				// decision the user already made.
				if (frame.type !== "permission_resolved" && frame.type !== "plan_reflection_resolved") {
					return false;
				}
				// `aborted` is not a decision — the request went away before the user
				// answered — so it must not tick a step that asks them to decide.
				if (frame.decision === "aborted") return false;
				// An unpinned step accepts either decision: "deny" is a legitimate thing
				// to learn, and demanding "allow" would trap a user who denied on purpose.
				if (!completion.decision) return true;
				return frame.decision === completion.decision;
			});
		case "toolCompleted":
			return framesForLesson(observations).some(
				(frame) =>
					frame.type === "tool_completed" &&
					frame.toolName === completion.toolName &&
					// Any terminal status counts. A failed call still demonstrates the card's
					// lifecycle, and gating on success would strand the user on an
					// environment-specific failure they cannot fix from inside the lesson.
					!!frame.status,
			);
		case "subagentSpawned":
			// Judged on the PARENT's frame stream, where a subagent event arrives with
			// `subagentNarratorId` set — the child has its own narrator id, so the
			// `framesForLesson` filter would discard exactly the evidence needed.
			return observations.frames.some(
				(frame) =>
					frame.narratorId === observations.narratorId &&
					typeof frame.subagentNarratorId === "string",
			);
		case "chapterForked":
			return (observations.chapterEdgeKinds ?? []).includes("fork");
		case "chapterMerged":
			return (observations.chapterEdgeKinds ?? []).includes("merge");
		case "specTaskWritten":
			return (observations.specTaskCount ?? 0) > 0;
		default: {
			// Exhaustiveness: a new completion kind must be handled here, not silently
			// treated as "never completes" — which is invisible until a user is stuck.
			const _exhaustive: never = completion;
			return _exhaustive;
		}
	}
}

/**
 * Which steps are satisfied right now.
 *
 * Returns ids rather than mutating anything so the caller decides what to persist;
 * the service treats progress as additive, so re-reporting a step is harmless.
 */
export function satisfiedStepIds(
	steps: readonly TutorialStep[],
	observations: TutorialObservations,
): string[] {
	return steps
		.filter((step) => isCompletionSatisfied(step.completion, observations))
		.map((step) => step.id);
}

/**
 * The step the user should be working on.
 *
 * The first step that is neither already recorded nor currently satisfied. Steps
 * are ordered instructions, so this is intentionally the first gap and not "the
 * furthest reached": skipping ahead past an incomplete step would leave the user
 * reading instructions for work they never did.
 *
 * Returns null when every step is done.
 */
export function activeStepId(
	steps: readonly TutorialStep[],
	completedStepIds: readonly string[],
	observations: TutorialObservations,
): string | null {
	const done = new Set(completedStepIds);
	for (const step of steps) {
		if (done.has(step.id)) continue;
		if (isCompletionSatisfied(step.completion, observations)) continue;
		return step.id;
	}
	return null;
}

/** Whether every step of a lesson is accounted for. */
export function isLessonComplete(
	steps: readonly TutorialStep[],
	completedStepIds: readonly string[],
): boolean {
	if (steps.length === 0) return false;
	const done = new Set(completedStepIds);
	return steps.every((step) => done.has(step.id));
}
