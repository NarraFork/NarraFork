import { SHELL_TOOL_NAME } from "@server/lib/agent/tools/bash";
import type { ToolDefinition } from "@server/lib/agent/types";
import {
	getSubagentParentReportingHint,
	getSubagentPrompt,
	type Locale,
	type SubagentType,
} from "@server/lib/prompt-i18n";
import { settings } from "@server/lib/settings";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";

/** Tools available to explore/plan subagents (read + search + shell + conclusion file write) */
const EXPLORE_PLAN_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"WebSearch",
	"WebFetch",
	SHELL_TOOL_NAME,
	"Write",
	"Edit",
	"TeamStatus",
	"Await",
	"Send",
]);

/** Tools available to search subagents. Native web_search is provider-side; WebFetch is for follow-up URLs. */
const SEARCH_TOOLS = new Set(["WebFetch", "TeamStatus", "Await", "Send"]);

/** Tools that are never available inside subagents. */
const DISALLOWED_SUBAGENT_TOOLS = new Set(["AskUserQuestion"]);

/** Tools available to general subagents (EXPLORE_PLAN_TOOLS + non-interactive helpers, no nesting/plan/forking) */
const GENERAL_TOOLS = new Set([...EXPLORE_PLAN_TOOLS, "Skill"]);

function isBuiltinToolAllowedForSubagent(toolName: string): boolean {
	return !DISALLOWED_SUBAGENT_TOOLS.has(toolName);
}

/** MCP tools use the naming convention `mcp__<server>__<tool>` */
function isMcpTool(tool: ToolDefinition): boolean {
	return tool.name.startsWith("mcp__");
}

function normalizeMcpToolBehavior(behavior: string | null | undefined): string | null {
	return behavior === "allow" ? "readWrite" : (behavior ?? null);
}

/**
 * Resolve the effective MCP behavior for a tool definition.
 * Checks per-tool override first, then server defaultBehavior.
 * Returns null when no MCP-specific config applies.
 */
function resolveMcpToolBehavior(tool: ToolDefinition): string | null {
	const meta = tool.metadata;
	if (!meta?.mcpServerId) return null;

	const servers = settings.mcpServers;
	if (!servers) return null;
	const serverConfig = servers.find((s) => s.id === meta.mcpServerId);
	if (!serverConfig) return null;

	if (serverConfig.toolPermissions) {
		const toolPerm = serverConfig.toolPermissions.find(
			(tp) => tp.toolName === meta.mcpToolName && tp.enabled !== false,
		);
		if (toolPerm) return normalizeMcpToolBehavior(toolPerm.behavior);
	}

	return normalizeMcpToolBehavior(serverConfig.defaultBehavior);
}

/**
 * Check if an MCP tool should be included for a given subagent type.
 * - explore/plan (read-only): only readOnly MCP tools
 * - general (read-write): all MCP tools except explicit deny
 * - deny MCP tools are always excluded
 * - MCP tools with no explicit config or "ask" are available to general subagents
 */
function isMcpToolAllowedForSubagent(tool: ToolDefinition, subagentType: string): boolean {
	const behavior = resolveMcpToolBehavior(tool);
	if (behavior === "deny") return false;
	if (subagentType === "explore" || subagentType === "plan") {
		return behavior === "readOnly";
	}
	// general / custom with general access
	return true;
}

/**
 * Check if an MCP tool should be included for the primary narrator.
 * Only excludes tools with "deny" behavior.
 */
export function isMcpToolAllowedForNarrator(tool: ToolDefinition): boolean {
	const behavior = resolveMcpToolBehavior(tool);
	return behavior !== "deny";
}

/** Tool filter factories per built-in subagent type */
const BUILTIN_TOOL_FILTERS: Record<string, (tool: ToolDefinition) => boolean> = {
	explore: (tool) =>
		isBuiltinToolAllowedForSubagent(tool.name) &&
		(EXPLORE_PLAN_TOOLS.has(tool.name) ||
			(isMcpTool(tool) && isMcpToolAllowedForSubagent(tool, "explore"))),
	plan: (tool) =>
		isBuiltinToolAllowedForSubagent(tool.name) &&
		(EXPLORE_PLAN_TOOLS.has(tool.name) ||
			(isMcpTool(tool) && isMcpToolAllowedForSubagent(tool, "plan"))),
	general: (tool) =>
		isBuiltinToolAllowedForSubagent(tool.name) &&
		(GENERAL_TOOLS.has(tool.name) ||
			(isMcpTool(tool) && isMcpToolAllowedForSubagent(tool, "general"))),
	search: (tool) => isBuiltinToolAllowedForSubagent(tool.name) && SEARCH_TOOLS.has(tool.name),
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
			return (tool) =>
				isBuiltinToolAllowedForSubagent(tool.name) &&
				allowed.has(tool.name) &&
				(!isMcpTool(tool) || isMcpToolAllowedForSubagent(tool, "general"));
		}
		default:
			return BUILTIN_TOOL_FILTERS.explore;
	}
}

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 * Accepts an optional pre-loaded customPrompt to avoid redundant I/O.
 *
 * `canReportToParent` controls whether the parent-reporting hint is included.
 * Only background subagents may report to the parent — a foreground subagent
 * blocks the parent until it finishes, so its reports could never be read in
 * time. Advertising the capability to foreground subagents would only cause
 * rejected Send attempts.
 */
export async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
	customPrompt?: string | null,
	canReportToParent = false,
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

	// Background subagents run without blocking the parent, so tell them how to
	// report interim progress to the narrator that launched them (the final
	// result is still returned automatically when they finish).
	if (canReportToParent) {
		basePrompt = `${basePrompt}\n\n${getSubagentParentReportingHint(locale)}`;
	}

	const { prompt } = await buildEffectiveSystemPrompt({
		basePrompt,
		cwd,
		locale,
		contextSummary,
	});
	return prompt ?? basePrompt;
}
