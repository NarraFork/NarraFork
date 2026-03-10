import { toolRegistry } from "../tool-registry";
import type { ToolDefinition } from "../types";
import { askUserQuestionTool } from "./ask-user-question";
import { bashTool } from "./bash";
import { cancelBackgroundTaskTool } from "./cancel-background-task";
import { checkBackgroundTaskTool } from "./check-background-task";
import { continueTaskTool } from "./continue-task";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode";
import { readTool } from "./read";
import { skillTool } from "./skill";
import { taskTool } from "./task";
import { terminalTool } from "./terminal";
import { todoWriteTool } from "./todo";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

/**
 * Optional tools — registered in the registry but excluded by default.
 * They are included in a narrator session only when explicitly loaded
 * (via `/load <name>` or when the corresponding routine is enabled).
 *
 * Map key = tool name as it appears in the registry (e.g. "Terminal").
 */
export const OPTIONAL_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map([
	["Terminal", terminalTool],
]);

/** Register all core tools into the singleton registry */
export function registerCoreTools(): void {
	toolRegistry.register(bashTool);
	toolRegistry.register(readTool);
	toolRegistry.register(writeTool);
	toolRegistry.register(editTool);
	toolRegistry.register(globTool);
	toolRegistry.register(grepTool);
	toolRegistry.register(webSearchTool);
	toolRegistry.register(todoWriteTool);
	toolRegistry.register(enterPlanModeTool);
	toolRegistry.register(exitPlanModeTool);
	toolRegistry.register(taskTool);
	toolRegistry.register(continueTaskTool);
	toolRegistry.register(checkBackgroundTaskTool);
	toolRegistry.register(cancelBackgroundTaskTool);
	toolRegistry.register(askUserQuestionTool);
	toolRegistry.register(skillTool);

	// Register optional tools (they use isAvailable to stay hidden by default)
	for (const tool of OPTIONAL_TOOLS.values()) {
		toolRegistry.register(tool);
	}
}
