import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const webSearchTool: ToolDefinition = {
	name: "WebSearch",
	description:
		"Search the web for current information. Returns relevant search results with titles, URLs, and snippets. " +
		"Use this when you need up-to-date information that may not be in your training data, " +
		"such as recent documentation, library versions, API references, or current events.",
	parameters: z.object({
		query: z.string().describe("Search query string"),
	}),
	async execute(args): Promise<ToolResult> {
		const { query } = args as { query: string };

			return {
				isError: true,
			};
		}

		try {

			if (response.error) {
				return {
					output: `Search error: ${response.error.message ?? "Unknown error"}`,
					isError: true,
				};
			}

			if (!response.result?.content?.length) {
				return { output: "No results found" };
			}

			const text = response.result.content
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text)
				.join("\n\n");

			return {
				output: text || "No results found",
				isError: response.result.isError,
				title: query.slice(0, 80),
			};
		} catch (err) {
			return {
				output: `Web search failed: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
