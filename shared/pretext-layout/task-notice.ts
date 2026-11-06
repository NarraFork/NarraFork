/**
 * task-notice.ts — the transcript's task notices, as data for the `tasks_notice` system card.
 *
 * Four notices about a session's tasks used to reach the reader as the model's own text,
 * projected to Markdown and then painted as plain text (`origin_notice`): a `######` before the
 * headline, a backslash before every escaped character, the sentence twice, and bare `key/sid`
 * addresses. They are now one folded line each, with the task as a titled outline link and its
 * status as a chip, and the tasks as rows when unfolded:
 *
 *   - `turnEnd`   — `outline_task_turn_end`: a long turn ended with a task still in progress;
 *   - `edited`    — `outline_task_edit`: people changed tasks of the session; also
 *                   `outline_task_finished`: tasks the session created were finished elsewhere
 *                   (outline P2 PR 9b), titled by who finished them;
 *   - `interrupt` — `interrupt_task_guard`: the open tasks after a user interrupt (outline and spec);
 *   - `view`      — a `context_update` of the outline current-tasks view (`outline.tasks`);
 *   - `answers`   — `outline_answer`: a person answered questions the session asked (outline P2
 *                   PR 7), the questions as rows with the answers beside them.
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
	type OutlineAnswerNoticeItem,
	type OutlineTaskNoticeChange,
	type OutlineTaskNoticeItem,
	type OutlineTasksViewDisplay,
	type OutlineTasksViewTask,
} from "../outline-task-notice";
import type { SideCarBody, SideCarTaskEntry } from "../sidecar-body";

export type TaskNoticeVariant = "turnEnd" | "edited" | "interrupt" | "view" | "answers";

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
	/** A row under the one before it (a question's answer): drawn indented, still one line. */
	indent?: true;
}

/** The folded line after the notice's title: `lead`, one task row inline, `tail`. */
export interface TaskNoticeSummary {
	lead?: string;
	row?: TaskNoticeRow;
	tail?: string;
	/**
	 * The tail is what the notice is for (a question's answer), so the row's title gives way to it
	 * rather than the other way round.
	 */
	tailFirst?: true;
}

/** The `system-text` card data of a task notice (`kind: "tasks_notice"`). */
export interface TaskNoticeData {
	kind: "tasks_notice";
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
	taskNoticeStatusDelegated: "Delegated",
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
	taskNoticeFinishedTitle: "{who} finished {n} task(s) this session created",
	taskNoticeTurnEndTail: "not ticked done yet",
	taskNoticeOpenLead: "{n} open:",
	taskNoticeOpenLeadAtLeast: "at least {n} open:",
	taskNoticeMoreTail: "and {n} more",
	taskNoticeMoreRow: "{n} more not listed",
	taskNoticeMoreRowAtLeast: "at least {n} more not listed",
	taskNoticeViewTitle: "Current tasks updated",
	taskNoticeViewEmpty: "The current task list is empty",
	taskNoticeCountDoing: "{n} in progress",
	taskNoticeCountWaiting: "{n} waiting",
	taskNoticeCountDelegated: "{n} delegated",
	taskNoticeCountTodo: "{n} to do",
	taskNoticeCountSep: " · ",
	taskNoticeAnswersTitle: "{who} answered {n} question(s)",
	taskNoticeAnswersSomeone: "Someone",
	taskNoticeAnswerOption: "option {n}: {option}",
	taskNoticeAnswerOptionBare: "option {n}",
	taskNoticeAnswerText: "\u201c{text}\u201d",
	taskNoticeAnswerAdopted: "your recommendation",
	taskNoticeAnswerDiffers: "differs from your pick",
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
	delegated: "violet",
};

const STATUS_KEY: Record<string, string> = {
	todo: "taskNoticeStatusTodo",
	doing: "taskNoticeStatusDoing",
	done: "taskNoticeStatusDone",
	cancelled: "taskNoticeStatusCancelled",
	waiting: "taskNoticeStatusWaiting",
	delegated: "taskNoticeStatusDelegated",
};

function chip(status: string | undefined | null, labels: Labels): TaskNoticeChip | undefined {
	if (!status) return undefined;
	const key = STATUS_KEY[status];
	return key ? { label: label(labels, key), color: STATUS_COLOR[status] ?? "gray" } : undefined;
}

