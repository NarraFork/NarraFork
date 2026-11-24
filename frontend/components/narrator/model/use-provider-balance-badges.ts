import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import type { TokenDanceBalance } from "@shared/tokendance";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
	isProviderQuotaCapabilityEnabled,
	type ProviderQuotaCapabilitySettings,
	useProviderQuotas,
} from "../../../hooks/useProviderQuota";
import { useQuotaNow } from "../../../hooks/useQuotaNow";
import { useTokenDanceBalance } from "../../../hooks/useTokenDanceBalance";
import { api } from "../../../lib/api";
import { formatLocaleNumber } from "../../../lib/intl-format";
import { customApiQuotaDisplayFor } from "./custom-api-usage-source";
import { buildProviderQuotaView } from "./provider-quota-view";
import {
	formatQuotaBadgeText,
	formatQuotaSummaryLines,
	QUOTA_LEVEL_COLORS,
} from "./quota-panel-view";
import { tokenDanceQuotaView } from "./tokendance-quota-format";
import type { ProviderQuotaBadge } from "./use-opencode-provider-badges";

/** Pay-as-you-go balance shown in a model-picker provider header. */
export interface ProviderBalanceBadge {
	text: string;
	tooltip?: string;
	/** The last refresh failed or the value is old; drawn dimmed. */
	stale?: boolean;
}
export type ProviderBalanceBadges = Record<string, ProviderBalanceBadge>;
interface ProviderConfigLike {
	id: string;
	prefix?: string;
	baseUrl?: string;
	disabled?: boolean;
}
type Translate = (key: string, options?: Record<string, unknown>) => string;
export interface ProviderBalanceSources {
	customApiProviders: ProviderConfigLike[];
	nugProviders: ProviderConfigLike[];
	nugQuotas?: Record<string, { balance: number | null; detailedQuotaBalance?: string | null }>;
	customApiQuotas?: Parameters<typeof customApiQuotaDisplayFor>[0]["pushedQuotas"];
	providerQuotas?: Record<string, ProviderQuotaSnapshot>;
	providerQuotaGenerations?: Record<string, string>;
	quotaQueryFailed?: boolean;
	/** Disabling quota sources hides their cached values, never independent push text. */
	quotaCapabilityEnabled?: boolean;
	tokenDance?: { generation: number; data: TokenDanceBalance | undefined };
	isAdmin: boolean;
	now: number;
	t: Translate;
}

/** Prefixes are display keys only; normalized values are selected by provider ID + generation. */
export function buildProviderBalanceBadges(input: ProviderBalanceSources): ProviderBalanceBadges {
	const out: ProviderBalanceBadges = {};
	for (const provider of input.nugProviders) {
		if (provider.disabled || !provider.prefix) continue;
		const quota = input.nugQuotas?.[provider.id];
		if (quota?.balance == null || !Number.isFinite(quota.balance)) continue;
		out[provider.prefix] = {
			text: formatLocaleNumber(quota.balance, { maximumFractionDigits: 2 }),
			tooltip: quota.detailedQuotaBalance?.trim() || undefined,
		};
	}
	for (const provider of input.customApiProviders) {
		if (provider.disabled || !provider.prefix) continue;
		const { pushedQuota, quotaSnapshot } = customApiQuotaDisplayFor({
			providerId: provider.id,
			generation: input.providerQuotaGenerations?.[provider.id],
			pushedQuotas: input.customApiQuotas,
			snapshot: input.providerQuotas?.[provider.id],
		});
		if (pushedQuota) {
			out[provider.prefix] = {
				text: pushedQuota.quotaBalance as string,
				tooltip: pushedQuota.detailedQuotaBalance?.trim() || undefined,
			};
			continue;
		}
		if (input.quotaCapabilityEnabled === false || !quotaSnapshot?.data) continue;
		const view = buildProviderQuotaView(
			quotaSnapshot,
			input.t,
			input.isAdmin,
			input.quotaQueryFailed,
			input.now,
		);
		// Window bars have their own slot; discovery/error status is not an amount badge.
		if (!view || view.windows.length > 0) continue;
		out[provider.prefix] = {
			text: formatQuotaBadgeText(view, input.t),
			tooltip: formatQuotaSummaryLines(view, input.now, input.t).join("\n"),
			stale: view.failed,
		};
	}
	if (input.tokenDance) {
		const { generation, data } = input.tokenDance;
		const view = tokenDanceQuotaView(
			data,
			generation,
			input.isAdmin,
			input.t as Parameters<typeof tokenDanceQuotaView>[3],
		);
		if (view && data?.generation === generation && data.balance != null) {
			out.tokendance = {
				text: view.balance,
				tooltip: view.detailsText,
				stale: data.hasError,
			};
		}
	}
	return out;
}

