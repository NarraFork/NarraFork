/**
 * The note a delegated subagent's result ends with (outline P2 PR 9a, `delegation.ts`), read back
 * for the Agent tool card (PR 9b): which task the agent was sent with, and whether its result is
 * late.
 *
 * The writer (`server/services/outline/delegation.ts`, `DELEGATION_TEXT.note`) appends three
 * lines at the very end of the result: the head line below, one line of text, the closing tag.
 * A report may quote a note of the same form in its own text; that is the report's text, left as
 * it is. So a reader takes the LAST head line within the end of the text, and nothing before it:
 * a last head line that does not have the exact form reads as no note at all.
 *
 * The head line's form is defined here, once ({@link OUTLINE_REPORT_NOTE_HEAD_RE}): the writer
 * strips a repeated note with it, the card parses it. Change it only together with both.
 *
 * Pure: no DOM, no server imports.
 */
import { parseAddress } from "./outline/address";

/** Why a delegated result is late (the writer's `DelegationLateReason`). */
export type OutlineReportLateReason =
	| "taken_over"
	| "redelegated"
	| "reclaimed"
	| "ended"
	| "reopened"
	| "gone";

export const OUTLINE_REPORT_LATE_REASONS: readonly OutlineReportLateReason[] = [
	"taken_over",
	"redelegated",
	"reclaimed",
	"ended",
	"reopened",
	"gone",
];

/** What the head line of a note says. */
export interface OutlineReportNote {
	/** The task's address (`key/sid`). */
	task: string;
	/** The report's container block (`key/sid`), when it was attached. */
	report: string | null;
	/** The delegation's claim generation. */
	generation: number;
	status: "current" | "late" | "not_attached";
	/** Why it is late (`status` late, or not attached because the task is gone). */
	reason: OutlineReportLateReason | null;
}

/** The head line of a note, exactly as the writer writes it. */
export const OUTLINE_REPORT_NOTE_HEAD_RE =
	/^<outline_report task="([^"<>&\n]*)"(?: report="([^"<>&\n]*)")? generation="(\d+)" status="(current|late|not_attached)"(?: reason="([a-z_]+)")?>$/;

/** The note is at most about a KiB: only this much of a text's end is looked at. */
export const OUTLINE_REPORT_NOTE_WINDOW = 4096;

const HEAD_START = "<outline_report ";

/**
 * The note at the end of a delegated result, or null when the text has none: the last head line
 * within the last {@link OUTLINE_REPORT_NOTE_WINDOW} characters, which must have the exact form.
 * One pass over the window, whatever the text's length.
 */
export function readOutlineReportNote(text: string | null | undefined): OutlineReportNote | null {
	if (!text) return null;
	const offset = Math.max(0, text.length - OUTLINE_REPORT_NOTE_WINDOW);
	const window = text.slice(offset);
	const found = window.lastIndexOf(`\n${HEAD_START}`);
	let start: number;
	if (found >= 0) start = found + 1;
	// The window opens with a head that starts a line of the text (the text is a note, say).
	else if (window.startsWith(HEAD_START) && (offset === 0 || text.charAt(offset - 1) === "\n"))
		start = 0;
	else return null;
	const end = window.indexOf("\n", start);
	const head = window.slice(start, end === -1 ? undefined : end).replace(/\r$/, "");
	const match = OUTLINE_REPORT_NOTE_HEAD_RE.exec(head);
	if (!match) return null;
	const reason = match[5] as OutlineReportLateReason | undefined;
	return {
		task: match[1] as string,
		report: match[2] ?? null,
		generation: Number(match[3]),
		status: match[4] as OutlineReportNote["status"],
		reason: reason && OUTLINE_REPORT_LATE_REASONS.includes(reason) ? reason : null,
	};
}

/**
 * The task a background delegation names right after its `<background_task_id>` (the writer's
 * `DELEGATION_TEXT.started`): `Delegated [[key/sid|Title]] to this agent (claim generation E)`.
 * Null when the text has no such line.
 */
export function readDelegationStarted(
	text: string | null | undefined,
): { address: string; title: string | null } | null {
	if (!text) return null;
	const match =
		/^Delegated \[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\] to this agent \(claim generation \d+\)/m.exec(
			text.slice(0, OUTLINE_REPORT_NOTE_WINDOW),
		);
	if (!match) return null;
	return { address: (match[1] as string).trim(), title: match[2]?.trim() || null };
}

/**
 * The title a note gives a block it links to (`[[key/sid|Title]]`), when it links to it; the
 * writer links the task in a current note and in a failure, not in a late one.
 */
export function noteLinkTitle(text: string | null | undefined, address: string): string | null {
	if (!text || !address) return null;
	const tail = text.slice(Math.max(0, text.length - OUTLINE_REPORT_NOTE_WINDOW));
	const needle = `[[${address}|`;
	const at = tail.lastIndexOf(needle);
	if (at === -1) return null;
	const close = tail.indexOf("]]", at + needle.length);
	if (close === -1) return null;
	const title = tail.slice(at + needle.length, close).trim();
	return title && !title.includes("\n") ? title : null;
}

/** What an Agent tool card shows of the outline task the agent was sent with (P2 PR 9b). */
export interface SubagentDelegation {
	/** The task's title as the card names it, or what the call named it by. */
	title: string;
	/** Its `key/sid` when known: the card links it (`/outline/ref`, permission checked). */
	address: string | null;
	/** Why the result is late; null when it is not, or not back yet. */
	late: OutlineReportLateReason | "late" | null;
}

/** Characters of the task's title on the card (one truncating line). */
const DELEGATION_TITLE_CHARS = 120;

function clipTitle(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > DELEGATION_TITLE_CHARS
		? `${line.slice(0, DELEGATION_TITLE_CHARS - 1)}…`
		: line;
}

/**
 * The task an Agent call was sent with (`task`, its input) and what its result says of it: the
 * address and title from the note at the result's end, or from the line a background launch
 * names it in, else what the call wrote; late when the note says so (a task deleted since counts:
 * its report was not attached). Null when the call has no `task`.
 */
export function readSubagentDelegation(
	taskInput: unknown,
	resultText: string | null | undefined,
): SubagentDelegation | null {
	if (typeof taskInput !== "string" || !taskInput.trim()) return null;
	const named = taskInput.trim();
	const note = readOutlineReportNote(resultText);
	const started = readDelegationStarted(resultText);
	const address = note?.task || started?.address || (parseAddress(named) ? named : null) || null;
	const title = started?.title ?? (address ? noteLinkTitle(resultText, address) : null) ?? named;
	const late =
		note?.status === "late" || (note?.status === "not_attached" && note.reason === "gone")
			? (note.reason ?? "late")
			: null;
	return { title: clipTitle(title), address, late };
}
