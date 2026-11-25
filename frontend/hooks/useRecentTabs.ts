import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	applyRecentTabFolderDissolve,
	applyRecentTabMove,
	applyRecentTabPin,
	applyRecentTabRemove,
	isFolderTab,
	regroupFolders,
	unitRange,
} from "@shared/recent-tab-layout";
import type {
	PersistedRecentTab,
	RecentTabsDelta as RecentTabsDeltaFrame,
	RecentTabsOperation,
	RecentTabsSection,
} from "@shared/recent-tabs";
import { RECENT_TABS_PAGE_SIZE, RECENT_TABS_STALE_CURSOR_CODE } from "@shared/recent-tabs";
import {
	type InfiniteData,
	type QueryClient,
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { type ComponentType, createElement, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, api } from "../lib/api";
import type {
	RecentTabFolderPatch,
	RecentTabMoveTarget,
	RecentTabsMutationResponse,
	RecentTabsPageResponse,
} from "../lib/api/settings";
import { queryClient as globalQC } from "../lib/query-client";
import {
	getRecentTabsScope,
	isRecentTabsScopeCurrent,
	type RecentTabsScope,
	recentTabsFlatQueryKey,
	recentTabsScopeKey,
	recentTabsSectionQueryKey,
	requireRecentTabsScope,
	useRecentTabsScope,
} from "../lib/recent-tabs-owner";
import { invalidateNarratorGitIdentities } from "./git-identity-query-keys";
import type { AddRecentTabInput, RecentTab, SubagentRecentTabInput } from "./recent-tabs-utils";
import {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	clampRecentTabText,
	mergeRecentTabPatch,
	mergeRecentTabRuntime,
	normalizeRecentTab,
	recentTabVisitSignature,
} from "./recent-tabs-utils";

export {
	RECENT_TABS_QUERY_KEY,
	recentTabsFlatQueryKey,
	recentTabsSectionQueryKey,
} from "../lib/recent-tabs-owner";
export type {
	AddRecentTabInput,
	ReadonlyRecentTabRuntimeVersions,
	RecentTab,
	RecentTabRuntimeVersions,
	RecentTabViewer,
	SubagentRecentTabInput,
	SubagentRecentTabPreferenceState,
} from "./recent-tabs-utils";
export {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	bumpRecentTabRuntimeVersions,
	clampRecentTabText,
	isRecentTabBackgroundActive,
	isSameRecentTab,
	mergeRecentTabPatch,
	mergeRecentTabRuntime,
	normalizeRecentTab,
	normalizeRecentTabViewers,
	pruneRecentTabsRuntimeVersions,
	RECENT_TAB_TEXT_MAX_CHARS,
	recentTabVisitSignature,
	reconcileRecentTabsRuntimePatches,
	selectRecentTabsLiveWindow,
	shouldAddSubagentRecentTab,
	snapshotRecentTabRuntimeVersions,
} from "./recent-tabs-utils";

/** One-tab pin reads are separate from page queries but share their complete access scope. */
const recentTabStateScopeKey = (scope: RecentTabsScope | null) =>
	[
		"user-preferences",
		"recent-tab-state",
		scope?.userId ?? null,
		scope?.authGeneration ?? null,
		scope?.accessGeneration ?? null,
	] as const;
export const recentTabStateQueryKey = (scope: RecentTabsScope | null, key: string) =>
	[...recentTabStateScopeKey(scope), key] as const;

/** Mark touched pin states stale, or all current-scope pin states after a gap/reconnect. */
export function invalidateRecentTabStates(
	qc: QueryClient,
	scope: RecentTabsScope | null,
	keys?: readonly string[],
): void {
	if (!isRecentTabsScopeCurrent(scope) || keys?.length === 0) return;
	const queryKey = recentTabStateScopeKey(scope);
	const touched = keys ? new Set(keys) : undefined;
	void qc.invalidateQueries({
		queryKey,
		predicate: touched
			? (query) => touched.has(String(query.queryKey[queryKey.length]))
			: undefined,
	});
}
const RECENT_TABS_QUERY_GC_TIME_MS = 60_000;
const RECENT_TABS_REFRESH_DEDUPE_MS = 500;
const loadedWindowRefreshes = new WeakMap<
	QueryClient,
	{
		scope: RecentTabsScope;
		startedAt: number;
		reset: boolean;
		minimumRevision: number;
		promise: Promise<void>;
	}
>();
const loadedWindowRefreshGenerations = new WeakMap<QueryClient, number>();

const UNDO_NOTIFICATION_ID = "recent-tabs-undo";
const UNDO_AUTO_CLOSE_MS = 6_000;

export type RecentTabsInfiniteData = InfiniteData<RecentTabsPageResponse>;

export interface RecentTabsDelta {
	baseRevision?: number;
	revision: number;
	operations: RecentTabsOperation[];
}

export type RecentTabsDeltaBatchState = Map<
	number,
	{
		baseRevision: number;
		batchCount: number;
		batches: Map<number, RecentTabsOperation[]>;
	}
>;

export type RecentTabsDeltaCollectionResult =
	| { status: "pending" }
	| { status: "gap" }
	| { status: "complete"; delta: RecentTabsDelta };

export function collectRecentTabsDeltaFrame(
	state: RecentTabsDeltaBatchState,
	frame: RecentTabsDeltaFrame,
): RecentTabsDeltaCollectionResult {
	for (const pendingRevision of state.keys()) {
		if (pendingRevision < frame.revision) {
			state.clear();
			return { status: "gap" };
		}
	}
	if (
		frame.batchIndex < 0 ||
		frame.batchIndex >= frame.batchCount ||
		!Number.isInteger(frame.batchIndex) ||
		!Number.isInteger(frame.batchCount) ||
		frame.batchCount < 1
	) {
		state.clear();
		return { status: "gap" };
	}
	if (frame.batchCount === 1) {
		return {
			status: "complete",
			delta: {
				baseRevision: frame.baseRevision,
				revision: frame.revision,
				operations: frame.operations,
			},
		};
	}
	let pending = state.get(frame.revision);
	if (
		pending &&
		(pending.baseRevision !== frame.baseRevision || pending.batchCount !== frame.batchCount)
	) {
		state.clear();
		return { status: "gap" };
	}
	if (!pending) {
		pending = {
			baseRevision: frame.baseRevision,
			batchCount: frame.batchCount,
			batches: new Map(),
		};
		state.set(frame.revision, pending);
	}
	pending.batches.set(frame.batchIndex, frame.operations);
	if (pending.batches.size < pending.batchCount) return { status: "pending" };

	const operations: RecentTabsOperation[] = [];
	for (let index = 0; index < pending.batchCount; index++) {
		const batch = pending.batches.get(index);
		if (!batch) return { status: "pending" };
		operations.push(...batch);
	}
	state.delete(frame.revision);
	return {
		status: "complete",
		delta: { baseRevision: frame.baseRevision, revision: frame.revision, operations },
	};
}

export interface RecentTabsSectionState {
	tabs: RecentTab[];
	revision: number;
	hasMore: boolean;
	isLoading: boolean;
	isError: boolean;
	isFetchingNextPage: boolean;
	loadMore: () => void;
	retry: () => void;
}

function tabKey(tab: Pick<RecentTab, "type" | "id">): string {
	return `${tab.type}:${tab.id}`;
}

/**
 * Every tab lives in the sidebar's one list, `work`: sessions, folders, and pinned projects and
 * teams alike (the server converts what the retired `projects` section held). The `projects`
 * window is still read, and stays empty.
 */
export function recentTabSection(_tab: Pick<RecentTab, "type">): RecentTabsSection {
	return "work";
}

function sectionFromKey(_key: string): RecentTabsSection {
	return "work";
}

function flattenPages(data: RecentTabsInfiniteData | undefined): RecentTab[] {
	return (
		data?.pages.flatMap((page) => page.items.map((tab) => normalizeRecentTab(tab as RecentTab))) ??
		[]
	);
}

export function recentTabsDataRevision(
	data: RecentTabsInfiniteData | undefined,
): number | undefined {
	const pages = data?.pages;
	const firstRevision = pages?.[0]?.revision;
	if (firstRevision === undefined || !pages) return undefined;
	return pages.every((page) => page.revision === firstRevision) ? firstRevision : undefined;
}

function dataRevision(data: RecentTabsInfiniteData | undefined): number {
	return recentTabsDataRevision(data) ?? 0;
}

/** True when a rebuilt window is field-for-field the object the cache already holds. */
function isSameLoadedWindow(
	previous: RecentTabsInfiniteData,
	next: RecentTabsInfiniteData,
): boolean {
	if (previous === next) return true;
	if (previous.pages.length !== next.pages.length) return false;
	return previous.pages.every((page, index) => {
		const nextPage = next.pages[index];
		if (
			page.revision !== nextPage.revision ||
			page.hasMore !== nextPage.hasMore ||
			page.nextCursor !== nextPage.nextCursor ||
			page.items.length !== nextPage.items.length
		) {
			return false;
		}
		// Item identity, not deep equality: every producer here already returns the
		// previous tab object when a patch changed nothing.
		return page.items.every((item, itemIndex) => item === nextPage.items[itemIndex]);
	});
}

function replaceLoadedTabs(
	data: RecentTabsInfiniteData,
	tabs: RecentTab[],
	revision?: number,
): RecentTabsInfiniteData {
	const previousCount = data.pages.reduce((count, page) => count + page.items.length, 0);
	const lastPage = data.pages.at(-1);
	const capacity = data.pages.length * RECENT_TABS_PAGE_SIZE;
	let visibleCount = Math.min(
		tabs.length,
		Math.max(previousCount, Math.min(tabs.length, capacity)),
	);
	// Never cut a folder in half: the server pages by top-level unit, so a folder's members
	// always travel with it. Keep the rest of a folder the cut would have split.
	if (visibleCount > 0 && visibleCount < tabs.length) {
		visibleCount = unitRange(tabs, visibleCount - 1).end + 1;
	}
	const visible = tabs.slice(0, visibleCount);
	let offset = 0;
	const pages = data.pages.map((page, pageIndex) => {
		const remaining = visible.length - offset;
		const size =
			pageIndex === data.pages.length - 1
				? Math.max(0, remaining)
				: Math.min(RECENT_TABS_PAGE_SIZE, Math.max(0, remaining));
		const items = visible.slice(offset, offset + size);
		offset += size;
		return {
			...page,
			items,
			...(revision !== undefined ? { revision } : {}),
			...(pageIndex === data.pages.length - 1 && lastPage
				? { hasMore: lastPage.hasMore, nextCursor: lastPage.nextCursor }
				: {}),
		};
	});
	const next = { ...data, pages };
	// Returning the SAME object when nothing moved is what lets React Query skip the
	// notification. Without it, a runtime tick that changed no field still allocated a
	// new window object and re-rendered every consumer of the recent-tabs cache
	// (the app shell, the sidebar lists, the graph) — the identity preservation inside
	// `mergeRecentTabPatch` was being thrown away one layer up.
	return isSameLoadedWindow(data, next) ? data : next;
}

function updateSectionData(
	qc: QueryClient,
	scope: RecentTabsScope,
	section: RecentTabsSection,
	updater: (tabs: RecentTab[], data: RecentTabsInfiniteData) => RecentTab[],
	revision?: number,
): void {
	qc.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, section), (data) => {
		if (!data) return data;
		return replaceLoadedTabs(
			data,
			updater(flattenPages(data), data),
			revision ?? recentTabsDataRevision(data),
		);
	});
}

