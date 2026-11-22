import {
	GIT_STATUS_PAGE_MAX_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPageStatsResult,
	type GitStatusPageStatsRow,
	normalizeGitStatusFilter,
} from "@shared/git-status-page";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { GitTarget } from "../lib/api/git";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useGitWorkspaceSubscription } from "./useGit";

export interface GitStatusPageStatsSource {
	snapshotId?: string;
	pageGeneration?: string;
	filterKey: string;
	epoch: string;
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
	onExpired: (source: GitStatusPageStatsSource) => void;
	onRefused: (source: GitStatusPageStatsSource, error: Error) => void;
}
const expiredSnapshot = (error: unknown) =>
	((error as { data?: { code?: string }; code?: string } | null)?.data?.code ??
		(error as { code?: string } | null)?.code) === "GIT_STATUS_PAGE_EXPIRED";

function createStatsEpoch(
	source: GitStatusPageStatsSource,
	onExpired: StatsEpoch["onExpired"],
	onRefused: StatsEpoch["onRefused"],
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
				const result = await api.getGitStatusPageStats(
					target,
					{
						snapshotId: epoch.source.snapshotId as string,
						filter,
						rows: batch.map(({ row }) => row),
					},
					signal,
				);
				signal.throwIfAborted();
				if (result.snapshotId !== epoch.source.snapshotId)
					throw new Error("Git statistics snapshot changed");
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
				if (expiredSnapshot(error)) {
					// Snapshot expiry is a page-chain recovery event, not a measured unknown row.
					for (const pending of epoch.pending.values()) pending.reject(error);
					epoch.pending.clear();
					epoch.queued.clear();
					epoch.onExpired(epoch.source);
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
	const enabled = options.enabled !== false && !!target;
	const subscriptions = useGitWorkspaceSubscription(enabled ? target : null);
	const denied = !!target && subscriptions.isDenied(target);
	const active = enabled && !!snapshotId && !denied && subscriptions.isVisible();
	const filterKey = normalizeGitStatusFilter([...selectedFilter]).join(",");
	const pageGeneration = options.generation;
	const onSnapshotObservation = options.onSnapshotObservation;
	const observationCallback = useRef(onSnapshotObservation);
	observationCallback.current = onSnapshotObservation;
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
	]);
	const [generation, setGeneration] = useState(0);
	const sequence = useRef(0);
	const epoch = useMemo(
		() =>
			createStatsEpoch(
				{
					snapshotId,
					pageGeneration,
					filterKey,
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
			),
		[scope, generation, owner, snapshotId, pageGeneration, filterKey],
	);
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
		queryFn: async ({ signal }): Promise<GitStatusPageStatsResult> => {
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
			return { snapshotId: snapshotId as string, rows: measured };
		},
		enabled: active && !epoch.readRefused && rows.length > 0,
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
	useEffect(
		() =>
			narratorWSManager.onConnectionChange((connected, reconnect) => {
				if (connected && reconnect) restart();
			}),
		[restart],
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
		enabled && !!target?.workspaceKey && !!target?.narratorId && !denied && !readRefused;
	return {
		source: epoch.source,
		rows,
		data: active && displayAllowed ? query.data : undefined,
		error: query.error ?? (refusal?.epoch === epoch.source.epoch ? refusal.error : null),
		displayAllowed,
		readRefused: denied || readRefused,
		isSettled: query.isSuccess || query.isError,
		retry: restart,
	};
}
