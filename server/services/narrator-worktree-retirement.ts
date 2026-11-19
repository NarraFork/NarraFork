/**
 * Production side effects of retiring one worktree.
 *
 * Split out of {@link NarratorWorktreeService} on purpose: that service owns Git,
 * authorization and the removal sequence while staying database-free, which is what the
 * fixture tests exercise. Everything here is the opposite — sessions, runtime objects and
 * durable rows — so it lives behind an injected port group, and is reached only once the
 * sequence has decided the order.
 *
 * Two invariants drive every method:
 *
 * 1. A protection claim is `narrators.cwd` / `workspace_context.cwd`, not a status. An
 *    archived conversation still claims its directory, so "archive it" is never enough:
 *    the removal also has to relocate it. That is why `relocate` exists at all.
 * 2. Nothing may be deleted underneath something still using it. Terminals go before the
 *    owner row (`onDelete: restrict`), and background work is cancelled and proven
 *    stopped before Git touches the directory.
 */
import type { WorktreeDependent, WorktreeRemovalInventory } from "@shared/narrator-worktrees";
import { withDeviceDirectory } from "@shared/workspace-directories";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	containerInstances,
	narrators,
	narratorWorktreeResources,
	portAllocations,
	terminals,
	terminalViewState,
	volumeSnapshotApplications,
	volumeSnapshots,
	worktreeTreeSnapshots,
} from "../db/schema";
import { localPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError, NotFoundError } from "../lib/errors";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { backgroundTaskService } from "./background-task-service";
import { isNarratorRuntimeBusy } from "./narrator-session-state";
import type {
	WorktreeRegistrationSnapshot,
	WorktreeRetirementInspection,
	WorktreeRetirementPorts,
} from "./narrator-worktree-service";
import { syncNarratorProjectLinksSafely } from "./project-index";
import { interruptAndArchiveSubagent } from "./subagent-lifecycle";
import { terminalService } from "./terminal-service";
import { prepareLocalWorkspaceContext, workspaceContextService } from "./workspace-context-service";
import { workspaceConflict } from "./workspace-context-transition";
import { withWorkspaceAdmission } from "./worktree-lifecycle-guard";

/** Bound on the dependent scan; exceeding it is a refusal, never a truncated answer. */
const MAX_DEPENDENTS = 200;
const MAX_INVENTORY_ROWS = 501;
const MAX_OWNED_TERMINALS = 500;
/** How long a cancelled background task may take to actually stop before we give up. */
const TASK_STOP_TIMEOUT_MS = 2000;
const TASK_STOP_POLL_MS = 50;

const directorySeparator = () => (localPathSemantics.flavor === "windows" ? "\\" : "/");
const contextCwd = sql<string | null>`json_extract(${narrators.workspaceContext}, '$.cwd')`;
const contextDevice = sql<string | null>`json_extract(${narrators.workspaceContext}, '$.deviceId')`;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The device a recorded path belongs to; only `local` paths are claims on this host. */
function pathDevice(
	row: { defaultDeviceId: string | null; contextDevice: string | null },
	viaContext: boolean,
): string {
	return viaContext
		? (row.contextDevice ?? row.defaultDeviceId ?? "local")
		: (row.defaultDeviceId ?? "local");
}

async function countBrowserSessions(narratorId: string): Promise<number> {
	try {
		const { listSessions } = await import("../lib/browser/session");
		return listSessions(narratorId).length;
	} catch {
		return 0;
	}
}

/** Narrator-owned shells whose directory is inside the checkout. Bounded, never aggregated. */
async function ownedTerminalsInPath(worktreePath: string) {
	const owned = await db
		.select({ id: terminals.id, cwd: terminals.cwd })
		.from(terminals)
		.where(isNull(terminals.worktreeResourceId))
		.limit(MAX_OWNED_TERMINALS);
	return owned.filter(
		(terminal) => terminal.cwd && localPathSemantics.contains(worktreePath, terminal.cwd),
	);
}

/**
 * Escape LIKE metacharacters for a prefix match bound with `ESCAPE '\'`.
 *
 * The escape clause is not optional: without it SQLite treats `\` as an ordinary
 * character, so a worktree named `feat_x` would search for the literal `feat\_x` and
 * silently find no dependents at all.
 */
