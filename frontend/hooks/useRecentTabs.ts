import { Button } from "@mantine/core";
import { notifications } from "@mantine/notifications";
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
	RecentTabMoveTarget as ApiRecentTabMoveTarget,
	RecentTabsMutationResponse,
	RecentTabsPageResponse,
} from "../lib/api/settings";
import { queryClient as globalQC } from "../lib/query-client";
import type { AddRecentTabInput, RecentTab, SubagentRecentTabInput } from "./recent-tabs-utils";
import {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	clampRecentTabText,
	mergeRecentTabPatch,
	mergeRecentTabRuntime,
	normalizeRecentTab,
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
	isSameRecentTab,
	mergeRecentTabPatch,
	mergeRecentTabRuntime,
	normalizeRecentTab,
	normalizeRecentTabViewers,
	pruneRecentTabsRuntimeVersions,
	RECENT_TAB_TEXT_MAX_CHARS,
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

const CLEAR_UNDO_NOTIFICATION_ID = "recent-tabs-clear-undo";
const CLEAR_UNDO_AUTO_CLOSE_MS = 6_000;

export type RecentTabsInfiniteData = InfiniteData<RecentTabsPageResponse>;
export type RecentTabApiMoveTarget = ApiRecentTabMoveTarget;
export type RecentTabMoveTarget =
	| RecentTabApiMoveTarget
	| { afterKey: string }
	| { beforeKey: string };

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

function replaceLoadedTabs(
	data: RecentTabsInfiniteData,
	tabs: RecentTab[],
	revision?: number,
): RecentTabsInfiniteData {
	const previousCount = data.pages.reduce((count, page) => count + page.items.length, 0);
	const lastPage = data.pages.at(-1);
	const capacity = data.pages.length * RECENT_TABS_PAGE_SIZE;
	const visibleCount = Math.min(
		tabs.length,
		Math.max(previousCount, Math.min(tabs.length, capacity)),
	);
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
	return { ...data, pages };
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

function syncCompatibilityCache(qc: QueryClient): void {
	const projects = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("projects")),
	);
	const work = flattenPages(
		qc.getQueryData<RecentTabsInfiniteData>(recentTabsSectionQueryKey("work")),
	);
	qc.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, [...projects, ...work]);
}

/** Enforce workspace grouping: each header is immediately followed by its loaded children. */
function regroupTabs(tabs: RecentTab[]): void {
	const childrenByWorkspace = new Map<string, RecentTab[]>();
	for (const tab of tabs) {
		if (!tab.workspaceId) continue;
		const children = childrenByWorkspace.get(tab.workspaceId);
		if (children) children.push(tab);
		else childrenByWorkspace.set(tab.workspaceId, [tab]);
	}
	if (childrenByWorkspace.size === 0) return;

	for (let index = tabs.length - 1; index >= 0; index--) {
		if (tabs[index].workspaceId) tabs.splice(index, 1);
	}
	const headerIds = new Set<string>();
	for (let index = 0; index < tabs.length; index++) {
		const tab = tabs[index];
		if (tab.type !== "workspace") continue;
		headerIds.add(tab.id);
		const children = childrenByWorkspace.get(tab.id);
		if (children?.length) {
			tabs.splice(index + 1, 0, ...children);
			index += children.length;
		}
	}
	for (const [workspaceId, children] of childrenByWorkspace) {
		if (headerIds.has(workspaceId)) continue;
		tabs.push(...children.map((child) => ({ ...child, workspaceId: undefined })));
	}
}

function getPinnedSectionEndIndex(tabs: RecentTab[]): number {
	let index = 0;
	while (index < tabs.length) {
		const tab = tabs[index];
		if (tab.workspaceId) {
			index++;
			continue;
		}
		if (!tab.pinned) break;
		index++;
		if (tab.type === "workspace") {
			while (index < tabs.length && tabs[index]?.workspaceId === tab.id) index++;
		}
	}
	return index;
}

export function applyRecentTabMove(
	tabs: RecentTab[],
	key: string,
	target: RecentTabMoveTarget,
): RecentTab[] {
	const index = tabs.findIndex((tab) => tabKey(tab) === key);
	if (index === -1) return tabs;
	const next = [...tabs];
	const tab = next[index];
	let movedGroup: RecentTab[];
	if (tab.type === "workspace") {
		let end = index + 1;
		while (end < next.length && next[end].workspaceId === tab.id) end++;
		movedGroup = next.splice(index, end - index);
	} else {
		movedGroup = next.splice(index, 1);
	}

	if ("afterKey" in target) {
		const anchor = next.findIndex((item) => tabKey(item) === target.afterKey);
		next.splice(anchor === -1 ? next.length : anchor + 1, 0, ...movedGroup);
	} else if ("beforeKey" in target) {
		const anchor = next.findIndex((item) => tabKey(item) === target.beforeKey);
		next.splice(anchor === -1 ? 0 : anchor, 0, ...movedGroup);
	} else if ("toIndex" in target) {
		next.splice(Math.min(target.toIndex, next.length), 0, ...movedGroup);
	} else {
		next.unshift(...movedGroup);
	}
	regroupTabs(next);
	return next;
}

