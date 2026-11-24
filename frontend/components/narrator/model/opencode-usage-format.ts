import { identifyService } from "@shared/sourcing/identify";
import type { OpencodeUsageCache, OpencodeUsageWindow } from "../../../lib/api/types";
import { formatLocaleDateTime } from "../../../lib/intl-format";

/** Minimal translation signature compatible with react-i18next's `t`. */
export type OpencodeTFunction = (key: string, options?: Record<string, unknown>) => string;

/**
 * Whether the last refresh for this provider failed.
 *
 * The server withholds the error TEXT from non-admins (it describes the deployment's
 * provider account) and sends `hasError` instead, so a caller must not test `error`
 * alone: for a non-admin that would read a failed fetch as a success. This is the
 * guard the "unavailable" fallback uses — the cached percentages themselves stay
 * visible either way (same as the Kimi indicator), which is why the details popover
 * also prints the failure reason.
 */
export function opencodeUsageFailed(usage: OpencodeUsageCache): boolean {
	return usage.error != null || usage.hasError === true;
}

/**
 * True when the baseUrl points at an OpenCode Go plan endpoint (same check as the server).
 *
 * The preset's `/zen/go/v1`, the inference-routed `/inference/go/v1` and the inference
 * service's per-family roots all qualify. The host check is not enough on its own:
 * `https://opencode.ai/zen/v1` is the pay-as-you-go Zen endpoint, which has no plan
 * allowance to show. A relay serving OpenCode models from another host does not qualify
 * either, because its `/usage` path means nothing and probing it would spend the user's
 * key on a third party.
 */
export function isOpencodeProviderBaseUrl(baseUrl?: string): boolean {
	return identifyService({ baseUrl }).templateId === "opencode-go";
}

function formatResetTime(resetsAt: string | null): string | null {
	if (!resetsAt) return null;
	// `formatLocaleDateTime` rather than the Date method with no locale argument: the bare
	// method follows the SYSTEM locale, so a user running the app in Chinese on an English
	// OS saw this one timestamp in English among translated text. It returns "" for an
	// unparseable value, normalized back to null so callers keep their "no reset" branch.
	const formatted = formatLocaleDateTime(resetsAt);
	return formatted || null;
}

function formatWindowLine(
	label: string,
	window: OpencodeUsageWindow,
	t: OpencodeTFunction,
): string {
	const reset = formatResetTime(window.resetsAt);
	return (
		t("opencode.windowLine", { label, percent: window.percent ?? "?" }) +
		(reset ? t("opencode.resetSuffix", { time: reset }) : "")
	);
}

/**
 * Status-bar text: what is LEFT of the 5-hour rolling window, expressed the same way as the
 * Kimi and Codex indicators (a `percent` of remaining allowance). The upstream figure is the
 * share already spent, so the remainder is `100 - percent` — showing the API number under
 * this convention would have told the user the exact opposite of the truth.
 *
 * Returns null when there is nothing meaningful to show, so the panel can fall back to the
 * generic relay quota string instead of rendering an empty indicator.
 */
export function formatOpencodeBarText(
	usage: OpencodeUsageCache,
	t: OpencodeTFunction,
): string | null {
	const rolling = usage.rolling;
	if (rolling?.percent != null) {
		const remaining = Math.max(0, Math.min(100, Math.round(100 - rolling.percent)));
		return t("opencode.rollingShort", { percent: remaining });
	}
	if (opencodeUsageFailed(usage)) return t("opencode.unavailable");
	return null;
}

/** Details-popover text: the 5-hour, weekly and monthly windows, one per line. */
export function formatOpencodeDetailsText(usage: OpencodeUsageCache, t: OpencodeTFunction): string {
	const lines: string[] = [];
	if (usage.rolling) lines.push(formatWindowLine(t("opencode.window5h"), usage.rolling, t));
	if (usage.weekly) lines.push(formatWindowLine(t("opencode.windowWeekly"), usage.weekly, t));
	if (usage.monthly) lines.push(formatWindowLine(t("opencode.windowMonthly"), usage.monthly, t));
	// A non-admin gets `hasError` without the text, so the reason line falls back to a bare
	// "fetch failed". Saying nothing at all would leave stale percentages looking current.
	if (usage.error) lines.push(t("opencode.fetchError", { error: usage.error }));
	else if (usage.hasError) lines.push(t("opencode.fetchFailed"));
	return lines.join("\n");
}
