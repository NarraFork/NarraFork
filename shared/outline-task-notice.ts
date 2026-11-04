/**
 * What a system notice about a session's outline tasks names, as data for the reader.
 *
 * The notices (the turn-end reminder, people's changes to the session's tasks, the update of the
 * session's current-tasks view) reach the model as text. The transcript used to project that text
 * back for the reader: raw `key/sid` addresses, markdown escapes, the sentence twice. These shapes
 * travel beside the model-facing text instead (a `system_injection` body, a `context_update`
 * block's `display`), so the transcript can show titled outline links and status chips. The
 * model-facing text is unchanged and never derived from them.
 *
 * Bounded at the source: a notice names at most {@link OUTLINE_TASK_NOTICE_LIMITS.items} tasks,
 * each title one line of at most {@link OUTLINE_TASK_NOTICE_LIMITS.titleChars} characters, so a
 * row stays small in a message's JSON and in every list that reads it.
 *
 * Zero DOM, no server imports (reachable from `shared/sidecar-body.ts`).
 */

/** A task's checkbox status, as the outline stores it. */
export type OutlineTaskNoticeStatus = "todo" | "doing" | "done" | "cancelled";

/**
 * One change a person made to a task of the session (outline P2 PR 5, `outline-task-edits.ts`).
 * Structurally the same as the prompt's `OutlineTaskEditChange`, which words it for the model.
 */
export type OutlineTaskNoticeChange =
	| { kind: "added" | "deleted" | "unchecked" | "moved" | "locked" | "unlocked" | "fields" }
	| { kind: "status"; from: OutlineTaskNoticeStatus | null; to: string }
	| { kind: "assigned"; to: string | null }
	/** The person rejected the agent's marking a locked goal done or cancelled (D26b). */
	| { kind: "rejected"; status: "done" | "cancelled"; reason: string | null };

/** One task a notice names. */
export interface OutlineTaskNoticeItem {
	/** `key/sid`: what its outline link opens. */
	address: string;
	/** Its title when the notice was written: one plain line. */
	title: string;
	/** Its checkbox status then, when the notice says it. */
	status?: OutlineTaskNoticeStatus;
	/** It waited on a prerequisite or a person then. */
	waiting?: true;
	/** Created by a person (`/goal`, the board): the agent may not drop it on its own. */
	humanCreated?: true;
	locked?: true;
	/** Changes by people: who made them (a display name, never their words). */
	by?: string;
	/** Changes by people: what changed, in order. */
	changes?: OutlineTaskNoticeChange[];
}

export const OUTLINE_TASK_NOTICE_LIMITS = {
	/** Tasks one notice names; the rest are counted. */
	items: 20,
	/** Characters of a title, a name or an assignee. */
	titleChars: 120,
	/** Characters of a rejection's reason. */
	reasonChars: 200,
	/** Changes kept per task. */
	changes: 8,
} as const;

