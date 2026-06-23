import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CustomSearchProviderConfig, SearchChannelConfig } from "../settings/types";
import type { SearchChannelResult, SearchRequest, SearchResultItem } from "./types";

export const ZHIPU_WEB_SEARCH_DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
export const TAVILY_MCP_DEFAULT_BASE_URL = "https://mcp.tavily.com/mcp/";

interface AdapterContext {
	channel: SearchChannelConfig;
	channelLabel: string;
	provider: CustomSearchProviderConfig;
	request: SearchRequest;
	signal: AbortSignal;
}

interface McpToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
}

function optionRecord(provider: CustomSearchProviderConfig): Record<string, unknown> {
	return provider.options &&
		typeof provider.options === "object" &&
		!Array.isArray(provider.options)
		? provider.options
		: {};
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringOption(
	options: Record<string, unknown>,
	key: string,
	fallback?: string,
): string | undefined {
	const value = options[key];
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanOption(
	options: Record<string, unknown>,
	key: string,
	fallback?: boolean,
): boolean | undefined {
	const value = options[key];
	return typeof value === "boolean" ? value : fallback;
}

function boundedInt(value: number | undefined, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value ?? fallback), min), max);
}

function headerExists(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function setHeaderIfMissing(headers: Record<string, string>, name: string, value: string): void {
	if (!headerExists(headers, name)) headers[name] = value;
}

function providerHeaders(provider: CustomSearchProviderConfig): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(provider.headers ?? {})) {
		const header = key.trim();
		if (header) headers[header] = String(value);
	}
	return headers;
}

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

