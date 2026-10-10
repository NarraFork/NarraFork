import { useEffect, useRef } from "react";
import { includesSearch, normalizeSearchText } from "../../../lib/search-utils";
import type { NarratorListItem, NarratorListViewer } from "./NarratorListCard";

export interface NarratorListSearchParams {
	sortBy?: string;
	sortOrder?: string;
	filter?: string;
	q?: string;
	hasTerminals?: boolean;
	hasContainers?: boolean;
	hasRunningContainers?: boolean;
	hasViewers?: boolean;
}

export interface NarratorListState {
	sortBy: string;
	sortOrder: string;
	filter: string;
	localQuery: string;
	hasTerminals: boolean;
	hasContainers: boolean;
	hasRunningContainers: boolean;
	hasViewers: boolean;
}

interface NarratorListSearchable {
	title?: unknown;
	id?: unknown;
	cwd?: unknown;
	model?: unknown;
	status?: unknown;
	chapter?: {
		title?: unknown;
		projectName?: unknown;
	} | null;
}

export const parseBool = (v: unknown) => v === true || v === "true";

export function validateNarratorListSearch(
	search: Record<string, unknown>,
): NarratorListSearchParams {
	return {
		sortBy: typeof search.sortBy === "string" ? search.sortBy : undefined,
		sortOrder: typeof search.sortOrder === "string" ? search.sortOrder : undefined,
		filter: typeof search.filter === "string" ? search.filter : undefined,
		q: typeof search.q === "string" ? search.q : undefined,
		hasTerminals: parseBool(search.hasTerminals) || undefined,
		hasContainers: parseBool(search.hasContainers) || undefined,
		hasRunningContainers: parseBool(search.hasRunningContainers) || undefined,
		hasViewers: parseBool(search.hasViewers) || undefined,
	};
}

export function getNarratorListState(search: NarratorListSearchParams): NarratorListState {
	return {
		sortBy: search.sortBy ?? "updatedAt",
		sortOrder: search.sortOrder ?? "desc",
		filter: search.filter ?? "all",
		localQuery: search.q ?? "",
		hasTerminals: search.hasTerminals ?? false,
		hasContainers: search.hasContainers ?? false,
		hasRunningContainers: search.hasRunningContainers ?? false,
		hasViewers: search.hasViewers ?? false,
	};
}

export function normalizeNarratorListSearchPatch<T extends NarratorListSearchParams>(
	prev: T,
	patch: Partial<T>,
): T {
	const next = { ...prev, ...patch };
	if (next.sortBy === "updatedAt") next.sortBy = undefined;
	if (next.sortOrder === "desc") next.sortOrder = undefined;
	if (next.filter === "all") next.filter = undefined;
	if (!next.q?.trim()) next.q = undefined;
	if (!next.hasTerminals) next.hasTerminals = undefined;
	if (!next.hasContainers) next.hasContainers = undefined;
	if (!next.hasRunningContainers) next.hasRunningContainers = undefined;
	if (!next.hasViewers) next.hasViewers = undefined;
	return next as T;
}

export function buildNarratorListQueryOptions(state: NarratorListState, status?: string) {
	return {
		standalone: "all" as const,
		...(status ? { status } : {}),
		filter: state.filter === "all" ? undefined : state.filter,
		sortBy: state.sortBy,
		sortOrder: state.sortOrder,
		hasTerminals: state.hasTerminals || undefined,
		hasContainers: state.hasContainers || undefined,
		hasRunningContainers: state.hasRunningContainers || undefined,
		hasViewers: state.hasViewers || undefined,
	};
}

export function filterNarratorsByLocalQuery<T extends NarratorListSearchable>(
	narrators: T[],
	localQuery: string,
): T[] {
	const normalizedQuery = normalizeSearchText(localQuery);
	if (!normalizedQuery) return narrators;
	return narrators.filter((narrator) =>
		[
			narrator.title,
			narrator.id,
			narrator.cwd,
			narrator.model,
			narrator.status,
			narrator.chapter?.title,
			narrator.chapter?.projectName,
		]
			.filter(Boolean)
			.some((value) => includesSearch(value, localQuery)),
	);
}

