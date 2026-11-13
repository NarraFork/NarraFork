/**
 * The line a subagent report's container block carries, read back for display.
 *
 * The writer (`server/services/outline/delegation-text.ts`, `DELEGATION_BLOCK_TEXT`, composed by
 * `containerText` in `delegation.ts`) stores the line in the delegating session's language, with
 * the claim generation and a UTC minute written into the text:
 *
 *   报告（第 2 代 · 2026-11-09 17:38 UTC）
 *   Late report (generation 2 · 2026-11-09 17:38 UTC; the task changed hands after it was sent)
 *
 * optionally followed by "unfinished" and "no output" suffixes. Readers are shown it in their own
 * language and time zone, without the generation (`frontend/lib/outline-report-line.ts`); the
 * stored text is never rewritten. A line that does not have exactly one of the written forms is
 * not a report line: callers show it as it is, they never guess.
 *
 * The forms are held to the writer by `shared/__tests__/outline-report-line.test.ts`. Change one
 * only together with the other.
 *
 * Pure: no DOM, no server imports.
 */

/** Ids of report containers start with this, then 28 characters of a hash (`reportBlockId`). */
export const OUTLINE_REPORT_ID_PREFIX = "dlrp";
const REPORT_ID_LENGTH = OUTLINE_REPORT_ID_PREFIX.length + 28;

/** Whether a block id is a report container's (the writer's `reportBlockId`). */
export function isOutlineReportBlockId(id: string): boolean {
	return id.length === REPORT_ID_LENGTH && id.startsWith(OUTLINE_REPORT_ID_PREFIX);
}

/**
 * Whether a block is a subagent report's container: by its id (as the writer makes it), or by a
 * line that is exactly a report line (a page read from a copy, a test page).
 */
export function isOutlineReportContainer(id: string, content: string): boolean {
	if (isOutlineReportBlockId(id)) return true;
	// Every stored form has a full-width or an ASCII bracket: skip the parse for ordinary text.
	if (content.length > 400 || !/[（(]/.test(content)) return false;
	return parseOutlineReportLine(content) !== null;
}

/** Why a report is late, as the container line says it (`gone` never gets a container). */
export type OutlineReportLineLateReason = "ended" | "reopened" | "taken_over";

/** How the run ended when it did not complete. */
export type OutlineReportLineEnding = "timed_out" | "failed" | "interrupted";

export interface OutlineReportLine {
	/** When the report was attached: the UTC minute of the text, as an ISO instant. */
	at: string;
	/** The delegation's claim generation (kept for callers that need it; never shown). */
	generation: number;
	/** Set when the report came back after the task had moved on. */
	late: OutlineReportLineLateReason | null;
	/** Set when the subagent's run did not complete. */
	unfinished: OutlineReportLineEnding | null;
	/** The run produced no output. */
	empty: boolean;
}

const STAMP = "(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}) UTC";

interface Form {
	re: RegExp;
	late: Record<string, OutlineReportLineLateReason>;
	unfinished: Record<string, OutlineReportLineEnding>;
}

const FORMS: readonly Form[] = [
	{
		re: new RegExp(
			`^(报告|迟到的报告)（第 (\\d{1,9}) 代 · ${STAMP}(?:，([^（）]+))?）(?: · 未完成：(超时|出错|被中断))?(（没有输出）)?$`,
		),
		late: {
			派出后任务已被结束: "ended",
			派出后任务已退回待办: "reopened",
			派出后任务已转手: "taken_over",
		},
		unfinished: { 超时: "timed_out", 出错: "failed", 被中断: "interrupted" },
	},
	{
		re: new RegExp(
			`^(Report|Late report) \\(generation (\\d{1,9}) · ${STAMP}(?:; ([^()]+))?\\)(?: · unfinished: (timed out|failed|interrupted))?( \\(no output\\))?$`,
		),
		late: {
			"the task was ended after it was sent": "ended",
			"the task went back to do after it was sent": "reopened",
			"the task changed hands after it was sent": "taken_over",
		},
		unfinished: { "timed out": "timed_out", failed: "failed", interrupted: "interrupted" },
	},
];

/** Longest text looked at: the written line is far shorter, and a block may hold 16 KiB. */
const MAX_LINE = 240;

/**
 * A report container's line, or `null` when `text` is not exactly one (then it is shown raw).
 * Surrounding whitespace is ignored; anything else around the line makes it ordinary text.
 */
export function parseOutlineReportLine(text: string): OutlineReportLine | null {
	if (text.length > MAX_LINE + 64) return null;
	const line = text.trim();
	if (!line || line.length > MAX_LINE || line.includes("\n")) return null;
	for (const form of FORMS) {
		const m = form.re.exec(line);
		if (!m) continue;
		const [, head, generation, y, mo, d, h, mi, reason, ending, empty] = m;
		const isLate = head === "迟到的报告" || head === "Late report";
		// A late line always says why, a plain one never does.
		const late = reason === undefined ? null : (form.late[reason] ?? undefined);
		if (late === undefined || isLate !== (late !== null)) return null;
		const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
		const date = new Date(ms);
		// A date that does not exist (month 13, the 31st of a short month, hour 25) is not one.
		if (
			Number.isNaN(ms) ||
			date.getUTCMonth() !== Number(mo) - 1 ||
			date.getUTCDate() !== Number(d) ||
			date.getUTCHours() !== Number(h) ||
			date.getUTCMinutes() !== Number(mi)
		) {
			return null;
		}
		return {
			at: date.toISOString(),
			generation: Number(generation),
			late,
			unfinished: ending === undefined ? null : (form.unfinished[ending] ?? null),
			empty: empty !== undefined,
		};
	}
	return null;
}
