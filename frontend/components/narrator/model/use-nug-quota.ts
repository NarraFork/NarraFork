import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../../../lib/api";

/**
 * NUG provider config as stored in settings. Only the fields this hook reads
 * are declared; the settings object carries more that is irrelevant here.
 */
export interface NugProviderSetting {
	id: string;
	name?: string;
	prefix?: string;
	disabled?: boolean;
}

/** Resolved NUG provider quota info surfaced to the panel (feeds the WS state). */
export interface NugProviderInfo {
	providerId: string;
	providerPrefix: string | undefined;
	name: string;
	quotaBalance: string | null;
	totalGranted: number | null;
	detailedQuotaBalance: string | null;
}

/**
 * Owns the NUG quota data layer for the active narrator's model:
 * - resolves the NUG provider config from the model prefix,
 * - fetches the aggregate quotas (and a targeted single-provider quota when the
 *   aggregate is missing the current provider),
 * - writes the single-provider result back into the aggregate cache, and
 * - derives {@link NugProviderInfo} for the current provider.
 *
 * The derived info still flows back into NarratorPanel (it feeds the shared
 * `useNarratorPanelWS` and the payment-required recharge derivation), so the
 * call stays in the panel rather than being pushed into a single child.
 */
export function useNugQuota(
	resolvedModel: string | undefined,
	nugProviders: NugProviderSetting[] | undefined,
): NugProviderInfo | null {
	const qc = useQueryClient();

	const nugProviderConfig = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		if (!prefix) return null;
		const providers: NugProviderSetting[] = nugProviders ?? [];
		return providers.find((p) => !p.disabled && (p.prefix === prefix || p.id === prefix)) ?? null;
	}, [resolvedModel, nugProviders]);
	const hasNugProviders = (nugProviders?.length ?? 0) > 0;
	const { data: nugQuotasData } = useQuery({
		queryKey: ["nug", "quotas"],
		queryFn: api.nugGetQuotas,
		enabled: hasNugProviders,
		staleTime: 30_000,
	});
	const missingCurrentNugQuota = Boolean(
		nugProviderConfig?.id && nugQuotasData && !nugQuotasData[nugProviderConfig.id],
	);
	const { data: currentNugQuotaData } = useQuery({
		queryKey: ["nug", "quota", nugProviderConfig?.id],
		queryFn: () => api.nugGetQuota(nugProviderConfig?.id ?? ""),
		enabled: missingCurrentNugQuota,
		staleTime: 30_000,
	});

	useEffect(() => {
		if (!nugProviderConfig?.id || !currentNugQuotaData) return;
		qc.setQueryData(["nug", "quotas"], (old: unknown) => {
			const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
			const existing =
				quotas[nugProviderConfig.id] && typeof quotas[nugProviderConfig.id] === "object"
					? (quotas[nugProviderConfig.id] as Record<string, unknown>)
					: {};
			return {
				...quotas,
				[nugProviderConfig.id]: {
					...existing,
					balance: currentNugQuotaData.balance,
					totalGranted: currentNugQuotaData.totalGranted,
					detailedQuotaBalance: currentNugQuotaData.detailedQuotaBalance ?? null,
					...(currentNugQuotaData.extra !== undefined ? { extra: currentNugQuotaData.extra } : {}),
				},
			};
		});
	}, [currentNugQuotaData, nugProviderConfig?.id, qc]);

	return useMemo(() => {
		if (!nugProviderConfig) return null;
		const quota = nugQuotasData?.[nugProviderConfig.id] ?? currentNugQuotaData;
		const rawDetailedQuotaBalance = quota?.detailedQuotaBalance;
		const detailedQuotaBalance = rawDetailedQuotaBalance?.trim() ? rawDetailedQuotaBalance : null;
		return {
			providerId: nugProviderConfig.id,
			providerPrefix: nugProviderConfig.prefix,
			name: nugProviderConfig.name ?? nugProviderConfig.prefix ?? nugProviderConfig.id,
			quotaBalance: quota?.balance == null ? null : String(quota.balance),
			totalGranted: quota?.totalGranted ?? null,
			detailedQuotaBalance,
		};
	}, [nugProviderConfig, nugQuotasData, currentNugQuotaData]);
}
