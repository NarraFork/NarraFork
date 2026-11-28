import {
	GIT_STAGING_LIMITS,
	type GitStagingAction,
	type GitStagingActionResult,
	type GitStagingFile,
	type GitStagingFilesPage,
	type GitStagingList,
	type GitStagingSummary,
} from "@shared/git-staging-lists";
import { type GitStatusFilterChar, normalizeGitStatusFilter } from "@shared/git-status-page";
import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { ApiError } from "../lib/api/client";
import type { GitTarget } from "../lib/api/git";
import { readWorkspace, useGitWorkspaceSubscription } from "./useGit";

export type GitStagingActionInput = GitStagingAction;

export class GitStagingGuardError extends Error {
	readonly code = "GIT_STAGING_ACCESS_CHANGED";
	constructor() {
		super("Git changes workspace access or observation changed");
	}
}

function stagingPageChainError(
	data: InfiniteData<GitStagingFilesPage> | undefined,
): ApiError | null {
	if (!data) return null;
	const cursors = new Set<unknown>();
	const first = data.pages[0];
	for (let index = 0; index < data.pages.length; index++) {
		const page = data.pages[index];
		const cursor = data.pageParams[index];
		if (
			data.pages.length !== data.pageParams.length ||
			cursor !== (index ? data.pages[index - 1].nextCursor : undefined) ||
			cursors.has(cursor) ||
			page.workspaceKey !== first.workspaceKey ||
			page.listId !== first.listId ||
			page.snapshotVersion !== first.snapshotVersion ||
			page.complete !== (page.nextCursor === null) ||
			(page.nextCursor === null && index < data.pages.length - 1) ||
			(page.nextCursor !== null &&
				(typeof page.nextCursor !== "string" ||
					!page.nextCursor ||
					page.nextCursor === cursor ||
					cursors.has(page.nextCursor) ||
					!page.files.length))
		)
			return new ApiError("The changes file page chain is incomplete or made no progress", 502, {
				code: "GIT_STAGING_INVALID_PAGE_CHAIN",
			});
		cursors.add(cursor);
	}
	return null;
}

/** Keep private ownership scoped to both the authorized narrator and signed-in user. */
function useStagingScope(target: GitTarget) {
	const qc = useQueryClient();
	const subscriptions = useGitWorkspaceSubscription(target);
	const subscribe = useMemo(
		() => (listener: () => void) =>
			qc.getQueryCache().subscribe(({ query }) => {
				if (query.queryKey[0] === "auth" && query.queryKey[1] === "me") listener();
			}),
		[qc],
	);
	const readPrincipal = () => qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id;
	const principal = useSyncExternalStore(subscribe, readPrincipal, readPrincipal);
	const scopeKey = JSON.stringify([
		target.narratorId,
		target.workspaceKey,
		principal,
		subscriptions.getAuthorizationKey(target),
	]);
	const owner = useMemo(() => ({ live: true, scopeKey }), [scopeKey]);
	useEffect(() => {
		owner.live = true;
		return () => {
			owner.live = false;
		};
	}, [owner]);
	const current = useRef(owner);
	current.current = owner;
	const refused = subscriptions.isDenied(target);
	const readable = typeof principal === "string" && subscriptions.canRead(target);
	const displayAllowed =
		readable ||
		(typeof principal === "string" &&
			subscriptions.getState(target) === "waiting" &&
			!subscriptions.needsWorkspaceProbe(target.narratorId) &&
			!subscriptions.getReadError(target));
	async function read<T>(signal: AbortSignal, load: () => Promise<T>, shared = false): Promise<T> {
		const authorized = subscriptions.getWriteResultGuard(target);
		if (!authorized() || signal.aborted) throw new GitStagingGuardError();
		try {
			const result = await readWorkspace(qc, target, load, true, signal);
			if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
			// Shared file reads belong to the query, not the observer that started it.
			if (
				(!shared && (!owner.live || current.current !== owner)) ||
				readPrincipal() !== principal ||
				!authorized()
			)
				throw new GitStagingGuardError();
			return result;
		} catch (error) {
			if (authorized() && error instanceof ApiError) {
				if (error.status === 403) subscriptions.reject(target);
				else if ([401, 404].includes(error.status)) subscriptions.unavailable(target, true);
			}
			throw error;
		}
	}
	return {
		qc,
		subscriptions,
		principal,
		scopeKey,
		owner,
		current,
		refused,
		readable,
		displayAllowed,
		read,
	};
}

