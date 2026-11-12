/**
 * Queries and live updates of the read-only outline pages.
 */

import type {
	OutlineAnswerHttpInput,
	OutlineBlockViewResponse,
	OutlineQuestionGroupResponse,
	OutlineSpaceSummary,
	OutlineViewMode,
} from "@shared/outline-api";
import {
	OUTLINE_BLOCK_ID_RE,
	OUTLINE_REPORT_AUTHORS_API_LIMITS,
	OUTLINE_VIEW_LIMITS,
	OUTLINE_VIEW_STATE_LIMITS,
} from "@shared/outline-api";
import { boundedFoldView } from "@shared/outline-fold";
import {
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { OutlineViewState } from "../components/outline/view-state";
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
	pagePending: (spaceId: string, pageId: string) =>
		["outline", "pending", spaceId, pageId] as const,
	pending: (pendingId: string) => ["outline", "pending-detail", pendingId] as const,
	questions: (blockId: string) => ["outline", "questions", blockId] as const,
	digest: () => ["outline", "digest"] as const,
	tree: () => ["outline", "tree"] as const,
	treeSpaces: (group: string) => ["outline", "tree", group] as const,
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

/**
 * The connected outline's root (`/outline/tree`): my space and the project spaces, a page at a
 * time. Not refreshed by commits: the tree does not reorder while it is read (design §4.2).
 */
export function useOutlineTree(enabled = true) {
	return useInfiniteQuery({
		queryKey: outlineKeys.tree(),
		queryFn: ({ pageParam }) => api.getOutlineTree({ cursor: pageParam }),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		retry: false,
	});
}

/** A group of the connected outline (a project's sessions, the loose ones, the orphaned). */
export function useOutlineTreeSpaces(
	group: { kind: "project"; projectId: string } | { kind: "loose" | "orphaned" },
	enabled: boolean,
) {
	return useInfiniteQuery({
		queryKey: outlineKeys.treeSpaces(
			group.kind === "project" ? `project:${group.projectId}` : group.kind,
		),
		queryFn: ({ pageParam }) => api.listOutlineTreeSpaces(group, { cursor: pageParam }),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		enabled,
		retry: false,
	});
}

/** Creates the caller's personal space on first use; idempotent. */
export function useEnsurePersonalOutlineSpace() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.ensurePersonalOutlineSpace(),
		onSuccess: (result) => {
			if (result.created) {
				void queryClient.invalidateQueries({ queryKey: outlineKeys.spaces() });
				void queryClient.invalidateQueries({ queryKey: outlineKeys.tree() });
			}
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
		/** Byte budget (the server's default when absent). */
		bytes?: number;
		enabled?: boolean;
		/**
		 * Keep showing the previous read of the same space while another block loads: the live
		 * editor moves its focus at once and only the toolbar's details wait for the read.
		 */
		keepSpace?: boolean;
	},
) {
	const { asOf, view, blocks, bytes, keepSpace } = options;
	return useQuery({
		queryKey: [
			...outlineKeys.block(spaceId, blockId, asOf ?? null, view),
			blocks ?? null,
			...(bytes !== undefined ? [bytes] : []),
		],
		queryFn: () => api.getOutlineBlock(spaceId, blockId, { asOf, view, blocks, bytes }),
		enabled: options.enabled ?? true,
		retry: false,
		// A view as of a commit never changes; the current one is refreshed by the subscription.
		staleTime: asOf === undefined ? 0 : Number.POSITIVE_INFINITY,
		placeholderData: (previous) =>
			previous &&
			previous.space.id === spaceId &&
			(previous.rootId === blockId || (keepSpace && previous.current))
				? previous
				: undefined,
	});
}

/**
 * The read a live page is shown from before its session is live (read-only first, design
 * §6.10): the focused block and everything under it, tasks included (the editor's lens hides
 * them like the live page does), as many blocks as one read gives. Not kept long: once the page
 * is live nothing reads it.
 */
export function useOutlineSeed(
	spaceId: string,
	blockId: string,
	enabled: boolean,
	onRead?: (read: OutlineBlockViewResponse) => void,
) {
	return useQuery({ ...outlineSeedQuery(spaceId, blockId, onRead), enabled, retry: false });
}

