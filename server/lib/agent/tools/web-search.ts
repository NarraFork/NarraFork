import { z } from "zod/v4";
import { executeSearch, hasUsableFunctionSearchChannel } from "../../search/router";

export { isAbortError, withSearchTimeout } from "../../search/timeout";

import type { ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const domainListSchema = z.array(z.string().min(1)).max(20).optional();

export const webSearchTool: ToolDefinition = {
	name: "WebSearch",
	description:
		"\n- Allows the agent to search the web and use the results to inform responses\n" +
		"- Provides up-to-date information for current events and recent data\n" +
		"- Use this tool for accessing information beyond the model's knowledge cutoff\n" +
		"\nCRITICAL REQUIREMENT - You MUST follow this:\n" +
		'  - After answering the user\'s question, include a "Sources:" section when search results contain URLs\n' +
		"  - In the Sources section, list relevant URLs from the search results as markdown links\n" +
		"\nUsage notes:\n" +
		"  - Provide a specific purpose when the search requires synthesis, verification, or may use the search-subagent channel\n" +
		"  - Domain filtering is supported to include or block specific websites\n" +
		"  - Use exact dates/years in queries for recent information and time-sensitive topics",
	rawJsonSchema: {
		type: "object",
		properties: {
			query: {
				description: "The search query to use",
				type: "string",
				minLength: 2,
			},
			purpose: {
				description:
					"Why this search is needed and what should be verified or synthesized. Required when the configured search-subagent channel is used.",
				type: "string",
			},
			allowed_domains: {
				description: "Only include search results from these domains",
				type: "array",
				items: { type: "string" },
			},
			blocked_domains: {
				description: "Never include search results from these domains",
				type: "array",
				items: { type: "string" },
			},
			recency_days: {
				description: "Prefer results from this many recent days when supported by the channel",
				type: "number",
			},
			max_results: {
				description: "Maximum number of results requested when supported by the channel",
				type: "number",
			},
		},
		required: ["query"],
		additionalProperties: false,
	},
	parameters: z.object({
		query: z.string().min(2).describe("Search query string"),
		purpose: z.string().optional().describe("Specific purpose for this search"),
		allowed_domains: domainListSchema.describe("Only include results from these domains"),
		blocked_domains: domainListSchema.describe("Block results from these domains"),
		recency_days: looseNumber("Prefer results from this many recent days"),
		max_results: looseNumber("Maximum number of results requested"),
	}),
	isAvailable: () => hasUsableFunctionSearchChannel(),
	async execute(args, ctx): Promise<ToolResult> {
		const parsed = args as {
			query: string;
			purpose?: string;
			allowed_domains?: string[];
			blocked_domains?: string[];
			recency_days?: number;
			max_results?: number;
		};

		try {
			const result = await executeSearch({
				query: parsed.query,
				purpose: parsed.purpose,
				allowedDomains: parsed.allowed_domains,
				blockedDomains: parsed.blocked_domains,
				recencyDays: normalizeNumber(parsed.recency_days, { min: 0 }),
				maxResults: normalizeNumber(parsed.max_results, { min: 1, max: 50 }),
				locale: ctx.locale,
				signal: ctx.signal,
				parentNarratorId: ctx.narratorId,
				parentToolUseId: ctx.currentToolUseId,
				cwd: ctx.cwd,
				provider: ctx.provider,
				model: ctx.model,
				userId: ctx.userId ?? null,
			});
			return {
				output: result.text || "No results found",
				title: parsed.query.slice(0, 80),
				metadata: {
					channelId: result.channelId,
					channelLabel: result.channelLabel,
					attempts: result.attempts,
					sources: result.sources,
				},
			};
		} catch (err) {
			if (ctx.signal.aborted) {
				return { output: "Web search aborted by user", isError: true };
			}
			return {
				output: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
