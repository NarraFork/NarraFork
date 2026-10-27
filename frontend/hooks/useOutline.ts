/**
 * Queries and live updates of the read-only outline pages.
 */
import type {
	OutlineBlockViewResponse,
	OutlineSpaceSummary,
	OutlineViewMode,
} from "@shared/outline-api";
import { OUTLINE_VIEW_LIMITS } from "@shared/outline-api";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../lib/api";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { OutlinePageSubscriptions } from "../lib/outline-page-subscription";

export { useOutlineEnabled } from "./useOutlineEnabled";

export const outlineKeys = {
	all: ["outline"] as const,
	spaces: () => ["outline", "spaces"] as const,
	space: (spaceId: string) => ["outline", "space", spaceId] as const,
	pages: (spaceId: string) => ["outline", "pages", spaceId] as const,
	blocks: (spaceId: string) => ["outline", "block", spaceId] as const,
	block: (spaceId: string, blockId: string, asOf: number | null, view: OutlineViewMode) =>
		["outline", "block", spaceId, blockId, asOf, view] as const,
	timeline: (spaceId: string, pageId: string) => ["outline", "timeline", spaceId, pageId] as const,
	history: (spaceId: string, blockId: string) => ["outline", "history", spaceId, blockId] as const,
	backlinks: (spaceId: string, blockId: string) =>
		["outline", "backlinks", spaceId, blockId] as const,
	search: (q: string, spaceId: string | null) => ["outline", "search", q, spaceId] as const,
};

export function useOutlineSpaces(enabled: boolean) {
	return useInfiniteQuery({
		queryKey: outlineKeys.spaces(),
		queryFn: ({ pageParam }) =>
			api.listOutlineSpaces({ cursor: pageParam, limit: OUTLINE_VIEW_LIMITS.defaultListPage }),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
	});
}

/** Creates the caller's personal space on first use; idempotent. */
export function useEnsurePersonalOutlineSpace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.ensurePersonalOutlineSpace(),
		onSuccess: (result) => {
			if (result.created) void queryClient.invalidateQueries({ queryKey: outlineKeys.spaces() });
		},
	});
}

export function useOutlineSpace(spaceId: string, enabled = true) {
	return useQuery({
		queryKey: outlineKeys.space(spaceId),
		queryFn: () => api.getOutlineSpace(spaceId),
		enabled,
		retry: false,
	});
}

export function useOutlinePages(spaceId: string, enabled = true) {
	return useInfiniteQuery({
		queryKey: outlineKeys.pages(spaceId),
		queryFn: ({ pageParam }) =>
			api.listOutlinePages(spaceId, {
				cursor: pageParam,
				limit: OUTLINE_VIEW_LIMITS.defaultListPage,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		retry: false,
	});
}

export function useOutlineBlock(
	spaceId: string,
	blockId: string,
	options: {
		asOf?: number;
		view: OutlineViewMode;
		/** Block budget: the live editor shows the blocks itself and reads only the root. */
		blocks?: number;
		enabled?: boolean;
	},
) {
	const { asOf, view, blocks } = options;
	return useQuery({
		queryKey: [...outlineKeys.block(spaceId, blockId, asOf ?? null, view), blocks ?? null],
		queryFn: () => api.getOutlineBlock(spaceId, blockId, { asOf, view, blocks }),
		enabled: options.enabled ?? true,
		retry: false,
		// A view as of a commit never changes; the current one is refreshed by the subscription.
		staleTime: asOf === undefined ? 0 : Number.POSITIVE_INFINITY,
		placeholderData: (previous) =>
			previous && previous.rootId === blockId && previous.space.id === spaceId
				? previous
				: undefined,
	});
}

export function useOutlineTimeline(spaceId: string, pageId: string | undefined) {
	return useInfiniteQuery({
		queryKey: outlineKeys.timeline(spaceId, pageId ?? ""),
		queryFn: ({ pageParam }) =>
			api.getOutlinePageCommits(spaceId, pageId as string, {
				before: pageParam,
				limit: OUTLINE_VIEW_LIMITS.defaultTimeline,
			}),
		initialPageParam: null as number | null,
		getNextPageParam: (page) => page.nextBefore,
		enabled: !!pageId,
		retry: false,
	});
}

export function useOutlineBlockHistory(spaceId: string, blockId: string, enabled: boolean) {
	return useInfiniteQuery({
		queryKey: outlineKeys.history(spaceId, blockId),
		queryFn: ({ pageParam }) =>
			api.getOutlineBlockHistory(spaceId, blockId, {
				before: pageParam,
				limit: OUTLINE_VIEW_LIMITS.defaultTimeline,
			}),
		initialPageParam: null as number | null,
		getNextPageParam: (page) => page.nextBefore,
		enabled,
		retry: false,
	});
}

export function useOutlineBacklinks(spaceId: string, blockId: string, enabled: boolean) {
	return useQuery({
		queryKey: outlineKeys.backlinks(spaceId, blockId),
		queryFn: () => api.getOutlineBacklinks(spaceId, blockId),
		enabled,
		retry: false,
	});
}

export function useOutlineSearch(q: string, spaceId: string | null, enabled: boolean) {
	const trimmed = q.trim();
	return useQuery({
		queryKey: outlineKeys.search(trimmed, spaceId),
		queryFn: () => api.searchOutline({ q: trimmed, spaceId: spaceId ?? undefined }),
		enabled: enabled && trimmed.length > 0,
		retry: false,
		placeholderData: (previous) => previous,
	});
}

/** Everything about one space's current state that a commit may have changed. */
export function invalidateOutlineSpace(queryClient: QueryClient, spaceId: string): void {
	void queryClient.invalidateQueries({
		queryKey: outlineKeys.blocks(spaceId),
		// Views as of a commit never change.
		predicate: (query) => query.queryKey[4] === null,
	});
	for (const kind of ["timeline", "history", "backlinks", "pages", "space"]) {
		void queryClient.invalidateQueries({ queryKey: ["outline", kind, spaceId] });
	}
}

export function useRevertOutlineCommit(spaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (commitId: string) => api.revertOutlineCommit(commitId),
		onSuccess: () => invalidateOutlineSpace(queryClient, spaceId),
	});
}

