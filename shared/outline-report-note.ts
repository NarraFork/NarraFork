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

const CLOSE = "</outline_report>";
const FILE_CHANGES_OPEN = "\n<subagent_file_changes>";
const FILE_CHANGES_CLOSE = "</subagent_file_changes>";

/**
 * The text up to where the run service's file-change block starts, when it ends the text: the run
 * service appends that block after the note (`appendSubagentFileChanges`), and a long one would
 * push the note out of the window.
 */
function withoutFileChanges(text: string): string {
	const end = text.trimEnd();
	if (!end.endsWith(FILE_CHANGES_CLOSE)) return text;
	const at = end.lastIndexOf(FILE_CHANGES_OPEN);
	return at === -1 ? text : end.slice(0, at);
}

/**
 * What the subagent runner appends after a foreground result (`subagent-runner.ts`), the last one
 * first: the note that the alias asked for was taken (`aliasConflictNote`), and the note that the
 * parent's model is not in the subagent pool (`formatSubagentModelFallbackNote`). Each is one
 * line; `outline-report-note-trailers.test.ts` holds these to the writers.
 */
const RUNNER_TRAILERS = [
	/\n\nNote: The requested alias "[^\n]*" was already taken\. This agent was assigned "[^\n]*" instead\.(?: Use this alias with Await or Send to reference this agent\.)?$/,
	/\n\nNote: the parent model "[^\n]*" is not in the allowed "[^\n]*" subagent model pool, so this subagent ran on "[^\n]*" instead\.$/,
];
/** The runner's notes are short: only this much of the end is looked at for them. */
const RUNNER_TRAILER_WINDOW = 2048;

/** The text without what the runner and the run service append after the note. */
function withoutTrailers(text: string): string {
	let body = text.trimEnd();
	for (const trailer of RUNNER_TRAILERS) {
		const from = Math.max(0, body.length - RUNNER_TRAILER_WINDOW);
		const match = trailer.exec(body.slice(from));
		if (match) body = body.slice(0, from + match.index).trimEnd();
	}
	return withoutFileChanges(body);
}

/**
 * The note at the end of a delegated result, or null when the text has none. The note is the
 * writer's three lines (its head line in the exact form, one line of text, the closing tag), the
 * last thing in the text but for the run service's file-change block and the runner's notes after
 * it; only the last {@link OUTLINE_REPORT_NOTE_WINDOW} characters before those are looked at. A
 * head line a report quotes anywhere else is the report's text.
 */
