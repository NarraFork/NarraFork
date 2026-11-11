/**
 * Text of the outline delegation (outline P2 PR 9a, `delegation.ts`), in one place.
 *
 *   - What the agents read (the `Agent` refusals, the subagent's instructions, the note added to a
 *     subagent's result): English, like every tool result.
 *   - What people read in the outline (the report block under the task): in the delegating
 *     session's language, like the plan review's block (outline P2 PR 8b).
 *
 * The note added to a result starts with one fixed line, `<outline_report … status="…">`, which
 * the tool card reads (outline P2 PR 9b; its form is `@shared/outline-report-note`'s
 * `OUTLINE_REPORT_NOTE_HEAD_RE`): change it only together with its reader. A reader takes
 * the LAST such head line of the result and nothing before it: the note is always the last three
 * lines, and a report may quote a note of the same form in its text (left there as it is).
 *
 * `reason="reclaimed"` means the delegating session holds the task again at a later generation:
 * it took the task up itself (after it went back to do, say), or another of its agents was sent
 * with it since and has handed it back. The claim cannot tell which; a label must not claim one.
 */

/** Language of the blocks written under a task. */
export type DelegationLocale = "en" | "zh-CN";

/** The delegating session's language, as the report blocks are written in. */
export function delegationLocale(locale: string | null | undefined): DelegationLocale {
	return locale?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

const quoted = (text: string) => JSON.stringify(text);

/** Why a delegated result is late (`classifyDelegatedResult`). */
export type DelegationLateReason =
	| "taken_over"
	| "redelegated"
	| "reclaimed"
	| "ended"
	| "reopened"
	| "gone";

/** How a run ended, as a report says when it did not finish. */
export type DelegationRunEnding = "completed" | "failed" | "timed_out" | "cancelled";

/** Model-facing text (English). */
export const DELEGATION_TEXT = {
	// ── Refusals of `Agent({ task })`: nothing was created. ──
	refused: (reason: string) => `Agent task error: ${reason}. No agent was started.`,
	notOutlineSession:
		"task is only available in sessions whose tasks live in the outline (and only to the session itself, not to its subagents)",
	planMode:
		"this session is in plan mode: plan first, and delegate the plan's steps once it is approved (research while planning is delegated without task)",
	withTakeover:
		"task cannot be combined with takeover_by_user: an agent the user takes over does not hand back a report",
	notFound: (ref: string) => `${quoted(ref)} matches no task this session can read`,
	ambiguous: (ref: string, candidates: readonly string[]) =>
		`${quoted(ref)} matches several blocks (${candidates.join(", ")}); pass the address of one`,
	notATask: (address: string) => `${address} is not a task (it has no checkbox)`,
	deleted: (address: string) => `${address} is deleted`,
	finished: (address: string, status: string) =>
		`${address} is ${status}; reopen it (set it to do) before delegating it`,
	notWritable: (address: string, why: string) =>
		`this turn may not write the space ${address} is in (${why}), and delegating it is a write`,
	planning: (address: string) =>
		`${address} is part of a plan that is not approved yet; delegate its steps once the plan is approved (research for the plan is delegated without task)`,
	waitsPrerequisites: (address: string, prerequisites: readonly string[]) =>
		`${address} waits for its prerequisites (${prerequisites.join(", ")}); delegate it once they are done`,
	waitsPeople: (address: string) =>
		`${address} waits for an answer to a question under it; delegate it once the question is answered`,
	waitsConfirmation: (address: string) =>
		`${address} waits for a change to its plan to be confirmed; delegate it once that is decided`,
	assignedToPerson: (address: string, assignee: string) =>
		`${address} is assigned to a person (@${assignee}); an agent cannot take it`,
	claimed: (address: string, holder: string) =>
		`${address} is being done by ${holder}; pick another task, or ask them`,
	runningSubagent: (address: string, holder: string) =>
		`${address} is already handed to ${holder}, which is still running; Stop it to hand the task to another agent, or Send it further instructions`,
	changedMeanwhile: (address: string) =>
		`${address} changed while it was being delegated (finished, reopened, edited or claimed meanwhile); read it again and decide again`,
	takenBySibling: (address: string, holder: string) =>
		`${address} was just handed to ${holder} by another Agent call of this session; Send it further instructions, or wait for its report`,
	noBinding: "the Agent call has no recorded tool call to delegate from",

	/** After `<background_task_id>` when a background agent was sent with a task. */
	started: (task: string, epoch: number) =>
		`Delegated ${task} to this agent (claim generation ${epoch}); its report will be attached under the task when it finishes.`,

	// ── The subagent's instructions, written from the task tree. ──
	brief: {
		title: (title: string) => `# Task: ${title}`,
		goals: (titles: readonly string[]) => `Part of: ${titles.join(" › ")}`,
		body: "## What to do",
		notes: "## Notes and steps so far",
		more: (n: number) => `- … ${n} more`,
		earlierReport: (title: string) => `${title} (an earlier report; not repeated here)`,
		decided: (question: string, answer: string) => `Decided: ${question} → ${answer}`,
		open: (question: string, suggestion: string | null) =>
			suggestion
				? `Open question: ${question} (suggested: ${suggestion})`
				: `Open question: ${question}`,
		withdrawn: (question: string) => `Withdrawn question: ${question}`,
		prerequisites: "## Prerequisites",
		prerequisite: (title: string, status: string) => `- ${title} (${status})`,
		instructions: "## Further instructions",
		unreadable: "(a block this session cannot read)",
		truncated: "…",
		closing:
			"When you are done, reply with a report: what you did, your conclusions, the evidence (file:line, the commands you ran and their results), what is left undone, and what needs a person's decision.",
	},

	// ── The note added to a delegated subagent's result. ──
	note: {
		/** The fixed first line (see the module header). */
		head: (fields: Record<string, string | number>) =>
			`<outline_report ${Object.entries(fields)
				.map(([k, v]) => `${k}="${String(v).replace(/["<>&]/g, "")}"`)
				.join(" ")}>`,
		tail: "</outline_report>",
		blocks: (n: number) => (n === 1 ? "1 block" : `${n} blocks`),
		current: (task: string, report: string, blocks: string) =>
			`The report is attached under the task ${task} as ${report} (${blocks}). The task is still in progress and yours: read the report, write a line or two of summary under the task, use Ask for anything a person must decide, and add what is left as subtasks; tick the task done if it meets its acceptance, otherwise delegate it again or do it yourself.`,
		doneBySubagent: (task: string, report: string, blocks: string) =>
			`The subagent ticked the task ${task} done itself. Its report is attached under the task as ${report} (${blocks}); if the task does not meet its acceptance, reopen it.`,
		late: {
			taken_over: (holder: string, epoch: number) =>
				`Late result: since this agent was sent, the task was taken over by ${holder} (claim generation ${epoch}).`,
			redelegated: (epoch: number) =>
				`Late result: since this agent was sent, the task was delegated again (claim generation ${epoch}).`,
			reclaimed: (epoch: number) =>
				`Late result: since this agent was sent, the task was claimed again in this session (claim generation ${epoch}): this session took it up itself, or another of its agents was sent with it and has handed it back.`,
			ended: (by: string, status: string) =>
				`Late result: since this agent was sent, the task was ticked ${status} by ${by}.`,
			reopened:
				"Late result: since this agent was sent, the task went back to do (its lease ran out, or someone reset it).",
			gone: "Late result: the task was deleted since this agent was sent (or is no longer a task).",
		},
		lateAttached: (report: string, blocks: string) =>
			`The report is attached under the task as ${report} (${blocks}), marked late. Do not tick the task done on the strength of this report; if it is useful, tell whoever is doing the task now.`,
		lateReopened: (report: string, blocks: string) =>
			`The report is attached under the task as ${report} (${blocks}), marked late. It says what was done: start the task again (set it in progress) before ticking it done on its strength.`,
		notAttachedGone: "The report was not attached; this result is its full text.",
		failed: (task: string) =>
			`The report could not be attached under the task ${task}; this result is its full text. Note what matters under the task yourself.`,
		someone: "someone",
		theSystem: "the system",
		session: (title: string | null, id: string) =>
			title ? `the session ${quoted(title)} (${id})` : `the session ${id}`,
		person: (name: string | null, id: string) => name ?? `the person ${id}`,
	},

	/** Summaries of the commits (the outline timeline). */
	summary: {
		delegated: (address: string, subagentId: string, epoch: number) =>
			`delegated ${address} to subagent ${subagentId} (claim generation ${epoch})`,
		undone: (address: string, subagentId: string) =>
			`${address} back to do: subagent ${subagentId} it was delegated to never ran`,
		report: (subagentId: string, late: boolean) =>
			late
				? `late report of subagent ${subagentId} attached`
				: `report of subagent ${subagentId} attached`,
	},
} as const;

/** What people read under the task: the report's block (in the delegating session's language). */
export const DELEGATION_BLOCK_TEXT: Record<
	DelegationLocale,
	{
		report: (epoch: number, at: string) => string;
		late: (epoch: number, at: string, reason: Exclude<DelegationLateReason, "gone">) => string;
		unfinished: (ending: Exclude<DelegationRunEnding, "completed">) => string;
		empty: string;
		continued: string;
		omitted: (kib: number) => string;
	}
> = {
	en: {
		report: (epoch, at) => `Report (generation ${epoch} · ${at})`,
		late: (epoch, at, reason) =>
			`Late report (generation ${epoch} · ${at}; ${
				reason === "ended"
					? "the task was ended after it was sent"
					: reason === "reopened"
						? "the task went back to do after it was sent"
						: "the task changed hands after it was sent"
			})`,
		unfinished: (ending) =>
			` · unfinished: ${ending === "timed_out" ? "timed out" : ending === "failed" ? "failed" : "interrupted"}`,
		empty: " (no output)",
		continued: "(cont.)",
		omitted: (kib) =>
			`About ${kib} KiB more of the report was not attached; the full text is the subagent session's last reply.`,
	},
	"zh-CN": {
		report: (epoch, at) => `报告（第 ${epoch} 代 · ${at}）`,
		late: (epoch, at, reason) =>
			`迟到的报告（第 ${epoch} 代 · ${at}，${
				reason === "ended"
					? "派出后任务已被结束"
					: reason === "reopened"
						? "派出后任务已退回待办"
						: "派出后任务已转手"
			}）`,
		unfinished: (ending) =>
			` · 未完成：${ending === "timed_out" ? "超时" : ending === "failed" ? "出错" : "被中断"}`,
		empty: "（没有输出）",
		continued: "（续）",
		omitted: (kib) => `其余约 ${kib} KiB 没有挂回，原文是子代理会话的最后一条回复。`,
	},
};

