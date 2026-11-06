/**
 * The task board's API (outline P2 PR 5): the built-in view of the process dimension, grouped by
 * executor and status, for one session (the session dock) or one project (the project page).
 * Types only, shared by the routes and the client.
 */
import type { OutlineActorKind, OutlineSpaceKind, OutlineTaskStatus } from "./outline-api";

/** Limits of the board; the server clamps what a client asks for to these. */
export const OUTLINE_TASK_BOARD_LIMITS = {
	/** Open tasks a session board shows of its session space (more are counted as truncated). */
	sessionOpen: 200,
	/**
	 * Open tasks a project board shows of each space (more are counted as truncated; the session's
	 * own board shows them all). Kept small with {@link projectSpaces}: a page is one bounded read.
	 */
	projectOpen: 20,
	/** Tasks a session holds in other spaces that its board shows. */
	claimedElsewhere: 50,
	/** Finished tasks a session board shows at first, and per page after. */
	sessionFinished: 20,
	/** Finished tasks a project board shows of each space at first. */
	projectFinished: 5,
	/** Finished tasks one page of a space's finished list holds at most. */
	maxFinishedPage: 50,
	/** Session spaces one page of a project board covers (the project space comes first). */
	projectSpaces: 10,
	/** Characters of a task's text (`/goal`, the add form). */
	maxTaskChars: 4000,
	/** Characters of a username an assignment names. */
	maxUsernameChars: 128,
} as const;

/**
 * Who does a task, as the board groups it:
 *   - `session`: a session holds it (its claim, lease running or lapsed), or it is an open task of
 *     the session's own space that nobody else is assigned (the session will take it up);
 *   - `human`: a person holds it, or it is assigned to a person (`@human:name`);
 *   - `agent`: assigned by name to an agent (`@agent:name`) that holds nothing yet;
 *   - `none`: nobody (an unassigned task of a project space).
 * Finished tasks are grouped by who finished them (the claim's last holder) when known.
 */
export type OutlineBoardExecutor =
	| { kind: "session"; narratorId: string; title: string | null }
	| { kind: "human"; userId: string | null; name: string }
	| { kind: "agent"; name: string }
	| { kind: "none" };

export interface OutlineBoardTask {
	id: string;
	spaceId: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	pageId: string;
	/** The task's first line, plain text. */
	title: string;
	status: OutlineTaskStatus;
	/**
	 * What an open task waits for (derived, never stored: D27b); null when it does not wait or is
	 * finished. `prerequisites` is how many unfinished prerequisites it has.
	 */
	waiting: { prerequisites: number; people: boolean; confirmation: boolean } | null;
	/** `agent:name` or `human:name`. */
	assignee: string | null;
	executor: OutlineBoardExecutor;
	/** Created by a person (`/goal`, the board). */
	humanCreated: boolean;
	/** The lock on the task's tree, when this task is a locked root. */
	lock: { by: { kind: OutlineActorKind; id: string; name: string | null } } | null;
	/**
	 * When this task is a plan's root (outline P2 PR 8): `planning` (not approved yet, never
	 * executed: "计划中") or `approved`, and the versions decided so far.
	 */
	plan: { state: "planning" | "approved"; round: number } | null;
	/**
	 * An open change asking to end the task (a locked plan's root done or cancelled, D26b): the
	 * person who locked it confirms or rejects it on the board.
	 */
	completion: {
		pendingId: string;
		/** What the change sets the task to. */
		status: "done" | "cancelled";
		/** Whether the caller decides it (the locker, D25: no delegate by default). */
		canDecide: boolean;
	} | null;
	/** The task's `version_seq` as read: a change names it as its base. */
	versionSeq: number;
}

export interface OutlineBoardSpace {
	id: string;
	key: string;
	kind: OutlineSpaceKind;
	projectId: string | null;
	narratorId: string | null;
	/** The project's name or the session's title. */
	label: string | null;
}

/** One space's tasks on a board. */
export interface OutlineBoardSection {
	space: OutlineBoardSpace;
	/** Whether the caller may change tasks of this space (assign, transfer, reopen, finish). */
	canWrite: boolean;
	/**
	 * `own`: the space's tasks. `claimed`: only the tasks the board's session holds in a space
	 * that is not its own (a session board).
	 */
	role: "own" | "claimed";
	/** Open tasks in document order. */
	open: OutlineBoardTask[];
	/**
	 * More open tasks than the board shows. Those in progress or locked are shown first, so a cut
	 * leaves out to-dos only (while the space has no more of those than the cap).
	 */
	openTruncated: boolean;
	/** Finished tasks, latest change first (none for a `claimed` section). */
	finished: OutlineBoardTask[];
	/** Pass back to read the space's next finished tasks; null when there are no more. */
	finishedCursor: string | null;
}

export type OutlineBoardScope =
	| { kind: "session"; narratorId: string }
	| { kind: "project"; projectId: string };

export interface OutlineTaskBoardResponse {
	scope: OutlineBoardScope;
	sections: OutlineBoardSection[];
	/** A session board: whether the caller may add tasks to the session (`/goal`, the form). */
	canAdd: boolean;
	/** A project board: pass back as `cursor` for the next spaces; null on the last page. */
	nextCursor: string | null;
	/** The caller, for "assign to me". */
	me: { userId: string; name: string };
}

export interface OutlineBoardFinishedResponse {
	tasks: OutlineBoardTask[];
	nextCursor: string | null;
}

/** Add a task to a session, as a person (the board's form). */
export interface OutlineBoardAddRequest {
	text: string;
	/** Lock it (D26b); default true. */
	lock?: boolean;
	/** Start the session on its tasks right away when it is idle ("Add and start", Q5). */
	start?: boolean;
}

export interface OutlineBoardAddResponse {
	/** False when an open or done task with the same text exists already (nothing was written). */
	added: boolean;
	task: { id: string; address: string; spaceId: string };
	locked: boolean;
	/** A turn was started. */
	started: boolean;
}

/** Who a task is handed to. */
export type OutlineBoardAssignTarget =
	| { kind: "me" }
	| { kind: "user"; username: string }
	/** Back to the session: no assignee. */
	| { kind: "session" };

/** A person's change to one task on the board. */
export interface OutlineBoardTaskUpdateRequest {
	/** The task's `version_seq` as the board read it; a change since then is refused (409). */
	baseVersionSeq: number;
	/** `todo` reopens a finished task (or stops one in progress). */
	status?: "todo" | "done" | "cancelled";
	assign?: OutlineBoardAssignTarget;
	/**
	 * Start the session whose space holds the task right away when it is idle ("Reopen and
	 * start", Q5). Only for a task of a session space.
	 */
	start?: boolean;
}

export interface OutlineBoardTaskUpdateResponse {
	/** The task's new `version_seq`, or null when nothing changed. */
	versionSeq: number | null;
	started: boolean;
}

/** The status bar's read (any task backend). */
export interface NarratorCurrentTaskResponse {
	/** The session's task backend in effect (`spec` while the outline is switched off). */
	backend: "spec" | "outline";
	current: { text: string; address: string | null; protected: boolean } | null;
	/** Person-created goals of the session whose completion waits for confirmation (outline). */
	awaitingConfirmation: number;
	/** Of those, the ones the caller decides: they locked the goal (the board gives them Confirm). */
	awaitingYourConfirmation: number;
	/** Who decides the others (usernames, at most three): "waits for alice's confirmation". */
	awaitingFrom: string[];
}

/** WebSocket event: the tasks a session's board shows changed (ids only; the client re-reads). */
export const OUTLINE_TASKS_CHANGED_EVENT = "outline_tasks_changed";
