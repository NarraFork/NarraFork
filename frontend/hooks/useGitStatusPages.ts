import {
	GIT_STATUS_PAGE_DEFAULT_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPage,
	normalizeGitStatusFilter,
} from "@shared/git-status-page";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { GitTarget } from "../lib/api/git";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useGitWorkspaceSubscription } from "./useGit";

export const GIT_STATUS_PAGE_AUTO_PAGE_LIMIT = 10;

type ReadingCycle = {
	scope: string;
	intent: "automatic" | "manual" | "cancelled" | "exhausted" | "error";
	recoveryUsed: boolean;
};

const EMPTY_PAGES: GitStatusPage[] = [];
const errorCode = (error: unknown) =>
	(error as { data?: { code?: string }; code?: string } | null)?.data?.code ??
	(error as { code?: string } | null)?.code;
const staleCursor = (error: unknown) =>
	["GIT_STATUS_PAGE_EXPIRED", "GIT_STATUS_PAGE_INVALID_CURSOR"].includes(errorCode(error) ?? "");

/** Each generation owns a complete cursor chain; ordinary invalidation starts a new chain. */
export function useGitStatusPages(
	target: GitTarget | null | undefined,
	selectedFilter: readonly GitStatusFilterChar[] | ReadonlySet<GitStatusFilterChar> = [],
	options: { enabled?: boolean; limit?: number; autoPageLimit?: number } = {},
) {
	const qc = useQueryClient();
	const owner = useId();
	const enabled = options.enabled !== false && !!target;
	const subscriptions = useGitWorkspaceSubscription(enabled ? target : null);
	const denied = !!target && subscriptions.isDenied(target);
	const filterKey = normalizeGitStatusFilter([...selectedFilter]).join(",");
	const limit = options.limit ?? GIT_STATUS_PAGE_DEFAULT_LIMIT;
	const autoPageLimit = options.autoPageLimit ?? GIT_STATUS_PAGE_AUTO_PAGE_LIMIT;
	const scope = JSON.stringify([target?.workspaceKey, target?.narratorId, filterKey, limit]);
	// Display ownership is independent of the cursor/cache generation.
	const displayScope = JSON.stringify([
		target?.narratorId,
		target?.workspaceKey,
		target?.repositoryKey,
		target?.rootPath,
		filterKey,
		limit,
	]);
	// Cursor and statistics expiry share one recovery until an explicit cycle reset.
	const autoCycle = useRef<ReadingCycle>({ scope, intent: "automatic", recoveryUsed: false });
	if (autoCycle.current.scope !== scope) {
		autoCycle.current.intent = "error";
		autoCycle.current = { scope, intent: "automatic", recoveryUsed: false };
	}
	const active = enabled && !denied && subscriptions.isVisible();
	const activeState = useRef({ scope, active });
	const [generation, setGeneration] = useState(0);
	const epoch = useMemo(
		() => ({ controller: new AbortController(), scope, generation }),
		[scope, generation],
	);
	const versions = useMemo(() => ({ scope, values: new Map<string, number>() }), [scope]);
	const narratorId = target?.narratorId;
	const workspaceKey = target?.workspaceKey;
	const queryGeneration = JSON.stringify([scope, owner, generation]);
	const displayIdentity = useRef({
		scope: displayScope,
		generation: queryGeneration,
		pending: false,
	});
	if (displayIdentity.current.scope !== displayScope)
		displayIdentity.current = {
			scope: displayScope,
			generation: queryGeneration,
			pending: displayIdentity.current.generation === queryGeneration,
		};
	else if (displayIdentity.current.generation !== queryGeneration)
		displayIdentity.current = { scope: displayScope, generation: queryGeneration, pending: false };
	const displayIdentityPending = displayIdentity.current.pending;
	const currentGeneration = useRef(queryGeneration);
	currentGeneration.current = queryGeneration;
	const queryKey = useMemo(
		() => ["gitStatusPages", target?.workspaceKey, target?.narratorId, queryGeneration] as const,
		[target?.workspaceKey, target?.narratorId, queryGeneration],
	);
	const [statsFailure, setStatsFailure] = useState<{
		generation: string;
		error: Error;
	} | null>(null);
	const batch = useRef<AbortController | null>(null);
	const batchPromise = useRef<Promise<void> | null>(null);
	const [isLoadingAll, setLoadingAll] = useState(false);
	const [watchValidity, setWatchValidity] = useState<{
		scope: string;
		snapshotId?: string;
		reliable: boolean;
	}>({ scope, reliable: true });
	const cancelLoadAll = useCallback(() => {
		if (!batch.current) return;
		autoCycle.current.intent = "cancelled";
		batch.current.abort();
		batch.current = null;
		batchPromise.current = null;
		setLoadingAll(false);
		void qc.cancelQueries({ queryKey, exact: true });
	}, [qc, queryKey]);
	const restart = useCallback(
		(mode: "snapshot" | "cycle" = "snapshot") => {
			if (epoch.controller.signal.aborted) return;
			const cycle = autoCycle.current;
			const intent = cycle.intent;
			epoch.controller.abort();
			cancelLoadAll();
			void qc.cancelQueries({ queryKey, exact: true });
			cycle.intent = "error";
			// Background changes replace the snapshot, not the user's reading intent.
			// Explicit refresh/retry and display-owner changes start a new cycle.
			autoCycle.current =
				mode === "cycle"
					? { scope, intent: "automatic", recoveryUsed: false }
					: { scope, intent, recoveryUsed: cycle.recoveryUsed };
			setGeneration((value) => value + 1);
		},
		[epoch, cancelLoadAll, qc, queryKey, scope],
	);
	const recoverSnapshot = useCallback(() => {
		if (autoCycle.current.recoveryUsed) {
			autoCycle.current.intent = "error";
			return false;
		}
		autoCycle.current.recoveryUsed = true;
		restart();
		return true;
	}, [restart]);
	useLayoutEffect(() => {
		// Repository/root refinements need a fresh chain even when the query identity
		// is unchanged. Never expose that identity's old pages under the new owner.
		if (displayIdentityPending) restart("cycle");
	}, [displayIdentityPending, restart]);
	const query = useInfiniteQuery({
		queryKey,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam, signal }) => {
			const signals = [signal, epoch.controller.signal];
			if (batch.current) signals.push(batch.current.signal);
			const requestSignal = AbortSignal.any(signals);
			// QueryClient may schedule an old chain's refetch in the same invalidation
			// turn that retires its generation. Do not dispatch that obsolete request.
			requestSignal.throwIfAborted();
			return api.getGitStatusPage(
				target as GitTarget,
				{
					cursor: pageParam,
					filter: filterKey ? (filterKey.split(",") as GitStatusFilterChar[]) : [],
					limit,
				},
				requestSignal,
			);
		},
		getNextPageParam: (lastPage) =>
			lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined,
		enabled: active,
		staleTime: Infinity,
		// Generation keys are never reused; release obsolete full page chains immediately.
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: false,
		retry: false,
	});
	const error = statsFailure?.generation === queryGeneration ? statsFailure.error : query.error;
	const readRefused = [401, 403, 404].includes(
		(query.error as { status?: number } | null)?.status ?? 0,
	);
	const displayAllowed =
		enabled &&
		!!target?.workspaceKey &&
		!!target?.narratorId &&
		!displayIdentityPending &&
		!denied &&
		!readRefused;
	const current = useRef(query);
	current.current = query;
	const observeSnapshotStats = useCallback(
		(observation: { snapshotId: string; generation: string; expired: boolean }) => {
			if (
				!active ||
				epoch.controller.signal.aborted ||
				observation.generation !== currentGeneration.current ||
				observation.generation !== queryGeneration ||
				observation.snapshotId !== current.current.data?.pages[0]?.snapshotId
			)
				return;
			if (!observation.expired || recoverSnapshot()) return;
			// Statistics and cursor expiry share one recovery allowance. Preserve the
			// displayed files, but invalidate range actions and expose an explicit retry.
			cancelLoadAll();
			autoCycle.current.intent = "error";
			void qc.cancelQueries({ queryKey, exact: true });
			setStatsFailure((previous) =>
				previous?.generation === queryGeneration
					? previous
					: {
							generation: queryGeneration,
							error: Object.assign(new Error("Git status snapshot expired"), {
								code: "GIT_STATUS_PAGE_EXPIRED",
							}),
						},
			);
		},
		[active, epoch, queryGeneration, recoverSnapshot, cancelLoadAll, qc, queryKey],
	);
	useEffect(() => {
		setLoadingAll(false);
		// StrictMode replays setup after cleanup without rebuilding memoized values.
		// A replay must acquire a new cursor generation instead of reusing its aborted owner.
		if (epoch.controller.signal.aborted) setGeneration((value) => value + 1);
		return () => {
			epoch.controller.abort();
			batch.current?.abort();
			batch.current = null;
			batchPromise.current = null;
			void qc.cancelQueries({ queryKey, exact: true });
		};
	}, [epoch, qc, queryKey]);
	useEffect(() => {
		const previous = activeState.current;
		activeState.current = { scope, active };
		if (active) {
			// A hidden/closed panel may have missed workspace change notifications.
			if (previous.scope === scope && !previous.active) restart();
			return;
		}
		cancelLoadAll();
		void qc.cancelQueries({ queryKey, exact: true });
	}, [active, scope, cancelLoadAll, qc, queryKey, restart]);
	useEffect(
		() =>
			qc.getQueryCache().subscribe((event) => {
				if (
					event.type === "updated" &&
					event.action.type === "invalidate" &&
					event.query.queryKey[0] === "gitStatusPages" &&
					event.query.queryKey[3] === queryGeneration
				)
					restart();
			}),
		[qc, queryGeneration, restart],
	);
	useEffect(() => {
		if (!enabled || !narratorId || !workspaceKey) return;
		// Statistical snapshots can arrive repeatedly with unchanged files. Only actual
		// category changes (or a reconnect that missed them) reset the paging chain.
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["git_workspace_changed"] },
			(data) => {
				if (
					data.type !== "git_workspace_changed" ||
					data.workspaceKey !== workspaceKey ||
					typeof data.version !== "number"
				)
					return;
				const id = String(data.subscriptionId ?? "");
				if (data.version <= (versions.values.get(id) ?? -1)) return;
				versions.values.set(id, data.version);
				if (data.statusPagesReliable === false) cancelLoadAll();
				if (typeof data.statusPagesReliable === "boolean")
					setWatchValidity({
						scope,
						snapshotId: current.current.data?.pages[0]?.snapshotId,
						reliable: data.statusPagesReliable,
					});
				const changed =
					typeof data.statusPagesChanged === "boolean"
						? data.statusPagesChanged
						: Array.isArray(data.categories) &&
							data.categories.some((value) =>
								["worktree", "index", "head", "refs"].includes(value),
							);
				if (changed) restart();
			},
		);
		const offConnection = narratorWSManager.onConnectionChange((connected, reconnect) => {
			if (connected && reconnect) restart();
		});
		return () => {
			narratorWSManager.removeListener(handle);
			offConnection();
		};
	}, [enabled, narratorId, workspaceKey, restart, versions, scope, cancelLoadAll]);
	useEffect(() => {
		if (!error || epoch.controller.signal.aborted) return;
		if (!active || !staleCursor(error)) autoCycle.current.intent = "error";
		else recoverSnapshot();
	}, [error, active, epoch, recoverSnapshot]);

	const fetchNextPage = useCallback(
		() => current.current.fetchNextPage({ cancelRefetch: false }),
		[],
	);
	useEffect(() => {
		const cycle = autoCycle.current;
		if (
			!active ||
			epoch.controller.signal.aborted ||
			cycle.intent !== "automatic" ||
			batch.current ||
			!query.data?.pages.length ||
			query.isFetching ||
			error
		)
			return;
		if (!query.hasNextPage) return;
		if (query.data.pages.length >= autoPageLimit) {
			cycle.intent = "exhausted";
			return;
		}
		// One shared continuation per render: manual reads and loadAll join the same
		// cancelRefetch:false request; its completed page consumes one budget slot.
		void fetchNextPage().then(
			(result) => {
				if (result.error && !staleCursor(result.error) && !epoch.controller.signal.aborted)
					cycle.intent = "error";
			},
			(failure) => {
				if (!staleCursor(failure) && !epoch.controller.signal.aborted) cycle.intent = "error";
			},
		);
	}, [
		active,
		epoch,
		autoPageLimit,
		query.data,
		query.isFetching,
		error,
		query.hasNextPage,
		fetchNextPage,
	]);
	const loadAll = useCallback((): Promise<void> => {
		if (batchPromise.current) return batchPromise.current;
		if (!displayAllowed || !current.current.data) return Promise.resolve();
		if (
			watchValidity.scope === scope &&
			watchValidity.snapshotId === current.current.data.pages[0]?.snapshotId &&
			!watchValidity.reliable
		)
			return Promise.resolve();
		if ((current.current.data.pages.at(-1)?.expiresAt ?? 0) <= Date.now()) return Promise.resolve();
		// The explicit full-range intent owns scheduling after the current shared page.
		autoCycle.current.intent = "manual";
		const controller = new AbortController();
		batch.current = controller;
		setLoadingAll(true);
		const work = async () => {
			try {
				let result = current.current;
				while (
					result.hasNextPage &&
					!controller.signal.aborted &&
					!epoch.controller.signal.aborted
				) {
					result = await fetchNextPage();
					if (result.error) throw result.error;
				}
			} finally {
				if (batch.current === controller) {
					batch.current = null;
					batchPromise.current = null;
					setLoadingAll(false);
				}
			}
		};
		const promise = Promise.resolve().then(work);
		batchPromise.current = promise;
		return promise;
	}, [displayAllowed, epoch, fetchNextPage, watchValidity, scope]);
	const pages = displayAllowed ? (query.data?.pages ?? EMPTY_PAGES) : EMPTY_PAGES;
	const first = pages[0];
	const last = pages.at(-1);
	const expiresAt = last?.expiresAt;
	const [, expire] = useState(0);
	useEffect(() => {
		if (expiresAt === undefined || expiresAt <= Date.now()) return;
		const timer = setTimeout(() => expire((value) => value + 1), expiresAt - Date.now() + 1);
		return () => clearTimeout(timer);
	}, [expiresAt]);
	const statusPagesReliable =
		watchValidity.scope !== scope ||
		watchValidity.snapshotId !== first?.snapshotId ||
		watchValidity.reliable;
	const snapshotValid =
		!!first &&
		statusPagesReliable &&
		active &&
		activeState.current.active &&
		!!expiresAt &&
		expiresAt > Date.now() &&
		!epoch.controller.signal.aborted &&
		!staleCursor(error) &&
		pages.every((page) => page.snapshotId === first.snapshotId);
	const pageChainLoaded = snapshotValid && !!last && !last.hasMore;
	const reset = useCallback(() => restart("cycle"), [restart]);
	const retry = useCallback(() => {
		if (
			staleCursor(error) ||
			[401, 403, 404].includes((current.current.error as { status?: number } | null)?.status ?? 0)
		) {
			restart("cycle");
			return Promise.resolve(current.current);
		}
		return current.current.data?.pages.length ? fetchNextPage() : current.current.refetch();
	}, [error, fetchNextPage, restart]);
	return {
		...query,
		error,
		isError: !!error,
		isSuccess: !error && query.isSuccess,
		isLoadingError: !!error && !query.data,
		isRefetchError: !!error && !!query.data,
		status: error ? ("error" as const) : query.status,
		data: displayAllowed ? query.data : undefined,
		pages,
		queryGeneration,
		displayScope,
		displayAllowed,
		readRefused: denied || readRefused,
		observeSnapshotStats,
		counts: first?.counts,
		complete: first?.complete ?? false,
		limitReason: first?.limitReason,
		snapshotValid,
		statusPagesReliable,
		pageChainLoaded,
		isComplete: pageChainLoaded && first?.complete === true,
		isLoadingAll,
		loadAll,
		cancelLoadAll,
		fetchNextPage,
		refresh: reset,
		reset,
		retry,
		refetch: reset,
	};
}