let sharedSubscriptions: OutlinePageSubscriptions | null = null;

function pageSubscriptions(): OutlinePageSubscriptions {
	sharedSubscriptions ??= new OutlinePageSubscriptions(narratorWSManager);
	return sharedSubscriptions;
}

/**
 * Keep a page's current view fresh: subscribe to the page over the narrator socket and re-read
 * whenever the space moved past what is shown. Losing access re-reads too, so the page shows
 * the server's answer (not found) rather than stale content.
 */
export function useOutlinePageLive(
	view: Pick<OutlineBlockViewResponse, "pageId" | "seq" | "current" | "space"> | undefined,
): void {
	const queryClient = useQueryClient();
	const spaceId = view?.space.id;
	const pageId = view?.pageId;
	const shownSeq = useRef(-1);
	// The newest seq the shown state is known to include (a view as of a commit includes up to
	// the space's last commit as of the read).
	shownSeq.current = Math.max(view?.seq ?? -1, view?.space.lastSeq ?? -1);
	useEffect(() => {
		if (!spaceId || !pageId) return;
		return pageSubscriptions().subscribe(pageId, (hint) => {
			if (hint.kind === "subscribed" || hint.kind === "changed") {
				if (hint.seq > shownSeq.current) {
					shownSeq.current = hint.seq;
					invalidateOutlineSpace(queryClient, spaceId);
				}
			} else if (hint.kind === "denied") {
				invalidateOutlineSpace(queryClient, spaceId);
			}
		});
	}, [spaceId, pageId, queryClient]);
}

/**
 * Open the outline space of a project or a session: resolves it (creating it when the caller
 * may write it) and navigates there, or hands it to `onOpen` (a session opens it in a panel).
 * `onMissing` runs when the space does not exist yet and the caller may not create it;
 * `onError` when resolving fails.
 */
export function useOpenOutlineSpace(callbacks: {
	onMissing: () => void;
	onError: (error: unknown) => void;
	onOpen?: (space: OutlineSpaceSummary) => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { onMissing, onError, onOpen } = callbacks;
	const mutation = useMutation({
		mutationFn: (target: { kind: "project" | "narrator"; id: string }) =>
			target.kind === "project"
				? api.resolveProjectOutlineSpace(target.id)
				: api.resolveNarratorOutlineSpace(target.id),
		onSuccess: (result) => {
			const space: OutlineSpaceSummary | null = result.space;
			if (!space) {
				onMissing();
				return;
			}
			if (result.created) void queryClient.invalidateQueries({ queryKey: outlineKeys.spaces() });
			if (onOpen) onOpen(space);
			else void navigate({ to: "/outline/$spaceId", params: { spaceId: space.id } });
		},
		onError,
	});
	const open = useCallback(
		(kind: "project" | "narrator", id: string) => mutation.mutate({ kind, id }),
		[mutation.mutate],
	);
	return { open, pending: mutation.isPending };
}
