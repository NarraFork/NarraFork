import type { CustomSearchProviderConfig, SearchChannelConfig } from "../../settings/types";
import type { SearchChannelResult, SearchRequest, SearchResultItem } from "../types";

// ─── Option helpers ───────────────────────────────────────────────────────────

export function optionRecord(provider: CustomSearchProviderConfig): Record<string, unknown> {
	return provider.options &&
		typeof provider.options === "object" &&
		!Array.isArray(provider.options)
		? provider.options
		: {};
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function stringOption(
	options: Record<string, unknown>,
	key: string,
	fallback?: string,
): string | undefined {
	const value = options[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function booleanOption(
	options: Record<string, unknown>,
	key: string,
	fallback?: boolean,
): boolean | undefined {
	const value = options[key];
	return typeof value === "boolean" ? value : fallback;
}

export function boundedInt(
	value: number | undefined,
	min: number,
	max: number,
	fallback: number,
): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value ?? fallback), min), max);
}

// ─── Header helpers ───────────────────────────────────────────────────────────

export function headerExists(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

export function setHeaderIfMissing(
	headers: Record<string, string>,
	name: string,
	value: string,
): void {
	if (!headerExists(headers, name)) headers[name] = value;
}

export function providerHeaders(provider: CustomSearchProviderConfig): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(provider.headers ?? {})) {
		const header = key.trim();
		if (header) headers[header] = String(value);
	}
	return headers;
}

// ─── Domain filtering ─────────────────────────────────────────────────────────

function parseHostname(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return value
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.split("/")[0];
	}
}

function domainPatternHost(pattern: string): string {
	return parseHostname(pattern)?.replace(/^\*\./, "") ?? pattern.toLowerCase().replace(/^\*\./, "");
}

function matchesDomain(url: string | undefined, domains: string[] | undefined): boolean {
	if (!domains?.length) return false;
	const host = parseHostname(url);
	if (!host) return false;
	return domains.some((domain) => {
		const wanted = domainPatternHost(domain.trim());
		return !!wanted && (host === wanted || host.endsWith(`.${wanted}`));
	});
}

export function filterResultsByDomains(
	results: SearchResultItem[] | undefined,
	request: SearchRequest,
): SearchResultItem[] | undefined {
	if (!results || (!request.allowedDomains?.length && !request.blockedDomains?.length))
		return results;
	return results.filter((result) => {
		if (request.allowedDomains?.length && !matchesDomain(result.url, request.allowedDomains))
			return false;
		if (request.blockedDomains?.length && matchesDomain(result.url, request.blockedDomains))
			return false;
		return true;
	});
}

// ─── Result rendering ─────────────────────────────────────────────────────────

export function renderSearchResults(
	query: string,
	results: SearchResultItem[] | undefined,
): string {
	if (!results?.length) return "No results found";
	const lines = [`Search results for: ${query}`, ""];
	const sources: string[] = [];
	for (const [index, item] of results.entries()) {
		const title = item.title ?? item.url ?? `Result ${index + 1}`;
		lines.push(`${index + 1}. ${title}`);
		if (item.url) {
			lines.push(`   ${item.url}`);
			sources.push(`- [${title}](${item.url})`);
		}
		if (item.snippet) lines.push(`   ${item.snippet}`);
		const meta = [item.source, item.publishedAt].filter(Boolean).join(" · ");
		if (meta) lines.push(`   ${meta}`);
	}
	if (sources.length > 0) {
		lines.push("", "Sources:", ...sources);
	}
	return lines.join("\n");
}

// ─── Protocol metadata & adapter interface ────────────────────────────────────

export interface SearchProtocolMeta {
	/** Protocol ID — matches CustomSearchProviderConfig.protocol */
	id: string;
	label: { en: string; "zh-CN": string };
	description: { en: string; "zh-CN": string };
	defaultBaseUrl: string;
}

export interface AdapterContext {
	channel: SearchChannelConfig;
	channelLabel: string;
	provider: CustomSearchProviderConfig;
	request: SearchRequest;
	signal: AbortSignal;
}

/**
 * Unified adapter interface. Every protocol adapter file exports a single
 * object conforming to this interface. The registry is purely data-driven:
 * adding a new protocol = one new file + one entry in the adapters array.
 */
export interface SearchProtocolAdapter {
	meta: SearchProtocolMeta;
	/** Check whether the provider has enough config to be usable. */
	isUsable(provider: CustomSearchProviderConfig): boolean;
	/** Execute a search request. */
	execute(ctx: AdapterContext): Promise<SearchChannelResult>;
}