/**
 * Text of the opening brief of a session opened to do a task (outline P2 PR 10c-1,
 * `task-session.ts`): what the new session's model reads as the first row of its history.
 * English, like the delegation's instructions (the task's own words stay as written). Nothing here
 * depends on the time or on a lease: the same task state renders the same bytes.
 */
export const TASK_BRIEF_TEXT = {
	/** After the title and the goals above the task. */
	head: (address: string, epoch: number) => [
		`Address: \`${address}\` · claimed for this session (claim generation ${epoch})`,
		"This is the opening brief of a session opened to do this task. The system put it together from the outline as it was when the session was opened; it is not what a person said, and it is not updated afterwards.",
	],
	background: "## Background (the tasks above this one)",
	ancestor: (title: string) => `- ${title}`,
	siblings: "  - Its tasks, with this one among them:",
	sibling: (title: string, status: string, self: boolean) =>
		`    - ${title} (${status})${self ? " ← this task" : ""}`,
	facts: "## Facts the task links to",
	/** Above a target as read (its own first line is its title). */
	fact: (address: string) => `### \`${address}\``,
	/** A target that did not fit: its title and address only. */
	factLine: (title: string, address: string) => `- ${title} (\`${address}\`): not shown here`,
	/** A target the session may not read: no title, no address. */
	factUnreadable: "- (a block this session cannot read)",
	pages: "## Pages of the project's outline",
	pagesNote:
		"A map, not the content: each page with the first lines of what it holds. Read a page with OutlineRead before relying on it.",
	page: (title: string, address: string, linked: boolean) =>
		`- ${title} (\`${address}\`)${linked ? " · linked from the task" : ""}`,
	pageLine: (text: string) => `  - ${text}`,
	more: (n: number) => `- … ${n} more`,
	/** The last section: how the session works on the task and how it ends (design §B.4). */
	rules: [
		"## How to work on this task",
		"- The task is yours: the system claimed it for this session, and it is in progress. Its state from now on is in your current tasks; read anything again, or anything not shown here, with OutlineRead <address>.",
		"- Do this task and its steps, and nothing beyond them. As you go, record what you find under the task with OutlineEdit: the conclusion first, the evidence under it, the details one level further down.",
		"- When it is done: tick the task `[x]` and leave one result line under it (the conclusion first).",
		"- When a person must decide something: put the question with Ask and leave the task in progress. It stays yours, and this session is woken when the answer comes.",
		"- When you cannot finish it: write a handoff note under the task (what is done, what comes next, which branch and commit hold the code), then end your turn. Do not set the task back to `[ ]` yourself: it goes back to do, and the next session opened for it continues from your note.",
	],
} as const;
