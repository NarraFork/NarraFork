import { lstat, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod/v4";
import { imageToBase64 } from "../../uploads";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText } from "./encoding";

/**
 * When limit = -1 (read-all mode), cap output at ≈100 KB of text
 * to avoid blowing up the context window.
 */
const READ_ALL_MAX_CHARS = 100_000;

/** Image extensions → format string for the API (Anthropic media_type = `image/${format}`). */
const IMAGE_EXTENSIONS: Record<string, string> = {
	".png": "png",
	".jpg": "jpeg",
	".jpeg": "jpeg",
	".gif": "gif",
	".webp": "webp",
};

/** Max raw image size we'll base64-encode (~5 MB, safe for all providers). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const readTool: ToolDefinition = {
	name: "Read",
	description:
		"Reads a file from the local filesystem. You can access any file directly by using this tool.\n" +
		"Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\n" +
		"Usage:\n" +
		"- The file_path parameter must be an absolute path, not a relative path\n" +
		"- By default, it reads the entire file from the beginning\n" +
		"- You can optionally specify a line offset and limit (especially handy for long files)\n" +
		"- Set limit to -1 to force reading the entire file, bypassing output truncation (up to ~100k chars)\n" +
		"- Any lines longer than 2000 characters will be truncated\n" +
		"- Results are returned using cat -n format, with line numbers starting at 1\n" +
		"- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.\n" +
		'- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.\n' +
		"- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.\n" +
		"- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.\n" +
		"- You can call multiple tools in a single response. It is always better to speculatively read multiple potentially useful files in parallel.\n" +
		"- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.\n" +
		"- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
	rawJsonSchema: {
		type: "object",
		properties: {
			file_path: {
				description: "The absolute path to the file to read",
				type: "string",
			},
			offset: {
				description:
					"The line number to start reading from. Only provide if the file is too large to read at once",
				type: "number",
			},
			limit: {
				description:
					"The number of lines to read. Set to -1 to read the entire file bypassing output truncation (up to ~100k chars). Only provide if the file is too large to read at once.",
				type: "number",
			},
			pages: {
				description:
					'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
				type: "string",
			},
		},
		required: ["file_path"],
		additionalProperties: false,
	},
	parameters: z.object({
		file_path: z.string().describe("The absolute path to the file to read"),
		offset: z
			.number()
			.optional()
			.describe(
				"The line number to start reading from. Only provide if the file is too large to read at once",
			),
		limit: z
			.number()
			.optional()
			.describe(
				"The number of lines to read. Set to -1 to read the entire file bypassing output truncation (up to ~100k chars). Only provide if the file is too large to read at once.",
			),
		pages: z
			.string()
			.optional()
			.describe(
				'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { file_path } = args as {
			file_path: string;
			offset?: number;
			limit?: number;
		};

		// Coerce offset/limit to integers and clamp to sane values so that
		// slightly-off model outputs (floats, 0, negative) don't cause hard errors.
		const rawOffset = (args as { offset?: number }).offset;
		const rawLimit = (args as { limit?: number }).limit;
		const offset = rawOffset != null ? Math.max(1, Math.round(rawOffset)) : undefined;
		const limit =
			rawLimit != null
				? Math.round(rawLimit) <= 0 && Math.round(rawLimit) !== -1
					? undefined // treat 0 or negative (except -1) as "no limit"
					: Math.round(rawLimit)
				: undefined;

		const readAll = limit === -1;
		if (readAll && offset !== undefined) {
			return {
				output: "Error: limit=-1 (read-all) cannot be combined with offset",
				isError: true,
			};
		}

		const resolvedPath = resolve(ctx.cwd, file_path);

		// ── Directory handling: list contents instead of erroring ──
		try {
			const stat = await lstat(resolvedPath);
			if (stat.isDirectory()) {
				return await listDirectory(file_path, resolvedPath);
			}
		} catch {
			// Path doesn't exist or can't be stat'd — fall through to normal read,
			// which will produce the appropriate error message.
		}

		// ── Image file handling ──
		const ext = extname(resolvedPath).toLowerCase();
		const imageFormat = IMAGE_EXTENSIONS[ext];
		if (imageFormat) {
			try {
				const file = Bun.file(resolvedPath);
				const size = file.size;
				if (size > MAX_IMAGE_BYTES) {
					return {
						output: `Image file too large (${(size / 1024 / 1024).toFixed(1)} MB). Maximum supported size is ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`,
						isError: true,
					};
				}
				const { base64, detectedMediaType } = await imageToBase64(resolvedPath);
				// Prefer the real format detected from file content magic bytes
				const MIME_TO_FORMAT: Record<string, string> = {
					"image/png": "png",
					"image/jpeg": "jpeg",
					"image/gif": "gif",
					"image/webp": "webp",
				};
				const actualFormat =
					(detectedMediaType && MIME_TO_FORMAT[detectedMediaType]) || imageFormat;
				return {
					output: `[Image: ${file_path} (${(size / 1024).toFixed(1)} KB, ${actualFormat})]`,
					title: file_path,
					images: [{ format: actualFormat, base64 }],
					metadata: {
						isImage: true,
						imageFormat: actualFormat,
						filePath: resolvedPath,
						sizeKB: Number.parseFloat((size / 1024).toFixed(1)),
					},
				};
			} catch (err) {
				return {
					output: `Error reading image ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
		}

		// ── Text file handling ──
		try {
			const { text } = await readFileText(resolvedPath);
			const lines = text.split("\n");
			const start = Math.max(0, (offset ?? 1) - 1);
			const end = readAll ? lines.length : limit ? start + limit : lines.length;
			const slice = lines.slice(start, end);

			let numbered = slice
				.map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`)
				.join("\n");

			// read-all mode caps output at ~100k chars to avoid blowing up context.
			let capped = false;
			if (readAll && numbered.length > READ_ALL_MAX_CHARS) {
				numbered = numbered.slice(0, READ_ALL_MAX_CHARS);
				// Trim to last complete line to avoid a broken trailing line,
				// but only if a newline exists in the last 200 chars — otherwise
				// the file has very long / no-newline lines and hard-cutting is fine.
				const tail = numbered.length - 200;
				const lastNewline = numbered.lastIndexOf("\n");
				if (lastNewline > tail) {
					numbered = numbered.slice(0, lastNewline);
				}
				capped = true;
			}

			const suffix = capped
				? `\n\n...output capped at ${READ_ALL_MAX_CHARS} chars. Use offset/limit to read the rest.`
				: "";

			return {
				output: (numbered || "(empty file)") + suffix,
				title: file_path,
				// Mark as pre-truncated to signal loop layer: do not apply global 50KB truncation.
				truncated: readAll,
				metadata: {
					totalLines: lines.length,
					readLines: slice.length,
					readAll,
				},
			};
		} catch (err) {
			return {
				output: `Error reading ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};

// ── Directory listing helper ──

const MAX_DIR_ENTRIES = 500;

async function listDirectory(displayPath: string, resolvedPath: string): Promise<ToolResult> {
	const entries = await readdir(resolvedPath, { withFileTypes: true });

	// Sort: directories first, then files, alphabetical within each group
	const sorted = entries.toSorted((a, b) => {
		const aDir = a.isDirectory() ? 0 : 1;
		const bDir = b.isDirectory() ? 0 : 1;
		if (aDir !== bDir) return aDir - bDir;
		return a.name.localeCompare(b.name);
	});

	const truncated = sorted.length > MAX_DIR_ENTRIES;
	const visible = truncated ? sorted.slice(0, MAX_DIR_ENTRIES) : sorted;

	const lines = visible.map((e) => `  ${e.name}${e.isDirectory() ? "/" : ""}`);
	const header = `Directory listing for ${displayPath}\n`;
	const footer = `\n(${entries.length} entries${truncated ? `, showing first ${MAX_DIR_ENTRIES}` : ""})`;

	return {
		output: header + lines.join("\n") + footer,
		title: displayPath,
	};
}
