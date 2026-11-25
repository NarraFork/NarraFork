import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { getAuthSnapshot, subscribeAuth } from "../lib/api/client";
import { getNarratorUiSummary, type NarratorUiSummary } from "../lib/api/narrator-ui-summary";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const narratorUiSummaryKey = (narratorId: string, generation: number) =>
	["narrator-ui-summary", narratorId, generation] as const;
type SummaryKey = ReturnType<typeof narratorUiSummaryKey>;
const SUMMARY_STALE_TIME_MS = 30_000;

/** Shared authenticated reads are generation-scoped and need not wait for the profile. */
export function useNarratorUiScope() {
	return useSyncExternalStore(subscribeAuth, getAuthSnapshot, getAuthSnapshot);
}

const observers = new WeakMap<QueryClient, Map<string, { count: number; stop: () => void }>>();

/** One event owner for route, toolbar badge and terminal access observers combined. */
function observeSummary(qc: QueryClient, key: SummaryKey) {
	let entries = observers.get(qc);
	if (!entries) {
		entries = new Map();
		observers.set(qc, entries);
	}
	const identity = JSON.stringify(key);
	let entry = entries.get(identity);
	if (!entry) {
		const narratorId = key[1];
		const generation = key[2];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lastLegacyProbeAt = 0;
		const valid = () => getAuthSnapshot().generation === generation;
		const cancel = () => {
			void qc.cancelQueries({ queryKey: key, exact: true });
		};
		const invalidate = () => {
			if (!valid() || timer !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				if (valid()) void qc.invalidateQueries({ queryKey: key, exact: true });
			}, 100);
		};
		const patch = (update: (data: NarratorUiSummary) => NarratorUiSummary) => {
			const interruptedRead = qc.getQueryState(key)?.fetchStatus === "fetching";
			cancel(); // Cancel/revert first: an older HTTP snapshot must not replace the WS fact.
			if (qc.getQueryState(key)?.status === "error") {
				// A badge frame cannot restore a failed/denied HTTP authorization snapshot.
				invalidate();
				return;
			}
			const old = qc.getQueryData<NarratorUiSummary>(key);
			if (old)
				qc.setQueryData(key, update(old), {
					// A count/unread frame does not renew the HTTP ACL snapshot's freshness.
					updatedAt: qc.getQueryState(key)?.dataUpdatedAt,
				});
			if (!old || interruptedRead) invalidate();
		};
		const listener = narratorWSManager.addListener(
			{
				types: [
					"terminal_count_changed",
					"narrator_access_changed",
					"project_access_changed",
					"workspace_context_changed",
					"chat:unread_changed",
					"chat:read",
					"chat:room_created",
				],
			},
			(event) => {
				if (!valid()) return;
				const type = event.type as string;
				if (type === "chat:read" && event.userId !== getAuthSnapshot().userId) return;
				if (event.narratorId && event.narratorId !== narratorId) return;
				if (type === "terminal_count_changed") {
					if (
						Number.isSafeInteger(event.activeTerminalCount) &&
						(event.activeTerminalCount as number) >= 0
					)
						patch((old) => ({ ...old, activeTerminalCount: event.activeTerminalCount as number }));
					return;
				}
				const old = qc.getQueryData<NarratorUiSummary>(key);
				if (type === "chat:unread_changed" && old?.discussion.roomId === event.roomId) {
					if (Number.isSafeInteger(event.unread) && (event.unread as number) >= 0)
						patch((data) => ({
							...data,
							discussion: {
								...data.discussion,
								unread: event.unread as number,
								unreadCapped: false,
							},
						}));
					return;
				}
				if (type.startsWith("chat:")) {
					if (typeof event.roomId !== "string") return;
					if (type === "chat:room_created" && !event.narratorId) return;
					if (!event.narratorId && event.roomId !== old?.discussion.roomId) {
						// Legacy servers cannot identify an unknown room. Unrelated DMs must
						// not fan out into a GET for every open narrator on every badge frame.
						if (old?.discussion.roomId || !old) return;
						const state = qc.getQueryState(key);
						if (
							state?.fetchStatus !== "idle" ||
							Date.now() - Math.max(state.dataUpdatedAt, lastLegacyProbeAt) < SUMMARY_STALE_TIME_MS
						)
							return;
						lastLegacyProbeAt = Date.now();
					}
				}
				cancel();
				if (type.endsWith("access_changed") && old)
					qc.setQueryData(
						key,
						{ ...old, canWrite: false },
						{
							updatedAt: qc.getQueryState(key)?.dataUpdatedAt,
						},
					); // Unknown ACL is never allow.
				invalidate();
			},
		);
		const stopConnection = narratorWSManager.onConnectionChange((connected) => {
			if (connected) {
				cancel();
				invalidate();
			}
		});
		const stopRecovery = narratorWSManager.onControlPlaneRecovery(invalidate);
		entry = {
			count: 0,
			stop: () => {
				clearTimeout(timer);
				narratorWSManager.removeListener(listener);
				stopConnection();
				stopRecovery();
				cancel();
			},
		};
		entries.set(identity, entry);
	}
	entry.count++;
	return () => {
		if (--entry.count > 0) return;
		entry.stop();
		entries.delete(identity);
	};
}

export function useNarratorUiSummary(narratorId: string, enabled = true) {
	const qc = useQueryClient();
	const { hasToken, generation } = useNarratorUiScope();
	const active = enabled && !!narratorId && hasToken;
	const queryKey = narratorUiSummaryKey(narratorId, generation);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => {
			if (getAuthSnapshot().generation !== generation)
				throw new DOMException("Session changed", "AbortError");
			return getNarratorUiSummary(narratorId, { signal });
		},
		enabled: active,
		staleTime: SUMMARY_STALE_TIME_MS,
		refetchOnWindowFocus: true,
		gcTime: 60_000,
		retry: false,
		placeholderData: undefined,
	});
	useEffect(() => {
		if (!active) return;
		return observeSummary(qc, narratorUiSummaryKey(narratorId, generation));
	}, [qc, narratorId, generation, active]);
	return query;
}
