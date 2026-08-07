/**
 * Unified panel-kind vocabulary for every NarraFork dockview surface.
 *
 * Historically the single-narrator dock (`dock/dock-panel-types.ts`) and the
 * multi-narrator workspace (`workspace/panel-types.ts`) each defined their own
 * panel-type enum + component registry, with inconsistent names for the same
 * thing (the narrator's own panel was `chat` in the dock but `narrator` in the
 * workspace). This module is the single source of truth both sides now share.
 *
 * Cluster model: a "cluster" is one dockview group = a primary narrator panel
 * (`chat`) plus its secondary panels (terminal / details / filemod / spec / git /
 * browser / subagent) as sibling tabs. The workspace additionally hosts standalone
 * `terminal` / `webview` panels that are not bound to a narrator.
 *
 * Kept free of React / heavy imports so pure logic (layout persistence,
 * migration) can depend on it without pulling in panel components.
 */

import type { PluginDockPanelParams } from "../../plugins/protocol";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../split-tree";

/**
 * Every panel kind that can appear on any surface.
 *
 * - `chat`     — the primary narrator panel (a cluster's protagonist).
 * - `terminal` — a terminal; narrator-bound in the dock, config-bound in a workspace.
 * - `details` / `filemod` / `spec` / `git` / `browser` / `tasks` / `search` — singleton narrator resources.
 * - `subagent` — a multi-instance child-narrator session in the cluster's secondary area.
 * - `file`     — a multi-instance read-only file viewer in the secondary area.
 * - `webview`  — a standalone webview (workspace only).
 * - `mock`     — TEMPORARY streaming harness (see `../mock/README-REMOVAL.md`).
 */
export type PanelKind =
	| "chat"
	| "terminal"
	| "details"
	| "filemod"
	| "spec"
	| "git"
	| "browser"
	| "tasks"
	| "search"
	| "subagent"
	| "file"
	| "webview"
	| "plugin"
	| "mock";

/**
 * Singleton resource panels controlled by the narrator toolbar.
 *
 * `file` is excluded on purpose: a file viewer is MULTI-INSTANCE (one panel per
 * path, like `subagent`), so it never participates in the toolbar's
 * open/close/toggle single-instance vocabulary.
 */
export type ResourcePanelKind = Exclude<
	PanelKind,
	"chat" | "subagent" | "file" | "webview" | "plugin"
>;

/**
 * Params carried by a narrator-bound panel (chat + all resource panels in the
 * focus dock). Identity comes from live page context at render time; `narratorId`
 * here is only a serialization hint (see `stripIdentityFromLayout`).
 */
export interface NarratorBoundPanelParams {
	panelType: Exclude<PanelKind, "subagent" | "webview">;
	narratorId: string;
	/** Chapter id — required by the git panel; optional elsewhere. */
	chapterId?: string | null;
}

/** Params carried by a multi-instance subagent session panel. */
export interface SubagentPanelParams {
	panelType: "subagent";
	/** The child narrator rendered by this panel. This identity must be persisted. */
	subagentNarratorId: string;
	/** Owning root narrator cluster (required by workspace surfaces). */
	hostNarratorId?: string;
}

/**
 * Params carried by a read-only file viewer panel (multi-instance: one panel per
 * path). Like `subagent`, the resource identity (`filePath`) MUST survive
 * serialization — `stripIdentityFromLayout` only removes host identity
 * (narratorId / chapterId).
 */
export interface FilePanelParams {
	panelType: "file";
	/** Absolute path of the file being viewed. */
	filePath: string;
	/** Optional display-name override (defaults to the path's basename). */
	fileName?: string;
	/** Owning root narrator cluster (required by workspace surfaces). */
	hostNarratorId?: string;
}

/** Params carried by a standalone terminal panel (workspace). */
export interface StandaloneTerminalPanelParams {
	panelType: "terminal";
	terminalConfig: TerminalLeafConfig;
}

/** Params carried by a standalone webview panel (workspace). */
export interface StandaloneWebviewPanelParams {
	panelType: "webview";
	webviewConfig: WebviewLeafConfig;
}

/**
 * The full set of params any panel may carry. A discriminated union on
 * `panelType`; note `terminal` is intentionally reachable via both the
 * narrator-bound and standalone shapes (the dock binds it to a narrator, the
 * workspace binds it to a config).
 */
export type AnyPanelParams =
	| NarratorBoundPanelParams
	| SubagentPanelParams
	| FilePanelParams
	| StandaloneTerminalPanelParams
	| StandaloneWebviewPanelParams
	| PluginDockPanelParams;

/**
 * Dockview component-registry name for each kind. Kept === the kind string so
 * a single registry can serve every surface. The single-narrator focus dock
 * registers its narrator panel as `"chat"`; the multi-narrator workspace still
 * registers its own as `"narrator"` (see workspace/panel-types.ts) — the two
 * surfaces keep independent registries, so no cross-surface name migration is
 * needed.
 */
export const PANEL_COMPONENT: Record<PanelKind, string> = {
	chat: "chat",
	terminal: "terminal",
	details: "details",
	filemod: "filemod",
	spec: "spec",
	git: "git",
	browser: "browser",
	tasks: "tasks",
	search: "search",
	subagent: "subagent",
	file: "file",
	webview: "webview",
	plugin: "plugin",
	mock: "mock",
};

/** Stable dockview panel id for a per-narrator singleton tool panel. */
export function dockPanelId(kind: PanelKind): string {
	// One instance of each tool panel per focus surface; chat is the root.
	return `ndock-${kind}`;
}

/** Human-facing default title per kind (i18n applied at render time). */
export const PANEL_DEFAULT_TITLE: Record<PanelKind, string> = {
	chat: "Chat",
	terminal: "Terminal",
	details: "Details",
	filemod: "Files",
	spec: "Spec",
	git: "Git",
	browser: "Browser",
	tasks: "Tasks",
	search: "Search",
	subagent: "Subagent",
	file: "File",
	webview: "Webview",
	plugin: "Plugin",
	mock: "Mock stream",
};
