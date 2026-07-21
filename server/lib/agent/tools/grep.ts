import { z } from "zod/v4";
import { specVfsService } from "../../../services/spec-vfs-service";
import { isRgAvailable, RG_FALLBACK_NOTE, RG_INSTALL_HINT } from "../../ripgrep";
import { settings } from "../../settings";
import { vfsGrep } from "../../vfs-grep";
import { withDeviceParam } from "../execution/device-schema";
import { resolveBackendPath, toolBaseCwd } from "../execution/path-resolve";
import { getToolBackend } from "../execution/tool-backend";
import type { ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

export { isRgAvailable };

/** Maximum bytes to retain from ripgrep stdout before truncating + killing the process. */
const MAX_GREP_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Hard timeout for a single ripgrep invocation. Kills the process when elapsed. */
const GREP_TIMEOUT_MS = 30_000;

/**
 * Grep the narrator's spec:// virtual files. Fetches the in-memory file list
 * and delegates matching to the VFS-agnostic engine in vfs-grep.ts.
 */
async function grepSpecFiles(args: {
	narratorId: string;
	pattern: string;
	path?: string;
	glob?: string;
	outputMode: "content" | "files_with_matches" | "count";
	showLineNumbers: boolean;
	caseInsensitive?: boolean;
	headLimit: number;
	offset: number;
	multiline?: boolean;
}): Promise<ToolResult> {
	const files = await specVfsService.listSpecFiles(args.narratorId);
	const pathPrefix =
		args.path && args.path !== "spec://" ? specVfsService.normalizeSpecPath(args.path) : undefined;

	const result = vfsGrep(files, {
		pattern: args.pattern,
		pathPrefix,
		glob: args.glob,
		outputMode: args.outputMode,
		showLineNumbers: args.showLineNumbers,
		caseInsensitive: args.caseInsensitive,
		multiline: args.multiline,
		headLimit: args.headLimit,
		offset: args.offset,
	});
	return {
		output: result.output,
		isError: result.isError,
		title: result.title,
		metadata: result.metadata,
	};
}

const DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Dynamic Spec support: set path to "spec://" (or a spec:// subpath) to search the narrator's virtual Dynamic Spec files
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\``;

export const grepTool: ToolDefinition = {
	name: "Grep",
	description: DESCRIPTION,
	rawJsonSchema: {
		type: "object",
		properties: {
			pattern: {
				description: "The regular expression pattern to search for in file contents",
				type: "string",
			},
			path: {
				description:
					'File or directory to search in (rg PATH), or "spec://" to search Dynamic Spec virtual files. Defaults to current working directory.',
				type: "string",
			},
			glob: {
				description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
				type: "string",
			},
			output_mode: {
				description:
					'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
				type: "string",
				enum: ["content", "files_with_matches", "count"],
			},
			"-B": {
				description:
					'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
				type: "number",
			},
			"-A": {
				description:
					'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
				type: "number",
			},
			"-C": {
				description: "Alias for context.",
				type: "number",
			},
			context: {
				description:
					'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
				type: "number",
			},
			"-n": {
				description:
					'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
				type: "boolean",
			},
			"-i": {
				description: "Case insensitive search (rg -i)",
				type: "boolean",
			},
			type: {
				description:
					"File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
				type: "string",
			},
			head_limit: {
				description:
					'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 0 (unlimited).',
				type: "number",
			},
			offset: {
				description:
					'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
				type: "number",
			},
			multiline: {
				description:
					"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
				type: "boolean",
			},
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	getRawJsonSchema(config) {
		return withDeviceParam(grepTool.rawJsonSchema as Record<string, unknown>, config);
	},
	parameters: z.object({
		pattern: z.string().describe("The regular expression pattern to search for in file contents"),
		path: z
			.string()
			.optional()
			.describe(
				'File or directory to search in (rg PATH), or "spec://" to search Dynamic Spec virtual files. Defaults to current working directory.',
			),
		glob: z
			.string()
			.optional()
			.describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob'),
		output_mode: z
			.enum(["content", "files_with_matches", "count"])
			.optional()
			.describe(
				'Output mode: "content" shows matching lines, "files_with_matches" shows file paths (default), "count" shows match counts.',
			),
		"-B": looseNumber("Number of lines to show before each match (rg -B). Content mode only."),
		"-A": looseNumber("Number of lines to show after each match (rg -A). Content mode only."),
		"-C": looseNumber("Alias for context."),
		context: looseNumber(
			"Number of lines to show before and after each match (rg -C). Content mode only.",
		),
		"-n": z
			.boolean()
			.optional()
			.describe("Show line numbers in output (rg -n). Content mode only. Defaults to true."),
		"-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
		type: z
			.string()
			.optional()
			.describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc."),
		head_limit: looseNumber("Limit output to first N lines/entries. Defaults to 0 (unlimited)."),
		offset: looseNumber("Skip first N lines/entries before applying head_limit. Defaults to 0."),
		multiline: z
			.boolean()
			.optional()
			.describe(
				"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			pattern,
			path: searchPathArg,
			glob: globPattern,
			output_mode: outputMode = "files_with_matches",
			"-n": showLineNumbers = true,
			"-i": caseInsensitive,
			type: fileType,
			multiline,
		} = args as {
			pattern: string;
			path?: string;
			glob?: string;
			output_mode?: "content" | "files_with_matches" | "count";
			"-n"?: boolean;
			"-i"?: boolean;
			type?: string;
			multiline?: boolean;
		};

		// Normalize numeric context/pagination params (float/string/negative → sane int).
		const beforeCtx = normalizeNumber((args as { "-B"?: unknown })["-B"], { min: 0 });
		const afterCtx = normalizeNumber((args as { "-A"?: unknown })["-A"], { min: 0 });
		const cAlias = normalizeNumber((args as { "-C"?: unknown })["-C"], { min: 0 });
		const contextLines = normalizeNumber((args as { context?: unknown }).context, { min: 0 });
		const headLimit =
			normalizeNumber((args as { head_limit?: unknown }).head_limit, { min: 0 }) ?? 0;
		const offset = normalizeNumber((args as { offset?: unknown }).offset, { min: 0 }) ?? 0;

		if (!pattern) {
			return { output: "pattern is required", isError: true };
		}

		if (searchPathArg && specVfsService.isSpecUri(searchPathArg)) {
			return grepSpecFiles({
				narratorId: ctx.narratorId,
				pattern,
				path: searchPathArg,
				glob: globPattern,
				outputMode,
				showLineNumbers,
				caseInsensitive,
				headLimit,
				offset,
				multiline,
			});
		}

		const backend = getToolBackend(ctx, (args as { device?: string }).device);
		const base = toolBaseCwd(backend, ctx.cwd);
		const searchPath = resolveBackendPath(backend, base, searchPathArg ?? base);

		try {
			const grepResult = await backend.grep({
				pattern,
				searchPath,
				cwd: base,
				glob: globPattern,
				outputMode,
				beforeContext: beforeCtx,
				afterContext: afterCtx,
				contextLines: cAlias ?? contextLines,
				showLineNumbers,
				caseInsensitive,
				fileType,
				multiline,
				rawBytes: settings.agent.legacyEncoding,
				maxBytes: MAX_GREP_OUTPUT_BYTES,
				timeoutMs: GREP_TIMEOUT_MS,
				signal: ctx.signal,
			});

			if (grepResult.unavailable) {
				return { output: RG_INSTALL_HINT, isError: true };
			}

			// When ripgrep was missing, the backend fell back to the system `grep`.
			// Surface a one-time notice so the model accounts for the capability gap,
			// and use the right tool name in error messages.
			const usedFallback = grepResult.usedFallback === true;
			const toolLabel = usedFallback ? "grep" : "ripgrep";
			const notePrefix = usedFallback ? `${RG_FALLBACK_NOTE}\n\n` : "";

			const { stderr, exitCode } = grepResult;
			const outputTruncatedByBytes = grepResult.truncatedByBytes;

			if (grepResult.timedOut) {
				return {
					output: `${notePrefix}${toolLabel} timed out after ${GREP_TIMEOUT_MS / 1000}s and was terminated. Narrow your search (add a path, glob, or type filter).`,
					isError: true,
				};
			}

			// When legacy encoding is enabled with --encoding none, rg outputs raw
			// bytes. We attempt charset detection so that non-UTF-8 content (e.g. GBK
			// grep results) is decoded correctly.
			let stdout: string;
			if (settings.agent.legacyEncoding) {
				const buf = Buffer.from(grepResult.stdoutBytes);
				const chardet = await import("chardet");
				const results = chardet.default.analyse(buf);
				const best = results[0];
				if (
					best &&
					best.confidence >= 70 &&
					best.name.toLowerCase() !== "utf-8" &&
					best.name.toLowerCase() !== "ascii"
				) {
					const iconv = await import("iconv-lite");
					stdout = iconv.default.decode(buf, best.name);
				} else {
					stdout = new TextDecoder().decode(grepResult.stdoutBytes);
				}
			} else {
				stdout = new TextDecoder().decode(grepResult.stdoutBytes);
			}

			// Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
			if (exitCode === 2 && !stdout.trim()) {
				if (stderr.trim()) {
					return { output: `${notePrefix}${toolLabel} error: ${stderr.trim()}`, isError: true };
				}
				return {
					output: `${notePrefix}No matches found`,
					title: pattern,
					metadata: { matches: 0, truncated: false, usedFallback },
				};
			}

			if (exitCode === 1) {
				return {
					output: `${notePrefix}No matches found`,
					title: pattern,
					metadata: { matches: 0, truncated: false, usedFallback },
				};
			}

			if (exitCode !== 0 && exitCode !== 2) {
				return { output: `${notePrefix}${toolLabel} failed: ${stderr}`, isError: true };
			}

			const hasErrors = exitCode === 2;

			// Split output into lines
			const rawLines = stdout.trimEnd().split(/\r?\n/);

			// If stdout was cut off at the byte cap, the final line may be partial —
			// drop it so we never emit a corrupted match line.
			if (outputTruncatedByBytes && rawLines.length > 1) {
				rawLines.pop();
			}

			// Apply offset and head_limit
			let lines = rawLines;
			if (offset > 0) {
				lines = lines.slice(offset);
			}
			const truncated = headLimit > 0 && lines.length > headLimit;
			if (headLimit > 0) {
				lines = lines.slice(0, headLimit);
			}

			if (lines.length === 0 || (lines.length === 1 && !lines[0])) {
				return {
					output: `${notePrefix}No matches found`,
					title: pattern,
					metadata: { matches: 0, truncated: false, usedFallback },
				};
			}

			const output = lines.join("\n");
			const suffix: string[] = [];
			if (truncated) {
				suffix.push(
					`\n(Results limited to ${headLimit} entries. ${rawLines.length - offset - headLimit} more available.)`,
				);
			}
			if (outputTruncatedByBytes) {
				suffix.push(
					`\n(Output exceeded ${MAX_GREP_OUTPUT_BYTES / (1024 * 1024)}MB and was truncated. Narrow your search with a path, glob, or type filter.)`,
				);
			}
			if (hasErrors) {
				suffix.push("\n(Some paths were inaccessible and skipped)");
			}

			return {
				output: notePrefix + output + suffix.join(""),
				title: pattern,
				metadata: {
					matches: rawLines.length,
					truncated: truncated || outputTruncatedByBytes,
					usedFallback,
				},
			};
		} catch (err) {
			return {
				output: `Error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
