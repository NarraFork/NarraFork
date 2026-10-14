import { AsyncLocalStorage } from "node:async_hooks";
import type { WorkspaceContext } from "@shared/workspace-context";
import { and, eq, inArray } from "drizzle-orm";
import { db, postgresRuntime } from "../db";
import { narratorBufferedMessages as mailbox, narrators } from "../db/schema";
import { getAllSessionStats } from "../lib/browser/session";
import { hotSafe } from "../lib/hot-safe";
import { createRuntimeMapView, hasRuntimeBufferSoftStop } from "./agent-runtime/ownership";
import * as state from "./narrator-session-state";

type RuntimeWorkspace = { cwd: string; deviceId: string; context?: WorkspaceContext };
const reservations = hotSafe(
	"narrafork.legacyMigrationRuntime.reservations",
	() =>
		new AsyncLocalStorage<{
			ids: Set<string>;
			live: boolean;
			workspaces?: Map<string, RuntimeWorkspace | null>;
		}>(),
);

/** Pure metadata survives cache eviction only inside the owning lifecycle admission. */
export function getLegacyMigrationRuntimeWorkspace(id: string): RuntimeWorkspace | null {
	const own = reservations.getStore();
	if (own?.live && own.workspaces?.has(id)) {
		const snapshot = own.workspaces.get(id);
		return snapshot ? structuredClone(snapshot) : null;
	}
	const active = state.activeNarrators.get(id);
	if (!active) return null;
	const row = postgresRuntime
		? undefined
		: db
				.select({
					workspaceContext: narrators.workspaceContext,
					workspaceRevision: narrators.workspaceRevision,
					defaultDeviceId: narrators.defaultDeviceId,
				})
				.from(narrators)
				.where(eq(narrators.id, id))
				.limit(1)
				.get();
	const deviceId = row?.workspaceContext
		? (row.defaultDeviceId ?? "local")
		: (active._defaultDeviceId ?? row?.defaultDeviceId ?? "local");
	const committed =
		row?.workspaceContext?.revision === row?.workspaceRevision &&
		row?.workspaceContext?.deviceId === deviceId
			? row.workspaceContext
			: undefined;
	const cwd = committed?.cwd ?? active.cwd;
	const context =
		committed ??
		(active._workspaceContext?.cwd === cwd && active._workspaceContext.deviceId === deviceId
			? active._workspaceContext
			: undefined);
	return structuredClone({ cwd, deviceId, ...(context ? { context } : {}) });
}
const childExecutions = createRuntimeMapView("subagentExecution");
const toolReplays = createRuntimeMapView("toolReplayCompletion");

/** Read existing hot registries only: never create a second background-task authority. */
function hasReflectionResources(id: string): boolean {
	for (const key of ["narrafork.pendingTaskReflections", "narrafork.pendingExitPlanReflections"]) {
		const resources: unknown = Reflect.get(globalThis, Symbol.for(key));
		if (resources === undefined) continue;
		if (!(resources instanceof Map)) return true;
		for (const pending of resources.values()) {
			if (!pending || typeof pending !== "object" || typeof pending.narratorId !== "string")
				return true;
			if (pending.narratorId === id || pending.broadcastTargetId === id) return true;
		}
	}
	return false;
}

function hasBackgroundResources(id: string): boolean {
	const read = (key: string): unknown => Reflect.get(globalThis, Symbol.for(key));
	const parents = read("narrafork:bg-task:parentNarratorCache");
	for (const key of ["abortControllers", "killHandlers", "activeAgentContinuations"]) {
		const resources = read(`narrafork:bg-task:${key}`);
		if (resources === undefined) continue;
		if (!(key === "activeAgentContinuations" ? resources instanceof Set : resources instanceof Map))
			return true;
		if (!(resources instanceof Map || resources instanceof Set)) return true;
		for (const taskId of resources.keys()) {
			if (!(parents instanceof Map) || !parents.has(taskId)) return true;
			if (parents.get(taskId) === id) return true;
		}
	}
	return false;
}

