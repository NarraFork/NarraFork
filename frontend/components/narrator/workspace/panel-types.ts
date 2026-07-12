/**
 * Workspace panel type definitions and the Dockview component registry names.
 *
 * Kept free of React / heavy imports so pure logic (layout migration) can depend
 * on it without pulling in panel components.
 */

import type { NarratorToolPanelType } from "../dock/dock-panel-types";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../split-tree";

/** Panel type discriminator stored on each Dockview panel's params. */
export type WorkspacePanelType = "narrator" | "terminal" | "webview" | "narrator-tool" | "subagent";

/** Params carried by a narrator panel. */
export interface NarratorPanelParams {
	panelType: "narrator";
	narratorId: string;
}

/** Params carried by a terminal panel. */
export interface TerminalPanelParams {
	panelType: "terminal";
	terminalConfig: TerminalLeafConfig;
}

/** Params carried by a webview panel. */
export interface WebviewPanelParams {
	panelType: "webview";
	webviewConfig: WebviewLeafConfig;
}

/**
 * Params carried by a narrator-bound tool panel (terminal / details / filemod /
 * spec / git / browser) opened next to a narrator cell in the workspace. Mirrors
 * the focus dock's resource panels, but scoped to a specific narrator so several
 * clusters can coexist on one workspace surface.
 */
export interface NarratorToolPanelParams {
	panelType: "narrator-tool";
	toolType: NarratorToolPanelType;
	narratorId: string;
	/** Chapter id — required by the git tool; optional elsewhere. */
	chapterId?: string | null;
}

/** Multi-instance child session belonging to one root narrator cluster. */
export interface SubagentPanelParams {
	panelType: "subagent";
	hostNarratorId: string;
	subagentNarratorId: string;
}

export type WorkspacePanelParams =
	| NarratorPanelParams
	| TerminalPanelParams
	| WebviewPanelParams
	| NarratorToolPanelParams
	| SubagentPanelParams;

/** Component registry name for each panel type. */
export const PANEL_COMPONENT = {
	narrator: "narrator",
	terminal: "terminal",
	webview: "webview",
	narratorTool: "narrator-tool",
	subagent: "subagent",
} as const;