function sameTabList(previous: RecentTab[] | undefined, next: RecentTab[]): boolean {
	if (previous === next) return true;
	if (!previous || previous.length !== next.length) return false;
	return previous.every((tab, index) => tab === next[index]);
}

function syncCompatibilityCache(qc: QueryClient, scope: RecentTabsScope): void {
	const projects = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, "projects")),
	);
	const work = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, "work")),
	);
	// Same reasoning as `replaceLoadedTabs`: this flat array is a separate cache entry
	// that several components read, so re-allocating it on an unchanged tick would
	// re-render them even after the section windows correctly stayed put.
	qc.setQueryData<RecentTab[]>(recentTabsFlatQueryKey(scope), (previous) => {
		const next = [...projects, ...work];
		return sameTabList(previous, next) ? (previous as RecentTab[]) : next;
	});
}

function applyOperation(tabs: RecentTab[], operation: RecentTabsOperation): RecentTab[] {
	if (operation.type === "remove") {
		// Header only, even for a folder: the server lists every removed member as its own
		// operation, and a dissolved folder's members arrive as upserts right after this.
		// Taking the members out here would make those upserts lose their anchors.
		if (!tabs.some((tab) => tabKey(tab) === operation.key)) return tabs;
		return tabs.filter((tab) => tabKey(tab) !== operation.key);
	}

	const previous = tabs.find((tab) => tabKey(tab) === operation.key);
	const hasAnchor = (key: string) =>
		tabs.some(
			(tab) =>
				tabKey(tab) === key &&
				tabKey(tab) !== operation.key &&
				!(previous && isFolderTab(previous) && tab.folderId === previous.id),
		);
	// The server emits operations in final order and detects moves by predecessor.
	// Prefer that already-positioned predecessor: the successor may not have moved
	// yet, may be outside the loaded window, or may belong to the moved folder.
	let target: RecentTabMoveTarget | null = null;
	if (operation.afterKey === null) target = { toIndex: 0 };
	else if (hasAnchor(operation.afterKey)) target = { afterKey: operation.afterKey };
	else if (operation.beforeKey && hasAnchor(operation.beforeKey)) {
		target = { beforeKey: operation.beforeKey };
	}
	if (!target) {
		// Neither neighbor is loaded: this row belongs outside the visible prefix.
		// Never invent a top position for an off-page metadata update. A loaded row
		// moving out of the window is removed so the caller can backfill the page.
		if (!previous) return tabs;
		return tabs.filter(
			(tab) =>
				tabKey(tab) !== operation.key && !(isFolderTab(previous) && tab.folderId === previous.id),
		);
	}
	if (operation.type === "move") return replayMove(tabs, operation.key, target);

	// Deltas only carry persisted columns, so an upsert for an already-rendered tab must
	// keep its live runtime fields (status colour, terminal count, viewers, container badge).
	// Otherwise every revisit blanks the row until the next runtime poll lands.
	const nextTab = mergeRecentTabRuntime(operation.tab, previous);
	const withoutCurrent = tabs.filter((tab) => tabKey(tab) !== operation.key);
	let insertAt = 0;
	if ("afterKey" in target) {
		insertAt = withoutCurrent.findIndex((tab) => tabKey(tab) === target.afterKey) + 1;
	} else if ("beforeKey" in target) {
		insertAt = withoutCurrent.findIndex((tab) => tabKey(tab) === target.beforeKey);
	}
	withoutCurrent.splice(insertAt, 0, nextTab);
	return regroupFolders(withoutCurrent);
}

