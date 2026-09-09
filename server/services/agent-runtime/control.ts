import { logger } from "../../lib/logger";
import { broadcastToNarrator } from "../../websocket/narrator-ws";
import type { ExecuteLoopResult } from "../narrator-executor";
import { narratorService } from "../narrator-service";
import type { ActiveNarrator } from "../narrator-session-state";
import {
	consumeForegroundSubagentHardInterrupt,
	getDetachableMap,
	getForegroundAbortControllers,
} from "../subagent-detach";
import { consumeNextBufferedSubagentMessage } from "../subagent-executor";
import { resumeManualOverride, waitForManualOverride } from "../subagent-manual-override";
import {
	beginSubagentInterruptSuspension,
	clearTakenOver,
	consumePendingBackgroundFinalize,
	consumePendingStopTakeover,
	isTakenOver,
} from "../subagent-takeover";
import { peekInbox } from "./inbox";
import type { SubagentRuntimeProfile } from "./input";
import { type ExecutionOwner, setExecutionSuspended } from "./ownership";

export type RuntimeControlOutcome =
	| { kind: "none" }
	| { kind: "finish"; finalText: string; hasError: boolean; interrupted: boolean }
	| { kind: "resume"; prompt: string; userId: string | null; prePromptBashCommand?: string };

/** A bounded control transition, not a second executor or next-pass loop. */
export async function applyForegroundControl(
	active: ActiveNarrator,
	owner: ExecutionOwner,
	profile: SubagentRuntimeProfile,
	result: ExecuteLoopResult,
): Promise<RuntimeControlOutcome> {
	const control = profile.control;
	if (!control || !owner.isCurrent()) return { kind: "none" };
	const id = active.narratorId;
	if (control.detached || control.parentSignal.aborted || control.timeoutSignal?.aborted)
		return { kind: "none" };
	const locallyInterrupted = control.turnAbort.signal.aborted;
	if (consumeForegroundSubagentHardInterrupt(id) && locallyInterrupted) {
		return {
			kind: "finish",
			finalText: "Subagent interrupted by user",
			hasError: false,
			interrupted: true,
		};
	}
	if (result.hasError && !result.aborted) {
		if (isTakenOver(id)) clearTakenOver(id);
		return { kind: "none" };
	}
	if (!locallyInterrupted && !isTakenOver(id)) return { kind: "none" };
	const consumeQueued = () =>
		consumeNextBufferedSubagentMessage({
			narratorId: id,
			parentNarratorId: profile.parentNarratorId,
			toolUseId: profile.parentToolUseId,
			model: active.model,
			provider: active.provider,
			cwd: active.cwd,
		});
	if (locallyInterrupted) {
		const queued = await consumeQueued();
		if (queued)
			return {
				kind: "resume",
				prompt: queued.currentInput ?? queued.prompt,
				userId: queued.preservePrincipal
					? (active._currentUserId ?? null)
					: (queued.userId ?? null),
				prePromptBashCommand: queued.prePromptBashCommand,
			};
	}
	const heldByTakeover = locallyInterrupted
		? beginSubagentInterruptSuspension(id).heldByTakeover
		: true;
	if (heldByTakeover && (consumePendingStopTakeover(id) || consumePendingBackgroundFinalize(id))) {
		clearTakenOver(id);
		return {
			kind: "finish",
			finalText: result.finalText,
			hasError: result.hasError,
			interrupted: false,
		};
	}
	const substatus = heldByTakeover ? ["taken_over"] : ["manual_override"];
	await narratorService.updateStatus(id, "idle", { substatus });
	broadcastToNarrator(profile.parentNarratorId, {
		type: "subagent_suspended",
		narratorId: profile.parentNarratorId,
		subagentNarratorId: id,
		toolUseId: profile.parentToolUseId,
	});
	broadcastToNarrator(id, { type: "status_change", narratorId: id, status: "idle", substatus });
	const signal = control.timeoutSignal
		? AbortSignal.any([control.parentSignal, control.timeoutSignal])
		: control.parentSignal;
	const waiting = waitForManualOverride(
		id,
		signal,
		profile.parentNarratorId,
		profile.parentToolUseId,
	);
	setExecutionSuspended(owner, true);
	try {
		// Registration precedes inbox inspection: user input may only settle this control,
		// never observe a gap and start a second owner.
		// Team reports and notices do not authorize releasing user control.
		const queued =
			peekInbox(id)?.kind === "user_input"
				? await consumeQueued().catch((error) => {
						logger.warn("Failed to materialize user input for suspended runtime", {
							narratorId: id,
							error: String(error),
						});
						return undefined;
					})
				: undefined;
		const resumedFromQueue =
			queued &&
			resumeManualOverride(id, {
				prompt: queued.currentInput ?? queued.prompt,
				history: queued.history,
				trailingToolResults: queued.trailingToolResults,
				userId: queued.preservePrincipal
					? (active._currentUserId ?? null)
					: (queued.userId ?? null),
			});
		const answer = await waiting;
		if (answer.action === "resume")
			return {
				kind: "resume",
				prompt: answer.prompt,
				userId: answer.userId ?? null,
				prePromptBashCommand: resumedFromQueue ? queued?.prePromptBashCommand : undefined,
			};
		if (heldByTakeover) clearTakenOver(id);
		return {
			kind: "finish",
			finalText: answer.finalText,
			hasError: answer.hasError,
			interrupted: answer.interrupted === true,
		};
	} finally {
		setExecutionSuspended(owner, false);
	}
}

/** Install the next turn cancellation sources without releasing its execution epoch. */
export function resetForegroundTurn(active: ActiveNarrator, profile: SubagentRuntimeProfile): void {
	const control = profile.control;
	if (!control) return;
	control.cleanupTurnAbort?.();
	control.proxy.dispose();
	control.turnAbort = new AbortController();
	control.proxy.listenTo(control.parentSignal, control.turnAbort.signal);
	if (control.timeoutSignal) control.proxy.listenTo(control.timeoutSignal);
	getForegroundAbortControllers().set(active.narratorId, control.turnAbort);
	const detachable = getDetachableMap().get(active.narratorId);
	if (detachable) detachable.fgAbort = control.turnAbort;
	active.abortController = new AbortController();
	const signal = control.proxy.signal;
	const controller = active.abortController;
	const abort = () => controller.abort(signal.reason);
	control.cleanupTurnAbort = () => signal.removeEventListener("abort", abort);
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });
	active.alive = true;
}
