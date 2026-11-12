/**
 * The task source: the one way continuation, the periodic task digest, the behavior
 * fence, the request prefix's task views, the interrupt guard, the turn-end note and
 * compact read a narrator's tasks. `currentTask` is the status bar's read
 * (`GET /api/narrators/:id/tasks/current`, outline P2 PR 5).
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

import type { ContextPart } from "@shared/prefix-context";
import type { SideCarBody } from "@shared/sidecar-body";
import type { Locale } from "../../lib/prompt-i18n";
import type { SpecContinuationCause } from "../turn-continuation-decisions";

/**
 * Where a narrator's tasks live: `spec` (`spec://tasks.json`) or `outline` (checkbox blocks in
 * the session space, claims, derived waiting). Stored per session (`narrators.task_backend`);
 * a subagent follows its root (design D31).
 */
export type TaskBackend = "spec" | "outline";

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
	/**
	 * Outline: the task is a team task, of a project space the session holds it in (its block id).
	 * Such a task may be given back when the run ends (outline P2 PR 10c-2), so the turn-end note
	 * does not name it then. A task of the session's own or of a personal space has none.
	 */
	teamTaskId?: string;
}

export interface OpenTaskList {
	/**
	 * Unfinished tasks in the source's own order (spec: array order; outline: document order).
	 * A backend may list only a leading part of a long list (outline: the first 20); readers
	 * show a prefix anyway (the interrupt guard eight).
	 */
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

/** What the status bar shows of a session's tasks (`NarratorTaskSource.statusBar`). */
export interface StatusBarView {
	current: (TaskView & { address: string | null }) | null;
	awaitingConfirmation: {
		total: number;
		/** Those the viewer decides: they locked the goal. */
		mine: number;
		/** The people who decide the others (their usernames), at most a few. */
		from: string[];
	};
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
	/**
	 * The narrator has no tasks of its own and continues on its turn budget only (outline
	 * subagents, design D27c): a pass that spent its turn budget before the final reply gets
	 * another one, whatever the mode says about tasks (only `off` still stops it); a pass that
	 * ended on its own does not. The pass ceiling and the stall rules apply as always. `openTask`
	 * is null then; the reader names no task. Spec never sets it.
	 */
	turnBudgetOnly?: boolean;
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
			/**
			 * The run has no task of its own and was continued on its turn budget
			 * (`ContinuationTarget.turnBudgetOnly`): `task` is a placeholder, the prompt names none.
			 */
			turnBudgetOnly?: boolean;
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
 * interrupt finish). The injection reads (`taskDigest`, `behaviorFence`, `compactContext`,
 * `contextParts`) resolve to null (or no parts) instead; their readers also catch a
 * rejection, but a source must not rely on that. The contract suite pins both halves.
 */
export interface NarratorTaskSource {
	readonly backend: TaskBackend;
	readonly narratorId: string;

	// ── Task data ─────────────────────────────────────────────────────────────

	/** The first task in progress, or null: the task the status bar shows. */
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
	/**
	 * Unfinished protected tasks (outline: unfinished human-created tasks, except those whose
	 * completion only waits for their person's confirmation).
	 */
	protectedOpenCount(): Promise<number>;
	/**
	 * The status bar's read, in one read of the tasks: the first task in progress (with its address
	 * when the backend has one), and the person-created tasks whose completion waits for
	 * confirmation (outline: a locked goal the agent ticked done, D26b), in all, those
	 * `viewerUserId` decides (on the board: its locker), and who decides the others. Spec: its
	 * current task, no address, nothing waits.
	 */
	statusBar(viewerUserId: string | null): Promise<StatusBarView>;

	// ── Continuation ──────────────────────────────────────────────────────────

