import { type ToolProvider, toolRegistry } from "../tool-registry";
import type { ToolDefinition } from "../types";
import { askUserQuestionTool } from "./ask-user-question";
import { awaitTool } from "./await";
import { bashTool } from "./bash";
import { browserTool } from "./browser";
import { concludeReviewTool } from "./conclude-review";
import { contextAskTool } from "./context-ask";
import { dangerCancelTool, dangerConfirmTool } from "./danger-reflection";
import { editTool } from "./edit";
import {
	exitPlanConfirmAndCompactTool,
	exitPlanConfirmTool,
	exitPlanReviseTool,
} from "./exit-plan-reflection";
import { forkNarratorTool } from "./fork-narrator";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { hookAdminTool } from "./hook-admin";
import { knowledgeLibraryTool, knowledgeReadTool, knowledgeSearchTool } from "./knowledge";
import { knowledgeAdminTool } from "./knowledge-admin";
import { knowledgeCreateTool, knowledgeEditTool } from "./knowledge-edit";
import { knowledgeReviewTool } from "./knowledge-review";
import { learningGuideTool } from "./learning-guide";
import { mcpAdminTool } from "./mcp-admin";
import { narraforkAdminTool } from "./narrafork-admin";
import { packActivateTool, packDeactivateTool, packListTool } from "./pack";
import { extractPipelineTool, startPipelineTool } from "./pipeline";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode";
import { pluginInstallTool } from "./plugin-install";
import { readTool } from "./read";
import { recallTool } from "./recall";
import { scheduledTaskTool } from "./scheduled-task";
import { scheduledTaskAdminTool } from "./scheduled-task-admin";
import { sendTool } from "./send";
import { shareFileTool } from "./share-file";
import { skillTool } from "./skill";
import { switchDeviceTool } from "./switch-device";
import { agentTool } from "./task";
import { taskReflectConfirmTool, taskReflectReviseTool } from "./task-reflection";
import { teamStatusTool } from "./team-status";
import { terminalTool } from "./terminal";
import { transferFileTool } from "./transfer-file";
import { webFetchTool } from "./web-fetch";
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
	["ShareFile", shareFileTool],
	["Recall", recallTool],
	["Browser", browserTool],
	["ForkNarrator", forkNarratorTool],
	["ScheduledTask", scheduledTaskTool],
	["NarraForkAdmin", narraforkAdminTool],
	["PackList", packListTool],
	["PackActivate", packActivateTool],
	["PackDeactivate", packDeactivateTool],
	["PluginInstall", pluginInstallTool],
	["McpAdmin", mcpAdminTool],
	["HookAdmin", hookAdminTool],
	["ScheduledTaskAdmin", scheduledTaskAdminTool],
	["KnowledgeCreate", knowledgeCreateTool],
	["KnowledgeEdit", knowledgeEditTool],
	["KnowledgeAdmin", knowledgeAdminTool],
	["KnowledgeReview", knowledgeReviewTool],
	["StartPipeline", startPipelineTool],
	["ExtractPipeline", extractPipelineTool],
]);

/**
 * Knowledge Steward preload tool names live in a dependency-free leaf module so
 * that narrator-service.ts can import them without pulling in tools/index.ts
 * (which would re-form the circular-import chain). Re-exported here for
 * backward compatibility with existing importers.
 */
export {
	KNOWLEDGE_KIND_PRELOAD_TOOLS,
	KNOWLEDGE_KIND_PRELOAD_TOOLS_ADMIN,
} from "./knowledge-kind";

/**
 * Core tools a Knowledge Steward narrator does NOT need — denied in toolFilter for this kind.
 * MUST contain ONLY clearly-unrelated content tools. NEVER include planning/reflection
 * control tools (plan mode, pipeline, danger/exit-plan/task reflection, Task), or the agent
 * loop would stall. A knowledge steward works against the local knowledge base, not the live
 * web, so web search/fetch are dropped.
 */
export const KNOWLEDGE_KIND_DENY_CORE: ReadonlySet<string> = new Set<string>([
	"WebSearch",
	"WebFetch",
]);

/**
 * Review-only tools — only injected for narrators in review chapters.
 */
export const REVIEW_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map([
	["ConcludeReview", concludeReviewTool],
]);

/** Core tools provider — always-available tools. */
const coreProvider: ToolProvider = {
	name: "core",
	tools() {
		return [
			bashTool,
			readTool,
			writeTool,
			editTool,
			globTool,
			grepTool,
			webSearchTool,
			webFetchTool,
			learningGuideTool,
			enterPlanModeTool,
			exitPlanModeTool,
			agentTool,
			awaitTool,
			contextAskTool,
			sendTool,
			teamStatusTool,
			askUserQuestionTool,
			skillTool,
			knowledgeSearchTool,
			knowledgeReadTool,
			knowledgeLibraryTool,
			switchDeviceTool,
			transferFileTool,
			dangerConfirmTool,
			dangerCancelTool,
			exitPlanConfirmTool,
			exitPlanConfirmAndCompactTool,
			exitPlanReviseTool,
			taskReflectConfirmTool,
			taskReflectReviseTool,
		];
	},
};

/** Optional tools provider — hidden by default, loaded on demand. */
const optionalProvider: ToolProvider = {
	name: "optional",
	tools() {
		return [...OPTIONAL_TOOLS.values()];
	},
};

/** Review tools provider — injected for review narrators. */
const reviewProvider: ToolProvider = {
	name: "review",
	tools() {
		return [...REVIEW_TOOLS.values()];
	},
};

/** Register all core tools into the singleton registry */
export function registerCoreTools(): void {
	toolRegistry.registerProvider(coreProvider);
	toolRegistry.registerProvider(optionalProvider);
	toolRegistry.registerProvider(reviewProvider);
}

// Register after this module has finished initializing provider constants. Keeping the
// side effect here avoids calling registerCoreTools from a circular importer while
// coreProvider is still in the temporal dead zone.
registerCoreTools();
