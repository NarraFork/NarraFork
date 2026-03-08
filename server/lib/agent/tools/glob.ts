import { isAbsolute, resolve } from "node:path";
import { z } from "zod/v4";
import { toForwardSlash } from "../../platform-path";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_RESULTS = 500;

export const globTool: ToolDefinition = {
	name: "Glob",
	description:
		"Find files matching a glob pattern. Returns up to 500 paths sorted by modification time.",
	parameters: z.object({
		pattern: z.string().describe("Glob pattern to match files, e.g. '**/*.ts' or 'src/*.json'"),
		path: z.string().optional().describe("Base directory to search from. Defaults to cwd"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { pattern, path: pathArg } = args as { pattern: string; path?: string };
		// Resolve relative paths against the narrator's cwd
		let cwd: string;
		if (pathArg) {
			cwd = isAbsolute(pathArg) ? pathArg : resolve(ctx.cwd, pathArg);
		} else {
			cwd = ctx.cwd;
		}
		try {
			const glob = new Bun.Glob(pattern);
			const results: string[] = [];
			for await (const entry of glob.scan({ cwd, dot: false })) {
				// Normalise backslashes to forward slashes for consistent output
				results.push(toForwardSlash(entry));
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