/**
 * Replay a server `move` exactly: the server already resolved membership and the
 * canonical layout, so the tab lands right next to its anchor (a folder moves with its
 * members) and `regroupFolders` only restores contiguity.
 */
function replayMove(tabs: RecentTab[], key: string, target: RecentTabMoveTarget): RecentTab[] {
	const index = tabs.findIndex((tab) => tabKey(tab) === key);
	if (index < 0) return tabs;
	const next = [...tabs];
	const range = isFolderTab(next[index]) ? unitRange(next, index) : { start: index, end: index };
	const group = next.splice(range.start, range.end - range.start + 1);
	let insertAt = 0;
	if ("afterKey" in target) {
		insertAt = next.findIndex((tab) => tabKey(tab) === target.afterKey) + 1;
	} else if ("beforeKey" in target) {
		insertAt = Math.max(
			0,
			next.findIndex((tab) => tabKey(tab) === target.beforeKey),
		);
	}
	next.splice(insertAt, 0, ...group);
	return regroupFolders(next);
}

function operationSection(operation: RecentTabsOperation): RecentTabsSection {
	return operation.type === "upsert"
		? recentTabSection(operation.tab)
		: sectionFromKey(operation.key);
}

export function recentTabsOperationSections(
	operations: RecentTabsOperation[],
): RecentTabsSection[] {
	return [...new Set(operations.map(operationSection))];
}

export function reduceRecentTabsOperations(
	tabs: RecentTab[],
	section: RecentTabsSection,
	operations: RecentTabsOperation[],
): RecentTab[] {
	let next = tabs;
	for (const operation of operations) {
		if (operationSection(operation) !== section) continue;
		next = applyOperation(next, operation);
	}
	return next;
}

export interface RecentTabsDeltaApplyResult {
	/** Loaded windows that could not advance and must be rebuilt from page one. */
	gaps: RecentTabsSection[];
	/**
	 * Sections whose window shrank while the server still has rows past it.
	 * Only these gained an empty slot that a page fetch can refill.
	 */
	backfill: RecentTabsSection[];
}

const NO_DELTA_FOLLOW_UP: RecentTabsDeltaApplyResult = { gaps: [], backfill: [] };

/**
 * Apply a mutation/WS delta atomically across every loaded section.
 *
 * The returned result is what decides whether a page fetch follows. A delta that
 * applied cleanly needs NO fetch: the operations carry `beforeKey`/`afterKey`
 * anchors, so the reducer lands on the same order the server holds. Refetching
 * both sections after every applied revision is what turned one narrator switch
 * into a burst of `recent-tabs?section=...` requests — a visit upserts the tab,
 * the mutation response and the WS delta each carry that revision, and every
 * status change during the turn produces another one.
 *
 * A removal can shrink a window that still has more server rows, so it needs
 * backfilling. A move into the window from an unloaded page also needs a fetch:
 * move operations carry anchors but no tab payload to populate the missing row.
 */
export function applyRecentTabsDelta(
	qc: QueryClient,
	delta: RecentTabsDelta,
	scope = getRecentTabsScope(),
): RecentTabsDeltaApplyResult {
	if (!isRecentTabsScopeCurrent(scope) || !Number.isFinite(delta.revision) || delta.revision <= 0)
		return NO_DELTA_FOLLOW_UP;
	const baseRevision = delta.baseRevision ?? delta.revision - 1;
	const loaded = (["projects", "work"] as const)
		.map((section) => ({
			section,
			key: recentTabsSectionQueryKey(scope, section),
			data: qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, section)),
		}))
		.filter(
			(entry): entry is typeof entry & { data: RecentTabsInfiniteData } => entry.data !== undefined,
		);
	if (loaded.length === 0) return NO_DELTA_FOLLOW_UP;

	const revisions = loaded.map(({ data }) => recentTabsDataRevision(data));
	if (revisions.every((revision) => revision !== undefined && revision >= delta.revision))
		return NO_DELTA_FOLLOW_UP;
	// Rebuilding is the caller's job (one `reset` refresh). Invalidating here as well
	// would make an active infinite query refetch every loaded page on top of it.
	if (revisions.some((revision) => revision === undefined || revision !== baseRevision)) {
		return { gaps: ["projects", "work"], backfill: [] };
	}

	const backfill: RecentTabsSection[] = [];
	for (const { section, key, data } of loaded) {
		const relevant = delta.operations.filter(
			(operation) => operationSection(operation) === section,
		);
		const previousTabs = flattenPages(data);
		const nextTabs = reduceRecentTabsOperations(previousTabs, section, relevant);
		qc.setQueryData(key, replaceLoadedTabs(data, nextTabs, delta.revision));
		const nextKeys = new Set(nextTabs.map(tabKey));
		const missingMovedTab = relevant.some(
			(operation) =>
				operation.type === "move" &&
				!nextKeys.has(operation.key) &&
				(operation.afterKey === null ||
					nextKeys.has(operation.afterKey) ||
					(operation.beforeKey !== null && nextKeys.has(operation.beforeKey))),
		);
		if (missingMovedTab || (nextTabs.length < previousTabs.length && data.pages.at(-1)?.hasMore)) {
			backfill.push(section);
		}
	}
	syncCompatibilityCache(qc, scope);
	return { gaps: [], backfill };
}

export function applyRecentTabsRuntimePatches(
	qc: QueryClient,
	patches: Array<{ key: string; patch: Record<string, unknown> }>,
	scope = getRecentTabsScope(),
): void {
	if (!isRecentTabsScopeCurrent(scope) || patches.length === 0) return;
	const patchMap = new Map(patches.map(({ key, patch }) => [key, patch]));
	for (const section of ["projects", "work"] as const) {
		updateSectionData(qc, scope, section, (tabs) => {
			let changed = false;
			const next = tabs.map((tab) => {
				const patch = patchMap.get(tabKey(tab));
				if (!patch) return tab;
				// Runtime polls repeat the same values most of the time. Keep the previous object
				// when nothing actually moved so memoized rows are not re-rendered on every tick.
				const patched = mergeRecentTabPatch(tab, patch);
				if (patched === tab) return tab;
				changed = true;
				return patched;
			});
			return changed ? next : tabs;
		});
	}
	syncCompatibilityCache(qc, scope);
}

/** How long a project card's own read of its details counts as fresh. */
const PROJECT_TAB_DETAILS_FRESH_MS = 10_000;
const projectTabDetailReads = new WeakMap<
	QueryClient,
	{ scope: RecentTabsScope; reads: Map<string, number> }
>();

/**
 * Read one project tab's runtime details now (its hover card or touch details just opened) and
 * merge them into the tab cache: the sidebar's own runtime request refreshes them only when its
 * targets change. One key, at most once per {@link PROJECT_TAB_DETAILS_FRESH_MS} per key.
 * Returns the cancel for the opener's cleanup; a cancelled or failed read does not count.
 */
