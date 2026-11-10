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
 *                   (outline P2 PR 9b), titled by who finished them; also
 *                   `outline_team_activity`: what others did around the session's tasks since its
 *                   last turn (outline P2 PR 10b), each row naming who;
 *   - `interrupt` — `interrupt_task_guard`: the open tasks after a user interrupt (outline and spec);
 *   - `view`      — a `context_update` of the outline current-tasks view (`outline.tasks`): its
 *                   heading says what changed since the view the session saw before ("Finished
 *                   “Add tests”, started “Fix the race”"), from the changes the server stored;
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
	clipNoticeLine,
	coerceOutlineTasksViewDisplay,
	OUTLINE_TASKS_VIEW_KEY,
	OUTLINE_TASKS_VIEW_STATES,
	type OutlineAnswerNoticeItem,
	type OutlineTaskNoticeChange,
	type OutlineTaskNoticeItem,
	type OutlineTasksViewChange,
	type OutlineTasksViewChangeKind,
	type OutlineTasksViewDisplay,
	type OutlineTasksViewState,
	type OutlineTasksViewTask,
} from "../outline-task-notice";
import { type ContextUpdateBlockLike, contextUpdateKeys } from "../prefix-context";
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
	/**
	 * Who made the change, drawn first (dimmed) so a long title cannot push it out of the line
	 * (team activity, where every row may be someone else's).
	 */
	lead?: string;
	/** A row that names no task ("3 more not listed"): dimmed text only. */
	dim?: true;
	/** A row under the one before it (a question's answer): drawn indented, still one line. */
	indent?: true;
	/** The row is one of the changes the notice is about (the view's update): drawn marked. */
	changed?: true;
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
	/**
	 * The heading is what the notice says (the changes, in words): folded, it keeps the line and the
	 * summary (the counts) takes what it leaves, instead of the heading giving way to a task.
	 */
	titleFirst?: true;
	/** Nothing a reader needs to act on (the list was only refreshed): the heading is drawn plain. */
	quiet?: true;
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
	taskNoticeChangeNotes: "{n} note(s) added",
	taskNoticeChangeReports: "{n} report(s) attached",
	taskNoticeChangeAnswers: "{n} question(s) answered",
	taskNoticeChangeClaimable: "put in the claim pool",
	taskNoticeChangeOverlap: "also changing {path}",
	taskNoticeChangeOverlapHidden: "another session's task is also changing it",
	taskNoticeActivityTitle: "Team activity: {n} change(s)",
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
	taskNoticeViewCurrent: "Current tasks",
	taskNoticeViewRefreshed: "Task list refreshed",
	taskNoticeViewChangedOne: "1 task change",
	taskNoticeViewChanged: "{n} task changes",
	taskNoticeViewDid_done: "finished \u201c{title}\u201d",
	taskNoticeViewDid_started: "started \u201c{title}\u201d",
	taskNoticeViewDid_cancelled: "cancelled \u201c{title}\u201d",
	taskNoticeViewDid_returned: "a subagent handed back \u201c{title}\u201d",
	taskNoticeViewDid_delegated: "handed \u201c{title}\u201d to a subagent",
	taskNoticeViewDid_waiting: "\u201c{title}\u201d is now waiting",
	taskNoticeViewDid_unblocked: "\u201c{title}\u201d is no longer waiting",
	taskNoticeViewDid_added: "added \u201c{title}\u201d",
	taskNoticeViewDid_requeued: "put \u201c{title}\u201d back to to-do",
	taskNoticeViewDid_removed: "removed \u201c{title}\u201d",
	taskNoticeViewDid_unlisted: "\u201c{title}\u201d is no longer listed",
	taskNoticeViewDid_renamed: "renamed a task to \u201c{title}\u201d",
	taskNoticeViewDidJoin: ", ",
	taskNoticeViewDidMore: "{list}, and {n} more",
	taskNoticeViewNoteReturned: "handed back by a subagent",
	taskNoticeViewNoteRemoved: "removed",
	taskNoticeViewNoteUnlisted: "no longer listed",
	taskNoticeViewNoteRenamed: "renamed",
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
		case "notes":
			return label(labels, "taskNoticeChangeNotes", { n: change.n });
		case "reports":
			return label(labels, "taskNoticeChangeReports", { n: change.n });
		case "answers":
			return label(labels, "taskNoticeChangeAnswers", { n: change.n });
		case "claimable":
			return label(labels, "taskNoticeChangeClaimable");
		case "overlap":
			return label(labels, "taskNoticeChangeOverlap", { path: change.path });
	}
}

