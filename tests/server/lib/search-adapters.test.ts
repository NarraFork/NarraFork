import { describe, expect, it } from "bun:test";
import {
	buildTavilyMcpArgs,
	buildZhipuWebSearchPayload,
	normalizeTavilyMcpResponse,
	normalizeZhipuWebSearchResponse,
} from "../../../server/lib/search/adapters";
import type { SearchRequest } from "../../../server/lib/search/types";
import type { CustomSearchProviderConfig } from "../../../server/lib/settings/types";

const zhipuProvider: CustomSearchProviderConfig = {
	id: "zhipu",
	name: "Zhipu",
	protocol: "zhipu-web-search-v1",
	baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	apiKey: "key",
};

const tavilyProvider: CustomSearchProviderConfig = {
	id: "tavily",
	name: "Tavily",
	protocol: "tavily-mcp",
	baseUrl: "https://mcp.tavily.com/mcp/",
	apiKey: "key",
};

describe("search provider adapters", () => {
	it("maps NarraFork search requests to Zhipu Web Search fields", () => {
		const payload = buildZhipuWebSearchPayload(
			{
				query: "narrafork",
				allowedDomains: ["docs.bigmodel.cn", "example.com"],
				recencyDays: 7,
				maxResults: 5,
			},
			{
				...zhipuProvider,
				options: {
					searchEngine: "search_std",
					searchIntent: true,
					requestId: "req-1",
					userId: "user-1",
					contentSize: "high",
				},
			},
		);

		expect(payload).toEqual({
			search_query: "narrafork",
			search_engine: "search_std",
			search_intent: true,
			count: 5,
			search_recency_filter: "week",
			search_domain_filter: "docs.bigmodel.cn,example.com",
			request_id: "req-1",
			user_id: "user-1",
			content_size: "high",
		});
	});

	it("normalizes Zhipu Web Search results into sources", () => {
		const request: SearchRequest = { query: "narrafork", blockedDomains: ["blocked.test"] };
		const parsed = normalizeZhipuWebSearchResponse(
			{
				search_result: [
					{
						title: "NarraFork",
						link: "https://example.com/narrafork",
						content: "A result snippet",
						publish_date: "2026-06-22",
						media: "Example",
					},
					{
						title: "Blocked",
						link: "https://blocked.test/page",
						content: "Should be filtered",
					},
				],
			},
			request,
		);

		expect(parsed.results).toEqual([
			{
				title: "NarraFork",
				url: "https://example.com/narrafork",
				snippet: "A result snippet",
				publishedAt: "2026-06-22",
				source: "Example",
			},
		]);
		expect(parsed.text).toContain("Sources:");
		expect(parsed.text).not.toContain("blocked.test");
	});

	it("maps NarraFork search requests to Tavily MCP args", () => {
		const args = buildTavilyMcpArgs(
			{
				query: "narrafork",
				allowedDomains: ["tavily.com"],
				blockedDomains: ["spam.test"],
				recencyDays: 30,
				maxResults: 3,
			},
			{
				...tavilyProvider,
				options: {
					searchDepth: "advanced",
					includeAnswer: true,
					includeRawContent: false,
					includeImages: true,
					defaultParameters: { include_favicon: true },
				},
			},
		);

		expect(args).toEqual({
			include_favicon: true,
			query: "narrafork",
			max_results: 3,
			search_depth: "advanced",
			time_range: "month",
			include_domains: ["tavily.com"],
			exclude_domains: ["spam.test"],
			include_answer: true,
			include_raw_content: false,
			include_images: true,
		});
	});

	it("normalizes Tavily MCP JSON text responses", () => {
		const parsed = normalizeTavilyMcpResponse(
			[
				{
					type: "text",
					text: JSON.stringify({
						results: [
							{
								title: "Tavily result",
								url: "https://tavily.com/result",
								content: "Result content",
							},
						],
					}),
				},
			],
			{ query: "tavily" },
		);

		expect(parsed.results?.[0]).toEqual({
			title: "Tavily result",
			url: "https://tavily.com/result",
			snippet: "Result content",
			publishedAt: undefined,
			source: undefined,
		});
		expect(parsed.text).toContain("https://tavily.com/result");
	});
});
