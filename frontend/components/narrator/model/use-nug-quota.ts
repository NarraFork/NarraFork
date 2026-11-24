import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { useMemo } from "react";

/** Only recharge-provider identity is needed here; quotas use the shared snapshot query. */
export interface NugProviderSetting {
	id: string;
	name?: string;
	prefix?: string;
	disabled?: boolean;
}

export interface NugProviderInfo {
	providerId: string;
	providerPrefix: string | undefined;
	name: string;
}

/** Resolve the NUG recharge target without fetching or caching provider-specific quotas. */
export function useNugQuota(
	resolvedModel: string | undefined,
	nugProviders: NugProviderSetting[] | undefined,
): NugProviderInfo | null {
	return useMemo(() => {
		if (REMOTE_BUILD) return null;
		const prefix = resolvedModel?.split(":")[0];
		if (!prefix) return null;
		const provider = nugProviders?.find(
			(p) => !p.disabled && (p.prefix === prefix || p.id === prefix),
		);
		if (!provider) return null;
		return {
			providerId: provider.id,
			providerPrefix: provider.prefix,
			name: provider.name ?? provider.prefix ?? provider.id,
		};
	}, [resolvedModel, nugProviders]);
}
