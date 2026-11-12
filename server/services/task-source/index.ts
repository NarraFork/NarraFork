/**
 * The task source for a narrator.
 *
 * Continuation, the task digest, the behavior fence, the interrupt guard and compact get
 * their tasks from here instead of reading `spec://tasks.json` themselves.
 *
 * Each session records where its tasks live (`narrators.task_backend`, plan §3):
 * `resolveTaskBackend` reads it and the matching implementation in `TASK_SOURCE_FACTORIES`
 * serves it. A subagent's backend follows its root narrator's (D31). What the backend means
 * for a subagent differs: under spec every narrator, subagents included, reads its own
 * tasks.json; under the outline a subagent has no tasks of its own and continues on its turn
 * budget only (design D27c).
 *
 * `taskSourceForNarrator` never rejects: if the backend cannot be resolved it logs and
 * falls back to spec, so readers need no fallback for the factory itself.
 */

import { logger } from "../../lib/logger";
import { isOutlineEnabled } from "../outline/feature";
import { readTaskBackend } from "./backend";
import { createOutlineTaskSource } from "./outline";
import { createSpecTaskSource } from "./spec";
import type { NarratorTaskSource, TaskBackend } from "./types";

/** For whatever moves a session to the outline (the import, plan PR 12). */
export { invalidateTaskBackend } from "./backend";
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
	StatusBarView,
	TaskBackend,
	TaskStatus,
	TaskView,
} from "./types";

const TASK_SOURCE_FACTORIES: Record<TaskBackend, (narratorId: string) => NarratorTaskSource> = {
	spec: createSpecTaskSource,
	outline: createOutlineTaskSource,
};

/**
 * The backend a root session created now gets: `outline` while the outline is switched on,
 * `spec` otherwise. Sessions that exist keep theirs; subagents copy their root's.
 */
export function defaultTaskBackendForNewSession(): TaskBackend {
	return isOutlineEnabled() ? "outline" : "spec";
}

/**
 * The narrator's task backend: its session's `task_backend` (a subagent's root's). Read once per
 * narrator with one small indexed read and then served from memory (`backend.ts`; the column only
 * changes at import, which invalidates it). `spec` for a narrator that does not exist, and for
 * every narrator while the outline is switched off: an outline session then reads as a spec one
 * (its outline tasks wait, untouched, until the outline is back), rather than as one whose task
 * tools are gone.
 */
export async function resolveTaskBackend(narratorId: string): Promise<TaskBackend> {
	return await readTaskBackend(narratorId);
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