/** Preview is non-destructive; an idle cached session alone is not a runner. */
export function isLegacyMigrationRuntimeBusy(id: string): boolean {
	// A synchronous preview cannot prove remote queue quiescence; fail closed on PG.
	if (postgresRuntime) return true;
	const queued = db
		.select({ id: mailbox.id })
		.from(mailbox)
		.where(and(eq(mailbox.narratorId, id), inArray(mailbox.state, ["queued", "claimed", "failed"])))
		.limit(1)
		.get();
	if (queued) return true;
	const own = reservations.getStore();
	if (
		(!(own?.live && own.ids.has(id)) && state.isNarratorRevertAdmissionBlocked(id)) ||
		state.hasNarratorAdmissionWork(id) ||
		state.isNarratorMutationAdmissionBusy(id) ||
		state.isNarratorRuntimeBusy(id) ||
		state.narratorCreationLocks.has(id) ||
		state.compactLocks.has(id) ||
		hasRuntimeBufferSoftStop(id) ||
		state.activeSubagentSettings.has(id) ||
		toolReplays.has(id) ||
		state.pendingFeedback.has(id) ||
		state.pendingPlanCompact.has(id) ||
		state.pendingPlanApprover.has(id) ||
		state.pendingPlanApproverSource.has(id) ||
		state.pendingPlanDiff.has(id)
	)
		return true;
	for (const pending of [
		...state.pendingPermissions.values(),
		...state.pendingDangerReflections.values(),
		...state.pendingDangerConfirmations.values(),
	]) {
		if (
			pending.narratorId === id ||
			("broadcastTargetId" in pending && pending.broadcastTargetId === id)
		)
			return true;
	}
	for (const child of childExecutions.values()) {
		if (child.subagentId === id || child.parentNarratorId === id) return true;
	}
	const active = state.activeNarrators.get(id);
	if (
		active &&
		(active._loopRunning ||
			active._workspaceInstallFailed ||
			active._workspacePassInvalidated ||
			!(active._substatus instanceof Set) ||
			active._substatus.size > 0 ||
			active._modelRefreshPending ||
			active._modelUnavailableWaitCancel ||
			active._partialMessageId ||
			active._planApprovedContinue ||
			active._feedbackSoftStop ||
			active._bufferGuidancePending ||
			active._resumeBufferedAfterLoop ||
			active._guidanceAbortController ||
			active._urgentGuidanceAbortController ||
			active._preparedPlanModes?.size ||
			active._bashBeforeStatus?.size ||
			active._treeHashBefore?.size)
	)
		return true;
	// New/legacy runner fields are not silently treated as pure cache state.
	if (active)
		for (const [key, value] of Object.entries(active)) {
			if (key === "abortController" || value == null || value === false) continue;
			if (
				value instanceof Promise ||
				value instanceof AbortController ||
				(/runner|reflection|permission|pending/i.test(key) &&
					(typeof value === "function" ||
						(typeof value === "object" &&
							(!(value instanceof Map || value instanceof Set) || value.size > 0))))
			)
				return true;
		}
	if (hasBackgroundResources(id) || hasReflectionResources(id)) return true;
	return getAllSessionStats().narrators.some(
		(entry) => entry.narratorId === id && entry.sessionCount > 0,
	);
}

/** Reserve the entire lifecycle, unload only proved-idle caches, and never interrupt work. */
export async function withLegacyMigrationRuntimeAdmission<T>(
	ids: string[],
	body: () => Promise<T>,
): Promise<T | null> {
	const targets = [...new Set(ids)];
	if (targets.some(isLegacyMigrationRuntimeBusy)) return null;
	return state.withIdleNarratorCleanupAdmission(targets, async () => {
		const reservation = {
			ids: new Set(targets),
			live: true,
			workspaces: new Map<string, RuntimeWorkspace | null>(),
		};
		return reservations.run(reservation, async () => {
			try {
				if (targets.some(isLegacyMigrationRuntimeBusy)) return null;
				const observed = targets.map((id) => ({ id, active: state.activeNarrators.get(id) }));
				for (const { id } of observed) {
					reservation.workspaces.set(id, getLegacyMigrationRuntimeWorkspace(id));
				}
				const { unloadIdleNarratorSessionForLegacyMigration } = await import("./narrator-session");
				const stillIdle = () =>
					!targets.some(isLegacyMigrationRuntimeBusy) &&
					observed.every(({ id, active }) => state.activeNarrators.get(id) === active);
				if (!stillIdle()) return null;
				for (const entry of observed) {
					const { id, active } = entry;
					if (active && !(await unloadIdleNarratorSessionForLegacyMigration(id, active, stillIdle)))
						return null;
					// Removal is intentional; subsequent checks still pin all remaining instances.
					entry.active = undefined;
				}
				if (!stillIdle()) return null;
				return await body();
			} finally {
				reservation.live = false;
				reservation.workspaces.clear();
			}
		});
	});
}
