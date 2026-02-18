import { z } from "zod/v4";
import type { ToolDefinition, ToolResult } from "../types";

export const editTool: ToolDefinition = {
	name: "Edit",
	description:
		"Edit a file by replacing an exact string match. old_string must be unique in the file unless replace_all is true.",
	parameters: z.object({
		file_path: z.string(),
		old_string: z.string(),
		new_string: z.string(),
		replace_all: z.boolean().optional(),
	}),
	async execute(args): Promise<ToolResult> {
		const { file_path, old_string, new_string, replace_all } = args as {
			file_path: string;
			old_string: string;
			new_string: string;
			replace_all?: boolean;
		};
		try {
			const content = await Bun.file(file_path).text();

			if (!content.includes(old_string)) {
				return { output: `old_string not found in ${file_path}`, isError: true };
			}

			if (!replace_all) {
				const first = content.indexOf(old_string);
				const second = content.indexOf(old_string, first + 1);
				if (second !== -1) {
					return {
						output: `old_string is not unique in ${file_path} (found multiple matches). Use replace_all or provide more context.`,
						isError: true,
					};
				}
			}

			const updated = replace_all
				? content.replaceAll(old_string, new_string)
				: content.replace(old_string, new_string);

			await Bun.write(file_path, updated);
			return { output: `Edited ${file_path}`, title: file_path };
		} catch (err) {
			return {
				output: `Error editing ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