export function refreshProjectTabDetails(
	qc: QueryClient,
	projectId: string,
	scope = getRecentTabsScope(),
): (() => void) | undefined {
	if (!isRecentTabsScopeCurrent(scope)) return;
	const key = `project:${projectId}`;
	let entry = projectTabDetailReads.get(qc);
	if (entry?.scope !== scope) {
		entry = { scope, reads: new Map() };
		projectTabDetailReads.set(qc, entry);
	}
	const { reads } = entry;
	const startedAt = Date.now();
	// Only fresh entries help dedupe; visiting many projects must not grow the map forever.
	for (const [readKey, readAt] of reads) {
		if (startedAt - readAt >= PROJECT_TAB_DETAILS_FRESH_MS) reads.delete(readKey);
	}
	if (reads.has(key)) return;
	reads.set(key, startedAt);
	const controller = new AbortController();
	let fulfilled = false;
	const forget = () => {
		if (reads.get(key) === startedAt) reads.delete(key);
	};
	api
		.getRecentTabsRuntime([key], controller.signal)
		.then(({ patches }) => {
			if (controller.signal.aborted || !isRecentTabsScopeCurrent(scope)) return;
			fulfilled = true;
			applyRecentTabsRuntimePatches(qc, patches, scope);
		})
		.catch(forget);
	return () => {
		controller.abort();
		if (!fulfilled) forget();
	};
}

function applyFolderPatch(
	tab: RecentTab,
	folderId: string,
	patch: RecentTabFolderPatch,
): RecentTab {
	if (!isFolderTab(tab) || tab.id !== folderId) return tab;
	const next: RecentTab = { ...tab };
	if (patch.title !== undefined) next.title = patch.title.trim();
	if (patch.icon !== undefined) next.folderIcon = patch.icon ?? undefined;
	if (patch.color !== undefined) next.folderColor = patch.color ?? undefined;
	if (patch.previewCount !== undefined) next.folderPreviewCount = patch.previewCount ?? undefined;
	return next;
}

function toPersistedRecentTab(tab: RecentTab): PersistedRecentTab {
	const persisted: PersistedRecentTab = {
		type: tab.type,
		id: tab.id,
		title: tab.title,
		lastVisitedAt: tab.lastVisitedAt,
	};
	if (tab.narratorId !== undefined) persisted.narratorId = tab.narratorId;
	if (tab.parentNarratorId !== undefined) persisted.parentNarratorId = tab.parentNarratorId;
	if (tab.folderId !== undefined) persisted.folderId = tab.folderId;
	if (tab.subtitle !== undefined) persisted.subtitle = tab.subtitle;
	if (tab.status !== undefined) persisted.status = tab.status;
	if (tab.pinned !== undefined) persisted.pinned = tab.pinned;
	if (tab.isScheduled !== undefined) persisted.isScheduled = tab.isScheduled;
	// Carried so an undo-restore brings folders back with their look and preview size.
	if (tab.folderIcon !== undefined) persisted.folderIcon = tab.folderIcon;
	if (tab.folderColor !== undefined) persisted.folderColor = tab.folderColor;
	if (tab.folderPreviewCount !== undefined) persisted.folderPreviewCount = tab.folderPreviewCount;
	if (tab.projectId !== undefined) persisted.projectId = tab.projectId;
	return persisted;
}

function mutationDelta(result: RecentTabsMutationResponse): RecentTabsDelta {
	return {
		baseRevision: result.baseRevision,
		revision: result.revision,
		operations: result.operations,
	};
}

function isAttentionTab(tab: RecentTab): boolean {
	if (tab.status === "working" || tab.status === "waiting") return true;
	return !!tab.substatus?.some((status) => status === "unread" || status === "error");
}

export function clearLoadedTabs(
	tabs: RecentTab[],
	scope: "all" | "projects" | "inactive_narrators",
	keepTabKey?: string,
): RecentTab[] {
	// Mirrors the server: pinned tabs, folders (whole, with their members) and the kept
	// tab survive every scope. A folder is a structure the user built by hand.
	const isKept = (tab: RecentTab) =>
		(keepTabKey ? tabKey(tab) === keepTabKey : false) ||
		tab.pinned === true ||
		isFolderTab(tab) ||
		!!tab.folderId;
	if (scope === "all") return tabs.filter(isKept);
	if (scope === "projects") return tabs.filter((tab) => tab.type !== "project" || isKept(tab));
	// Projects and teams are not sessions: never "inactive".
	return tabs.filter(
		(tab) => isKept(tab) || tab.type === "project" || tab.type === "team" || isAttentionTab(tab),
	);
}

function snapshotSections(
	qc: QueryClient,
	scope: RecentTabsScope,
): Record<RecentTabsSection, RecentTabsInfiniteData | undefined> {
	return {
		projects: qc.getQueryData(recentTabsSectionQueryKey(scope, "projects")),
		work: qc.getQueryData(recentTabsSectionQueryKey(scope, "work")),
	};
}

function restoreSectionSnapshots(
	qc: QueryClient,
	scope: RecentTabsScope | null,
	snapshots: Record<RecentTabsSection, RecentTabsInfiniteData | undefined>,
): void {
	if (!isRecentTabsScopeCurrent(scope)) return;
	for (const section of ["projects", "work"] as const) {
		const current = qc.getQueryData<RecentTabsInfiniteData>(
			recentTabsSectionQueryKey(scope, section),
		);
		const snapshot = snapshots[section];
		if (
			(current !== undefined && recentTabsDataRevision(current) === undefined) ||
			recentTabsDataRevision(current) !== recentTabsDataRevision(snapshot)
		) {
			void qc.invalidateQueries({
				queryKey: recentTabsSectionQueryKey(scope, section),
				exact: true,
			});
			continue;
		}
		qc.setQueryData(recentTabsSectionQueryKey(scope, section), snapshot);
	}
	syncCompatibilityCache(qc, scope);
}

/**
 * Remove an entity's tab from the sectioned caches (the source of truth that
 * `useRecentTabs` re-derives the flat array from) and cascade-delete it server side.
 * Editing only the flat array is overwritten by that derivation, which left an archived
 * session's tab visible until a WS delta happened to arrive.
 */
export async function removeRecentTabCascade(
	qc: QueryClient,
	type: RecentTab["type"],
	id: string,
	options: { keepEmptyFolder?: boolean } = {},
	scope = getRecentTabsScope(),
): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope)) return;
	const section = recentTabSection({ type });
	await qc.cancelQueries({ queryKey: recentTabsSectionQueryKey(scope, section) });
	if (!isRecentTabsScopeCurrent(scope)) return;
	const snapshots = snapshotSections(qc, scope);
	updateSectionData(qc, scope, section, (current) =>
		applyOperation(current, { type: "remove", key: `${type}:${id}` }),
	);
	syncCompatibilityCache(qc, scope);
	try {
		const result = await api.removeRecentTab(type, id, {
			cascade: true,
			keepEmptyFolder: options.keepEmptyFolder,
		});
		await applyRecentTabsDeltaAndFollowUp(qc, mutationDelta(result), scope);
	} catch {
		restoreSectionSnapshots(qc, scope, snapshots);
	}
}

class RecentTabsStaleWindowError extends Error {}

export function isRecentTabsStaleCursorError(error: unknown): boolean {
	return (
		error instanceof RecentTabsStaleWindowError ||
		(error instanceof ApiError &&
			error.status === 409 &&
			error.data?.code === RECENT_TABS_STALE_CURSOR_CODE)
	);
}

