import type { CustomSearchProviderConfig } from "../../settings/types";
import type { SearchChannelResult, SearchRequest, SearchResultItem } from "../types";
import type { AdapterContext, SearchProtocolAdapter } from "./shared";
import {
	filterResultsByDomains,
	headerExists,
	providerHeaders,
	renderSearchResults,
	setHeaderIfMissing,
} from "./shared";

export const CUSTOM_HTTP_DEFAULT_BASE_URL = "https://example.com/search";

/**
 * Custom HTTP adapter options (stored in provider.options):
 *
 * - method: "GET" | "POST" (default "POST")
 * - bodyTemplate: JSON string template with {{query}}, {{count}}, {{freshness}} placeholders
 * - queryParams: Record<string, string> for GET query params with placeholders
 * - responseMapping:
 *   - resultsPath: dot-separated path to the results array (e.g. "data.webPages")
 *   - titleField: field name for title (default "title" or "name")
 *   - urlField: field name for URL (default "url")
 *   - snippetField: field name for snippet (default "snippet")
 *   - publishedAtField: field name for publish date (default "datePublished")
 *   - sourceField: field name for source name (default "source")
 * - authStyle: "bearer" | "header" | "query" | "none" (default "bearer")
 * - authQueryParam: query param name for API key when authStyle is "query"
 */

interface CustomHttpOptions {
	method?: "GET" | "POST";
	bodyTemplate?: string;
	queryParams?: Record<string, string>;
	responseMapping?: {
		resultsPath?: string;
		titleField?: string;
		urlField?: string;
		snippetField?: string;
		publishedAtField?: string;
		sourceField?: string;
	};
	authStyle?: "bearer" | "header" | "query" | "none";
	authQueryParam?: string;
}

function getOptions(provider: CustomSearchProviderConfig): CustomHttpOptions {
	const raw = provider.options;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	return raw as CustomHttpOptions;
}

function interpolate(template: string, vars: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

function freshnessDays(days: number | undefined): string {
	if (days == null || days <= 0) return "";
	if (days <= 1) return "day";
	if (days <= 7) return "week";
	if (days <= 31) return "month";
	if (days <= 365) return "year";
	return "";
}

function resolvePath(obj: unknown, path: string): unknown {
	let current = obj;
	for (const key of path.split(".")) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

export function normalizeCustomHttpResponse(
	body: unknown,
	request: SearchRequest,
	options: CustomHttpOptions,
): { text: string; results?: SearchResultItem[] } {
	if (!body || typeof body !== "object") return { text: "No results found" };
	const mapping = options.responseMapping ?? {};
	const resultsPath = mapping.resultsPath || "data";
	const rawResults = resolvePath(body, resultsPath);
	const items = Array.isArray(rawResults) ? rawResults : [];
	const titleField = mapping.titleField || "title";
	const urlField = mapping.urlField || "url";
	const snippetField = mapping.snippetField || "snippet";
	const publishedAtField = mapping.publishedAtField || "datePublished";
	const sourceField = mapping.sourceField || "source";

	const results: SearchResultItem[] = items
		.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
		.map((item) => ({
			title:
				typeof item[titleField] === "string"
					? item[titleField]
					: typeof item.name === "string"
						? item.name
						: undefined,
			url: typeof item[urlField] === "string" ? item[urlField] : undefined,
			snippet:
				typeof item[snippetField] === "string"
					? item[snippetField]
					: typeof item.summary === "string"
						? item.summary
						: undefined,
			publishedAt: typeof item[publishedAtField] === "string" ? item[publishedAtField] : undefined,
			source: typeof item[sourceField] === "string" ? item[sourceField] : undefined,
		}));
	const filtered = filterResultsByDomains(results, request);
	return { text: renderSearchResults(request.query, filtered), results: filtered };
}

async function execute(ctx: AdapterContext): Promise<SearchChannelResult> {
	const { channel, channelLabel, provider, request, signal } = ctx;
	const options = getOptions(provider);
	const method = options.method ?? "POST";
	const headers = providerHeaders(provider);
	setHeaderIfMissing(headers, "Content-Type", "application/json");

	// Auth handling
	const authStyle = options.authStyle ?? "bearer";
	if (authStyle === "bearer" && provider.apiKey) {
		setHeaderIfMissing(headers, "Authorization", `Bearer ${provider.apiKey}`);
	}

	// Build URL
	const baseUrl = (provider.baseUrl || CUSTOM_HTTP_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const url = new URL(baseUrl);

	// Template variables
	const vars: Record<string, string> = {
		query: request.query,
		count: String(request.maxResults ?? 10),
		freshness: freshnessDays(request.recencyDays),
		page: "1",
	};

	// Query params (for GET or additional params)
	if (authStyle === "query" && provider.apiKey) {
		const paramName = options.authQueryParam || "apiKey";
		url.searchParams.set(paramName, provider.apiKey);
	}
	if (options.queryParams) {
		for (const [key, template] of Object.entries(options.queryParams)) {
			url.searchParams.set(key, interpolate(template, vars));
		}
	}

	let body: string | undefined;
	if (method === "POST") {
		if (options.bodyTemplate) {
			body = interpolate(options.bodyTemplate, vars);
		} else {
			body = JSON.stringify({ query: request.query, count: request.maxResults ?? 10 });
		}
	} else {
		// GET: put query in URL params if not already in queryParams
		if (!options.queryParams || !("query" in options.queryParams)) {
			url.searchParams.set("query", request.query);
		}
	}

	const response = await fetch(url.toString(), {
		method,
		headers,
		body: method === "POST" ? body : undefined,
		signal,
	});
	if (!response.ok) {
		const errText = await response.text().catch(() => "");
		throw new Error(`Custom HTTP search error ${response.status}: ${errText}`);
	}
	const parsed = normalizeCustomHttpResponse(await response.json(), request, options);
	return {
		channelId: channel.id,
		channelLabel,
		text: parsed.text,
		results: parsed.results,
		sources: parsed.results,
	};
}

function isUsable(provider: CustomSearchProviderConfig): boolean {
	if (!provider.baseUrl) return false;
	const options = getOptions(provider);
	const authStyle = options.authStyle ?? "bearer";
	if (authStyle === "none") return true;
	const headers = providerHeaders(provider);
	return !!provider.apiKey || headerExists(headers, "Authorization");
}

export const adapter: SearchProtocolAdapter = {
	meta: {
		id: "custom-http",
		label: { en: "Custom HTTP", "zh-CN": "自定义 HTTP" },
		description: {
			en: "Fully customizable HTTP search adapter. Define request method, URL, body template, and response field mappings.",
			"zh-CN": "完全自定义的 HTTP 搜索适配器。可定义请求方法、URL、请求体模板和响应字段映射。",
		},
		defaultBaseUrl: CUSTOM_HTTP_DEFAULT_BASE_URL,
	},
	isUsable,
	execute,
};