export function buildProviderQuotaBadges(
	input: ProviderBalanceSources,
): Record<string, ProviderQuotaBadge> {
	const out: Record<string, ProviderQuotaBadge> = {};
	if (input.quotaCapabilityEnabled === false) return out;
	for (const provider of input.customApiProviders) {
		if (provider.disabled || !provider.prefix) continue;
		const { quotaSnapshot } = customApiQuotaDisplayFor({
			providerId: provider.id,
			generation: input.providerQuotaGenerations?.[provider.id],
			pushedQuotas: input.customApiQuotas,
			snapshot: input.providerQuotas?.[provider.id],
		});
		const view = buildProviderQuotaView(
			quotaSnapshot,
			input.t,
			input.isAdmin,
			input.quotaQueryFailed,
			input.now,
		);
		if (!view || view.windows.length === 0) continue;
		out[provider.prefix] = {
			text: formatQuotaBadgeText(view, input.t),
			color: QUOTA_LEVEL_COLORS[view.level],
			tooltip: formatQuotaSummaryLines(view, input.now, input.t).join("\n"),
			bars: view.windows,
			stale: view.failed,
		};
	}
	return out;
}

export interface ProviderBadgeSettings extends ProviderQuotaCapabilitySettings {
	customApiProviders?: unknown;
	nugProviders?: unknown;
	customApiQuotas?: unknown;
	providerQuotaGenerations?: unknown;
	tokendance?: unknown;
}

/** One paginated, cache-only read for every Custom API source, not one hook per upstream brand. */
function useCustomApiQuotaBadgeSources(
	settingsData: ProviderBadgeSettings | undefined,
	enabled: boolean,
	isAdmin: boolean,
) {
	const { t } = useTranslation("narrator");
	const customApiProviders = useMemo(
		() =>
			(Array.isArray(settingsData?.customApiProviders)
				? settingsData.customApiProviders
				: []) as ProviderConfigLike[],
		[settingsData?.customApiProviders],
	);
	const providerQuotaGenerations = useMemo(() => {
		const raw = settingsData?.providerQuotaGenerations;
		return raw && typeof raw === "object"
			? Object.fromEntries(
					Object.entries(raw).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};
	}, [settingsData?.providerQuotaGenerations]);
	const quotaCapabilityEnabled = isProviderQuotaCapabilityEnabled(settingsData);
	const query = useProviderQuotas(
		providerQuotaGenerations,
		enabled && customApiProviders.some((p) => !p.disabled),
		quotaCapabilityEnabled,
	);
	const now = useQuotaNow(
		enabled &&
			quotaCapabilityEnabled &&
			Object.values(query.data ?? {}).some((snapshot) => Boolean(snapshot.data?.expiresAt)),
	);
	return {
		customApiProviders,
		customApiQuotas: settingsData?.customApiQuotas as ProviderBalanceSources["customApiQuotas"],
		providerQuotaGenerations,
		providerQuotas: query.data,
		quotaQueryFailed: query.isError,
		quotaCapabilityEnabled,
		isAdmin,
		now,
		t,
	};
}

export function useCustomApiQuotaBadges(
	settingsData: ProviderBadgeSettings | undefined,
	enabled: boolean,
	isAdmin: boolean,
) {
	const input = useCustomApiQuotaBadgeSources(settingsData, enabled, isAdmin);
	const badges = buildProviderQuotaBadges({ ...input, nugProviders: [] });
	return Object.keys(badges).length > 0 ? badges : undefined;
}

/** Shared picker path; NUG and platform TokenDance retain their original caches and behavior. */
export function useProviderBalanceBadges(
	settingsData: ProviderBadgeSettings | undefined,
	enabled: boolean,
	isAdmin: boolean,
): ProviderBalanceBadges | undefined {
	const customApi = useCustomApiQuotaBadgeSources(settingsData, enabled, isAdmin);
	const nugProviders = useMemo(
		() =>
			(Array.isArray(settingsData?.nugProviders)
				? settingsData.nugProviders
				: []) as ProviderConfigLike[],
		[settingsData?.nugProviders],
	);
	const hasNug = nugProviders.some((p) => !p.disabled);
	const { data: nugQuotas } = useQuery({
		queryKey: ["nug", "quotas"],
		queryFn: api.nugGetQuotas,
		enabled: !REMOTE_BUILD && enabled && hasNug,
		staleTime: 30_000,
	});
	const tokenDanceConnection = settingsData?.tokendance as
		| { connected?: boolean; disabled?: boolean; generation?: number }
		| undefined;
	const tokenDanceGeneration =
		tokenDanceConnection?.connected &&
		!tokenDanceConnection.disabled &&
		Number.isSafeInteger(tokenDanceConnection.generation)
			? (tokenDanceConnection.generation as number)
			: undefined;
	const tokenDanceBalance = useTokenDanceBalance(tokenDanceGeneration, enabled);
	const badges = buildProviderBalanceBadges({
		...customApi,
		nugProviders,
		nugQuotas,
		tokenDance:
			tokenDanceGeneration !== undefined
				? { generation: tokenDanceGeneration, data: tokenDanceBalance.data }
				: undefined,
	});
	return Object.keys(badges).length > 0 ? badges : undefined;
}