	/**
	 * Where a task this source handed out is (`key/sid`), when the backend has addresses (the
	 * outline); null otherwise. An approved outline plan names its first step by it (P2 PR 8).
	 */
	taskAddress?(task: { text: string; protected: boolean }): string | null;
	/**
	 * Read the tasks for a continuation decision, writing first when needed.
	 *
	 * With `promoteTodo`, nothing in progress and something to do, the first todo becomes
	 * the current task before choosing (a system write; in the outline it is a claim). The
	 * promotion therefore lands even when no continuation follows. Delegated subagents do
	 * not promote (`policy.continuation.promoteTodo`).
	 */
	prepareContinuation(options: {
		promoteTodo: boolean;
		/**
		 * The task a person just asked the session to start ("Add and start", "Reopen and start";
		 * outline P2 PR 5), or an approved plan's root (P2 PR 8): a to-do of the session's own is
		 * started for it (the same system start as a promotion, even with `promoteTodo` off and
		 * something else in progress). The target is this task; or, when it has unfinished tasks
		 * under it (a tree), its first step that can start, started too; or none when nothing
		 * can be started. Read as its own subtree, whatever comes before it. A backend without
		 * task ids (spec) ignores it.
		 */
		preferTaskId?: string;
	}): Promise<ContinuationTarget>;
	/** The continuation prompt: names one task, says the system sent it, lists the outcomes. */
	continuationPrompt(input: ContinuationPromptInput): string;

	// ── Injections ────────────────────────────────────────────────────────────

	/**
	 * The digest injected every N completed tool calls (`living_work_spec`).
	 *
	 * Spec: never null while the source is readable: with no open tasks it is an empty variant
	 * (`emptyNever` / `emptyDone`, which nudge the model to create or reorganize tasks); null
	 * means only that the read failed. This is load-bearing beyond the digest itself: under the
	 * default settings (`behaviorFenceInterval: -1`, `behaviorFenceAttachTasks: true`) the
	 * behavior fence is injected only alongside a non-null digest.
	 *
	 * A backend may retire the digest (outline: always null, so the cadence drain writes and
	 * reads nothing), but only by delivering the tasks and the behavior fence another way first:
	 * the outline does it with {@link contextParts}.
	 */
	taskDigest(): Promise<SideCarBody | null>;
	/**
	 * The behavior fence (`behavior_fence`) the cadence drain injects; null when empty or
	 * unreadable, never injected. Always null for a backend that delivers its boundary through
	 * {@link contextParts} (outline).
	 */
	behaviorFence(): Promise<SideCarBody | null>;
	/**
	 * The named dynamic context parts this source adds to the request prefix, after the
	 * platform's own (`narrator-prompt.ts`): in the baseline of every prefix epoch (the first
	 * turn, every compact, a model change), and within an epoch updated by one `context_update`
	 * only when their text changes (`narrator-epochs.ts`). Their text must be deterministic, or
	 * every request becomes an update. Spec: none (the prefix stays exactly as it was).
	 * Outline: the built-in views, current tasks and behavior boundary (plan PR 4). A view that
	 * cannot be read now and was never read in this process is marked `unreadable`: the request
	 * keeps its previous value. Only a view that is really empty is left out.
	 */
	contextParts(locale: Locale): Promise<ContextPart[]>;
	/**
	 * The task context for the compact summarizer's system prompt; null without tasks (spec).
	 * `since`: when the conversation being summarized starts (its first message), for a source
	 * that also lists what the session recorded since its last compact (outline).
	 */
	compactContext(locale: Locale, options?: { since?: string | null }): Promise<string | null>;
	/**
	 * The one-line note left when a long turn ends with `task` (in progress) untouched and no
	 * continuation follows (outline, decision 2026-11-02 Q4). Absent: the backend leaves none
	 * (spec, whose periodic digest still runs).
	 */
	turnEndNote?(task: OpenTaskView, locale: Locale): InterruptGuardNote | null;
	/**
	 * The note left for the model after a user interrupt, listing the given open tasks
	 * (the reader decides how many). Whether and how often it is sent is the reader's call.
	 */
	interruptGuardNote(tasks: readonly OpenTaskView[], locale: Locale): InterruptGuardNote;
}
