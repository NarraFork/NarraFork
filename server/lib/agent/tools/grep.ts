import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import { logger } from "../../logger";
import { IS_WINDOWS } from "../../platform";
import type { ToolDefinition, ToolResult } from "../types";

const RG_INSTALL_HINT = IS_WINDOWS
	? "ripgrep (rg) is not installed. Install it with:\n\n  winget install BurntSushi.ripgrep.MSVC\n\nThen restart NarraFork."
	: "ripgrep (rg) is not installed. Install it with your package manager, e.g.:\n\n  # macOS\n  brew install ripgrep\n\n  # Ubuntu/Debian\n  sudo apt install ripgrep\n\nThen restart NarraFork.";

/**
 * Scan the WinGet packages directory for any ripgrep package folder.
 * The folder name contains a version-dependent hash (e.g.
 * `BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe`)
 * so we cannot hard-code it — instead we glob for `BurntSushi.ripgrep*`.
 */
function findRgInWinGet(): string | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;
	const packagesDir = join(localAppData, "Microsoft", "WinGet", "Packages");
	try {
		const entries = readdirSync(packagesDir);
		for (const entry of entries) {
			if (entry.toLowerCase().startsWith("burntsushi.ripgrep")) {
				const candidate = join(packagesDir, entry, "rg.exe");
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// Directory doesn't exist or not readable
	}
	return undefined;
}

/** Resolve the ripgrep binary path. Returns null when rg cannot be found. */
function findRg(): string | null {
	if (IS_WINDOWS) {
		// 1. Static well-known paths (scoop, chocolatey, cargo, Program Files)
		const winPaths = [
			`${process.env.USERPROFILE ?? ""}\\scoop\\shims\\rg.exe`,
			`${process.env.ProgramData ?? "C:\\ProgramData"}\\chocolatey\\bin\\rg.exe`,
			`${process.env.ProgramFiles ?? "C:\\Program Files"}\\ripgrep\\rg.exe`,
			`${process.env.USERPROFILE ?? ""}\\.cargo\\bin\\rg.exe`,
		];
		for (const p of winPaths) {
			if (p && existsSync(p)) return p;
		}
		// 2. WinGet packages (dynamic folder name)
		const winget = findRgInWinGet();
		if (winget) return winget;
		// 3. Ask the OS to find it on PATH
		const which = Bun.which("rg");
		if (which) return which;
		// Not found
		return null;
	}
	const systemPaths = [
		"/usr/bin/rg",
		"/usr/local/bin/rg",
		"/opt/homebrew/bin/rg",
		"/home/linuxbrew/.linuxbrew/bin/rg",
	];
	for (const p of systemPaths) {
		if (existsSync(p)) return p;
	}
	// Last check via PATH
	const which = Bun.which("rg");
	if (which) return which;
	return null;
}

const RG_PATH = findRg();

/** Whether ripgrep is available on this system. */
export const isRgAvailable = RG_PATH !== null;

// Log a warning at startup so the user sees it in the server console
if (!RG_PATH) {
	logger.warn(
		IS_WINDOWS
			? "ripgrep (rg) not found — Grep tool will be unavailable. Install: winget install BurntSushi.ripgrep.MSVC"
			: "ripgrep (rg) not found — Grep tool will be unavailable. Install via your package manager (e.g. brew install ripgrep, apt install ripgrep).",
	);
}

const DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
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
					"File or directory to search in (rg PATH). Defaults to current working directory.",
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
	parameters: z.object({
		pattern: z.string().describe("The regular expression pattern to search for in file contents"),
		path: z
			.string()
			.optional()
			.describe("File or directory to search in (rg PATH). Defaults to current working directory."),
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
		"-B": z
			.number()
			.optional()
			.describe("Number of lines to show before each match (rg -B). Content mode only."),
		"-A": z
			.number()
			.optional()
			.describe("Number of lines to show after each match (rg -A). Content mode only."),
		"-C": z.number().optional().describe("Alias for context."),
		context: z
			.number()
			.optional()
			.describe("Number of lines to show before and after each match (rg -C). Content mode only."),
		"-n": z
			.boolean()
			.optional()
			.describe("Show line numbers in output (rg -n). Content mode only. Defaults to true."),
		"-i": z.boolean().optional().describe("Case insensitive search (rg -i)"),
		type: z
			.string()
			.optional()
			.describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc."),
		head_limit: z
			.number()
			.optional()
			.describe("Limit output to first N lines/entries. Defaults to 0 (unlimited)."),
		offset: z
			.number()
			.optional()
			.describe("Skip first N lines/entries before applying head_limit. Defaults to 0."),
		multiline: z
			.boolean()
			.optional()
			.describe(
				"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		if (!RG_PATH) {
			return { output: RG_INSTALL_HINT, isError: true };
		}

		const {
			pattern,
			path: searchPathArg,
			glob: globPattern,
			output_mode: outputMode = "files_with_matches",
			"-B": beforeCtx,
			"-A": afterCtx,
			"-C": cAlias,
			context: contextLines,
			"-n": showLineNumbers = true,
			"-i": caseInsensitive,
			type: fileType,
			head_limit: headLimit = 0,
			offset = 0,
			multiline,
		} = args as {
			pattern: string;
			path?: string;
			glob?: string;
			output_mode?: "content" | "files_with_matches" | "count";
			"-B"?: number;
			"-A"?: number;
			"-C"?: number;
			context?: number;
			"-n"?: boolean;
			"-i"?: boolean;
			type?: string;
			head_limit?: number;
			offset?: number;
			multiline?: boolean;
		};

		if (!pattern) {
			return { output: "pattern is required", isError: true };
		}

		let searchPath = searchPathArg ?? ctx.cwd;
		searchPath = isAbsolute(searchPath) ? searchPath : resolve(ctx.cwd, searchPath);

		// Build rg arguments
		const rgArgs: string[] = [RG_PATH, "--hidden", "--no-messages"];

		// Output mode flags
		if (outputMode === "files_with_matches") {
			rgArgs.push("-l");
		} else if (outputMode === "count") {
			rgArgs.push("-c");
		} else {
			// content mode
			if (showLineNumbers) {
				rgArgs.push("-n");
			}
			// Context lines (only in content mode)
			const effectiveC = cAlias ?? contextLines;
			if (effectiveC != null) {
				rgArgs.push("-C", String(effectiveC));
			} else {
				if (beforeCtx != null) rgArgs.push("-B", String(beforeCtx));
				if (afterCtx != null) rgArgs.push("-A", String(afterCtx));
			}
		}

		// Case insensitive
		if (caseInsensitive) {
			rgArgs.push("-i");
		}

		// Multiline
		if (multiline) {
			rgArgs.push("-U", "--multiline-dotall");
		}

		// File type filter
		if (fileType) {
			rgArgs.push("--type", fileType);
		}

		// Glob filter
		if (globPattern) {
			rgArgs.push("--glob", globPattern);
		}

		// Pattern and path
		rgArgs.push("--regexp", pattern, searchPath);

		try {
			const proc = Bun.spawn(rgArgs, {
				cwd: ctx.cwd,
				stdout: "pipe",
				stderr: "pipe",
				signal: ctx.signal,
			});

			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;

			// Exit codes: 0 = matches found, 1 = no matches, 2 = errors (but may still have matches)
			if (exitCode === 2 && !stdout.trim()) {
				if (stderr.trim()) {
					return { output: `ripgrep error: ${stderr.trim()}`, isError: true };
				}
				return {
					output: "No matches found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			if (exitCode === 1) {
				return {
					output: "No matches found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			if (exitCode !== 0 && exitCode !== 2) {
				return { output: `ripgrep failed: ${stderr}`, isError: true };
			}

			const hasErrors = exitCode === 2;

			// Split output into lines
			const rawLines = stdout.trimEnd().split(/\r?\n/);

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
					output: "No matches found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			const output = lines.join("\n");
			const suffix: string[] = [];
			if (truncated) {
				suffix.push(
					`\n(Results limited to ${headLimit} entries. ${rawLines.length - offset - headLimit} more available.)`,
				);
			}
			if (hasErrors) {
				suffix.push("\n(Some paths were inaccessible and skipped)");
			}

			return {
				output: output + suffix.join(""),
				title: pattern,
				metadata: {
					matches: rawLines.length,
					truncated,
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
