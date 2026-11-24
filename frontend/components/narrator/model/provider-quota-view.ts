import type { ProviderQuotaAmount, ProviderQuotaSnapshot } from "@shared/provider-quota";
import {
	formatQuotaAmount,
	parseQuotaReset,
	pickLimitingWindow,
	type QuotaLevel,
	type QuotaPanelT,
	type QuotaPanelView,
	quotaLevelForRemaining,
	quotaWindowFromAmounts,
	worstQuotaLevel,
} from "./quota-panel-view";

function finite(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) ? value : null;
}

function formatAmount(value: number | null | undefined, unit: string | undefined, t: QuotaPanelT) {
	const amount = finite(value);
	return amount === null
		? t("providerQuota.unknown")
		: `${unit ? `${unit} ` : ""}${formatQuotaAmount(amount)}`;
}

export function formatProviderQuotaAmount(amount: ProviderQuotaAmount, t: QuotaPanelT): string {
	if (amount.unlimited === true) return t("providerQuota.unlimited");
	const exact = amount.remainingText;
	if (
		exact &&
		exact.length <= 64 &&
		/^-?(?:\d+\.?\d*|\.\d+)$/.test(exact) &&
		finite(amount.remaining) !== null &&
		Number(exact) === amount.remaining
	)
		return `${amount.unit} ${exact}`;
	return formatAmount(amount.remaining, amount.unit, t);
}

/** Required amounts constrain independently; alternatives are usable without summing currencies. */
function amountQuotaLevels(amounts: ProviderQuotaAmount[], unlimited: boolean): QuotaLevel[] {
	if (unlimited) return ["ok"];
	const levels: QuotaLevel[] = [];
	const alternatives: QuotaLevel[] = [];
	for (const amount of amounts) {
		if (amount.quota === "none") continue;
		const remaining = finite(amount.remaining);
		const level: QuotaLevel =
			amount.unlimited === true
				? "ok"
				: remaining === null
					? "unknown"
					: remaining <= 0
						? "exhausted"
						: "ok";
		if (amount.quota === "alternative") alternatives.push(level);
		else levels.push(level);
	}
	if (alternatives.length > 0) {
		levels.push(
			alternatives.includes("ok")
				? "ok"
				: alternatives.includes("unknown")
					? "unknown"
					: "exhausted",
		);
	}
	return levels;
}

/** Legacy error snapshots can also identify a missing or disabled quota source. */
export function isProviderQuotaUnavailable(
	snapshot: ProviderQuotaSnapshot | null | undefined,
): boolean {
	return snapshot?.status === "unavailable" || snapshot?.error === "unavailable";
}