function applyOperation(tabs: RecentTab[], operation: RecentTabsOperation): RecentTab[] {
	if (operation.type === "remove") {
		const removed = tabs.find((tab) => tabKey(tab) === operation.key);
		if (!removed) return tabs;
		if (removed.type === "workspace") {
			return tabs
				.filter((tab) => tabKey(tab) !== operation.key)
				.map((tab) => (tab.workspaceId === removed.id ? { ...tab, workspaceId: undefined } : tab));
		}
		return tabs.filter((tab) => tabKey(tab) !== operation.key);
	}
	if (operation.type === "move") {
		if (operation.beforeKey) {
			return applyRecentTabMove(tabs, operation.key, { beforeKey: operation.beforeKey });
		}
		if (operation.afterKey) {
			return applyRecentTabMove(tabs, operation.key, { afterKey: operation.afterKey });
		}
		return tabs;
	}

	// Deltas only carry persisted columns, so an upsert for an already-rendered tab must
	// keep its live runtime fields (status colour, terminal count, viewers, container badge).
	// Otherwise every revisit blanks the row until the next runtime poll lands.
	const nextTab = mergeRecentTabRuntime(
		operation.tab,
		tabs.find((tab) => tabKey(tab) === operation.key),
	);
	const withoutCurrent = tabs.filter((tab) => tabKey(tab) !== operation.key);
	let insertAt = getPinnedSectionEndIndex(withoutCurrent);
	if (operation.beforeKey) {
		const index = withoutCurrent.findIndex((tab) => tabKey(tab) === operation.beforeKey);
		if (index >= 0) insertAt = index;
	} else if (operation.afterKey) {
		const index = withoutCurrent.findIndex((tab) => tabKey(tab) === operation.afterKey);
		if (index >= 0) insertAt = index + 1;
	}
	withoutCurrent.splice(insertAt, 0, nextTab);
	regroupTabs(withoutCurrent);
	return withoutCurrent;
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

/** Apply a mutation/WS delta atomically across every loaded section. */
export function applyRecentTabsDelta(qc: QueryClient, delta: RecentTabsDelta): RecentTabsSection[] {
	if (!Number.isFinite(delta.revision) || delta.revision <= 0) return [];
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
	if (loaded.length === 0) return [];

	const revisions = loaded.map(({ data }) => recentTabsDataRevision(data));
	if (revisions.every((revision) => revision !== undefined && revision >= delta.revision))
		return [];
	if (revisions.some((revision) => revision === undefined || revision !== baseRevision)) {
		for (const section of ["projects", "work"] as const) {
			void qc.invalidateQueries({ queryKey: recentTabsSectionQueryKey(section), exact: true });
		}
		return ["projects", "work"];
	}

	for (const { section, key, data } of loaded) {
		const relevant = delta.operations.filter(
			(operation) => operationSection(operation) === section,
		);
		const nextTabs = reduceRecentTabsOperations(flattenPages(data), section, relevant);
		qc.setQueryData(key, replaceLoadedTabs(data, nextTabs, delta.revision));
	}
	syncCompatibilityCache(qc);
	return [];
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

function toPersistedRecentTab(tab: RecentTab): PersistedRecentTab {
	const persisted: PersistedRecentTab = {
		type: tab.type,
		id: tab.id,
		title: tab.title,
		lastVisitedAt: tab.lastVisitedAt,
	};
	if (tab.narratorId !== undefined) persisted.narratorId = tab.narratorId;
	if (tab.parentNarratorId !== undefined) persisted.parentNarratorId = tab.parentNarratorId;
	if (tab.workspaceId !== undefined) persisted.workspaceId = tab.workspaceId;
	if (tab.subtitle !== undefined) persisted.subtitle = tab.subtitle;
	if (tab.status !== undefined) persisted.status = tab.status;
	if (tab.pinned !== undefined) persisted.pinned = tab.pinned;
	if (tab.isScheduled !== undefined) persisted.isScheduled = tab.isScheduled;
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

function clearLoadedTabs(
	tabs: RecentTab[],
	scope: "all" | "projects" | "inactive_narrators",
	keepTabKey?: string,
): RecentTab[] {
	const isKept = (tab: RecentTab) => (keepTabKey ? tabKey(tab) === keepTabKey : false);
	if (scope === "all") return keepTabKey ? tabs.filter(isKept) : [];
	if (scope === "projects") return tabs.filter((tab) => tab.type !== "project" || isKept(tab));

	const childrenByWorkspace = new Map<string, RecentTab[]>();
	for (const tab of tabs) {
		if (!tab.workspaceId) continue;
		const children = childrenByWorkspace.get(tab.workspaceId);
		if (children) children.push(tab);
		else childrenByWorkspace.set(tab.workspaceId, [tab]);
	}
	const activeWorkspaces = new Set<string>();
	for (const tab of tabs) {
		if (tab.type !== "workspace") continue;
		if ((childrenByWorkspace.get(tab.id) ?? []).some(isAttentionTab)) activeWorkspaces.add(tab.id);
	}
	return tabs.filter((tab) => {
		if (isKept(tab) || tab.type === "project") return true;
		if (tab.type === "workspace") return activeWorkspaces.has(tab.id);
		if (tab.workspaceId) return activeWorkspaces.has(tab.workspaceId);
		return isAttentionTab(tab);
	});
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

	useEffect(() => {
		qc.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, tabs);
	}, [qc, tabs]);

	const applyAuthoritativeResult = useCallback(
		(result: RecentTabsMutationResponse) => {
			const gaps = applyRecentTabsDelta(qc, mutationDelta(result));
			void refreshRecentTabsLoadedWindow(qc, {
				reset: gaps.length > 0,
				minimumRevision: result.revision,
			}).catch(() => {});
		},
		[qc],
	);

	const removeMutation = useMutation({
		mutationFn: ({ type, id }: { type: RecentTab["type"]; id: string }) =>
			api.removeRecentTab(type, id),
		onMutate: async ({ type, id }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			const section = type === "project" ? "projects" : "work";
			updateSectionData(qc, section, (current) =>
				applyOperation(current, { type: "remove", key: `${type}:${id}` }),
			);
			syncCompatibilityCache(qc);
			return { snapshots };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: applyAuthoritativeResult,
	});

	const moveMutation = useMutation({
		mutationFn: ({ key, target }: { key: string; target: RecentTabApiMoveTarget }) =>
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
		onSuccess: applyAuthoritativeResult,
	});

	const pinMutation = useMutation({
		mutationFn: ({ key, pinned }: { key: string; pinned: boolean }) =>
			api.pinRecentTab(key, pinned),
		onMutate: async ({ key, pinned }) => {
			await qc.cancelQueries({ queryKey: RECENT_TABS_QUERY_KEY });
			const snapshots = snapshotSections(qc);
			updateSectionData(qc, sectionFromKey(key), (current) => {
				const index = current.findIndex((tab) => tabKey(tab) === key);
				if (index === -1) return current;
				const next = [...current];
				const tab = { ...next[index], pinned: pinned || undefined };
				next.splice(index, 1);
				next.splice(getPinnedSectionEndIndex(next), 0, tab);
				regroupTabs(next);
				return next;
			});
			syncCompatibilityCache(qc);
			return { snapshots };
		},
		onError: (_error, _variables, context) => {
			if (context) restoreSectionSnapshots(qc, context.snapshots);
		},
		onSuccess: applyAuthoritativeResult,
	});

	const restoreMutation = useMutation({
		mutationFn: (input: { snapshot?: RecentTab[]; token?: string }) =>
			api.restoreRecentTabs({
				...(input.token ? { token: input.token } : {}),
				...(input.snapshot ? { tabs: input.snapshot.map(toPersistedRecentTab) } : {}),
			}),
		onSuccess: applyAuthoritativeResult,
		onError: () => {
			void qc.invalidateQueries({ queryKey: RECENT_TABS_QUERY_KEY });
		},
	});

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
			notifications.show({
				id: CLEAR_UNDO_NOTIFICATION_ID,
				color: "gray",
				autoClose: CLEAR_UNDO_AUTO_CLOSE_MS,
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
					createElement("span", null, t("tabsCleared", { count: removedCount })),
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
								notifications.hide(CLEAR_UNDO_NOTIFICATION_ID);
								restoreMutation.mutate(
									result.undoToken ? { token: result.undoToken } : { snapshot: context.snapshot },
								);
							},
						},
						t("undo"),
					),
				),
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
		moveTab: useCallback(
			(key: string, target: RecentTabApiMoveTarget) => moveMutation.mutate({ key, target }),
			[moveMutation],
		),
		pinTab: useCallback(
			(key: string, pinned: boolean) => pinMutation.mutate({ key, pinned }),
			[pinMutation],
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
	const gaps = applyRecentTabsDelta(globalQC, mutationDelta(result));
	await refreshRecentTabsLoadedWindow(globalQC, {
		reset: gaps.length > 0,
		minimumRevision: result.revision,
	});
}

export function addRecentTab(tab: AddRecentTabInput): Promise<void> {
	return applyGlobalRecentTabsMutation(api.upsertRecentTab(buildRecentTabUpsert(tab))).catch(
		(error) => {
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
	void addRecentTab(buildSubagentRecentTab(input)).catch(() => {});
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
