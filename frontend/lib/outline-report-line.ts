/**
 * How a subagent report's container line reads to a person: 「子代理报告 · 昨天 17:38」 in the
 * interface's language and the viewer's time zone, decoded from the stored text
 * (`shared/outline-report-line.ts`). Never the claim generation, never "UTC".
 *
 * The time is a short absolute one (not "3h ago"): the live editor and the mind map show the line
 * as a decoration and a measured node, and neither re-renders as time passes.
 */
import {
	type OutlineReportLine,
	type OutlineReportLineEnding,
	type OutlineReportLineLateReason,
	parseOutlineReportLine,
} from "@shared/outline-report-line";
import { formatLocaleDateTime, formatLocaleRelativeTime, formatLocaleTime } from "./intl-format";

const DAY_MS = 86_400_000;

function startOfDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * A report's time in the viewer's zone: today 「17:38」, yesterday 「昨天 17:38」, this year
 * 「11月9日 17:38」, earlier with the year. 24-hour, whatever the locale's habit: the line is short.
 */
export function formatReportLineTime(
	iso: string,
	locale?: string | null,
	now: Date = new Date(),
): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const clock: Intl.DateTimeFormatOptions = {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	};
	const time = formatLocaleTime(date, clock, locale);
	const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
	if (days === 0) return time;
	if (days === 1) {
		const yesterday = formatLocaleRelativeTime(-1, "day", { numeric: "auto" }, locale);
		return `${yesterday} ${time}`;
	}
	return formatLocaleDateTime(
		date,
		{
			...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
			month: "short",
			day: "numeric",
			...clock,
		},
		locale,
	);
}

export interface ReportLineLabelOptions {
	/** The `outline` namespace's `t`. */
	t: (key: string, options?: Record<string, unknown>) => string;
	/** The interface's language; the document's when not given (`resolveIntlLocale`). */
	locale?: string | null;
	now?: Date;
	/** The subagent that wrote the report, when the caller knows it. */
	from?: string | null;
}

const LATE_KEYS: Record<OutlineReportLineLateReason, string> = {
	ended: "reportLine.lateEnded",
	reopened: "reportLine.lateReopened",
	taken_over: "reportLine.lateTakenOver",
};

const UNFINISHED_KEYS: Record<OutlineReportLineEnding, string> = {
	timed_out: "reportLine.timedOut",
	failed: "reportLine.failed",
	interrupted: "reportLine.interrupted",
};

/** The line a person reads for a decoded report container. */
export function reportLineLabel(line: OutlineReportLine, options: ReportLineLabelOptions): string {
	const { t, locale, now, from } = options;
	const parts = [
		line.late ? t(LATE_KEYS[line.late]) : t("reportLine.title"),
		formatReportLineTime(line.at, locale, now),
	];
	if (from) parts.push(t("reportLine.from", { name: from }));
	if (line.unfinished) parts.push(t(UNFINISHED_KEYS[line.unfinished]));
	if (line.empty) parts.push(t("reportLine.empty"));
	return parts.filter(Boolean).join(" · ");
}

/**
 * What a block's text reads as when it is a report container's line, else `null` (show the text
 * as it is). The one entry the tree, the editor and the mind map go through.
 */
export function reportLineDisplay(content: string, options: ReportLineLabelOptions): string | null {
	// Every stored form has a full-width or an ASCII bracket: skip the parse for ordinary text.
	if (content.length > 400 || !/[（(]/.test(content)) return null;
	const line = parseOutlineReportLine(content);
	return line ? reportLineLabel(line, options) : null;
}
