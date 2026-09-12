/**
 * Panel type definitions for the single-narrator dock surface.
 *
 * These names are now thin aliases over the unified vocabulary in
 * `../panels/panel-kind.ts` (kept for backward-compatible imports across the
 * dock). New code should prefer `PanelKind` / `AnyPanelParams` directly.
 */

import type { PluginDockPanelParams } from "../../plugins/protocol";
import {
	type FilePanelParams,
	type KnowledgePanelParams,
	type NarratorBoundPanelParams,
	PANEL_COMPONENT,
	PANEL_DEFAULT_TITLE,
	type PanelKind,
	type ResourcePanelKind,
	type SubagentPanelParams,
	dockPanelId as sharedDockPanelId,
} from "../panels/panel-kind";
import { type ToolEditReference, toolEditReferenceKey } from "../tool-call/tool-edit-reference";

/** Panel type discriminator stored on each dockview panel's params. */
export type NarratorDockPanelType = Exclude<PanelKind, "webview">;

/** All tool panels (everything except the primary chat panel). */
export type NarratorToolPanelType = ResourcePanelKind;

/** Params carried by every focus-dock panel. */
export type NarratorDockPanelParams =
	| NarratorBoundPanelParams
	| SubagentPanelParams
	| FilePanelParams
	| KnowledgePanelParams
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
	userchat: PANEL_COMPONENT.userchat,
	appearance: PANEL_COMPONENT.appearance,
	filetree: PANEL_COMPONENT.filetree,
	subagent: PANEL_COMPONENT.subagent,
	file: PANEL_COMPONENT.file,
	knowledge: PANEL_COMPONENT.knowledge,
	plugin: PANEL_COMPONENT.plugin,
	mock: PANEL_COMPONENT.mock,
};

/** Stable dockview panel id for a singleton panel type within one narrator surface. */
export function dockPanelId(
	type: Exclude<NarratorDockPanelType, "subagent" | "file" | "knowledge">,
): string {
	return sharedDockPanelId(type);
}

/** Stable multi-instance panel id for one child narrator session. */
export function subagentDockPanelId(subagentNarratorId: string): string {
	return `ndock-subagent-${subagentNarratorId}`;
}

/**
 * Deterministic FNV-1a hash of a file path, used to build a safe dockview panel
 * id.
 *
 * A file path contains `/`, spaces and non-ASCII characters and can be very
 * long, so it is never embedded in a panel id verbatim — the original path lives
 * in the panel's `params.filePath`. Exported so the workspace surface can build
 * its own namespaced ids with the SAME hash (a mismatch would let one file open
 * twice on the same surface).
 */
export function hashFilePath(filePath: string): string {
	// FNV-1a (32-bit), kept in unsigned range via Math.imul + >>> 0.
	let hash = 0x811c9dc5;
	for (let i = 0; i < filePath.length; i++) {
		hash ^= filePath.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	// Mix in the length so two paths that collide on the rolling hash are still
	// distinguished by size (cheap, and paths differ in length far more often).
	return `${hash.toString(36)}${filePath.length.toString(36)}`;
}

/** Keep host legacy ids; live cross-session reads differ, historical refs retain their own identity. */
export function filePanelIdentity(
	filePath: string,
	deviceId = "local",
	toolEdit?: ToolEditReference,
	fileNarratorId?: string,
): string {
	if (toolEdit) {
		return `history-${hashFilePath(JSON.stringify([deviceId, filePath, toolEditReferenceKey(toolEdit)]))}`;
	}
	if (fileNarratorId) {
		return `session-${hashFilePath(JSON.stringify([fileNarratorId, deviceId, filePath]))}`;
	}
	return deviceId === "local"
		? hashFilePath(filePath)
		: `remote-${hashFilePath(JSON.stringify([deviceId, filePath]))}`;
}

/** Stable multi-instance panel id for one read-only file viewer. */
export function fileDockPanelId(
	filePath: string,
	deviceId = "local",
	toolEdit?: ToolEditReference,
	fileNarratorId?: string,
): string {
	return `ndock-file-${filePanelIdentity(filePath, deviceId, toolEdit, fileNarratorId)}`;
}

/**
 * Stable multi-instance panel id for one knowledge entry viewer/editor. The
 * entryId is a nanoid (safe characters, bounded length), so it is embedded
 * directly without hashing.
 */
export function knowledgeDockPanelId(entryId: string): string {
	return `ndock-knowledge-${entryId}`;
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
	userchat: PANEL_DEFAULT_TITLE.userchat,
	appearance: PANEL_DEFAULT_TITLE.appearance,
	filetree: PANEL_DEFAULT_TITLE.filetree,
	subagent: PANEL_DEFAULT_TITLE.subagent,
	file: PANEL_DEFAULT_TITLE.file,
	knowledge: PANEL_DEFAULT_TITLE.knowledge,
	plugin: PANEL_DEFAULT_TITLE.plugin,
	mock: PANEL_DEFAULT_TITLE.mock,
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
	"userchat",
	"appearance",
	"filetree",
	// TEMPORARY: the streaming harness participates in the toolbar's
	// open/close/toggle vocabulary so its button can show active state.
	// Removed together with `../mock/` (see its README-REMOVAL.md).
	"mock",
]);

/** Runtime guard used when scanning serialized/live dock panels. */
export function isNarratorToolPanelType(value: unknown): value is NarratorToolPanelType {
	return typeof value === "string" && NARRATOR_TOOL_PANEL_TYPES.has(value);
}