function outlineSeedQuery(
	spaceId: string,
	blockId: string,
	onRead?: (read: OutlineBlockViewResponse) => void,
) {
	return {
		queryKey: [...outlineKeys.block(spaceId, blockId, null, "all"), OUTLINE_VIEW_LIMITS.maxBlocks],
		queryFn: async () => {
			const read = await api.getOutlineBlock(spaceId, blockId, {
				view: "all",
				blocks: OUTLINE_VIEW_LIMITS.maxBlocks,
			});
			// As soon as it arrives (before any render): the page's session takes it.
			onRead?.(read);
			return read;
		},
		staleTime: 0,
		gcTime: 30_000,
	};
}

/**
 * Start the read of a place about to be shown (the quick switcher's pick), so it is on its way
 * before the surface switches pages.
 */
export function prefetchOutlineSeed(
	queryClient: QueryClient,
	spaceId: string,
	blockId: string,
	onRead?: (read: OutlineBlockViewResponse) => void,
) {
	void queryClient.prefetchQuery({ ...outlineSeedQuery(spaceId, blockId, onRead), retry: false });
}

/** Views states whose stored folding was read already (once per surface and page). */
const loadedViewStates = new WeakSet<OutlineViewState>();

/**
 * Keep a surface's folding and mind-map direction of a page in step with the person's stored
 * view state (`/api/outline/view-state/:pageId`, design §7.1): read once when the page is first
 * shown (unless the person already folded something here), and written back, debounced, after
 * every change. Failures are quiet: the view state is the person's convenience, kept locally.
 */
export function useOutlineViewStateSync(
	pageId: string | undefined,
	state: OutlineViewState | null,
): void {
	useEffect(() => {
		if (!pageId || !state || state.pageId !== pageId) return;
		let disposed = false;
		let touched = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const write = () => {
			timer = null;
			// Block ids only (the server refuses anything else); the last write of the page wins.
			// What the reader opened and what they closed share one limit.
			const ok = (ids: Iterable<string>) =>
				new Set([...ids].filter((id) => OUTLINE_BLOCK_ID_RE.test(id)));
			const folding = boundedFoldView(
				{ expanded: ok(state.expanded), collapsed: ok(state.collapsed) },
				OUTLINE_VIEW_STATE_LIMITS.maxCollapsed,
			);
			void api
				.putOutlineViewState(pageId, { ...folding, layout: state.layout })
				.catch(() => undefined);
		};
		const off = state.on((part) => {
			if (part !== "collapsed" && part !== "layout") return;
			touched = true;
			if (timer) clearTimeout(timer);
			timer = setTimeout(write, OUTLINE_VIEW_STATE_LIMITS.writeDebounceMs);
		});
		if (!loadedViewStates.has(state)) {
			loadedViewStates.add(state);
			api
				.getOutlineViewState(pageId)
				.then((stored) => {
					if (disposed || touched || stored.updatedAt === null) return;
					state.applyStored(stored.collapsed, stored.expanded ?? [], stored.layout);
				})
				.catch(() => loadedViewStates.delete(state));
		}
		return () => {
			disposed = true;
			off();
			if (timer) {
				clearTimeout(timer);
				write();
			}
		};
	}, [pageId, state]);
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
	for (const kind of ["timeline", "history", "backlinks", "pages", "space", "pending"]) {
		void queryClient.invalidateQueries({ queryKey: ["outline", kind, spaceId] });
	}
	void queryClient.invalidateQueries({ queryKey: ["outline", "pending-detail"] });
	void queryClient.invalidateQueries({ queryKey: ["outline", "questions"] });
}

/** A question root, or all questions under a task. */
function outlineQuestionsQuery(blockId: string) {
	return {
		queryKey: outlineKeys.questions(blockId),
		queryFn: () => api.getOutlineQuestions(blockId),
		retry: false as const,
		staleTime: 5_000,
	};
}

