import type { HumanAttentionItem, HumanAttentionPage } from "@shared/human-attention";
import {
	HUMAN_ATTENTION_CHANGED_WS_TYPE,
	HUMAN_ATTENTION_DEFAULT_PAGE_SIZE,
} from "@shared/human-attention";
import {
	type QueryClient,
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";
import { ApiError } from "../lib/api/client";
import { narratorWSManager } from "../lib/narrator-ws-manager";

export const humanAttentionQueryKey = ["human-attention"] as const;
export const humanAttentionListKey = [...humanAttentionQueryKey, "list"] as const;
export const humanAttentionDetailKey = (id: string) => [...humanAttentionQueryKey, "detail", id];

export function isAttentionGone(error: unknown) {
	return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

/** One listener per QueryClient, not per composer/drawer/dashboard mount. No tab subscriptions. */
const listeners = new WeakMap<QueryClient, { users: number; dispose: () => void }>();
const changeTypes = [
	HUMAN_ATTENTION_CHANGED_WS_TYPE,
	"narrator_access_changed",
	"project_access_changed",
	"narrator_deleted",
	"narrators_deleted",
	"chapter_deleted",
	"project_deleted",
];

function retainListener(client: QueryClient) {
	let entry = listeners.get(client);
	if (!entry) {
		let queued = false;
		let disposed = false;
		const invalidate = () => {
			if (queued || disposed) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				if (!disposed) void client.invalidateQueries({ queryKey: humanAttentionQueryKey });
			});
		};
		const handle = narratorWSManager.addListener({ types: changeTypes }, invalidate);
		const offConnection = narratorWSManager.onConnectionChange((connected) => {
			// Also close the first-HTTP-load → first-WebSocket-connect race window.
			if (connected) invalidate();
		});
		entry = {
			users: 0,
			dispose: () => {
				disposed = true;
				narratorWSManager.removeListener(handle);
				offConnection();
			},
		};
		listeners.set(client, entry);
	}
	entry.users++;
	return () => {
		if (--entry.users === 0) {
			entry.dispose();
			listeners.delete(client);
		}
	};
}

/** Summaries only. A next cursor means the displayed count is a lower bound. */
export function useHumanAttention(enabled = true) {
	const client = useQueryClient();
	useEffect(() => (enabled ? retainListener(client) : undefined), [client, enabled]);
	return useInfiniteQuery({
		queryKey: humanAttentionListKey,
		queryFn: ({ pageParam, signal }) =>
			api.getHumanAttention(
				{ cursor: pageParam ?? undefined, limit: HUMAN_ATTENTION_DEFAULT_PAGE_SIZE },
				signal,
			),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		enabled,
		staleTime: 30_000,
		retry: false,
	});
}

export function useHumanAttentionDetail(id: string, enabled = true) {
	const client = useQueryClient();
	const query = useQuery({
		queryKey: humanAttentionDetailKey(id),
		queryFn: ({ signal }) => api.getHumanAttentionDetail(id, signal),
		enabled,
		staleTime: 0,
		gcTime: 30_000,
		retry: false,
	});
	useEffect(() => {
		// Never invalidate this failed detail again: that would create a 404 refetch loop.
		if (enabled && isAttentionGone(query.error)) {
			void client.invalidateQueries({ queryKey: humanAttentionListKey });
		}
	}, [client, enabled, query.error]);
	return query;
}

export function loadedHumanAttentionItems(pages: readonly HumanAttentionPage[] = []) {
	const byId = new Map<string, HumanAttentionItem>();
	for (const page of pages) for (const item of page.items) byId.set(item.id, item);
	return [...byId.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export function groupHumanAttentionByScope<
	T extends {
		narratorId: string;
		parentNarratorId?: string | null;
		rootNarratorId?: string | null;
	},
>(items: readonly T[], currentNarratorId?: string): { current: T[]; others: T[] } {
	const current: T[] = [];
	const others: T[] = [];
	for (const item of items) {
		const isCurrent =
			currentNarratorId &&
			[item.narratorId, item.parentNarratorId, item.rootNarratorId].includes(currentNarratorId);
		(isCurrent ? current : others).push(item);
	}
	return { current, others };
}

/** Success AND failure reconcile the authority; never optimistically remove a decision. */
export function invalidateHumanAttentionDecision(client: QueryClient, item: HumanAttentionItem) {
	const ids = new Set([item.narratorId, item.parentNarratorId, item.rootNarratorId]);
	return Promise.all([
		client.invalidateQueries({ queryKey: humanAttentionQueryKey }),
		client.invalidateQueries({ queryKey: ["async-questions", "all"], exact: true }),
		...[...ids]
			.filter((id): id is string => !!id)
			.flatMap((id) => [
				client.invalidateQueries({ queryKey: ["async-questions", id], exact: true }),
				client.invalidateQueries({ queryKey: ["permissions", id] }),
				client.invalidateQueries({ queryKey: ["narrators", id] }),
			]),
	]);
}
