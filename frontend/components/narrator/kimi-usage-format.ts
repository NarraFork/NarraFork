import type { KimiUsageCache, KimiUsageWindow } from "../../lib/api/types";

/** Minimal translation signature compatible with react-i18next's `t`. */
export type KimiTFunction = (key: string, options?: Record<string, unknown>) => string;

/** True when the baseUrl points at a kimi.com / kimi.ai host (mirrors the server check). */
export function isKimiProviderBaseUrl(baseUrl?: string): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return (
			host === "kimi.com" ||
			host === "kimi.ai" ||
			host.endsWith(".kimi.com") ||
			host.endsWith(".kimi.ai")
		);
	} catch {
		return false;
	}
}

function formatResetTime(resetTime: string | null): string | null {
	if (!resetTime) return null;
	const date = new Date(resetTime);
	if (Number.isNaN(date.getTime())) return null;
	return date.toLocaleString();
}

function formatWindowLine(label: string, window: KimiUsageWindow, t: KimiTFunction): string {
	const reset = formatResetTime(window.resetTime);
	return (
		t("kimi.windowLine", {
			label,
			used: window.used ?? "?",
			limit: window.limit ?? "?",
		}) + (reset ? t("kimi.resetSuffix", { time: reset }) : "")
	);
}

/**
 * Status-bar text for a Kimi provider: remaining percentage of the 5-hour
 * window (same "remaining" convention as the Codex quota indicator). Falls
 * back to used/limit when the percentage cannot be computed; returns null
 * when there is nothing meaningful to show.
 */
export function formatKimiBarText(usage: KimiUsageCache, t: KimiTFunction): string | null {
	const fiveHour = usage.fiveHour;
	if (fiveHour?.limit != null && fiveHour.limit > 0) {
		const remaining =
			fiveHour.remaining ?? (fiveHour.used != null ? fiveHour.limit - fiveHour.used : null);
		if (remaining != null) {
			const percent = Math.max(0, Math.min(100, Math.round((remaining / fiveHour.limit) * 100)));
			return t("kimi.fiveHourShort", { percent });
		}
		return t("kimi.fiveHourRatio", {
			used: fiveHour.used ?? "?",
			limit: fiveHour.limit,
		});
	}
	if (usage.error) return t("kimi.unavailable");
	return null;
}

/** Details-popover text: 5-hour + weekly + monthly windows, one per line. */
export function formatKimiDetailsText(usage: KimiUsageCache, t: KimiTFunction): string {
	const lines: string[] = [];
	if (usage.fiveHour) lines.push(formatWindowLine(t("kimi.window5h"), usage.fiveHour, t));
	if (usage.weekly) lines.push(formatWindowLine(t("kimi.windowWeekly"), usage.weekly, t));
	if (usage.monthly) lines.push(formatWindowLine(t("kimi.windowMonthly"), usage.monthly, t));
	for (const extra of usage.extraWindows) {
		lines.push(formatWindowLine(extra.label, extra, t));
	}
	if (usage.error) lines.push(t("kimi.fetchError", { error: usage.error }));
	return lines.join("\n");
}