/** Any quota source can render amounts/windows; neither sourceId nor format selects a core adapter. */
export function buildProviderQuotaView(
	snapshot: ProviderQuotaSnapshot | null | undefined,
	t: QuotaPanelT,
	isAdmin = false,
	queryFailed = false,
	now = Date.now(),
): QuotaPanelView | null {
	if (!snapshot || isProviderQuotaUnavailable(snapshot)) return null;
	const data = snapshot.data;
	const expiresAt = parseQuotaReset(data?.expiresAt);
	const expired = expiresAt !== null && expiresAt <= now;
	const windows = (data?.windows ?? []).map((window) => {
		const remaining = finite(window.remaining);
		const view = quotaWindowFromAmounts({
			id: window.id,
			label: window.label || window.id,
			shortLabel: window.label || window.id,
			used: finite(window.used),
			limit: finite(window.limit),
			remaining,
			resetAt: parseQuotaReset(window.resetAt),
		});
		const explicitPercent = finite(window.usedPercent);
		if (explicitPercent !== null) {
			view.usedPercent = Math.max(0, Math.min(100, explicitPercent));
			const rawRemainingPercent = 100 - view.usedPercent;
			view.remainingPercent = Math.round(rawRemainingPercent);
			view.level =
				remaining !== null && remaining > 0 && rawRemainingPercent <= 0
					? "critical"
					: quotaLevelForRemaining(rawRemainingPercent);
		}
		if (window.status === "rate-limited" || (remaining !== null && remaining <= 0)) {
			view.level = "exhausted";
		}
		return view;
	});
	const amounts = data?.amounts ?? [];
	const rows: QuotaPanelView["rows"] = [];
	const amountLevels = amountQuotaLevels(amounts, data?.unlimited === true);
	for (const amount of amounts) {
		const mirroredWindow =
			amount.display === "detail" && amount.quota === "none"
				? data?.windows.find(
						(window) =>
							window.id === amount.window &&
							window.unit === amount.unit &&
							window.remaining === amount.remaining &&
							window.used === amount.used &&
							window.limit === amount.total,
					)
				: undefined;
		const label = amount.label || mirroredWindow?.label || amount.id;
		if (!mirroredWindow) {
			rows.push({ id: `amount/${amount.id}`, label, value: formatProviderQuotaAmount(amount, t) });
			if (amount.used !== undefined || amount.total !== undefined)
				rows.push({
					id: `amount/${amount.id}/usage`,
					label: t("providerQuota.amountUsage", { label }),
					value: `${formatAmount(amount.used, amount.unit, t)} / ${formatAmount(amount.total, amount.unit, t)}`,
				});
			if (amount.window)
				rows.push({
					id: `amount/${amount.id}/window`,
					label: t("providerQuota.amountWindow", { label }),
					value: amount.window,
				});
		}
		if (amount.windowStart)
			rows.push({
				id: `amount/${amount.id}/window-start`,
				label: t("providerQuota.windowStart", { label }),
				value: amount.windowStart,
			});
	}
	for (const window of data?.windows ?? []) {
		if (finite(window.remaining) !== null)
			rows.push({
				id: `window/${window.id}/remaining`,
				label: t("providerQuota.windowRemaining", { label: window.label || window.id }),
				value: formatAmount(window.remaining, window.unit, t),
			});
	}
	if (data?.unlimited === true)
		rows.push({
			id: "meta/allowance",
			label: t("providerQuota.allowance"),
			value: t("providerQuota.unlimited"),
		});
	if (data?.available === false)
		rows.push({
			id: "meta/availability",
			label: t("providerQuota.availability"),
			value: t("providerQuota.accountUnavailable"),
		});
	if (data?.planName)
		rows.push({ id: "meta/plan", label: t("providerQuota.plan"), value: data.planName });
	if (data?.scope) {
		const scope = data.scope;
		const value =
			scope === "wallet" || scope === "key" || scope === "subscription"
				? t(`providerQuota.scopes.${scope}`)
				: scope;
		rows.push({ id: "meta/scope", label: t("providerQuota.scope"), value });
	}
	if (data?.expiresAt)
		rows.push({ id: "meta/expiresAt", label: t("providerQuota.expiresAt"), value: data.expiresAt });
	if (expired)
		rows.push({
			id: "meta/status",
			label: t("providerQuota.status"),
			value: t("providerQuota.expiredDetail"),
		});
	if (data?.details)
		rows.push({ id: "meta/details", label: t("providerQuota.details"), value: data.details });
	const failed =
		queryFailed || snapshot.stale || snapshot.status === "error" || snapshot.error !== null;
	const balanceText = amounts
		.filter((amount) => amount.display !== "detail")
		.map((amount) => formatProviderQuotaAmount(amount, t))
		.join(" · ");
	const fallbackStatus = queryFailed
		? "error"
		: snapshot.status === "supported"
			? "unknown"
			: snapshot.status;
	return {
		title: t("providerQuota.title"),
		badgeText: expired ? t("providerQuota.expired") : undefined,
		unavailableText:
			data?.unlimited === true
				? t("providerQuota.unlimited")
				: balanceText || t(`providerQuota.${fallbackStatus}`),
		// Once expired, show the authoritative text badge rather than apparently usable bars.
		windows: expired ? [] : windows,
		limiting: expired ? null : pickLimitingWindow(windows),
		level: worstQuotaLevel([
			...windows.map((window) => window.level),
			...amountLevels,
			...(data?.available === false || expired ? ["exhausted" as const] : []),
		]),
		rows,
		failed,
		failureDetail: isAdmin && snapshot.error ? t(`providerQuota.errors.${snapshot.error}`) : null,
		fetchedAt: snapshot.fetchedAt,
	};
}
