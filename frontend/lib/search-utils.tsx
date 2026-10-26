import { Mark } from "@mantine/core";
import type { ReactNode } from "react";
import type { SearchSectionName, SearchSectionPage } from "./api";

/** The search page's tabs: everything, or one section. */
export type SearchTab = "all" | SearchSectionName;

/**
 * Parse the `tab` URL value. Also accepts the old `type` values, so a bookmarked
 * `?type=message` still opens the matching tab.
 */
export function normalizeSearchTab(value: unknown): SearchTab {
	switch (value) {
		case "sessions":
		case "session":
		case "message":
		case "messages":
		case "narrator":
		case "narrators":
			return "sessions";
		case "knowledge":
			return "knowledge";
		default:
			return "all";
	}
}

/** Sort modes the search page offers. */
export type SearchSortMode = "relevance" | "time";

/**
 * Default sort: relevance. Each section ranks within itself, and session relevance already
 * folds in recency, so the newest-first crutch is no longer needed.
 */
export const DEFAULT_SEARCH_SORT: SearchSortMode = "relevance";

export function normalizeSearchSort(value: unknown): SearchSortMode {
	return value === "time" ? "time" : DEFAULT_SEARCH_SORT;
}

/**
 * Content global search skips unless asked: subagent sessions, system-written rows
 * (injected knowledge hints, reminders, automation prompts), tool calls, archived sessions.
 */
export const SEARCH_INCLUDES = ["subagents", "system", "tools", "archived"] as const;
export type SearchInclude = (typeof SEARCH_INCLUDES)[number];

/** Parse the `include` URL value (comma-separated) into known names, in canonical order. */
export function normalizeSearchInclude(value: unknown): SearchInclude[] {
	const raw = Array.isArray(value) ? value.map(String) : String(value ?? "").split(",");
	const names = new Set(raw.map((name) => name.trim()));
	return SEARCH_INCLUDES.filter((name) => names.has(name));
}

/** Time range presets, in days. */
export const SEARCH_TIME_RANGES = { "7d": 7, "30d": 30, "90d": 90, "365d": 365 } as const;
export type SearchTimeRange = keyof typeof SEARCH_TIME_RANGES;

export function normalizeSearchRange(value: unknown): SearchTimeRange | undefined {
	return typeof value === "string" && value in SEARCH_TIME_RANGES
		? (value as SearchTimeRange)
		: undefined;
}

/**
 * Start of a range as an ISO instant, rounded down to the UTC day so it stays stable (and
 * cacheable) for the whole day instead of changing on every render.
 */
export function searchRangeStart(range: SearchTimeRange, now = Date.now()): string {
	const day = 86_400_000;
	return new Date(Math.floor(now / day) * day - SEARCH_TIME_RANGES[range] * day).toISOString();
}

/** A section's match count as shown: exact, or `N+` when the window filled up. */
export function formatSearchTotal(
	page: Pick<SearchSectionPage<unknown>, "total" | "totalIsLowerBound"> | undefined,
): string {
	if (!page) return "0";
	return `${page.total}${page.totalIsLowerBound ? "+" : ""}`;
}

/** Highest page a link may name; the server accepts the same. */
const MAX_SEARCH_PAGE = 10_000;

/** A page number from the URL: a whole number from 1, or undefined for the first page. */
export function normalizeSearchPage(value: unknown): number | undefined {
	const page = typeof value === "number" ? value : Number(value);
	return Number.isInteger(page) && page > 1 ? Math.min(page, MAX_SEARCH_PAGE) : undefined;
}

/** Pages a section's matches fill at `pageSize` per page (at least one). */
export function searchPageCount(
	page: Pick<SearchSectionPage<unknown>, "total"> | undefined,
	pageSize: number,
): number {
	return Math.max(1, Math.ceil((page?.total ?? 0) / Math.max(1, pageSize)));
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

/**
 * Each whitespace-separated query term, longest first so a longer term wins where two
 * overlap. Search matches terms on their own, so highlighting does too.
 */
export function searchHighlightTerms(query: string): string[] {
	const terms = new Map<string, string>();
	for (const term of query.trim().split(/\s+/)) {
		if (term) terms.set(term.toLowerCase(), term);
	}
	return [...terms.values()].sort((a, b) => b.length - a.length);
}

export function highlightSearchText(text: string, query: string): ReactNode {
	const terms = searchHighlightTerms(query ?? "");
	if (terms.length === 0) return text;
	const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
	const parts = text.split(new RegExp(`(${escaped.join("|")})`, "gi"));
	if (parts.length === 1) return text;
	const lowered = new Set(terms.map((term) => term.toLowerCase()));
	return parts.map((part, i) =>
		lowered.has(part.toLowerCase()) ? (
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
