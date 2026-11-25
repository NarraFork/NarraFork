import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { getToken, onTokenChange } from "../lib/api/client";
import { getNarratorUiSummary, type NarratorUiSummary } from "../lib/api/narrator-ui-summary";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { useCurrentUser } from "./useCurrentUser";

export const narratorUiSummaryKey = (
	narratorId: string,
	userId: string | null,
	token: string | null,
) => ["narrator-ui-summary", narratorId, userId, token] as const;
type SummaryKey = ReturnType<typeof narratorUiSummaryKey>;
const SUMMARY_STALE_TIME_MS = 30_000;

function subscribeSession(listener: () => void) {
	const stop = onTokenChange(listener);
	const storage = (event: StorageEvent) => {
		if (event.key === "narrafork_token" || event.key === null) listener();
	};
	if (typeof window !== "undefined") window.addEventListener("storage", storage);
	return () => {
		stop();
		if (typeof window !== "undefined") window.removeEventListener("storage", storage);
	};
}

/** Identity is part of both summary and terminal-entity caches; no cross-account placeholder. */
export function useNarratorUiScope() {
	const token = useSyncExternalStore(subscribeSession, getToken, () => null);
	const { data: user } = useCurrentUser();
	return { token, userId: (user?.id as string | undefined) ?? null };
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
		const token = key[3];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lastLegacyProbeAt = 0;
		const valid = () => getToken() === token;
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
				if (type === "chat:read" && event.userId !== key[2]) return;
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
	const { userId, token } = useNarratorUiScope();
	const active = enabled && !!narratorId && !!userId && !!token;
	const queryKey = narratorUiSummaryKey(narratorId, userId, token);
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) => getNarratorUiSummary(narratorId, { signal }),
		enabled: active,
		staleTime: SUMMARY_STALE_TIME_MS,
		refetchOnWindowFocus: true,
		gcTime: 60_000,
		retry: false,
		placeholderData: undefined,
	});
	useEffect(() => {
		if (!active) return;
		return observeSummary(qc, narratorUiSummaryKey(narratorId, userId, token));
	}, [qc, narratorId, userId, token, active]);
	return query;
}
