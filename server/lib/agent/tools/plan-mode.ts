import { z } from "zod/v4";
import { getToolMessage, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

export const enterPlanModeTool: ToolDefinition = {
	name: "EnterPlanMode",
	description:
		"Enter plan mode — ONLY use this when the task requires producing an implementation plan " +
		"(e.g. the user explicitly asks for a plan, or a complex multi-step change needs an upfront design). " +
		"Do NOT enter plan mode for code analysis, code review, bug investigation, answering questions, " +
		"simple tasks, bug fixes, or straightforward changes — handle those directly in the current context. " +
		"In plan mode, focus on reading relevant files and forming an actionable implementation plan " +
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
		"You MUST put your COMPLETE, FULL plan in the 'plan' parameter — this is the ONLY place the plan is stored and shown to the user. " +
		"Do NOT summarize or abbreviate. Do NOT write the plan in your text response and then reference it here. " +
		"The plan parameter must be self-contained and include every detail.",
	parameters: z.object({
		plan: z
			.string()
			.describe(
				"The COMPLETE plan in markdown format. Must contain the full implementation plan with all steps, details, and reasoning. " +
					"This is the sole source of truth — do NOT put the plan in your text response instead.",
			),
	}),
	async execute(args, _ctx): Promise<ToolResult> {
		// DB update + WS broadcast handled by session layer (tool_result event).
		// The "plan approved" prompt is injected as a user message by the session
		// layer after the tool completes (via _planApprovedContinue flag).
		const { plan } = args as { plan: string };
		return { output: plan };
	},
};
