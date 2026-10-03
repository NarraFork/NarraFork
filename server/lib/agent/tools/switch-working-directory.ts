import { switchWorkingDirectorySchema } from "../../validators/workspace-context";
import type { ToolDefinition } from "../types";

export const switchWorkingDirectoryTool: ToolDefinition = {
	name: "SwitchWorkingDirectory",
	description: (config) =>
		"Switch the local working directory of this ordinary primary narrator. Supply the current workspace revision and a unique requestId. Non-Git directories are supported. Remote arbitrary directories and chapter cross-worktree changes are unsupported. This is a strict serial barrier: after a successful change the current pass ends; only the next pass uses the new cwd, skills and permissions. Already started background tools, subagents and terminals retain their original targets.\n" +
		`Current authoritative workspace context: ${JSON.stringify(config.workspaceContext ?? { supported: false })}`,
	parameters: switchWorkingDirectorySchema,
	async execute(args, ctx) {
		if (!ctx.switchWorkingDirectory)
			return {
				isError: true,
				output: "Working-directory switching is unsupported in this runtime.",
			};
		try {
			const result = await ctx.switchWorkingDirectory(switchWorkingDirectorySchema.parse(args));
			return { output: JSON.stringify(result) };
		} catch (error) {
			return { isError: true, output: error instanceof Error ? error.message : String(error) };
		}
	},
};
