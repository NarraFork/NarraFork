import { COMMUNICATION_LIMITS, type CommunicationCandidate } from "@shared/narrator-communication";
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
import type { CommunicationCandidatePurpose } from "../lib/api/narrator-communication";
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
	narratorMentionSearchKey,
} from "./narrator-mention-candidates";
import type { RecentTab, RecentTabsInfiniteData } from "./useRecentTabs";

export type CandidateVerificationStatus = "checking" | "denied" | "error";

/** Read only loaded preference pages: opening @ never starts a recent-tabs request. */
export function useNarratorMentionCandidates(
	narratorId: string | undefined,
	query: string | null,
	enabled = true,
	allowExact = enabled,
	purpose?: CommunicationCandidatePurpose,
) {
	const qc = useQueryClient();
	const scope = useRecentTabsScope();
	const owner = scope ? JSON.stringify(recentTabsScopeKey(scope)) : undefined;
	const activeQuery = enabled ? query : null;
	const key = narratorMentionSearchKey(owner, narratorId, activeQuery, purpose);
	const [remote, setRemote] = useState<MentionSearchState>();
	const [verification, setVerification] = useState<{
		targetId: string;
		status: CandidateVerificationStatus;
	}>();
	const verificationRef = useRef<AbortController | null>(null);
	const abortVerification = useCallback(() => {
		const controller = verificationRef.current;
		verificationRef.current = null;
		controller?.abort();
	}, []);
	const cancelVerification = useCallback(() => {
		abortVerification();
		setVerification(undefined);
	}, [abortVerification]);
	const searchRef = useRef<NarratorMentionSearch | null>(null);
	if (!searchRef.current)
		searchRef.current = new NarratorMentionSearch(
			(source, text, options) => api.searchCommunicationCandidates(source, text, options),
			setRemote,
		);
	useLayoutEffect(() => {
		// Cancel obsolete trailing and in-flight requests synchronously at the scope boundary.
		const unsubscribe = subscribeRecentTabsScope(() => {
			if (!isRecentTabsScopeCurrent(scope)) {
				searchRef.current?.invalidate();
				cancelVerification();
			}
		});
		return unsubscribe;
	}, [scope, cancelVerification]);
	useLayoutEffect(() => {
		cancelVerification();
		searchRef.current?.update(owner, narratorId, activeQuery, purpose);
		return () => {
			searchRef.current?.cancel();
			abortVerification();
		};
	}, [owner, narratorId, activeQuery, purpose, cancelVerification, abortVerification]);
	useLayoutEffect(() => {
		if (!allowExact) cancelVerification();
	}, [allowExact, cancelVerification]);
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
				: mergeNarratorMentionCandidates(local, current?.items ?? [], activeQuery, narratorId).map(
						(candidate) =>
							verification?.status === "denied" && candidate.id === verification.targetId
								? { ...candidate, canConnect: false }
								: candidate,
					),
		[local, current?.items, activeQuery, narratorId, verification],
	);
	const verifyExactCandidate = useCallback(
		(
			targetId: string,
			onEligible: (candidate: CommunicationCandidate) => void,
			onRejected?: (status: "denied" | "error") => void,
		) => {
			if (!allowExact || !narratorId || targetId === narratorId || !isRecentTabsScopeCurrent(scope))
				return;
			if (verificationRef.current) return;
			// Only explicit selection or drop triggers an exact read. Search-page omission is not denial.
			const controller = new AbortController();
			verificationRef.current = controller;
			setVerification({ targetId, status: "checking" });
			const isCurrent = () =>
				verificationRef.current === controller && isRecentTabsScopeCurrent(scope);
			const reject = (status: "denied" | "error") => {
				verificationRef.current = null;
				setVerification({ targetId, status });
				onRejected?.(status);
			};
			const timeout = setTimeout(() => {
				if (!isCurrent()) return;
				abortVerification();
				reject("error");
			}, COMMUNICATION_LIMITS.searchTimeoutMs);
			controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
			void api
				.searchCommunicationCandidates(narratorId, "", {
					targetId,
					signal: controller.signal,
					...(purpose !== undefined && { purpose }),
				})
				.then(
					(result) => {
						if (!isCurrent()) return;
						if (!Array.isArray(result?.items) || result.items.length > 1) return reject("error");
						const item = result.items[0];
						if (!result.items.length || (item?.id === targetId && item.canConnect === false))
							return reject("denied");
						if (item?.id !== targetId || item.canConnect !== true) return reject("error");
						verificationRef.current = null;
						setVerification(undefined);
						onEligible(item);
					},
					() => {
						if (isCurrent()) reject("error");
					},
				)
				.finally(() => clearTimeout(timeout));
			return controller.signal;
		},
		[narratorId, allowExact, purpose, scope, abortVerification],
	);
	const verifyCandidate = useCallback(
		(targetId: string, onEligible: (candidate: CommunicationCandidate) => void) => {
			if (!allowExact || activeQuery === null || !isRecentTabsScopeCurrent(scope)) return;
			if (verificationRef.current) return;
			const candidate = candidates.find(({ id }) => id === targetId);
			if (!candidate || candidate.canConnect === false) return;
			if (candidate.canConnect === true) {
				setVerification(undefined);
				onEligible({ ...candidate, canConnect: true });
			} else {
				verifyExactCandidate(targetId, (eligible) => {
					onEligible({ ...eligible, title: candidate.title, status: candidate.status });
				});
			}
		},
		[allowExact, activeQuery, scope, candidates, verifyExactCandidate],
	);
	return {
		candidates,
		loading: activeQuery !== null && !!owner && !!narratorId && (current?.loading ?? true),
		error: current?.error ?? false,
		hasMore: current?.hasMore ?? false,
		verification,
		verifyCandidate,
		verifyExactCandidate,
		cancelVerification,
	};
}
