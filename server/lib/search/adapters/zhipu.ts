import type { CustomSearchProviderConfig } from "../../settings/types";
import type { SearchChannelResult, SearchRequest, SearchResultItem } from "../types";
import type { AdapterContext, SearchProtocolAdapter } from "./shared";
import {
	booleanOption,
	boundedInt,
	filterResultsByDomains,
	headerExists,
	optionRecord,
	providerHeaders,
	renderSearchResults,
	setHeaderIfMissing,
	stringOption,
} from "./shared";

export const ZHIPU_WEB_SEARCH_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

function zhipuRecencyFilter(days: number | undefined): "noLimit" | "day" | "week" | "month" {
	if (days == null || days <= 0) return "noLimit";
	if (days <= 1) return "day";
	if (days <= 7) return "week";
	if (days <= 31) return "month";
	return "noLimit";
}

export function buildZhipuWebSearchPayload(
	request: SearchRequest,
	provider: CustomSearchProviderConfig,
): Record<string, unknown> {
	const options = optionRecord(provider);
	const payload: Record<string, unknown> = {
		search_query: request.query,
		search_engine: stringOption(options, "searchEngine", "search_std"),
		search_intent: booleanOption(options, "searchIntent", false),
		count: boundedInt(request.maxResults, 1, 50, 10),
		search_recency_filter: zhipuRecencyFilter(request.recencyDays),
	};
	if (request.allowedDomains?.length) {
		payload.search_domain_filter = request.allowedDomains.join(",");
	}
	const requestId = stringOption(options, "requestId");
	if (requestId) payload.request_id = requestId;
	const userId = stringOption(options, "userId");
	if (userId) payload.user_id = userId;
	const contentSize = stringOption(options, "contentSize");
	if (contentSize) payload.content_size = contentSize;
	return payload;
}

function zhipuWebSearchUrl(provider: CustomSearchProviderConfig): string {
	const baseUrl = (provider.baseUrl || ZHIPU_WEB_SEARCH_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return baseUrl.endsWith("/web_search") ? baseUrl : `${baseUrl}/web_search`;
}

export function normalizeZhipuWebSearchResponse(
	body: unknown,
	request: SearchRequest,
): { text: string; results?: SearchResultItem[] } {
	if (!body || typeof body !== "object") return { text: "No results found" };
	const data = body as Record<string, unknown>;
	const results = Array.isArray(data.search_result)
		? data.search_result
				.filter(
					(item): item is Record<string, unknown> => typeof item === "object" && item !== null,
				)
				.map((item) => ({
					title: typeof item.title === "string" ? item.title : undefined,
					url: typeof item.link === "string" ? item.link : undefined,
					snippet: typeof item.content === "string" ? item.content : undefined,
					publishedAt: typeof item.publish_date === "string" ? item.publish_date : undefined,
					source:
						typeof item.media === "string"
							? item.media
							: typeof item.refer === "string"
								? item.refer
								: undefined,
				}))
		: undefined;
	const filtered = filterResultsByDomains(results, request);
	return { text: renderSearchResults(request.query, filtered), results: filtered };
}

async function execute(ctx: AdapterContext): Promise<SearchChannelResult> {
	const { channel, channelLabel, provider, request, signal } = ctx;
	const headers = providerHeaders(provider);
	setHeaderIfMissing(headers, "Content-Type", "application/json");
	if (provider.apiKey) setHeaderIfMissing(headers, "Authorization", `Bearer ${provider.apiKey}`);
	if (!headerExists(headers, "Authorization")) {
		throw new Error("Zhipu Web Search requires an API key or Authorization header");
	}
	const response = await fetch(zhipuWebSearchUrl(provider), {
		method: "POST",
		headers,
		body: JSON.stringify(buildZhipuWebSearchPayload(request, provider)),
		signal,
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`Zhipu Web Search error ${response.status}: ${errText}`);
	}
	const parsed = normalizeZhipuWebSearchResponse(await response.json(), request);
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
		id: "zhipu-web-search-v1",
		label: { en: "Zhipu Web Search", "zh-CN": "智谱 Web Search" },
		description: {
			en: "Calls Zhipu's official Web Search API. Enter a BigModel API key.",
			"zh-CN": "调用智谱官方网络搜索 API，请填写 BigModel API Key。",
		},
		defaultBaseUrl: ZHIPU_WEB_SEARCH_DEFAULT_BASE_URL,
	},
	isUsable,
	execute,
};
