import { hotOnce, hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import {
	type PermissionPolicyChangeEvent,
	permissionPolicyChanges,
} from "../permission-rule-service";
import { executionPolicyEngine } from "./engine";

export type PendingPermissionPolicyReprocessor = (
	narratorId: string,
) => number | undefined | Promise<number | undefined>;

interface ExecutionPolicyEventState {
	reprocessor?: PendingPermissionPolicyReprocessor;
	pendingNarratorIds: Set<string>;
	scheduled: boolean;
}

const state = hotSafe<ExecutionPolicyEventState>("narrafork.executionPolicy.events", () => ({
	pendingNarratorIds: new Set(),
	scheduled: false,
}));

export async function flushExecutionPolicyChangeQueue(): Promise<void> {
	state.scheduled = false;
	const narratorIds = [...state.pendingNarratorIds];
	state.pendingNarratorIds.clear();
	const reprocessor = state.reprocessor;
	if (!reprocessor) return;
	for (const narratorId of narratorIds) {
		try {
			await reprocessor(narratorId);
		} catch (error) {
			logger.error("Failed to reprocess pending permissions after policy change", {
				narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function scheduleAffectedPendingReprocess(event: PermissionPolicyChangeEvent): void {
	executionPolicyEngine.invalidate(event.narratorId);
	state.pendingNarratorIds.add(event.narratorId);
	if (state.scheduled) return;
	state.scheduled = true;
	queueMicrotask(() => {
		void flushExecutionPolicyChangeQueue();
	});
}

if (hotOnce("narrafork.executionPolicy.events.listener")) {
	permissionPolicyChanges.on(scheduleAffectedPendingReprocess);
}

/** Register the permission module's coalesced pending-request re-evaluator. */
export function registerExecutionPolicyPendingReprocessor(
	reprocessor: PendingPermissionPolicyReprocessor,
): void {
	state.reprocessor = reprocessor;
}
