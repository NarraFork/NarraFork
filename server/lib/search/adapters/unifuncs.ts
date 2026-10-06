import type { CustomSearchProviderConfig } from "../../settings/types";
import type { SearchChannelResult, SearchRequest, SearchResultItem } from "../types";
import type { AdapterContext, SearchProtocolAdapter } from "./shared";
import {
	boundedInt,
	filterResultsByDomains,
	headerExists,
	providerHeaders,
	renderSearchResults,
	setHeaderIfMissing,
} from "./shared";

export const UNIFUNCS_DEFAULT_BASE_URL = "https://api.unifuncs.com/api/web-search";

function unifuncsFreshness(days: number | undefined): string | undefined {
	if (days == null || days <= 0) return undefined;
	if (days <= 1) return "Day";
	if (days <= 7) return "Week";
	if (days <= 31) return "Month";
	if (days <= 365) return "Year";
	return undefined;
}

function unifuncsSearchUrl(provider: CustomSearchProviderConfig): string {
	const baseUrl = (provider.baseUrl || UNIFUNCS_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return baseUrl.endsWith("/web-search") ? baseUrl : `${baseUrl}/web-search`;
}

export function normalizeUnifuncsResponse(
	body: unknown,
	request: SearchRequest,
): { text: string; results?: SearchResultItem[] } {
	if (!body || typeof body !== "object") return { text: "No results found" };
	const root = body as Record<string, unknown>;
	if (root.code !== 0) {
		const msg = typeof root.message === "string" ? root.message : "Unknown error";
		return { text: `UniFuncs search error: ${msg}` };
	}
	const data = root.data as Record<string, unknown> | undefined;
	if (!data) return { text: "No results found" };
	const webPages = Array.isArray(data.webPages) ? data.webPages : [];
	const results: SearchResultItem[] = webPages
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			title: typeof item.name === "string" ? item.name : undefined,
			url: typeof item.url === "string" ? item.url : undefined,
			snippet:
				typeof item.summary === "string"
					? item.summary
					: typeof item.snippet === "string"
						? item.snippet
						: undefined,
			publishedAt: typeof item.datePublished === "string" ? item.datePublished : undefined,
			source: typeof item.siteName === "string" ? item.siteName : undefined,
		}));
	const filtered = filterResultsByDomains(results, request);
	return { text: renderSearchResults(request.query, filtered), results: filtered };
}

async function execute(ctx: AdapterContext): Promise<SearchChannelResult> {
	const { channel, channelLabel, provider, request, signal } = ctx;
	const headers = providerHeaders(provider);
	setHeaderIfMissing(headers, "Content-Type", "application/json");
	if (provider.apiKey) setHeaderIfMissing(headers, "Authorization", `Bearer ${provider.apiKey}`);
	if (!headerExists(headers, "Authorization")) {
		throw new Error("UniFuncs search requires an API key or Authorization header");
	}
	const payload: Record<string, unknown> = {
		query: request.query,
		count: boundedInt(request.maxResults, 1, 50, 10),
	};
	const freshness = unifuncsFreshness(request.recencyDays);
	if (freshness) payload.freshness = freshness;
	const response = await fetch(unifuncsSearchUrl(provider), {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal,
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`UniFuncs search error ${response.status}: ${errText}`);
	}
	const parsed = normalizeUnifuncsResponse(await response.json(), request);
	return {
		channelId: channel.id,
		channelLabel,
		text: parsed.text,
		results: parsed.results,
		sources: parsed.results,
	};
}

function isUsable(provider: CustomSearchProviderConfig): boolean {
	const headers = providerHeaders(provider);
	return !!provider.apiKey || headerExists(headers, "Authorization");
}

export const adapter: SearchProtocolAdapter = {
	meta: {
		id: "unifuncs",
		label: { en: "UniFuncs (U深搜)", "zh-CN": "U深搜 (UniFuncs)" },
		description: {
			en: "Calls UniFuncs web search API. Supports web and image search. Enter a UniFuncs API key.",
			"zh-CN": "调用 U深搜 (UniFuncs) 网络搜索 API，支持网页和图片搜索，请填写 UniFuncs API Key。",
		},
		defaultBaseUrl: UNIFUNCS_DEFAULT_BASE_URL,
	},
	isUsable,
	execute,
};
