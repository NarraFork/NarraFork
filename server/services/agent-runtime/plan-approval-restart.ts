/**
 * plan-approval-restart.ts — when an approved plan restarts the pass.
 *
 * A successful ExitPlanMode ends the current pass: the orchestrator marks the approval
 * (`_planApprovedContinue`), optionally compacts onto the plan, and aborts the loop so
 * the next pass starts with "plan approved". ExitPlanMode runs as soon as its input is
 * complete, so the approval can land while the model is still streaming the response
 * that requested it. Aborting then would cut that response short: its API request is
 * recorded as aborted and the approval-abort cleanup discards the partial message.
 *
 * So the approval is marked at once (shouldStop then starts nothing after it), and the
 * restart itself runs when the response is finalized — the same point at which it runs
 * when the response ends before the approval.
 */

export type PlanApproval = "continue" | "compact";

export interface PlanApprovalState {
	/** Set while a streamed assistant response is open (not yet finalized). */
	_partialMessageId?: string;
	_planApprovedContinue?: PlanApproval;
	_planApprovalFinish?: () => Promise<void>;
}

export interface PlanApprovalRestart {
	/** Compact onto the approved plan before the restart (compact approvals only). */
	compact?: () => Promise<void>;
	/** End the current pass. */
	abort: () => void;
}

/**
 * Apply an approval: restart now when no response is open, otherwise once it is
 * finalized. The approval is marked before the abort, after any compact — as before.
 */
export async function applyPlanApproval(
	state: PlanApprovalState,
	approval: PlanApproval,
	restart: PlanApprovalRestart,
): Promise<void> {
	if (state._partialMessageId) {
		state._planApprovedContinue = approval;
		state._planApprovalFinish = async () => {
			await restart.compact?.();
			restart.abort();
		};
		return;
	}
	await restart.compact?.();
	state._planApprovedContinue = approval;
	restart.abort();
}

/** Run a restart deferred by `applyPlanApproval`, once its response is finalized. */
export async function runDeferredPlanApproval(state: PlanApprovalState): Promise<void> {
	const finish = state._planApprovalFinish;
	if (!finish) return;
	state._planApprovalFinish = undefined;
	await finish();
}

/**
 * The pass ended (error or interruption) before the approving response was finalized:
 * the restart never happened, so the approval must not turn this ending into a plan
 * restart that discards the partial response.
 */
export function dropDeferredPlanApproval(state: PlanApprovalState): void {
	if (!state._planApprovalFinish) return;
	state._planApprovalFinish = undefined;
	state._planApprovedContinue = undefined;
}
