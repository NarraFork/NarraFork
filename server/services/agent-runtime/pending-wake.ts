import { hasInboxKind } from "./inbox";

/** Live background work the session started (Bash tasks, Watch observations, subagents) or a question a person has yet to answer: each wakes it when it settles. */
export async function hasPendingWork(narratorId: string): Promise<boolean> {
	const { backgroundTaskService } = await import("../background-task-service");
	if ((await backgroundTaskService.countActiveKindsByParent(narratorId)).activeWorkCount > 0)
		return true;
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
