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

import type { FileSelection } from "@shared/file-reference";
import { localFileDirectory } from "@shared/markdown-file-path";
import type { PluginDockPanelParams } from "../../plugins/protocol";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../split-tree";
import { isToolEditReference, type ToolEditReference } from "../tool-edit-reference";

/**
 * Every panel kind that can appear on any surface.
 *
 * - `chat`     — the primary narrator panel (a cluster's protagonist).
 * - `terminal` — a terminal; narrator-bound in the dock, config-bound in a workspace.
 * - `details` / `filemod` / `spec` / `git` / `browser` / `tasks` / `search` — singleton narrator resources.
 * - `userchat` — the human discussion room beside this narrator (people talking to
 *   each other; its content never enters the narrator's context unless someone
 *   forwards it explicitly).
 * - `appearance` — live typography controls for this transcript (font size / letter
 *   spacing / block spacing), so the reader can adjust while watching the effect.
 * - `subagent` — a multi-instance child-narrator session in the cluster's secondary area.
 * - `file`     — a multi-instance read-only file viewer in the secondary area.
 * - `filetree` — a singleton browser of the narrator's cwd, which opens `file` panels.
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
	| "userchat"
	| "appearance"
	| "filetree"
	| "subagent"
	| "file"
	| "knowledge"
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
	"chat" | "subagent" | "file" | "knowledge" | "webview" | "plugin"
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
	/**
	 * Scroll to and flash this message once the panel mounts.
	 *
	 * A REQUEST, not state: it records "the reader clicked a row that points here",
	 * which is true at click time and meaningless later. Both this and
	 * `highlightRequestId` are therefore stripped before a layout is persisted
	 * (`stripIdentityFromLayout`) — restoring a saved layout must reopen the session
	 * where the reader left it, not re-run a jump from a previous visit.
	 */
	highlightMessageId?: string;
	/**
	 * Distinguishes one jump request from the next.
	 *
	 * The panel latches its jump per (narrator, target) so it fires once rather than
	 * on every re-render. That latch is also what breaks a repeat click: the reader
	 * scrolls away, clicks the same speaker row again, and the target is unchanged —
	 * so the jump is skipped and the control looks broken. A fresh token per click
	 * makes the second request a distinct one.
	 */
	highlightRequestId?: string;
}

/**
 * A fresh token for one panel-jump request. Monotonic within a page session, which
 * is all the latch needs (it only ever compares for equality).
 */
let highlightRequestSeq = 0;
export function nextHighlightRequestId(): string {
	highlightRequestSeq += 1;
	return `h${highlightRequestSeq}`;
}

/**
 * Params carried by a read-only file viewer panel (multi-instance: one panel per
 * path). Like `subagent`, the resource identity (`filePath`) MUST survive
 * serialization — `stripIdentityFromLayout` only removes host identity
 * (narratorId / chapterId).
 */
/** Navigation is transient; device/path and toolEdit are persisted resource identity. */
export interface FileOpenOptions {
	deviceId?: string;
	/** Historical edit identity; never replace this resource with the current disk file. */
	toolEdit?: ToolEditReference;
	/** Sticky read boundary: references cannot fall back to legacy filesystem routes. */
	referenceOrigin?: boolean;
	selection?: FileSelection;
	highlightRequestId?: string;
}

export interface FilePanelParams extends FileOpenOptions {
	panelType: "file";
	/** Absolute path of the file being viewed. */
	filePath: string;
	/** Optional display-name override (defaults to the path's basename). */
	fileName?: string;
	/** Owning root narrator cluster (required by workspace surfaces). */
	hostNarratorId?: string;
}

/** Use the shared dirname grammar on raw target paths; POSIX backslashes are filename bytes. */
export function filePanelBaseName(filePath: string): string {
	const directory = localFileDirectory(filePath);
	if (directory === "." && !filePath.startsWith("./")) return filePath;
	// Windows normalization changes separator characters, not their UTF-16 length.
	const separator = filePath[directory.length];
	const start = directory.length + (separator === "/" || separator === "\\" ? 1 : 0);
	return filePath.slice(start) || filePath;
}

/** Graph drag payloads historically carried a plain local path. Keep that form local-only. */
export function filePanelResourceId(
	filePath: string,
	deviceId = "local",
	referenceOrigin = false,
	toolEdit?: ToolEditReference,
): string {
	if (toolEdit) return JSON.stringify([deviceId, filePath, referenceOrigin, toolEdit]);
	if (referenceOrigin) return JSON.stringify([deviceId, filePath, true]);
	return deviceId === "local" ? filePath : JSON.stringify([deviceId, filePath]);
}

/** Decode a device-scoped drag identity without guessing the current/default device. */
export function filePanelResourceParams(
	resourceId: string,
): Pick<FilePanelParams, "filePath" | "deviceId" | "referenceOrigin" | "toolEdit"> {
	if (resourceId.startsWith("[")) {
		try {
			const value: unknown = JSON.parse(resourceId);
			if (
				Array.isArray(value) &&
				(value.length === 2 ||
					(value.length === 3 && value[2] === true) ||
					(value.length === 4 && typeof value[2] === "boolean" && isToolEditReference(value[3]))) &&
				typeof value[0] === "string" &&
				typeof value[1] === "string"
			) {
				return {
					deviceId: value[0],
					filePath: value[1],
					...(value[2] === true ? { referenceOrigin: true } : {}),
					...(value.length === 4 ? { toolEdit: value[3] as ToolEditReference } : {}),
				};
			}
		} catch {
			// Old local paths are not JSON.
		}
	}
	return { filePath: resourceId, deviceId: "local" };
}

/**
 * Scope discriminator for knowledge entry panels. `"global"` entries are in the
 * shared base (read via `useKnowledgeEntry`, write via `useAddKnowledgeRevision`).
 * `"personal"` entries belong to the caller's personal library (read via
 * `usePersonalEntry`, write via `useUpdatePersonalEntryContent`).
 */
export type KnowledgeEntryScope = "global" | "personal";

/**
 * Params carried by a knowledge entry panel (multi-instance: one panel per
 * entry). Like `subagent` and `file`, the resource identity (`entryId`) MUST
 * survive serialization — `stripIdentityFromLayout` only removes host identity.
 */
export interface KnowledgePanelParams {
	panelType: "knowledge";
	/** The knowledge entry id (global or personal). */
	entryId: string;
	/** Scope determines which hooks and permission rules are used. */
	scope: KnowledgeEntryScope;
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
	| KnowledgePanelParams
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
	userchat: "userchat",
	appearance: "appearance",
	filetree: "filetree",
	subagent: "subagent",
	file: "file",
	knowledge: "knowledge",
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
	userchat: "Discussion",
	appearance: "Appearance",
	filetree: "Files",
	subagent: "Subagent",
	file: "File",
	knowledge: "Knowledge",
	webview: "Webview",
	plugin: "Plugin",
	mock: "Mock stream",
};