export function useGitStagingLists(target: GitTarget) {
	const scope = useStagingScope(target);
	const { qc, subscriptions, principal, scopeKey, refused, readable } = scope;
	const query = useQuery({
		queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId, principal],
		queryFn: ({ signal }) =>
			scope.read(signal, async () => {
				const result = await api.getGitStagingLists(target, signal);
				if (result.workspaceKey !== target.workspaceKey) throw new GitStagingGuardError();
				return result;
			}),
		enabled: readable && subscriptions.isVisible(),
		staleTime: Infinity,
		retry: false,
		// Recheck offline CLI observations on return, without a permanent polling loop.
		refetchOnWindowFocus: "always",
	});
	const summary = scope.displayAllowed ? query.data : undefined;
	const supported = summary?.capability.supported === true;
	const canManage =
		supported && readable && subscriptions.canWrite(target) && target.canWrite && !query.error;
	const observation = subscriptions.getStagingObservation(target);
	const selectionKey = JSON.stringify([scopeKey, subscriptions.getStagingSelectionKey(target)]);
	const writable = canManage && subscriptions.isStagingWritable(target, summary);
	const version = summary?.observationId
		? { expectedGeneration: summary.generation, observationId: summary.observationId }
		: undefined;
	const latest = useRef({ summary, writable, canManage });
	latest.current = { summary, writable, canManage };
	const [notice, setNotice] = useState<{
		scopeKey: string;
		action: GitStagingAction["action"];
		result: GitStagingActionResult;
	}>();
	async function refresh() {
		if (!readable || inFlight.current) return;
		if (canManage && summary?.initialized) await mutation.mutateAsync({ action: "sync" });
		else await query.refetch();
	}
	const inFlight = useRef(false);
	const requestScopes = useRef(
		new WeakMap<GitStagingActionInput, { scopeKey: string; selectionKey: string }>(),
	);
	const writeMutation = useMutation({
		mutationFn: async (action: GitStagingActionInput) => {
			const state = latest.current;
			const chosen = requestScopes.current.get(action);
			const maintenance = ["init", "sync", "recover"].includes(action.action);
			if (
				!chosen ||
				chosen.scopeKey !== scopeKey ||
				!state.canManage ||
				!subscriptions.canWrite(target) ||
				(!maintenance &&
					(!state.writable ||
						!subscriptions.isStagingWritable(target, state.summary) ||
						chosen.selectionKey !==
							JSON.stringify([scopeKey, subscriptions.getStagingSelectionKey(target)])))
			)
				throw new GitStagingGuardError();
			if (
				"expectedGeneration" in action &&
				(action.expectedGeneration !== state.summary?.generation ||
					action.observationId !== state.summary?.observationId)
			)
				throw new GitStagingGuardError();
			if ("listId" in action && !state.summary?.lists.some((list) => list.id === action.listId))
				throw new GitStagingGuardError();
			if (
				action.action === "move" &&
				![action.fromListId, action.toListId].every((id) =>
					state.summary?.lists.some((list) => list.id === id),
				)
			)
				throw new GitStagingGuardError();
			const authorized = subscriptions.getWriteResultGuard(target);
			const live = () => scope.owner.live && scope.current.current === scope.owner && authorized();
			if (!live()) throw new GitStagingGuardError();
			if (inFlight.current) throw new GitStagingGuardError();
			inFlight.current = true;
			const releaseObservation =
				action.action === "sync" ? subscriptions.holdStagingObservation(target) : undefined;
			let result: GitStagingActionResult;
			try {
				result = await readWorkspace(
					qc,
					target,
					async () => {
						try {
							return await api.gitStagingAction(target, action);
						} catch (error) {
							if (!live()) throw new GitStagingGuardError();
							throw error;
						}
					},
					true,
				);
			} catch (error) {
				if (authorized() && error instanceof ApiError) {
					if (error.status === 403) subscriptions.reject(target);
					else if ([401, 404].includes(error.status)) subscriptions.unavailable(target, true);
				}
				// CAS failures and uncertain writes must retire the user's stale selection too.
				if (live() && error instanceof ApiError && error.status === 409) {
					const code = error.data?.code;
					const stale =
						typeof code !== "string" ||
						/^GIT_STAGING_(STALE|CONCURRENT_CHANGE|SOURCE_CHANGED|HEAD_CONFLICT|OBSERVATION_FAILED)/.test(
							code,
						);
					if (stale) {
						subscriptions.beginStagingObservation(target);
						void qc.invalidateQueries({
							queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId, principal],
						});
					} else subscriptions.retireStagingSelections(target);
				}
				throw error;
			} finally {
				inFlight.current = false;
				releaseObservation?.();
			}
			if (!live()) throw new GitStagingGuardError();
			if (result.outcome === "partial") setNotice({ scopeKey, action: action.action, result });
			else setNotice(undefined);
			if (result.observation) subscriptions.publishStagingObservation(target, result.observation);
			else subscriptions.beginStagingObservation(target);
			// HTTP and WS share generation deduplication. An unchanged sync needs no content reads.
			if (
				action.action !== "sync" ||
				result.generation !== state.summary?.generation ||
				result.observationId !== state.summary?.observationId
			)
				await subscriptions.invalidateStagingObservation(
					target,
					result.generation,
					result.affectedListIds,
				);
			return result;
		},
		retry: false,
	});
	const mutation: typeof writeMutation = {
		...writeMutation,
		mutate: (action, options) => {
			const request = { ...action };
			requestScopes.current.set(request, { scopeKey, selectionKey });
			writeMutation.mutate(request, options);
		},
		mutateAsync: (action, options) => {
			const request = { ...action };
			requestScopes.current.set(request, { scopeKey, selectionKey });
			return writeMutation.mutateAsync(request, options);
		},
	};
	const mutationScope = useRef(scopeKey);
	useEffect(() => {
		if (mutationScope.current === scopeKey) return;
		mutationScope.current = scopeKey;
		mutation.reset();
	}, [scopeKey, mutation.reset]);
	return {
		query,
		mutation,
		summary,
		version,
		supported,
		active: supported && summary?.initialized === true,
		writable: writable && !mutation.isPending,
		canRefresh: readable && !mutation.isPending,
		initializable: canManage && !mutation.isPending,
		observation,
		observing:
			!observation || observation.status === "pending" || observation.status === "observing",
		selectionKey,
		refused,
		scopeKey,
		displayScope: JSON.stringify([
			target.narratorId,
			target.workspaceKey,
			principal,
			subscriptions.getPrincipalKey(),
		]),
		preferenceKey: JSON.stringify([target.narratorId, target.workspaceKey, principal]),
		notice: readable && notice?.scopeKey === scopeKey ? notice : undefined,
		refresh,
	};
}

