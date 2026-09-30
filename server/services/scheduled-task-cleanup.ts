import type { ScheduledTaskCleanupResult } from "@shared/scheduled-task-cleanup";
import { and, desc, eq, inArray, lt, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	backgroundTasks,
	narratorMessages,
	narrators,
	narratorToolCalls,
	scheduledTasks,
	terminals,
} from "../db/schema";
import { AsyncMutex } from "../lib/async-mutex";
import { NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { buildNarratorCleanupPlan } from "./database-cleanup-utils";
import { narratorService } from "./narrator-service";
import { isLoopRunning } from "./narrator-session";
import { withIdleNarratorCleanupAdmission } from "./narrator-session-state";

export const TASK_CLEANUP_ROOT_LIMIT = 10;
const SUBTREE_LIMIT = 100;
const BATCH_BUDGET_MS = 500;
const cleanupLock = new AsyncMutex();
// Advance past protected roots, rather than letting the same 10 pin an entire backlog.
// This is only a scanning hint: retention boundaries are recomputed on every invocation.
const scanCursors = new Map<string, { policy: string; createdAt: string; id: string }>();

// Never SELECT *: narrator rows contain prompts and other potentially large fields.
const cleanupColumns = {
	id: narrators.id,
	parentNarratorId: narrators.parentNarratorId,
	chapterId: narrators.chapterId,
	scheduledTaskId: narrators.scheduledTaskId,
	ownerUserId: narrators.ownerUserId,
	type: narrators.type,
	variant: narrators.variant,
	traits: narrators.traits,
	title: narrators.title,
	status: narrators.status,
	messageCount: narrators.messageCount,
	createdAt: narrators.createdAt,
	updatedAt: narrators.updatedAt,
	lastMessageAt: narrators.lastMessageAt,
	isBackground: narrators.isBackground,
	backgroundStatus: narrators.backgroundStatus,
};
type CleanupRow = typeof narrators.$inferSelect;
type TreeRow = Pick<CleanupRow, keyof typeof cleanupColumns>;

/** A truncated subtree must never reach remove(): that method recursively deletes it. */
async function loadBoundedSubtree(root: TreeRow): Promise<TreeRow[] | null> {
	const rows = [root];
	const seen = new Set([root.id]);
	let frontier = [root.id];
	while (frontier.length) {
		const children = await db
			.select(cleanupColumns)
			.from(narrators)
			.where(inArray(narrators.parentNarratorId, frontier))
			.limit(SUBTREE_LIMIT - rows.length + 1);
		if (rows.length + children.length > SUBTREE_LIMIT) return null;
		frontier = [];
		for (const child of children) {
			if (seen.has(child.id)) return null;
			seen.add(child.id);
			rows.push(child);
			frontier.push(child.id);
		}
	}
	return rows;
}

/** One task, one small batch; no all-narrator inventory, COUNT, VACUUM or history deletion. */
export async function cleanupScheduledTaskNarrators(
	taskId: string,
): Promise<ScheduledTaskCleanupResult> {
	return cleanupLock.acquire(taskId, async () => {
		const task = await db.query.scheduledTasks.findFirst({
			where: eq(scheduledTasks.id, taskId),
			columns: { cleanupPolicy: true, reuseNarratorId: true, createdBy: true },
		});
		if (!task) throw new NotFoundError("ScheduledTask", taskId);
		const policy = task.cleanupPolicy;
		const result: ScheduledTaskCleanupResult = {
			deletedRoots: 0,
			deletedNarrators: 0,
			blockedRoots: 0,
			limited: false,
		};
		if (policy.mode === "none") {
			scanCursors.delete(taskId);
			return result;
		}
		const startedAt = performance.now();
		const cutoff =
			policy.mode === "olderThanDays"
				? new Date(Date.now() - policy.olderThanDays * 86_400_000).toISOString()
				: undefined;
		const policyKey = JSON.stringify(policy);
		const cursor = scanCursors.get(taskId);
		const activeCursor = cursor?.policy === policyKey ? cursor : undefined;
		// One indexed boundary lookup, even if protected roots exist or new runs were added.
		const boundary =
			policy.mode === "keepLatestN"
				? (
						await db
							.select({ createdAt: narrators.createdAt, id: narrators.id })
							.from(narrators)
							.where(eq(narrators.scheduledTaskId, taskId))
							.orderBy(desc(narrators.createdAt), desc(narrators.id))
							.offset(policy.keepLatestN)
							.limit(1)
					)[0]
				: undefined;
		if (policy.mode === "keepLatestN" && !boundary) {
			scanCursors.delete(taskId);
			return result;
		}
		// The covering (task, createdAt, id) index supplies the retention ordering.
		const candidates = await db
			.select(cleanupColumns)
			.from(narrators)
			.where(
				and(
					eq(narrators.scheduledTaskId, taskId),
					cutoff ? lt(narrators.createdAt, cutoff) : undefined,
					boundary
						? or(
								lt(narrators.createdAt, boundary.createdAt),
								and(eq(narrators.createdAt, boundary.createdAt), lte(narrators.id, boundary.id)),
							)
						: undefined,
					activeCursor
						? or(
								lt(narrators.createdAt, activeCursor.createdAt),
								and(
									eq(narrators.createdAt, activeCursor.createdAt),
									lt(narrators.id, activeCursor.id),
								),
							)
						: undefined,
				),
			)
			.orderBy(desc(narrators.createdAt), desc(narrators.id))
			.limit(TASK_CLEANUP_ROOT_LIMIT + 1);
		result.limited = candidates.length > TASK_CLEANUP_ROOT_LIMIT;
		for (const root of candidates.slice(0, TASK_CLEANUP_ROOT_LIMIT)) {
			if (performance.now() - startedAt > BATCH_BUDGET_MS) {
				result.limited = true;
				break;
			}
			if (scanCursors.size >= 500 && !scanCursors.has(taskId)) {
				const oldest = scanCursors.keys().next().value;
				if (oldest) scanCursors.delete(oldest);
			}
			scanCursors.set(taskId, { policy: policyKey, createdAt: root.createdAt, id: root.id });
			// A task may switch from new to reuse; never erase its remembered live session.
			if (root.id === task.reuseNarratorId || root.ownerUserId !== task.createdBy) {
				result.blockedRoots++;
				continue;
			}
			const observed = await loadBoundedSubtree(root);
			if (!observed) {
				result.blockedRoots++;
				continue;
			}
			const deleted = await withIdleNarratorCleanupAdmission(
				observed.map((n) => n.id),
				async () => {
					// Re-read the complete bounded tree under the lifecycle reservation. In particular,
					// a start/resume/fork that won admission must never be interrupted for retention.
					const current = (
						await db
							.select(cleanupColumns)
							.from(narrators)
							.where(eq(narrators.id, root.id))
							.limit(1)
					)[0];
					if (
						!current ||
						current.scheduledTaskId !== taskId ||
						current.ownerUserId !== task.createdBy
					)
						return null;
					const subtree = await loadBoundedSubtree(current);
					const observedIds = new Set(observed.map((n) => n.id));
					if (
						!subtree ||
						subtree.some(
							(n) => !observedIds.has(n.id) || (n.scheduledTaskId && n.scheduledTaskId !== taskId),
						)
					)
						return null;
					// Do not delete a root that another task currently depends on, even if this task created it.
					const ids = subtree.map((n) => n.id);
					const referenced = await db
						.select({ id: scheduledTasks.id })
						.from(scheduledTasks)
						.where(
							and(
								ne(scheduledTasks.id, taskId),
								or(
									inArray(scheduledTasks.reuseNarratorId, ids),
									inArray(scheduledTasks.lastNarratorId, ids),
								),
							),
						)
						.limit(1);
					if (referenced.some((t) => t.id !== taskId)) return null;
					const activeTasks = await db
						.select({ id: backgroundTasks.id })
						.from(backgroundTasks)
						.where(
							and(
								or(
									inArray(backgroundTasks.parentNarratorId, ids),
									inArray(backgroundTasks.subagentNarratorId, ids),
								),
								inArray(backgroundTasks.status, ["running", "paused"]),
							),
						)
						.limit(1);
					if (activeTasks.length) return null;
					const running = await db
						.select({ narratorId: terminals.narratorId })
						.from(terminals)
						.where(and(inArray(terminals.narratorId, ids), eq(terminals.status, "running")))
						.limit(1);
					const plan = buildNarratorCleanupPlan(
						"scheduledSessions",
						subtree.map((n) => ({
							...n,
							messageCount: n.messageCount ?? 0,
							status: isLoopRunning(n.id) ? "running" : n.status,
						})),
						{
							rootNarratorIds: new Set([root.id]),
							staleCutoffIso: cutoff,
							runningTerminalIds: new Set(
								running.flatMap((t) => (t.narratorId ? [t.narratorId] : [])),
							),
						},
					);
					if (!plan.safeRoots.length) return null;
					// Existing removal materializes/shared-history rows synchronously. Refuse giant
					// sessions on this hot path; LIMIT probes do not fetch content or run COUNT.
					const messages = await db
						.select({
							id: narratorMessages.id,
							bytes: sql<number>`COALESCE(length(CAST(${narratorMessages.contentJson} AS BLOB)), 0)`,
						})
						.from(narratorMessages)
						.where(inArray(narratorMessages.narratorId, ids))
						.limit(1001);
					const tools = await db
						.select({ id: narratorToolCalls.id })
						.from(narratorToolCalls)
						.where(inArray(narratorToolCalls.narratorId, ids))
						.limit(1001);
					if (
						messages.length > 1000 ||
						tools.length > 1000 ||
						messages.reduce((total, row) => total + row.bytes, 0) > 2 * 1024 * 1024
					)
						return null;
					// TODO: extend the byte budget to snapshots, patches, API requests and completed
					// background output; they are not fetched by this bounded metadata probe yet.
					// No new implementation of destructive deletion: preserve existing refs/uploads semantics.
					await narratorService.remove(root.id);
					await db
						.update(scheduledTasks)
						.set({ lastNarratorId: null })
						.where(and(eq(scheduledTasks.id, taskId), inArray(scheduledTasks.lastNarratorId, ids)));
					return subtree.length;
				},
			);
			if (deleted === null) {
				result.blockedRoots++;
				continue;
			}
			result.deletedRoots++;
			result.deletedNarrators += deleted;
			// Yield between roots, including when SQLite calls happened to resolve synchronously.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		if (!result.limited) scanCursors.delete(taskId);
		if (performance.now() - startedAt > BATCH_BUDGET_MS) {
			logger.warn("Slow scheduled task narrator cleanup", { taskId, ...result });
		}
		return result;
	});
}
