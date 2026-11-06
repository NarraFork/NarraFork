/**
 * How the reports' days and windows read, in the interface's language (汇报, P2 PR 11). A day is
 * the report's `periodKey` (a calendar date in the person's report time zone), shown as that date,
 * whatever the browser's zone; a window is shown in the report's zone and names it.
 */
import type { OutlineDigestHead } from "@shared/outline-digest";
import { useTranslation } from "react-i18next";
import { formatLocaleDate, formatLocaleDateTime } from "../../../lib/intl-format";
import { DIGEST_TODAY, type DigestDayEntry, isTodayIn } from "./digest-model";

/** A date, `2026-11-05` → "Thu, Nov 5" / "11月5日周四". */
export function useDigestDayLabel(): (key: string) => string {
	const { i18n } = useTranslation("outline");
	return (key) =>
		formatLocaleDate(key, { weekday: "short", month: "short", day: "numeric" }, i18n.language);
}

/**
 * A day to browse to: its date, or for the "so far" report "Today so far" while it is today in
 * its zone, and "Thu, Nov 5 so far" once that day is over (before the day's report replaces it).
 */
export function useDigestEntryLabel(): (entry: DigestDayEntry) => string {
	const { t } = useTranslation("outline");
	const dayLabel = useDigestDayLabel();
	return (entry) => {
		if (entry.key !== DIGEST_TODAY) return dayLabel(entry.key);
		return isTodayIn(entry.head.periodKey, entry.head.timeZone)
			? t("report.today")
			: t("report.soFar", { day: dayLabel(entry.head.periodKey) });
	};
}

/** The window a report covers, in its own zone. */
export function useDigestPeriod(): (
	head: Pick<OutlineDigestHead, "periodStart" | "periodEnd" | "timeZone">,
) => string {
	const { t, i18n } = useTranslation("outline");
	return (head) => {
		const options: Intl.DateTimeFormatOptions = {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			timeZone: head.timeZone,
		};
		return t("report.period", {
			from: formatLocaleDateTime(head.periodStart, options, i18n.language),
			to: formatLocaleDateTime(head.periodEnd, options, i18n.language),
			zone: head.timeZone,
		});
	};
}
