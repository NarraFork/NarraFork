/** Owner-directed task alerts. Never reads prompts, model summaries or provider errors. */
import { createHash } from "node:crypto";
import { db } from "@server/db";
import { scheduledTaskRuns, scheduledTasks, userPreferences, users } from "@server/db/schema";
import { logger } from "@server/lib/logger";
import {
	NOTIFICATION_PREVIEW_MAX_LENGTH,
	type NotificationLink,
} from "@shared/notification-center";
import { and, eq, sql } from "drizzle-orm";
import { clampNotificationText, recordNotificationOnce } from "./notification-center-service";
import { deliverNotification, type NotificationChannel } from "./notification-delivery";
import { taskOwnerWhere } from "./scheduled-task-acl";

export type ScheduledRunNotificationKind = "blocked" | "failed" | "completed" | "circuit_breaker";

// Only genuinely unmigrated rows use createdBy; a cleared modern owner is not resurrected.
const ownerColumn = sql<string>`coalesce(${scheduledTasks.ownerUserId}, case when ${scheduledTasks.schedule} is null then ${scheduledTasks.createdBy} end)`;
const taskColumns = {
	id: scheduledTasks.id,
	name: sql<string>`substr(${scheduledTasks.name}, 1, 160)`,
	ownerId: users.id,
	locale: scheduledTasks.locale,
};

function isCurrentOwner(taskId: string, ownerId: string): boolean {
	return !!db
		.select({ id: scheduledTasks.id })
		.from(scheduledTasks)
		.innerJoin(users, eq(users.id, ownerColumn))
		.where(and(eq(scheduledTasks.id, taskId), taskOwnerWhere(ownerId)))
		.limit(1)
		.get();
}