function filterResultsByDomains(
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

async function zhipuWebSearch(ctx: AdapterContext): Promise<SearchChannelResult> {
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

function tavilyTimeRange(days: number | undefined): string | undefined {
	if (days == null || days <= 0) return undefined;
	if (days <= 1) return "day";
	if (days <= 7) return "week";
	if (days <= 31) return "month";
	return "year";
}

export function buildTavilyMcpArgs(
	request: SearchRequest,
	provider: CustomSearchProviderConfig,
): Record<string, unknown> {
	const options = optionRecord(provider);
	const defaults = recordValue(options.defaultParameters) ?? {};
	const args: Record<string, unknown> = {
		...defaults,
		query: request.query,
		max_results: boundedInt(request.maxResults, 1, 50, 10),
		search_depth: stringOption(options, "searchDepth", "basic"),
	};
	const timeRange = tavilyTimeRange(request.recencyDays);
	if (timeRange) args.time_range = timeRange;
	if (request.allowedDomains?.length) args.include_domains = request.allowedDomains;
	if (request.blockedDomains?.length) args.exclude_domains = request.blockedDomains;
	const includeAnswer = booleanOption(options, "includeAnswer");
	if (includeAnswer !== undefined) args.include_answer = includeAnswer;
	const includeRawContent = booleanOption(options, "includeRawContent");
	if (includeRawContent !== undefined) args.include_raw_content = includeRawContent;
	const includeImages = booleanOption(options, "includeImages");
	if (includeImages !== undefined) args.include_images = includeImages;
	return args;
}

function tavilyMcpUrl(provider: CustomSearchProviderConfig): URL {
	const options = optionRecord(provider);
	const authStyle = stringOption(options, "authStyle", "query");
	const url = new URL(provider.baseUrl || TAVILY_MCP_DEFAULT_BASE_URL);
	if (provider.apiKey && authStyle !== "bearer" && !url.searchParams.has("tavilyApiKey")) {
		url.searchParams.set("tavilyApiKey", provider.apiKey);
	}
	return url;
}

function tavilyHeaders(provider: CustomSearchProviderConfig): Record<string, string> | undefined {
	const headers = providerHeaders(provider);
	const authStyle = stringOption(optionRecord(provider), "authStyle", "query");
	if (provider.apiKey && (authStyle === "bearer" || authStyle === "both")) {
		setHeaderIfMissing(headers, "Authorization", `Bearer ${provider.apiKey}`);
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

function contentToText(content: McpToolContent[]): string {
	const parts: string[] = [];
	for (const item of content) {
		if (item.type === "text" && item.text) {
			parts.push(item.text);
		} else if (item.type === "image" && item.data) {
			parts.push(`[image: ${item.mimeType ?? "image/png"}, ${item.data.length} bytes base64]`);
		} else if (item.type === "resource" && item.resource) {
			const resource = item.resource as { uri?: string; text?: string };
			parts.push(resource.text ?? `[resource: ${resource.uri ?? "unknown"}]`);
		}
	}
	return parts.join("\n\n");
}

function parseJsonText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function normalizeTavilyJsonResponse(
	body: unknown,
	request: SearchRequest,
): { text?: string; results?: SearchResultItem[] } {
	const data = Array.isArray(body)
		? { results: body }
		: body && typeof body === "object"
			? (body as Record<string, unknown>)
			: undefined;
	if (!data) return {};
	const results = Array.isArray(data.results)
		? data.results
				.filter(
					(item): item is Record<string, unknown> => typeof item === "object" && item !== null,
				)
				.map((item) => ({
					title: typeof item.title === "string" ? item.title : undefined,
					url: typeof item.url === "string" ? item.url : undefined,
					snippet:
						typeof item.content === "string"
							? item.content
							: typeof item.snippet === "string"
								? item.snippet
								: undefined,
					publishedAt:
						typeof item.published_date === "string"
							? item.published_date
							: typeof item.publishedAt === "string"
								? item.publishedAt
								: undefined,
					source: typeof item.source === "string" ? item.source : undefined,
				}))
		: undefined;
	const filtered = filterResultsByDomains(results, request);
	const answer = typeof data.answer === "string" ? data.answer : undefined;
	return {
		text: answer ?? (filtered ? renderSearchResults(request.query, filtered) : undefined),
		results: filtered,
	};
}

export function normalizeTavilyMcpResponse(
	content: McpToolContent[],
	request: SearchRequest,
): { text: string; results?: SearchResultItem[] } {
	const text = contentToText(content);
	const parsed = normalizeTavilyJsonResponse(parseJsonText(text), request);
	return {
		text: parsed.text ?? (text || "No results found"),
		results: parsed.results,
	};
}

async function tavilyMcpSearch(ctx: AdapterContext): Promise<SearchChannelResult> {
	const { channel, channelLabel, provider, request, signal } = ctx;
	const client = new Client({ name: "narrafork-search", version: "0.1.0" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(tavilyMcpUrl(provider), {
		requestInit: { headers: tavilyHeaders(provider) },
	});
	try {
		await client.connect(transport);
		const toolName =
			stringOption(optionRecord(provider), "toolName", "tavily-search") ?? "tavily-search";
		const result = await client.callTool(
			{ name: toolName, arguments: buildTavilyMcpArgs(request, provider) },
			undefined,
			{ signal },
		);
		const content = (result.content ?? []) as McpToolContent[];
		const parsed = normalizeTavilyMcpResponse(content, request);
		if (result.isError) throw new Error(parsed.text);
		return {
			channelId: channel.id,
			channelLabel,
			text: parsed.text,
			results: parsed.results,
			sources: parsed.results,
		};
	} finally {
		const closePromise = transport.close?.();
		if (closePromise) await closePromise.catch(() => {});
	}
}

export function isCustomSearchProviderUsable(
	provider: CustomSearchProviderConfig | undefined,
): boolean {
	if (!provider || provider.disabled) return false;
	switch (provider.protocol) {
		case "zhipu-web-search-v1": {
			const headers = providerHeaders(provider);
			return !!provider.apiKey || headerExists(headers, "Authorization");
		}
		case "tavily-mcp": {
			const headers = providerHeaders(provider);
			if (provider.apiKey || headerExists(headers, "Authorization")) return true;
			try {
				return tavilyMcpUrl(provider).searchParams.has("tavilyApiKey");
			} catch {
				return false;
			}
		}
		default:
			return !!provider.baseUrl;
	}
}

export async function executeCustomSearchProvider(
	ctx: AdapterContext,
): Promise<SearchChannelResult> {
	switch (ctx.provider.protocol) {
		case "zhipu-web-search-v1":
			return zhipuWebSearch(ctx);
		case "tavily-mcp":
			return tavilyMcpSearch(ctx);
	}
}
