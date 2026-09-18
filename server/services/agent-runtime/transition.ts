import type { ExecuteLoopResult } from "../narrator-executor";
import { planTurnInterruption } from "../turn-continuation-decisions";
import { selectPassRecoverySource } from "../turn-continuation-registry";

/** Run-scoped counters; neither a fresh EventContext nor a compact resets this object. */
export interface RuntimeRecoveryState {
	overflowRetries: number;
	transientRetries: number;
	interruptionRetries: number;
	/**
	 * Quota suspensions already spent on this run.
	 *
	 * Its own counter rather than a reuse of `transientRetries`: a quota wait is not
	 * a failed attempt, and the two have different budgets — every suspension costs
	 * a full history re-upload, so a reset instant that keeps resolving to
	 * "shortly" must be bounded here (`MAX_QUOTA_WAITS_PER_RUN`) without consuming
	 * (or being reset by) the transient-retry budget.
	 */
	quotaWaits: number;
}

export function createRuntimeRecoveryState(): RuntimeRecoveryState {
	return { overflowRetries: 0, transientRetries: 0, interruptionRetries: 0, quotaWaits: 0 };
}

export interface RecoveryObservation {
	result: ExecuteLoopResult;
	aborted: boolean;
	/** Approval can intentionally abort the old pass without cancelling the authorized turn. */
	planApproved: boolean;
	stateful: boolean;
	maxTransientRetries: number;
}

export type RuntimeRecoveryTransition =
	| { kind: "aborted" }
	| { kind: "payment"; payment: NonNullable<ExecuteLoopResult["paymentRequired"]> }
	| { kind: "model-unavailable"; model: NonNullable<ExecuteLoopResult["modelUnavailable"]> }
	| { kind: "overflow"; retryCount: number }
	| {
			kind: "backoff";
			source: "transient-error" | "silent-disconnect";
			error: string;
			retryCount: number;
			maxRetries: number;
	  }
	| { kind: "retry-exhausted"; error: string }
	| { kind: "completed" };

/**
 * One precedence and retry policy for both identities. Stateless failures already
 * exhausted the provider loop's retries; an outer replay would multiply that budget.
 * This function is pure: applying the returned count happens at the effect boundary.
 */
export function selectRuntimeRecovery(
	state: RuntimeRecoveryState,
	observation: RecoveryObservation,
): RuntimeRecoveryTransition {
	const { result } = observation;
	const source = selectPassRecoverySource(result, observation);
	if (source === "abort-before-recovery") return { kind: "aborted" };
	if (source === "payment-required" && result.paymentRequired)
		return { kind: "payment", payment: result.paymentRequired };
	if (source === "model-unavailable" && result.modelUnavailable)
		return { kind: "model-unavailable", model: result.modelUnavailable };
	if (source === "context-overflow")
		return {
			kind: "overflow",
			retryCount: result.completedAssistantTurn ? 0 : state.overflowRetries,
		};
	if (result.retryableError && !observation.stateful)
		return { kind: "retry-exhausted", error: result.retryableError };
	if (result.retryableError || result.silentDisconnect)
		return {
			kind: "backoff",
			source: result.retryableError ? "transient-error" : "silent-disconnect",
			error: result.retryableError ?? "Codex WebSocket silent disconnect",
			retryCount: state.transientRetries + 1,
			maxRetries:
				result.retryableError && result.bypassRetryLimit ? -1 : observation.maxTransientRetries,
		};
	return { kind: "completed" };
}

export interface RuntimeRecoveryEffectResult {
	/** False when a bounded backoff or availability wait ended without recovery. */
	recovered: boolean;
	aborted: boolean;
}

export function settleRuntimeRecovery(
	state: RuntimeRecoveryState,
	transition: RuntimeRecoveryTransition,
	result: RuntimeRecoveryEffectResult,
): "replay" | "aborted" | "failed" | "completed" {
	if (transition.kind === "backoff") state.transientRetries = transition.retryCount;
	if (result.aborted || transition.kind === "aborted") return "aborted";
	if (transition.kind === "completed") {
		state.transientRetries = 0;
		return "completed";
	}
	if (transition.kind === "payment" || transition.kind === "retry-exhausted") return "failed";
	if (!result.recovered) return "failed";
	if (transition.kind !== "backoff") state.transientRetries = 0;
	return "replay";
}

/** Replay packets must stay distinct from an injected textual continuation. */
export function selectRuntimeInterruption(
	state: RuntimeRecoveryState,
	result: ExecuteLoopResult,
	options: Parameters<typeof planTurnInterruption>[2],
) {
	const transition = planTurnInterruption(result, state.interruptionRetries, options);
	state.interruptionRetries = transition.retries;
	return transition;
}
