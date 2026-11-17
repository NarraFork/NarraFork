import { toolRegistry } from "@server/lib/agent/tool-registry";
import type { ToolDefinition } from "@server/lib/agent/types";
import { getSubagentPrompt, type Locale, type SubagentType } from "@server/lib/prompt-i18n";
import { settings } from "@server/lib/settings";
import {
	compileDelegationPolicy,
	isRuntimeToolAllowed,
	type RuntimePolicy,
	resolveRuntimePolicy,
	UNRESTRICTED_RUNTIME_POLICY,
} from "./agent-runtime/policy";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";

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

/** Common visibility projection for primary and child assembly; MCP config is read live. */
export function runtimeToolFilter(policy: RuntimePolicy): (tool: ToolDefinition) => boolean {
	return (tool) => isRuntimeToolAllowed(policy, tool.name, resolveMcpToolBehavior(tool));
}

/** The same ceiling check by tool name, for execution-time gates. Unknown MCP tools fail closed. */
export function isRuntimeToolNameAllowed(policy: RuntimePolicy, toolName: string): boolean {
	const tool = toolRegistry.get(toolName);
	if (!tool) return !toolName.startsWith("mcp__") && isRuntimeToolAllowed(policy, toolName);
	return runtimeToolFilter(policy)(tool);
}

/**
 * Check if an MCP tool is visible under an unrestricted ceiling.
 * Only excludes tools with "deny" behavior.
 */
export function isMcpToolAllowedForNarrator(tool: ToolDefinition): boolean {
	return runtimeToolFilter(UNRESTRICTED_RUNTIME_POLICY)(tool);
}

/**
 * Tool visibility of a delegation template's compiled ceiling (creation-side
 * preview; a running narrator uses its own resolved traits).
 * Accepts an optional pre-loaded customDef to avoid redundant I/O.
 */
export function resolveToolFilter(
	subagentType: string,
	customDef?: CustomSubagentDef | null,
): ((tool: ToolDefinition) => boolean) | undefined {
	return runtimeToolFilter(
		resolveRuntimePolicy([
			compileDelegationPolicy({ template: subagentType, customDefinition: customDef }),
		]),
	);
}

/**
 * The base prompt a delegation template compiles to, stored on the created narrator.
 *
 * Only the template's own instructions: runtime adds the effective sections (cwd,
 * senders, devices, compact summary) and the relationship and capability hints from
 * the narrator's registration and ceiling on every pass, the same way for every
 * session. A custom template's prompt is read once, here; editing or deleting the
 * definition later does not change sessions created from it.
 */
export async function buildDelegationBasePrompt(
	subagentType: SubagentType,
	locale: Locale,
	customPrompt?: string | null,
): Promise<string> {
	const builtin = getSubagentPrompt(subagentType, locale);
	if (builtin) return builtin;
	const custom =
		customPrompt !== undefined
			? customPrompt
			: ((await customSubagentService.loadByName(subagentType))?.prompt ?? null);
	return (
		custom ||
		(locale === "zh-CN"
			? "你是一个执行委派任务的子代理。完成任务并简洁地报告结果。"
			: "You are a subagent executing a delegated task. Complete the task and report your results concisely.")
	);
}
