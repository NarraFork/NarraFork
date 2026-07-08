import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { z } from "zod/v4";
import { specVfsService } from "../../../services/spec-vfs-service";
import { imageToBase64 } from "../../uploads";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText } from "./encoding";

/**
 * When limit = -1 (read-all mode), cap output at ≈100 KB of text
 * to avoid blowing up the context window.
 */
const READ_ALL_MAX_CHARS = 100_000;

/** For large text files, never fall back to whole-file `.text()` + `.split()`. */
const FULL_READ_STREAM_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Default number of lines shown when a large file is read without offset/limit. */
const DEFAULT_LARGE_FILE_LINES = 2000;

/** Long physical lines can otherwise dominate memory and UI rendering. */
const MAX_LINE_CHARS = 2000;

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
		"Reads a file from the local filesystem or the narrator's Dynamic Spec virtual files. You can access any file directly by using this tool.\n" +
		"Assume this tool is able to read all local files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\n" +
		"Usage:\n" +
		"- The file_path parameter must be an absolute local path, or a spec:// URI for Dynamic Spec virtual files\n" +
		"- Dynamic Spec examples: spec://tasks.json, spec://index.md, spec://behavior_fence. spec:// paths are virtual and do not need to be absolute.\n" +
		"- By default, it reads the entire file from the beginning\n" +
		"- You can optionally specify a line offset and limit (especially handy for long files)\n" +
		"- Set limit to -1 to force reading from the offset (or start) to EOF, bypassing output truncation (up to ~100k chars)\n" +
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
				description: "The absolute local path or spec:// Dynamic Spec URI to read",
				type: "string",
			},
			offset: {
				description:
					"The line number to start reading from. Only provide if the file is too large to read at once",
				type: "number",
			},
			limit: {
				description:
					"The number of lines to read. Set limit to -1 to read from the offset (or start) to EOF while bypassing output truncation (up to ~100k chars). Only provide if the file is too large to read at once.",
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
		file_path: z.string().describe("The absolute local path or spec:// Dynamic Spec URI to read"),
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
				"The number of lines to read. Set limit to -1 to read from the offset (or start) to EOF while bypassing output truncation (up to ~100k chars). Only provide if the file is too large to read at once.",
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

		if (specVfsService.isSpecUri(file_path)) {
			try {
				const file = await specVfsService.readSpecFile(ctx.narratorId, file_path);
				const lines = file.content.split("\n");
				const start = Math.max(0, (offset ?? 1) - 1);
				const end = limit && limit !== -1 ? start + limit : lines.length;
				const slice = lines.slice(start, end);
				const numbered = formatNumberedLines(slice, start + 1);
				return {
					output: numbered || "(empty file)",
					title: file.uri,
					metadata: {
						totalLines: lines.length,
						readLines: slice.length,
						readAll,
						specPath: file.path,
						readonly: file.readonly,
						builtin: file.builtin,
					},
				};
			} catch (err) {
				return {
					output: `Error reading ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
					isError: true,
				};
			}
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
			const file = Bun.file(resolvedPath);
			const fileSize = file.size;
			const shouldStream = readAll || fileSize > FULL_READ_STREAM_THRESHOLD_BYTES;

			if (shouldStream) {
				const startLine = offset ?? 1;
				const largeFileAutoLimited =
					fileSize > FULL_READ_STREAM_THRESHOLD_BYTES && limit == null && !readAll;
				const effectiveLimit = readAll
					? undefined
					: (limit ?? (largeFileAutoLimited ? DEFAULT_LARGE_FILE_LINES : undefined));
				const streamResult = await readTextLinesStream(
					resolvedPath,
					startLine,
					effectiveLimit,
					READ_ALL_MAX_CHARS,
					ctx.signal,
				);
				const numbered = formatNumberedLines(streamResult.lines, startLine, {
					truncateLines: false,
				});
				const suffix = buildStreamSuffix({
					readAll,
					largeFileAutoLimited,
					startLine,
					effectiveLimit,
					streamResult,
				});

				return {
					output: (numbered || "(no lines in requested range)") + suffix,
					title: file_path,
					truncated:
						readAll ||
						streamResult.cappedByChars ||
						streamResult.cappedByLines ||
						(fileSize > FULL_READ_STREAM_THRESHOLD_BYTES && limit == null),
					metadata: {
						readLines: streamResult.lines.length,
						readAll,
						startLine,
						fileSize,
						totalLines: streamResult.totalLinesKnown ? streamResult.scannedLines : undefined,
						totalLinesKnown: streamResult.totalLinesKnown,
					},
				};
			}

			const { text } = await readFileText(resolvedPath);
			const lines = text.split("\n");
			const start = Math.max(0, (offset ?? 1) - 1);
			const end = limit ? start + limit : lines.length;
			const slice = lines.slice(start, end);
			const numbered = formatNumberedLines(slice, start + 1);

			return {
				output: numbered || "(empty file)",
				title: file_path,
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

type StreamReadResult = {
	lines: string[];
	scannedLines: number;
	totalLinesKnown: boolean;
	cappedByChars: boolean;
	cappedByLines: boolean;
};

function truncateDisplayLine(line: string): string {
	if (line.length <= MAX_LINE_CHARS) return line;
	return `${line.slice(0, MAX_LINE_CHARS)}… [line truncated, ${line.length} chars total]`;
}

function formatNumberedLines(
	lines: string[],
	startLine: number,
	options: { truncateLines?: boolean } = {},
): string {
	const truncateLines = options.truncateLines ?? true;
	return lines
		.map(
			(line, i) =>
				`${String(startLine + i).padStart(6)}│${truncateLines ? truncateDisplayLine(line) : line}`,
		)
		.join("\n");
}

async function readTextLinesStream(
	filePath: string,
	startLine: number,
	limit: number | undefined,
	maxChars: number,
	signal: AbortSignal,
): Promise<StreamReadResult> {
	const stream = createReadStream(filePath, { encoding: "utf-8" });
	const lines: string[] = [];
	let scannedLines = 0;
	let chars = 0;
	let cappedByChars = false;
	let cappedByLines = false;
	let totalLinesKnown = true;
	let stopped = false;

	let currentLine = "";
	let currentLineChars = 0;
	let currentLineTruncated = false;

	const resetCurrentLine = () => {
		currentLine = "";
		currentLineChars = 0;
		currentLineTruncated = false;
	};

	const shouldCaptureCurrentLine = () => scannedLines + 1 >= startLine;
	const lineLimitReached = () =>
		limit != null && shouldCaptureCurrentLine() && lines.length >= limit;

	const appendLineSegment = (segment: string) => {
		if (lineLimitReached()) {
			cappedByLines = true;
			totalLinesKnown = false;
			stopped = true;
			return;
		}

		currentLineChars += segment.length;
		if (!shouldCaptureCurrentLine()) return;
		if (currentLine.length >= MAX_LINE_CHARS) {
			if (segment.length > 0) currentLineTruncated = true;
			return;
		}

		const remaining = MAX_LINE_CHARS - currentLine.length;
		const captured = segment.slice(0, remaining);
		currentLine += captured;
		if (captured.length < segment.length) currentLineTruncated = true;
	};

	const finalizeCurrentLine = () => {
		if (stopped) return;
		if (lineLimitReached()) {
			cappedByLines = true;
			totalLinesKnown = false;
			stopped = true;
			resetCurrentLine();
			return;
		}

		scannedLines++;
		if (scannedLines < startLine) {
			resetCurrentLine();
			return;
		}

		let displayLine = currentLine;
		let physicalChars = currentLineChars;
		if (displayLine.endsWith("\r")) {
			displayLine = displayLine.slice(0, -1);
			physicalChars = Math.max(0, physicalChars - 1);
		}
		if (currentLineTruncated || physicalChars > displayLine.length) {
			displayLine = `${displayLine}… [line truncated, ${physicalChars} chars total]`;
		}

		const projectedChars = chars + displayLine.length + 16;
		if (projectedChars > maxChars) {
			cappedByChars = true;
			totalLinesKnown = false;
			stopped = true;
			resetCurrentLine();
			return;
		}

		lines.push(displayLine);
		chars = projectedChars;
		resetCurrentLine();
	};

	const onAbort = () => {
		stream.destroy(new Error("Read aborted"));
	};
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		for await (const chunk of stream) {
			if (signal.aborted) throw new Error("Read aborted");
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
			let start = 0;
			while (start < text.length) {
				const newlineIndex = text.indexOf("\n", start);
				const end = newlineIndex === -1 ? text.length : newlineIndex;
				appendLineSegment(text.slice(start, end));
				if (stopped) break;
				if (newlineIndex === -1) break;
				finalizeCurrentLine();
				if (stopped) break;
				start = newlineIndex + 1;
			}
			if (stopped) break;
		}

		if (!stopped && currentLineChars > 0) {
			finalizeCurrentLine();
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		stream.destroy();
	}

	return { lines, scannedLines, totalLinesKnown, cappedByChars, cappedByLines };
}

function buildStreamSuffix(options: {
	readAll: boolean;
	largeFileAutoLimited: boolean;
	startLine: number;
	effectiveLimit: number | undefined;
	streamResult: StreamReadResult;
}): string {
	const suffix: string[] = [];
	const { readAll, largeFileAutoLimited, startLine, effectiveLimit, streamResult } = options;

	if (streamResult.cappedByChars) {
		suffix.push(
			`output capped at ${READ_ALL_MAX_CHARS} chars. Use offset/limit to read a smaller range.`,
		);
	}
	if (streamResult.cappedByLines && effectiveLimit != null) {
		const nextOffset = startLine + streamResult.lines.length;
		suffix.push(`output limited to ${effectiveLimit} lines. Continue with offset=${nextOffset}.`);
	}
	if (largeFileAutoLimited && !readAll && effectiveLimit != null) {
		suffix.push(
			`large file detected; streamed only the first ${effectiveLimit} lines. Use offset/limit for more.`,
		);
	}
	if (readAll && !streamResult.totalLinesKnown) {
		suffix.push("read-all mode stops after the safe output cap instead of loading the whole file.");
	}

	return suffix.length > 0 ? `\n\n...${suffix.join(" ")}` : "";
}

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
