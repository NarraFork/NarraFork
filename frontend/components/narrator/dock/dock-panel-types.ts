/**
 * Panel type definitions for the single-narrator dock surface.
 *
 * These names are now thin aliases over the unified vocabulary in
 * `../panels/panel-kind.ts` (kept for backward-compatible imports across the
 * dock). New code should prefer `PanelKind` / `AnyPanelParams` directly.
 */

import type { PluginDockPanelParams } from "../../plugins/protocol";
import {
	type NarratorBoundPanelParams,
	PANEL_COMPONENT,
	PANEL_DEFAULT_TITLE,
	type PanelKind,
	type ResourcePanelKind,
	type SubagentPanelParams,
	dockPanelId as sharedDockPanelId,
} from "../panels/panel-kind";

/** Panel type discriminator stored on each dockview panel's params. */
export type NarratorDockPanelType = Exclude<PanelKind, "webview">;

/** All tool panels (everything except the primary chat panel). */
export type NarratorToolPanelType = ResourcePanelKind;

/** Params carried by every focus-dock panel. */
export type NarratorDockPanelParams =
	| NarratorBoundPanelParams
	| SubagentPanelParams
	| PluginDockPanelParams;

/** Dockview component registry name for each panel type (kept === the type). */
export const NARRATOR_DOCK_COMPONENT: Record<NarratorDockPanelType, string> = {
	chat: PANEL_COMPONENT.chat,
	terminal: PANEL_COMPONENT.terminal,
	details: PANEL_COMPONENT.details,
	filemod: PANEL_COMPONENT.filemod,
	spec: PANEL_COMPONENT.spec,
	git: PANEL_COMPONENT.git,
	browser: PANEL_COMPONENT.browser,
	tasks: PANEL_COMPONENT.tasks,
	search: PANEL_COMPONENT.search,
	subagent: PANEL_COMPONENT.subagent,
	plugin: PANEL_COMPONENT.plugin,
};

/** Stable dockview panel id for a singleton panel type within one narrator surface. */
export function dockPanelId(type: Exclude<NarratorDockPanelType, "subagent">): string {
	return sharedDockPanelId(type);
}

/** Stable multi-instance panel id for one child narrator session. */
export function subagentDockPanelId(subagentNarratorId: string): string {
	return `ndock-subagent-${subagentNarratorId}`;
}

/** Human-facing default title per panel type (i18n applied at render time). */
export const NARRATOR_DOCK_DEFAULT_TITLE: Record<NarratorDockPanelType, string> = {
	chat: PANEL_DEFAULT_TITLE.chat,
	terminal: PANEL_DEFAULT_TITLE.terminal,
	details: PANEL_DEFAULT_TITLE.details,
	filemod: PANEL_DEFAULT_TITLE.filemod,
	spec: PANEL_DEFAULT_TITLE.spec,
	git: PANEL_DEFAULT_TITLE.git,
	browser: PANEL_DEFAULT_TITLE.browser,
	tasks: PANEL_DEFAULT_TITLE.tasks,
	search: PANEL_DEFAULT_TITLE.search,
	subagent: PANEL_DEFAULT_TITLE.subagent,
	plugin: PANEL_DEFAULT_TITLE.plugin,
};

const NARRATOR_TOOL_PANEL_TYPES: ReadonlySet<string> = new Set([
	"terminal",
	"details",
	"filemod",
	"spec",
	"git",
	"browser",
	"tasks",
	"search",
]);

/** Runtime guard used when scanning serialized/live dock panels. */
export function isNarratorToolPanelType(value: unknown): value is NarratorToolPanelType {
	return typeof value === "string" && NARRATOR_TOOL_PANEL_TYPES.has(value);
}
