import { resolve } from "node:path";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText } from "./encoding";

/** Maximum characters returned by force_full (≈100 KB of text). */
const FORCE_FULL_MAX_CHARS = 100_000;

export const readTool: ToolDefinition = {
	name: "Read",
	description:
		"Read a file. Returns content with line numbers. Supports offset/limit for line-based paging. " +
		"Set force_full=true to bypass output truncation and return as much of the file as possible (up to ~100k chars).",
	parameters: z.object({
		file_path: z.string().describe("Absolute or relative path to the file to read"),
		offset: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe("1-based line number to start reading from (default: 1)"),
		limit: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe("Maximum number of lines to return from the offset"),
		force_full: z
			.boolean()
			.optional()
			.describe(
				"If true, bypasses tool-output truncation and returns as much of the file as possible (up to ~100k chars). Cannot combine with offset/limit.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { file_path, offset, limit, force_full } = args as {
			file_path: string;
			offset?: number;
			limit?: number;
			force_full?: boolean;
		};

		if (force_full && (offset !== undefined || limit !== undefined)) {
			return {
				output: "Error: force_full cannot be combined with offset/limit",
				isError: true,
			};
		}

		const resolvedPath = resolve(ctx.cwd, file_path);
		try {
			const { text } = await readFileText(resolvedPath);
			const lines = text.split("\n");
			const start = force_full ? 0 : Math.max(0, (offset ?? 1) - 1);
			const end = force_full ? lines.length : limit ? start + limit : lines.length;
			const slice = lines.slice(start, end);

			let numbered = slice
				.map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`)
				.join("\n");

			// force_full caps output at ~100k chars to avoid blowing up context.
			let capped = false;
			if (force_full && numbered.length > FORCE_FULL_MAX_CHARS) {
				numbered = numbered.slice(0, FORCE_FULL_MAX_CHARS);
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
				? `\n\n...output capped at ${FORCE_FULL_MAX_CHARS} chars. Use offset/limit to read the rest.`
				: "";

			return {
				output: (numbered || "(empty file)") + suffix,
				title: file_path,
				// Mark as pre-truncated to signal loop layer: do not apply global 50KB truncation.
				truncated: !!force_full,
			};
		} catch (err) {
			return {
				output: `Error reading ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
