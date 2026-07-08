import { isAbsolute, resolve } from "node:path";
import { z } from "zod/v4";
import { toForwardSlash } from "../../platform-path";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_RESULTS = 500;

export const globTool: ToolDefinition = {
	name: "Glob",
	description:
		"- Fast file pattern matching tool that works with any codebase size\n" +
		'- Supports glob patterns like "**/*.js" or "src/**/*.ts"\n' +
		"- Returns matching file paths sorted by modification time\n" +
		"- Use this tool when you need to find local filesystem files by name patterns\n" +
		'- This tool does not enumerate spec:// Dynamic Spec virtual files; use Grep with path "spec://" or Read known spec:// files instead\n' +
		"- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead\n" +
		"- You can call multiple tools in a single response. It is always better to speculatively perform multiple searches in parallel if they are potentially useful.",
	rawJsonSchema: {
		type: "object",
		properties: {
			pattern: {
				description: "The glob pattern to match files against",
				type: "string",
			},
			path: {
				description:
					'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
				type: "string",
			},
			dot: {
				description:
					"Whether to match dotfiles and dot-directories (paths starting with '.'). Defaults to false. Set to true to include hidden files/directories such as .env or .config.",
				type: "boolean",
			},
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	parameters: z.object({
		pattern: z.string().describe("Glob pattern to match files, e.g. '**/*.ts' or 'src/*.json'"),
		path: z.string().optional().describe("Base directory to search from. Defaults to cwd"),
		dot: z
			.boolean()
			.optional()
			.describe("Match hidden files/directories (paths starting with '.'). Defaults to false"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			pattern,
			path: pathArg,
			dot,
		} = args as { pattern: string; path?: string; dot?: boolean };
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
			for await (const entry of glob.scan({ cwd, dot: dot ?? false })) {
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
