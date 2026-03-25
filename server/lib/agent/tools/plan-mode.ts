import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod/v4";
import { isInsidePath } from "../../platform-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

export const enterPlanModeTool: ToolDefinition = {
	name: "EnterPlanMode",
	description:
		"Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.\n\n" +
		"## When to Use This Tool\n\n" +
		"**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:\n\n" +
		"1. **New Feature Implementation**: Adding meaningful new functionality\n" +
		'   - Example: "Add a logout button" - where should it go? What should happen on click?\n' +
		'   - Example: "Add form validation" - what rules? What error messages?\n\n' +
		"2. **Multiple Valid Approaches**: The task can be solved in several different ways\n" +
		'   - Example: "Add caching to the API" - could use Redis, in-memory, file-based, etc.\n' +
		'   - Example: "Improve performance" - many optimization strategies possible\n\n' +
		"3. **Code Modifications**: Changes that affect existing behavior or structure\n" +
		'   - Example: "Update the login flow" - what exactly should change?\n' +
		'   - Example: "Refactor this component" - what\'s the target architecture?\n\n' +
		"4. **Architectural Decisions**: The task requires choosing between patterns or technologies\n" +
		'   - Example: "Add real-time updates" - WebSockets vs SSE vs polling\n' +
		'   - Example: "Implement state management" - Redux vs Context vs custom solution\n\n' +
		"5. **Multi-File Changes**: The task will likely touch more than 2-3 files\n" +
		'   - Example: "Refactor the authentication system"\n' +
		'   - Example: "Add a new API endpoint with tests"\n\n' +
		"6. **Unclear Requirements**: You need to explore before understanding the full scope\n" +
		'   - Example: "Make the app faster" - need to profile and identify bottlenecks\n' +
		'   - Example: "Fix the bug in checkout" - need to investigate root cause\n\n' +
		"7. **User Preferences Matter**: The implementation could reasonably go multiple ways\n" +
		"   - If you would use AskUserQuestion to clarify the approach, use EnterPlanMode instead\n" +
		"   - Plan mode lets you explore first, then present options with context\n\n" +
		"## When NOT to Use This Tool\n\n" +
		"Only skip EnterPlanMode for simple tasks:\n" +
		"- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\n" +
		"- Adding a single function with clear requirements\n" +
		"- Tasks where the user has given very specific, detailed instructions\n" +
		"- Pure research/exploration tasks (use the Agent tool with explore agent instead)\n\n" +
		"## What Happens in Plan Mode\n\n" +
		"In plan mode, you'll:\n" +
		"1. Thoroughly explore the codebase using Glob, Grep, and Read tools\n" +
		"2. Understand existing patterns and architecture\n" +
		"3. Design an implementation approach\n" +
		"4. Present your plan to the user for approval\n" +
		"5. Use AskUserQuestion if you need to clarify approaches\n" +
		"6. Exit plan mode with ExitPlanMode when ready to implement\n\n" +
		"## Examples\n\n" +
		"### GOOD - Use EnterPlanMode:\n" +
		'User: "Add user authentication to the app"\n' +
		"- Requires architectural decisions (session vs JWT, where to store tokens, middleware structure)\n\n" +
		'User: "Optimize the database queries"\n' +
		"- Multiple approaches possible, need to profile first, significant impact\n\n" +
		'User: "Implement dark mode"\n' +
		"- Architectural decision on theme system, affects many components\n\n" +
		'User: "Add a delete button to the user profile"\n' +
		"- Seems simple but involves: where to place it, confirmation dialog, API call, error handling, state updates\n\n" +
		'User: "Update the error handling in the API"\n' +
		"- Affects multiple files, user should approve the approach\n\n" +
		"### BAD - Don't use EnterPlanMode:\n" +
		'User: "Fix the typo in the README"\n' +
		"- Straightforward, no planning needed\n\n" +
		'User: "Add a console.log to debug this function"\n' +
		"- Simple, obvious implementation\n\n" +
		'User: "What files handle routing?"\n' +
		"- Research task, not implementation planning\n\n" +
		"## Important Notes\n\n" +
		"- This tool REQUIRES user approval - they must consent to entering plan mode\n" +
		"- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work\n" +
		"- Users appreciate being consulted before significant changes are made to their codebase",
	rawJsonSchema: {
		type: "object",
		properties: {},
		additionalProperties: false,
	},
	parameters: z.object({
		confirm: z
			.literal(true)
			.default(true)
			.describe("Confirm entering plan mode. Always pass true."),
	}),
	async execute(_args, ctx): Promise<ToolResult> {
		// DB update + WS broadcast handled by session layer (assistant_message event).
		const locale = (ctx?.locale as Locale) ?? "en";
		return { output: getToolMessage("enterPlanModeOutput", locale) };
	},
};

