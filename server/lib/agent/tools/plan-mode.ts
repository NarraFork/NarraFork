import { z } from "zod/v4";
import { getToolMessage, type Locale } from "../../prompt-i18n";
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
		"Use this tool when you are in plan mode and have finished designing your implementation plan and are ready for user approval.\n\n" +
		"## How This Tool Works\n\n" +
		"You have two ways to submit your plan:\n\n" +
		"### Mode A: Inline plan (for short/medium plans)\n" +
		"Pass the complete plan text in the `plan` parameter.\n\n" +
		"### Mode B: File-based plan (for long/complex plans)\n" +
		"Write your plan to the designated plan file using Write/Edit tools, then call ExitPlanMode WITHOUT the `plan` parameter. " +
		"The system will automatically read the plan file content and present it to the user.\n" +
		"Do NOT put a file reference like 'Plan written to xxx' in the `plan` parameter — just omit `plan` entirely and the system handles the rest.\n\n" +
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
					"This content will be shown to the user for approval. Cannot be empty. " +
					"Omit this parameter if you already wrote the plan to the designated plan file — " +
					"the system will read the file automatically.",
				type: "string",
			},
			allowedPrompts: {
				description:
					"Optional notes for the ExitPlanMode readiness self-check about command categories the plan may require. These do not grant permissions after approval.",
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
		additionalProperties: {},
	},
	parameters: z.object({
		plan: z
			.string()
			.optional()
			.describe(
				"The COMPLETE implementation plan in markdown format. " +
					"Must contain the full plan with all steps, file changes, and reasoning. " +
					"This content will be shown to the user for approval. Cannot be empty. " +
					"Omit this parameter if you already wrote the plan to the designated plan file — " +
					"the system will read the file automatically.",
			),
		allowedPrompts: z
			.array(
				z.object({
					tool: z.string().describe("The tool this prompt applies to"),
					prompt: z.string().describe("Semantic description of the action"),
				}),
			)
			.optional()
			.describe(
				"Optional notes for the ExitPlanMode readiness self-check. These do not grant permissions after approval.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		// The session layer (narrator-session.ts handlePermission) resolves the plan
		// content before this execute() is called — either from the inline `plan`
		// parameter or by reading the designated plan file on disk.  By the time we
		// get here, `plan` should already contain the resolved content.
		const locale = (ctx?.locale as Locale) ?? "en";
		const { plan } = args as { plan?: string };
		if (!plan?.trim()) {
			return {
				output: getToolMessage("exitPlanModeEmptyPlanFallback", locale),
				isError: true,
			};
		}
		return { output: getToolMessage("exitPlanModeOutput", locale) };
	},
};
