import type { ToolDefinition } from "@server/lib/agent/types";
import {
	getSubagentParentReportingHint,
	getSubagentPrompt,
	type Locale,
	type SubagentType,
} from "@server/lib/prompt-i18n";
import { settings } from "@server/lib/settings";
import {
	isRuntimeToolAllowed,
	type RuntimePolicy,
	resolveRuntimePolicy,
	runtimeInteractionHint,
} from "./agent-runtime/policy";
import { type CustomSubagentDef, customSubagentService } from "./custom-subagent-service";
import { buildEffectiveSystemPrompt } from "./narrator-prompt";

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

/**
 * Check if an MCP tool should be included for the primary narrator.
 * Only excludes tools with "deny" behavior.
 */
export function isMcpToolAllowedForNarrator(tool: ToolDefinition): boolean {
	return runtimeToolFilter(resolveRuntimePolicy({ variant: "primary" }))(tool);
}

/**
 * Resolve the tool filter for a subagent type.
 * Projects the shared built-in/custom capability policy into tool visibility.
 * MCP configuration remains live and execution permission gates remain mandatory.
 * Accepts an optional pre-loaded customDef to avoid redundant I/O.
 */
export function resolveToolFilter(
	subagentType: string,
	customDef?: CustomSubagentDef | null,
): ((tool: ToolDefinition) => boolean) | undefined {
	return runtimeToolFilter(
		resolveRuntimePolicy({
			variant: "subagent",
			subagentType,
			customDefinition: customDef,
		}),
	);
}

/**
 * Build the effective system prompt for a subagent.
 * Optionally injects contextSummary (after compact).
 * Accepts an optional pre-loaded customPrompt to avoid redundant I/O.
 *
 * Communication rules are included for every subagent. `canReportToParent`
 * only controls whether interim parent reports are advertised; foreground
 * subagents still receive the async-only communication policy.
 */
export async function buildSubagentSystemPrompt(
	subagentType: SubagentType,
	cwd: string,
	locale: Locale,
	contextSummary?: string | null,
	customPrompt?: string | null,
	canReportToParent = false,
	runtimePolicy?: RuntimePolicy,
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

	// All subagents receive the async-only communication policy. Background
	// subagents additionally receive permission to report interim progress to the
	// parent; foreground subagents are told that their final result is returned
	// automatically when they finish.
	const customDefinition = !["explore", "plan", "review", "search", "general"].includes(
		subagentType,
	)
		? await customSubagentService.loadByName(subagentType)
		: undefined;
	const policy =
		runtimePolicy ?? resolveRuntimePolicy({ variant: "subagent", subagentType, customDefinition });
	basePrompt = `${basePrompt}\n\n${getSubagentParentReportingHint(locale, canReportToParent)}\n${runtimeInteractionHint(policy, locale)}`;

	const { prompt } = await buildEffectiveSystemPrompt({
		basePrompt,
		cwd,
		locale,
		contextSummary,
	});
	return prompt ?? basePrompt;
}
