import { resolve } from "node:path";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText } from "./encoding";

export const readTool: ToolDefinition = {
	name: "Read",
	description:
		"Read a file. Returns content with line numbers. Supports offset/limit for line-based paging. " +
		"Set force_full=true to bypass output truncation and return the entire file.",
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
				"If true, returns the entire file and bypasses tool-output truncation. Cannot combine with offset/limit.",
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

			const numbered = slice
				.map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`)
				.join("\n");

			return {
				output: numbered || "(empty file)",
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