export function useOutlineQuestions(blockId: string | null, enabled = true) {
	return useQuery({ ...outlineQuestionsQuery(blockId ?? ""), enabled: enabled && !!blockId });
}

/** An Ask card reads its own roots, never an older task's entire question history. */
export function useOutlineQuestionGroups(blockIds: readonly string[]) {
	return useQueries({ queries: [...new Set(blockIds)].map(outlineQuestionsQuery) });
}

/** Share the existing page subscriptions with the editor; no polling or second socket. */
export function useOutlineQuestionsLive(groups: readonly OutlineQuestionGroupResponse[]) {
	const client = useQueryClient();
	const pages = JSON.stringify([
		...new Map(groups.map(({ group }) => [group.pageId, [group.pageId, group.spaceId]])).values(),
	]);
	useEffect(() => {
		const unsubscribe = (JSON.parse(pages) as [string, string][]).map(([pageId, spaceId]) => {
			let seen = -1;
			return pageSubscriptions().subscribe(pageId, (hint) => {
				if (
					hint.kind === "denied" ||
					((hint.kind === "subscribed" || hint.kind === "changed") && hint.seq > seen)
				) {
					if (hint.kind !== "denied") seen = hint.seq;
					invalidateOutlineSpace(client, spaceId);
					void client.invalidateQueries({ queryKey: ["human-attention"] });
				}
			});
		});
		return () => {
			for (const dispose of unsubscribe) dispose();
		};
	}, [client, pages]);
}

/** Answer questions of one space at once; questions, views and the inbox re-read after. */
export function useAnswerOutlineQuestions(spaceId: string | null) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (answers: OutlineAnswerHttpInput[]) => api.answerOutlineQuestions({ answers }),
		onSettled: () => {
			if (spaceId) invalidateOutlineSpace(queryClient, spaceId);
			void queryClient.invalidateQueries({ queryKey: ["outline", "questions"] });
			void queryClient.invalidateQueries({ queryKey: ["human-attention"] });
		},
	});
}

/** What agents confirmed on the person's behalf that they have not acknowledged. */
export function useOutlineDigest(enabled = true) {
	return useQuery({
		queryKey: outlineKeys.digest(),
		queryFn: () => api.getOutlineDigest(),
		enabled,
		retry: false,
	});
}

/** Acknowledge confirmations in the digest. */
export function useMarkOutlineDigestSeen() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (pendingIds: string[]) => api.markOutlineDigestSeen(pendingIds),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: outlineKeys.digest() });
			void queryClient.invalidateQueries({ queryKey: ["human-attention"] });
		},
	});
}

/** Mark all unread reports read (P2 PR 11): the inbox row's "Got it". */
export function useMarkOutlineReportsSeen() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => api.markOutlineReportsSeen(),
		onSettled: () => {
			void queryClient.invalidateQueries({ queryKey: ["human-attention"] });
		},
	});
}

/** What waits for confirmation on a page, and its locked tasks (design §2.2, §2.6). */
export function useOutlinePagePending(spaceId: string, pageId: string | undefined, enabled = true) {
	return useQuery({
		queryKey: outlineKeys.pagePending(spaceId, pageId ?? ""),
		queryFn: () => api.getOutlinePagePending(spaceId, pageId as string),
		enabled: enabled && !!pageId,
		// The live editor folds by the unanswered questions in it: a failed read is tried again.
		retry: 2,
		staleTime: 5_000,
	});
}

/**
 * Who wrote the subagent reports with these container ids, for a reader who may be told: the
 * live editor's report lines say 「来自 …」. At most the first
 * {@link OUTLINE_REPORT_AUTHORS_API_LIMITS.maxIds} containers are asked for (the rest show the
 * time alone); a session's title rarely changes, so the answer is kept for a while.
 */
export function useOutlineReportAuthors(spaceId: string, ids: readonly string[], enabled = true) {
	const asked = ids.slice(0, OUTLINE_REPORT_AUTHORS_API_LIMITS.maxIds);
	return useQuery({
		queryKey: [...outlineKeys.all, "report-authors", spaceId, asked.join(",")],
		queryFn: async () => (await api.getOutlineReportAuthors(spaceId, asked)).authors,
		enabled: enabled && asked.length > 0,
		retry: false,
		staleTime: 60_000,
	});
}

