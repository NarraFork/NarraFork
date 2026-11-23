import { identifyService } from "@shared/sourcing/identify";
import type { KimiUsageCache, KimiUsageWindow } from "../../../lib/api/types";
import {
	parseQuotaReset,
	pickLimitingWindow,
	type QuotaPanelView,
	quotaWindowFromAmounts,
	worstQuotaLevel,
} from "./quota-panel-view";

/** Minimal translation signature compatible with react-i18next's `t`. */
export type KimiTFunction = (key: string, options?: Record<string, unknown>) => string;

/**
 * Whether the last refresh for this provider failed.
 *
 * The server withholds the error TEXT from non-admins (it is verbatim upstream output
 * about the deployment's provider account) and sends `hasError` instead. Testing `error`
 * alone would therefore read a non-admin's failed fetch as a success, and the status bar
 * would present whatever numbers were last cached as if they were current.
 */
export function kimiUsageFailed(usage: KimiUsageCache): boolean {
	return usage.error != null || usage.hasError === true;
}

/** True when the baseUrl points at a kimi.com / kimi.ai host (mirrors the server check). */
export function isKimiProviderBaseUrl(baseUrl?: string): boolean {
	return identifyService({ baseUrl }).templateId === "kimi-code";
}

/**
 * Kimi windows mapped onto the shared quota panel (same progress-bar view as
 * OpenCode Go), or null when there is nothing to show yet.
 */
export function buildKimiQuotaView(
	usage: KimiUsageCache | null | undefined,
	t: KimiTFunction,
): QuotaPanelView | null {
	if (!usage) return null;
	const entries: Array<[string, string, string, KimiUsageWindow | null]> = [
		["fiveHour", t("kimi.window5h"), t("quotaPanel.short5h"), usage.fiveHour],
		["weekly", t("kimi.windowWeekly"), t("quotaPanel.shortWeekly"), usage.weekly],
		["monthly", t("kimi.windowMonthly"), t("quotaPanel.shortMonthly"), usage.monthly],
		...usage.extraWindows.map((extra, index): [string, string, string, KimiUsageWindow] => [
			`extra-${index}`,
			extra.label,
			extra.label,
			extra,
		]),
	];
	const windows = entries.flatMap(([id, label, shortLabel, window]) =>
		window
			? [
					quotaWindowFromAmounts({
						id,
						label,
						shortLabel,
						used: window.used,
						limit: window.limit,
						remaining: window.remaining,
						resetAt: parseQuotaReset(window.resetTime),
					}),
				]
			: [],
	);
	const failed = kimiUsageFailed(usage);
	if (windows.length === 0 && !failed) return null;
	return {
		title: t("kimi.title"),
		unavailableText: t("kimi.unavailable"),
		windows,
		limiting: pickLimitingWindow(windows),
		level: worstQuotaLevel(windows.map((window) => window.level)),
		rows: [],
		failed,
		failureDetail: usage.error ?? null,
		fetchedAt: usage.fetchedAt,
	};
}
