import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type {
	QuotaSnapshotEntry,
	QuotaSnapshotReadScope,
	QuotaSnapshotsResponse,
} from "@shared/quota-snapshot";
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
import { ApiError, getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import type { QuotaSnapshotRefreshTarget } from "../lib/api/quota-snapshots";
import { runtimeSettingsQueryKey } from "./useRuntimeSettings";

/** Shared invalidation prefix; every actual read is partitioned by its auth lifetime. */
export const quotaSnapshotsKey = ["quota-snapshots"] as const;
export const quotaSnapshotsReadKey = (
	scope?: QuotaSnapshotReadScope,
	authGeneration = getAuthSnapshot().generation,
) => [...quotaSnapshotsKey, scope ?? null, authGeneration] as const;

/** Framework de-duplication coalesces a burst; an in-flight pre-marker read gets one fresh tail. */
export async function invalidateQuotaSnapshotRead(
	client: QueryClient,
	scope?: QuotaSnapshotReadScope,
	authGeneration = getAuthSnapshot().generation,
) {
	if (getAuthSnapshot().generation !== authGeneration) return;
	if (scope?.cachedOnly && (!scope.groupId || scope.expectedGeneration === undefined)) return;
	const filter = { queryKey: quotaSnapshotsReadKey(scope, authGeneration), exact: true };
	const reading = client.isFetching(filter) > 0;
	await client.invalidateQueries(filter, { cancelRefetch: false });
	if (reading && getAuthSnapshot().generation === authGeneration)
		await client.invalidateQueries(filter, { cancelRefetch: false });
}
const cliQuotaKey = ["command-code-cli-quota"] as const;
const refreshQuotaKey = ["quota-refresh"] as const;
const quotaEditKey = ["quota-edit-generation"] as const;
const quotaEditGeneration = (client: QueryClient) => client.getQueryData<number>(quotaEditKey) ?? 0;
function advanceQuotaEditGeneration(client: QueryClient) {
	client.setQueryDefaults(quotaEditKey, { gcTime: Infinity });
	client.setQueryData(quotaEditKey, quotaEditGeneration(client) + 1);
}
export const commandCodeCliQuotaKey = (
	entry?: QuotaSnapshotEntry,
	authGeneration = getAuthSnapshot().generation,
) => [...cliQuotaKey, entry?.groupId, entry?.generation, authGeneration] as const;

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
	client.setQueriesData<QuotaSnapshotsResponse>({ queryKey: quotaSnapshotsKey }, { entries: [] });
	await client.invalidateQueries({ queryKey: quotaSnapshotsKey });
	await client.invalidateQueries({ queryKey: cliQuotaKey });
}

