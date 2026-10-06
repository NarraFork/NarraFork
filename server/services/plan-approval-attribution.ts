/**
 * plan-approval-attribution.ts — who a "plan approved, begin execution" turn is FROM.
 *
 * That turn is persisted with `role: "user"` (the model must read it as an
 * instruction), so the bubble it paints makes a claim about authorship. Four different
 * things can produce it, and attributing them all to "you" — which is what an absent
 * `createdBy` used to mean — tells the reader they approved a plan they may never have
 * seen.
 *
 * Pure and separate from the loop so the precedence can be tested without driving a
 * whole agent turn: the loop reads two session-state maps, hands the values here, and
 * persists whatever comes back.
 */

import { formatOriginLabel, type MessageOriginOptions } from "@shared/message-origin";

/** Who approved the plan, as recorded by the two approval paths. */
export type PlanApproverSource = "user" | "reflection";

export interface PlanApprovalAttributionInput {
	/**
	 * Chained feedback the approver typed alongside their decision, if any. Its
	 * presence is the strongest signal available: somebody WROTE the turn's text.
	 */
	feedbackUserId?: string | null;
	hasFeedback: boolean;
	/** `pendingPlanApprover` — the userId of a human who approved through the UI. */
	approverId?: string | undefined;
	/** `pendingPlanApproverSource` — which path approved. */
	approverSource?: PlanApproverSource | undefined;
}

export interface PlanApprovalAttribution {
	originOptions: MessageOriginOptions;
	/** `created_by`; undefined means "no account authored this". */
	createdBy: string | undefined;
}

/**
 * Resolve the turn's attribution.
 *
 * Precedence, strongest evidence first:
 *  1. chained feedback — the approver actually typed this text, so it is theirs;
 *  2. a recorded human approver — a real account pressed approve;
 *  3. the plan reflection — no human involved, so the "计划反思" identity on the left;
 *  4. neither — the generic auto-continuation card (legacy rows, recovery paths).
 *
 * ⚠️ A human approver OUTRANKS the reflection marker. Both maps are cleared on the
 * paths that consume them, but a marker can still outlive a failed approval, and
 * mislabelling a person's decision as the machine's is the worse error: an approver id
 * is only ever written by a real UI decision, so when both are present the id wins.
 */
export function resolvePlanApprovalAttribution(
	input: PlanApprovalAttributionInput,
): PlanApprovalAttribution {
	if (input.hasFeedback) {
		return { originOptions: { origin: "user" }, createdBy: input.feedbackUserId ?? undefined };
	}
	if (input.approverId) {
		return { originOptions: { origin: "user" }, createdBy: input.approverId };
	}
	if (input.approverSource === "reflection") {
		return {
			originOptions: { origin: "user", originLabel: formatOriginLabel("planReflection") },
			createdBy: undefined,
		};
	}
	return {
		originOptions: { origin: "system", originLabel: formatOriginLabel("autoContinuation") },
		createdBy: undefined,
	};
}
