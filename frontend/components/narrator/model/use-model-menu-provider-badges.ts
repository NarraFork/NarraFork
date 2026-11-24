import type { QuotaSnapshotEntry } from "@shared/quota-snapshot";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	selectQuotaEntries,
	useCommandCodeCliQuota,
	useQuotaSnapshots,
} from "../../../hooks/useQuotaSnapshots";
import type { QuotaBarSpec } from "./QuotaWindowBars";
import {
	formatQuotaBadgeText,
	formatQuotaSummaryLines,
	pickLimitingWindow,
	QUOTA_LEVEL_COLORS,
	type QuotaPanelT,
	worstQuotaLevel,
} from "./quota-panel-view";
import { quotaSnapshotText, quotaSnapshotView } from "./quota-snapshot-view";

/** Provider-neutral model-picker glyphs. Neither type describes an upstream payload. */
export interface ProviderQuotaBadge {
	text: string;
	color: string;
	tooltip?: string;
	bars?: QuotaBarSpec[];
	stale?: boolean;
}
export interface ProviderBalanceBadge {
	text: string;
	tooltip?: string;
	stale?: boolean;
}

interface BadgeSettings {
	customApiProviders?: unknown;
	nugProviders?: unknown;
	tokendance?: unknown;
	commandCode?: unknown;
}

/** Build the same window/amount presentation for every source, without reading detail. */
export function buildModelMenuProviderBadges(
	entries: QuotaSnapshotEntry[],
	now: number,
	t: QuotaPanelT,
	settingsData?: BadgeSettings,
) {
	const disabled = new Set<string>();
	for (const values of [settingsData?.customApiProviders, settingsData?.nugProviders]) {
		if (!Array.isArray(values)) continue;
		for (const provider of values) {
			if (provider.disabled) disabled.add(provider.id);
		}
	}
	if ((settingsData?.tokendance as { disabled?: boolean } | undefined)?.disabled) {
		disabled.add("tokendance");
	}
	if ((settingsData?.commandCode as { disabled?: boolean } | undefined)?.disabled) {
		disabled.add("CommandCode");
	}
	const groups = new Map<string, QuotaSnapshotEntry[]>();
	for (const entry of selectQuotaEntries(entries)) {
		if (disabled.has(entry.groupId)) continue;
		const group = groups.get(entry.prefix) ?? [];
		group.push(entry);
		groups.set(entry.prefix, group);
	}
	const providerBadges: Record<string, ProviderQuotaBadge> = {};
	const providerBalances: Record<string, ProviderBalanceBadge> = {};
	for (const [prefix, group] of groups) {
		const views = group.map((entry) => quotaSnapshotView(entry.snapshot, prefix, t));
		const windows = views.flatMap((view, index) =>
			view.windows.map((window) => ({
				...window,
				id: `${index}:${window.id}`,
				label: group.length > 1 ? `${index + 1} · ${window.label}` : window.label,
			})),
		);
		const failed = views.some((view) => view.failed);
		if (windows.length) {
			const level = worstQuotaLevel(windows.map((window) => window.level));
			const combined = {
				...views[0],
				windows,
				limiting: pickLimitingWindow(windows),
				level,
				failed,
			};
			providerBadges[prefix] = {
				text: formatQuotaBadgeText(combined, t),
				color: QUOTA_LEVEL_COLORS[level],
				tooltip: formatQuotaSummaryLines(combined, now, t).join("\n"),
				bars: windows,
				stale: failed,
			};
		}
		const balances = group.flatMap((entry) =>
			entry.snapshot?.balances.length
				? [quotaSnapshotText({ ...entry.snapshot, windows: [] }, t)]
				: [],
		);
		if (balances.length) {
			// Do not sum balances: separate credentials can share an upstream wallet.
			providerBalances[prefix] = {
				text: balances.map((balance) => balance.balance).join(" / "),
				tooltip: balances.map((balance) => balance.detailsText).join("\n"),
				stale: failed,
			};
		} else if (!windows.length && group.some((entry) => entry.supported !== false)) {
			providerBadges[prefix] = {
				text: views[0].unavailableText,
				color: "gray",
				tooltip: failed ? t("quotaPanel.staleHint") : undefined,
				stale: failed,
			};
		}
	}
	return {
		providerBadges: Object.keys(providerBadges).length ? providerBadges : undefined,
		providerBalances: Object.keys(providerBalances).length ? providerBalances : undefined,
	};
}

/** One shared cache/query for windows, wallets, subscriptions and stream balances. */
export function useModelMenuProviderBadges(
	settingsData: BadgeSettings | undefined,
	enabled: boolean,
) {
	const { t } = useTranslation("narrator");
	const { data } = useQuotaSnapshots(enabled);
	useCommandCodeCliQuota(enabled);
	return useMemo(
		() => buildModelMenuProviderBadges(data?.entries ?? [], Date.now(), t, settingsData),
		[data, settingsData, t],
	);
}
