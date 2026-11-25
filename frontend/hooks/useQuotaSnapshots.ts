import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { QuotaSnapshotEntry, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import {
	type QueryClient,
	QueryObserver,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import type { QuotaSnapshotRefreshTarget } from "../lib/api/quota-snapshots";

export const quotaSnapshotsKey = ["quota-snapshots"] as const;
const cliQuotaKey = ["command-code-cli-quota"] as const;
const refreshQuotaKey = ["quota-refresh"] as const;
const quotaEditKey = ["quota-edit-generation"] as const;
const quotaEditGeneration = (client: QueryClient) => client.getQueryData<number>(quotaEditKey) ?? 0;
function advanceQuotaEditGeneration(client: QueryClient) {
	client.setQueryDefaults(quotaEditKey, { gcTime: Infinity });
	client.setQueryData(quotaEditKey, quotaEditGeneration(client) + 1);
}
export const commandCodeCliQuotaKey = (entry?: QuotaSnapshotEntry) =>
	[...cliQuotaKey, entry?.groupId, entry?.generation] as const;

function cliEntry(data?: QuotaSnapshotsResponse) {
	return data?.entries.find(
		(entry) => entry.templateId === "command-code" && entry.refreshOnRead && entry.generation,
	);
}
function cliIdentity(data?: QuotaSnapshotsResponse) {
	const entry = cliEntry(data);
	return JSON.stringify([entry?.groupId, entry?.generation]);
}

/** Credential edits cancel framework-owned GET, ephemeral and manual requests together. */
export async function invalidateQuotaSnapshots(client: QueryClient): Promise<void> {
	advanceQuotaEditGeneration(client);
	await Promise.all(
		[quotaSnapshotsKey, cliQuotaKey, refreshQuotaKey].map((queryKey) =>
			client.cancelQueries({ queryKey }),
		),
	);
	client.removeQueries({ queryKey: cliQuotaKey, type: "inactive" });
	client.setQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey, { entries: [] });
	await client.invalidateQueries({ queryKey: quotaSnapshotsKey });
	await client.invalidateQueries({ queryKey: cliQuotaKey });
}

/** Select numerical data per credential, retaining the direct probe's validity and window metadata. */
export function selectQuotaEntries(entries: QuotaSnapshotEntry[]): QuotaSnapshotEntry[] {
	const selected = new Map<string, QuotaSnapshotEntry>();
	const probes = new Map<string, QuotaSnapshotEntry>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.groupId, entry.credentialId]);
		if ((entry.source ?? "probe") === "probe") probes.set(key, entry);
		const previous = selected.get(key);
		const hasData = (value: QuotaSnapshotEntry) =>
			!!value.snapshot &&
			(value.snapshot.windows.some((window) =>
				[window.usedRatio, window.used, window.total, window.remaining].some(Number.isFinite),
			) ||
				value.snapshot.balances.some(
					(balance) =>
						balance.unlimited || (balance.remaining != null && Number.isFinite(balance.remaining)),
				));
		if (
			!previous ||
			((entry.source ?? "probe") === "probe" && hasData(entry)) ||
			(!((previous.source ?? "probe") === "probe" && hasData(previous)) && hasData(entry))
		) {
			selected.set(key, entry);
		}
	}
	return [...selected].map(([key, entry]) => {
		const probe = probes.get(key);
		if (entry.source !== "quota_balance" || !entry.snapshot || !probe?.snapshot) return entry;
		const metadata = probe.snapshot;
		return {
			...entry,
			...(probe.primary !== undefined ? { primary: probe.primary } : {}),
			snapshot: {
				...entry.snapshot,
				scope: metadata.scope,
				...(Number.isFinite(metadata.expiresAt) ? { expiresAt: metadata.expiresAt } : {}),
				...(metadata.plan ? { plan: metadata.plan } : {}),
				...(metadata.windows.length ? { windows: metadata.windows } : {}),
				...(metadata.error ? { error: metadata.error } : {}),
				...(metadata.hasError ? { hasError: true } : {}),
			},
		};
	});
}

/** Pure display projection: CLI values never enter the authoritative GET cache. */
export function mergeCommandCodeCliQuota(
	incoming: QuotaSnapshotsResponse,
	cli: QuotaSnapshotEntry | undefined,
): QuotaSnapshotsResponse {
	return {
		entries: incoming.entries.map((entry) =>
			entry.refreshOnRead &&
			entry.generation &&
			entry.groupId === cli?.groupId &&
			entry.generation === cli.generation &&
			entry.credentialId === cli.credentialId
				? { ...entry, snapshot: cli.snapshot }
				: entry,
		),
	};
}

