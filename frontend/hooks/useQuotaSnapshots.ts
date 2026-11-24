import { REMOTE_BUILD } from "@frontend/lib/build-target";
import type { QuotaSnapshotEntry, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import {
	type QueryClient,
	queryOptions,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import type { QuotaSnapshotRefreshTarget } from "../lib/api/quota-snapshots";

export const quotaSnapshotsKey = ["quota-snapshots"] as const;

interface QuotaClientState {
	epoch: number;
	controllers: Set<AbortController>;
	cliReaders: Set<symbol>;
	cliAttempted: boolean;
	cliGeneration?: string;
	cliFreshUntil?: number;
	cliController?: AbortController;
}
const clientStates = new WeakMap<QueryClient, QuotaClientState>();
function quotaClientState(client: QueryClient): QuotaClientState {
	let state = clientStates.get(client);
	if (!state) {
		state = { epoch: 0, controllers: new Set(), cliReaders: new Set(), cliAttempted: false };
		clientStates.set(client, state);
	}
	return state;
}

function advanceQuotaIdentity(state: QuotaClientState) {
	state.epoch += 1;
	state.cliAttempted = false;
	state.cliGeneration = undefined;
	state.cliFreshUntil = 0;
	state.cliController = undefined;
	for (const controller of state.controllers) controller.abort();
	state.controllers.clear();
}

/** Every authoritative response can discover an external CLI identity change. */
function observeQuotaIdentity(client: QueryClient, incoming: QuotaSnapshotsResponse) {
	const previous = client.getQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey);
	const generations = (data: QuotaSnapshotsResponse | undefined) =>
		new Map(
			(data?.entries ?? [])
				.filter((entry) => entry.refreshOnRead && entry.generation)
				.map((entry) => [entry.groupId, entry.generation]),
		);
	const before = generations(previous);
	const after = generations(incoming);
	if (
		before.size !== after.size ||
		[...before].some(([groupId, generation]) => after.get(groupId) !== generation)
	) {
		advanceQuotaIdentity(quotaClientState(client));
	}
}

/** Credential edits invalidate every in-flight reader and refresh, not just the GET. */
export async function invalidateQuotaSnapshots(client: QueryClient): Promise<void> {
	advanceQuotaIdentity(quotaClientState(client));
	await client.cancelQueries({ queryKey: quotaSnapshotsKey });
	client.setQueryData<QuotaSnapshotsResponse>(quotaSnapshotsKey, { entries: [] });
	await client.invalidateQueries({ queryKey: quotaSnapshotsKey });
}

/** A probe's known validity deadline is authoritative even without numbers; otherwise use data. */
export function selectQuotaEntries(entries: QuotaSnapshotEntry[]): QuotaSnapshotEntry[] {
	const selected = new Map<string, QuotaSnapshotEntry>();
	for (const entry of entries) {
		const key = JSON.stringify([entry.groupId, entry.credentialId]);
		const previous = selected.get(key);
		const hasData = (value: QuotaSnapshotEntry) =>
			!!value.snapshot &&
			(Number.isFinite(value.snapshot.expiresAt) ||
				value.snapshot.windows.some(
					(window) => window.usedRatio != null && Number.isFinite(window.usedRatio),
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
	return [...selected.values()];
}

/** Keep only an authenticated CLI identity's ephemeral value, never deleted credentials. */
export function retainCommandCodeCliSnapshots(
	previous: QuotaSnapshotsResponse | undefined,
	incoming: QuotaSnapshotsResponse,
): QuotaSnapshotsResponse {
	return {
		entries: incoming.entries.map((entry) => {
			if (!entry.refreshOnRead || !entry.generation || entry.snapshot) return entry;
			const cached = previous?.entries.find(
				(old) =>
					old.refreshOnRead &&
					old.generation === entry.generation &&
					old.groupId === entry.groupId &&
					old.credentialId === entry.credentialId &&
					(old.source ?? "probe") === (entry.source ?? "probe"),
			);
			return cached?.snapshot ? { ...entry, snapshot: cached.snapshot } : entry;
		}),
	};
}

function acceptQuotaSnapshots(
	client: QueryClient,
	incoming: QuotaSnapshotsResponse,
): QuotaSnapshotsResponse {
	observeQuotaIdentity(client, incoming);
	const state = quotaClientState(client);
	const completed = incoming.entries.find(
		(entry) =>
			entry.templateId === "command-code" &&
			entry.refreshOnRead &&
			entry.snapshot &&
			!entry.snapshot.error &&
			!entry.snapshot.hasError,
	);
	if (completed) {
		// A real successful probe (automatic or manual) recovers a failed active reader.
		// A GET merely retaining an old snapshot must not extend this freshness deadline.
		state.cliAttempted = false;
		state.cliGeneration = completed.generation;
		state.cliFreshUntil = Date.now() + 60_000;
	}
	return retainCommandCodeCliSnapshots(client.getQueryData(quotaSnapshotsKey), incoming);
}

export function quotaSnapshotsOptions(enabled = true, client?: QueryClient) {
	return queryOptions({
		queryKey: quotaSnapshotsKey,
		queryFn: async ({ signal }) => {
			const state = client ? quotaClientState(client) : undefined;
			const epoch = state?.epoch;
			const data = await api.quotaSnapshots({ signal });
			if (state && state.epoch !== epoch)
				throw new DOMException("Quota identity changed", "AbortError");
			return client ? acceptQuotaSnapshots(client, data) : data;
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
	return useQuery(quotaSnapshotsOptions(enabled, useQueryClient()));
}

export function useQuotaSnapshot(
	groupId: string | null | undefined,
	credentialId?: string | null,
	enabled = true,
) {
	return useQuery({
		...quotaSnapshotsOptions(enabled && !!groupId, useQueryClient()),
		select: (data) =>
			selectQuotaEntries(data.entries).find(
				(entry) =>
					entry.groupId === groupId &&
					(credentialId === undefined || entry.credentialId === credentialId),
			)?.snapshot ?? null,
	});
}

/** Explicitly opt into the nonpersistent Command Code CLI probe on an active surface. */
export function useCommandCodeCliQuota(enabled: boolean) {
	const client = useQueryClient();
	const state = quotaClientState(client);
	const reader = useRef(Symbol("command-code-cli"));
	const query = useQuotaSnapshots(enabled);
	useEffect(() => {
		if (!enabled || REMOTE_BUILD) return;
		const id = reader.current;
		state.cliReaders.add(id);
		return () => {
			state.cliReaders.delete(id);
			queueMicrotask(() => {
				// StrictMode effect replay is still one activation, not a second probe.
				if (state.cliReaders.size > 0) return;
				state.cliController?.abort();
				state.cliController = undefined;
				state.cliAttempted = false;
			});
		};
	}, [enabled, state]);
	useEffect(() => {
		if (REMOTE_BUILD || !enabled) return;
		void query.dataUpdatedAt; // A structurally equal GET still advances the CLI refresh clock.
		const cli = query.data?.entries.find(
			(entry) => entry.templateId === "command-code" && entry.refreshOnRead,
		);
		if (!cli) return;
		const sameGeneration = state.cliGeneration === cli.generation;
		const freshUntil = Math.max(
			sameGeneration ? (state.cliFreshUntil ?? 0) : 0,
			(cli.snapshot?.fetchedAt ?? 0) + 60_000,
		);
		if (cli.snapshot && Date.now() < freshUntil) return;
		if (sameGeneration && (state.cliAttempted || state.cliController)) return;
		if (!sameGeneration) state.cliFreshUntil = 0;
		state.cliAttempted = true;
		state.cliGeneration = cli.generation;
		const epoch = state.epoch;
		state.cliController?.abort();
		const controller = new AbortController();
		state.cliController = controller;
		state.controllers.add(controller);
		const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
		void api
			.refreshQuotaSnapshots({ groupId: cli.groupId }, { signal })
			.then(async (data) => {
				if (signal.aborted || state.epoch !== epoch) return;
				await client.cancelQueries({ queryKey: quotaSnapshotsKey });
				if (signal.aborted || state.epoch !== epoch) return;
				client.setQueryData<QuotaSnapshotsResponse>(
					quotaSnapshotsKey,
					acceptQuotaSnapshots(client, data),
				);
			})
			.catch(() => {
				// Unknown remains unknown. No retry loop on a failed CLI read.
			})
			.finally(() => {
				state.controllers.delete(controller);
				if (state.cliController === controller) state.cliController = undefined;
			});
	}, [client, enabled, query.data, query.dataUpdatedAt, state]);
}

export function useRefreshQuotaSnapshots(identity?: unknown) {
	const client = useQueryClient();
	const controllers = useRef(new Set<AbortController>());
	const state = quotaClientState(client);
	useEffect(() => {
		// A credential identity change cancels the previous account's refresh.
		void identity;
		const pending = controllers.current;
		return () => {
			for (const controller of pending) {
				controller.abort();
				state.controllers.delete(controller);
			}
			pending.clear();
		};
	}, [identity, state]);
	return useMutation({
		mutationFn: async (target: QuotaSnapshotRefreshTarget = {}) => {
			const controller = new AbortController();
			controllers.current.add(controller);
			state.controllers.add(controller);
			try {
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
				const result = await api.refreshQuotaSnapshots(target, { signal });
				signal.throwIfAborted();
				return result;
			} finally {
				controllers.current.delete(controller);
				state.controllers.delete(controller);
			}
		},
		onMutate: async () => {
			const epoch = state.epoch;
			await client.cancelQueries({ queryKey: quotaSnapshotsKey });
			return { epoch };
		},
		onSuccess: async (data, _target, context) => {
			if (context.epoch !== state.epoch) return;
			await client.cancelQueries({ queryKey: quotaSnapshotsKey });
			if (context.epoch !== state.epoch) return;
			// The server returns the authoritative full list, including explicit CLI results.
			client.setQueryData<QuotaSnapshotsResponse>(
				quotaSnapshotsKey,
				acceptQuotaSnapshots(client, data),
			);
		},
	});
}