/** The row's title and link; a task with no address is plain text. */
function named(
	address: string | undefined | null,
	title: string,
): Pick<TaskNoticeRow, "title" | "href" | "address"> {
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
		...(status ? { status } : {}),
		...(from ? { statusFrom: from } : {}),
		...(marks.length > 0 ? { marks } : {}),
		...(notes.length > 0 ? { note: notes.join(label(labels, "taskNoticeJoin")) } : {}),
	};
}

/** "N more not listed"; `atLeast` when the count is a lower bound (the read stopped early). */
function moreRow(n: number, labels: Labels, atLeast = false): TaskNoticeRow {
	return {
		title: label(labels, atLeast ? "taskNoticeMoreRowAtLeast" : "taskNoticeMoreRow", { n }),
		dim: true,
	};
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
		kind: "tasks_notice",
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
		// Tasks the session created that someone else finished (outline P2 PR 9b): one finisher
		// per notice (one commit), named in the heading.
		const finished = body.variant === "finished";
		const showBy = people.length > 1;
		const rows = body.items.map((item) => itemRow(item, labels, showBy));
		if (body.more) rows.push(moreRow(body.more, labels));
		// Tasks, not (person, task) entries: two people changing one task is one task. `more`
		// counts tasks the notice left out (`outline-task-edits.ts`).
		const n = new Set(body.items.map((item) => item.address || item.title)).size + (body.more ?? 0);
		const who =
			people.length === 0
				? sourceTitle
				: people.length <= 3
					? people.join(label(labels, "taskNoticeWhoJoin"))
					: `${people.slice(0, 3).join(label(labels, "taskNoticeWhoJoin"))}…`;
		return notice(
			"edited",
			people.length === 0
				? sourceTitle
				: label(labels, finished ? "taskNoticeFinishedTitle" : "taskNoticeEditedTitle", {
						who,
						n,
					}),
			{
				row: rows[0],
				...(n > 1 ? { tail: label(labels, "taskNoticeMoreTail", { n: n - 1 }) } : {}),
			},
			rows,
		);
	}
	if (body.kind === "outlineAnswers") {
		if (body.items.length === 0) return null;
		// Two rows a question (it, then its answer under it), within the card's rows and a last
		// row counting the questions left out.
		const listed = body.items.slice(0, ANSWERS_LISTED);
		const rows = listed.flatMap((item) => answerRows(item, labels));
		const left = body.items.length - listed.length + (body.more ?? 0);
		if (left > 0) rows.push(moreRow(left, labels));
		const n = body.items.length + (body.more ?? 0);
		const first = listed[0] as OutlineAnswerNoticeItem;
		return notice(
			"answers",
			label(labels, "taskNoticeAnswersTitle", {
				who: body.by || label(labels, "taskNoticeAnswersSomeone"),
				n,
			}),
			{
				// The folded line names the first question and gives its answer the room.
				row: rows[0] as TaskNoticeRow,
				tail: answerNote(first, labels),
				tailFirst: true,
			},
			rows,
		);
	}
	if (body.kind === "tasks" && source === "interrupt_task_guard") {
		const tasks = body.tasks ?? [];
		if (tasks.length === 0) return null;
		const outline = body.taskBackend === "outline";
		const rows = tasks.map((task) => interruptRow(task, outline, labels));
		// The guard lists a prefix of the open tasks (at most eight); `taskCount` says how many the
		// source listed when that was more, itself a prefix of a long list: a lower bound.
		const counted =
			typeof body.taskCount === "number" && Number.isFinite(body.taskCount)
				? Math.floor(body.taskCount)
				: 0;
		const total = Math.max(tasks.length, counted);
		const partial = total > tasks.length;
		if (partial) rows.push(moreRow(total - tasks.length, labels, true));
		return notice(
			"interrupt",
			sourceTitle,
			{
				lead: label(labels, partial ? "taskNoticeOpenLeadAtLeast" : "taskNoticeOpenLead", {
					n: total,
				}),
				row: rows[0],
				...(total > 1 ? { tail: label(labels, "taskNoticeMoreTail", { n: total - 1 }) } : {}),
			},
			rows,
		);
	}
	return null;
}

/** The answer in the reader's words: the option chosen and/or their words, after an arrow. */
function answerNote(item: OutlineAnswerNoticeItem, labels: Labels): string {
	const a = item.answer;
	const parts: string[] = [];
	if (a.option !== undefined) {
		parts.push(
			a.optionText
				? label(labels, "taskNoticeAnswerOption", { n: a.option, option: a.optionText })
				: label(labels, "taskNoticeAnswerOptionBare", { n: a.option }),
		);
	}
	if (a.text) parts.push(label(labels, "taskNoticeAnswerText", { text: a.text }));
	if (a.adopted) parts.push(label(labels, "taskNoticeAnswerAdopted"));
	return `→ ${parts.join(label(labels, "taskNoticeJoin"))}`;
}

