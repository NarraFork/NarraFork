/**
 * Provider-neutral display model for a usage allowance split into windows
 * (5-hour / weekly / monthly …), rendered by `QuotaPanelIndicator`.
 *
 * Each provider adapter (OpenCode Go, Kimi, Command Code) maps its own payload
 * into this shape, so every windowed allowance gets the same badge, progress
 * bars, colour thresholds and reset countdowns. Pure: a function of the payload
 * and the clock, so tests can pin it without rendering.
 */

import { formatLocaleNumber } from "../../../lib/intl-format";

/** Ordered by severity; `unknown` is "no number to judge by". */
export type QuotaLevel = "ok" | "warning" | "critical" | "exhausted" | "unknown";

const LEVEL_RANK: Record<QuotaLevel, number> = {
	unknown: 0,
	ok: 1,
	warning: 2,
	critical: 3,
	exhausted: 4,
};

/** Remaining share at or below which a window is flagged. */
export const QUOTA_WARNING_REMAINING_PERCENT = 25;
export const QUOTA_CRITICAL_REMAINING_PERCENT = 10;

/** Mantine colour per level, shared by badge and progress bar. */
export const QUOTA_LEVEL_COLORS: Record<QuotaLevel, string> = {
	ok: "teal",
	warning: "yellow",
	critical: "red",
	exhausted: "red",
	unknown: "gray",
};

export interface QuotaWindowView {
	/** Stable React key. */
	id: string;
	/** Panel row label, e.g. "5-hour limit". */
	label: string;
	/** Badge label, e.g. "5h". */
	shortLabel: string;
	usedPercent: number | null;
	remainingPercent: number | null;
	/** Absolute amounts, only when upstream reported both. */
	used: number | null;
	limit: number | null;
	/** Optional period-specific amount and currency; never an unlabeled wallet balance. */
	remainingAmount?: number | null;
	unit?: string;
	/** Epoch ms the window refills, or null when unknown. */
	resetAt: number | null;
	/** Translation key for the reset caption (takes `time`); defaults to `quotaPanel.resetsIn`. */
	resetCaptionKey?: string;
	/** Tooltip on the reset caption; defaults to the absolute reset time. */
	resetHint?: string;
	level: QuotaLevel;
}

