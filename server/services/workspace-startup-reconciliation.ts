import { fileChangeScopes, workspaceWriteLeases } from "@server/db/schema";
import { hotSafe } from "@server/lib/hot-safe";
import { logger } from "@server/lib/logger";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
	getDefaultLocalFileChangeRuntime,
	type LocalFileChangeRuntime,
} from "./file-change-runtime";
import {
	assertWorkspaceMaintenanceAuthority,
	initializeWorkspaceExecutionOwner,
	proveWorkspaceOwnerEnded,
	type WorkspaceOwnerEndedEvidence,
} from "./workspace-execution-owner";
import { createWorkspaceScopeRecovery } from "./workspace-scope-recovery";

export const WORKSPACE_STARTUP_RECONCILIATION_LIMITS = Object.freeze({
	pageItems: 16,
	maxItems: 128,
	durationMs: 30_000,
});

type RuntimeDb = typeof import("../db").db;
type RecoveryRuntime = Pick<LocalFileChangeRuntime, "coordinator">;
export interface WorkspaceStartupReconciliationDeps {
	database: RuntimeDb;
	runtime: RecoveryRuntime;
	assertAuthority(): void;
	proveOwnerEnded(ownerEpoch: string): Promise<WorkspaceOwnerEndedEvidence | null>;
	reconcile(scopeId: string, leaseId: string, signal: AbortSignal): Promise<unknown>;
}

/** Small indexed pages; no raw file/effect bodies and no process probes on a write hot path. */
export async function reconcileWorkspaceOwnersOnStartup(
	deps: WorkspaceStartupReconciliationDeps,
	signal?: AbortSignal,
) {
	const started = performance.now();
	const bounded = AbortSignal.any([
		AbortSignal.timeout(WORKSPACE_STARTUP_RECONCILIATION_LIMITS.durationMs),
		...(signal ? [signal] : []),
	]);
	const result = { inspected: 0, reconciled: 0, deferred: 0, stopped: false };
	let cursor: string | undefined;
	// Cache positive AND negative observations only for this bounded startup pass.
	const proofs = new Map<string, WorkspaceOwnerEndedEvidence | null>();
	try {
		deps.assertAuthority();
		while (result.inspected < WORKSPACE_STARTUP_RECONCILIATION_LIMITS.maxItems) {
			bounded.throwIfAborted();
			deps.assertAuthority();
			const rows = deps.database
				.select({
					leaseId: workspaceWriteLeases.leaseId,
					scopeId: workspaceWriteLeases.scopeId,
					ownerEpoch: workspaceWriteLeases.ownerEpoch,
					endedAt: workspaceWriteLeases.executionEndedAt,
					scopeStatus: fileChangeScopes.status,
				})
				.from(workspaceWriteLeases)
				.innerJoin(fileChangeScopes, eq(fileChangeScopes.id, workspaceWriteLeases.scopeId))
				.where(
					and(
						eq(workspaceWriteLeases.deviceId, "local"),
						eq(workspaceWriteLeases.executionClass, "local_file_io"),
						inArray(workspaceWriteLeases.status, ["executing", "quarantined"]),
						inArray(fileChangeScopes.status, ["active", "needs_verification"]),
						cursor ? gt(workspaceWriteLeases.leaseId, cursor) : undefined,
					),
				)
				.orderBy(asc(workspaceWriteLeases.leaseId))
				.limit(WORKSPACE_STARTUP_RECONCILIATION_LIMITS.pageItems)
				.all();
			if (!rows.length) break;
			for (const row of rows) {
				bounded.throwIfAborted();
				deps.assertAuthority();
				cursor = row.leaseId;
				result.inspected++;
				try {
					if (!row.endedAt) {
						if (!proofs.has(row.ownerEpoch)) {
							proofs.set(row.ownerEpoch, await deps.proveOwnerEnded(row.ownerEpoch));
						}
						bounded.throwIfAborted();
						const proof = proofs.get(row.ownerEpoch);
						if (!proof) {
							result.deferred++;
							continue;
						}
						deps.runtime.coordinator.recordLocalOwnerTermination(row.leaseId, proof);
					}
					bounded.throwIfAborted();
					// Persisting native-IO termination is useful even under an independent
					// root/Bash barrier, but cannot authorize automatic file reconciliation.
					if (row.scopeStatus !== "active") {
						result.deferred++;
						continue;
					}
					const outcome = await deps.reconcile(row.scopeId, row.leaseId, bounded);
					if (
						outcome &&
						typeof outcome === "object" &&
						"recovered" in outcome &&
						outcome.recovered === false
					) {
						result.deferred++;
					} else {
						result.reconciled++;
					}
				} catch (error) {
					if (bounded.aborted) throw error;
					result.deferred++;
					logger.warn("Workspace startup reconciliation left a barrier for inspection", {
						leaseId: row.leaseId,
						scopeId: row.scopeId,
						error: String(error),
					});
				}
			}
			// Let request/WS work run between pages; never a synchronous full-inventory scan.
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	} catch (error) {
		result.stopped = true;
		logger.info("Workspace startup reconciliation stopped without clearing unproven barriers", {
			error: String(error),
		});
	}
	logger.info("Workspace startup reconciliation completed", {
		...result,
		elapsedMs: Math.round(performance.now() - started),
	});
	return result;
}

const startup = hotSafe("narrafork.workspace-startup-reconciliation.v1", () => ({
	initialization: undefined as
		| Promise<{ runtime: LocalFileChangeRuntime; database: RuntimeDb }>
		| undefined,
	task: undefined as Promise<unknown> | undefined,
	controller: new AbortController(),
}));

export function initializeWorkspaceOwnerOnStartup(): Promise<{
	runtime: LocalFileChangeRuntime;
	database: RuntimeDb;
}> {
	startup.initialization ??= Promise.all([
		getDefaultLocalFileChangeRuntime(),
		import("../db"),
	]).then(async ([runtime, { db }]) => {
		await initializeWorkspaceExecutionOwner(db, runtime.coordinator.ownerEpoch());
		return { runtime, database: db };
	});
	return startup.initialization;
}

/** Start after owner registration; --hot never starts a second scan or reassigns an old owner. */
export function startWorkspaceStartupReconciliation(): void {
	if (startup.task || startup.controller.signal.aborted) return;
	startup.task = initializeWorkspaceOwnerOnStartup()
		.then(({ runtime, database }) => {
			const recovery = createWorkspaceScopeRecovery({ database, getRuntime: async () => runtime });
			return reconcileWorkspaceOwnersOnStartup(
				{
					database,
					runtime,
					assertAuthority: assertWorkspaceMaintenanceAuthority,
					proveOwnerEnded: (epoch) => proveWorkspaceOwnerEnded(database, epoch),
					reconcile: (scopeId, leaseId, signal) =>
						recovery.reconcileWorkspaceBarrier(scopeId, leaseId, signal),
				},
				startup.controller.signal,
			);
		})
		.catch((error) => {
			logger.warn("Workspace owner startup registration or reconciliation unavailable", {
				error: String(error),
			});
		});
}

export async function stopWorkspaceStartupReconciliation(): Promise<void> {
	startup.controller.abort(new Error("Server is shutting down"));
	await startup.task;
}
