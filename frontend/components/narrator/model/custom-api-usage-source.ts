/**
 * Which cached usage source may speak for the provider the panel is currently showing.
 *
 * Both sources are keyed by provider id, and each is guarded by the provider id it is
 * CURRENTLY configured for rather than by "does this id appear in that source's cache".
 * That distinction is the whole point: React Query keeps the last `data` of a query that
 * has been disabled, so after an admin edits a provider from a Kimi endpoint to an
 * OpenCode Go one, the Kimi cache still holds an entry for that same id and its query is
 * disabled — it will never refetch to drop it. Reading that entry unguarded displayed the
 * previous account's allowance under the new one, which is exactly what the per-provider
 * isolation is supposed to prevent.
 *
 * Extracted from `NarratorPanel` so the precedence is testable without mounting the panel
 * (which carries queries, a WS subscription and scroll containers).
 */
import type { ProviderBalanceSnapshot } from "../../../../shared/provider-balance";
import type { ProviderQuotaSnapshot } from "../../../../shared/provider-quota";
import { isSub2ApiSubscriptionSnapshot } from "./sub2api-subscription-quota-view";

export function usageSourceFor(input: {
	providerId: string;
	opencodeProviderId: string | null;
	kimiProviderId: string | null;
}): "opencode" | "kimi" | null {
	if (input.providerId === input.opencodeProviderId) return "opencode";
	if (input.providerId === input.kimiProviderId) return "kimi";
	return null;
}

/** Stream-provided text wins over auto-detected balances, including after remount. */
export function customApiBalanceDisplayFor(input: {
	providerId: string | null;
	pushedQuotas?: Record<
		string,
		{ quotaBalance: string | null; detailedQuotaBalance?: string | null }
	>;
	snapshot: ProviderBalanceSnapshot | null | undefined;
}) {
	const cached = input.providerId ? input.pushedQuotas?.[input.providerId] : undefined;
	const pushedQuota = cached?.quotaBalance?.trim() ? cached : null;
	return {
		pushedQuota,
		// The query already isolates provider/generation; this layer only selects the source.
		subscriptionSnapshot:
			!pushedQuota && isSub2ApiSubscriptionSnapshot(input.snapshot) ? input.snapshot : null,
	};
}

/** The already resolved runtime model chooses the provider, never the first auto source. */
export function resolveCustomApiQuotaProviderId(
	resolvedModel: string | null | undefined,
	providers: readonly { id: string; prefix?: string; disabled?: boolean }[] | undefined,
): string | null {
	const prefix = resolvedModel?.split(":")[0];
	if (!prefix) return null;
	return (
		providers?.find((provider) => provider.prefix === prefix && !provider.disabled)?.id ?? null
	);
}

/** Inference-key text cannot replace an explicit site account or a different Key identity. */
export function customApiQuotaDisplayFor(input: {
	providerId: string | null;
	generation: string | undefined;
	pushedQuotas?: Record<
		string,
		{ quotaBalance: string | null; detailedQuotaBalance?: string | null; generation?: string }
	>;
	snapshot: ProviderQuotaSnapshot | null | undefined;
}) {
	const snapshot = input.snapshot;
	const quotaSnapshot =
		input.providerId &&
		input.generation &&
		snapshot?.providerId === input.providerId &&
		snapshot.targetId === `custom-api/${input.providerId}` &&
		snapshot.generation === input.generation
			? snapshot
			: null;
	const cached = input.providerId ? input.pushedQuotas?.[input.providerId] : undefined;
	const versionedPush = Boolean(input.generation && cached?.generation === input.generation);
	const legacyPush =
		cached?.generation === undefined && !snapshot?.keyId && (!snapshot || quotaSnapshot !== null);
	const pushedQuota =
		snapshot?.pushCompatible !== false &&
		cached?.quotaBalance?.trim() &&
		(versionedPush || legacyPush)
			? cached
			: null;
	return { pushedQuota, quotaSnapshot: pushedQuota ? null : quotaSnapshot };
}