export function readOutlineReportNote(text: string | null | undefined): OutlineReportNote | null {
	if (!text) return null;
	const body = withoutTrailers(text).trimEnd();
	if (!body.endsWith(CLOSE)) return null;
	const lines = body.slice(Math.max(0, body.length - OUTLINE_REPORT_NOTE_WINDOW)).split("\n");
	if (lines.length < 3) return null;
	const head = (lines[lines.length - 3] as string).replace(/\r$/, "");
	const line = lines[lines.length - 2] as string;
	if ((lines[lines.length - 1] as string).replace(/\r$/, "") !== CLOSE) return null;
	if (line.includes("<outline_report") || line.includes(CLOSE)) return null;
	// The head starts a line of the text (not one the window cut into).
	const start = body.length - CLOSE.length - line.length - head.length - 2;
	if (start > 0 && body.charAt(start - 1) !== "\n") return null;
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
 * Only in a background launch's text (it starts with the tag); null otherwise, so a report quoting
 * such a line names nothing.
 */
export function readDelegationStarted(
	text: string | null | undefined,
): { address: string; title: string | null } | null {
	if (!text || !/^\s*<background_task_id>[^<\r\n]+<\/background_task_id>/.test(text)) return null;
	const match =
		/^Delegated \[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\] to this agent \(claim generation \d+\)/m.exec(
			text.slice(0, OUTLINE_REPORT_NOTE_WINDOW),
		);
	if (!match) return null;
	return { address: (match[1] as string).trim(), title: match[2]?.trim() || null };
}

/**
 * The title a note gives a block it links to (`[[key/sid|Title]]`), when it links to it; the
 * writer links the task in a current note and in a failure, not in a late one. Read in the note's
 * own lines only.
 */
export function noteLinkTitle(text: string | null | undefined, address: string): string | null {
	if (!text || !address || !readOutlineReportNote(text)) return null;
	const body = withoutTrailers(text).trimEnd();
	const tail = body.slice(body.lastIndexOf("\n", body.length - CLOSE.length - 2) + 1);
	const needle = `[[${address}|`;
	const at = tail.lastIndexOf(needle);
	if (at === -1) return null;
	const close = tail.indexOf("]]", at + needle.length);
	if (close === -1) return null;
	const title = tail.slice(at + needle.length, close).trim();
	return title && !title.includes("\n") ? title : null;
}

// ── What the Agent call carries (outline P2 PR 9b) ──────────────────────────

/**
 * The key of the Agent call's result metadata (`_metadata`) that names the task it was sent with:
 * written by the Agent tool at launch (task, title, generation) and with a delivered result (also
 * the note's status and reason). Small, so it survives every projection that cuts the result's
 * text (the live 2K one, the page's 8K one), and the card reads it before the text.
 */
export const OUTLINE_DELEGATION_METADATA_KEY = "outlineDelegation";

export interface OutlineDelegationMetadata {
	/** `key/sid`. */
	task: string;
	title: string;
	generation: number;
	/** The note's status, once a result was delivered with one. */
	status?: OutlineReportNote["status"];
	reason?: OutlineReportLateReason;
}

/** The metadata of an Agent call sent with a task, with its result's note when there is one. */
export function outlineDelegationMetadata(
	task: { address: string; title: string; epoch: number },
	note: OutlineReportNote | null,
): OutlineDelegationMetadata {
	return {
		task: task.address,
		title: task.title,
		generation: task.epoch,
		...(note ? { status: note.status } : {}),
		...(note?.reason ? { reason: note.reason } : {}),
	};
}

/** The metadata read back (from a result's `_metadata`), bounded; null when it is not one. */
export function readOutlineDelegationMetadata(metadata: unknown): OutlineDelegationMetadata | null {
	if (!metadata || typeof metadata !== "object") return null;
	const value = (metadata as Record<string, unknown>)[OUTLINE_DELEGATION_METADATA_KEY];
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	if (typeof record.task !== "string" || !record.task) return null;
	const status =
		record.status === "current" || record.status === "late" || record.status === "not_attached"
			? record.status
			: undefined;
	const reason = OUTLINE_REPORT_LATE_REASONS.includes(record.reason as OutlineReportLateReason)
		? (record.reason as OutlineReportLateReason)
		: undefined;
	return {
		task: record.task.slice(0, 200),
		title: typeof record.title === "string" ? record.title.slice(0, 400) : "",
		generation:
			typeof record.generation === "number" && Number.isFinite(record.generation)
				? record.generation
				: 0,
		...(status ? { status } : {}),
		...(reason ? { reason } : {}),
	};
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

function lateOf(
	status: OutlineReportNote["status"] | undefined,
	reason: OutlineReportLateReason | null | undefined,
): SubagentDelegation["late"] {
	// A task deleted since is late too: its report was not attached.
	if (status === "late" || (status === "not_attached" && reason === "gone"))
		return reason ?? "late";
	return null;
}

/**
 * The task an Agent call was sent with (`task`, its input) and what its result says of it. From
 * the call's metadata when it has some (written by the server, whatever the projections cut from
 * the text); otherwise (calls from before it) from the note at the result's end, or from the line
 * a background launch names the task in, else what the call wrote. Null when the call has no
 * `task`.
 */
export function readSubagentDelegation(
	taskInput: unknown,
	resultText: string | null | undefined,
	metadata?: unknown,
): SubagentDelegation | null {
	if (typeof taskInput !== "string" || !taskInput.trim()) return null;
	const named = taskInput.trim();
	const meta = readOutlineDelegationMetadata(metadata);
	if (meta)
		return {
			title: clipTitle(meta.title || named),
			address: parseAddress(meta.task) ? meta.task : null,
			late: lateOf(meta.status, meta.reason),
		};
	const note = readOutlineReportNote(resultText);
	const started = readDelegationStarted(resultText);
	const address = note?.task || started?.address || (parseAddress(named) ? named : null) || null;
	const title = started?.title ?? (address ? noteLinkTitle(resultText, address) : null) ?? named;
	return { title: clipTitle(title), address, late: lateOf(note?.status, note?.reason) };
}
