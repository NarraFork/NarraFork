import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { backgroundTasks } from "../../db/schema";
import { hasInboxKind } from "./inbox";

function hasRunningWakeTask(narratorId: string): boolean {
	return !!db
		.select({ id: backgroundTasks.id })
		.from(backgroundTasks)
		.where(
			and(
				eq(backgroundTasks.parentNarratorId, narratorId),
				eq(backgroundTasks.status, "running"),
				eq(backgroundTasks.backgroundKind, "task"),
				inArray(backgroundTasks.type, ["bash", "agent"]),
			),
		)
		.limit(1)
		.get();
}

/**
 * Live background work the session started whose completion wakes it (Bash tasks, Watch
 * observations, subagents; never transfers or services), or a question a person has yet
 * to answer.
 */
export async function hasPendingWork(narratorId: string): Promise<boolean> {
	const { backgroundOccupancyStore } = await import("../background-occupancy-store");
	// A store stopped for a restart no longer reads: ask the task rows themselves.
	if (backgroundOccupancyStore.isStopped) {
		if (hasRunningWakeTask(narratorId)) return true;
	} else {
		await backgroundOccupancyStore.flush();
		if (backgroundOccupancyStore.countActiveWakeWork(narratorId) > 0) return true;
	}
	const { countOpenAsyncQuestions } = await import("../narrator-question-service");
	return (await countOpenAsyncQuestions(narratorId)) > 0;
}

/** Queued input, an agent's message or a notice in the session's inbox. */
export function hasQueuedWake(narratorId: string): Promise<boolean> {
	return hasInboxKind(narratorId, ["user_input", "agent_message", "task_notice"]);
}

/** Whether something already pending will wake this session. */
export async function hasPendingSessionWake(narratorId: string): Promise<boolean> {
	return (await hasQueuedWake(narratorId)) || (await hasPendingWork(narratorId));
}
