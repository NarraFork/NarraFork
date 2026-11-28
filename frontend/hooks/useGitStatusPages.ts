import {
	GIT_STATUS_PAGE_DEFAULT_LIMIT,
	type GitStatusFilterChar,
	type GitStatusPage,
	type GitStatusPageCacheState,
	type GitStatusPageResult,
	normalizeGitStatusFilter,
} from "@shared/git-status-page";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { GitTarget } from "../lib/api/git";
import { readWorkspace, useGitWorkspaceSubscription } from "./useGit";

export const GIT_STATUS_PAGE_AUTO_PAGE_LIMIT = 10;
const RECOVERY_STABILITY_MS = 1_000;
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERIES_PER_WINDOW = 2;

type ReadingCycle = {
	scope: string;
	intent: "automatic" | "manual" | "cancelled" | "exhausted" | "error";
	recoveryUsed: boolean;
	recoveryVersion?: string;
	recoveryGeneration?: string;
	recoveryTimes?: number[];
	statsSettledGeneration?: string;
	settledAt?: number;
};

const EMPTY_PAGES: GitStatusPage[] = [];
const errorCode = (error: unknown) =>
	(error as { data?: { code?: string }; code?: string } | null)?.data?.code ??
	(error as { code?: string } | null)?.code;
const staleCursor = (error: unknown) =>
	["GIT_STATUS_PAGE_EXPIRED", "GIT_STATUS_PAGE_INVALID_CURSOR"].includes(errorCode(error) ?? "");