function plainName(value: string): string {
	// Names are untrusted too: no mentions, Markdown links, control characters or extra lines.
	return clampNotificationText(
		value
			.replace(/[\p{Cc}\p{Cf}<>[\]()*_`!@#\\]/gu, " ")
			.replace(/\s+/g, " ")
			.trim(),
		80,
	);
}

async function deliverOwnerAlert(input: {
	taskId: string;
	ownerId: string;
	name: string;
	preview: string;
	sourceKey: string;
	link: NotificationLink;
}): Promise<void> {
	if (!isCurrentOwner(input.taskId, input.ownerId)) return;
	const title = clampNotificationText(`NarraFork · ${plainName(input.name)}`, 120);
	const preview = clampNotificationText(input.preview, NOTIFICATION_PREVIEW_MAX_LENGTH);
	// The unique notification (user, kind, source) is also an at-most-once channel claim.
	// If a process dies after claiming, the in-app alert remains; we deliberately do not resend.
	const inserted = await recordNotificationOnce({
		userId: input.ownerId,
		kind: "scheduled_task",
		sourceKey: input.sourceKey,
		title,
		preview,
		link: input.link,
	});
	if (!inserted || !isCurrentOwner(input.taskId, input.ownerId)) return;
	const [pref] = await db
		.select({
			dingtalkEnabled: userPreferences.notifyDingtalkEnabled,
			dingtalkWebhook: userPreferences.notifyDingtalkWebhook,
			dingtalkSecret: userPreferences.notifyDingtalkSecret,
			feishuEnabled: userPreferences.notifyFeishuEnabled,
			feishuWebhook: userPreferences.notifyFeishuWebhook,
			feishuSecret: userPreferences.notifyFeishuSecret,
		})
		.from(userPreferences)
		.where(eq(userPreferences.userId, input.ownerId))
		.limit(1);
	if (!pref) return;
	const message = `${preview}\n\n/scheduled-tasks/${encodeURIComponent(input.taskId)}${input.link.type === "scheduled_task" && input.link.runId ? `?runId=${encodeURIComponent(input.link.runId)}` : ""}`;
	const channels: Array<{
		channel: NotificationChannel;
		enabled: boolean;
		webhook: string;
		secret: string;
	}> = [
		{
			channel: "dingtalk",
			enabled: pref.dingtalkEnabled,
			webhook: pref.dingtalkWebhook,
			secret: pref.dingtalkSecret,
		},
		{
			channel: "feishu",
			enabled: pref.feishuEnabled,
			webhook: pref.feishuWebhook,
			secret: pref.feishuSecret,
		},
	];
	await Promise.all(
		channels
			.filter((channel) => channel.enabled && channel.webhook)
			.map((channel) =>
				deliverNotification({
					...channel,
					title,
					message,
					source: "automatic",
					userId: input.ownerId,
					// No RecentTabs dependency. Recheck after the shared bounded delivery queue admits us.
					beforeSend: () => isCurrentOwner(input.taskId, input.ownerId),
				}),
			),
	);
}

export async function notifyScheduledRunChanged(
	runId: string,
	kind: ScheduledRunNotificationKind,
): Promise<void> {
	try {
		const [row] = await db
			.select({
				...taskColumns,
				status: scheduledTaskRuns.status,
				blockReason: scheduledTaskRuns.blockReason,
				onBlocked: scheduledTasks.onBlocked,
				notifyOnSuccess: scheduledTasks.notifyOnSuccess,
				consecutiveFailures: scheduledTasks.consecutiveFailures,
				pauseReason: scheduledTasks.pauseReason,
				enabled: scheduledTasks.enabled,
			})
			.from(scheduledTaskRuns)
			.innerJoin(scheduledTasks, eq(scheduledTasks.id, scheduledTaskRuns.taskId))
			.innerJoin(users, eq(users.id, ownerColumn))
			.where(eq(scheduledTaskRuns.id, runId))
			.limit(1);
		if (!row) return;
		if (kind === "completed" && (row.status !== "completed" || !row.notifyOnSuccess)) return;
		if (
			kind === "blocked" &&
			(row.status !== "blocked" || row.onBlocked !== "wait" || row.blockReason === "provider_wait")
		)
			return;
		// One alert at the start of a consecutive failure streak; the circuit breaker
		// is a separate kind and always alerts when it pauses the task.
		if (
			kind === "failed" &&
			(!["failed", "timed_out", "interrupted"].includes(row.status) || row.consecutiveFailures > 1)
		)
			return;
		if (kind === "circuit_breaker" && (row.enabled || row.pauseReason !== "circuit_breaker"))
			return;
		const zh = row.locale === "zh-CN";
		const preview =
			kind === "circuit_breaker"
				? zh
					? "计划任务连续失败，已自动暂停。请打开任务检查后恢复。"
					: "Repeated failures paused this scheduled task. Review it before resuming."
				: kind === "blocked"
					? zh
						? "计划任务等待你处理。打开本次运行查看待办；系统不会自动代答。"
						: "This scheduled run needs your input. Open the run to respond; no answer is submitted automatically."
					: kind === "completed"
						? zh
							? "本次计划任务运行已结束。请打开运行记录查看结果。"
							: "This scheduled run finished. Open its run record to review the outcome."
						: row.status === "timed_out"
							? zh
								? "本次计划任务运行已超时。请打开运行记录查看。"
								: "This scheduled run timed out. Open its run record to review it."
							: row.status === "interrupted"
								? zh
									? "本次计划任务运行已中断。请打开运行记录查看。"
									: "This scheduled run was interrupted. Open its run record to review it."
								: zh
									? "本次计划任务运行失败。请打开运行记录查看。"
									: "This scheduled run failed. Open its run record to review it.";
		await deliverOwnerAlert({
			taskId: row.id,
			ownerId: row.ownerId,
			name: row.name,
			preview,
			sourceKey: `run:${runId}:${kind}`,
			link: { type: "scheduled_task", taskId: row.id, runId },
		});
	} catch {
		// Exception strings may include SQL parameters / credentials: never log them here.
		logger.warn("Scheduled task notification failed", { runId, kind });
	}
}

export async function notifyScheduledTaskTransferred(taskId: string): Promise<void> {
	try {
		const [task] = await db
			.select({
				...taskColumns,
				modified: scheduledTasks.lastModifiedBy,
				updatedAt: scheduledTasks.updatedAt,
			})
			.from(scheduledTasks)
			.innerJoin(users, eq(users.id, ownerColumn))
			.where(eq(scheduledTasks.id, taskId))
			.limit(1);
		if (
			!task?.modified ||
			!["transfer", "transfer_owner_on_user_deletion"].includes(task.modified.action)
		)
			return;
		// The row revision is monotonic even when separate transfers share a wall-clock ms.
		const changeKey = createHash("sha256").update(task.updatedAt).digest("hex").slice(0, 16);
		await deliverOwnerAlert({
			taskId,
			ownerId: task.ownerId,
			name: task.name,
			preview:
				task.locale === "zh-CN"
					? "你已接管此计划任务。原有调度和权限上限保持不变。"
					: "You now own this scheduled task. Its schedule and permission ceiling are unchanged.",
			sourceKey: `transfer:${taskId}:${changeKey}`,
			link: { type: "scheduled_task", taskId },
		});
	} catch {
		logger.warn("Scheduled task transfer notification failed", { taskId });
	}
}
