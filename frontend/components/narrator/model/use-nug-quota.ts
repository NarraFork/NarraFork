import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { api } from "../../../lib/api";
import { ApiError, getToken, onTokenChange } from "../../../lib/api/client";

/** Only the current provider's bounded runtime projection is needed. */
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
	quotaBalance: string | null;
	totalGranted: number | null;
	detailedQuotaBalance: string | null;
}

export const nugQuotaKey = (
	providerId: string | undefined,
	generation: number | string | undefined,
	token: string | null,
) => ["nug", "quota", providerId, generation, token] as const;

type QuotaRefresh = { started: boolean; dirty: boolean; promise: Promise<void> };
const quotaRefreshes = new WeakMap<QueryClient, Map<string, QuotaRefresh>>();

/** Coalesce a WS burst; never cancel/restart a cached read or touch another identity. */
export function invalidateNugQuotaForIdentity(
	qc: QueryClient,
	identity: {
		providerId: string;
		generation: number | string | undefined;
		token: string | null;
	},
): Promise<void> {
	if (!identity.providerId || identity.generation === undefined || getToken() !== identity.token)
		return Promise.resolve();
	const queryKey = nugQuotaKey(identity.providerId, identity.generation, identity.token);
	const key = JSON.stringify(queryKey);
	let refreshes = quotaRefreshes.get(qc);
	if (!refreshes) {
		refreshes = new Map();
		quotaRefreshes.set(qc, refreshes);
	}
	const existing = refreshes.get(key);
	if (existing) {
		if (existing.started) existing.dirty = true;
		return existing.promise;
	}
	let complete!: () => void;
	let fail!: (error: unknown) => void;
	const entry: QuotaRefresh = {
		started: false,
		dirty: false,
		promise: new Promise<void>((resolve, reject) => {
			complete = resolve;
			fail = reject;
		}),
	};
	refreshes.set(key, entry);
	queueMicrotask(() => {
		void (async () => {
			entry.started = true;
			let externalRead = qc.isFetching({ queryKey, exact: true }) > 0;
			do {
				entry.dirty = false;
				if (getToken() !== identity.token) return;
				await qc.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
				// A marker received during the hook's initial read must not be cleared
				// by that older promise; wait for it, then do exactly one fresh tail read.
				if (externalRead) {
					externalRead = false;
					entry.dirty = true;
				}
			} while (entry.dirty && getToken() === identity.token);
		})().then(
			() => {
				refreshes.delete(key);
				complete();
			},
			(error) => {
				refreshes.delete(key);
				fail(error);
			},
		);
	});
	return entry.promise;
}

/** Read only a cached, generation-bound provider projection; never quota RPC or all quotas. */
export function useNugQuota(
	resolvedModel: string | undefined,
	nugProviders: NugProviderSetting[] | undefined,
	enabled = true,
): NugProviderInfo | null {
	const token = useSyncExternalStore(onTokenChange, getToken, getToken);
	const qc = useQueryClient();
	const provider = useMemo(() => {
		const prefix = resolvedModel?.split(":")[0];
		return prefix
			? nugProviders?.find((p) => !p.disabled && (p.prefix === prefix || p.id === prefix))
			: undefined;
	}, [resolvedModel, nugProviders]);
	const { data: quota } = useQuery({
		queryKey: nugQuotaKey(provider?.id, provider?.generation, token),
		queryFn: async ({ signal }) => {
			if (getToken() !== token) throw new DOMException("Session changed", "AbortError");
			try {
				const result = await api.nugGetCachedQuota(provider?.id ?? "", {
					signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
					expectedGeneration: provider?.generation,
				});
				if (getToken() !== token) throw new DOMException("Session changed", "AbortError");
				if (String(result.generation) !== String(provider?.generation))
					throw new ApiError("Model runtime generation changed", 409, {
						code: "MODEL_RUNTIME_STALE",
					});
				return result.quota;
			} catch (error) {
				if (
					getToken() === token &&
					error instanceof ApiError &&
					error.status === 409 &&
					error.data?.code === "MODEL_RUNTIME_STALE"
				) {
					void qc.invalidateQueries({ queryKey: ["settings-runtime"] });
					void qc.invalidateQueries({ queryKey: ["model-catalog", "runtime"] });
				}
				throw error;
			}
		},
		enabled:
			!REMOTE_BUILD && enabled && !!token && !!provider?.id && provider.generation !== undefined,
		retry: false,
		staleTime: 30_000,
		gcTime: 60_000,
	});
	if (REMOTE_BUILD || !enabled || !provider) return null;
	return {
		providerId: provider.id,
		providerPrefix: provider.prefix,
		name: provider.name ?? provider.prefix ?? provider.id,
		quotaBalance: quota?.balance == null ? null : String(quota.balance),
		totalGranted: quota?.totalGranted ?? null,
		detailedQuotaBalance: quota?.detailedQuotaBalance?.trim() || null,
	};
}
