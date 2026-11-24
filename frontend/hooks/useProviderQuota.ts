import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { ProviderQuotaSnapshot } from "@shared/provider-quota";
import {
	type QueryClient,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../lib/api";
import {
	invalidateProviderQuotaQueries,
	subscribeProviderQuotaEvents,
} from "../lib/provider-quota-events";

export const providerQuotaKey = (providerId: string | null, generation: string | undefined) =>
	["provider-quotas", "provider", providerId, generation] as const;
export const providerQuotaListKey = (generations: Record<string, string>) =>
	[
		"provider-quotas",
		"list",
		Object.entries(generations).sort(([a], [b]) => a.localeCompare(b)),
	] as const;

function invalidateSettings(client: QueryClient) {
	void client.invalidateQueries({ queryKey: ["settings"] });
	void client.invalidateQueries({ queryKey: ["admin", "settings"] });
}

export interface ProviderQuotaCapabilitySettings {
	/** Compatibility projection for the host-owned Custom API quota capability. */
	providerBalanceCapability?: { enabled?: unknown };
}

export function isProviderQuotaCapabilityEnabled(
	settings: ProviderQuotaCapabilitySettings | undefined,
): boolean {
	return !REMOTE_BUILD && settings?.providerBalanceCapability?.enabled !== false;
}

/** The same capability gates the saved quota row and site-account inputs. */
export function useProviderQuotaCapability(): boolean {
	const { data: settings } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		enabled: !REMOTE_BUILD,
		staleTime: 30_000,
	});
	return isProviderQuotaCapabilityEnabled(settings);
}

/** Neither a renamed prefix nor a cached response can redefine an account's identity. */
export function matchesProviderQuotaIdentity(
	snapshot: ProviderQuotaSnapshot | null | undefined,
	providerId: string | null,
	generation: string | undefined,
): snapshot is ProviderQuotaSnapshot {
	return Boolean(
		providerId &&
			generation &&
			snapshot?.providerId === providerId &&
			snapshot.targetId === `custom-api/${providerId}` &&
			snapshot.generation === generation,
	);
}

/** A missing value is authoritative: deterministic errors and expired stale data must stay empty. */
export function reconcileProviderQuotaSnapshot(
	previous: ProviderQuotaSnapshot | null | undefined,
	next: ProviderQuotaSnapshot | null,
): ProviderQuotaSnapshot | null {
	if (
		!next ||
		!matchesProviderQuotaIdentity(previous, next.providerId, next.generation) ||
		previous.keyId !== next.keyId
	)
		return next;
	return previous.version > next.version ? previous : next;
}

export function providerQuotaPollInterval(snapshot: ProviderQuotaSnapshot | null | undefined) {
	if (!snapshot || snapshot.status === "pending" || snapshot.status === "probing") return 2_000;
	// GET observes the host cache, not an unthrottled plugin call. Errors may recover
	// autonomously; unavailable sources recover through lifecycle events/reconnects.
	return snapshot.status === "supported" || snapshot.status === "error" ? 60_000 : false;
}