async function fetchLoadedWindows(
	plans: Array<{
		section: RecentTabsSection;
		pageCount: number;
	}>,
	minimumRevision: number,
	scope: RecentTabsScope,
): Promise<Map<RecentTabsSection, RecentTabsInfiniteData>> {
	requireRecentTabsScope(scope);
	const firstPages = await Promise.all(
		plans.map(async (plan) => ({
			plan,
			page: await api.getRecentTabsPage(plan.section, { limit: RECENT_TABS_PAGE_SIZE }),
		})),
	);
	requireRecentTabsScope(scope);
	const revision = firstPages[0]?.page.revision;
	if (
		revision === undefined ||
		revision < minimumRevision ||
		firstPages.some(({ page }) => page.revision !== revision)
	) {
		throw new RecentTabsStaleWindowError("Recent-tabs sections have different revisions");
	}

	const entries = await Promise.all(
		firstPages.map(async ({ plan, page: firstPage }) => {
			const pages: RecentTabsPageResponse[] = [firstPage];
			const pageParams: Array<string | undefined> = [undefined];
			let cursor = firstPage.nextCursor;
			while (pages.length < plan.pageCount && cursor) {
				const page = await api.getRecentTabsPage(plan.section, {
					limit: RECENT_TABS_PAGE_SIZE,
					cursor,
				});
				requireRecentTabsScope(scope);
				if (page.revision !== revision) {
					throw new RecentTabsStaleWindowError("Recent-tabs page revision changed");
				}
				pageParams.push(cursor);
				pages.push(page);
				cursor = page.nextCursor;
			}
			return [plan.section, { pages, pageParams } satisfies RecentTabsInfiniteData] as const;
		}),
	);
	return new Map(entries);
}

/**
 * Carry live runtime fields onto a freshly fetched window using the CURRENT cache.
 *
 * Page responses only contain persisted columns, so they must inherit status colour,
 * terminal count, viewers and container badge from what is already rendered. Reading
 * the cache at write time (rather than snapshotting before the request) is what keeps
 * WS events that arrived mid-flight from being reverted.
 */
function withCachedRuntimeFields(
	qc: QueryClient,
	scope: RecentTabsScope,
	section: RecentTabsSection,
	data: RecentTabsInfiniteData,
	fallbackTabs: ReadonlyMap<string, RecentTab>,
): RecentTabsInfiniteData {
	const current = new Map(
		flattenPages(
			qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, section)),
		).map((tab) => [tabKey(tab), tab]),
	);
	return {
		...data,
		pages: data.pages.map((page) => ({
			...page,
			items: page.items.map((tab) => {
				const key = tabKey(tab);
				return mergeRecentTabRuntime(tab, current.get(key) ?? fallbackTabs.get(key));
			}),
		})),
	};
}

export async function refreshRecentTabsAfterReconnect(
	qc: QueryClient,
	scope = getRecentTabsScope(),
): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope)) return;
	// Frames may have been missed while the socket was down.
	invalidateRecentTabStates(qc, scope);
	try {
		await refreshRecentTabsLoadedWindow(qc, {}, scope);
	} finally {
		if (isRecentTabsScopeCurrent(scope)) {
			await qc.refetchQueries(
				{
					queryKey: recentTabsScopeKey(scope),
					predicate: (query) => query.state.status === "error",
				},
				{ throwOnError: true },
			);
		}
	}
}

export function refreshRecentTabsLoadedWindow(
	qc: QueryClient,
	options: { reset?: boolean; minimumRevision?: number } = {},
	scope = getRecentTabsScope(),
): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope)) return Promise.resolve();
	// A reset after missed deltas also invalidates the current scope's pin states.
	if (options.reset) invalidateRecentTabStates(qc, scope);
	const now = Date.now();
	const minimumRevision = options.minimumRevision ?? 0;
	const existing = loadedWindowRefreshes.get(qc);
	if (
		existing?.scope === scope &&
		now - existing.startedAt < RECENT_TABS_REFRESH_DEDUPE_MS &&
		(existing.reset || !options.reset) &&
		existing.minimumRevision >= minimumRevision
	) {
		return existing.promise;
	}
	const generation = (loadedWindowRefreshGenerations.get(qc) ?? 0) + 1;
	loadedWindowRefreshGenerations.set(qc, generation);
	const plans = (["projects", "work"] as const).flatMap((section) => {
		const data = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(scope, section));
		if (!data) return [];
		return [
			{
				section,
				pageCount: Math.max(1, data.pages.length),
				// Only a fallback for rows that `reset` truncates out of the cache before the
				// fetch. Live runtime fields are re-read from the cache at write time.
				truncatedTabs: new Map(flattenPages(data).map((tab) => [tabKey(tab), tab])),
			},
		];
	});
	if (plans.length === 0) return Promise.resolve();

	const promise = (async () => {
		await Promise.all(
			plans.map(({ section }) =>
				qc.cancelQueries({ queryKey: recentTabsSectionQueryKey(scope, section), exact: true }),
			),
		);
		if (!isRecentTabsScopeCurrent(scope)) return;
		if (options.reset && loadedWindowRefreshGenerations.get(qc) === generation) {
			for (const { section } of plans) {
				qc.setQueryData<RecentTabsInfiniteData>(
					recentTabsSectionQueryKey(scope, section),
					(data) =>
						data
							? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
							: data,
				);
			}
			syncCompatibilityCache(qc, scope);
		}
		let windows: Map<RecentTabsSection, RecentTabsInfiniteData> | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				windows = await fetchLoadedWindows(plans, minimumRevision, scope);
				break;
			} catch (error) {
				lastError = error;
				if (!isRecentTabsStaleCursorError(error)) throw error;
			}
		}
		if (!windows) throw lastError;
		if (!isRecentTabsScopeCurrent(scope) || loadedWindowRefreshGenerations.get(qc) !== generation)
			return;
		for (const { section, truncatedTabs } of plans) {
			const data = windows.get(section);
			if (!data) continue;
			// Re-read the cache HERE, not before the fetch: WS runtime events that landed
			// while the pages were in flight are already in the cache, and a pre-fetch
			// snapshot would roll status/substatus icons back to their pre-event values.
			qc.setQueryData(
				recentTabsSectionQueryKey(scope, section),
				withCachedRuntimeFields(qc, scope, section, data, truncatedTabs),
			);
		}
		syncCompatibilityCache(qc, scope);
	})().catch((error) => {
		if (!isRecentTabsScopeCurrent(scope)) return;
		if (options.reset && loadedWindowRefreshGenerations.get(qc) === generation) {
			for (const { section } of plans) {
				void qc.invalidateQueries({
					queryKey: recentTabsSectionQueryKey(scope, section),
					exact: true,
				});
			}
		}
		throw error;
	});
	loadedWindowRefreshes.set(qc, {
		scope,
		startedAt: now,
		reset: options.reset === true,
		minimumRevision,
		promise,
	});
	return promise;
}

/**
 * Apply a delta and fetch pages only when the delta could not be applied locally.
 *
 * Every mutation response and every WS delta funnels through here so the "did this
 * need a network follow-up?" decision lives in one place instead of being repeated
 * (and drifting) at each call site.
 */
export function applyRecentTabsDeltaAndFollowUp(
	qc: QueryClient,
	delta: RecentTabsDelta,
	scope = getRecentTabsScope(),
): Promise<void> {
	const { gaps, backfill } = applyRecentTabsDelta(qc, delta, scope);
	// A gap reloads page one and invalidates all pin-state reads; otherwise touch only delta keys.
	if (gaps.length === 0) {
		invalidateRecentTabStates(
			qc,
			scope,
			delta.operations.map((operation) => operation.key),
		);
	}
	if (gaps.length === 0 && backfill.length === 0) return Promise.resolve();
	return refreshRecentTabsLoadedWindow(
		qc,
		{
			reset: gaps.length > 0,
			minimumRevision: delta.revision,
		},
		scope,
	);
}