export function useNarratorInfiniteScroll({
	disabled,
	hasNextPage,
	isFetchingNextPage,
	fetchNextPage,
}: {
	disabled?: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	fetchNextPage: () => unknown;
}) {
	const sentinelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (disabled) return;
		if (!sentinelRef.current || !hasNextPage) return;
		const observer = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting && !isFetchingNextPage) fetchNextPage();
		});
		observer.observe(sentinelRef.current);
		return () => observer.disconnect();
	}, [disabled, hasNextPage, isFetchingNextPage, fetchNextPage]);
	return sentinelRef;
}

/** The slice of a paginated narrators cache this reducer reads and writes. */
export interface NarratorsInfiniteData {
	pages: Array<{
		items: NarratorListItem[];
		[key: string]: unknown;
	}>;
	[key: string]: unknown;
}

/**
 * Minimal shape of the list WS event this reducer consumes.
 *
 * Structural rather than `NarratorListWSEvent` itself, because that type lives in
 * the WS hook while this reducer is the part worth unit-testing on its own.
 */
export interface NarratorListUpdateEvent {
	status?: string;
	substatus?: string[];
	title?: string;
	permissionMode?: string;
	viewers?: NarratorListViewer[];
}

/**
 * Row shape this reducer patches.
 *
 * Deliberately looser than `NarratorListItem`: a patch writes `updatedAt`, which
 * the card type does not declare, and typing the row as `NarratorListItem` would
 * reject its own output. The real rows are `NarratorListItem` with those extras.
 */
type MutableRow = NarratorListItem & Record<string, unknown>;

/**
 * Apply one narrator list WS event to the paginated cache.
 *
 * Two behaviours are load-bearing:
 *
 * 1. **Archiving removes the row rather than setting `status: "archived"`.** The
 *    paginated query already excludes archived narrators, so writing the status
 *    back would be undone by the next `invalidateQueries` — the refetch returns a
 *    list without the row, and a status-only patch leaves an archived narrator
 *    sitting in the active list.
 * 2. **Pages are re-shaped, never dropped.** An infinite query's `pages` and
 *    `pageParams` must stay the same length and index-aligned, so removing a row
 *    empties its page's `items` instead of deleting the page; the paginator skips
 *    empty pages on its own. Deleting one would misalign `pageParams` and corrupt
 *    the next `fetchNextPage` cursor.
 *
 * Returns the original object when nothing matched, so React Query sees the same
 * reference and skips notifying subscribers.
 */
export function applyNarratorListEvent(
	old: NarratorsInfiniteData | undefined,
	narratorId: string,
	event: NarratorListUpdateEvent,
): NarratorsInfiniteData | undefined {
	if (!old?.pages) return old;

	if (event.status === "archived") {
		let removed = false;
		const pages = old.pages.map((page) => {
			const items = page.items.filter((item) => {
				if (item.id === narratorId) {
					removed = true;
					return false;
				}
				return true;
			});
			return items.length === page.items.length ? page : { ...page, items };
		});
		return removed ? { ...old, pages } : old;
	}

	let changed = false;
	const pages = old.pages.map((page) => ({
		...page,
		items: page.items.map((item) => {
			if (item.id !== narratorId) return item;
			changed = true;
			const row = item as MutableRow;
			return {
				...row,
				...(event.status !== undefined ? { status: event.status } : {}),
				...(event.substatus !== undefined ? { substatus: event.substatus } : {}),
				...(event.title !== undefined ? { title: event.title } : {}),
				...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
				...(event.viewers !== undefined ? { viewers: event.viewers } : {}),
				updatedAt: new Date().toISOString(),
			};
		}),
	}));
	return changed ? { ...old, pages } : old;
}
