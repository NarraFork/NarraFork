/** User deletion keeps scheduled work owned; deployed FK actions cannot be relied on. */
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
	gatewaySessionMappings,
	narratorMessages,
	narrators,
	projects,
	scheduledTasks,
	userPluginThemes,
	users,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { taskOwnerWhere } from "./scheduled-task-acl";

/** Transaction handle as produced by `db.transaction((tx) => …)`. SQLite-side only. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const USER_TASK_TRANSFER_PAGE_SIZE = 50;
/** Bound synchronous deletion work; exceptional legacy accounts must transfer tasks first. */
export const USER_TASK_TRANSFER_MAX = 200;

export async function previewUserScheduledTaskTransfer(userId: string, cursor?: string) {
	if (cursor !== undefined && (!cursor || cursor.length > 64)) {
		throw new AppError("Invalid transfer preview cursor", 400, "VALIDATION_ERROR");
	}
	const rows = await db
		.select({
			id: scheduledTasks.id,
			name: sql<string>`substr(${scheduledTasks.name}, 1, 200)`,
			enabled: scheduledTasks.enabled,
			completedAt: scheduledTasks.completedAt,
		})
		.from(scheduledTasks)
		.where(and(taskOwnerWhere(userId), cursor ? gt(scheduledTasks.id, cursor) : undefined))
		.orderBy(asc(scheduledTasks.id))
		.limit(USER_TASK_TRANSFER_PAGE_SIZE + 1);
	const items = rows.slice(0, USER_TASK_TRANSFER_PAGE_SIZE);
	return {
		items,
		nextCursor: rows.length > USER_TASK_TRANSFER_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
	};
}

/**
 * Runs in the same transaction as deleting the user. No run row / historical principal is
 * changed, and no saved permission mode, system prompt or scheduler state is widened.
 */
export function transferScheduledTasksBeforeUserDeletion(
	tx: DbTransaction,
	userId: string,
	actingUserId: string,
	confirmed: boolean,
): { taskIds: string[]; narratorIds: string[] } {
	const actor = tx
		.select({ id: users.id, role: users.role })
		.from(users)
		.where(eq(users.id, actingUserId))
		.get();
	if (!actor || actor.role !== "admin" || actingUserId === userId) {
		throw new AppError("An acting administrator is required", 403, "FORBIDDEN");
	}
	const target = tx
		.select({ username: users.username })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (!target) throw new AppError("User not found", 404, "NOT_FOUND");
	// Includes creator-only rows so their immutable display snapshot survives FK release too.
	const tasks = tx
		.select({
			id: scheduledTasks.id,
			ownerUserId: scheduledTasks.ownerUserId,
			createdBy: scheduledTasks.createdBy,
			legacy: sql<boolean>`${scheduledTasks.schedule} is null`,
			creatorSnapshot: scheduledTasks.creatorSnapshot,
			narratorMode: scheduledTasks.narratorMode,
			reuseNarratorId: scheduledTasks.reuseNarratorId,
			updatedAt: scheduledTasks.updatedAt,
		})
		.from(scheduledTasks)
		.where(or(taskOwnerWhere(userId), eq(scheduledTasks.createdBy, userId)))
		.limit(USER_TASK_TRANSFER_MAX + 1)
		.all();
	if (tasks.length > USER_TASK_TRANSFER_MAX) {
		throw new AppError(
			"Too many scheduled tasks for one account deletion. Transfer or remove tasks in batches first.",
			409,
			"TASK_TRANSFER_LIMIT",
		);
	}
	const isOwned = (task: (typeof tasks)[number]) =>
		task.ownerUserId === userId ||
		(task.ownerUserId === null && task.legacy && task.createdBy === userId);
	if (!confirmed && tasks.some(isOwned)) {
		throw new AppError(
			"Confirm takeover of this user's scheduled tasks before deletion",
			409,
			"TASK_TRANSFER_CONFIRMATION_REQUIRED",
		);
	}
	const now = new Date().toISOString();
	const taskIds: string[] = [];
	const narratorIds: string[] = [];
	for (const task of tasks) {
		const creatorSnapshot =
			task.createdBy === userId
				? {
						...task.creatorSnapshot,
						username: task.creatorSnapshot?.username ?? target.username.slice(0, 200),
					}
				: task.creatorSnapshot;
		if (!isOwned(task)) {
			tx.update(scheduledTasks)
				.set({ creatorSnapshot })
				.where(eq(scheduledTasks.id, task.id))
				.run();
			continue;
		}
		// Pending approvals bind to updatedAt: takeover must invalidate even a same-ms
		// update or a timestamp ahead of this server's clock.
		const previousUpdatedAt = Date.parse(task.updatedAt);
		const updatedAt = new Date(
			Math.max(Date.parse(now), Number.isFinite(previousUpdatedAt) ? previousUpdatedAt + 1 : 0),
		).toISOString();
		tx.update(scheduledTasks)
			.set({
				ownerUserId: actingUserId,
				creatorSnapshot,
				lastModifiedBy: {
					kind: "user",
					userId: actingUserId,
					action: "transfer_owner_on_user_deletion",
					at: updatedAt,
				},
				updatedAt,
			})
			.where(eq(scheduledTasks.id, task.id))
			.run();
		taskIds.push(task.id);
		if (task.narratorMode === "reuse" && task.reuseNarratorId) {
			// Never take an arbitrary ordinary session merely because reuseNarratorId points at it.
			const moved = tx
				.update(narrators)
				.set({ ownerUserId: actingUserId, updatedAt: now })
				.where(
					and(
						eq(narrators.id, task.reuseNarratorId),
						eq(narrators.scheduledTaskId, task.id),
						eq(narrators.ownerUserId, userId),
					),
				)
				.returning({ id: narrators.id })
				.all();
			narratorIds.push(...moved.map((narrator) => narrator.id));
		}
	}
	return { taskIds, narratorIds };
}

/** Explicitly releases nullable legacy references after the scheduled-task transfer. */
export function releaseUserForeignKeys(tx: DbTransaction, userId: string): void {
	if (
		tx
			.select({ id: scheduledTasks.id })
			.from(scheduledTasks)
			.where(taskOwnerWhere(userId))
			.limit(1)
			.get()
	) {
		throw new AppError(
			"Scheduled tasks must be transferred before deleting their owner",
			409,
			"TASK_TRANSFER_CONFIRMATION_REQUIRED",
		);
	}
	tx.update(scheduledTasks)
		.set({ createdBy: null })
		.where(eq(scheduledTasks.createdBy, userId))
		.run();
	// Ordinary sessions are released, not taken over. Task-dedicated reuse sessions moved above.
	tx.update(narrators).set({ ownerUserId: null }).where(eq(narrators.ownerUserId, userId)).run();
	tx.update(narratorMessages)
		.set({ createdBy: null })
		.where(eq(narratorMessages.createdBy, userId))
		.run();
	tx.update(narratorMessages)
		.set({ editedBy: null })
		.where(eq(narratorMessages.editedBy, userId))
		.run();
	tx.update(projects).set({ ownerUserId: null }).where(eq(projects.ownerUserId, userId)).run();
	tx.update(gatewaySessionMappings)
		.set({ appUserId: null })
		.where(eq(gatewaySessionMappings.appUserId, userId))
		.run();
	tx.delete(userPluginThemes).where(eq(userPluginThemes.userId, userId)).run();
}
