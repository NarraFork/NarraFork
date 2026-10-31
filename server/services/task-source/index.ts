/**
 * The task source for a narrator.
 *
 * Continuation, the task digest, the behavior fence, the interrupt guard and compact get
 * their tasks from here instead of reading `spec://tasks.json` themselves. Only the spec
 * implementation exists so far, so that is what every narrator gets.
 *
 * Extension point: once narrators carry a task backend, `resolveTaskBackend` reads it and
 * the outline implementation is registered in `TASK_SOURCE_FACTORIES`. A subagent's
 * backend follows its root narrator's. What the backend means for a subagent differs:
 * under spec every narrator, subagents included, reads its own tasks.json; under the
 * outline a subagent has no tasks of its own and continues on its turn budget only
 * (design D27c).
 *
 * `taskSourceForNarrator` never rejects: if the backend cannot be resolved it logs and
 * falls back to spec, so readers need no fallback for the factory itself.
 */

import { logger } from "../../lib/logger";
import { createSpecTaskSource } from "./spec";
import type { NarratorTaskSource, TaskBackend } from "./types";

export type {
	ContinuationCause,
	ContinuationPromptInput,
	ContinuationTarget,
	ContinuationTask,
	InterruptGuardNote,
	NarratorTaskSource,
	OpenTaskList,
	OpenTaskStatus,
	OpenTaskView,
	TaskBackend,
	TaskStatus,
	TaskView,
} from "./types";

const TASK_SOURCE_FACTORIES: Record<TaskBackend, (narratorId: string) => NarratorTaskSource> = {
	spec: createSpecTaskSource,
};

/** The narrator's task backend. Narrators have no such field yet: always `spec`, no DB read. */
export async function resolveTaskBackend(_narratorId: string): Promise<TaskBackend> {
	return "spec";
}

/** The task source bound to this narrator. Never rejects (see the module comment). */
export async function taskSourceForNarrator(narratorId: string): Promise<NarratorTaskSource> {
	let backend: TaskBackend = "spec";
	try {
		backend = await resolveTaskBackend(narratorId);
	} catch (err) {
		logger.warn("Failed to resolve task backend; using spec", {
			narratorId,
			error: String(err),
		});
	}
	const create = TASK_SOURCE_FACTORIES[backend] ?? TASK_SOURCE_FACTORIES.spec;
	return create(narratorId);
}
