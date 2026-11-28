import type { PublicQuotaSnapshot, QuotaBalance } from "@shared/quota-snapshot";
import { formatFullLocaleDateTime } from "../../../lib/format";
import { formatLocaleNumber } from "../../../lib/intl-format";
import {
	formatQuotaBadgeText,
	formatQuotaWindowAmount,
	pickLimitingWindow,
	type QuotaLevel,
	type QuotaPanelT,
	type QuotaPanelView,
	type QuotaWindowView,
	quotaLevelForRemaining,
	worstQuotaLevel,
} from "./quota-panel-view";

function balanceText(balance: QuotaBalance, t: QuotaPanelT): string {
	const exact = balance.remainingText;
	const amount = balance.unlimited
		? t("quotaSnapshot.unlimited")
		: balance.remaining != null && Number.isFinite(balance.remaining)
			? exact &&
				exact.length <= 64 &&
				/^-?(?:\d+\.?\d*|\.\d+)$/.test(exact) &&
				Number(exact) === balance.remaining
				? exact
				: formatLocaleNumber(balance.remaining, { maximumSignificantDigits: 12 })
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
			const rawRemainingPercent = usedPercent == null ? null : 100 - usedPercent;
			const remainingPercent =
				rawRemainingPercent == null ? null : Math.round(rawRemainingPercent);
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
				level:
					window.status === "rate-limited" ||
					(reportedRemaining !== null && reportedRemaining <= 0)
						? "exhausted"
						: reportedRemaining !== null &&
								reportedRemaining > 0 &&
								rawRemainingPercent !== null &&
								rawRemainingPercent <= 0
							? "critical"
							: quotaLevelForRemaining(rawRemainingPercent),
			};
		},
	);
	const balances = expired ? [] : (snapshot?.balances ?? []);
	const summaryBalances = balances.filter((balance) => balance.display !== "detail");
	const rows: QuotaPanelView["rows"] = balances.flatMap((balance, index) => {
		const rowId = balance.id ? `balance:${index}:${balance.id}` : undefined;
		const values: QuotaPanelView["rows"] = [
			{
				...(rowId ? { id: rowId } : {}),
				label: balance.label || balance.unit || t("quotaSnapshot.balance"),
				value: balanceText(balance, t),
			},
		];
		const suffix = balance.unit ? ` (${balance.unit})` : "";
		if (balance.total != null && Number.isFinite(balance.total)) {
			values.push({
				...(rowId ? { id: `${rowId}:total` } : {}),
				label: `${t("quotaSnapshot.total")}${suffix}`,
				value: balanceText(
					{ ...balance, unlimited: false, remainingText: undefined, remaining: balance.total },
					t,
				),
			});
		}
		const used =
			balance.used != null && Number.isFinite(balance.used)
				? balance.used
				: !balance.unlimited &&
						balance.total != null &&
						Number.isFinite(balance.total) &&
						balance.remaining != null &&
						Number.isFinite(balance.remaining)
					? balanceUsed(balance.total, balance.remaining)
					: null;
		if (used !== null) {
			values.push({
				...(rowId ? { id: `${rowId}:used` } : {}),
				label: `${t("quotaSnapshot.used")}${suffix}`,
				value: balanceText(
					{ ...balance, unlimited: false, remainingText: undefined, remaining: used },
					t,
				),
			});
		}
		const label = balance.label || balance.id || balance.unit;
		if (balance.window) {
			values.push({
				...(rowId ? { id: `${rowId}:window` } : {}),
				label: t("providerQuota.amountWindow", { label }),
				value: balance.window,
			});
		}
		if (balance.windowStart != null && Number.isFinite(balance.windowStart)) {
			values.push({
				...(rowId ? { id: `${rowId}:window-start` } : {}),
				label: t("providerQuota.windowStart", { label }),
				value: formatFullLocaleDateTime(balance.windowStart),
			});
		}
		return values;
	});
	if (snapshot?.scope && snapshot.scope !== "account") {
		rows.push({ label: t("providerQuota.scope"), value: t(`providerQuota.scopes.${snapshot.scope}`) });
	}
	if (snapshot?.available === false) {
		rows.push({
			label: t("providerQuota.availability"),
			value: t("providerQuota.accountUnavailable"),
		});
	}
	if (snapshot?.plan) rows.push({ label: t("quotaSnapshot.plan"), value: snapshot.plan });
	if (snapshot?.details) rows.push({ label: t("providerQuota.details"), value: snapshot.details });
	if (knownExpiry) {
		rows.push({ label: t("quotaSnapshot.expiresAt"), value: formatFullLocaleDateTime(expiresAt) });
	}
	const balanceLevels: QuotaLevel[] = [];
	const alternatives: QuotaLevel[] = [];
	for (const balance of balances) {
		if (balance.quota === "none") continue;
		const level: QuotaLevel = balance.unlimited
			? "ok"
			: balance.remaining == null || !Number.isFinite(balance.remaining)
				? "unknown"
				: balance.remaining <= 0
					? "exhausted"
					: balance.total != null && balance.total > 0
						? quotaLevelForRemaining((balance.remaining / balance.total) * 100)
						: "ok";
		if (balance.quota === "alternative") alternatives.push(level);
		else balanceLevels.push(level);
	}
	if (alternatives.length) {
		// Any usable alternative suffices; unknown credit never proves exhaustion.
		const best = (["ok", "warning", "critical", "unknown", "exhausted"] as const).find((level) =>
			alternatives.includes(level),
		);
		if (best) balanceLevels.push(best);
	}
	return {
		title,
		unavailableText: expired
			? t("quotaSnapshot.expired")
			: summaryBalances.length
				? summaryBalances.map((balance) => balanceText(balance, t)).join(" · ")
				: t("quotaSnapshot.unknown"),
		badgeText:
			!expired && snapshot?.available === false ? t("providerQuota.accountUnavailable") : undefined,
		windows,
		limiting: pickLimitingWindow(windows),
		level:
			expired || snapshot?.available === false
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
