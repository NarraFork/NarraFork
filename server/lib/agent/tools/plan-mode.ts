import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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
		"You can provide the plan in TWO ways (mutually exclusive):\n" +
		"1. **Inline**: Put the complete plan in the 'plan' parameter directly.\n" +
		"2. **File-based**: For complex/long plans, first write the plan to the designated plan file " +
		"using the Write tool (you may use multiple Write/Edit calls to build it incrementally), " +
		"then pass the file path in the 'planFile' parameter.\n" +
		"You MUST use exactly one of 'plan' or 'planFile'. " +
		"Do NOT summarize or abbreviate. The plan must be complete and self-contained.",
	parameters: z.object({
		plan: z
			.string()
			.optional()
			.describe(
				"The COMPLETE plan in markdown format (inline mode). " +
					"Must contain the full implementation plan with all steps, details, and reasoning. " +
					"Mutually exclusive with 'planFile'.",
			),
		planFile: z
			.string()
			.optional()
			.describe(
				"Path to the plan file (relative to cwd), e.g. '.narrafork/plan-xxxx.md'. " +
					"Use this for complex plans that are too long to fit in a single parameter. " +
					"Write the file first using the Write tool, then pass the path here. " +
					"Mutually exclusive with 'plan'.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { plan, planFile } = args as { plan?: string; planFile?: string };
		const cwd = ctx?.cwd ?? process.cwd();
		const planFileId = ctx?.planFileId;

		// Validate: exactly one of plan or planFile must be provided.
		// Exception: if neither is provided but a plan file exists on disk, use it automatically.
		if (plan && planFile) {
			return {
				output: "Error: Provide either 'plan' or 'planFile', not both.",
				isError: true,
			};
		}

		// If planFile is provided, resolve and read it
		if (planFile) {
			return readPlanFile(cwd, planFile);
		}

		// If inline plan is provided, use it directly
		if (plan) {
			return { output: plan };
		}

		// Neither provided — try to auto-detect the plan file from planFileId
		if (planFileId) {
			const autoPath = `.narrafork/plan-${planFileId}.md`;
			const absPath = resolve(cwd, autoPath);
			if (existsSync(absPath)) {
				return readPlanFile(cwd, autoPath);
			}
		}

		return {
			output:
				"Error: You must provide either 'plan' (inline text) or 'planFile' (path to plan file). " +
				"Neither was provided and no plan file was found on disk.",
			isError: true,
		};
	},
};

function readPlanFile(cwd: string, planFile: string): ToolResult {
	const absPath = resolve(cwd, planFile);

	// Security: ensure the resolved path is under cwd
	if (!absPath.startsWith(`${cwd}/`)) {
		return {
			output: "Error: planFile must be within the working directory.",
			isError: true,
		};
	}

	if (!existsSync(absPath)) {
		return {
			output: `Error: Plan file not found: ${planFile}. Write the file first using the Write tool.`,
			isError: true,
		};
	}

	try {
		const content = readFileSync(absPath, "utf-8");
		if (!content.trim()) {
			return {
				output: "Error: Plan file is empty.",
				isError: true,
			};
		}
		return { output: content };
	} catch (err) {
		return {
			output: `Error reading plan file: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}
