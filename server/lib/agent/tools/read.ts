import { z } from "zod/v4";
import { truncateOutput } from "../truncate";
import type { ToolDefinition, ToolResult } from "../types";

export const readTool: ToolDefinition = {
	name: "Read",
	description:
		"Read a file. Returns content with line numbers. Supports offset/limit for large files.",
	parameters: z.object({
		file_path: z.string(),
		offset: z.number().optional(),
		limit: z.number().optional(),
	}),
	async execute(args): Promise<ToolResult> {
		const { file_path, offset, limit } = args as {
			file_path: string;
			offset?: number;
			limit?: number;
		};
		try {
			const text = await Bun.file(file_path).text();
			const lines = text.split("\n");
			const start = Math.max(0, (offset ?? 1) - 1);
			const end = limit ? start + limit : lines.length;
			const slice = lines.slice(start, end);

			const numbered = slice
				.map((line, i) => `${String(start + i + 1).padStart(6)}│${line}`)
				.join("\n");

			return { output: truncateOutput(numbered || "(empty file)"), title: file_path };
		} catch (err) {
			return {
				output: `Error reading ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
