import { z } from "zod/v4";
import { PLAN_DIR_REL } from "../../plan-file-path";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../../prompt-i18n";
import type { ToolDefinition, ToolResult } from "../types";

const DISABLE_REFLECTION_REVIEW_DESCRIPTION =
	"Set true to disable plan reflection for the current narrator when the user explicitly requires human approval of the plan.";

export function shouldDisablePlanReflectionReview(value: unknown): boolean {
	return value === true || value === "true" || value === 1 || value === "1";
}

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
		"## Plan File Naming\n\n" +
		`Plan files always live under \`${PLAN_DIR_REL}/\` in the working directory. ` +
		"Optionally, you can provide a `plan_name` parameter as a readable prefix for your plan file. " +
		"The prefix is sanitized and conservatively limited to 48 UTF-8 bytes; the system always appends a fresh random unique suffix, even when the name is unused. " +
		"If omitted, a random readable prefix and unique suffix will be generated.\n\n" +
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
		"- If the user explicitly requires human approval of the plan, set `disableReflectionReview: true`.\n" +
		"- This tool REQUIRES user approval - they must consent to entering plan mode\n" +
		"- If unsure whether to use it, err on the side of planning - it's better to get alignment upfront than to redo work\n" +
		"- Users appreciate being consulted before significant changes are made to their codebase",
	rawJsonSchema: {
		type: "object",
		properties: {
			plan_name: {
				description:
					"Optional readable plan_name prefix (sanitized, limited to 48 UTF-8 bytes); " +
					"a fresh random unique suffix is always appended.",
				type: "string",
			},
			disableReflectionReview: {
				description: DISABLE_REFLECTION_REVIEW_DESCRIPTION,
				anyOf: [
					{ type: "boolean" },
					{ type: "string", enum: ["true", "false", "1", "0"] },
					{ type: "integer", enum: [1, 0] },
				],
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		plan_name: z
			.string()
			.optional()
			.describe(
				"Optional readable plan_name prefix (sanitized, limited to 48 UTF-8 bytes); a fresh random unique suffix is always appended.",
			),
		disableReflectionReview: z
			.union([z.boolean(), z.enum(["true", "false", "1", "0"]), z.literal(1), z.literal(0)])
			.optional()
			.describe(DISABLE_REFLECTION_REVIEW_DESCRIPTION),
	}),
	async execute(_args, ctx): Promise<ToolResult> {
		// DB update + WS broadcast handled by session layer (assistant_message event).
		// The session layer will call enterNarratorPlanMode with the custom plan name
		// and set the planFilePath in the active narrator state.
		const locale = (ctx?.locale as Locale) ?? "en";
		const planFilePath = ctx?.planFilePath as string | undefined;

		// Session layer injects the designated path; keep the receipt as a
		// compact reminder rather than restating the tool description.
		if (planFilePath) {
			return {
				output: getToolMessageWithParams("enterPlanModeOutputWithPath", locale, { planFilePath }),
			};
		}

		// Fallback to simple message (should not happen in normal flow)
		return { output: getToolMessage("enterPlanModeOutput", locale) };
	},
};

const EXIT_PLAN_INLINE_PLAN_PARAM_DESCRIPTION =
	"The COMPLETE implementation plan text itself, in markdown format. " +
	"This must be the ACTUAL plan content (all steps, file changes, and reasoning) — " +
	"NOT a file path, a location, or a reference like 'plan_path: ...' or 'see FILE.md'. " +
	"The verbatim text you put here is what the user reviews and approves. " +
	'Required when you declare mode="inline", and cannot be empty. ' +
	'Ignored when you declare mode="file" — do not put a file path here.';

const EXIT_PLAN_FILE_PATH_PARAM_DESCRIPTION =
	"Path to a custom plan file (relative to cwd or absolute). Only used in relaxed plan mode. " +
	`It MUST resolve inside \`${PLAN_DIR_REL}/\` of the working directory — relaxed plan mode lets you ` +
	"write other files while planning, but the plan itself always stays in that directory, and a path " +
	"resolving outside it (including through a symlink) is refused. " +
	"If provided, the system reads the plan content from this file instead of the default designated plan file. " +
	"The file must exist and contain the complete plan in markdown format.";

/**
 * Retired parameter, kept only on the Zod side for backward compatibility.
 *
 * `allowedPrompts` was copied from an upstream design where approving a plan
 * also pre-authorized a set of commands. NarraFork never implemented that: the
 * only consumer was a line in the exitPlanMode reflection prompt, and no
 * permission was ever granted from it. Worse, being the first declared property
 * made it the field `ensureNonEmptySchema` promoted to "required" on some gateways,
 * so models fabricated permission declarations to satisfy a field that did
 * nothing. It is no longer advertised to models; the Zod field remains optional
 * so historical `inputJson` and any model still sending it keep parsing.
 */
const EXIT_PLAN_ALLOWED_PROMPTS_DEPRECATED_DESCRIPTION =
	"Deprecated and ignored. Retained only so historical tool calls keep parsing; " +
	"it grants no permissions and is not read by anything.";

/**
 * The two plan sources a model can declare via ExitPlanMode's required `mode`.
 *
 * `mode` is a DECLARATION the resolution layer verifies, not a hint it may
 * reinterpret: declaring `inline` without a plan body is an error rather than a
 * silent fallback to reading the plan file. Before `mode` existed the source was
 * inferred purely from which optional fields were present, so a model that
 * forgot the body got a stale file's plan submitted under its name.
 */
export const EXIT_PLAN_MODE_INLINE = "inline";
export const EXIT_PLAN_MODE_FILE = "file";
export type ExitPlanModeSource = typeof EXIT_PLAN_MODE_INLINE | typeof EXIT_PLAN_MODE_FILE;