export function quotaSnapshotsOptions(enabled = true, client?: QueryClient) {
	return queryOptions({
		queryKey: quotaSnapshotsKey,
		queryFn: async ({ signal }) => {
			const data = await api.quotaSnapshots({ signal });
			signal.throwIfAborted();
			if (client && cliIdentity(client.getQueryData(quotaSnapshotsKey)) !== cliIdentity(data)) {
				advanceQuotaEditGeneration(client);
				await client.cancelQueries({ queryKey: refreshQuotaKey });
				await client.cancelQueries({
					queryKey: cliQuotaKey,
					predicate: (query) => query.queryKey[2] !== cliEntry(data)?.generation,
				});
			}
			return data;
		},
		enabled: !REMOTE_BUILD && enabled,
		staleTime: 30_000,
		refetchInterval: (query) => {
			if (REMOTE_BUILD || !enabled) return false;
			return query.state.data?.entries.some((entry) => entry.refreshing) ? 3_000 : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}

export function useQuotaSnapshots(enabled = true) {
	const client = useQueryClient();
	const query = useQuery(quotaSnapshotsOptions(enabled, client));
	const cli = cliEntry(query.data);
	// Subscribe to data, not as a Query observer: passive displays must not retain a probe.
	const subscribe = useCallback(
		(onChange: () => void) => client.getQueryCache().subscribe(onChange),
		[client],
	);
	const read = () => client.getQueryData<QuotaSnapshotEntry>(commandCodeCliQuotaKey(cli));
	const ephemeral = useSyncExternalStore(subscribe, read, read);
	const data = useMemo(
		() => (query.data ? mergeCommandCodeCliQuota(query.data, ephemeral) : undefined),
		[query.data, ephemeral],
	);
	return { ...query, data };
}

export function useQuotaSnapshot(
	groupId: string | null | undefined,
	credentialId?: string | null,
	enabled = true,
) {
	const query = useQuotaSnapshots(enabled && !!groupId);
	return {
		...query,
		data: query.data
			? (selectQuotaEntries(query.data.entries).find(
					(entry) =>
						entry.groupId === groupId &&
						(credentialId === undefined || entry.credentialId === credentialId),
				)?.snapshot ?? null)
			: undefined,
	};
}

/** Only active surfaces subscribe as Query observers; the last unsubscribe cancels work. */
export function useCommandCodeCliQuota(enabled: boolean) {
	const client = useQueryClient();
	const query = useQuery(quotaSnapshotsOptions(enabled, client));
	const cli = cliEntry(query.data);
	const groupId = cli?.groupId;
	const generation = cli?.generation;
	useEffect(() => {
		if (REMOTE_BUILD || !enabled || !groupId || !generation) return;
		const observer = new QueryObserver(client, {
			queryKey: [...cliQuotaKey, groupId, generation],
			queryFn: async ({ signal: querySignal }) => {
				const signal = AbortSignal.any([querySignal, AbortSignal.timeout(20_000)]);
				const response = await api.refreshQuotaSnapshots({ groupId }, { signal });
				signal.throwIfAborted();
				return (
					response.entries.find(
						(entry) => entry.groupId === groupId && entry.generation === generation,
					) ?? null
				);
			},
			staleTime: 60_000,
			refetchInterval: (state) =>
				state.state.status === "error" ||
				state.state.data?.snapshot?.error ||
				state.state.data?.snapshot?.hasError
					? false
					: 60_000,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
			retry: false,
		});
		return observer.subscribe(() => {});
	}, [client, enabled, groupId, generation]);
}

export function useRefreshQuotaSnapshots(identity?: unknown) {
	const client = useQueryClient();
	const owner = useId();
	useEffect(() => {
		void identity;
		return () => {
			void client.cancelQueries({
				queryKey: refreshQuotaKey,
				predicate: (query) => query.meta?.quotaRefreshOwner === owner,
			});
		};
	}, [client, identity, owner]);
	return useMutation({
		mutationFn: async (target: QuotaSnapshotRefreshTarget = {}) => {
			const queryKey = [...refreshQuotaKey, target.groupId, target.credentialId];
			await client.cancelQueries({ queryKey });
			return client.fetchQuery({
				queryKey,
				meta: { quotaRefreshOwner: owner },
				queryFn: async ({ signal: querySignal }) => {
					const signal = AbortSignal.any([querySignal, AbortSignal.timeout(60_000)]);
					const data = await api.refreshQuotaSnapshots(target, { signal });
					signal.throwIfAborted();
					return data;
				},
				staleTime: 0,
				gcTime: 0,
				retry: false,
			});
		},
		onMutate: async () => {
			// Capture before awaiting: an edit can happen between cancellation and query startup.
			const generation = quotaEditGeneration(client);
			await client.cancelQueries({ queryKey: quotaSnapshotsKey });
			return { generation };
		},
		onSuccess: async (data, _target, context) => {
			// Ordinary GET updates are not credential edits and must not discard a real refresh.
			if (context.generation !== quotaEditGeneration(client)) return;
			await client.cancelQueries({ queryKey: quotaSnapshotsKey });
			if (context.generation !== quotaEditGeneration(client)) return;
			const cli = cliEntry(data);
			if (cli?.snapshot) {
				await client.cancelQueries({ queryKey: commandCodeCliQuotaKey(cli) });
				if (context.generation !== quotaEditGeneration(client)) return;
				client.setQueryData(commandCodeCliQuotaKey(cli), cli);
			}
			if (cliIdentity(client.getQueryData(quotaSnapshotsKey)) !== cliIdentity(data))
				advanceQuotaEditGeneration(client);
			client.setQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey, {
				entries: data.entries.map((entry) =>
					entry.refreshOnRead ? { ...entry, snapshot: null } : entry,
				),
			});
		},
	});
}
