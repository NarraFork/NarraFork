import type { CommunicationCandidate } from "@shared/narrator-communication";
import { useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { api } from "../lib/api";
import {
	isRecentTabsScopeCurrent,
	recentTabsFlatQueryKey,
	recentTabsScopeKey,
	recentTabsSectionQueryKey,
	subscribeRecentTabsScope,
	useRecentTabsScope,
} from "../lib/recent-tabs-owner";
import {
	localNarratorMentionCandidates,
	type MentionSearchState,
	mergeNarratorMentionCandidates,
	NarratorMentionSearch,
} from "./narrator-mention-candidates";
import type { RecentTab, RecentTabsInfiniteData } from "./useRecentTabs";

/** Read only loaded preference pages: opening @ never starts a recent-tabs request. */
export function useNarratorMentionCandidates(
	narratorId: string | undefined,
	query: string | null,
	enabled = true,
): { candidates: CommunicationCandidate[]; loading: boolean; error: boolean; hasMore: boolean } {
	const qc = useQueryClient();
	const scope = useRecentTabsScope();
	const owner = scope ? JSON.stringify(recentTabsScopeKey(scope)) : undefined;
	const activeQuery = enabled ? query : null;
	const key = JSON.stringify([owner, narratorId, activeQuery]);
	const [remote, setRemote] = useState<MentionSearchState>();
	const searchRef = useRef<NarratorMentionSearch | null>(null);
	if (!searchRef.current)
		searchRef.current = new NarratorMentionSearch(
			(source, text, options) => api.searchCommunicationCandidates(source, text, options),
			setRemote,
		);
	useLayoutEffect(() => {
		// Cancel obsolete trailing and in-flight requests synchronously at the scope boundary.
		const unsubscribe = subscribeRecentTabsScope(() => {
			if (!isRecentTabsScopeCurrent(scope)) searchRef.current?.invalidate();
		});
		return unsubscribe;
	}, [scope]);
	useLayoutEffect(() => {
		searchRef.current?.update(owner, narratorId, activeQuery);
		return () => searchRef.current?.cancel();
	}, [owner, narratorId, activeQuery]);
	const subscribe = useCallback((notify: () => void) => qc.getQueryCache().subscribe(notify), [qc]);
	const getLoaded = useCallback(() => {
		if (!isRecentTabsScopeCurrent(scope)) return undefined;
		return (
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, "work")) ??
			qc.getQueryData<RecentTab[]>(recentTabsFlatQueryKey(scope))
		);
	}, [qc, scope]);
	const loaded = useSyncExternalStore(subscribe, getLoaded, () => undefined);
	const local = useMemo(() => {
		const tabs = Array.isArray(loaded) ? loaded : loaded?.pages.flatMap((page) => page.items);
		return localNarratorMentionCandidates(tabs ?? [], narratorId);
	}, [loaded, narratorId]);
	const current = remote?.key === key ? remote : undefined;
	const candidates = useMemo(
		() =>
			activeQuery === null
				? []
				: mergeNarratorMentionCandidates(local, current?.items ?? [], activeQuery, narratorId),
		[local, current?.items, activeQuery, narratorId],
	);
	return {
		candidates,
		loading: activeQuery !== null && !!owner && !!narratorId && (current?.loading ?? true),
		error: current?.error ?? false,
		hasMore: current?.hasMore ?? false,
	};
}