export const exitPlanModeTool: ToolDefinition = {
	name: "ExitPlanMode",
	description:
		"Use this tool when you are in plan mode and have finished designing your implementation plan and are ready for user approval.\n\n" +
		"## How This Tool Works\n" +
		"- You MUST pass the complete plan content in the `plan` parameter\n" +
		"- The user will see the plan content you provide and decide whether to approve it\n" +
		"- An empty or missing plan will be rejected — the plan parameter is required\n\n" +
		"## When to Use This Tool\n" +
		"IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase - do NOT use this tool.\n\n" +
		"## Before Using This Tool\n" +
		"Ensure your plan is complete and unambiguous:\n" +
		"- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)\n" +
		"- Once your plan is finalized, use THIS tool to request approval\n\n" +
		'**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" - that\'s exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.\n\n' +
		"## Examples\n\n" +
		'1. Initial task: "Search for and understand the implementation of vim mode in the codebase" - Do not use the exit plan mode tool because you are not planning the implementation steps of a task.\n' +
		'2. Initial task: "Help me implement yank mode for vim" - Use the exit plan mode tool after you have finished planning the implementation steps of the task.\n' +
		'3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.',
	rawJsonSchema: {
		type: "object",
		properties: {
			plan: {
				description:
					"The COMPLETE implementation plan in markdown format. " +
					"Must contain the full plan with all steps, file changes, and reasoning. " +
					"This content will be shown to the user for approval. Cannot be empty.",
				type: "string",
			},
			allowedPrompts: {
				description:
					"Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
				type: "array",
				items: {
					type: "object",
					properties: {
						tool: {
							description: "The tool this prompt applies to",
							type: "string",
							enum: ["Bash"],
						},
						prompt: {
							description:
								'Semantic description of the action, e.g. "run tests", "install dependencies"',
							type: "string",
						},
					},
					required: ["tool", "prompt"],
					additionalProperties: false,
				},
			},
		},
		required: ["plan"],
		additionalProperties: {},
	},
	parameters: z.object({
		plan: z
			.string()
			.describe(
				"The COMPLETE implementation plan in markdown format. " +
					"Must contain the full plan with all steps, file changes, and reasoning. " +
					"This content will be shown to the user for approval. Cannot be empty.",
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
		const locale = (ctx?.locale as Locale) ?? "en";
		const ok = { output: getToolMessage("exitPlanModeOutput", locale) };

		// Normalize: treat empty/whitespace-only strings as not provided
		const hasPlan = typeof plan === "string" && plan.trim().length > 0;
		const hasPlanFile = typeof planFile === "string" && planFile.trim().length > 0;

		// Validate: exactly one of plan or planFile must be provided.
		// Exception: if neither is provided but a plan file exists on disk, use it automatically.
		if (hasPlan && hasPlanFile) {
			return {
				output: getToolMessage("exitPlanModeBothProvided", locale),
				isError: true,
			};
		}

		// If planFile is provided, validate it exists, is readable, and has content
		if (hasPlanFile) {
			const validation = validatePlanFile(cwd, planFile as string, locale);
			if (validation.isError) return validation;
			return ok;
		}

		// If inline plan is provided, return confirmation
		if (hasPlan) {
			return ok;
		}

		// Neither provided — try to auto-detect the plan file from planFileId
		if (planFileId) {
			const autoPath = `.narrafork/plan-${planFileId}.md`;
			const absPath = resolve(cwd, autoPath);
			if (existsSync(absPath)) {
				const validation = validatePlanFile(cwd, autoPath, locale);
				if (validation.isError) return validation;
				return ok;
			}
		}

		return {
			output: getToolMessage("exitPlanModeNeitherProvided", locale),
			isError: true,
		};
	},
};

function validatePlanFile(cwd: string, planFile: string, locale: Locale): ToolResult {
	const absPath = resolve(cwd, planFile);

	// Security: ensure the resolved path is under cwd
	if (!isInsidePath(cwd, absPath)) {
		return {
			output: getToolMessage("exitPlanModeFileOutsideCwd", locale),
			isError: true,
		};
	}

	if (!existsSync(absPath)) {
		return {
			output: getToolMessageWithParams("exitPlanModeFileNotFound", locale, { planFile }),
			isError: true,
		};
	}

	try {
		const content = readFileSync(absPath, "utf-8");
		if (!content.trim()) {
			return {
				output: getToolMessage("exitPlanModeFileEmpty", locale),
				isError: true,
			};
		}
		return { output: "" };
	} catch (err) {
		return {
			output: getToolMessageWithParams("exitPlanModeFileReadError", locale, {
				error: err instanceof Error ? err.message : String(err),
			}),
			isError: true,
		};
	}
}
