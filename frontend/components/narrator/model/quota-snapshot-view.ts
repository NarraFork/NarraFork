import type { PublicQuotaSnapshot, QuotaBalance } from "@shared/quota-snapshot";
import { formatFullLocaleDateTime } from "../../../lib/format";
import { formatLocaleNumber } from "../../../lib/intl-format";
import {
	formatQuotaBadgeText,
	formatQuotaWindowAmount,
	pickLimitingWindow,
	type QuotaPanelT,
	type QuotaPanelView,
	type QuotaWindowView,
	quotaLevelForRemaining,
	worstQuotaLevel,
} from "./quota-panel-view";

function balanceText(balance: QuotaBalance, t: QuotaPanelT): string {
	const amount = balance.unlimited
		? t("quotaSnapshot.unlimited")
		: balance.remaining != null && Number.isFinite(balance.remaining)
			? formatLocaleNumber(balance.remaining, { maximumSignificantDigits: 12 })
			: t("quotaSnapshot.unknown");
	return [amount, balance.unit].filter(Boolean).join(" ");
}

function balanceUsed(total: number, remaining: number): number {
	const decimals = (value: number) => {
		const [coefficient, exponent = "0"] = String(value).split("e");
		return Math.max(0, (coefficient?.split(".")[1]?.length ?? 0) - Number(exponent));
	};
	const difference = total - remaining;
	// Do not manufacture floating-point dust when subtracting micro-unit balances.
	const rounded = Number(
		difference.toFixed(Math.min(100, Math.max(decimals(total), decimals(remaining)))),
	);
	return rounded === 0 && difference !== 0 ? difference : rounded;
}

/** Only the public, provider-neutral contract is read here. */
export function quotaSnapshotView(
	snapshot: PublicQuotaSnapshot | null | undefined,
	title: string,
	t: QuotaPanelT,
	now = Date.now(),
): QuotaPanelView {
	const expiresAt = snapshot?.expiresAt;
	const knownExpiry = expiresAt != null && Number.isFinite(expiresAt);
	const expired = knownExpiry && expiresAt <= now;
	const windows: QuotaWindowView[] = (expired ? [] : (snapshot?.windows ?? [])).map(
		(window, index) => {
			const usedPercent =
				window.usedRatio != null && Number.isFinite(window.usedRatio)
					? Math.max(0, Math.min(100, window.usedRatio * 100))
					: null;
			const remainingPercent = usedPercent == null ? null : Math.round(100 - usedPercent);
			const limit = window.total != null && Number.isFinite(window.total) ? window.total : null;
			const reportedRemaining =
				window.remaining != null && Number.isFinite(window.remaining) ? window.remaining : null;
			const used =
				window.used != null && Number.isFinite(window.used)
					? window.used
					: limit != null && reportedRemaining != null
						? balanceUsed(limit, reportedRemaining)
						: null;
			const remainingAmount =
				reportedRemaining ?? (limit != null && used != null ? balanceUsed(limit, used) : null);
			const standardPeriod = window.label && ["daily", "weekly", "monthly"].includes(window.label);
			const label = standardPeriod
				? t(`quotaSnapshot.window.${window.label}`)
				: window.label || t(`quotaSnapshot.window.${window.kind}`);
			return {
				id: `${window.kind}-${index}`,
				label,
				shortLabel: label,
				usedPercent,
				remainingPercent,
				used,
				limit,
				remainingAmount,
				...(window.unit ? { unit: window.unit } : {}),
				resetAt: window.resetsAt,
				level: quotaLevelForRemaining(remainingPercent),
			};
		},
	);
	const balances = expired ? [] : (snapshot?.balances ?? []);
	const rows = balances.flatMap((balance) => {
		const values = [
			{ label: balance.unit || t("quotaSnapshot.balance"), value: balanceText(balance, t) },
		];
		if (balance.total != null && Number.isFinite(balance.total)) {
			const suffix = balance.unit ? ` (${balance.unit})` : "";
			values.push({
				label: `${t("quotaSnapshot.total")}${suffix}`,
				value: balanceText({ ...balance, unlimited: false, remaining: balance.total }, t),
			});
			if (!balance.unlimited && balance.remaining != null && Number.isFinite(balance.remaining)) {
				values.push({
					label: `${t("quotaSnapshot.used")}${suffix}`,
					value: balanceText(
						{ ...balance, remaining: balanceUsed(balance.total, balance.remaining) },
						t,
					),
				});
			}
		}
		return values;
	});
	if (snapshot?.plan) rows.push({ label: t("quotaSnapshot.plan"), value: snapshot.plan });
	if (knownExpiry) {
		rows.push({ label: t("quotaSnapshot.expiresAt"), value: formatFullLocaleDateTime(expiresAt) });
	}
	const balanceLevels = balances.map((balance) => {
		if (balance.unlimited) return "ok" as const;
		if (balance.remaining == null || !Number.isFinite(balance.remaining)) return "unknown" as const;
		if (balance.remaining <= 0) return "exhausted" as const;
		return balance.total != null && balance.total > 0
			? quotaLevelForRemaining((balance.remaining / balance.total) * 100)
			: ("ok" as const);
	});
	return {
		title,
		unavailableText: expired
			? t("quotaSnapshot.expired")
			: balances.length
				? balances.map((balance) => balanceText(balance, t)).join(" · ")
				: t("quotaSnapshot.unknown"),
		windows,
		limiting: pickLimitingWindow(windows),
		level: expired
			? "exhausted"
			: worstQuotaLevel([...windows.map((window) => window.level), ...balanceLevels]),
		rows,
		expired,
		failed: !!(snapshot?.error || snapshot?.hasError),
		// Only host-defined reasons are localized; arbitrary error text is never a UI detail.
		failureDetail:
			snapshot?.error === "plugin_not_enabled" ? t("quotaSnapshot.pluginDisabled") : null,
		fetchedAt: snapshot?.fetchedAt ?? 0,
	};
}

/** Plain text for lists and accessible descriptions; expiration follows the same display clock. */
export function quotaSnapshotText(
	snapshot: PublicQuotaSnapshot | null | undefined,
	t: QuotaPanelT,
	now = Date.now(),
): { balance: string; detailsText: string } {
	const view = quotaSnapshotView(snapshot, "", t, now);
	const lines = view.windows.map((window) => {
		const remaining =
			window.remainingPercent == null
				? t("quotaPanel.remainingUnknown")
				: t("quotaPanel.remainingPercent", { percent: window.remainingPercent });
		const reset =
			window.resetAt != null && Number.isFinite(window.resetAt)
				? ` · ${t("quotaSnapshot.resetsAt", { time: new Date(window.resetAt).toISOString() })}`
				: "";
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
	lines.push(...view.rows.map((row) => `${row.label}: ${row.value}`));
	if (view.failureDetail) lines.push(t("quotaPanel.fetchError", { error: view.failureDetail }));
	if (view.failed) lines.push(t("quotaPanel.staleHint"));
	return {
		balance: formatQuotaBadgeText(view, t),
		detailsText: lines.join("\n") || t("quotaSnapshot.unknown"),
	};
}
