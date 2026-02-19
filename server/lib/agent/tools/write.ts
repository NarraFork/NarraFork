import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const writeTool: ToolDefinition = {
	name: "Write",
	description: "Write content to a file. Creates parent directories if needed.",
	parameters: z.object({
		file_path: z.string(),
		content: z.string(),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { file_path, content } = args as { file_path: string; content: string };
		const resolvedPath = resolve(ctx.cwd, file_path);
		try {
			mkdirSync(dirname(resolvedPath), { recursive: true });
			await Bun.write(resolvedPath, content);
			return { output: `Wrote ${content.length} bytes to ${file_path}`, title: file_path };
		} catch (err) {
			return {
				output: `Error writing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
