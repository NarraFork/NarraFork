/**
 * The task source: the one way continuation, the periodic task digest, the behavior
 * fence, the interrupt guard and compact read a narrator's tasks. `currentTask` is the
 * status bar's read; the status bar itself still reads `GET /spec/tasks` until the task
 * board replaces the Spec panel (outline P2, PR 5).
 *
 * Shaped by what those readers need, not by tasks.json:
 * - Where a reader's own logic does not depend on the backend (the interrupt guard's
 *   suppression and dedupe, continuation modes and stall rules), the source only hands
 *   over data: current, next, the open list, the protected count, the continuation target.
 * - Where a reader passes text to the model that cannot avoid backend vocabulary
 *   (`spec://tasks.json`, taskReflection), the source hands over the finished text:
 *   continuation prompts, the interrupt note, the periodic digest, the compact task list.
 *
 * One source is bound to one narrator; get it from `taskSourceForNarrator`.
 */

import type { SideCarBody } from "@shared/sidecar-body";
import type { Locale } from "../../lib/prompt-i18n";
import type { SpecContinuationCause } from "../turn-continuation-decisions";

/**
 * Where a narrator's tasks live.
 *
 * Only `spec` (`spec://tasks.json`) exists so far. The outline backend (checkbox tasks,
 * claims, derived waiting) is added here and registered with the factory in `index.ts`.
 */
export type TaskBackend = "spec";

/**
 * The four task states readers see.
 *
 * `blocked` means blocked or waiting: in spec it is a status the agent sets by hand; the
 * outline derives it from waiting on a person (an unanswered question) or on a
 * prerequisite, and never stores it (design D27b).
 */
export type TaskStatus = "todo" | "doing" | "blocked" | "done";

/** Unfinished: to do, in progress, or blocked/waiting. */
export type OpenTaskStatus = Exclude<TaskStatus, "done">;

export interface TaskView {
	text: string;
	status: TaskStatus;
	/**
	 * A task the narrator may not drop on its own: `protected: true` in spec (`/goal`, or
	 * marked in the Spec panel); a human-created task in the outline (design D27a). The
	 * default `protectedOnly` continuation mode only runs while one of these is open.
	 */
	protected: boolean;
}

export interface OpenTaskView extends TaskView {
	status: OpenTaskStatus;
}

export interface OpenTaskList {
	/** Unfinished tasks in the source's own order (spec: array order; outline: document order). */
	tasks: OpenTaskView[];
	/**
	 * Must change whenever the open tasks change, and stay put while nothing is written;
	 * it may move more often than strictly needed (spec moves it on every tasks.json
	 * write). The interrupt guard dedupes on it — one key, one note — and treats null as a
	 * key like any other, so it must not be null while `tasks` is non-empty.
	 *
	 * Spec: the id of tasks.json's current revision. A backend whose `blocked` is derived
	 * (outline: waiting on a person or a prerequisite) must fold that derivation into the
	 * key — a question asked or answered, a prerequisite finished — or the guard will not
	 * speak again after the open list's statuses changed.
	 */
	revision: string | null;
}

/** The one task a continuation names. */
export interface ContinuationTask {
	text: string;
	protected: boolean;
	/** `blocked` switches the prompt to "unblock it or ask", and `blockStop` stops instead. */
	status: "doing" | "blocked";
}

/** Everything continuation needs from the tasks: exactly what `planSpecContinuation` reads. */
export interface ContinuationTarget {
	/** The first task in progress; else the first blocked one; else null. */
	openTask: ContinuationTask | null;
	/** Unfinished protected tasks; `protectedOnly` does not continue while this is 0. */
	protectedOpenCount: number;
}

/** Why another pass is granted: `spec` for open work, `maxTurns` for a spent turn budget. */
export type ContinuationCause = SpecContinuationCause;

