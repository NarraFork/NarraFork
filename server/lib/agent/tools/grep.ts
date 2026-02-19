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
		"-i": z.boolean().optional(),
		"-n": z.boolean().optional(),
		"-A": z.number().optional(),
		"-B": z.number().optional(),
		"-C": z.number().optional(),
		head_limit: z.number().optional(),
		offset: z.number().optional(),
		multiline: z.boolean().optional(),
		type: z.string().optional(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			pattern,
			path,
			glob: globFilter,
			output_mode,
			context,
			"-i": caseInsensitive,
			"-n": lineNumbers,
			"-A": afterContext,
			"-B": beforeContext,
			"-C": cAlias,
			head_limit,
			offset,
			multiline,
			type: fileType,
		} = args as {
			pattern: string;
			path?: string;
			glob?: string;
			output_mode?: string;
			context?: number;
			"-i"?: boolean;
			"-n"?: boolean;
			"-A"?: number;
			"-B"?: number;
			"-C"?: number;
			head_limit?: number;
			offset?: number;
			multiline?: boolean;
			type?: string;
		};
		const searchPath = path ?? ctx.cwd;
		const rgArgs = ["rg", "--no-heading"];

		if (output_mode === "files_with_matches" || !output_mode) rgArgs.push("-l");
		else if (output_mode === "count") rgArgs.push("-c");
		else {
			// content mode — line numbers default to true
			if (lineNumbers !== false) rgArgs.push("-n");
		}

		// Case insensitive
		if (caseInsensitive) rgArgs.push("-i");

		// Multiline
		if (multiline) rgArgs.push("-U", "--multiline-dotall");

		// Context lines: -A/-B/-C override `context`
		if (output_mode === "content") {
			const effectiveC = cAlias ?? context;
			if (afterContext != null) rgArgs.push("-A", String(afterContext));
			if (beforeContext != null) rgArgs.push("-B", String(beforeContext));
			if (effectiveC != null && afterContext == null && beforeContext == null) {
				rgArgs.push("-C", String(effectiveC));
			}
		}

		// File type filter
		if (fileType) rgArgs.push("--type", fileType);

		// Glob filter
		if (globFilter) rgArgs.push("--glob", globFilter);

		rgArgs.push(pattern, searchPath);

		const GREP_TIMEOUT_MS = 30_000;

		try {
			const proc = Bun.spawn(rgArgs, {
				cwd: ctx.cwd,
				stdout: "pipe",
				stderr: "pipe",
			});

			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, GREP_TIMEOUT_MS);
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			clearTimeout(timeout);

			if (timedOut) {
				return { output: "Search timed out", isError: true };
			}

			if (exitCode === 1) return { output: "No matches found" };
			if (exitCode !== 0) return { output: stderr || "ripgrep error", isError: true };

			let output = stdout.trim() || "No matches found";

			// Post-process: offset and head_limit
			if (offset != null || head_limit != null) {
				const lines = output.split("\n");
				const start = offset ?? 0;
				const end = head_limit != null ? start + head_limit : lines.length;
				output = lines.slice(start, end).join("\n");
			}

			return { output: truncateOutput(output) };
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
