import { z } from "zod/v4";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

export const grepTool: ToolDefinition = {
	name: "Grep",
	description:
		"Search file contents using ripgrep. Supports regex, glob filtering, and output modes.",
	parameters: z.object({
		pattern: z.string(),
		path: z.string().optional(),
		glob: z.string().optional(),
		output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
		context: z.number().optional(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			pattern,
			path,
			glob: globFilter,
			output_mode,
			context,
		} = args as {
			pattern: string;
			path?: string;
			glob?: string;
			output_mode?: string;
			context?: number;
		};
		const searchPath = path ?? ctx.cwd;
		const rgArgs = ["rg", "--no-heading"];

		if (output_mode === "files_with_matches" || !output_mode) rgArgs.push("-l");
		else if (output_mode === "count") rgArgs.push("-c");
		else rgArgs.push("-n");

		if (context && output_mode === "content") rgArgs.push("-C", String(context));
		if (globFilter) rgArgs.push("--glob", globFilter);

		rgArgs.push(pattern, searchPath);

		try {
			const proc = Bun.spawn(rgArgs, {
				cwd: ctx.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;

			if (exitCode === 1) return { output: "No matches found" };
			if (exitCode !== 0) return { output: stderr || "ripgrep error", isError: true };
			return { output: truncateOutput(stdout.trim() || "No matches found") };
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
