/**
 * Panel type definitions for the unified narrator dockview surface.
 *
 * The narrator page hosts a single dockview whose panels are: the chat itself
 * (primary) plus a set of tool panels (details / file modifications / spec /
 * git / browser / terminal). Kept free of React / heavy imports so pure logic
 * (layout persistence) can depend on it.
 */

/** Panel type discriminator stored on each dockview panel's params. */
export type NarratorDockPanelType =
	| "chat"
	| "terminal"
	| "details"
	| "filemod"
	| "spec"
	| "git"
	| "browser";

/** All tool panels (everything except the primary chat panel). */
export type NarratorToolPanelType = Exclude<NarratorDockPanelType, "chat">;

/** Params carried by every narrator dock panel. All panels bind to one narrator. */
export interface NarratorDockPanelParams {
	panelType: NarratorDockPanelType;
	narratorId: string;
	/** Chapter id — required by the git panel; optional elsewhere. */
	chapterId?: string | null;
}

/** Dockview component registry name for each panel type (kept === the type). */
export const NARRATOR_DOCK_COMPONENT: Record<NarratorDockPanelType, string> = {
	chat: "chat",
	terminal: "terminal",
	details: "details",
	filemod: "filemod",
	spec: "spec",
	git: "git",
	browser: "browser",
};

/** Stable dockview panel id for a given panel type within one narrator surface. */
export function dockPanelId(type: NarratorDockPanelType): string {
	// One instance of each tool panel per surface; chat is the root.
	return `ndock-${type}`;
}

/** Human-facing default title per panel type (i18n applied at render time). */
export const NARRATOR_DOCK_DEFAULT_TITLE: Record<NarratorDockPanelType, string> = {
	chat: "Chat",
	terminal: "Terminal",
	details: "Details",
	filemod: "Files",
	spec: "Spec",
	git: "Git",
	browser: "Browser",
};