function useRecentTabsSection(scope: RecentTabsScope | null, section: RecentTabsSection) {
	const qc = useQueryClient();
	return useInfiniteQuery({
		queryKey: recentTabsSectionQueryKey(scope, section),
		enabled: scope !== null,
		queryFn: async ({ pageParam, signal }) => {
			requireRecentTabsScope(scope);
			const page = await api.getRecentTabsPage(section, {
				limit: RECENT_TABS_PAGE_SIZE,
				...(pageParam ? { cursor: pageParam } : {}),
				signal,
			});
			requireRecentTabsScope(scope);
			const current = qc.getQueryData<RecentTabsInfiniteData>(
				recentTabsSectionQueryKey(scope, section),
			);
			if (pageParam) {
				const revision = recentTabsDataRevision(current);
				if (revision === undefined || page.revision !== revision) {
					throw new RecentTabsStaleWindowError("Recent-tabs cursor revision changed");
				}
			}
			// The page endpoint returns persisted columns only; carry the runtime fields the
			// live window already knows about so a refetch never blanks status/terminal badges.
			const previous = new Map(flattenPages(current).map((tab) => [tabKey(tab), tab]));
			if (previous.size === 0) return page;
			return {
				...page,
				items: page.items.map((tab) => mergeRecentTabRuntime(tab, previous.get(tabKey(tab)))),
			};
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
		retry: (failureCount, error) => !isRecentTabsStaleCursorError(error) && failureCount < 1,
		staleTime: 60_000,
		gcTime: RECENT_TABS_QUERY_GC_TIME_MS,
	});
}

type ScopedMutation = { scope: RecentTabsScope | null };

export function useRecentTabs() {
	const qc = useQueryClient();
	const { t } = useTranslation("nav");
	const scope = useRecentTabsScope();
	const projectsQuery = useRecentTabsSection(scope, "projects");
	const workQuery = useRecentTabsSection(scope, "work");
	const projectTabs = useMemo(() => flattenPages(projectsQuery.data), [projectsQuery.data]);
	const workTabs = useMemo(() => flattenPages(workQuery.data), [workQuery.data]);
	const tabs = useMemo(() => [...projectTabs, ...workTabs], [projectTabs, workTabs]);

	// Every mounted `useRecentTabs()` maintains the flat compatibility array, and each
	// one memoizes its own copy — so writing unconditionally meant N cache writes per
	// change for a value that had not changed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: page updates trigger sync, but read the latest cache to avoid overwriting intervening WS deltas.
	useEffect(() => {
		if (isRecentTabsScopeCurrent(scope)) syncCompatibilityCache(qc, scope);
	}, [qc, scope, tabs]);

	const applyAuthoritativeResult = useCallback(
		(result: RecentTabsMutationResponse, { scope }: ScopedMutation) => {
			if (!isRecentTabsScopeCurrent(scope)) return;
			void applyRecentTabsDeltaAndFollowUp(qc, mutationDelta(result), scope).catch(() => {});
		},
		[qc],
	);

	const restoreMutation = useMutation({
		mutationFn: (input: ScopedMutation & { snapshot?: RecentTab[]; token?: string }) => {
			requireRecentTabsScope(input.scope);
			// Refuse an empty full-list replace: a missing snapshot must never wipe the
			// user's recent tabs. Token restore is the only path that needs no snapshot.
			if (!input.token && (!input.snapshot || input.snapshot.length === 0)) {
				return Promise.reject(new Error("recent-tabs undo needs a token or a non-empty snapshot"));
			}
			return api.restoreRecentTabs({
				...(input.token ? { token: input.token } : {}),
				...(input.snapshot ? { tabs: input.snapshot.map(toPersistedRecentTab) } : {}),
			});
		},
		onSuccess: applyAuthoritativeResult,
		onError: (_error, { scope }) => {
			if (!isRecentTabsScopeCurrent(scope)) return;
			void qc.invalidateQueries({ queryKey: recentTabsScopeKey(scope) });
			notifications.show({ color: "red", message: t("undoFailed") });
		},
	});

	/**
	 * Shared undo toast for destructive recent-tab mutations (clear, single-tab close).
	 * Only one undo affordance is offered at a time — later mutations replace the toast,
	 * matching the server's single pending undo token per user.
	 */
	const showUndoNotification = useCallback(
		(
			message: string,
			undo: { undoToken?: string; snapshot?: RecentTab[] },
			scope: RecentTabsScope | null,
		) => {
			if (!isRecentTabsScopeCurrent(scope)) return;
			const snapshot = undo.snapshot && undo.snapshot.length > 0 ? undo.snapshot : undefined;
			// Nothing to restore with — showing an undo button would only fail.
			if (!undo.undoToken && !snapshot) return;
			notifications.show({
				id: UNDO_NOTIFICATION_ID,
				color: "gray",
				autoClose: UNDO_AUTO_CLOSE_MS,
				withCloseButton: true,
				withBorder: true,
				message: createElement(
					"div",
					{
						style: {
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 12,
						},
					},
					createElement("span", null, message),
					createElement(
						Button as ComponentType<{
							size?: string;
							variant?: string;
							onClick?: () => void;
							children?: React.ReactNode;
						}>,
						{
							size: "compact-xs",
							variant: "light",
							onClick: () => {
								if (!isRecentTabsScopeCurrent(scope)) return;
								// Hide immediately so a second click cannot fire a duplicate restore.
								notifications.hide(UNDO_NOTIFICATION_ID);
								if (undo.undoToken) restoreMutation.mutate({ scope, token: undo.undoToken });
								else if (snapshot) restoreMutation.mutate({ scope, snapshot });
							},
						},
						t("undo"),
					),
				),
			});
		},
		[restoreMutation, t],
	);

	const removeMutation = useMutation({
		mutationFn: ({ scope, type, id }: ScopedMutation & { type: RecentTab["type"]; id: string }) => {
			requireRecentTabsScope(scope);
			return api.removeRecentTab(type, id);
		},
		onMutate: async ({ scope, type, id }) => {
			requireRecentTabsScope(scope);
			await qc.cancelQueries({ queryKey: recentTabsScopeKey(scope) });
			requireRecentTabsScope(scope);
			const snapshots = snapshotSections(qc, scope);
			updateSectionData(qc, scope, recentTabSection({ type }), (current) =>
				applyRecentTabRemove(current, `${type}:${id}`),
			);
			syncCompatibilityCache(qc, scope);
			return { snapshots };
		},
		onError: (_error, { scope }, context) => {
			if (context) restoreSectionSnapshots(qc, scope, context.snapshots);
		},
		onSuccess: (result, variables) => {
			applyAuthoritativeResult(result, variables);
			// Single-tab (or whole-folder) close via swipe / context menu / middle-click — same
			// undo affordance as one-click clear. Token-only: a loaded-window snapshot would
			// wipe unloaded pages if used as a full-list restore fallback.
			if (!result.removedCount || !result.undoToken) return;
			showUndoNotification(
				t(variables.type === "folder" ? "folderClosed" : "tabClosed"),
				{
					undoToken: result.undoToken,
				},
				variables.scope,
			);
		},
	});

	const moveMutation = useMutation({
		mutationFn: ({
			scope,
			key,
			target,
		}: ScopedMutation & { key: string; target: RecentTabMoveTarget }) => {
			requireRecentTabsScope(scope);
			return api.moveRecentTab(key, target);
		},
		onMutate: async ({ scope, key, target }) => {
			requireRecentTabsScope(scope);
			await qc.cancelQueries({ queryKey: recentTabsScopeKey(scope) });
			requireRecentTabsScope(scope);
			const snapshots = snapshotSections(qc, scope);
			updateSectionData(qc, scope, sectionFromKey(key), (current) =>
				applyRecentTabMove(current, key, target),
			);
			syncCompatibilityCache(qc, scope);
			return { snapshots };
		},
		onError: (_error, { scope }, context) => {
			if (context) restoreSectionSnapshots(qc, scope, context.snapshots);
		},
		onSuccess: (result, variables) => {
			if (!isRecentTabsScopeCurrent(variables.scope)) return;
			applyAuthoritativeResult(result, variables);
			// A move can change which folder's git identity a session follows.
			void invalidateNarratorGitIdentities(qc);
		},
	});

	const pinMutation = useMutation({
		mutationFn: ({ scope, key, pinned }: ScopedMutation & { key: string; pinned: boolean }) => {
			requireRecentTabsScope(scope);
			return api.pinRecentTab(key, pinned);
		},
		onMutate: async ({ scope, key, pinned }) => {
			requireRecentTabsScope(scope);
			await qc.cancelQueries({ queryKey: recentTabsScopeKey(scope) });
			requireRecentTabsScope(scope);
			const snapshots = snapshotSections(qc, scope);
			updateSectionData(qc, scope, sectionFromKey(key), (current) =>
				applyRecentTabPin(current, key, pinned),
			);
			syncCompatibilityCache(qc, scope);
			return { snapshots };
		},
		onError: (_error, { scope }, context) => {
			if (context) restoreSectionSnapshots(qc, scope, context.snapshots);
		},
		onSuccess: applyAuthoritativeResult,
	});

	/** Optimistic local edit + server call for the folder endpoints. */
	const runFolderMutation = useCallback(
		async (
			request: () => Promise<RecentTabsMutationResponse>,
			optimistic?: (tabs: RecentTab[]) => RecentTab[],
		): Promise<RecentTabsMutationResponse> => {
			requireRecentTabsScope(scope);
			await qc.cancelQueries({ queryKey: recentTabsScopeKey(scope) });
			requireRecentTabsScope(scope);
			const snapshots = snapshotSections(qc, scope);
			if (optimistic) {
				updateSectionData(qc, scope, "work", optimistic);
				syncCompatibilityCache(qc, scope);
			}
			try {
				const result = await request();
				applyAuthoritativeResult(result, { scope });
				return result;
			} catch (error) {
				if (isRecentTabsScopeCurrent(scope)) {
					restoreSectionSnapshots(qc, scope, snapshots);
					notifications.show({ color: "red", message: t("folderActionFailed") });
				}
				throw error;
			}
		},
		[qc, scope, applyAuthoritativeResult, t],
	);

	const clearMutation = useMutation({
		mutationFn: ({
			scope,
			clearScope,
			keepTabKey,
		}: ScopedMutation & {
			clearScope: "all" | "projects" | "inactive_narrators";
			keepTabKey?: string;
		}) => {
			requireRecentTabsScope(scope);
			return api.clearRecentTabs(clearScope, keepTabKey);
		},
		onMutate: async ({ scope, clearScope, keepTabKey }) => {
			requireRecentTabsScope(scope);
			await qc.cancelQueries({ queryKey: recentTabsScopeKey(scope) });
			requireRecentTabsScope(scope);
			const snapshots = snapshotSections(qc, scope);
			const snapshot = [...flattenPages(snapshots.projects), ...flattenPages(snapshots.work)];
			let removedCount = 0;
			for (const section of ["projects", "work"] as const) {
				updateSectionData(qc, scope, section, (current) => {
					const next = clearLoadedTabs(current, clearScope, keepTabKey);
					removedCount += current.length - next.length;
					return next;
				});
			}
			syncCompatibilityCache(qc, scope);
			return { snapshots, snapshot, removedCount };
		},
		onError: (_error, { scope }, context) => {
			if (context) restoreSectionSnapshots(qc, scope, context.snapshots);
		},
		onSuccess: (result, variables, context) => {
			applyAuthoritativeResult(result, variables);
			const removedCount = result.removedCount ?? context?.removedCount ?? 0;
			if (!context || removedCount <= 0) return;
			showUndoNotification(
				t("tabsCleared", { count: removedCount }),
				{
					...(result.undoToken ? { undoToken: result.undoToken } : {}),
					snapshot: context.snapshot,
				},
				variables.scope,
			);
		},
	});

	const toSectionState = useCallback(
		(query: typeof projectsQuery, sectionTabs: RecentTab[]): RecentTabsSectionState => ({
			tabs: sectionTabs,
			revision: dataRevision(query.data),
			hasMore: query.hasNextPage,
			isLoading: query.isLoading,
			isError: query.isError,
			isFetchingNextPage: query.isFetchingNextPage,
			loadMore: () => {
				if (!isRecentTabsScopeCurrent(scope)) return;
				void query
					.fetchNextPage()
					.then((result) => {
						if (isRecentTabsStaleCursorError(result.error)) {
							return refreshRecentTabsLoadedWindow(qc, { reset: true }, scope);
						}
					})
					.catch((error) => {
						if (isRecentTabsStaleCursorError(error)) {
							return refreshRecentTabsLoadedWindow(qc, { reset: true }, scope);
						}
					});
			},
			retry: () => {
				if (isRecentTabsScopeCurrent(scope)) void query.refetch();
			},
		}),
		[qc, scope],
	);

	return {
		scope,
		tabs,
		projectTabs,
		workTabs,
		projects: toSectionState(projectsQuery, projectTabs),
		work: toSectionState(workQuery, workTabs),
		removeTab: useCallback(
			(type: RecentTab["type"], id: string) => removeMutation.mutate({ scope, type, id }),
			[removeMutation, scope],
		),
		/**
		 * Optimistic move with an authoritative follow-up. `onError` runs after the
		 * optimistic layout has been rolled back, so callers can report the failure.
		 */
		moveTab: useCallback(
			(
				key: string,
				target: RecentTabMoveTarget,
				options?: { onError?: (error: unknown) => void },
			) =>
				moveMutation.mutate(
					{ scope, key, target },
					{
						onError: (error) => {
							if (isRecentTabsScopeCurrent(scope)) options?.onError?.(error);
						},
					},
				),
			[moveMutation, scope],
		),
		pinTab: useCallback(
			(key: string, pinned: boolean) => pinMutation.mutate({ scope, key, pinned }),
			[pinMutation, scope],
		),
		updateFolder: useCallback(
			(folderId: string, patch: RecentTabFolderPatch) =>
				runFolderMutation(
					() => api.updateRecentTabFolder(folderId, patch),
					(current) => current.map((tab) => applyFolderPatch(tab, folderId, patch)),
				).then(() => undefined),
			[runFolderMutation],
		),
		dissolveFolder: useCallback(
			async (folderId: string) => {
				const result = await runFolderMutation(
					() => api.dissolveRecentTabFolder(folderId),
					(current) => applyRecentTabFolderDissolve(current, folderId),
				);
				// The folder layout is hand-built work; dissolving it is undoable like a close.
				if (result.undoToken) {
					showUndoNotification(t("folderDissolved"), { undoToken: result.undoToken }, scope);
				}
			},
			[runFolderMutation, scope, showUndoNotification, t],
		),
		clearTabs: useCallback(
			(clearScope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
				clearMutation.mutate({ scope, clearScope, keepTabKey }),
			[clearMutation, scope],
		),
		restoreTabs: useCallback(
			(snapshot: RecentTab[]) => restoreMutation.mutate({ scope, snapshot }),
			[restoreMutation, scope],
		),
	};
}

async function applyGlobalRecentTabsMutation(
	scope: RecentTabsScope,
	request: Promise<RecentTabsMutationResponse>,
): Promise<void> {
	const result = await request;
	await applyRecentTabsDeltaAndFollowUp(globalQC, mutationDelta(result), scope);
}

export function addRecentTab(tab: AddRecentTabInput, scope = getRecentTabsScope()): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope)) return Promise.resolve();
	return applyGlobalRecentTabsMutation(scope, api.upsertRecentTab(buildRecentTabUpsert(tab))).catch(
		(error) => {
			if (import.meta.env.DEV) console.warn("[useRecentTabs] upsertRecentTab failed:", error);
		},
	);
}

