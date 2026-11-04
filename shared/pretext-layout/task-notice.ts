/**
 * task-notice.ts — the transcript's task notices, as data for the `task_notice` system card.
 *
 * Four notices about a session's tasks used to reach the reader as the model's own text,
 * projected to Markdown and then painted as plain text (`origin_notice`): a `######` before the
 * headline, a backslash before every escaped character, the sentence twice, and bare `key/sid`
 * addresses. They are now one folded line each, with the task as a titled outline link and its
 * status as a chip, and the tasks as rows when unfolded:
 *
 *   - `turnEnd`   — `outline_task_turn_end`: a long turn ended with a task still in progress;
 *   - `edited`    — `outline_task_edit`: people changed tasks of the session;
 *   - `interrupt` — `interrupt_task_guard`: the open tasks after a user interrupt (outline and spec);
 *   - `view`      — a `context_update` of the outline current-tasks view (`outline.tasks`).
 *
 * Everything here is derived from STRUCTURED data the server stored beside the model-facing text
 * (`SideCarBody` `outlineTasks` / `tasks`, a `context_update` row's `display`); nothing parses the
 * model's prose. Rows written before that data existed keep their old card (see
 * `sideCarBodyToPlainText`, `outlineViewUpdateLine`).
 *
 * Geometry is fixed: the folded card is one line, each row is one line (truncated, the full title
 * on hover), so the measure pass needs no text layout — only the row count.
 *
 * PURITY: no DOM, no React (shared pretext core). Copy arrives through `labels` (the shell's
 * `ctx.labels`), with English fallbacks.
 */

import { outlineAddressPath } from "../outline-links";
import {
	coerceOutlineTasksViewDisplay,
	OUTLINE_TASKS_VIEW_KEY,
	type OutlineTaskNoticeChange,
	type OutlineTaskNoticeItem,
	type OutlineTasksViewDisplay,
	type OutlineTasksViewTask,
} from "../outline-task-notice";
import type { SideCarBody, SideCarTaskEntry } from "../sidecar-body";

export type TaskNoticeVariant = "turnEnd" | "edited" | "interrupt" | "view";

/** A status chip: its words and its Mantine colour. */
export interface TaskNoticeChip {
	label: string;
	color: string;
}

/** One task line of a notice. Every field is height-neutral: a row is one line. */
export interface TaskNoticeRow {
	/** The task's title (plain, one line). */
	title: string;
	/** App path of its outline link (`outlineAddressPath`); absent when it has no address. */
	href?: string;
	/** Its `key/sid`, for the link's tooltip. */
	address?: string;
	/** Its status chip; with `statusFrom`, a change from one to the other. */
	status?: TaskNoticeChip;
	statusFrom?: TaskNoticeChip;
	/** Small chips after the title (set by a person, locked, protected). */
	marks?: string[];
	/** What changed, in the reader's words (dimmed, after the title). */
	note?: string;
	/** A row that names no task ("3 more not listed"): dimmed text only. */
	dim?: true;
}

/** The folded line after the notice's title: `lead`, one task row inline, `tail`. */
export interface TaskNoticeSummary {
	lead?: string;
	row?: TaskNoticeRow;
	tail?: string;
}

/** The `system-text` card data of a task notice (`kind: "task_notice"`). */
export interface TaskNoticeData {
	kind: "task_notice";
	variant: TaskNoticeVariant;
	/** The heading: the notice's name ("回合末任务提醒", "alice 改了 2 个任务"). */
	title: string;
	summary: TaskNoticeSummary;
	/** The rows an unfolded card lists; the summary shows the first. */
	rows: TaskNoticeRow[];
	/** True when unfolding shows more than the folded line (more than one row). */
	expandable: boolean;
	/** The notice as plain text: what copying the row gives, and part of its cache key. */
	text: string;
}

/** Rows an unfolded card lists at most (a notice names at most 20 tasks; the view at most 11). */
export const TASK_NOTICE_MAX_ROWS = 24;

/**
 * English copy. `{n}` / `{who}` / `{to}` / `{status}` / `{reason}` are interpolated.
 * The shell supplies the reader's language through `labels` (`useVListLabels`).
 */