export type ContinuationPromptInput =
	/**
	 * A run with a pass ceiling or without AskUserQuestion (delegated subagents): says why
	 * another pass was granted and how many remain.
	 */
	| {
			form: "bounded";
			task: ContinuationTask;
			cause: ContinuationCause;
			/** Passes used so far, including the one being started. */
			passes: number;
			maxPasses: number | null;
			canAskUserQuestion: boolean;
			locale: Locale;
	  }
	/** An ordinary narrator: no ceiling, may ask the user. */
	| { form: "open"; task: ContinuationTask; locale: Locale };

/** The system note the interrupt guard leaves: model text plus the structured body. */
export interface InterruptGuardNote {
	content: string;
	body: SideCarBody;
}

/**
 * One narrator's task source.
 *
 * When the tasks cannot be read (spec: tasks.json is not valid JSON, …), the task-data
 * reads and `prepareContinuation` reject, and each reader handles it as it always has
 * (continuation treats it as nothing to continue, the interrupt guard logs and lets the
 * interrupt finish). The injection reads (`taskDigest`, `behaviorFence`, `compactContext`)
 * resolve to null instead; their readers also catch a rejection, but a source must not
 * rely on that. The contract suite pins both halves.
 */
export interface NarratorTaskSource {
	readonly backend: TaskBackend;
	readonly narratorId: string;

	// ── Task data ─────────────────────────────────────────────────────────────

	/**
	 * The first task in progress, or null. The status bar shows this task (it still reads
	 * `GET /spec/tasks` until PR 5 switches it to the task source).
	 */
	currentTask(): Promise<TaskView | null>;
	/**
	 * A task not started yet that would be taken up next, or null when none is waiting.
	 * Spec takes the first todo in array order, even one listed before the current task;
	 * another backend may take the first todo after the current task. Readers may rely on
	 * the two agreeing only when no todo precedes the current task (or nothing is current).
	 */
	nextTask(): Promise<TaskView | null>;
	/** Unfinished tasks plus the revision key; read by the interrupt guard. */
	openTasks(): Promise<OpenTaskList>;
	/** Unfinished protected tasks (outline: unfinished human-created tasks). */
	protectedOpenCount(): Promise<number>;

	// ── Continuation ──────────────────────────────────────────────────────────

	/**
	 * Read the tasks for a continuation decision, writing first when needed.
	 *
	 * With `promoteTodo`, nothing in progress and something to do, the first todo becomes
	 * the current task before choosing (a system write; in the outline it is a claim). The
	 * promotion therefore lands even when no continuation follows. Delegated subagents do
	 * not promote (`policy.continuation.promoteTodo`).
	 */
	prepareContinuation(options: { promoteTodo: boolean }): Promise<ContinuationTarget>;
	/** The continuation prompt: names one task, says the system sent it, lists the outcomes. */
	continuationPrompt(input: ContinuationPromptInput): string;

	// ── Injections ────────────────────────────────────────────────────────────

	/**
	 * The digest injected every N completed tool calls (`living_work_spec`).
	 *
	 * Never null while the source is readable: with no open tasks it is an empty variant
	 * (spec: `emptyNever` / `emptyDone`, which nudge the model to create or reorganize
	 * tasks). Null means only that the read failed. This is load-bearing beyond the digest
	 * itself: under the default settings (`behaviorFenceInterval: -1`,
	 * `behaviorFenceAttachTasks: true`) the behavior fence is injected only alongside a
	 * non-null digest, so a source that went quiet without tasks would drop the fence too.
	 * A backend that retires this digest must deliver the fence some other way first.
	 */
	taskDigest(): Promise<SideCarBody | null>;
	/** The behavior fence (`behavior_fence`); null when empty or unreadable, never injected. */
	behaviorFence(): Promise<SideCarBody | null>;
	/** The task list for the compact summarizer's system prompt; null without tasks. */
	compactContext(locale: Locale): Promise<string | null>;
	/**
	 * The note left for the model after a user interrupt, listing the given open tasks
	 * (the reader decides how many). Whether and how often it is sent is the reader's call.
	 */
	interruptGuardNote(tasks: readonly OpenTaskView[], locale: Locale): InterruptGuardNote;
}