/**
 * Add or reposition a tab, PROPAGATING failure — and optionally placing it at an anchor.
 *
 * Two differences from {@link addRecentTab}, both needed by the external-drop path:
 *
 *  - It rejects instead of swallowing. A drop that silently did nothing is indistinguishable
 *    from an unsupported gesture, so the caller has to be able to show a failure notice.
 *  - The anchor rides along with the upsert, so creating and positioning the tab is ONE
 *    revision. Doing it as upsert-then-move renders the tab at the default insertion point
 *    for a frame before it jumps to where the user aimed.
 */
export async function addRecentTabOrThrow(
	tab: AddRecentTabInput,
	anchor?: { beforeKey: string } | { afterKey: string },
	scope = getRecentTabsScope(),
): Promise<void> {
	requireRecentTabsScope(scope);
	return applyGlobalRecentTabsMutation(
		scope,
		api.upsertRecentTab({ ...buildRecentTabUpsert(tab), ...(anchor ?? {}) }),
	);
}

/**
 * Last-persisted visit signature per tab, insertion-ordered by recency of use.
 *
 * Bounded: a long-lived session visits an unbounded number of narrators, and this
 * map would otherwise grow for the whole lifetime of the page. Eviction only
 * costs one redundant upsert on the next visit to that tab, which is exactly the
 * behaviour before this dedupe existed — the safe direction to fail in.
 */
