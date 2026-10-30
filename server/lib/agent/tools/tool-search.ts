import { z } from "zod/v4";
import { logger } from "../../logger";
import { searchToolDocuments } from "../tool-search-index";
import type { ToolDefinition } from "../types";

export const toolSearchTool: ToolDefinition = {
	name: "ToolSearch",
	description:
		"Find and load optional tools by capability. Searches only authorized auto-mode tools, not manual or resident tools. Describe what you need in English or Chinese. Each MCP match loads only that tool; built-in matches load their routine group. Limit counts these selections. Newly loaded tools are declared on the next model request and may execute immediately after loading, including parallel calls in the current response. Already loaded matches are reported without duplicate notices. Use this tool to discover capabilities; do not simulate unavailable tools through shell commands or internal service calls.",
	parameters: z.object({
		query: z.string().trim().min(1).max(512),
		limit: z.number().int().min(1).max(5).default(3),
	}),
	async execute(input, context) {
		const parsed = toolSearchTool.parameters.safeParse(input);
		if (!parsed.success)
			return {
				output: "Invalid ToolSearch input: query must be 1–512 characters; limit must be 1–5.",
				isError: true,
			};
		const { query, limit } = parsed.data as { query: string; limit: number };
		const started = Date.now();
		context = {
			...context,
			signal: AbortSignal.any([context.signal, AbortSignal.timeout(10_000)]),
		};
		context.signal.throwIfAborted();
		await context.recheckAuthorization?.();
		const { getToolSearchCandidates, changeLoadedToolGroup } = await import(
			"../../../services/tool-loading-service"
		);
		const candidates = await getToolSearchCandidates(context.narratorId, context.userId, context);
		const documents = candidates.flatMap((group) => {
			const exactGroup = [group.id, group.id.replace(/^mcp-server:/, "")];
			if (!group.searchTexts)
				return [{ id: group.id, text: group.description, exactNames: exactGroup }];
			return [
				// Index group and member metadata without materializing parameter schemas.
				{ id: group.id, text: group.description, exactNames: exactGroup },
				...group.searchTexts.map((text, index) => ({
					id: group.id,
					text,
					exactNames: [group.toolNames[index] ?? group.id],
				})),
			];
		});
		const hits = await searchToolDocuments(documents, query, limit, context.signal);
		const results: { group: string; status: string; error?: string }[] = [];
		for (const hit of hits) {
			const group = candidates.find((candidate) => candidate.id === hit.id);
			if (!group) continue;
			try {
				const status = await changeLoadedToolGroup(
					context.narratorId,
					group,
					true,
					context.userId,
					context,
				);
				const denied = status.startsWith("denied");
				results.push({ group: group.id.slice(0, 256), status: denied ? "denied" : status });
			} catch (error) {
				// Cancellation and the execution deadline are control flow, not per-hit failures.
				context.signal.throwIfAborted();
				results.push({
					group: group.id.slice(0, 256),
					status: "error",
					error: String(error).slice(0, 256),
				});
			}
		}
		context.signal.throwIfAborted();
		if (Date.now() - started > 1000)
			logger.warn("Slow tool discovery", {
				narratorId: context.narratorId,
				durationMs: Date.now() - started,
				groups: candidates.length,
			});
		const output = JSON.stringify({
			results,
			...(results.length ? {} : { message: "No matching authorized auto-mode tools found." }),
		});
		return { output };
	},
};
