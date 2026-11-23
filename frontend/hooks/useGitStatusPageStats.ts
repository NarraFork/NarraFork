import {
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPageCacheState,
	type GitStatusPageStatsResult,
	type GitStatusPageStatsRow,
	normalizeGitStatusFilter,
} from "@shared/git-status-page";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GitChangesPageStatsResult } from "../components/git/git-changes-list-model";
import { api } from "../lib/api";
import type { GitTarget } from "../lib/api/git";
import { readWorkspace, useGitWorkspaceSubscription } from "./useGit";

export interface GitStatusPageStatsSource {
	snapshotId?: string;
	pageGeneration?: string;
	filterKey: string;
	epoch: string;
	workspaceIdentity?: string;
	workerEpoch?: string;
	memberVersion?: number;
	statsVersion?: number;
	updating?: boolean;
}
export const gitStatusPageStatsRowKey = (row: GitStatusPageStatsRow) =>
	JSON.stringify([row.type, row.section, row.path]);
type StatsRow = GitStatusPageStatsResult["rows"][number];
interface PendingRow {
	row: GitStatusPageStatsRow;
	users: number;
	started: boolean;
	promise: Promise<StatsRow>;
	resolve: (value: StatsRow) => void;
	reject: (error: unknown) => void;
}
interface StatsEpoch {
	source: GitStatusPageStatsSource;
	controller: AbortController;
	cache: Map<string, StatsRow>;
	pending: Map<string, PendingRow>;
	queued: Set<string>;
	running: boolean;
	readRefused: boolean;
	paused?: unknown;
	resultCache?: GitStatusPageCacheState;
	onCache: (cache: GitStatusPageCacheState) => void;
	read: <T>(load: () => Promise<T>, signal: AbortSignal) => Promise<T>;
	onExpired: (source: GitStatusPageStatsSource) => void;
	onRefused: (source: GitStatusPageStatsSource, error: Error) => void;
}
class CacheWaiting extends Error {}
const expiredSnapshot = (error: unknown) =>
	((error as { data?: { code?: string }; code?: string } | null)?.data?.code ??
		(error as { code?: string } | null)?.code) === "GIT_STATUS_PAGE_EXPIRED";

function createStatsEpoch(
	source: GitStatusPageStatsSource,
	onExpired: StatsEpoch["onExpired"],
	onRefused: StatsEpoch["onRefused"],
	onCache: StatsEpoch["onCache"],
	read: StatsEpoch["read"],
): StatsEpoch {
	const epoch: StatsEpoch = {
		source,
		controller: new AbortController(),
		cache: new Map(),
		pending: new Map(),
		queued: new Set(),
		running: false,
		readRefused: false,
		onExpired,
		onRefused,
		onCache,
		read,
	};
	epoch.controller.signal.addEventListener(
		"abort",
		() => {
			for (const pending of epoch.pending.values()) pending.reject(epoch.controller.signal.reason);
			epoch.pending.clear();
			epoch.queued.clear();
		},
		{ once: true },
	);
	return epoch;
}