/** One pending change block by block. */
export function useOutlinePendingDetail(pendingId: string | null) {
	return useQuery({
		queryKey: outlineKeys.pending(pendingId ?? ""),
		queryFn: () => api.getOutlinePending(pendingId as string),
		enabled: !!pendingId,
		retry: false,
	});
}

/** Confirm or reject a pending change; the page's summaries and views re-read after. */
export function useDecideOutlinePending(spaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { pendingId: string; decision: "confirm" | "reject"; reason?: string }) =>
			input.decision === "confirm"
				? api.confirmOutlinePending(input.pendingId)
				: api.rejectOutlinePending(input.pendingId, input.reason?.trim() || null),
		onSettled: () => invalidateOutlineSpace(queryClient, spaceId),
	});
}

/** Lock (with an optional delegate session) or unlock a task's tree. */
export function useOutlineLock(spaceId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: { blockId: string; lock: boolean; delegate?: string | null }) =>
			input.lock
				? api.lockOutlineBlock(spaceId, input.blockId, input.delegate ?? null)
				: api.unlockOutlineBlock(spaceId, input.blockId),
		onSettled: () => invalidateOutlineSpace(queryClient, spaceId),
	});
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
			} else if (hint.kind === "pending") {
				void queryClient.invalidateQueries({ queryKey: outlineKeys.pagePending(spaceId, pageId) });
				void queryClient.invalidateQueries({ queryKey: ["outline", "pending-detail"] });
				void queryClient.invalidateQueries({ queryKey: outlineKeys.blocks(spaceId) });
			}
		});
	}, [spaceId, pageId, queryClient]);
}

/** How long a burst of commits is gathered before the plan's diff is read again. */
const PLAN_DIFF_REFRESH_MS = 300;

/**
 * A submitted plan against the version it is compared with (outline P2 PR 8), kept fresh while
 * shown: its page is subscribed to, and a commit past what is shown reads it again (the person may
 * be editing the plan in the outline beside the session).
 *
 * At most one read per burst (review round 1 N6): hints only raise the newest seq wanted, and a
 * short timer compares it with what is shown once no read is in flight, so the subscription's
 * first hint does not restart the first read and a live flush's commits share one refetch. The
 * space-wide invalidation leaves this query to its own subscription.
 */
export function useOutlinePlanDiff(
	plan: { spaceId: string; pageId: string; blockId: string; from: number },
	enabled: boolean,
) {
	const queryClient = useQueryClient();
	const { spaceId, pageId, blockId, from } = plan;
	const query = useQuery({
		queryKey: ["outline", "plan-diff", spaceId, blockId, from],
		queryFn: () => api.getOutlinePlanDiff(spaceId, blockId, from),
		enabled,
		retry: false,
		staleTime: 5_000,
	});
	const state = useRef({ wanted: -1, shown: -1, fetching: false });
	state.current.shown = query.data?.toSeq ?? -1;
	state.current.fetching = query.isFetching;
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const check = () => {
			timer = null;
			const s = state.current;
			if (s.wanted <= s.shown) return;
			// A read in flight may already include the newest commit: look again once it lands.
			if (s.fetching) {
				timer = setTimeout(check, PLAN_DIFF_REFRESH_MS);
				return;
			}
			void queryClient.invalidateQueries({
				queryKey: ["outline", "plan-diff", spaceId, blockId],
			});
		};
		const unsubscribe = pageSubscriptions().subscribe(pageId, (hint) => {
			if (hint.kind !== "changed" && hint.kind !== "subscribed") return;
			if (hint.seq <= state.current.wanted) return;
			state.current.wanted = hint.seq;
			timer ??= setTimeout(check, PLAN_DIFF_REFRESH_MS);
		});
		return () => {
			unsubscribe();
			if (timer !== null) clearTimeout(timer);
		};
	}, [enabled, pageId, spaceId, blockId, queryClient]);
	return query;
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