export const TASK_NOTICE_LABEL_FALLBACKS: Readonly<Record<string, string>> = {
	taskNoticeStatusTodo: "To do",
	taskNoticeStatusDoing: "In progress",
	taskNoticeStatusDone: "Done",
	taskNoticeStatusCancelled: "Cancelled",
	taskNoticeStatusWaiting: "Waiting",
	taskNoticeMarkHumanCreated: "Set by a person",
	taskNoticeMarkLocked: "Locked",
	taskNoticeMarkProtected: "Protected",
	taskNoticeChangeAdded: "added",
	taskNoticeChangeDeleted: "deleted",
	taskNoticeChangeUnchecked: "no longer a task",
	taskNoticeChangeMoved: "moved",
	taskNoticeChangeLocked: "locked",
	taskNoticeChangeUnlocked: "unlocked",
	taskNoticeChangeFields: "prerequisites or due date changed",
	taskNoticeChangeAssigned: "handed to @{to}",
	taskNoticeChangeUnassigned: "handed back to this session",
	taskNoticeChangeRejected: "rejected marking it {status}",
	taskNoticeChangeRejectedReason: "rejected marking it {status}: {reason}",
	taskNoticeJoin: "; ",
	taskNoticeWhoJoin: ", ",
	taskNoticeEditedTitle: "{who} changed {n} task(s)",
	taskNoticeTurnEndTail: "not ticked done yet",
	taskNoticeOpenLead: "{n} open:",
	taskNoticeMoreTail: "and {n} more",
	taskNoticeMoreRow: "{n} more not listed",
	taskNoticeViewTitle: "Current tasks updated",
	taskNoticeViewEmpty: "No open tasks",
	taskNoticeCountDoing: "{n} in progress",
	taskNoticeCountWaiting: "{n} waiting",
	taskNoticeCountTodo: "{n} to do",
	taskNoticeCountSep: " · ",
};

type Labels = Readonly<Record<string, string>> | undefined;

function label(labels: Labels, key: string, params?: Record<string, string | number>): string {
	let out = labels?.[key] ?? TASK_NOTICE_LABEL_FALLBACKS[key] ?? key;
	if (params)
		for (const [k, v] of Object.entries(params)) out = out.replaceAll(`{${k}}`, String(v));
	return out;
}

const STATUS_COLOR: Record<string, string> = {
	todo: "gray",
	doing: "blue",
	done: "green",
	cancelled: "gray",
	waiting: "orange",
};

const STATUS_KEY: Record<string, string> = {
	todo: "taskNoticeStatusTodo",
	doing: "taskNoticeStatusDoing",
	done: "taskNoticeStatusDone",
	cancelled: "taskNoticeStatusCancelled",
	waiting: "taskNoticeStatusWaiting",
};

function chip(status: string | undefined | null, labels: Labels): TaskNoticeChip | undefined {
	if (!status) return undefined;
	const key = STATUS_KEY[status];
	return key ? { label: label(labels, key), color: STATUS_COLOR[status] ?? "gray" } : undefined;
}

/** The row's link and title; a task with no address is plain text. */
function named(address: string | undefined | null, title: string): Partial<TaskNoticeRow> {
	const href = outlineAddressPath(address);
	return {
		title: title || address || "",
		...(href ? { href } : {}),
		...(address ? { address } : {}),
	};
}

function changeNote(change: OutlineTaskNoticeChange, labels: Labels): string | null {
	switch (change.kind) {
		case "status":
			// Drawn as chips (`statusFrom` → `status`), not words.
			return null;
		case "added":
			return label(labels, "taskNoticeChangeAdded");
		case "deleted":
			return label(labels, "taskNoticeChangeDeleted");
		case "unchecked":
			return label(labels, "taskNoticeChangeUnchecked");
		case "moved":
			return label(labels, "taskNoticeChangeMoved");
		case "locked":
			return label(labels, "taskNoticeChangeLocked");
		case "unlocked":
			return label(labels, "taskNoticeChangeUnlocked");
		case "fields":
			return label(labels, "taskNoticeChangeFields");
		case "assigned":
			return change.to
				? label(labels, "taskNoticeChangeAssigned", { to: change.to })
				: label(labels, "taskNoticeChangeUnassigned");
		case "rejected": {
			const status = chip(change.status, labels)?.label ?? change.status;
			return change.reason
				? label(labels, "taskNoticeChangeRejectedReason", { status, reason: change.reason })
				: label(labels, "taskNoticeChangeRejected", { status });
		}
	}
}