function itemRow(
	item: OutlineTaskNoticeItem,
	labels: Labels,
	showBy: boolean,
	byFirst = false,
): TaskNoticeRow {
	const changes = item.changes ?? [];
	const statusChange = changes.find(
		(change): change is Extract<OutlineTaskNoticeChange, { kind: "status" }> =>
			change.kind === "status",
	);
	const notes = changes
		.map((change) =>
			// A file whose task the session may not name: the row is the path, said once.
			change.kind === "overlap" && !item.address && change.path === item.title
				? label(labels, "taskNoticeChangeOverlapHidden")
				: changeNote(change, labels),
		)
		.filter((note): note is string => !!note);
	if (showBy && item.by && !byFirst) notes.unshift(item.by);
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
		...(byFirst && item.by ? { lead: item.by } : {}),
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
			row.lead ? `${row.lead}:` : "",
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
	/** The folded line shows no task (the heading says it all): one row is worth unfolding for. */
	foldedShowsNoTask = false,
): TaskNoticeData {
	const listed = rows.slice(0, TASK_NOTICE_MAX_ROWS);
	return {
		kind: "tasks_notice",
		variant,
		title,
		summary,
		rows: listed,
		expandable: listed.length > (foldedShowsNoTask ? 0 : 1),
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
		if (body.variant === "activity") {
			// Team activity (outline P2 PR 10b): several sessions and people, one change a row; every
			// row names who made it. Counted in changes, not tasks: one task may change twice.
			const rows = body.items.map((item) => itemRow(item, labels, true, true));
			if (body.more) rows.push(moreRow(body.more, labels));
			const n = body.items.length + (body.more ?? 0);
			return notice(
				"edited",
				label(labels, "taskNoticeActivityTitle", { n }),
				{
					row: rows[0],
					...(n > 1 ? { tail: label(labels, "taskNoticeMoreTail", { n: n - 1 }) } : {}),
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

export {
	CONTEXT_UPDATE_NOTICE,
	type ContextUpdateBlockLike,
	contextUpdateKeys,
} from "../prefix-context";

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
	const only = keys.length === 1 && keys[0] === OUTLINE_TASKS_VIEW_KEY;
	return viewNotice(only ? null : viewsTitle, view, labels);
}

/** Changes the heading names in words; the rest are counted after them. */
export const TASK_NOTICE_VIEW_NAMED_CHANGES = 2;
/** Characters of a task's title inside the heading's sentence (its row has it in full). */
const VIEW_SENTENCE_TITLE_CHARS = 40;

/**
 * The changes in words: "Finished “Add tests”, started “Fix the race”, and 2 more". Null when
 * there are none; `{n}` of the last form is how many are left unnamed.
 */
function changeSentence(view: OutlineTasksViewDisplay, labels: Labels): string | null {
	const total = view.changed ?? 0;
	if (total <= 0) return null;
	const named = (view.changes ?? []).slice(0, TASK_NOTICE_VIEW_NAMED_CHANGES);
	if (named.length === 0) {
		return label(labels, total === 1 ? "taskNoticeViewChangedOne" : "taskNoticeViewChanged", {
			n: total,
		});
	}
	const list = named
		.map((change) =>
			label(labels, `taskNoticeViewDid_${change.kind}`, {
				title: clipNoticeLine(change.title, VIEW_SENTENCE_TITLE_CHARS),
			}),
		)
		.join(label(labels, "taskNoticeViewDidJoin"));
	const sentence =
		total > named.length
			? label(labels, "taskNoticeViewDidMore", { list, n: total - named.length })
			: list;
	// The phrases are written to follow one another; the first one starts the sentence.
	return sentence.charAt(0).toLocaleUpperCase() + sentence.slice(1);
}

/** The state a change leaves its task in, when the task is no longer on the list. */
const GONE_STATUS: Partial<Record<OutlineTasksViewChangeKind, string>> = {
	done: "done",
	cancelled: "cancelled",
};

const CHANGE_NOTE: Partial<Record<OutlineTasksViewChangeKind, string>> = {
	added: "taskNoticeChangeAdded",
	returned: "taskNoticeViewNoteReturned",
	removed: "taskNoticeViewNoteRemoved",
	unlisted: "taskNoticeViewNoteUnlisted",
	renamed: "taskNoticeViewNoteRenamed",
};

/** What a row says of its task's change: where it came from (a chip), and a word where chips cannot. */
function changeMarks(
	change: OutlineTasksViewChange,
	status: string | undefined,
	labels: Labels,
): Pick<TaskNoticeRow, "statusFrom" | "note" | "changed"> {
	const from = change.from && change.from !== status ? chip(change.from, labels) : undefined;
	// New on the list and already under way: no state to come from, so the row says it is new.
	// Not when the state it came from is merely unknown (the previous table was cut).
	const noteKey =
		CHANGE_NOTE[change.kind] ??
		(!change.from && !change.fromUnknown && !GONE_STATUS[change.kind]
			? "taskNoticeChangeAdded"
			: undefined);
	return {
		...(from && status ? { statusFrom: from } : {}),
		...(noteKey ? { note: label(labels, noteKey) } : {}),
		changed: true,
	};
}

function viewNotice(
	/** The heading of an update that changed other parts too; null when it changed only the view. */
	viewsTitle: string | null,
	view: OutlineTasksViewDisplay | null,
	labels: Labels,
): TaskNoticeData {
	const updated = viewsTitle ?? label(labels, "taskNoticeViewTitle");
	// Removed: no task is open, or the session's tasks left the outline (its backend changed).
	// The row cannot tell which, so it says what is true of both: the list is empty.
	if (!view) return notice("view", updated, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	const changes = new Map((view.changes ?? []).map((change) => [change.address, change]));
	const row = (task: OutlineTasksViewTask, status: string): TaskNoticeRow => {
		const statusChip = chip(status, labels);
		const change = changes.get(task.address);
		return {
			...named(task.address, task.title),
			...(statusChip ? { status: statusChip } : {}),
			...(task.humanCreated ? { marks: [label(labels, "taskNoticeMarkHumanCreated")] } : {}),
			...(change ? changeMarks(change, status, labels) : {}),
		};
	};
	const delegated = view.delegated ?? [];
	const listed = [
		...view.doing.map((task) => row(task, "doing")),
		// Handed to the session's subagents (outline P2 PR 9b), right after its own work.
		...delegated.map((task) => row(task, "delegated")),
		...view.waiting.map((task) => row(task, "waiting")),
		...view.next.map((task) => row(task, "todo")),
	];
	// The changes of tasks the list does not show (finished ones, to-dos past the first), first.
	const shown = new Set(listed.map((item) => item.address));
	const stateOf = (address: string): OutlineTasksViewState | undefined =>
		OUTLINE_TASKS_VIEW_STATES.find((state) => view.states?.[state]?.includes(address));
	const changeRows = (view.changes ?? [])
		.filter((change) => !shown.has(change.address))
		.map((change): TaskNoticeRow => {
			const status = GONE_STATUS[change.kind] ?? stateOf(change.address);
			const statusChip = chip(status, labels);
			return {
				...named(change.address, change.title),
				...(statusChip ? { status: statusChip } : {}),
				...changeMarks(change, status, labels),
			};
		});
	const rows = [...changeRows, ...listed];
	const delegatedCount = view.counts.delegated ?? 0;
	const total = view.counts.doing + delegatedCount + view.counts.waiting + view.counts.todo;
	// A read that stopped early counted only what it read: there are more than `total`.
	if (view.more) rows.push(moreRow(Math.max(1, total - listed.length), labels, true));
	else if (total > listed.length) rows.push(moreRow(total - listed.length, labels));
	const countsLine = (counts: Record<OutlineTasksViewState, number>): string => {
		const parts = [
			counts.doing > 0 ? label(labels, "taskNoticeCountDoing", { n: counts.doing }) : null,
			counts.delegated > 0
				? label(labels, "taskNoticeCountDelegated", { n: counts.delegated })
				: null,
			counts.waiting > 0 ? label(labels, "taskNoticeCountWaiting", { n: counts.waiting }) : null,
			counts.todo > 0 ? label(labels, "taskNoticeCountTodo", { n: counts.todo }) : null,
		].filter((part): part is string => !!part);
		return parts.length > 0
			? `${parts.join(label(labels, "taskNoticeCountSep"))}${view.more ? "…" : ""}`
			: view.more
				? "…"
				: "";
	};
	const all = {
		doing: view.counts.doing,
		delegated: delegatedCount,
		waiting: view.counts.waiting,
		todo: view.counts.todo,
	};

	// Compared with the view the session saw before: the heading says what changed, the counts of
	// the list as it is now come second.
	if (view.changes) {
		const sentence = changeSentence(view, labels);
		const counts =
			listed.length === 0 && total === 0 ? label(labels, "taskNoticeViewEmpty") : countsLine(all);
		// Beside other parts' update the heading stays theirs, and the changes lead the line.
		const lead = viewsTitle
			? [sentence ?? label(labels, "taskNoticeViewRefreshed"), counts]
					.filter(Boolean)
					.join(label(labels, "taskNoticeCountSep"))
			: counts;
		const data = notice(
			"view",
			viewsTitle ?? sentence ?? label(labels, "taskNoticeViewRefreshed"),
			lead ? { lead } : {},
			rows,
			true,
		);
		return {
			...data,
			...(viewsTitle ? {} : { titleFirst: true as const }),
			...(sentence ? {} : { quiet: true as const }),
		};
	}

	if (listed.length === 0) {
		return notice("view", updated, { lead: label(labels, "taskNoticeViewEmpty") }, []);
	}
	// Nothing to compare with (the first view of an epoch): the list as it is, not an "update".
	// A row written before state tables existed keeps its heading.
	const title =
		viewsTitle ?? label(labels, view.states ? "taskNoticeViewCurrent" : "taskNoticeViewTitle");
	// The folded line: the first task listed, then how many of each kind besides it.
	const first: OutlineTasksViewState =
		view.doing.length > 0
			? "doing"
			: delegated.length > 0
				? "delegated"
				: view.waiting.length > 0
					? "waiting"
					: "todo";
	const tail = countsLine({ ...all, [first]: all[first] - 1 });
	return notice("view", title, { row: rows[0], ...(tail ? { tail } : {}) }, rows);
}
