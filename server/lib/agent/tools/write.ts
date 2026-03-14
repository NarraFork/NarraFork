import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod/v4";
import { ensureFileSnapshot } from "../../../services/file-snapshot-service";
import type { ToolDefinition, ToolResult } from "../types";
import { readFileText, writeFileText } from "./encoding";

export const writeTool: ToolDefinition = {
	name: "Write",
	description:
		"Writes a file to the local filesystem.\n\n" +
		"Usage:\n" +
		"- This tool will overwrite the existing file if there is one at the provided path.\n" +
		"- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.\n" +
		"- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.\n" +
		"- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.\n" +
		"- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.",
	rawJsonSchema: {
		type: "object",
		properties: {
			file_path: {
				description: "The absolute path to the file to write (must be absolute, not relative)",
				type: "string",
			},
			content: {
				description: "The content to write to the file",
				type: "string",
			},
		},
		required: ["file_path", "content"],
		additionalProperties: false,
	},
	parameters: z.object({
		file_path: z
			.string()
			.describe("The absolute path to the file to write (must be absolute, not relative)"),
		content: z.string().describe("The content to write to the file"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { file_path, content } = args as { file_path: string; content: string };
		const resolvedPath = resolve(ctx.cwd, file_path);
		try {
			// Record original content before writing (non-fatal)
			await ensureFileSnapshot(ctx.narratorId, file_path, async () => {
				try {
					const file = Bun.file(resolvedPath);
					if (await file.exists()) {
						return (await readFileText(resolvedPath)).text;
					}
				} catch {
					// File doesn't exist or can't be read
				}
				return null;
			});

			mkdirSync(dirname(resolvedPath), { recursive: true });
			await writeFileText(resolvedPath, content);
			return { output: `Wrote ${content.length} bytes to ${file_path}`, title: file_path };
		} catch (err) {
			return {
				output: `Error writing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
