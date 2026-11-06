/**
 * How the reports' days and windows read, in the interface's language (汇报, P2 PR 11). A day is
 * the report's `periodKey` (a calendar date in the person's report time zone), shown as that date,
 * whatever the browser's zone; a window is shown in the report's zone and names it.
 */
import type { OutlineDigestHead } from "@shared/outline-digest";
import { useTranslation } from "react-i18next";
import { formatLocaleDate, formatLocaleDateTime } from "../../../lib/intl-format";
import { DIGEST_TODAY } from "./digest-model";

/** `2026-11-05` → "Thu, Nov 5" / "11月5日周四"; "today" → "Today so far". */
export function useDigestDayLabel(): (key: string) => string {
	const { t, i18n } = useTranslation("outline");
	return (key) =>
		key === DIGEST_TODAY
			? t("report.today")
			: formatLocaleDate(key, { weekday: "short", month: "short", day: "numeric" }, i18n.language);
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