/** Questions an answer notice lists, two rows each, leaving one row for the rest. */
const ANSWERS_LISTED = Math.floor((TASK_NOTICE_MAX_ROWS - 1) / 2);

/**
 * A question (its alias chip, its title as a link) and, on its own indented row under it, the
 * answer: what the notice is for, so it never shares a line with a long question.
 */
function answerRows(item: OutlineAnswerNoticeItem, labels: Labels): TaskNoticeRow[] {
	return [
		{
			...named(item.address, item.question),
			// The question's alias, as written (case-sensitive): the chip before its title.
			...(item.alias ? { status: { label: item.alias, color: "teal" } } : {}),
			...(item.differs ? { marks: [label(labels, "taskNoticeAnswerDiffers")] } : {}),
		},
		{ title: answerNote(item, labels), indent: true },
	];
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
		...(status ? { status } : {}),
		...(mark ? { marks: [mark] } : {}),
	};
}

/** How the host's `context_update` notice row starts (`narrator-epochs.ts`). */
export const CONTEXT_UPDATE_NOTICE = "Context updated: ";

export interface ContextUpdateBlockLike {
	type: string;
	text?: string | null;
	[key: string]: unknown;
}

/**
 * The part keys a host `context_update` row names in its notice text, or null when the row is
 * not one (no `context_update` block, or a notice that does not start the host's way). The
 * stored row names the keys in English; the update itself is in its snapshot.
 */
export function contextUpdateKeys(blocks: readonly ContextUpdateBlockLike[]): string[] | null {
	if (!blocks.some((block) => block.type === "context_update")) return null;
	const notice = blocks.find((block) => block.type === "text")?.text ?? "";
	if (!notice.startsWith(CONTEXT_UPDATE_NOTICE)) return null;
	return notice
		.slice(CONTEXT_UPDATE_NOTICE.length)
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
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
	const keys = contextUpdateKeys(blocks) ?? [OUTLINE_TASKS_VIEW_KEY];
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
	// Removed: no task is open, or the session's tasks left the outline (its backend changed).
	// The row cannot tell which, so it says what is true of both: the list is empty.
	if (!view) return notice("view", title, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	const row = (task: OutlineTasksViewTask, status: string): TaskNoticeRow => {
		const statusChip = chip(status, labels);
		return {
			...named(task.address, task.title),
			...(statusChip ? { status: statusChip } : {}),
			...(task.humanCreated ? { marks: [label(labels, "taskNoticeMarkHumanCreated")] } : {}),
		};
	};
	const delegated = view.delegated ?? [];
	const rows = [
		...view.doing.map((task) => row(task, "doing")),
		// Handed to the session's subagents (outline P2 PR 9b), right after its own work.
		...delegated.map((task) => row(task, "delegated")),
		...view.waiting.map((task) => row(task, "waiting")),
		...view.next.map((task) => row(task, "todo")),
	];
	const delegatedCount = view.counts.delegated ?? 0;
	const total = view.counts.doing + delegatedCount + view.counts.waiting + view.counts.todo;
	// A read that stopped early counted only what it read: there are more than `total`.
	if (view.more) rows.push(moreRow(Math.max(1, total - rows.length), labels, true));
	else if (total > rows.length) rows.push(moreRow(total - rows.length, labels));
	if (rows.length === 0 || rows[0]?.dim) {
		return notice("view", title, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	}
	// The folded line: the first task listed, then how many of each kind besides it.
	const first: "doing" | "delegated" | "waiting" | "todo" =
		view.doing.length > 0
			? "doing"
			: delegated.length > 0
				? "delegated"
				: view.waiting.length > 0
					? "waiting"
					: "todo";
	const left = {
		doing: view.counts.doing - (first === "doing" ? 1 : 0),
		delegated: delegatedCount - (first === "delegated" ? 1 : 0),
		waiting: view.counts.waiting - (first === "waiting" ? 1 : 0),
		todo: view.counts.todo - (first === "todo" ? 1 : 0),
	};
	const counts = [
		left.doing > 0 ? label(labels, "taskNoticeCountDoing", { n: left.doing }) : null,
		left.delegated > 0 ? label(labels, "taskNoticeCountDelegated", { n: left.delegated }) : null,
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
