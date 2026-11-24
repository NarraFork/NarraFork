import type { PublicQuotaSnapshot, QuotaBalance } from "@shared/quota-snapshot";
import { formatLocaleNumber } from "../../../lib/intl-format";
import {
	formatQuotaBadgeText,
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
): QuotaPanelView {
	const windows: QuotaWindowView[] = (snapshot?.windows ?? []).map((window, index) => {
		const usedPercent =
			window.usedRatio != null && Number.isFinite(window.usedRatio)
				? Math.max(0, Math.min(100, window.usedRatio * 100))
				: null;
		const remainingPercent = usedPercent == null ? null : Math.round(100 - usedPercent);
		const label = window.label || t(`quotaSnapshot.window.${window.kind}`);
		return {
			id: `${window.kind}-${index}`,
			label,
			shortLabel: label,
			usedPercent,
			remainingPercent,
			used: null,
			limit: null,
			resetAt: window.resetsAt,
			level: quotaLevelForRemaining(remainingPercent),
		};
	});
	const balances = snapshot?.balances ?? [];
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
		unavailableText: balances.length
			? balances.map((balance) => balanceText(balance, t)).join(" · ")
			: t("quotaSnapshot.unknown"),
		windows,
		limiting: pickLimitingWindow(windows),
		level: worstQuotaLevel([...windows.map((window) => window.level), ...balanceLevels]),
		rows,
		failed: !!(snapshot?.error || snapshot?.hasError),
		// The public API's safe status code is not user-facing failure detail.
		failureDetail: snapshot?.error === "quota_unavailable" ? null : (snapshot?.error ?? null),
		fetchedAt: snapshot?.fetchedAt ?? 0,
	};
}

/** Clock-independent plain text for lists, settings and accessible descriptions. */
export function quotaSnapshotText(
	snapshot: PublicQuotaSnapshot | null | undefined,
	t: QuotaPanelT,
): { balance: string; detailsText: string } {
	const view = quotaSnapshotView(snapshot, "", t);
	const lines = view.windows.map((window) => {
		const remaining =
			window.remainingPercent == null
				? t("quotaPanel.remainingUnknown")
				: t("quotaPanel.remainingPercent", { percent: window.remainingPercent });
		const reset =
			window.resetAt != null && Number.isFinite(window.resetAt)
				? ` · ${t("quotaSnapshot.resetsAt", { time: new Date(window.resetAt).toISOString() })}`
				: "";
		return `${window.label}: ${remaining}${reset}`;
	});
	lines.push(...view.rows.map((row) => `${row.label}: ${row.value}`));
	if (view.failureDetail) lines.push(t("quotaPanel.fetchError", { error: view.failureDetail }));
	if (view.failed) lines.push(t("quotaPanel.staleHint"));
	return {
		balance: formatQuotaBadgeText(view, t),
		detailsText: lines.join("\n") || t("quotaSnapshot.unknown"),
	};
}
