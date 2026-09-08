/**
 * Workspace panel type definitions and the Dockview component registry names.
 *
 * Kept free of React / heavy imports so pure logic (layout migration) can depend
 * on it without pulling in panel components.
 */

import type { PluginDockPanelParams } from "../../plugins/protocol";
import type { NarratorToolPanelType } from "../dock/dock-panel-types";
import type { FilePanelParams } from "../panels/panel-kind";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../split-tree";

/** Panel type discriminator stored on each Dockview panel's params. */
export type WorkspacePanelType =
	| "narrator"
	| "terminal"
	| "webview"
	| "narrator-tool"
	| "subagent"
	| "file"
	| "knowledge"
	| "plugin";

/** Params carried by a narrator panel. */
export interface NarratorPanelParams {
	panelType: "narrator";
	narratorId: string;
}

/**
 * The membership row a non-narrator top-level panel belongs to.
 *
 * REQUIRED, and that is the point: terminal / webview / plugin panels are membership
 * (rows in `workspace_panels`), and their identity has to come from params rather than
 * from the dockview panel id. Making it non-optional means "add a terminal panel
 * without first creating its row" cannot be expressed — which is exactly the mistake
 * that left these three kinds writing only to the layout blob, so they were pruned on
 * the next open and closed by the membership sync in the meantime.
 *
 * A narrator panel needs no equivalent: `narratorId` already identifies its row, which
 * is unique per workspace by database constraint.
 */
export interface WorkspaceMemberRowRef {
	/** `workspace_panels.id` for this panel. */
	panelRowId: string;
}

/** Params carried by a terminal panel. */
export interface TerminalPanelParams extends WorkspaceMemberRowRef {
	panelType: "terminal";
	terminalConfig: TerminalLeafConfig;
}

/** Params carried by a webview panel. */
export interface WebviewPanelParams extends WorkspaceMemberRowRef {
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
	/**
	 * One-shot jump request: scroll to and flash this message once mounted. Set when
	 * the panel was opened from a row pointing at one specific thing the child said.
	 * Stripped before persistence — see the focus dock's counterpart in
	 * `../panels/panel-kind` for why a request must not be restored.
	 */
	highlightMessageId?: string;
	/** Distinguishes consecutive jump requests so a repeat click re-fires. */
	highlightRequestId?: string;
}

/**
 * Multi-instance read-only file viewer belonging to one narrator cluster. Like
 * `subagent`, the host is explicit so orphan pruning can close it when the
 * owning narrator cell goes away.
 */
export interface WorkspaceFilePanelParams extends FilePanelParams {
	hostNarratorId: string;
}

/**
 * Multi-instance knowledge entry viewer/editor belonging to one narrator
 * cluster. Like `file`, the host is explicit for orphan pruning.
 */
export interface WorkspaceKnowledgePanelParams {
	panelType: "knowledge";
	hostNarratorId: string;
	entryId: string;
	scope: "global" | "personal";
}

export type WorkspacePanelParams =
	| NarratorPanelParams
	| TerminalPanelParams
	| WebviewPanelParams
	| NarratorToolPanelParams
	| SubagentPanelParams
	| WorkspaceFilePanelParams
	| WorkspaceKnowledgePanelParams
	| PluginDockPanelParams;

/** Component registry name for each panel type. */
export const PANEL_COMPONENT = {
	narrator: "narrator",
	terminal: "terminal",
	webview: "webview",
	narratorTool: "narrator-tool",
	subagent: "subagent",
	file: "file",
	knowledge: "knowledge",
	plugin: "plugin",
} as const;
