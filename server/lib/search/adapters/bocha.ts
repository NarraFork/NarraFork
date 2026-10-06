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

export const BOCHA_DEFAULT_BASE_URL = "https://api.bocha.cn/v1";

function bochaFreshness(
	days: number | undefined,
): "noLimit" | "oneDay" | "oneWeek" | "oneMonth" | "oneYear" {
	if (days == null || days <= 0) return "noLimit";
	if (days <= 1) return "oneDay";
	if (days <= 7) return "oneWeek";
	if (days <= 31) return "oneMonth";
	if (days <= 365) return "oneYear";
	return "noLimit";
}

function bochaSearchUrl(provider: CustomSearchProviderConfig): string {
	const baseUrl = (provider.baseUrl || BOCHA_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return baseUrl.endsWith("/web-search") ? baseUrl : `${baseUrl}/web-search`;
}

export function normalizeBochaResponse(
	body: unknown,
	request: SearchRequest,
): { text: string; results?: SearchResultItem[] } {
	if (!body || typeof body !== "object") return { text: "No results found" };
	const root = body as Record<string, unknown>;
	if (root.code !== 200 && root.code !== 0) {
		const msg = typeof root.msg === "string" ? root.msg : "Unknown error";
		return { text: `Bocha search error: ${msg}` };
	}
	const data = root.data as Record<string, unknown> | undefined;
	if (!data) return { text: "No results found" };
	const webPages = data.webPages as Record<string, unknown> | undefined;
	const values = Array.isArray(webPages?.value) ? webPages.value : [];
	const results: SearchResultItem[] = values
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
		throw new Error("Bocha search requires an API key or Authorization header");
	}
	const payload: Record<string, unknown> = {
		query: request.query,
		summary: true,
		freshness: bochaFreshness(request.recencyDays),
		count: boundedInt(request.maxResults, 1, 50, 10),
	};
	const response = await fetch(bochaSearchUrl(provider), {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal,
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`Bocha search error ${response.status}: ${errText}`);
	}
	const parsed = normalizeBochaResponse(await response.json(), request);
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
		id: "bocha",
		label: { en: "Bocha AI Search", "zh-CN": "博查 AI 搜索" },
		description: {
			en: "Calls Bocha's web search API. Searches from billions of web pages. Enter a Bocha API key.",
			"zh-CN": "调用博查 AI 搜索 API，从近百亿网页中搜索高质量信息，请填写博查 API Key。",
		},
		defaultBaseUrl: BOCHA_DEFAULT_BASE_URL,
	},
	isUsable,
	execute,
};
