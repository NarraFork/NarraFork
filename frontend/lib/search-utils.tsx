import { Mark } from "@mantine/core";
import type { ReactNode } from "react";
import type { SearchFallback, SearchResponse } from "./api";

export type SearchResultType = "all" | "chapter" | "narrator" | "message" | "knowledge";

export function normalizeSearchType(value: unknown): SearchResultType {
	switch (value) {
		case "chapter":
		case "chapters":
			return "chapter";
		case "narrator":
		case "narrators":
			return "narrator";
		case "message":
		case "messages":
			return "message";
		case "knowledge":
			return "knowledge";
		case "all":
		case undefined:
		case null:
			return "all";
		default:
			return "all";
	}
}

/** Sort modes the search page offers. `time` (newest first) is the default. */
export type SearchSortMode = "time" | "relevance" | "type" | "title";

/**
 * Default sort for the global search page: newest first.
 *
 * Relevance ranking on a trigram index puts short-but-old matches ahead of the
 * work in front of you, so recency is the better default and relevance stays one
 * click away.
 */
export const DEFAULT_SEARCH_SORT: SearchSortMode = "time";

export function normalizeSearchSort(value: unknown): SearchSortMode {
	switch (value) {
		case "relevance":
		case "type":
		case "title":
		case "time":
			return value;
		default:
			return DEFAULT_SEARCH_SORT;
	}
}

export function getSearchResultDisplayTitle(
	result: {
		id?: string;
		title?: string | null;
		narratorTitle?: string | null;
		chapterTitle?: string | null;
	},
	untitled: (id: string) => string,
): string {
	return (
		result.title ||
		result.narratorTitle ||
		result.chapterTitle ||
		untitled(String(result.id ?? "").slice(0, 8))
	);
}

interface SortableSearchResult {
	id?: string;
	type?: string;
	title?: string | null;
	narratorTitle?: string | null;
	chapterTitle?: string | null;
	updatedAt?: string | null;
	createdAt?: string | null;
	lastMessageAt?: string | null;
	matchScore?: number;
}

/** All result types share one ordering; only explicit type sorting groups them. */
export function sortVisibleSearchResults<T extends SortableSearchResult>(
	results: readonly T[],
	type: SearchResultType,
	sort: SearchSortMode,
	untitled: (id: string) => string,
): T[] {
	const items = results.filter((result) => type === "all" || result.type === type);
	if (sort === "title") {
		return items
			.map((result) => ({ result, title: getSearchResultDisplayTitle(result, untitled) }))
			.sort((a, b) => a.title.localeCompare(b.title))
			.map(({ result }) => result);
	}
	return items.sort((a, b) => {
		if (sort === "time") {
			const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? b.lastMessageAt ?? "") || 0;
			const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? a.lastMessageAt ?? "") || 0;
			return bTime - aTime;
		}
		if (sort === "type") return String(a.type).localeCompare(String(b.type));
		return (b.matchScore ?? 0) - (a.matchScore ?? 0);
	});
}
export function normalizeSearchText(value: unknown): string {
	return String(value ?? "")
		.toLowerCase()
		.trim();
}

export function includesSearch(text: unknown, query: string): boolean {
	const normalizedQuery = normalizeSearchText(query);
	if (!normalizedQuery) return true;
	return normalizeSearchText(text).includes(normalizedQuery);
}

export interface SearchRuntimeStatus {
	degraded: boolean;
	mode?: string;
	fallbackMessages: string[];
}

export function formatSearchFallbackMessage(fallback: SearchFallback): string {
	const scope = String(fallback.entity ?? fallback.feature ?? "search");
	const detail = String(
		fallback.reason ?? fallback.message ?? fallback.error ?? fallback.code ?? "fallback",
	);
	const route = fallback.from && fallback.to ? ` (${fallback.from} → ${fallback.to})` : "";
	return `${scope}: ${detail}${route}`;
}

export function summarizeSearchRuntimeState(response?: SearchResponse): SearchRuntimeStatus {
	const metadataFallbacks = Array.isArray(response?.searchMetadata?.fallbacks)
		? response.searchMetadata.fallbacks
		: [];
	const topLevelFallbacks = Array.isArray(response?.fallbacks) ? response.fallbacks : [];
	const seen = new Set<string>();
	const fallbackMessages = [...metadataFallbacks, ...topLevelFallbacks]
		.map((fallback) => formatSearchFallbackMessage(fallback))
		.filter((message) => {
			if (seen.has(message)) return false;
			seen.add(message);
			return true;
		});
	return {
		degraded:
			response?.degraded === true ||
			response?.searchMetadata?.degraded === true ||
			fallbackMessages.length > 0,
		mode: response?.searchMetadata?.mode,
		fallbackMessages,
	};
}

export function highlightSearchText(text: string, query: string): ReactNode {
	if (!query) return text;
	const normalizedQuery = query.trim();
	if (!normalizedQuery) return text;
	const escaped = normalizedQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const parts = text.split(new RegExp(`(${escaped})`, "gi"));
	if (parts.length === 1) return text;
	return parts.map((part, i) =>
		part.toLowerCase() === normalizedQuery.toLowerCase() ? (
			// biome-ignore lint/suspicious/noArrayIndexKey: stable split output
			<Mark key={i} color="yellow">
				{part}
			</Mark>
		) : (
			part
		),
	);
}

export function compactSnippet(text: string, query: string, radius = 96): string {
	const clean = text.replace(/\s+/g, " ").trim();
	const normalizedQuery = normalizeSearchText(query);
	if (!normalizedQuery) return clean.slice(0, radius * 2);
	const index = clean.toLowerCase().indexOf(normalizedQuery);
	if (index < 0) return clean.slice(0, radius * 2);
	const start = Math.max(0, index - radius);
	const end = Math.min(clean.length, index + normalizedQuery.length + radius);
	return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}