/** One line of at most `max` characters, never cut inside a surrogate pair. */
export function clipNoticeLine(text: string, max: number = OUTLINE_TASK_NOTICE_LIMITS.titleChars) {
	const line = text
		.slice(0, max * 4)
		.replace(/\s+/g, " ")
		.trim();
	if (line.length <= max) return line;
	let end = Math.max(0, max - 1);
	const code = line.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${line.slice(0, end).trimEnd()}…`;
}

const STATUSES = new Set<string>(["todo", "doing", "done", "cancelled"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundChange(raw: unknown): OutlineTaskNoticeChange | null {
	if (!isRecord(raw) || typeof raw.kind !== "string") return null;
	switch (raw.kind) {
		case "added":
		case "deleted":
		case "unchecked":
		case "moved":
		case "locked":
		case "unlocked":
		case "fields":
			return { kind: raw.kind };
		case "status":
			if (typeof raw.to !== "string") return null;
			return {
				kind: "status",
				from: typeof raw.from === "string" && STATUSES.has(raw.from) ? (raw.from as never) : null,
				to: clipNoticeLine(raw.to, 32),
			};
		case "assigned":
			return {
				kind: "assigned",
				to: typeof raw.to === "string" && raw.to ? clipNoticeLine(raw.to) : null,
			};
		case "rejected":
			if (raw.status !== "done" && raw.status !== "cancelled") return null;
			return {
				kind: "rejected",
				status: raw.status,
				reason:
					typeof raw.reason === "string" && raw.reason.trim()
						? clipNoticeLine(raw.reason, OUTLINE_TASK_NOTICE_LIMITS.reasonChars)
						: null,
			};
		default:
			return null;
	}
}

/**
 * A task as a notice keeps it: strings clipped, unknown fields dropped. Null when it names no
 * task (no title and no address). Used by the producers and again when a row is read back, so a
 * malformed or oversized payload can never reach the renderer.
 */
export function boundOutlineTaskNoticeItem(raw: unknown): OutlineTaskNoticeItem | null {
	if (!isRecord(raw)) return null;
	const address = typeof raw.address === "string" ? clipNoticeLine(raw.address, 80) : "";
	const title = typeof raw.title === "string" ? clipNoticeLine(raw.title) : "";
	if (!address && !title) return null;
	const changes = Array.isArray(raw.changes)
		? raw.changes
				.slice(0, OUTLINE_TASK_NOTICE_LIMITS.changes)
				.map(boundChange)
				.filter((change): change is OutlineTaskNoticeChange => change !== null)
		: [];
	return {
		address,
		title,
		...(typeof raw.status === "string" && STATUSES.has(raw.status)
			? { status: raw.status as OutlineTaskNoticeStatus }
			: {}),
		...(raw.waiting === true ? { waiting: true as const } : {}),
		...(raw.humanCreated === true ? { humanCreated: true as const } : {}),
		...(raw.locked === true ? { locked: true as const } : {}),
		...(typeof raw.by === "string" && raw.by.trim() ? { by: clipNoticeLine(raw.by, 64) } : {}),
		...(changes.length > 0 ? { changes } : {}),
	};
}

/** Bounded items of a notice, at most {@link OUTLINE_TASK_NOTICE_LIMITS.items}. */
export function boundOutlineTaskNoticeItems(raw: unknown): OutlineTaskNoticeItem[] {
	if (!Array.isArray(raw)) return [];
	const out: OutlineTaskNoticeItem[] = [];
	for (const item of raw.slice(0, OUTLINE_TASK_NOTICE_LIMITS.items)) {
		const bounded = boundOutlineTaskNoticeItem(item);
		if (bounded) out.push(bounded);
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The current-tasks view, as a `context_update` row shows it
// ─────────────────────────────────────────────────────────────────────────────

/** The named context part of an outline session's current-tasks view (outline plan PR 4). */
export const OUTLINE_TASKS_VIEW_KEY = "outline.tasks";

/** A task the current-tasks view lists. */
export interface OutlineTasksViewTask {
	address: string;
	title: string;
	humanCreated?: true;
}

/**
 * What the current-tasks view held when it changed: the tasks it listed by section, and how many
 * open tasks there were. Stored on the `context_update` row beside the model-facing update (never
 * part of the change key, never sent to the model).
 */
export interface OutlineTasksViewDisplay {
	doing: OutlineTasksViewTask[];
	waiting: OutlineTasksViewTask[];
	next: OutlineTasksViewTask[];
	/** Open tasks by section, counted over everything the view read (not only those listed). */
	counts: { doing: number; waiting: number; todo: number };
	/** The view read only a leading part of the open tasks: there are more than counted. */
	more?: true;
}

/** Tasks a section of the display lists at most. */
export const OUTLINE_TASKS_VIEW_DISPLAY_LIMITS = { perSection: 5 } as const;

function viewTasks(raw: unknown): OutlineTasksViewTask[] {
	if (!Array.isArray(raw)) return [];
	const out: OutlineTasksViewTask[] = [];
	for (const item of raw.slice(0, OUTLINE_TASKS_VIEW_DISPLAY_LIMITS.perSection)) {
		if (!isRecord(item)) continue;
		const address = typeof item.address === "string" ? clipNoticeLine(item.address, 80) : "";
		const title = typeof item.title === "string" ? clipNoticeLine(item.title) : "";
		if (!address && !title) continue;
		out.push({ address, title, ...(item.humanCreated === true ? { humanCreated: true } : {}) });
	}
	return out;
}

function count(raw: unknown): number {
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/**
 * Read a stored display back: the bounded display, `null` when the view was removed (no open
 * tasks), `undefined` when the value is not one (a row written before displays existed).
 */
export function coerceOutlineTasksViewDisplay(
	value: unknown,
): OutlineTasksViewDisplay | null | undefined {
	if (value === null) return null;
	if (!isRecord(value)) return undefined;
	const counts = isRecord(value.counts) ? value.counts : {};
	return {
		doing: viewTasks(value.doing),
		waiting: viewTasks(value.waiting),
		next: viewTasks(value.next),
		counts: {
			doing: count(counts.doing),
			waiting: count(counts.waiting),
			todo: count(counts.todo),
		},
		...(value.more === true ? { more: true as const } : {}),
	};
}
