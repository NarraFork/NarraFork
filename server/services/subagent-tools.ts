import { SHELL_TOOL_NAME } from "@server/lib/agent/tools/bash";
import type { ToolDefinition } from "@server/lib/agent/types";
import { getSubagentPrompt, type Locale, type SubagentType } from "@server/lib/prompt-i18n";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";

/** Tools available to explore/plan subagents (read + search + shell + conclusion file write + todos) */
const EXPLORE_PLAN_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
	"Write",
	"Edit",
	"TaskCreate",
	"TeamStatus",
	"AwaitBackgroundTask",
]);

/** Tools available to general subagents (EXPLORE_PLAN_TOOLS + interactive tools, no nesting/plan/forking) */
const GENERAL_TOOLS = new Set([...EXPLORE_PLAN_TOOLS, "AskUserQuestion", "Skill"]);

/** MCP tools use the naming convention `mcp__<server>__<tool>` */
function isMcpTool(tool: ToolDefinition): boolean {
	return tool.name.startsWith("mcp__");
}

/** Tool filter factories per built-in subagent type */
const BUILTIN_TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name) || isMcpTool(tool),
	plan: (tool) => EXPLORE_PLAN_TOOLS.has(tool.name) || isMcpTool(tool),
	general: (tool) => GENERAL_TOOLS.has(tool.name) || isMcpTool(tool),
};

/**
 * Resolve the tool filter for a subagent type.
 * For built-in types, returns the static filter.
 * For custom types, builds a filter based on the custom definition's toolAccess.
 * Accepts an optional pre-loaded customDef to avoid redundant I/O.
 */
export function resolveToolFilter(
	subagentType: string,
	customDef?: CustomSubagentDef | null,
): ((tool: ToolDefinition) => boolean) | undefined {
	const builtin = BUILTIN_TOOL_FILTERS[subagentType];
	if (builtin) return builtin;

	if (!customDef) return BUILTIN_TOOL_FILTERS.explore; // fallback: deny write access when definition is missing

	switch (customDef.toolAccess) {
		case "readOnly":
			return BUILTIN_TOOL_FILTERS.explore;
		case "general":
			return BUILTIN_TOOL_FILTERS.general;
		case "custom": {
			const allowed = new Set(customDef.customTools);
			return (tool) => allowed.has(tool.name) || isMcpTool(tool);
		}
		default:
			return BUILTIN_TOOL_FILTERS.explore;
	}
}

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 * Accepts an optional pre-loaded customPrompt to avoid redundant I/O.
 */
export async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
	customPrompt?: string | null,
): Promise<string> {
	// Try built-in prompt first
	let basePrompt = getSubagentPrompt(subagentType, locale);

	// If not a built-in type, use the pre-loaded custom prompt or load it
	if (!basePrompt) {
		if (customPrompt !== undefined) {
			basePrompt = customPrompt;
		} else {
			const customDef = await customSubagentService.loadByName(subagentType);
			basePrompt = customDef?.prompt ?? null;
		}
	}

	// Fallback to a generic prompt if nothing found
	if (!basePrompt) {
		basePrompt =
			locale === "zh-CN"
				? "你是一个执行委派任务的子代理。完成任务并简洁地报告结果。"
				: "You are a subagent executing a delegated task. Complete the task and report your results concisely.";
	}

	const { prompt } = await buildEffectiveSystemPrompt({
		basePrompt,
		cwd,
		locale,
		contextSummary,
	});
	return prompt ?? basePrompt;
}
