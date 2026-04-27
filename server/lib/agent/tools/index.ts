import { type ToolProvider, toolRegistry } from "../tool-registry";
import type { ToolDefinition } from "../types";
import { askUserQuestionTool } from "./ask-user-question";
import { awaitBackgroundTaskTool } from "./await-background-task";
import { bashTool } from "./bash";
import { browserTool } from "./browser";
import { concludeReviewTool } from "./conclude-review";
import { continueTaskTool } from "./continue-task";
import { editTool } from "./edit";
import { forkNarratorTool } from "./fork-narrator";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { narraforkAdminTool } from "./narrafork-admin";
import {
	approvePermissionTool,
	denyPermissionTool,
	getNarratorContextTool,
	listManagedNarratorsTool,
} from "./overseer";
import { enterPlanModeTool, exitPlanModeTool } from "./plan-mode";
import { readTool } from "./read";
import { recallTool } from "./recall";
import { shareFileTool } from "./share-file";
import { skillTool } from "./skill";
import { agentTool } from "./task";
import { teamStatusTool } from "./team-status";
import { terminalTool } from "./terminal";
import { taskCreateTool } from "./todo";
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
	["NarraForkAdmin", narraforkAdminTool],
]);

/**
 * Overseer-only tools — only injected for narrators bound to an overseer.
 */
export const OVERSEER_TOOLS: ReadonlyMap<string, ToolDefinition> = new Map([
	["ApprovePermission", approvePermissionTool],
	["DenyPermission", denyPermissionTool],
	["ListManagedNarrators", listManagedNarratorsTool],
	["GetNarratorContext", getNarratorContextTool],
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
			taskCreateTool,
			enterPlanModeTool,
			exitPlanModeTool,
			agentTool,
			continueTaskTool,
			awaitBackgroundTaskTool,
			teamStatusTool,
			askUserQuestionTool,
			skillTool,
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

/** Overseer tools provider — injected for overseer narrators. */
const overseerProvider: ToolProvider = {
	name: "overseer",
	tools() {
		return [...OVERSEER_TOOLS.values()];
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
	toolRegistry.registerProvider(overseerProvider);
	toolRegistry.registerProvider(reviewProvider);
}
