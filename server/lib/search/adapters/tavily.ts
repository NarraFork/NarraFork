import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
	recordValue,
	renderSearchResults,
	setHeaderIfMissing,
	stringOption,
} from "./shared";

export const TAVILY_MCP_DEFAULT_BASE_URL = "https://mcp.tavily.com/mcp/";

interface McpToolContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: unknown;
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

async function execute(ctx: AdapterContext): Promise<SearchChannelResult> {
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

function isUsable(provider: CustomSearchProviderConfig): boolean {
	const headers = providerHeaders(provider);
	if (provider.apiKey || headerExists(headers, "Authorization")) return true;
	try {
		return tavilyMcpUrl(provider).searchParams.has("tavilyApiKey");
	} catch {
		return false;
	}
}

export const adapter: SearchProtocolAdapter = {
	meta: {
		id: "tavily-mcp",
		label: { en: "Tavily MCP", "zh-CN": "Tavily MCP" },
		description: {
			en: "Calls tavily-search through Tavily's official MCP server. Enter a Tavily API key.",
			"zh-CN": "通过 Tavily 官方 MCP Server 调用 tavily-search，请填写 Tavily API Key。",
		},
		defaultBaseUrl: TAVILY_MCP_DEFAULT_BASE_URL,
	},
	isUsable,
	execute,
};