/** Each generation owns a complete cursor chain; reads only consume published cache. */
export function useGitStatusPages(
	target: GitTarget | null | undefined,
	selectedFilter: readonly GitStatusFilterChar[] | ReadonlySet<GitStatusFilterChar> = [],
	options: { enabled?: boolean; limit?: number; autoPageLimit?: number } = {},
) {
	const qc = useQueryClient();
	const owner = useId();
	const principal = qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
	const enabled = options.enabled !== false && !!target;
	const subscriptions = useGitWorkspaceSubscription(enabled ? target : null);
	const denied = !!target && subscriptions.isDenied(target);
	const filterKey = normalizeGitStatusFilter([...selectedFilter]).join(",");
	const limit = options.limit ?? GIT_STATUS_PAGE_DEFAULT_LIMIT;
	const autoPageLimit = options.autoPageLimit ?? GIT_STATUS_PAGE_AUTO_PAGE_LIMIT;
	const scope = JSON.stringify([
		target?.workspaceKey,
		target?.narratorId,
		target?.repositoryKey,
		target?.rootPath,
		filterKey,
		limit,
		principal,
	]);
	// Display ownership is independent of the cursor/cache generation.
	const displayScope = JSON.stringify([
		target?.narratorId,
		target?.workspaceKey,
		target?.repositoryKey,
		target?.rootPath,
		filterKey,
		limit,
		principal,
	]);
	// Cursor and statistics share one recovery per published version until a valid handoff.
	const autoCycle = useRef<ReadingCycle>({ scope, intent: "automatic", recoveryUsed: false });
	if (autoCycle.current.scope !== scope) {
		autoCycle.current.intent = "error";
		autoCycle.current = { scope, intent: "automatic", recoveryUsed: false };
	}
	const connected = !!target && subscriptions.isPush(target);
	const readable = !!target && subscriptions.canRead(target);
	const authorizationKey = target ? subscriptions.getAuthorizationKey(target) : undefined;
	const active = enabled && readable && connected && subscriptions.isVisible();
	const observedCache = target ? subscriptions.getStatusPageState(target) : undefined;
	const updating = !!target && subscriptions.isStatusPageUpdating(target);
	const connectionKey = target ? subscriptions.getStatusPageConnectionKey(target) : undefined;
	const connection = useRef<{ scope: string; key?: string }>({ scope });
	const reconciliation = useMemo(() => ({ scope, last: "" }), [scope]);
	const cacheVersion = (cache: GitStatusPageCacheState | undefined) =>
		JSON.stringify([cache?.workerEpoch, cache?.memberVersion, cache?.statsVersion]);
	const activeState = useRef({ scope, active, authorizationKey });
	const [generation, setGeneration] = useState(0);
	const epoch = useMemo(
		() => ({ controller: new AbortController(), scope, generation, authorizationKey }),
		[scope, generation, authorizationKey],
	);
	const queryGeneration = JSON.stringify([scope, owner, generation, authorizationKey]);
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
		(mode: "snapshot" | "cycle" | "publication" = "snapshot") => {
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
					: {
							...cycle,
							scope,
							intent: mode === "publication" && intent === "error" ? "automatic" : intent,
						};
			setGeneration((value) => value + 1);
		},
		[epoch, cancelLoadAll, qc, queryKey, scope],
	);
	const failedCache = useRef<{ scope: string; cache: GitStatusPageCacheState } | null>(null);
	const publishedVersion = useRef("");
	const lease = useRef<{
		generation: string;
		expiresAt: number;
		establishedAt: number;
		attempted: boolean;
	} | null>(null);
	const recoverSnapshot = useCallback(
		(leaseExpiry = false) => {
			const cycle = autoCycle.current;
			const now = Date.now();
			if (cycle.recoveryVersion !== publishedVersion.current) {
				cycle.recoveryUsed = false;
				cycle.recoveryTimes = [];
			}
			const recent = (cycle.recoveryTimes ?? []).filter((at) => now - at < RECOVERY_WINDOW_MS);
			const settledAt = leaseExpiry ? lease.current?.establishedAt : cycle.settledAt;
			const stable = settledAt !== undefined && now - settledAt >= RECOVERY_STABILITY_MS;
			if (recent.length >= RECOVERIES_PER_WINDOW || (cycle.recoveryUsed && !stable)) {
				cycle.intent = "error";
				return false;
			}
			cycle.recoveryUsed = true;
			cycle.recoveryTimes = [...recent, now];
			cycle.recoveryVersion = publishedVersion.current;
			cycle.recoveryGeneration = queryGeneration;
			cycle.statsSettledGeneration = undefined;
			cycle.settledAt = undefined;
			restart();
			return true;
		},
		[restart, queryGeneration],
	);
	useLayoutEffect(() => {
		// Repository/root refinements need a fresh chain even when the query identity
		// is unchanged. Never expose that identity's old pages under the new owner.
		if (displayIdentityPending) restart("cycle");
	}, [displayIdentityPending, restart]);
	const query = useInfiniteQuery({
		queryKey,
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam, signal }): Promise<GitStatusPageResult> => {
			const signals = [signal, epoch.controller.signal];
			if (batch.current) signals.push(batch.current.signal);
			const requestSignal = AbortSignal.any(signals);
			// QueryClient may schedule an old chain's refetch in the same invalidation
			// turn that retires its generation. Do not dispatch that obsolete request.
			requestSignal.throwIfAborted();
			const publish = subscriptions.statusPageReadPublisher(target as GitTarget, {
				membershipOnly: pageParam !== undefined,
			});
			const baseline = subscriptions.getStatusPageState(target as GitTarget);
			const result = await readWorkspace(
				qc,
				target,
				() =>
					api.getGitStatusPage(
						target as GitTarget,
						{
							cursor: pageParam,
							filter: filterKey ? (filterKey.split(",") as GitStatusFilterChar[]) : [],
							limit,
						},
						requestSignal,
					),
				false,
				requestSignal,
			).catch((failure: unknown) => {
				requestSignal.throwIfAborted();
				if (baseline) failedCache.current = { scope, cache: baseline };
				throw failure;
			});
			requestSignal.throwIfAborted();
			const accepted = publish(result.cache);
			if (result.status === "error") {
				failedCache.current = { scope, cache: result.cache };
				throw Object.assign(new Error(result.cache.message ?? "Git cache unavailable"), {
					code: result.cache.errorCode ?? "GIT_STATUS_PAGE_SOURCE_FAILED",
				});
			}
			return accepted ? result : { status: "pending", cache: result.cache };
		},
		getNextPageParam: (lastPage) =>
			lastPage.status === "ready" && lastPage.hasMore
				? (lastPage.nextCursor ?? undefined)
				: undefined,
		enabled: active,
		staleTime: Infinity,
		// Generation keys are never reused; release obsolete full page chains immediately.
		gcTime: 0,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: false,
		retry: false,
	});
	const response = query.data?.pages[0];
	const readyPages = useMemo(() => {
		const ready =
			query.data?.pages.filter(
				(page): page is Extract<GitStatusPageResult, { status: "ready" }> =>
					page.status === "ready",
			) ?? [];
		const first = ready[0];
		return first &&
			ready.every(
				(page) =>
					page.snapshotId === first.snapshotId &&
					page.cache.workerEpoch === first.cache.workerEpoch &&
					page.cache.memberVersion === first.cache.memberVersion,
			)
			? ready
			: EMPTY_PAGES;
	}, [query.data]);
	const firstReady = readyPages[0] as Extract<GitStatusPageResult, { status: "ready" }> | undefined;
	const cache =
		observedCache &&
		(!firstReady ||
			(observedCache.workerEpoch === firstReady.cache.workerEpoch &&
				observedCache.memberVersion === firstReady.cache.memberVersion))
			? observedCache
			: (firstReady?.cache ?? response?.cache);
	if (observedCache ?? response?.cache)
		publishedVersion.current = cacheVersion(observedCache ?? response?.cache);
	const cacheFailure = useMemo(
		() =>
			cache?.errorCode
				? Object.assign(new Error(cache.message ?? "Git cache update failed"), {
						code: cache.errorCode,
					})
				: null,
		[cache?.errorCode, cache?.message],
	);
	const statsError = useMemo(
		() =>
			cache?.statsErrorCode
				? Object.assign(new Error("Git statistics update failed"), { code: cache.statsErrorCode })
				: null,
		[cache?.statsErrorCode],
	);
	const refusal = target ? subscriptions.getReadError(target) : undefined;
	const error =
		statsFailure?.generation === queryGeneration
			? statsFailure.error
			: (refusal ?? query.error ?? cacheFailure);
	const readRefused =
		!!refusal || [401, 403, 404].includes((query.error as { status?: number } | null)?.status ?? 0);
	const displayAllowed =
		enabled &&
		!!target?.workspaceKey &&
		!!target?.narratorId &&
		!displayIdentityPending &&
		readable &&
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
				current.current.data?.pages[0]?.status !== "ready" ||
				observation.snapshotId !== (current.current.data?.pages[0] as GitStatusPage)?.snapshotId
			)
				return;
			if (!observation.expired) {
				const cycle = autoCycle.current;
				cycle.statsSettledGeneration = observation.generation;
				const last = current.current.data?.pages.at(-1);
				if (last?.status === "ready" && !last.hasMore && !current.current.error)
					cycle.settledAt ??= Date.now();
				return;
			}
			if (recoverSnapshot()) return;
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
	useLayoutEffect(() => {
		const previous = activeState.current;
		activeState.current = { scope, active, authorizationKey };
		if (active) {
			// A hidden/closed panel may have missed workspace change notifications.
			if (
				previous.scope === scope &&
				!previous.active &&
				previous.authorizationKey === authorizationKey
			)
				restart();
			return;
		}
		connection.current = { scope };
		cancelLoadAll();
		void qc.cancelQueries({ queryKey, exact: true });
	}, [active, scope, authorizationKey, cancelLoadAll, qc, queryKey, restart]);
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
		if (!active || !connectionKey) return;
		const previous = connection.current;
		connection.current = { scope, key: connectionKey };
		if (previous.scope === scope && previous.key && previous.key !== connectionKey) restart();
	}, [active, connectionKey, scope, restart]);
	useEffect(() => {
		if (
			!active ||
			(query.isFetching && !response) ||
			(!response && !query.error) ||
			!observedCache ||
			observedCache.memberVersion === 0
		)
			return;
		const baseline =
			response?.cache ??
			(failedCache.current?.scope === scope ? failedCache.current.cache : undefined);
		const newer =
			!baseline ||
			observedCache.workerEpoch !== baseline.workerEpoch ||
			observedCache.memberVersion > baseline.memberVersion ||
			((response?.status === "pending" ||
				!!error ||
				(response?.status === "ready" && response.expiresAt <= Date.now())) &&
				observedCache.memberVersion === baseline.memberVersion &&
				observedCache.statsVersion > baseline.statsVersion) ||
			(!response && baseline.status === "error" && observedCache.status === "ready");
		if (!newer) return;
		const version = JSON.stringify([
			observedCache.workerEpoch,
			observedCache.memberVersion,
			observedCache.statsVersion,
		]);
		// Includes the ready-before-pending race. One read per published membership,
		// not one per local generation, render or old response.
		if (reconciliation.last === version) return;
		reconciliation.last = version;
		autoCycle.current.recoveryUsed = false;
		restart("publication");
	}, [
		active,
		query.isFetching,
		query.error,
		response,
		error,
		observedCache,
		reconciliation,
		restart,
		scope,
	]);
	useEffect(() => {
		if (updating) cancelLoadAll();
	}, [updating, cancelLoadAll]);
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
		if (!active || updating || cache?.updating) return Promise.resolve();
		const last = current.current.data.pages.at(-1);
		if (last?.status !== "ready" || last.expiresAt <= Date.now()) return Promise.resolve();
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
	}, [displayAllowed, epoch, fetchNextPage, active, updating, cache?.updating]);
	const pages = displayAllowed ? readyPages : EMPTY_PAGES;
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
		!updating &&
		!cache?.updating &&
		!cache?.errorCode &&
		(!observedCache ||
			!firstReady ||
			(observedCache.workerEpoch === firstReady.cache.workerEpoch &&
				observedCache.memberVersion === firstReady.cache.memberVersion));
	const snapshotValid =
		!!first &&
		statusPagesReliable &&
		active &&
		!!connectionKey &&
		activeState.current.active &&
		!!expiresAt &&
		expiresAt > Date.now() &&
		!epoch.controller.signal.aborted &&
		!staleCursor(error) &&
		pages.every((page) => page.snapshotId === first.snapshotId);
	const pageChainLoaded = snapshotValid && !!last && !last.hasMore;
	useEffect(() => {
		const cycle = autoCycle.current;
		if (pageChainLoaded && cycle.statsSettledGeneration === queryGeneration)
			cycle.settledAt ??= Date.now();
		if (expiresAt === undefined) return;
		if (expiresAt <= Date.now() && lease.current?.generation !== queryGeneration) return;
		if (lease.current?.generation !== queryGeneration || lease.current.expiresAt !== expiresAt)
			lease.current = {
				generation: queryGeneration,
				expiresAt,
				establishedAt: Date.now(),
				attempted: false,
			};
		if (
			active &&
			!snapshotValid &&
			expiresAt <= Date.now() &&
			!epoch.controller.signal.aborted &&
			!error &&
			!lease.current.attempted
		) {
			lease.current.attempted = true;
			// Renew one expired cursor lease from published cache. No statistics polling
			// and no Git production; repeated failures share the recovery ceiling.
			recoverSnapshot(true);
		}
	}, [
		active,
		expiresAt,
		snapshotValid,
		pageChainLoaded,
		queryGeneration,
		epoch,
		error,
		recoverSnapshot,
	]);
	const reset = useCallback(() => restart("cycle"), [restart]);
	const refresh = useCallback(() => {
		autoCycle.current.intent = "automatic";
		autoCycle.current.recoveryUsed = false;
		autoCycle.current.recoveryTimes = [];
		if (target) subscriptions.refresh(target);
	}, [target, subscriptions]);
	const retry = useCallback(() => {
		if (target && !subscriptions.canRead(target)) {
			subscriptions.refresh(target);
			restart("cycle");
			return Promise.resolve(current.current);
		}
		if (
			staleCursor(error) ||
			[401, 403, 404].includes((error as { status?: number } | null)?.status ?? 0)
		) {
			restart("cycle");
			return Promise.resolve(current.current);
		}
		return current.current.data?.pages.length ? fetchNextPage() : current.current.refetch();
	}, [error, fetchNextPage, restart, target, subscriptions]);
	return {
		...query,
		error,
		statsError,
		isError: !!error,
		isSuccess: !error && query.isSuccess,
		isLoadingError: !!error && !query.data,
		isRefetchError: !!error && !!query.data,
		status: error ? ("error" as const) : query.status,
		data: displayAllowed ? query.data : undefined,
		pages,
		queryGeneration,
		displayScope,
		workspaceIdentity: JSON.stringify([
			target?.workspaceKey,
			target?.narratorId,
			target?.repositoryKey,
			target?.rootPath,
			principal,
		]),
		displayAllowed,
		readRefused: !readable || denied || readRefused,
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
		cache,
		updating: updating || !!cache?.updating || !active,
		waitingForConnection: !connected || !connectionKey,
		isCachePending: response?.status === "pending",
		refresh,
		reset,
		retry,
		refetch: reset,
	};
}