/** Only comparable NUG wallet observations may update a probe's authoritative display. */
export function selectQuotaEntries(entries: QuotaSnapshotEntry[]): QuotaSnapshotEntry[] {
	const selected = new Map<string, QuotaSnapshotEntry>();
	const probes = new Map<string, QuotaSnapshotEntry>();
	const streams = new Map<string, QuotaSnapshotEntry>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.groupId, entry.credentialId]);
		if ((entry.source ?? "probe") === "probe") probes.set(key, entry);
		else streams.set(key, entry);
		if (!selected.has(key)) selected.set(key, entry);
	}
	return [...selected].map<QuotaSnapshotEntry>(([key, entry]) => {
		const probe = probes.get(key);
		const stream = streams.get(key);
		if (probe?.supported === false) return probe;
		// A missing probe may use the stream; an observed unknown/error is not missing.
		if (!probe?.snapshot) return stream?.snapshot ? stream : (probe ?? entry);
		if (!stream?.snapshot) return probe;
		const metadata = probe.snapshot;
		const observed = stream.snapshot;
		const balance = metadata.balances[0];
		const reported = observed.balances[0];
		if (
			probe.templateId !== "nug" ||
			stream.templateId !== "nug" ||
			metadata.scope !== "wallet" ||
			observed.scope !== "wallet" ||
			metadata.error ||
			metadata.hasError ||
			observed.error ||
			observed.hasError ||
			metadata.balances.length !== 1 ||
			observed.balances.length !== 1 ||
			!balance ||
			!reported ||
			balance.unit !== reported.unit ||
			balance.unlimited ||
			reported.unlimited ||
			(balance.remaining == null && balance.remainingObservedAt !== null) ||
			(balance.remaining != null && !Number.isFinite(balance.remaining)) ||
			(reported.remaining == null && reported.remainingObservedAt !== null) ||
			(reported.remaining != null && !Number.isFinite(reported.remaining))
		)
			return probe;
		const remainingAt =
			balance.remainingObservedAt === undefined ? metadata.fetchedAt : balance.remainingObservedAt;
		const totalAt =
			balance.totalObservedAt === undefined ? metadata.fetchedAt : balance.totalObservedAt;
		const streamRemainingAt =
			reported.remainingObservedAt === undefined
				? observed.fetchedAt
				: reported.remainingObservedAt;
		const streamTotalAt =
			reported.totalObservedAt === undefined ? observed.fetchedAt : reported.totalObservedAt;
		const newer = (current: number | null, candidate: number | null) =>
			candidate !== null &&
			Number.isFinite(candidate) &&
			candidate >= 0 &&
			(current === null || (Number.isFinite(current) && current >= 0 && candidate > current));
		const updateRemaining =
			reported.remaining != null &&
			Number.isFinite(reported.remaining) &&
			newer(remainingAt, streamRemainingAt);
		const updateTotal =
			reported.total !== undefined &&
			Number.isFinite(reported.total) &&
			newer(totalAt, streamTotalAt);
		if (!updateRemaining && !updateTotal) return probe;
		return {
			...probe,
			source: "quota_balance",
			snapshot: {
				...metadata,
				fetchedAt: Math.max(metadata.fetchedAt, observed.fetchedAt),
				balances: [
					{
						...balance,
						...(updateRemaining ? { remaining: reported.remaining } : {}),
						...(updateTotal ? { total: reported.total } : {}),
						remainingObservedAt: updateRemaining ? streamRemainingAt : remainingAt,
						totalObservedAt: updateTotal ? streamTotalAt : totalAt,
					},
				],
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

export function quotaSnapshotsOptions(
	enabled = true,
	client?: QueryClient,
	scope?: QuotaSnapshotReadScope,
) {
	const authGeneration = getAuthSnapshot().generation;
	const queryKey = quotaSnapshotsReadKey(scope, authGeneration);
	return queryOptions({
		queryKey,
		queryFn: async ({ signal }) => {
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Session changed", "AbortError");
			let data: QuotaSnapshotsResponse;
			try {
				data = await api.quotaSnapshots({ ...scope, signal });
			} catch (error) {
				if (
					scope &&
					client &&
					getAuthSnapshot().generation === authGeneration &&
					error instanceof ApiError &&
					error.status === 409 &&
					error.data?.code === "MODEL_RUNTIME_STALE"
				) {
					void client.invalidateQueries({
						queryKey: runtimeSettingsQueryKey(authGeneration),
						exact: true,
					});
					void client.invalidateQueries({
						queryKey: ["model-catalog", "runtime", authGeneration],
					});
				}
				throw error;
			}
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Session changed", "AbortError");
			signal.throwIfAborted();
			if (!scope && client && cliIdentity(client.getQueryData(queryKey)) !== cliIdentity(data)) {
				advanceQuotaEditGeneration(client);
				await client.cancelQueries({ queryKey: refreshQuotaKey });
				if (getAuthSnapshot().generation !== authGeneration)
					throw new DOMException("Session changed", "AbortError");
				await client.cancelQueries({
					queryKey: cliQuotaKey,
					predicate: (query) =>
						query.queryKey[3] === authGeneration &&
						query.queryKey[2] !== cliEntry(data)?.generation,
				});
			}
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Session changed", "AbortError");
			return data;
		},
		enabled: !REMOTE_BUILD && enabled,
		staleTime: 30_000,
		refetchInterval: (query) => {
			if (REMOTE_BUILD || !enabled || scope?.cachedOnly) return false;
			return query.state.data?.entries.some((entry) => entry.refreshing) ? 3_000 : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
}

export function useQuotaSnapshots(enabled = true, scope?: QuotaSnapshotReadScope) {
	const client = useQueryClient();
	const { generation: authGeneration } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	const query = useQuery(quotaSnapshotsOptions(enabled, client, scope));
	const cli = cliEntry(query.data);
	// Subscribe to data, not as a Query observer: passive displays must not retain a probe.
	const subscribe = useCallback(
		(onChange: () => void) => client.getQueryCache().subscribe(onChange),
		[client],
	);
	const read = () =>
		client.getQueryData<QuotaSnapshotEntry>(commandCodeCliQuotaKey(cli, authGeneration));
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
	const { generation: authGeneration } = useSyncExternalStore(
		subscribeAuth,
		getAuthSnapshot,
		getAuthSnapshot,
	);
	const query = useQuery(quotaSnapshotsOptions(enabled, client));
	const cli = cliEntry(query.data);
	const groupId = cli?.groupId;
	const generation = cli?.generation;
	useEffect(() => {
		if (REMOTE_BUILD || !enabled || !groupId || !generation) return;
		const observer = new QueryObserver(client, {
			queryKey: [...cliQuotaKey, groupId, generation, authGeneration],
			queryFn: async ({ signal: querySignal }) => {
				if (getAuthSnapshot().generation !== authGeneration)
					throw new DOMException("Session changed", "AbortError");
				const signal = AbortSignal.any([querySignal, AbortSignal.timeout(20_000)]);
				const response = await api.refreshQuotaSnapshots({ groupId }, { signal });
				signal.throwIfAborted();
				if (getAuthSnapshot().generation !== authGeneration)
					throw new DOMException("Session changed", "AbortError");
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
	}, [client, enabled, groupId, generation, authGeneration]);
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
			const authGeneration = getAuthSnapshot().generation;
			const queryKey = [...refreshQuotaKey, target.groupId, target.credentialId, authGeneration];
			await client.cancelQueries({ queryKey });
			if (getAuthSnapshot().generation !== authGeneration)
				throw new DOMException("Session changed", "AbortError");
			return client.fetchQuery({
				queryKey,
				meta: { quotaRefreshOwner: owner },
				queryFn: async ({ signal: querySignal }) => {
					const signal = AbortSignal.any([querySignal, AbortSignal.timeout(60_000)]);
					const data = await api.refreshQuotaSnapshots(target, { signal });
					signal.throwIfAborted();
					if (getAuthSnapshot().generation !== authGeneration)
						throw new DOMException("Session changed", "AbortError");
					return data;
				},
				staleTime: 0,
				gcTime: 0,
				retry: false,
			});
		},
		onMutate: async () => {
			// Capture before awaiting: either the credential or the session may change meanwhile.
			const generation = quotaEditGeneration(client);
			const session = getAuthSnapshot().generation;
			await client.cancelQueries({
				queryKey: quotaSnapshotsReadKey(undefined, session),
				exact: true,
			});
			return { generation, session };
		},
		onSuccess: async (data, _target, context) => {
			// Ordinary GET updates are not credential edits and must not discard a real refresh.
			if (
				context.session !== getAuthSnapshot().generation ||
				context.generation !== quotaEditGeneration(client)
			)
				return;
			const queryKey = quotaSnapshotsReadKey(undefined, context.session);
			await client.cancelQueries({ queryKey, exact: true });
			if (
				context.session !== getAuthSnapshot().generation ||
				context.generation !== quotaEditGeneration(client)
			)
				return;
			const cli = cliEntry(data);
			if (cli?.snapshot) {
				await client.cancelQueries({ queryKey: commandCodeCliQuotaKey(cli, context.session) });
				if (
					context.session !== getAuthSnapshot().generation ||
					context.generation !== quotaEditGeneration(client)
				)
					return;
				client.setQueryData(commandCodeCliQuotaKey(cli, context.session), cli);
			}
			if (cliIdentity(client.getQueryData(queryKey)) !== cliIdentity(data))
				advanceQuotaEditGeneration(client);
			client.setQueryData<QuotaSnapshotsResponse>(queryKey, {
				entries: data.entries.map((entry) =>
					entry.refreshOnRead ? { ...entry, snapshot: null } : entry,
				),
			});
			// Scoped readers re-read their cached projection with their own generation guard.
			void client.invalidateQueries({
				queryKey: quotaSnapshotsKey,
				predicate: (query) => query.queryKey[1] != null && query.queryKey[2] === context.session,
			});
		},
	});
}
