import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_RESULTS = 500;

export const globTool: ToolDefinition = {
	name: "Glob",
	description:
		"Find files matching a glob pattern. Returns up to 500 paths sorted by modification time.",
	parameters: z.object({
		pattern: z.string(),
		path: z.string().optional(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { pattern, path } = args as { pattern: string; path?: string };
		const cwd = path ?? ctx.cwd;
		try {
			const glob = new Bun.Glob(pattern);
			const results: string[] = [];
			for await (const entry of glob.scan({ cwd, dot: false })) {
				results.push(entry);
				if (results.length >= MAX_RESULTS) break;
			}
			if (results.length === 0) return { output: "No matches found" };
			const truncated = results.length >= MAX_RESULTS ? `\n(limited to ${MAX_RESULTS})` : "";
			return { output: results.join("\n") + truncated };
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
