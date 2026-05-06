import { useEffect, useRef } from "react";
import { includesSearch, normalizeSearchText } from "../../lib/search-utils";

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
