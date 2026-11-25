import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { QuotaSnapshotEntry } from "@shared/quota-snapshot";
import { useMemo } from "react";
import { selectQuotaEntries, useQuotaSnapshots } from "../../../hooks/useQuotaSnapshots";
import { getToken } from "../../../lib/api/client";

export interface NugProviderSetting {
	id: string;
	name?: string;
	prefix?: string;
	disabled?: boolean;
	generation?: number | string;
}

export interface NugProviderInfo {
	providerId: string;
	providerPrefix: string | undefined;
	name: string;
	entries: QuotaSnapshotEntry[];
}

/** One cached-only group projection, isolated by the model-runtime generation and session. */
export function useNugQuota(
	resolvedModel: string | undefined,
	nugProviders: NugProviderSetting[] | undefined,
	enabled = true,
): NugProviderInfo | null {
	const provider = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		return prefix
			? nugProviders?.find(
					(entry) => !entry.disabled && (entry.prefix === prefix || entry.id === prefix),
				)
			: undefined;
	}, [resolvedModel, nugProviders]);
	const query = useQuotaSnapshots(
		!REMOTE_BUILD && enabled && !!getToken() && !!provider && provider.generation !== undefined,
		{ groupId: provider?.id, cachedOnly: true, expectedGeneration: provider?.generation },
	);
	if (REMOTE_BUILD || !enabled || !provider) return null;
	return {
		providerId: provider.id,
		providerPrefix: provider.prefix,
		name: provider.name ?? provider.prefix ?? provider.id,
		entries: selectQuotaEntries(query.data?.entries ?? []).filter(
			(entry) => entry.groupId === provider.id && entry.supported !== false,
		),
	};
}
