import { toolRegistry } from "../tool-registry";
import { askUserQuestionTool } from "./ask-user-question";
import { bashTool } from "./bash";
import { continueTaskTool } from "./continue-task";
import { editTool } from "./edit";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode";
import { readTool } from "./read";
import { skillTool } from "./skill";
import { taskTool } from "./task";
import { todoWriteTool } from "./todo";
import { webSearchTool } from "./web-search";
import { writeTool } from "./write";

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
	toolRegistry.register(askUserQuestionTool);
	toolRegistry.register(skillTool);
}
