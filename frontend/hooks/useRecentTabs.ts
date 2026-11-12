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
	shouldApplyRecentTabsRuntimeResponse,
	snapshotRecentTabRuntimeVersions,
} from "./recent-tabs-utils";

export const RECENT_TABS_QUERY_KEY = ["user-preferences", "recent-tabs"] as const;
export const recentTabsSectionQueryKey = (section: RecentTabsSection) =>
	[...RECENT_TABS_QUERY_KEY, section] as const;
const RECENT_TABS_QUERY_GC_TIME_MS = 60_000;
const RECENT_TABS_REFRESH_DEDUPE_MS = 500;
const loadedWindowRefreshes = new WeakMap<
	QueryClient,
	{ startedAt: number; reset: boolean; minimumRevision: number; promise: Promise<void> }
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

export function recentTabSection(tab: Pick<RecentTab, "type">): RecentTabsSection {
	return tab.type === "project" ? "projects" : "work";
}

function sectionFromKey(key: string): RecentTabsSection {
	return key.startsWith("project:") ? "projects" : "work";
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
	section: RecentTabsSection,
	updater: (tabs: RecentTab[], data: RecentTabsInfiniteData) => RecentTab[],
	revision?: number,
): void {
	qc.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section), (data) => {
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

function syncCompatibilityCache(qc: QueryClient): void {
	const projects = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects")),
	);
	const work = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work")),
	);
	// Same reasoning as `replaceLoadedTabs`: this flat array is a separate cache entry
	// that several components read, so re-allocating it on an unchanged tick would
	// re-render them even after the section windows correctly stayed put.
	qc.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, (previous) => {
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
): RecentTabsDeltaApplyResult {
	if (!Number.isFinite(delta.revision) || delta.revision <= 0) return NO_DELTA_FOLLOW_UP;
	const baseRevision = delta.baseRevision ?? delta.revision - 1;
	const loaded = (["projects", "work"] as const)
		.map((section) => ({
			section,
			key: recentTabsSectionQueryKey(section),
			data: qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section)),
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
	syncCompatibilityCache(qc);
	return { gaps: [], backfill };
}

export function applyRecentTabsRuntimePatches(
	qc: QueryClient,
	patches: Array<{ key: string; patch: Record<string, unknown> }>,
): void {
	if (patches.length === 0) return;
	const patchMap = new Map(patches.map(({ key, patch }) => [key, patch]));
	for (const section of ["projects", "work"] as const) {
		updateSectionData(qc, section, (tabs) => {
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
	syncCompatibilityCache(qc);
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
	return tabs.filter((tab) => isKept(tab) || tab.type === "project" || isAttentionTab(tab));
}

function snapshotSections(
	qc: QueryClient,
): Record<RecentTabsSection, RecentTabsInfiniteData | undefined> {
	return {
		projects: qc.getQueryData(recentTabsSectionQueryKey("projects")),
		work: qc.getQueryData(recentTabsSectionQueryKey("work")),
	};
}

function restoreSectionSnapshots(
	qc: QueryClient,
	snapshots: Record<RecentTabsSection, RecentTabsInfiniteData | undefined>,
): void {
	for (const section of ["projects", "work"] as const) {
		const current = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section));
		const snapshot = snapshots[section];
		if (
			(current !== undefined && recentTabsDataRevision(current) === undefined) ||
			recentTabsDataRevision(current) !== recentTabsDataRevision(snapshot)
		) {
			void qc.invalidateQueries({ queryKey: recentTabsSectionQueryKey(section), exact: true });
			continue;
		}
		qc.setQueryData(recentTabsSectionQueryKey(section), snapshot);
	}
	syncCompatibilityCache(qc);
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
): Promise<void> {
	const section = recentTabsSectionQueryKey(type === "project" ? "projects" : "work");
	await qc.cancelQueries({ queryKey: section });
	const snapshots = snapshotSections(qc);
	updateSectionData(qc, type === "project" ? "projects" : "work", (current) =>
		applyOperation(current, { type: "remove", key: `${type}:${id}` }),
	);
	syncCompatibilityCache(qc);
	try {
		const result = await api.removeRecentTab(type, id, {
			cascade: true,
			keepEmptyFolder: options.keepEmptyFolder,
		});
		await applyRecentTabsDeltaAndFollowUp(qc, mutationDelta(result));
	} catch {
		restoreSectionSnapshots(qc, snapshots);
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
): Promise<Map<RecentTabsSection, RecentTabsInfiniteData>> {
	const firstPages = await Promise.all(
		plans.map(async (plan) => ({
			plan,
			page: await api.getRecentTabsPage(plan.section, { limit: RECENT_TABS_PAGE_SIZE }),
		})),
	);
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
	section: RecentTabsSection,
	data: RecentTabsInfiniteData,
	fallbackTabs: ReadonlyMap<string, RecentTab>,
): RecentTabsInfiniteData {
	const current = new Map(
		flattenPages(qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section))).map(
			(tab) => [tabKey(tab), tab],
		),
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

export function refreshRecentTabsLoadedWindow(
	qc: QueryClient,
	options: { reset?: boolean; minimumRevision?: number } = {},
): Promise<void> {
	const now = Date.now();
	const minimumRevision = options.minimumRevision ?? 0;
	const existing = loadedWindowRefreshes.get(qc);
	if (
		existing &&
		now - existing.startedAt < RECENT_TABS_REFRESH_DEDUPE_MS &&
		(existing.reset || !options.reset) &&
		existing.minimumRevision >= minimumRevision
	) {
		return existing.promise;
	}
	const generation = (loadedWindowRefreshGenerations.get(qc) ?? 0) + 1;
	loadedWindowRefreshGenerations.set(qc, generation);
	const plans = (["projects", "work"] as const).flatMap((section) => {
		const data = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section));
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
				qc.cancelQueries({ queryKey: recentTabsSectionQueryKey(section), exact: true }),
			),
		);
		if (options.reset && loadedWindowRefreshGenerations.get(qc) === generation) {
			for (const { section } of plans) {
				qc.setQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section), (data) =>
					data ? { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) } : data,
				);
			}
			syncCompatibilityCache(qc);
		}
		let windows: Map<RecentTabsSection, RecentTabsInfiniteData> | undefined;
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				windows = await fetchLoadedWindows(plans, minimumRevision);
				break;
			} catch (error) {
				lastError = error;
				if (!isRecentTabsStaleCursorError(error)) throw error;
			}
		}
		if (!windows) throw lastError;
		if (loadedWindowRefreshGenerations.get(qc) !== generation) return;
		for (const { section, truncatedTabs } of plans) {
			const data = windows.get(section);
			if (!data) continue;
			// Re-read the cache HERE, not before the fetch: WS runtime events that landed
			// while the pages were in flight are already in the cache, and a pre-fetch
			// snapshot would roll status/substatus icons back to their pre-event values.
			qc.setQueryData(
				recentTabsSectionQueryKey(section),
				withCachedRuntimeFields(qc, section, data, truncatedTabs),
			);
		}
		syncCompatibilityCache(qc);
	})().catch((error) => {
		if (options.reset && loadedWindowRefreshGenerations.get(qc) === generation) {
			for (const { section } of plans) {
				void qc.invalidateQueries({ queryKey: recentTabsSectionQueryKey(section), exact: true });
			}
		}
		throw error;
	});
	loadedWindowRefreshes.set(qc, {
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
): Promise<void> {
	const { gaps, backfill } = applyRecentTabsDelta(qc, delta);
	if (gaps.length === 0 && backfill.length === 0) return Promise.resolve();
	return refreshRecentTabsLoadedWindow(qc, {
		reset: gaps.length > 0,
		minimumRevision: delta.revision,
	});
}

function useRecentTabsSection(section: RecentTabsSection) {
	const qc = useQueryClient();
	return useInfiniteQuery({
		queryKey: recentTabsSectionQueryKey(section),
		queryFn: async ({ pageParam, signal }) => {
			const page = await api.getRecentTabsPage(section, {
				limit: RECENT_TABS_PAGE_SIZE,
				...(pageParam ? { cursor: pageParam } : {}),
				signal,
			});
			const current = qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section));
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

export function useRecentTabs() {
	const qc = useQueryClient();
	const { t } = useTranslation("nav");
	const projectsQuery = useRecentTabsSection("projects");
	const workQuery = useRecentTabsSection("work");
	const projectTabs = useMemo(() => flattenPages(projectsQuery.data), [projectsQuery.data]);
	const workTabs = useMemo(() => flattenPages(workQuery.data), [workQuery.data]);
	const tabs = useMemo(() => [...projectTabs, ...workTabs], [projectTabs, workTabs]);

	// Every mounted `useRecentTabs()` maintains the flat compatibility array, and each
	// one memoizes its own copy — so writing unconditionally meant N cache writes per
	// change for a value that had not changed.
	useEffect(() => {
		qc.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, (previous) =>
			sameTabList(previous, tabs) ? (previous as RecentTab[]) : tabs,
		);
	}, [qc, tabs]);

	const applyAuthoritativeResult = useCallback(
		(result: RecentTabsMutationResponse) => {
			void applyRecentTabsDeltaAndFollowUp(qc, mutationDelta(result)).catch(() => {});
		},
		[qc],
	);

	const restoreMutation = useMutation({
		mutationFn: (input: { snapshot?: RecentTab[]; token?: string }) => {
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
		onError: () => {
			void qc.invalidateQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			notifications.show({ color: "red", message: t("undoFailed") });
		},
	});

	/**
	 * Shared undo toast for destructive recent-tab mutations (clear, single-tab close).
	 * Only one undo affordance is offered at a time — later mutations replace the toast,
	 * matching the server's single pending undo token per user.
	 */
	const showUndoNotification = useCallback(
		(message: string, undo: { undoToken?: string; snapshot?: RecentTab[] }) => {
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
								// Hide immediately so a second click cannot fire a duplicate restore.
								// Failure feedback is a separate `undoFailed` toast.
								notifications.hide(UNDO_NOTIFICATION_ID);
								if (undo.undoToken) restoreMutation.mutate({ token: undo.undoToken });
								else if (snapshot) restoreMutation.mutate({ snapshot });
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
		mutationFn: ({ type, id }: { type: RecentTab["type"]; id: string }) =>
			api.removeRecentTab(type, id),
		onMutate: async ({ type, id }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			const section = type === "project" ? "projects" : "work";
			updateSectionData(qc, section, (current) => applyRecentTabRemove(current, `${type}:${id}`));
			syncCompatibilityCache(qc);
			return { snapshots };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: (result, variables) => {
			applyAuthoritativeResult(result);
			// Single-tab (or whole-folder) close via swipe / context menu / middle-click — same
			// undo affordance as one-click clear. Token-only: a loaded-window snapshot would
			// wipe unloaded pages if used as a full-list restore fallback.
			if (!result.removedCount || !result.undoToken) return;
			showUndoNotification(t(variables.type === "folder" ? "folderClosed" : "tabClosed"), {
				undoToken: result.undoToken,
			});
		},
	});

	const moveMutation = useMutation({
		mutationFn: ({ key, target }: { key: string; target: RecentTabMoveTarget }) =>
			api.moveRecentTab(key, target),
		onMutate: async ({ key, target }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			updateSectionData(qc, sectionFromKey(key), (current) =>
				applyRecentTabMove(current, key, target),
			);
			syncCompatibilityCache(qc);
			return { snapshots };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: (result) => {
			applyAuthoritativeResult(result);
			// A move can change which folder's git identity a session follows.
			void invalidateNarratorGitIdentities(qc);
		},
	});

	const pinMutation = useMutation({
		mutationFn: ({ key, pinned }: { key: string; pinned: boolean }) =>
			api.pinRecentTab(key, pinned),
		onMutate: async ({ key, pinned }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			updateSectionData(qc, sectionFromKey(key), (current) =>
				applyRecentTabPin(current, key, pinned),
			);
			syncCompatibilityCache(qc);
			return { snapshots };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: applyAuthoritativeResult,
	});

	/** Optimistic local edit + server call for the folder endpoints. */
	const runFolderMutation = useCallback(
		async (
			request: () => Promise<RecentTabsMutationResponse>,
			optimistic?: (tabs: RecentTab[]) => RecentTab[],
		): Promise<RecentTabsMutationResponse> => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			if (optimistic) {
				updateSectionData(qc, "work", optimistic);
				syncCompatibilityCache(qc);
			}
			try {
				const result = await request();
				applyAuthoritativeResult(result);
				return result;
			} catch (error) {
				restoreSectionSnapshots(qc, snapshots);
				notifications.show({ color: "red", message: t("folderActionFailed") });
				throw error;
			}
		},
		[qc, applyAuthoritativeResult, t],
	);

	const clearMutation = useMutation({
		mutationFn: ({
			scope,
			keepTabKey,
		}: {
			scope: "all" | "projects" | "inactive_narrators";
			keepTabKey?: string;
		}) => api.clearRecentTabs(scope, keepTabKey),
		onMutate: async ({ scope, keepTabKey }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			const snapshot = [...flattenPages(snapshots.projects), ...flattenPages(snapshots.work)];
			let removedCount = 0;
			for (const section of ["projects", "work"] as const) {
				updateSectionData(qc, section, (current) => {
					const next = clearLoadedTabs(current, scope, keepTabKey);
					removedCount += current.length - next.length;
					return next;
				});
			}
			syncCompatibilityCache(qc);
			return { snapshots, snapshot, removedCount };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: (result, _variables, context) => {
			applyAuthoritativeResult(result);
			const removedCount = result.removedCount ?? context?.removedCount ?? 0;
			if (!context || removedCount <= 0) return;
			showUndoNotification(t("tabsCleared", { count: removedCount }), {
				...(result.undoToken ? { undoToken: result.undoToken } : {}),
				snapshot: context.snapshot,
			});
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
				void query
					.fetchNextPage()
					.then((result) => {
						if (isRecentTabsStaleCursorError(result.error)) {
							return refreshRecentTabsLoadedWindow(qc, { reset: true });
						}
					})
					.catch((error) => {
						if (isRecentTabsStaleCursorError(error)) {
							return refreshRecentTabsLoadedWindow(qc, { reset: true });
						}
					});
			},
			retry: () => {
				void query.refetch();
			},
		}),
		[qc],
	);

	return {
		tabs,
		projectTabs,
		workTabs,
		projects: toSectionState(projectsQuery, projectTabs),
		work: toSectionState(workQuery, workTabs),
		removeTab: useCallback(
			(type: RecentTab["type"], id: string) => removeMutation.mutate({ type, id }),
			[removeMutation],
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
			) => moveMutation.mutate({ key, target }, { onError: options?.onError }),
			[moveMutation],
		),
		pinTab: useCallback(
			(key: string, pinned: boolean) => pinMutation.mutate({ key, pinned }),
			[pinMutation],
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
					showUndoNotification(t("folderDissolved"), { undoToken: result.undoToken });
				}
			},
			[runFolderMutation, showUndoNotification, t],
		),
		clearTabs: useCallback(
			(scope: "all" | "projects" | "inactive_narrators", keepTabKey?: string) =>
				clearMutation.mutate({ scope, keepTabKey }),
			[clearMutation],
		),
		restoreTabs: useCallback(
			(snapshot: RecentTab[]) => restoreMutation.mutate({ snapshot }),
			[restoreMutation],
		),
	};
}

async function applyGlobalRecentTabsMutation(
	request: Promise<RecentTabsMutationResponse>,
): Promise<void> {
	const result = await request;
	await applyRecentTabsDeltaAndFollowUp(globalQC, mutationDelta(result));
}

export function addRecentTab(tab: AddRecentTabInput): Promise<void> {
	return applyGlobalRecentTabsMutation(api.upsertRecentTab(buildRecentTabUpsert(tab))).catch(
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
export function addRecentTabOrThrow(
	tab: AddRecentTabInput,
	anchor?: { beforeKey: string } | { afterKey: string },
): Promise<void> {
	return applyGlobalRecentTabsMutation(
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

function isRecentTabLoaded(key: string): boolean {
	for (const section of ["projects", "work"] as const) {
		const data = globalQC.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey(section));
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
export function recordRecentTabVisit(tab: AddRecentTabInput): Promise<void> {
	const key = `${tab.type}:${tab.id}`;
	const signature = recentTabVisitSignature(tab);
	if (visitSignatures.get(key) === signature && isRecentTabLoaded(key)) {
		return Promise.resolve();
	}
	rememberVisitSignature(key, signature);
	return applyGlobalRecentTabsMutation(api.upsertRecentTab(buildRecentTabUpsert(tab))).catch(
		(error) => {
			// A failed write must not be remembered as persisted, or the tab would stay
			// missing until something else happened to change the signature.
			if (visitSignatures.get(key) === signature) visitSignatures.delete(key);
			if (import.meta.env.DEV) console.warn("[useRecentTabs] upsertRecentTab failed:", error);
		},
	);
}

export function addRecentTabsBatch(tabs: AddRecentTabInput[]): Promise<void> {
	if (tabs.length === 0) return Promise.resolve();
	return applyGlobalRecentTabsMutation(
		api.upsertRecentTabsBatch(tabs.map(buildRecentTabUpsert)),
	).catch((error) => {
		if (import.meta.env.DEV) console.warn("[useRecentTabs] batch upsert failed:", error);
		throw error;
	});
}

export function addSubagentRecentTab(input: SubagentRecentTabInput): void {
	void recordRecentTabVisit(buildSubagentRecentTab(input)).catch(() => {});
}

export function updateRecentTabLocal(
	type: RecentTab["type"],
	id: string,
	patch: Partial<Pick<RecentTab, "title" | "subtitle" | "status">>,
) {
	const normalizedPatch = { ...patch };
	if ("title" in patch) normalizedPatch.title = clampRecentTabText(patch.title);
	if ("subtitle" in patch) normalizedPatch.subtitle = clampRecentTabText(patch.subtitle);
	updateSectionData(globalQC, type === "project" ? "projects" : "work", (tabs) => {
		let changed = false;
		const next = tabs.map((tab) => {
			if (tab.type !== type || tab.id !== id) return tab;
			changed = true;
			return { ...tab, ...normalizedPatch };
		});
		return changed ? next : tabs;
	});
	syncCompatibilityCache(globalQC);
}
