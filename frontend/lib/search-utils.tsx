import { Mark } from "@mantine/core";
import type { ReactNode } from "react";
import type { SearchFallback, SearchResponse } from "./api";

export type SearchResultType = "all" | "chapter" | "narrator" | "message";

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
		case "all":
		case undefined:
		case null:
			return "all";
		default:
			return "all";
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