/** Read the declared mode off a raw tool input, if it is one of the known values. */
export function readDeclaredExitPlanMode(input: {
	mode?: unknown;
}): ExitPlanModeSource | undefined {
	const mode = typeof input.mode === "string" ? input.mode.trim().toLowerCase() : "";
	if (mode === EXIT_PLAN_MODE_INLINE) return EXIT_PLAN_MODE_INLINE;
	if (mode === EXIT_PLAN_MODE_FILE) return EXIT_PLAN_MODE_FILE;
	return undefined;
}

function buildExitPlanModeParamDescription(): string {
	return (
		"Where the plan comes from, declared explicitly. " +
		'"inline" means the complete plan body is in `inline_plan` — declaring it without a real ' +
		"plan body is an error, not a request to read a file. " +
		'"file" means the plan was written to a plan file and the system should read it; ' +
		"`inline_plan` is ignored."
	);
}

function buildExitPlanModeDescription(): string {
	const header =
		"Use this tool when you are in plan mode and have finished designing your implementation plan and are ready for user approval.\n\n";

	const howItWorks =
		"## How This Tool Works\n\n" +
		"Consult the current plan-mode context for the designated plan path, whether inline plans are allowed, and whether relaxed planning is enabled. The runtime validates these restrictions independently of this schema.\n\n" +
		'The required `mode` declares the plan source. With `mode: "inline"`, supply the complete actual plan body in `inline_plan`, never a path or reference. Missing plan text is an error, not a fallback to a file.\n\n' +
		'With `mode: "file"`, write the complete plan to the designated file first; `inline_plan` is ignored. Only in relaxed plan mode may `plan_file_path` select another file. ' +
		`Custom plan paths must still resolve inside \`${PLAN_DIR_REL}/\` of the working directory, including after symlink resolution.\n\n`;

	const rest =
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
		'3. Initial task: "Add a new feature to handle user authentication" - If unsure about auth method (OAuth, JWT, etc.), use AskUserQuestion first, then use exit plan mode tool after clarifying the approach.';
	return header + howItWorks + rest;
}

function buildExitPlanModeSchema(): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			mode: {
				description: buildExitPlanModeParamDescription(),
				type: "string",
				enum: [EXIT_PLAN_MODE_INLINE, EXIT_PLAN_MODE_FILE],
			},
			inline_plan: { description: EXIT_PLAN_INLINE_PLAN_PARAM_DESCRIPTION, type: "string" },
			plan_file_path: { description: EXIT_PLAN_FILE_PATH_PARAM_DESCRIPTION, type: "string" },
		},
		required: ["mode"],
		additionalProperties: {},
	};
}

export const exitPlanModeTool: ToolDefinition = {
	name: "ExitPlanMode",
	executionRouting: {
		kind: "single",
		resolve(input, config) {
			const path =
				config.relaxedPlan === true &&
				typeof input.plan_file_path === "string" &&
				input.plan_file_path.trim()
					? input.plan_file_path.trim()
					: typeof input._planFile === "string" && input._planFile.trim()
						? input._planFile.trim()
						: config.planFilePath;
			return {
				key: "primary",
				operation: path ? "read" : "control",
				...(typeof input.device === "string" ? { deviceId: input.device } : {}),
				...(path ? { path } : {}),
				...(path?.startsWith("spec://") ? { hostOnly: true, pathFlavor: "spec" as const } : {}),
			};
		},
	},
	description: buildExitPlanModeDescription(),
	// Static union of supported inputs; live plan restrictions are enforced by the resolver.
	rawJsonSchema: buildExitPlanModeSchema(),
	parameters: z.object({
		// Required in the MODEL-FACING schema, optional here on purpose: the
		// resolution layer validates `mode` itself so it can return a precise,
		// localized correction, and historical tool calls predating `mode` must
		// still parse when replayed.
		mode: z.string().optional().describe(buildExitPlanModeParamDescription()),
		// `plan` is the canonical field: the resolution layer (resolveExitPlanModeInput)
		// writes the resolved plan body here before tool-executor's safeParse runs, so it
		// must be accepted. `inline_plan` is what the model actually fills; it is normalized
		// into `plan` (and stripped) by the resolution layer. Both are optional; Zod strips
		// unknown keys, so carrying either is safe.
		plan: z.string().optional().describe(EXIT_PLAN_INLINE_PLAN_PARAM_DESCRIPTION),
		inline_plan: z.string().optional().describe(EXIT_PLAN_INLINE_PLAN_PARAM_DESCRIPTION),
		plan_file_path: z.string().optional().describe(EXIT_PLAN_FILE_PATH_PARAM_DESCRIPTION),
		// Retired: no longer advertised to models. See the constant's doc comment.
		allowedPrompts: z
			.array(
				z.object({
					tool: z.string().optional(),
					prompt: z.string().optional(),
				}),
			)
			.optional()
			.describe(EXIT_PLAN_ALLOWED_PROMPTS_DEPRECATED_DESCRIPTION),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		// The session layer (narrator-permission.ts resolveExitPlanModeInput) resolves the
		// plan content before this execute() is called — either from the model's inline
		// `inline_plan` parameter or by reading the designated plan file on disk — and
		// normalizes it into the canonical `plan` field. By the time we get here, `plan`
		// should already contain the resolved content; `inline_plan` is a defensive fallback.
		const locale = (ctx?.locale as Locale) ?? "en";
		const { plan, inline_plan } = args as { plan?: string; inline_plan?: string };
		const resolved = plan ?? inline_plan;
		if (!resolved?.trim()) {
			return {
				output: getToolMessage("exitPlanModeEmptyPlanFallback", locale),
				isError: true,
			};
		}
		return { output: getToolMessage("exitPlanModeOutput", locale) };
	},
};