export type GitStagingController = ReturnType<typeof useGitStagingLists>;

export function useGitStagingFiles(
	target: GitTarget,
	summary: GitStagingSummary | undefined,
	list: GitStagingList | undefined,
	enabled = true,
	filter?: GitStatusFilterChar[],
) {
	const scope = useStagingScope(target);
	const readable =
		scope.readable && summary?.initialized === true && summary.capability.supported && !!list;
	const active = readable && enabled && scope.subscriptions.isVisible();
	const filterKey = normalizeGitStatusFilter(filter).join("");
	const normalizedFilter = useMemo(() => filterKey.split("") as GitStatusFilterChar[], [filterKey]);
	const queryKey = useMemo(
		() => [
			"gitStagingFiles",
			target.workspaceKey,
			list?.id,
			target.narratorId,
			scope.principal,
			list?.snapshotVersion,
			normalizedFilter,
		],
		[
			target.workspaceKey,
			list?.id,
			target.narratorId,
			scope.principal,
			list?.snapshotVersion,
			normalizedFilter,
		],
	);
	const access = useRef({ queryKey, active });
	access.current = { queryKey, active };
	const canRead = useCallback(
		() =>
			access.current.queryKey === queryKey &&
			access.current.active &&
			scope.owner.live &&
			scope.current.current === scope.owner &&
			scope.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id === scope.principal &&
			scope.subscriptions.isVisible() &&
			scope.subscriptions.canRead(target),
		[queryKey, scope.owner, scope.current, scope.qc, scope.principal, scope.subscriptions, target],
	);
	// Every Infinite Query fetch has one signal, including all pages of a refetch.
	const readChains = useRef(new WeakMap<AbortSignal, InfiniteData<GitStagingFilesPage>>());
	const query = useInfiniteQuery({
		queryKey,
		queryFn: ({ signal, pageParam }) => {
			// A manual fetch can bypass `enabled`; enforce access before touching the API too.
			if (
				!readable ||
				scope.qc.getQueryData<{ id?: unknown }>(["auth", "me"])?.id !== scope.principal ||
				!scope.subscriptions.canRead(target) ||
				!scope.subscriptions.isVisible() ||
				signal.aborted
			)
				throw new GitStagingGuardError();
			return scope.read(
				signal,
				async () => {
					const prefix =
						readChains.current.get(signal) ??
						(pageParam === undefined
							? undefined
							: scope.qc.getQueryData<InfiniteData<GitStagingFilesPage>>(queryKey));
					const prefixError = stagingPageChainError(prefix);
					if (prefixError) throw prefixError;
					const page = await api.getGitStagingFiles(
						target,
						list?.id as string,
						{ cursor: pageParam, limit: GIT_STAGING_LIMITS.maxPageRows, filter },
						signal,
					);
					if (
						page.workspaceKey !== target.workspaceKey ||
						page.listId !== list?.id ||
						page.snapshotVersion !== list?.snapshotVersion
					)
						throw new ApiError("The changes observation changed; reload its files", 409, {
							code: "GIT_STAGING_STALE_CURSOR",
						});
					const chain = {
						pages: [...(prefix?.pages ?? []), page],
						pageParams: [...(prefix?.pageParams ?? []), pageParam],
					};
					const chainError = stagingPageChainError(chain);
					if (chainError) throw chainError;
					readChains.current.set(signal, chain);
					return page;
				},
				true,
			);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled: active,
		// Detaching only this observer lets Query cancel the last reader, retaining cached pages.
		subscribed: active,
		staleTime: Infinity,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const pageChainError = useMemo(() => stagingPageChainError(query.data), [query.data]);
	const error = pageChainError ?? query.error;
	const fetchNextPage = useCallback(async () => {
		if (canRead() && !pageChainError) return query.fetchNextPage({ cancelRefetch: false });
	}, [canRead, pageChainError, query.fetchNextPage]);
	const refetch = useCallback(async () => {
		if (canRead()) return query.refetch({ cancelRefetch: false });
	}, [canRead, query.refetch]);
	useEffect(() => {
		// Fast pages can settle in one notification batch; page data must advance the scheduler too.
		if (active && query.data?.pages.length && query.hasNextPage && !query.isFetching && !error)
			void fetchNextPage();
	}, [active, query.data, query.hasNextPage, query.isFetching, error, fetchNextPage]);
	const retry = useCallback(async () => {
		if (!pageChainError && query.isFetchNextPageError) return fetchNextPage();
		return refetch();
	}, [pageChainError, query.isFetchNextPageError, fetchNextPage, refetch]);
	const staleReload = useRef<Error | null>(null);
	useEffect(() => {
		if (
			!query.error ||
			!active ||
			!(query.error instanceof ApiError) ||
			query.error.status !== 409 ||
			staleReload.current === query.error
		)
			return;
		staleReload.current = query.error;
		void scope.qc.invalidateQueries({
			queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId],
		});
	}, [query.error, active, scope.qc, target.workspaceKey, target.narratorId]);
	return {
		...query,
		error,
		fetchNextPage,
		refetch,
		retry,
		displayAllowed: readable,
		pages: readable ? (query.data?.pages ?? []) : [],
	};
}

export function useGitStagingDiff(
	target: GitTarget,
	summary: GitStagingSummary | undefined,
	list: GitStagingList | undefined,
	file: GitStagingFile | null,
) {
	const scope = useStagingScope(target);
	const enabled =
		scope.readable &&
		summary?.initialized === true &&
		summary.capability.supported &&
		!!list &&
		!!file;
	const query = useQuery({
		queryKey: [
			"gitStagingDiff",
			target.workspaceKey,
			list?.id,
			target.narratorId,
			scope.principal,
			list?.snapshotVersion,
			file?.fileId,
			file?.path,
		],
		queryFn: ({ signal }) =>
			scope.read(signal, async () => {
				const result = await api.getGitStagingDiff(
					target,
					list?.id as string,
					{ path: file?.path as string, ...(file?.oldPath ? { oldPath: file.oldPath } : {}) },
					signal,
				);
				if (
					result.path !== file?.path ||
					result.units.some(
						(unit) =>
							unit.listId !== list?.id || unit.fileId !== file?.fileId || unit.path !== file?.path,
					)
				)
					throw new GitStagingGuardError();
				if (result.snapshotVersion !== list?.snapshotVersion)
					throw new ApiError("The changes observation changed; reload its diff", 409, {
						code: "GIT_STAGING_STALE_CURSOR",
					});
				return result;
			}),
		enabled,
		staleTime: Infinity,
		retry: false,
		refetchOnWindowFocus: false,
	});
	const staleReload = useRef<Error | null>(null);
	useEffect(() => {
		if (
			!enabled ||
			!(query.error instanceof ApiError) ||
			query.error.status !== 409 ||
			staleReload.current === query.error
		)
			return;
		staleReload.current = query.error;
		void scope.qc.invalidateQueries({
			queryKey: ["gitStagingLists", target.workspaceKey, target.narratorId],
		});
	}, [enabled, query.error, scope.qc, target.workspaceKey, target.narratorId]);
	return { ...query, data: enabled ? query.data : undefined };
}