/** Requests belong to the observation epoch; overlapping viewport observers share their work. */
async function drainStatsEpoch(
	epoch: StatsEpoch,
	target: GitTarget,
	filter: GitStatusFilterChar[],
) {
	const { signal } = epoch.controller;
	try {
		while (epoch.queued.size && !signal.aborted) {
			const batch: PendingRow[] = [];
			for (const key of epoch.queued) {
				epoch.queued.delete(key);
				const pending = epoch.pending.get(key);
				if (pending && pending.users > 0) {
					pending.started = true;
					batch.push(pending);
				}
				if (batch.length === GIT_STATUS_PAGE_MAX_LIMIT) break;
			}
			if (!batch.length) continue;
			try {
				const result = await epoch.read(
					() =>
						api.getGitStatusPageStats(
							target,
							{
								snapshotId: epoch.source.snapshotId as string,
								filter,
								rows: batch.map(({ row }) => row),
							},
							signal,
						),
					signal,
				);
				signal.throwIfAborted();
				if (result.status === "error")
					throw Object.assign(new Error(result.cache.message ?? "Git statistics unavailable"), {
						code: result.cache.errorCode,
					});
				if (
					result.status !== "ready" ||
					(epoch.source.workerEpoch !== undefined &&
						(result.cache.workerEpoch !== epoch.source.workerEpoch ||
							result.cache.memberVersion !== epoch.source.memberVersion ||
							result.cache.statsVersion !== epoch.source.statsVersion))
				) {
					epoch.onCache(result.cache);
					throw new CacheWaiting("Waiting for published Git statistics");
				}
				if (result.snapshotId !== epoch.source.snapshotId)
					throw new Error("Git statistics snapshot changed");
				epoch.resultCache = result.cache;
				const measured = new Map(result.rows.map((row) => [gitStatusPageStatsRowKey(row), row]));
				for (const pending of batch) {
					const key = gitStatusPageStatsRowKey(pending.row);
					const row = measured.get(key) ?? { ...pending.row, complete: false };
					epoch.cache.set(key, row);
					epoch.pending.delete(key);
					pending.resolve(row);
				}
			} catch (error) {
				if (signal.aborted) return;
				if ([401, 403, 404].includes((error as { status?: number } | null)?.status ?? 0)) {
					epoch.readRefused = true;
					epoch.onRefused(epoch.source, error instanceof Error ? error : new Error(String(error)));
					for (const pending of epoch.pending.values()) pending.reject(error);
					epoch.pending.clear();
					epoch.queued.clear();
					return;
				}
				if (error instanceof CacheWaiting || expiredSnapshot(error)) {
					epoch.paused = error;
					// Pending and version transitions never become measured unknown rows.
					// Snapshot expiry is a page-chain recovery event, not a measured unknown row.
					for (const pending of epoch.pending.values()) pending.reject(error);
					epoch.pending.clear();
					epoch.queued.clear();
					if (expiredSnapshot(error)) epoch.onExpired(epoch.source);
					return;
				}
				for (const pending of batch) {
					const key = gitStatusPageStatsRowKey(pending.row);
					epoch.cache.set(key, { ...pending.row, complete: false });
					epoch.pending.delete(key);
					pending.reject(error);
				}
			}
		}
	} finally {
		epoch.running = false;
	}
}