function itemRow(item: OutlineTaskNoticeItem, labels: Labels, showBy: boolean): TaskNoticeRow {
	const changes = item.changes ?? [];
	const statusChange = changes.find(
		(change): change is Extract<OutlineTaskNoticeChange, { kind: "status" }> =>
			change.kind === "status",
	);
	const notes = changes
		.map((change) => changeNote(change, labels))
		.filter((note): note is string => !!note);
	if (showBy && item.by) notes.unshift(item.by);
	const marks = [
		item.humanCreated ? label(labels, "taskNoticeMarkHumanCreated") : null,
		item.locked ? label(labels, "taskNoticeMarkLocked") : null,
	].filter((mark): mark is string => !!mark);
	const status = statusChange
		? chip(statusChange.to, labels)
		: chip(item.waiting ? "waiting" : item.status, labels);
	const from = statusChange ? chip(statusChange.from, labels) : undefined;
	return {
		...named(item.address, item.title),
		title: item.title || item.address,
		...(status ? { status } : {}),
		...(from ? { statusFrom: from } : {}),
		...(marks.length > 0 ? { marks } : {}),
		...(notes.length > 0 ? { note: notes.join(label(labels, "taskNoticeJoin")) } : {}),
	};
}

function moreRow(n: number, labels: Labels): TaskNoticeRow {
	return { title: label(labels, "taskNoticeMoreRow", { n }), dim: true };
}

/** The notice as text: its title, then a line per row (copy, and the card's cache key). */
function plainText(title: string, summary: TaskNoticeSummary, rows: TaskNoticeRow[]): string {
	const line = (row: TaskNoticeRow) =>
		[
			row.statusFrom && row.status
				? `[${row.statusFrom.label} → ${row.status.label}]`
				: row.status
					? `[${row.status.label}]`
					: "",
			row.title,
			row.address && row.address !== row.title ? `(${row.address})` : "",
			...(row.marks ?? []).map((mark) => `· ${mark}`),
			row.note ? `— ${row.note}` : "",
		]
			.filter(Boolean)
			.join(" ");
	if (rows.length === 0) {
		return [title, [summary.lead, summary.tail].filter(Boolean).join(" ")]
			.filter(Boolean)
			.join("\n");
	}
	return [title, ...rows.map((row) => (row.dim ? row.title : `• ${line(row)}`))].join("\n");
}

function notice(
	variant: TaskNoticeVariant,
	title: string,
	summary: TaskNoticeSummary,
	rows: TaskNoticeRow[],
): TaskNoticeData {
	const listed = rows.slice(0, TASK_NOTICE_MAX_ROWS);
	return {
		kind: "task_notice",
		variant,
		title,
		summary,
		rows: listed,
		expandable: listed.length > 1,
		text: plainText(title, summary, listed),
	};
}

/**
 * The task notice of an injection body, or null when the body is not one: an `outlineTasks`
 * body (turn end, people's changes), or the `tasks` body of the interrupt guard.
 *
 * `sourceTitle` is the producer's name the card's heading shows ("回合末任务提醒").
 */
export function taskNoticeFromBody(
	source: string,
	body: SideCarBody,
	sourceTitle: string,
	labels: Labels,
): TaskNoticeData | null {
	if (body.kind === "outlineTasks") {
		if (body.items.length === 0) return null;
		if (body.variant === "turnEnd") {
			const rows = body.items.map((item) => itemRow(item, labels, false));
			return notice(
				"turnEnd",
				sourceTitle,
				{
					row: rows[0],
					tail: label(labels, "taskNoticeTurnEndTail"),
				},
				rows,
			);
		}
		const people = [...new Set(body.items.map((item) => item.by).filter(Boolean))] as string[];
		const showBy = people.length > 1;
		const rows = body.items.map((item) => itemRow(item, labels, showBy));
		if (body.more) rows.push(moreRow(body.more, labels));
		const n = body.items.length + (body.more ?? 0);
		const who =
			people.length === 0
				? sourceTitle
				: people.length <= 3
					? people.join(label(labels, "taskNoticeWhoJoin"))
					: `${people.slice(0, 3).join(label(labels, "taskNoticeWhoJoin"))}…`;
		return notice(
			"edited",
			people.length === 0 ? sourceTitle : label(labels, "taskNoticeEditedTitle", { who, n }),
			{
				row: rows[0],
				...(n > 1 ? { tail: label(labels, "taskNoticeMoreTail", { n: n - 1 }) } : {}),
			},
			rows,
		);
	}
	if (body.kind === "tasks" && source === "interrupt_task_guard") {
		const tasks = body.tasks ?? [];
		if (tasks.length === 0) return null;
		const outline = body.taskBackend === "outline";
		const rows = tasks.map((task) => interruptRow(task, outline, labels));
		return notice(
			"interrupt",
			sourceTitle,
			{
				lead: label(labels, "taskNoticeOpenLead", { n: tasks.length }),
				row: rows[0],
				...(tasks.length > 1
					? { tail: label(labels, "taskNoticeMoreTail", { n: tasks.length - 1 }) }
					: {}),
			},
			rows,
		);
	}
	return null;
}