async function withQuotaDeadline<T>(
	signal: AbortSignal | undefined,
	run: (signal: AbortSignal) => Promise<T>,
) {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(() => controller.abort(), 15_000);
	try {
		return await run(controller.signal);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export function providerQuotaOptions(
	client: QueryClient,
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
) {
	const key = providerQuotaKey(providerId, generation);
	return queryOptions({
		queryKey: key,
		queryFn: ({ signal }) =>
			REMOTE_BUILD
				? Promise.resolve(null)
				: withQuotaDeadline(signal, async (requestSignal) => {
						const page = await api.providerGetQuotas({
							providerId: providerId ?? undefined,
							signal: requestSignal,
						});
						const snapshot = page.snapshots.find((item) => item.providerId === providerId) ?? null;
						if (snapshot && !matchesProviderQuotaIdentity(snapshot, providerId, generation))
							invalidateSettings(client);
						return reconcileProviderQuotaSnapshot(
							client.getQueryData<ProviderQuotaSnapshot | null>(key),
							snapshot,
						);
					}),
		select: (snapshot) =>
			!REMOTE_BUILD && matchesProviderQuotaIdentity(snapshot, providerId, generation)
				? snapshot
				: undefined,
		enabled: !REMOTE_BUILD && enabled && Boolean(providerId && generation),
		staleTime: 30_000,
		gcTime: 60_000,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		retry: false,
		refetchInterval: (query) => {
			if (REMOTE_BUILD || !enabled || !providerId || !generation) return false;
			if (
				query.state.data &&
				!matchesProviderQuotaIdentity(query.state.data, providerId, generation)
			)
				return false;
			return query.state.status === "error" ? 60_000 : providerQuotaPollInterval(query.state.data);
		},
	});
}

export function providerQuotasOptions(
	client: QueryClient,
	generations: Record<string, string>,
	enabled = true,
) {
	const key = providerQuotaListKey(generations);
	return queryOptions({
		queryKey: key,
		queryFn: ({ signal }) =>
			REMOTE_BUILD
				? Promise.resolve<Record<string, ProviderQuotaSnapshot>>({})
				: withQuotaDeadline(signal, async (requestSignal) => {
						const snapshots: Record<string, ProviderQuotaSnapshot> = {};
						const previous = client.getQueryData<Record<string, ProviderQuotaSnapshot>>(key);
						const cursors = new Set<string>();
						let cursor: string | undefined;
						// At least one snapshot fits a host page. Bound the whole scan by the
						// visible settings projection as well as a hard request/response budget.
						const maxPages = Math.min(256, Object.keys(generations).length + 1);
						let totalBytes = 0;
						for (let index = 0; index < maxPages; index++) {
							const page = await api.providerGetQuotas({
								cursor,
								limit: 100,
								signal: requestSignal,
							});
							totalBytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
							if (totalBytes > 4 * 1024 * 1024)
								throw new Error("Quota snapshot byte budget exceeded");
							for (const snapshot of page.snapshots) {
								const generation = generations[snapshot.providerId];
								if (!generation) continue;
								if (!matchesProviderQuotaIdentity(snapshot, snapshot.providerId, generation)) {
									invalidateSettings(client);
									continue;
								}
								snapshots[snapshot.providerId] =
									reconcileProviderQuotaSnapshot(previous?.[snapshot.providerId], snapshot) ??
									snapshot;
							}
							if (!page.nextCursor) return snapshots;
							if (cursors.has(page.nextCursor)) throw new Error("Repeated quota page cursor");
							cursors.add(page.nextCursor);
							cursor = page.nextCursor;
						}
						throw new Error("Quota page budget exceeded");
					}),
		select: (snapshots) =>
			REMOTE_BUILD
				? {}
				: Object.fromEntries(
						Object.entries(snapshots).filter(([providerId, snapshot]) =>
							matchesProviderQuotaIdentity(snapshot, providerId, generations[providerId]),
						),
					),
		enabled: !REMOTE_BUILD && enabled && Object.keys(generations).length > 0,
		staleTime: 30_000,
		gcTime: 60_000,
		retry: false,
		refetchOnWindowFocus: false,
		refetchInterval: (query) => {
			if (REMOTE_BUILD || !enabled || Object.keys(generations).length === 0) return false;
			if (query.state.status === "error") return 60_000;
			const values = Object.values(query.state.data ?? {});
			if (values.some((item) => providerQuotaPollInterval(item) === 2_000)) return 2_000;
			return values.some((item) => providerQuotaPollInterval(item) !== false) ? 60_000 : false;
		},
	});
}

function useQuotaEvents(client: QueryClient, enabled: boolean) {
	useEffect(
		() => (!REMOTE_BUILD && enabled ? subscribeProviderQuotaEvents(client) : undefined),
		[client, enabled],
	);
}

export function useProviderQuota(
	providerId: string | null,
	generation: string | undefined,
	enabled = true,
	capabilityEnabled = true,
) {
	const client = useQueryClient();
	// A visible disabled capability still observes lifecycle hints so reinstall can recover.
	useQuotaEvents(client, enabled && Boolean(providerId && generation));
	return useQuery(
		providerQuotaOptions(client, providerId, generation, enabled && capabilityEnabled),
	);
}

export function useProviderQuotas(
	generations: Record<string, string>,
	enabled = true,
	capabilityEnabled = true,
) {
	const client = useQueryClient();
	useQuotaEvents(client, enabled && Object.keys(generations).length > 0);
	return useQuery(providerQuotasOptions(client, generations, enabled && capabilityEnabled));
}

export function providerQuotaRefreshOptions(
	client: QueryClient,
	providerId: string,
	generation: string | undefined,
	canRefresh: boolean,
) {
	let inFlight: Promise<ProviderQuotaSnapshot> | null = null;
	return {
		mutationFn: async (mode: "probe" | "refresh" = "refresh") => {
			if (REMOTE_BUILD || !canRefresh || !generation) return null;
			if (inFlight) return inFlight;
			inFlight = client
				.cancelQueries({ queryKey: providerQuotaKey(providerId, generation), exact: true })
				.then(() =>
					withQuotaDeadline(undefined, (signal) =>
						api.providerRefreshQuota(providerId, mode, signal),
					),
				);
			try {
				return await inFlight;
			} finally {
				inFlight = null;
			}
		},
		onSuccess: async (snapshot: ProviderQuotaSnapshot | null) => {
			if (REMOTE_BUILD || !snapshot) return;
			if (!matchesProviderQuotaIdentity(snapshot, providerId, generation)) {
				invalidateSettings(client);
				return;
			}
			const key = providerQuotaKey(providerId, generation);
			await client.cancelQueries({ queryKey: key, exact: true });
			client.setQueryData<ProviderQuotaSnapshot | null>(key, (previous) =>
				reconcileProviderQuotaSnapshot(previous, snapshot),
			);
			invalidateProviderQuotaQueries(client, [providerId]);
		},
	};
}

export function useRefreshProviderQuota(
	providerId: string,
	generation: string | undefined,
	canRefresh: boolean,
) {
	const client = useQueryClient();
	const options = useMemo(
		() => providerQuotaRefreshOptions(client, providerId, generation, canRefresh),
		[client, providerId, generation, canRefresh],
	);
	return useMutation(options);
}
