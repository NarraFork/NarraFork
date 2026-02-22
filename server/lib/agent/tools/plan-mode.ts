import { z } from "zod/v4";
import { getToolMessage, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

export const enterPlanModeTool: ToolDefinition = {
	name: "EnterPlanMode",
	description:
		"Enter plan mode — ONLY use this for complex multi-step implementations, " +
		"large-scale refactoring, or when the user explicitly asks for a plan. " +
		"Do NOT enter plan mode for simple tasks, bug fixes, or straightforward changes. " +
		"In plan mode, focus on analyzing the task, reading relevant files, and forming a plan " +
		"without making any edits or running commands. Call ExitPlanMode with your plan when ready.",
	parameters: z.object({}),
	async execute(_args, ctx): Promise<ToolResult> {
		// DB update + WS broadcast handled by session layer (assistant_message event).
		const locale = (ctx?.locale as Locale) ?? "en";
		return { output: getToolMessage("enterPlanModeOutput", locale) };
	},
};

export const exitPlanModeTool: ToolDefinition = {
	name: "ExitPlanMode",
	description:
		"Exit plan mode and present your plan. " +
		"Include a clear, structured plan of what you intend to do.",
	parameters: z.object({
		plan: z.string().describe("The complete plan in markdown format"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		// DB update + WS broadcast handled by session layer (tool_result event).
		const { plan } = args as { plan: string };
		const locale = (ctx?.locale as Locale) ?? "en";
		const suffix = getToolMessage("exitPlanModeApproved", locale);
		return { output: `${plan}\n\n${suffix}` };
	},
};