export interface QuotaPanelView {
	/** Popover heading, e.g. "Kimi usage". */
	title: string;
	/** Badge text when no window has a number (e.g. "Kimi usage unavailable"). */
	unavailableText: string;
	/** Authoritative status text (e.g. expired), taking precedence over old numeric windows. */
	badgeText?: string;
	/** Windows upstream reported, in display order. */
	windows: QuotaWindowView[];
	/** The window with the least allowance left, which bounds the next request. */
	limiting: QuotaWindowView | null;
	/** Worst level across windows. */
	level: QuotaLevel;
	/** Extra label/value rows under the windows (balance, monthly credits …). */
	rows: Array<{ id?: string; label: string; value: string }>;
	/** A known validity deadline passed; this is not a missing or zero-valued allowance. */
	expired?: boolean;
	/** The last refresh failed; any numbers shown are from an earlier fetch. */
	failed: boolean;
	/** Why it failed, when the viewer may see it (admins only). */
	failureDetail: string | null;
	/** Epoch ms of the last successful fetch, 0 when unknown. */
	fetchedAt: number;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Level for a window from its remaining share; `exhausted` forces the top level. */
export function quotaLevelForRemaining(
	remainingPercent: number | null,
	exhausted = false,
): QuotaLevel {
	if (exhausted) return "exhausted";
	if (remainingPercent == null) return "unknown";
	if (remainingPercent <= 0) return "exhausted";
	if (remainingPercent <= QUOTA_CRITICAL_REMAINING_PERCENT) return "critical";
	if (remainingPercent <= QUOTA_WARNING_REMAINING_PERCENT) return "warning";
	return "ok";
}

export function worstQuotaLevel(levels: QuotaLevel[]): QuotaLevel {
	return levels.reduce<QuotaLevel>(
		(worst, level) => (LEVEL_RANK[level] > LEVEL_RANK[worst] ? level : worst),
		"unknown",
	);
}

/**
 * The window that bounds the account: an exhausted one wins (the one that
 * refills last, since that is when requests resume), otherwise the one with
 * the least left.
 */
export function pickLimitingWindow<
	W extends { level: QuotaLevel; remainingPercent: number | null; resetAt: number | null },
>(windows: W[]): W | null {
	let limiting: W | null = null;
	for (const window of windows) {
		if (window.level === "exhausted") {
			if (
				limiting?.level !== "exhausted" ||
				(window.resetAt ?? Number.POSITIVE_INFINITY) >
					(limiting.resetAt ?? Number.POSITIVE_INFINITY)
			) {
				limiting = window;
			}
			continue;
		}
		if (limiting?.level === "exhausted" || window.remainingPercent == null) continue;
		if (limiting?.remainingPercent == null || window.remainingPercent < limiting.remainingPercent) {
			limiting = window;
		}
	}
	return limiting ?? windows[0] ?? null;
}

/**
 * Window view from absolute amounts. `remaining` is used when `used` is not
 * reported; percentages stay null when the limit is unknown or not positive.
 */
export function quotaWindowFromAmounts(input: {
	id: string;
	label: string;
	shortLabel: string;
	used: number | null | undefined;
	limit: number | null | undefined;
	remaining?: number | null;
	resetAt?: number | null;
}): QuotaWindowView {
	const limit =
		input.limit != null && Number.isFinite(input.limit) && input.limit >= 0 ? input.limit : null;
	const remaining =
		input.remaining != null && Number.isFinite(input.remaining) ? input.remaining : null;
	let used = input.used != null && Number.isFinite(input.used) ? input.used : null;
	if (used == null && limit != null && remaining != null) {
		const inferred = limit - remaining;
		used = Number.isFinite(inferred) ? inferred : null;
	}
	const usedPercent =
		limit != null && limit > 0 && used != null ? clampPercent((used / limit) * 100) : null;
	const rawRemainingPercent =
		limit != null && limit > 0 && remaining != null
			? clampPercent((remaining / limit) * 100)
			: usedPercent == null
				? null
				: 100 - usedPercent;
	const remainingPercent = rawRemainingPercent == null ? null : Math.round(rawRemainingPercent);
	const exhausted =
		remaining != null ? remaining <= 0 : limit != null && used != null && used >= limit;
	return {
		id: input.id,
		label: input.label,
		shortLabel: input.shortLabel,
		usedPercent,
		remainingPercent,
		used,
		limit,
		resetAt: input.resetAt ?? null,
		// A rounded 0% is not exhaustion when a positive allowance was actually reported.
		level:
			rawRemainingPercent == null && remaining != null && remaining > 0
				? "ok"
				: quotaLevelForRemaining(rawRemainingPercent, exhausted),
	};
}

/** Epoch ms from an upstream timestamp string, or null when absent or unparseable. */
export function parseQuotaReset(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Minimal translation signature compatible with react-i18next's `t`. */
export type QuotaPanelT = (key: string, options?: Record<string, unknown>) => string;

/** "3d 4h" / "2h 15m" / "12m" / "now", for a reset countdown. */
export function formatQuotaCountdown(ms: number, t: QuotaPanelT): string {
	if (!Number.isFinite(ms) || ms <= 0) return t("quotaPanel.resetDue");
	const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return t("quotaPanel.countdownDH", { d: days, h: hours });
	if (hours > 0) return t("quotaPanel.countdownHM", { h: hours, m: minutes });
	return t("quotaPanel.countdownM", { m: minutes });
}

/** Compact amounts, retaining small nonzero values rather than displaying a false zero. */
export function formatQuotaAmount(value: number): string {
	if (Number.isInteger(value)) return String(value);
	const rounded = value.toFixed(2).replace(/\.?0+$/, "");
	return Number(rounded) === 0
		? formatLocaleNumber(value, { maximumSignificantDigits: 6 })
		: rounded;
}

/** Preserve monetary precision and keep each absolute amount attached to its period unit. */
export function formatQuotaWindowAmount(value: number, unit?: string): string {
	const amount = unit
		? formatLocaleNumber(value, { maximumSignificantDigits: 12 })
		: formatQuotaAmount(value);
	return unit ? `${amount} ${unit}` : amount;
}

/**
 * Compact badge text: the limiting window and what is left of it ("5h 63%"),
 * "exhausted" once spent, or the provider's unavailable placeholder.
 */
export function formatQuotaBadgeText(view: QuotaPanelView, t: QuotaPanelT): string {
	if (view.badgeText) return view.badgeText;
	const limiting = view.limiting;
	if (!limiting || limiting.remainingPercent == null) {
		if (limiting?.level === "exhausted") return t("quotaPanel.exhaustedShort");
		return view.unavailableText;
	}
	if (limiting.level === "exhausted") {
		return t("quotaPanel.badgeExhausted", { label: limiting.shortLabel });
	}
	return t("quotaPanel.badgeRemaining", {
		label: limiting.shortLabel,
		percent: limiting.remainingPercent,
	});
}

/** One plain-text line per window, for the badge's accessible label. */
export function formatQuotaSummaryLines(
	view: QuotaPanelView,
	now: number,
	t: QuotaPanelT,
): string[] {
	const lines = view.windows.map((window) => {
		const remaining =
			window.remainingPercent == null
				? t("quotaPanel.remainingUnknown")
				: t("quotaPanel.remainingPercent", { percent: window.remainingPercent });
		const reset =
			window.resetAt == null
				? ""
				: ` · ${t(window.resetCaptionKey ?? "quotaPanel.resetsIn", {
						time: formatQuotaCountdown(window.resetAt - now, t),
					})}`;
		const amounts =
			window.used != null && window.limit != null
				? ` · ${t("quotaPanel.usedOfLimit", { used: formatQuotaWindowAmount(window.used, window.unit), limit: formatQuotaWindowAmount(window.limit, window.unit) })}`
				: "";
		const amountLeft =
			window.remainingAmount != null
				? ` · ${t("quotaSnapshot.remainingAmount", { amount: formatQuotaWindowAmount(window.remainingAmount, window.unit) })}`
				: "";
		return `${window.label}: ${remaining}${amounts}${amountLeft}${reset}`;
	});
	for (const row of view.rows) lines.push(`${row.label}: ${row.value}`);
	if (view.failed) lines.push(t("quotaPanel.staleHint"));
	return lines;
}