export function escapeLikePrefix(value: string): string {
	return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * Sessions whose effective directory lives inside the worktree.
 *
 * The predicate is deliberately generous — `LIKE prefix%` in SQL, exact containment in
 * JS — because a missed dependency means deleting a directory out from under a live
 * session, while a false positive only costs one extra row in a confirmation list.
 */
async function findDependents(
	worktreePath: string,
	requestorId: string,
): Promise<{ dependents: WorktreeDependent[]; truncated: boolean }> {
	const separator = directorySeparator();
	const prefix = worktreePath.endsWith(separator) ? worktreePath : `${worktreePath}${separator}`;
	const pattern = `${escapeLikePrefix(prefix)}%`;
	const cwdPrefix = sql`${narrators.cwd} like ${pattern} escape '\\'`;
	const contextPrefix = sql`${contextCwd} like ${pattern} escape '\\'`;
	const rows = await db
		.select({
			id: narrators.id,
			title: narrators.title,
			status: narrators.status,
			type: narrators.type,
			cwd: narrators.cwd,
			defaultDeviceId: narrators.defaultDeviceId,
			contextCwd,
			contextDevice,
		})
		.from(narrators)
		.where(
			or(eq(narrators.cwd, worktreePath), cwdPrefix, eq(contextCwd, worktreePath), contextPrefix),
		)
		.orderBy(narrators.id)
		.limit(MAX_DEPENDENTS + 1);
	const truncated = rows.length > MAX_DEPENDENTS;
	const dependents: WorktreeDependent[] = [];
	for (const row of rows.slice(0, MAX_DEPENDENTS)) {
		// Re-decide in the engine's own path semantics: LIKE is case-insensitive for ASCII
		// and knows nothing about separators or drive letters.
		const devices = { defaultDeviceId: row.defaultDeviceId, contextDevice: row.contextDevice };
		const byCwd =
			row.cwd !== null &&
			pathDevice(devices, false) === "local" &&
			localPathSemantics.contains(worktreePath, row.cwd);
		const byContext =
			row.contextCwd !== null &&
			pathDevice(devices, true) === "local" &&
			localPathSemantics.contains(worktreePath, row.contextCwd);
		if (!byCwd && !byContext) continue;
		dependents.push({
			id: row.id,
			title: row.title ?? null,
			status: row.status,
			kind: row.id === requestorId ? "self" : row.type === "subagent" ? "subagent" : "primary",
			running:
				row.status === "working" || row.status === "waiting" || isNarratorRuntimeBusy(row.id),
		});
	}
	return { dependents, truncated };
}

export function createWorktreeRetirementPorts(): WorktreeRetirementPorts {
	return {
		async inspect(input): Promise<WorktreeRetirementInspection> {
			const { worktreePath, requestorId, signal } = input;
			signal.throwIfAborted();
			const registration = await db
				.select({
					id: narratorWorktreeResources.id,
					state: narratorWorktreeResources.state,
				})
				.from(narratorWorktreeResources)
				.where(
					and(
						eq(narratorWorktreeResources.deviceId, "local"),
						eq(narratorWorktreeResources.worktreePath, worktreePath),
					),
				)
				.limit(1)
				.get();
			const requestor = await db
				.select({ revision: narrators.workspaceRevision })
				.from(narrators)
				.where(eq(narrators.id, requestorId))
				.limit(1)
				.get();
			if (!requestor) throw new NotFoundError("Narrator", requestorId);
			signal.throwIfAborted();
			const { dependents, truncated } = await findDependents(worktreePath, requestorId);
			signal.throwIfAborted();
			let backgroundTasks = 0;
			let browserSessions = 0;
			for (const dependent of dependents) {
				backgroundTasks += await backgroundTaskService.countActiveByParent(dependent.id);
				browserSessions += await countBrowserSessions(dependent.id);
			}
			const resourceId = registration?.id ?? null;
			const resourceTerminals = resourceId
				? await db
						.select({ id: terminals.id })
						.from(terminals)
						.where(eq(terminals.worktreeResourceId, resourceId))
						.limit(MAX_INVENTORY_ROWS)
				: [];
			const ownedTerminals = await ownedTerminalsInPath(worktreePath);
			const containers = resourceId
				? await db
						.select({ id: containerInstances.id })
						.from(containerInstances)
						.where(eq(containerInstances.worktreeResourceId, resourceId))
						.limit(MAX_INVENTORY_ROWS)
				: [];
			const snapshots = resourceId
				? await db
						.select({ id: volumeSnapshots.id })
						.from(volumeSnapshots)
						.where(eq(volumeSnapshots.sourceWorktreeResourceId, resourceId))
						.limit(MAX_INVENTORY_ROWS)
				: [];
			const applications = resourceId
				? await db
						.select({ id: volumeSnapshotApplications.id })
						.from(volumeSnapshotApplications)
						.where(eq(volumeSnapshotApplications.targetWorktreeResourceId, resourceId))
						.limit(MAX_INVENTORY_ROWS)
				: [];
			const trees = await db
				.select({ id: worktreeTreeSnapshots.id })
				.from(worktreeTreeSnapshots)
				.where(
					and(
						eq(worktreeTreeSnapshots.deviceId, "local"),
						eq(worktreeTreeSnapshots.worktreePath, worktreePath),
					),
				)
				.limit(MAX_INVENTORY_ROWS);
			signal.throwIfAborted();
			const inventory: WorktreeRemovalInventory = {
				backgroundTasks,
				browserSessions,
				terminals: resourceTerminals.length + ownedTerminals.length,
				containers: containers.length,
				volumeSnapshots: snapshots.length + applications.length,
				treeSnapshots: trees.length,
			};
			return {
				registration: registration ?? null,
				dependents,
				inventory,
				truncated,
				revision: requestor.revision,
			};
		},

		async relocate(input) {
			const { dependent, mode, rootPath, worktreePath, signal } = input;
			signal.throwIfAborted();
			const row = await db
				.select({
					cwd: narrators.cwd,
					status: narrators.status,
					workspaceRevision: narrators.workspaceRevision,
					contextProjectId: narrators.contextProjectId,
					workspaceDirectories: narrators.workspaceDirectories,
				})
				.from(narrators)
				.where(eq(narrators.id, dependent.id))
				.limit(1)
				.get();
			if (!row) throw new NotFoundError("Narrator", dependent.id);
			// Still inside the doomed directory? A previous attempt may have moved it already.
			if (row.cwd && !localPathSemantics.contains(worktreePath, row.cwd))
				return { relocated: false };
			if (
				row.status === "working" ||
				row.status === "waiting" ||
				isNarratorRuntimeBusy(dependent.id)
			)
				throw workspaceConflict("Narrator is busy", "WORKSPACE_CONTEXT_BUSY");
			if (mode === "switch") {
				try {
					await workspaceContextService.switch(
						dependent.id,
						{
							expectedRevision: row.workspaceRevision,
							requestId: generateId(),
							target: { deviceId: "local", cwd: rootPath },
						},
						{ origin: "http" },
					);
					return { relocated: true };
				} catch (error) {
					// A specialized session cannot take a user-visible directory switch, but its
					// protection claim still has to be released; fall through to the silent repair.
					if (!(error instanceof AppError) || error.code !== "WORKSPACE_CONTEXT_UNSUPPORTED")
						throw error;
				}
			}
			// `repair`: silently relocate a session nobody is looking at. A real switch
			// refuses specialized sessions (subagents, background and steward narrators), and
			// leaving one behind would keep its protection claim forever.
			const current = await workspaceContextService.getForDirectorySwitch(dependent.id);
			const prepared = await prepareLocalWorkspaceContext(
				rootPath,
				current.revision + 1,
				row.contextProjectId ?? undefined,
			);
			await withWorkspaceAdmission(
				{ deviceId: "local", path: prepared.cwd, repositoryKey: prepared.git?.repositoryKey },
				async () => {
					const updated = await db
						.update(narrators)
						.set({
							cwd: prepared.cwd,
							defaultDeviceId: null,
							workspaceRevision: prepared.revision,
							workspaceContext: prepared,
							workspaceDirectories: withDeviceDirectory(row.workspaceDirectories, "local", {
								cwd: prepared.cwd,
								pathFlavor: prepared.pathFlavor,
							}),
						})
						.where(
							and(
								eq(narrators.id, dependent.id),
								eq(narrators.workspaceRevision, row.workspaceRevision),
							),
						)
						.returning({ id: narrators.id });
					if (updated.length !== 1)
						throw workspaceConflict("Workspace identity changed", "WORKSPACE_CONTEXT_STALE");
				},
			);
			broadcastToNarrator(dependent.id, {
				type: "workspace_context_changed",
				narratorId: dependent.id,
				previous: current,
				current: prepared,
			});
			// The directory may now belong to another project.
			void syncNarratorProjectLinksSafely(dependent.id);
			return { relocated: true };
		},

		async stopRuntime(input) {
			const { dependent, worktreePath, signal } = input;
			signal.throwIfAborted();
			const cancelledTasks = await backgroundTaskService.cancelRunningByParent(dependent.id);
			const deadline = Date.now() + TASK_STOP_TIMEOUT_MS;
			while (await backgroundTaskService.countActiveByParent(dependent.id)) {
				if (Date.now() >= deadline)
					throw new AppError(
						"A background task in this worktree did not stop in time",
						409,
						"WORKTREE_REMOVAL_TASK_STOP_TIMEOUT",
					);
				await sleep(TASK_STOP_POLL_MS);
				signal.throwIfAborted();
			}
			const closedBrowsers = await countBrowserSessions(dependent.id);
			if (closedBrowsers > 0) {
				const { cleanupNarrator } = await import("../lib/browser/session");
				await cleanupNarrator(dependent.id).catch((error) => {
					logger.warn("Failed to close browser sessions for a removed worktree", {
						narratorId: dependent.id,
						error: String(error),
					});
				});
			}
			// The requesting session keeps running: it is only leaving the directory.
			if (dependent.kind !== "self") {
				const { closeNarrator, isNarratorActive } = await import("./narrator-session");
				if (isNarratorActive(dependent.id)) closeNarrator(dependent.id);
			}
			logger.info("Closed runtime for a worktree dependent", {
				narratorId: dependent.id,
				worktreePath,
				cancelledTasks,
				closedBrowsers,
			});
			return { cancelledTasks, closedBrowsers };
		},

		async archiveSubagent(dependent) {
			const result = await interruptAndArchiveSubagent(dependent.id);
			// A subagent row that vanished mid-removal is already retired.
			if (!result.ok && result.error !== "not_found")
				throw new AppError(
					`Failed to archive a subagent in this worktree: ${result.error ?? "unknown"}`,
					409,
					"WORKTREE_REMOVAL_SUBAGENT_ARCHIVE_FAILED",
				);
		},

		async releaseAttachments(input) {
			const { registrationId, worktreePath } = input;
			const result = await terminalService.cleanupForWorktree({
				worktreeResourceId: registrationId,
				worktreePath,
			});
			if (registrationId) {
				await db
					.delete(terminalViewState)
					.where(eq(terminalViewState.worktreeResourceId, registrationId));
				await db
					.delete(portAllocations)
					.where(eq(portAllocations.worktreeResourceId, registrationId));
			}
			return result;
		},

		async releaseRegistration(input): Promise<WorktreeRegistrationSnapshot | null> {
			const { registrationId, worktreePath } = input;
			const row = await db
				.select({
					id: narratorWorktreeResources.id,
					ownerNarratorId: narratorWorktreeResources.ownerNarratorId,
					deviceId: narratorWorktreeResources.deviceId,
					repositoryKey: narratorWorktreeResources.repositoryKey,
					worktreePath: narratorWorktreeResources.worktreePath,
					createRequestId: narratorWorktreeResources.createRequestId,
					scopeKind: narratorWorktreeResources.scopeKind,
					scopeProjectId: narratorWorktreeResources.scopeProjectId,
					scopeOwnerUserId: narratorWorktreeResources.scopeOwnerUserId,
					ownershipRevision: narratorWorktreeResources.ownershipRevision,
					state: narratorWorktreeResources.state,
					containerConfig: narratorWorktreeResources.containerConfig,
					createdAt: narratorWorktreeResources.createdAt,
				})
				.from(narratorWorktreeResources)
				.where(
					and(
						eq(narratorWorktreeResources.id, registrationId),
						eq(narratorWorktreeResources.worktreePath, worktreePath),
					),
				)
				.limit(1)
				.get();
			if (!row) return null;
			await withWorkspaceAdmission(
				{
					deviceId: row.deviceId,
					path: row.worktreePath,
					repositoryKey: row.repositoryKey,
					scopeProjectId: row.scopeProjectId ?? undefined,
				},
				async () => {
					await db
						.delete(narratorWorktreeResources)
						.where(
							and(
								eq(narratorWorktreeResources.id, registrationId),
								eq(narratorWorktreeResources.worktreePath, worktreePath),
							),
						);
				},
			);
			return { ...row };
		},

		async restoreRegistration(snapshot) {
			await withWorkspaceAdmission(
				{
					deviceId: snapshot.deviceId,
					path: snapshot.worktreePath,
					repositoryKey: snapshot.repositoryKey,
					scopeProjectId: snapshot.scopeProjectId ?? undefined,
				},
				async () => {
					await db
						.insert(narratorWorktreeResources)
						.values({
							...snapshot,
							// The checkout's real state is unknown after a failed removal; that is
							// exactly what this state means on the creation path too.
							state: "unknown",
							updatedAt: new Date().toISOString(),
						})
						.onConflictDoNothing();
				},
			);
		},

		async releasePathRows(worktreePath) {
			const removed = await db
				.delete(worktreeTreeSnapshots)
				.where(
					and(
						eq(worktreeTreeSnapshots.deviceId, "local"),
						eq(worktreeTreeSnapshots.worktreePath, worktreePath),
					),
				)
				.returning({ id: worktreeTreeSnapshots.id });
			// Destroyed worktrees must not retain their last Git status anywhere.
			await import("./git-status-cache")
				.then(({ dropStatus }) => dropStatus(worktreePath))
				.catch((error) => {
					logger.warn("Failed to drop cached status for a removed worktree", {
						worktreePath,
						error: String(error),
					});
				});
			return removed.length;
		},
	};
}
