import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod/v4";
import { logger } from "../../logger";
import { IS_WINDOWS } from "../../platform";
import { toForwardSlash } from "../../platform-path";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_LINE_LENGTH = 2000;
const MAX_MATCHES = 100;

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

const shellLabel = IS_WINDOWS ? "Shell" : "Bash";

const DESCRIPTION = `- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Filter files by pattern with the include parameter (eg. "*.js", "*.{ts,tsx}")
- Returns file paths and line numbers with at least one match sorted by modification time
- Use this tool when you need to find files containing specific patterns
- If you need to identify/count the number of matches within files, use the ${shellLabel} tool with \`rg\` (ripgrep) directly. Do NOT use \`grep\`.
- When you are doing an open-ended search that may require multiple rounds of globbing and grepping, use the Task tool instead`;

export const grepTool: ToolDefinition = {
	name: "Grep",
	description: DESCRIPTION,
	parameters: z.object({
		pattern: z.string().describe("The regex pattern to search for in file contents"),
		path: z
			.string()
			.optional()
			.describe("The directory or file to search in. Defaults to the current working directory."),
		include: z
			.string()
			.optional()
			.describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		if (!RG_PATH) {
			return { output: RG_INSTALL_HINT, isError: true };
		}

		const {
			pattern,
			path: searchPathArg,
			include,
		} = args as {
			pattern: string;
			path?: string;
			include?: string;
		};

		if (!pattern) {
			return { output: "pattern is required", isError: true };
		}

		let searchPath = searchPathArg ?? ctx.cwd;
		searchPath = isAbsolute(searchPath) ? searchPath : resolve(ctx.cwd, searchPath);

		const rgArgs = [
			RG_PATH,
			"-nH",
			"--hidden",
			"--no-messages",
			"--field-match-separator=|",
			"--regexp",
			pattern,
		];

		if (include) {
			rgArgs.push("--glob", include);
		}

		rgArgs.push(searchPath);

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
				// No output + exit code 2: could be invalid regex or all paths inaccessible
				if (stderr.trim()) {
					return { output: `ripgrep error: ${stderr.trim()}`, isError: true };
				}
				return {
					output: "No files found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			if (exitCode === 1) {
				return {
					output: "No files found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			if (exitCode !== 0 && exitCode !== 2) {
				return { output: `ripgrep failed: ${stderr}`, isError: true };
			}

			const hasErrors = exitCode === 2;

			// Handle both Unix (\n) and Windows (\r\n) line endings
			const lines = stdout.trim().split(/\r?\n/);
			const matches: {
				path: string;
				modTime: number;
				lineNum: number;
				lineText: string;
			}[] = [];

			for (const line of lines) {
				if (!line) continue;

				const [rawFilePath, lineNumStr, ...lineTextParts] = line.split("|");
				if (!rawFilePath || !lineNumStr || lineTextParts.length === 0) continue;

				const lineNum = parseInt(lineNumStr, 10);
				const lineText = lineTextParts.join("|");

				// Normalise backslashes so paths are consistent across platforms
				const filePath = toForwardSlash(rawFilePath);

				const file = Bun.file(filePath);
				const stats = await file.stat().catch(() => null);
				if (!stats) continue;

				matches.push({
					path: filePath,
					modTime: stats.mtime.getTime(),
					lineNum,
					lineText,
				});
			}

			// Sort by modification time descending (most recently modified first)
			matches.sort((a, b) => b.modTime - a.modTime);

			const truncated = matches.length > MAX_MATCHES;
			const finalMatches = truncated ? matches.slice(0, MAX_MATCHES) : matches;

			if (finalMatches.length === 0) {
				return {
					output: "No files found",
					title: pattern,
					metadata: { matches: 0, truncated: false },
				};
			}

			const totalMatches = matches.length;
			const outputLines = [
				`Found ${totalMatches} matches${truncated ? ` (showing first ${MAX_MATCHES})` : ""}`,
			];

			let currentFile = "";
			for (const match of finalMatches) {
				if (currentFile !== match.path) {
					if (currentFile !== "") {
						outputLines.push("");
					}
					currentFile = match.path;
					outputLines.push(`${match.path}:`);
				}
				const truncatedLineText =
					match.lineText.length > MAX_LINE_LENGTH
						? `${match.lineText.substring(0, MAX_LINE_LENGTH)}...`
						: match.lineText;
				outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`);
			}

			if (truncated) {
				outputLines.push("");
				outputLines.push(
					`(Results truncated: showing ${MAX_MATCHES} of ${totalMatches} matches (${totalMatches - MAX_MATCHES} hidden). Consider using a more specific path or pattern.)`,
				);
			}

			if (hasErrors) {
				outputLines.push("");
				outputLines.push("(Some paths were inaccessible and skipped)");
			}

			return {
				output: outputLines.join("\n"),
				title: pattern,
				metadata: {
					matches: totalMatches,
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