let visitScope: RecentTabsScope | null = null;
const visitSignatures = new Map<string, string>();
const MAX_TRACKED_VISIT_SIGNATURES = 200;

function rememberVisitSignature(key: string, signature: string): void {
	// Re-insert so the map stays ordered by recency, which is what makes the
	// eviction below drop the least recently visited tab.
	visitSignatures.delete(key);
	visitSignatures.set(key, signature);
	while (visitSignatures.size > MAX_TRACKED_VISIT_SIGNATURES) {
		const oldest = visitSignatures.keys().next();
		if (oldest.done) break;
		visitSignatures.delete(oldest.value);
	}
}

function isRecentTabLoaded(scope: RecentTabsScope, key: string): boolean {
	for (const section of ["projects", "work"] as const) {
		const data = globalQC.getQueryData<RecentTabsInfiniteData>(
			recentTabsSectionQueryKey(scope, section),
		);
		if (data?.pages.some((page) => page.items.some((tab) => tabKey(tab) === key))) return true;
	}
	return false;
}

/**
 * Register a visit, skipping the request when nothing persisted would change.
 *
 * Route effects re-run on every narrator query update (status, substatus, title,
 * presence), so without this a single narrator switch issued a stream of identical
 * upserts, each one costing a revision plus a WS delta to every one of that user's
 * open clients.
 *
 * The skip is conditional on the tab still being in a loaded window: removing a tab
 * from the sidebar and navigating back to the same page must re-create it, and the
 * signature alone cannot tell that apart from a redundant re-render.
 */
export function recordRecentTabVisit(
	tab: AddRecentTabInput,
	scope = getRecentTabsScope(),
): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope)) return Promise.resolve();
	if (visitScope !== scope) {
		visitSignatures.clear();
		visitScope = scope;
	}
	const key = `${tab.type}:${tab.id}`;
	const signature = recentTabVisitSignature(tab);
	if (visitSignatures.get(key) === signature && isRecentTabLoaded(scope, key)) {
		return Promise.resolve();
	}
	rememberVisitSignature(key, signature);
	return applyGlobalRecentTabsMutation(scope, api.upsertRecentTab(buildRecentTabUpsert(tab))).catch(
		(error) => {
			// A failed write must not be remembered as persisted, or the tab would stay
			// missing until something else happened to change the signature.
			if (visitScope === scope && visitSignatures.get(key) === signature)
				visitSignatures.delete(key);
			if (import.meta.env.DEV) console.warn("[useRecentTabs] upsertRecentTab failed:", error);
		},
	);
}

export function addRecentTabsBatch(
	tabs: AddRecentTabInput[],
	scope = getRecentTabsScope(),
): Promise<void> {
	if (!isRecentTabsScopeCurrent(scope) || tabs.length === 0) return Promise.resolve();
	return applyGlobalRecentTabsMutation(
		scope,
		api.upsertRecentTabsBatch(tabs.map(buildRecentTabUpsert)),
	).catch((error) => {
		if (import.meta.env.DEV) console.warn("[useRecentTabs] batch upsert failed:", error);
		throw error;
	});
}

/** Pin from the page in one revision; unpin keeps the row, like the sidebar menu does. */
export async function setRecentTabPinnedFromPage(
	tab: { type: "project" | "team"; id: string; title: string },
	pinned: boolean,
	scope = getRecentTabsScope(),
): Promise<void> {
	requireRecentTabsScope(scope);
	return applyGlobalRecentTabsMutation(
		scope,
		pinned
			? api.upsertRecentTab({ ...buildRecentTabUpsert(tab), pin: true })
			: api.pinRecentTab(`${tab.type}:${tab.id}`, false),
	);
}

export function addSubagentRecentTab(
	input: SubagentRecentTabInput,
	scope = getRecentTabsScope(),
): void {
	void recordRecentTabVisit(buildSubagentRecentTab(input), scope).catch(() => {});
}

export function updateRecentTabLocal(
	type: RecentTab["type"],
	id: string,
	patch: Partial<Pick<RecentTab, "title" | "subtitle" | "status">>,
	scope = getRecentTabsScope(),
) {
	if (!isRecentTabsScopeCurrent(scope)) return;
	const normalizedPatch = { ...patch };
	if ("title" in patch) normalizedPatch.title = clampRecentTabText(patch.title);
	if ("subtitle" in patch) normalizedPatch.subtitle = clampRecentTabText(patch.subtitle);
	updateSectionData(globalQC, scope, recentTabSection({ type }), (tabs) => {
		let changed = false;
		const next = tabs.map((tab) => {
			if (tab.type !== type || tab.id !== id) return tab;
			changed = true;
			return { ...tab, ...normalizedPatch };
		});
		return changed ? next : tabs;
	});
	syncCompatibilityCache(globalQC, scope);
}