function readEpochRows(
	epoch: StatsEpoch,
	target: GitTarget,
	rows: GitStatusPageStatsRow[],
	filter: GitStatusFilterChar[],
	signal: AbortSignal,
) {
	epoch.controller.signal.throwIfAborted();
	signal.throwIfAborted();
	if (epoch.paused) return Promise.reject(epoch.paused);
	const demand: PendingRow[] = [];
	const result = Promise.all(
		rows.map((row) => {
			const key = gitStatusPageStatsRowKey(row);
			const cached = epoch.cache.get(key);
			if (cached) return Promise.resolve(cached);
			const pending = epoch.pending.get(key);
			if (pending) {
				pending.users++;
				demand.push(pending);
				return pending.promise;
			}
			let resolve!: PendingRow["resolve"];
			let reject!: PendingRow["reject"];
			const promise = new Promise<StatsRow>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const created = { row, users: 1, started: false, promise, resolve, reject };
			epoch.pending.set(key, created);
			epoch.queued.add(key);
			demand.push(created);
			return promise;
		}),
	);
	if (epoch.queued.size && !epoch.running) {
		epoch.running = true;
		queueMicrotask(() => void drainStatsEpoch(epoch, target, filter));
	}
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		for (const pending of demand) {
			pending.users--;
			const key = gitStatusPageStatsRowKey(pending.row);
			if (!pending.users && !pending.started && epoch.pending.get(key) === pending) {
				epoch.pending.delete(key);
				epoch.queued.delete(key);
				pending.reject(new DOMException("Cancelled", "AbortError"));
			}
		}
	};
	return new Promise<StatsRow[]>((resolve, reject) => {
		const cleanup = () => {
			signal.removeEventListener("abort", onAbort);
			release();
		};
		const onAbort = () => {
			cleanup();
			reject(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		result.then(
			(measured) => {
				cleanup();
				resolve(measured);
			},
			(error) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Viewport statistics have their own observation lifetime, not the bounded WS projection. */
export function useGitStatusPageStats(
	target: GitTarget | null | undefined,
	snapshotId: string | undefined,
	selectedFilter: readonly GitStatusFilterChar[] | ReadonlySet<GitStatusFilterChar>,
	visibleRows: readonly ({ type: string } | GitStatusPageStatsRow)[],
	options: {
		generation?: string;
		cache?: GitStatusPageCacheState;
		enabled?: boolean;
		onSnapshotObservation?: (observation: {
			snapshotId: string;
			generation: string;
			expired: boolean;
		}) => void;
	} = {},
) {
	const qc = useQueryClient();
	const owner = useId();
	const principal = qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
	const enabled = options.enabled !== false && !!target;
	const subscriptions = useGitWorkspaceSubscription(enabled ? target : null);
	const denied = !!target && subscriptions.isDenied(target);
	const observedCache = target ? subscriptions.getStatusPageState(target) : undefined;
	const updating = !!target && subscriptions.isStatusPageUpdating(target);
	const pageCache = options.cache;
	const cache =
		observedCache &&
		(!pageCache ||
			(observedCache.workerEpoch === pageCache.workerEpoch &&
				observedCache.memberVersion === pageCache.memberVersion &&
				observedCache.statsVersion >= pageCache.statsVersion))
			? observedCache
			: pageCache;
	const connected = !!target && subscriptions.isPush(target);
	const readable = !!target && subscriptions.canRead(target);
	const authorizationKey = target ? subscriptions.getAuthorizationKey(target) : undefined;
	const active = enabled && !!snapshotId && readable && connected && subscriptions.isVisible();
	const cacheReady = !cache || cache.statsVersion > 0;
	const workspaceIdentity = JSON.stringify([
		target?.workspaceKey,
		target?.narratorId,
		target?.repositoryKey,
		target?.rootPath,
		principal,
	]);
	const filterKey = normalizeGitStatusFilter([...selectedFilter]).join(",");
	const pageGeneration = options.generation;
	const onSnapshotObservation = options.onSnapshotObservation;
	const observationCallback = useRef(onSnapshotObservation);
	observationCallback.current = onSnapshotObservation;
	const currentTarget = useRef(target);
	currentTarget.current = target;
	const activeEpoch = useRef<StatsEpoch | null>(null);
	const [refusal, setRefusal] = useState<{ epoch: string; error: Error } | null>(null);
	const scope = JSON.stringify([
		target?.workspaceKey,
		target?.narratorId,
		target?.repositoryKey,
		target?.rootPath,
		snapshotId,
		pageGeneration,
		filterKey,
		active,
		principal,
		cache?.workerEpoch,
		cache?.memberVersion,
		cache?.statsVersion,
		authorizationKey,
	]);
	const [generation, setGeneration] = useState(0);
	const sequence = useRef(0);
	const epoch = useMemo(() => {
		const authorized = currentTarget.current
			? subscriptions.getWriteResultGuard(currentTarget.current)
			: () => false;
		const target = currentTarget.current;
		const publish = currentTarget.current
			? subscriptions.statusPageReadPublisher(currentTarget.current)
			: () => false;
		return createStatsEpoch(
			{
				snapshotId,
				pageGeneration,
				filterKey,
				workspaceIdentity,
				workerEpoch: cache?.workerEpoch,
				memberVersion: cache?.memberVersion,
				statsVersion: cache?.statsVersion,
				epoch: JSON.stringify([scope, generation, owner, ++sequence.current]),
			},
			(source) => {
				const current = activeEpoch.current;
				if (
					!current ||
					current.source.epoch !== source.epoch ||
					current.controller.signal.aborted ||
					!source.snapshotId ||
					!source.pageGeneration
				)
					return;
				observationCallback.current?.({
					snapshotId: source.snapshotId,
					generation: source.pageGeneration,
					expired: true,
				});
			},
			(source, error) => {
				const current = activeEpoch.current;
				if (current?.source.epoch !== source.epoch || current.controller.signal.aborted) return;
				// A shared batch may finish after its viewport observer was cancelled.
				// Refusal still revokes the entire active epoch, including cached views.
				setRefusal({ epoch: source.epoch, error });
			},
			publish,
			async (load, signal) => {
				if (!target || !authorized())
					throw new DOMException("Git authorization pending", "AbortError");
				const result = await readWorkspace(qc, target, load, false, signal);
				if (!authorized()) throw new DOMException("Git authorization superseded", "AbortError");
				return result;
			},
		);
	}, [
		scope,
		generation,
		owner,
		snapshotId,
		pageGeneration,
		filterKey,
		workspaceIdentity,
		cache?.workerEpoch,
		cache?.memberVersion,
		cache?.statsVersion,
		subscriptions,
		qc,
	]);
	activeEpoch.current = epoch;
	const rowsKey = JSON.stringify(
		visibleRows
			.filter(
				(row): row is GitStatusPageStatsRow => row.type === "file" || row.type === "directory",
			)
			.map(({ type, section, path }) => ({ type, section, path })),
	);
	const rows = useMemo(() => JSON.parse(rowsKey) as GitStatusPageStatsRow[], [rowsKey]);
	const queryKey = useMemo(
		() =>
			[
				"gitStatusPageStats",
				target?.workspaceKey,
				target?.narratorId,
				epoch.source.epoch,
				rowsKey,
			] as const,
		[target?.workspaceKey, target?.narratorId, epoch, rowsKey],
	);
	const restart = useCallback(() => {
		if (epoch.controller.signal.aborted) return;
		epoch.controller.abort();
		void qc.cancelQueries({
			queryKey: ["gitStatusPageStats", target?.workspaceKey, target?.narratorId],
		});
		setGeneration((value) => value + 1);
	}, [epoch, qc, target?.workspaceKey, target?.narratorId]);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }): Promise<GitChangesPageStatsResult> => {
			signal.throwIfAborted();
			const measured = await readEpochRows(
				epoch,
				target as GitTarget,
				rows,
				filterKey ? (filterKey.split(",") as GitStatusFilterChar[]) : [],
				signal,
			);
			// Observer cancellation discards its delivery without cancelling shared epoch requests.
			signal.throwIfAborted();
			epoch.controller.signal.throwIfAborted();
			return {
				snapshotId: snapshotId as string,
				rows: measured,
				cache: epoch.resultCache,
				workspaceIdentity: epoch.source.workspaceIdentity,
				filterKey: epoch.source.filterKey,
			};
		},
		enabled: active && cacheReady && !epoch.readRefused && rows.length > 0,
		staleTime: Infinity,
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: false,
		retry: false,
	});
	useEffect(() => {
		if (epoch.controller.signal.aborted) setGeneration((value) => value + 1);
		return () => {
			epoch.controller.abort();
			void qc.cancelQueries({
				queryKey: [
					"gitStatusPageStats",
					target?.workspaceKey,
					target?.narratorId,
					epoch.source.epoch,
				],
			});
		};
	}, [epoch, qc, target?.workspaceKey, target?.narratorId]);
	useEffect(
		() =>
			qc.getQueryCache().subscribe((event) => {
				if (
					event.type === "updated" &&
					event.action.type === "invalidate" &&
					event.query.queryKey[0] === "gitStatusPageStats" &&
					event.query.queryKey[3] === epoch.source.epoch
				)
					restart();
			}),
		[qc, epoch, restart],
	);
	useEffect(() => {
		if (!active || !snapshotId || !pageGeneration || (!query.data && !expiredSnapshot(query.error)))
			return;
		onSnapshotObservation?.({
			snapshotId,
			generation: pageGeneration,
			expired: expiredSnapshot(query.error),
		});
	}, [active, snapshotId, pageGeneration, query.data, query.error, onSnapshotObservation]);
	const readRefused =
		epoch.readRefused ||
		[401, 403, 404].includes((query.error as { status?: number } | null)?.status ?? 0);
	const displayAllowed =
		enabled && !!target?.workspaceKey && !!target?.narratorId && readable && !readRefused;
	const source = useMemo(
		() => ({ ...epoch.source, updating: updating || !!cache?.updating || !active }),
		[epoch, cache?.updating, active, updating],
	);
	const unavailable = useMemo(
		() =>
			cache?.statsVersion === 0 && cache.statsErrorCode
				? Object.assign(new Error("Git statistics unavailable"), { code: cache.statsErrorCode })
				: null,
		[cache?.statsVersion, cache?.statsErrorCode],
	);
	const waiting = !unavailable && (!cacheReady || query.error instanceof CacheWaiting);
	return {
		source,
		rows,
		data: active && displayAllowed && !waiting ? query.data : undefined,
		error: waiting
			? null
			: (unavailable ??
				query.error ??
				(refusal?.epoch === epoch.source.epoch ? refusal.error : null)),
		displayAllowed,
		readRefused: !readable || denied || readRefused,
		isSettled: !!unavailable || (!waiting && (query.isSuccess || query.isError)),
		isPending: waiting,
		updating: updating || !!cache?.updating || !active,
		retry: () => {
			if (target && !subscriptions.canRead(target)) subscriptions.refresh(target);
			restart();
		},
	};
}
