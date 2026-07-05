/**
 * Workspace panel type definitions and the Dockview component registry names.
 *
 * Kept free of React / heavy imports so pure logic (layout migration) can depend
 * on it without pulling in panel components.
 */

import type { TerminalLeafConfig, WebviewLeafConfig } from "../split-tree";

/** Panel type discriminator stored on each Dockview panel's params. */
export type WorkspacePanelType = "narrator" | "terminal" | "webview";

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

export type WorkspacePanelParams = NarratorPanelParams | TerminalPanelParams | WebviewPanelParams;

/** Component registry name for each panel type. */
export const PANEL_COMPONENT = {
	narrator: "narrator",
	terminal: "terminal",
	webview: "webview",
} as const;