function interruptRow(task: SideCarTaskEntry, outline: boolean, labels: Labels): TaskNoticeRow {
	const status = chip(
		task.role === "blocked" ? "waiting" : task.role === "doing" ? "doing" : "todo",
		labels,
	);
	const mark = task.protected
		? label(labels, outline ? "taskNoticeMarkHumanCreated" : "taskNoticeMarkProtected")
		: null;
	return {
		...named(task.ref, task.text),
		title: task.text || task.ref || "",
		...(status ? { status } : {}),
		...(mark ? { marks: [mark] } : {}),
	};
}

/** How the host's `context_update` notice row starts (`narrator-epochs.ts`). */
const CONTEXT_UPDATE_NOTICE = "Context updated: ";

interface ContextUpdateBlockLike {
	type: string;
	text?: string | null;
	[key: string]: unknown;
}

/**
 * The task notice of a `context_update` row that changed the outline current-tasks view, from
 * the summary the server stored beside it (`display["outline.tasks"]`). Null for any other row,
 * and for a row written before summaries existed (it keeps its one-line notice).
 *
 * `viewsTitle` is the existing "Context updated: …" line in the reader's words, used as the
 * heading when the update changed other parts too.
 */
export function taskNoticeFromContextUpdate(
	blocks: readonly ContextUpdateBlockLike[],
	viewsTitle: string | null,
	labels: Labels,
): TaskNoticeData | null {
	const update = blocks.find((block) => block.type === "context_update");
	const display = update?.display;
	if (!display || typeof display !== "object" || Array.isArray(display)) return null;
	if (!(OUTLINE_TASKS_VIEW_KEY in display)) return null;
	const view = coerceOutlineTasksViewDisplay(
		(display as Record<string, unknown>)[OUTLINE_TASKS_VIEW_KEY],
	);
	if (view === undefined) return null;
	const notice = blocks.find((block) => block.type === "text")?.text ?? "";
	const keys = notice.startsWith(CONTEXT_UPDATE_NOTICE)
		? notice
				.slice(CONTEXT_UPDATE_NOTICE.length)
				.split(",")
				.map((key) => key.trim())
				.filter(Boolean)
		: [OUTLINE_TASKS_VIEW_KEY];
	const title =
		keys.length === 1 && keys[0] === OUTLINE_TASKS_VIEW_KEY
			? label(labels, "taskNoticeViewTitle")
			: (viewsTitle ?? label(labels, "taskNoticeViewTitle"));
	return viewNotice(title, view, labels);
}

function viewNotice(
	title: string,
	view: OutlineTasksViewDisplay | null,
	labels: Labels,
): TaskNoticeData {
	if (!view) return notice("view", title, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	const row = (task: OutlineTasksViewTask, status: string): TaskNoticeRow => {
		const statusChip = chip(status, labels);
		return {
			...named(task.address, task.title),
			title: task.title || task.address,
			...(statusChip ? { status: statusChip } : {}),
			...(task.humanCreated ? { marks: [label(labels, "taskNoticeMarkHumanCreated")] } : {}),
		};
	};
	const rows = [
		...view.doing.map((task) => row(task, "doing")),
		...view.waiting.map((task) => row(task, "waiting")),
		...view.next.map((task) => row(task, "todo")),
	];
	const total = view.counts.doing + view.counts.waiting + view.counts.todo;
	if (total > rows.length) rows.push(moreRow(total - rows.length, labels));
	if (rows.length === 0 || rows[0]?.dim) {
		return notice("view", title, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	}
	// The folded line: the first task listed, then how many of each kind besides it.
	const first: "doing" | "waiting" | "todo" =
		view.doing.length > 0 ? "doing" : view.waiting.length > 0 ? "waiting" : "todo";
	const left = {
		doing: view.counts.doing - (first === "doing" ? 1 : 0),
		waiting: view.counts.waiting - (first === "waiting" ? 1 : 0),
		todo: view.counts.todo - (first === "todo" ? 1 : 0),
	};
	const counts = [
		left.doing > 0 ? label(labels, "taskNoticeCountDoing", { n: left.doing }) : null,
		left.waiting > 0 ? label(labels, "taskNoticeCountWaiting", { n: left.waiting }) : null,
		left.todo > 0 ? label(labels, "taskNoticeCountTodo", { n: left.todo }) : null,
	].filter((part): part is string => !!part);
	const tail =
		counts.length > 0
			? `${counts.join(label(labels, "taskNoticeCountSep"))}${view.more ? "…" : ""}`
			: view.more
				? "…"
				: "";
	return notice("view", title, { row: rows[0], ...(tail ? { tail } : {}) }, rows);
}
