import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

/** Resolve the ripgrep binary path. Checks system paths, then vendored fallback. */
function findRg(): string {
	const systemPaths = ["/usr/bin/rg", "/usr/local/bin/rg", "/home/linuxbrew/.linuxbrew/bin/rg"];
	for (const p of systemPaths) {
		if (existsSync(p)) return p;
	}
	// Vendored rg from @anthropic-ai/claude-agent-sdk
	const arch = process.arch === "x64" ? "x64" : "arm64";
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	try {
		const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
		const vendored = join(dirname(sdkEntry), "vendor", "ripgrep", `${arch}-${platform}`, "rg");
		if (existsSync(vendored)) return vendored;
	} catch {}
	// Last resort: hope it's in PATH
	return "rg";
}

const RG_PATH = findRg();

export const grepTool: ToolDefinition = {
	name: "Grep",
	description:
		"Search file contents using ripgrep. Supports regex, glob filtering, and output modes.",
	parameters: z.object({
		pattern: z.string().describe("Regex pattern to search for (ripgrep syntax)"),
		path: z.string().optional().describe("File or directory to search. Defaults to cwd"),
		glob: z
			.string()
			.optional()
			.describe("Glob filter to restrict searched files, e.g. '*.ts' or '*.{ts,json}'"),
		output_mode: z
			.enum(["content", "files_with_matches", "count"])
			.optional()
			.describe(
				"'content' shows matching lines, 'files_with_matches' (default) lists file paths, 'count' shows match counts per file",
			),
		context: z
			.number()
			.optional()
			.describe(
				"Number of context lines around each match (only in content mode). Overridden by -A/-B/-C",
			),
		"-i": z.boolean().optional().describe("Case-insensitive search"),
		"-n": z
			.boolean()
			.optional()
			.describe("Show line numbers in content mode (default: true). Set false to suppress"),
		"-A": z.number().optional().describe("Show N lines after each match (only in content mode)"),
		"-B": z.number().optional().describe("Show N lines before each match (only in content mode)"),
		"-C": z
			.number()
			.optional()
			.describe(
				"Show N lines before and after each match (only in content mode). Takes precedence over context",
			),
		head_limit: z
			.number()
			.optional()
			.describe("Max number of output lines to return (applied after offset)"),
		offset: z.number().optional().describe("Number of output lines to skip from the beginning"),
		multiline: z
			.boolean()
			.optional()
			.describe("Enable multiline matching (pattern can span multiple lines)"),
		type: z
			.string()
			.optional()
			.describe("Restrict search to a file type recognized by ripgrep, e.g. 'ts', 'py', 'json'"),
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
		const rgArgs = [RG_PATH, "--no-heading"];

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
