/**
 * "Open this panel in an external window" — descriptor (de)serialization and
 * the window.open call.
 *
 * A descriptor is a normalized copy of a panel's params from either dock
 * surface (the focus dock's `NarratorDockPanelParams` or the workspace's
 * `WorkspacePanelParams`), serialized into the `d` query param of
 * `/windows/panel`. The window route validates and re-renders the panel's
 * content standalone — see ./StandalonePanelWindow.tsx.
 *
 * Normalization drops surface bookkeeping (`panelRowId`), transient jump
 * requests (`highlightMessageId`/`highlightRequestId`) and anything unknown, so
 * a descriptor written by a newer/older build degrades to the fields both sides
 * understand. `mock` (the debug streaming harness) is deliberately not openable.
 */

import { assetUrl } from "@frontend/lib/base-path";
import { z } from "zod";
import type { NarratorToolPanelType } from "../narrator/dock/dock-panel-types";
import { isNarratorToolPanelType } from "../narrator/dock/dock-panel-types";
import type { KnowledgeEntryScope } from "../narrator/panels/panel-kind";
import { filePanelBaseName, PANEL_DEFAULT_TITLE } from "../narrator/panels/panel-kind";
import type { TerminalLeafConfig, WebviewLeafConfig } from "../narrator/split-tree";
import {
	isToolEditReference,
	type ToolEditReference,
} from "../narrator/tool-call/tool-edit-reference";
import {
	type PluginUiSessionContext,
	resolveCanonicalPluginUiSessionContext,
} from "../plugins/PluginUiSurfaceContext";
import {
	jsonByteLength,
	type PluginDockPanelParams,
	parsePluginDockPanelParams,
} from "../plugins/protocol";

export type PluginPanelWindowDescriptor = PluginDockPanelParams & {
	/** A host routing hint, never an authorization credential. */
	hostContext?: PluginUiSessionContext;
};

// Host IDs are platform nanoids (which may start with '-' or '_'), not plugin IDs.
const contextIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9._:-]+$/);
const pluginWindowHostContextSchema = z
	.object({
		surface: z.enum(["focus", "graph", "workspace", "director", "settings", "provider-settings"]),
		workspaceId: contextIdSchema.optional(),
		narratorId: contextIdSchema.optional(),
		chapterId: contextIdSchema.nullable().optional(),
		projectId: contextIdSchema.optional(),
		presentation: z.enum(["grid", "director"]).optional(),
	})
	.strict();

/**
 * The window-side panel vocabulary. `chat` covers both the focus dock's chat
 * panel and the workspace's `narrator` cell; `terminal` covers both the
 * narrator-bound and the workspace config-bound shapes.
 */
export type PanelWindowDescriptor =
	| { panelType: "chat"; narratorId: string; chapterId?: string | null }
	| { panelType: "terminal"; narratorId: string; chapterId?: string | null }
	| { panelType: "terminal"; terminalConfig: TerminalLeafConfig }
	| { panelType: "webview"; webviewConfig: WebviewLeafConfig }
	| {
			panelType: "narrator-tool";
			toolType: NarratorToolPanelType;
			narratorId: string;
			chapterId?: string | null;
	  }
	| {
			panelType: "subagent";
			subagentNarratorId: string;
			hostNarratorId?: string;
	  }
	| {
			panelType: "file";
			filePath: string;
			fileName?: string;
			deviceId?: string;
			fileNarratorId?: string;
			hostNarratorId?: string;
			referenceOrigin?: boolean;
			/** Confirmation belongs to this panel, not the file's resource identity. */
			largeFileConfirmed?: boolean;
			toolEdit?: ToolEditReference;
	  }
	| {
			panelType: "knowledge";
			entryId: string;
			scope: KnowledgeEntryScope;
			hostNarratorId?: string;
	  }
	| {
			panelType: Exclude<NarratorToolPanelType, "terminal" | "mock">;
			narratorId: string;
			chapterId?: string | null;
	  }
	| PluginPanelWindowDescriptor;

/** UTF-8 JSON budget shared by normalization, builders and receivers. */
export const PANEL_WINDOW_DESCRIPTOR_MAX_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strOrNull(value: unknown): string | null | undefined {
	return value === null ? null : str(value);
}

function narratorBound(
	panelType: NarratorToolPanelType,
	value: Record<string, unknown>,
): PanelWindowDescriptor | null {
	const narratorId = str(value.narratorId);
	if (!narratorId || panelType === "mock") return null;
	const chapterId = strOrNull(value.chapterId);
	const extra = chapterId !== undefined ? { chapterId } : {};
	// The split return is for TS narrowing: "terminal" and the rest are distinct
	// union members even though their shapes are identical here.
	if (panelType === "terminal") return { panelType, narratorId, ...extra };
	return { panelType, narratorId, ...extra };
}

/**
 * Validate and normalize an unknown value (raw dock params or parsed JSON) into
 * a descriptor. Returns null for anything unrecognized — callers treat that as
 * "this panel cannot be opened in a window".
 */
export function normalizePanelWindowDescriptor(value: unknown): PanelWindowDescriptor | null {
	const descriptor = normalizeDescriptor(value);
	return descriptor && jsonByteLength(descriptor) <= PANEL_WINDOW_DESCRIPTOR_MAX_BYTES
		? descriptor
		: null;
}

function normalizeDescriptor(value: unknown): PanelWindowDescriptor | null {
	if (!isRecord(value)) return null;
	const panelType = str(value.panelType);
	if (!panelType || panelType === "mock") return null;

	// The focus dock's chat and the workspace's narrator cell are the same window.
	if (panelType === "chat" || panelType === "narrator") {
		const narratorId = str(value.narratorId);
		if (!narratorId) return null;
		const chapterId = strOrNull(value.chapterId);
		return { panelType: "chat", narratorId, ...(chapterId !== undefined ? { chapterId } : {}) };
	}

	switch (panelType) {
		case "subagent": {
			const subagentNarratorId = str(value.subagentNarratorId);
			if (!subagentNarratorId) return null;
			const hostNarratorId = str(value.hostNarratorId);
			return {
				panelType: "subagent",
				subagentNarratorId,
				...(hostNarratorId ? { hostNarratorId } : {}),
			};
		}
		case "file": {
			const filePath = str(value.filePath);
			if (!filePath) return null;
			return {
				panelType: "file",
				filePath,
				...(str(value.fileName) ? { fileName: str(value.fileName) } : {}),
				...(str(value.deviceId) ? { deviceId: str(value.deviceId) } : {}),
				...(str(value.fileNarratorId) ? { fileNarratorId: str(value.fileNarratorId) } : {}),
				...(str(value.hostNarratorId) ? { hostNarratorId: str(value.hostNarratorId) } : {}),
				...(value.referenceOrigin === true ? { referenceOrigin: true } : {}),
				...(value.largeFileConfirmed === true ? { largeFileConfirmed: true } : {}),
				...(isToolEditReference(value.toolEdit) ? { toolEdit: value.toolEdit } : {}),
			};
		}
		case "knowledge": {
			const entryId = str(value.entryId);
			if (!entryId) return null;
			const hostNarratorId = str(value.hostNarratorId);
			return {
				panelType: "knowledge",
				entryId,
				scope: value.scope === "personal" ? "personal" : "global",
				...(hostNarratorId ? { hostNarratorId } : {}),
			};
		}
		case "webview": {
			const config = isRecord(value.webviewConfig) ? value.webviewConfig : null;
			const url = str(config?.url);
			if (!url) return null;
			return {
				panelType: "webview",
				webviewConfig: { url, ...(str(config?.title) ? { title: str(config?.title) } : {}) },
			};
		}
		case "terminal": {
			// Workspace shape ({ terminalConfig }) wins over the narrator-bound shape.
			if (isRecord(value.terminalConfig)) {
				const config = value.terminalConfig;
				const terminalConfig: TerminalLeafConfig = {
					...(str(config.narratorId) ? { narratorId: str(config.narratorId) } : {}),
					...(str(config.chapterId) ? { chapterId: str(config.chapterId) } : {}),
					...(str(config.cwd) ? { cwd: str(config.cwd) } : {}),
				};
				return { panelType: "terminal", terminalConfig };
			}
			return narratorBound("terminal", value);
		}
		case "narrator-tool": {
			const toolType = str(value.toolType);
			const narratorId = str(value.narratorId);
			if (!toolType || toolType === "mock" || !isNarratorToolPanelType(toolType) || !narratorId)
				return null;
			const chapterId = strOrNull(value.chapterId);
			return {
				panelType: "narrator-tool",
				toolType,
				narratorId,
				...(chapterId !== undefined ? { chapterId } : {}),
			};
		}
		case "plugin": {
			// Window-only metadata and known dock membership are not plugin params.
			// Everything else still goes through the unchanged strict plugin schema.
			const params = { ...value };
			delete params.hostContext;
			delete params.panelRowId;
			const plugin = parsePluginDockPanelParams(params);
			if (!plugin) return null;
			if (value.hostContext === undefined) return plugin;
			const context = pluginWindowHostContextSchema.safeParse(value.hostContext);
			if (!context.success) return null;
			const host = context.data;
			if ((host.surface === "focus" || host.surface === "graph") && !host.narratorId) return null;
			if ((host.surface === "workspace" || host.surface === "director") && !host.workspaceId)
				return null;
			const resolved = resolveCanonicalPluginUiSessionContext(host, plugin);
			if (!resolved || resolved.narratorId !== host.narratorId) return null;
			return { ...plugin, hostContext: host };
		}
		default:
			// Remaining kinds: the narrator-bound singleton tool panels.
			return isNarratorToolPanelType(panelType) ? narratorBound(panelType, value) : null;
	}
}

/** Legacy links may recover only identities explicitly encoded in their binding. */
export function pluginPanelWindowHostContext(
	descriptor: PluginPanelWindowDescriptor,
): PluginUiSessionContext | undefined {
	if (descriptor.hostContext) return descriptor.hostContext;
	switch (descriptor.binding.kind) {
		case "focus-current-narrator":
			return descriptor.binding.narratorId
				? { surface: "focus", narratorId: descriptor.binding.narratorId }
				: undefined;
		case "workspace":
			return { surface: "workspace", workspaceId: descriptor.binding.workspaceId };
		case "workspace-narrator":
			return {
				surface: "workspace",
				workspaceId: descriptor.binding.workspaceId,
				narratorId: descriptor.binding.ownerNarratorId,
			};
		case "global":
			return { surface: "settings" };
		case "host-surface":
			return descriptor.binding.surface === "settings" ||
				descriptor.binding.surface === "provider-settings"
				? { surface: descriptor.binding.surface }
				: undefined;
	}
}

/** Accept raw query JSON or TanStack Router's automatically decoded object. */
export function parsePanelWindowDescriptor(json: unknown): PanelWindowDescriptor | null {
	if (isRecord(json)) return normalizePanelWindowDescriptor(json);
	// Size-bound raw JSON before parsing so a hostile URL stays cheap to reject.
	if (
		typeof json !== "string" ||
		!json ||
		json.length > PANEL_WINDOW_DESCRIPTOR_MAX_BYTES ||
		new TextEncoder().encode(json).byteLength > PANEL_WINDOW_DESCRIPTOR_MAX_BYTES
	)
		return null;
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	return normalizePanelWindowDescriptor(value);
}

/** Internal Router address. Router navigation adds its basepath. */
export function buildPanelWindowHref(descriptor: PanelWindowDescriptor): string {
	const normalized = normalizePanelWindowDescriptor(descriptor);
	if (!normalized) throw new TypeError("Invalid or oversized panel window descriptor");
	const json = JSON.stringify(normalized);
	return `/windows/panel?d=${encodeURIComponent(json)}`;
}

/** Full app-mount URL for window.open / copied links. */
export function buildPanelWindowBrowserHref(descriptor: PanelWindowDescriptor): string {
	return assetUrl(buildPanelWindowHref(descriptor));
}

export const PANEL_WINDOW_FEATURES = "popup,width=1280,height=800";

/**
 * Open raw dock panel params in their own OS window. Copy semantics: the source
 * panel stays. Returns false when the params name nothing openable (callers hide
 * the menu item via `normalizePanelWindowDescriptor(...) !== null` beforehand, so
 * a false here means a race, not a user-facing error).
 *
 * Called from context-menu clicks, i.e. inside a user gesture, so the popup is
 * allowed; in an installed PWA an in-scope URL opens as another app window.
 */
export function openPanelInWindow(rawParams: unknown): boolean {
	const descriptor = normalizePanelWindowDescriptor(rawParams);
	if (!descriptor) return false;
	window.open(buildPanelWindowBrowserHref(descriptor), "_blank", PANEL_WINDOW_FEATURES);
	return true;
}

/** Non-i18n fallback title; the window replaces it with the live localized one. */
export function panelWindowTitle(descriptor: PanelWindowDescriptor): string {
	switch (descriptor.panelType) {
		case "narrator-tool":
			return PANEL_DEFAULT_TITLE[descriptor.toolType] ?? "Panel";
		case "file":
			return descriptor.fileName?.trim() || filePanelBaseName(descriptor.filePath);
		case "webview":
			return descriptor.webviewConfig.title?.trim() || descriptor.webviewConfig.url;
		case "plugin":
			return descriptor.fallback?.title?.trim() || PANEL_DEFAULT_TITLE.plugin;
		default:
			return PANEL_DEFAULT_TITLE[descriptor.panelType] ?? "Panel";
	}
}

/**
 * Where a sidebar recent tab opens in an external window, or null when the tab
 * kind has no window target (e.g. a chapter that never recorded its narrator).
 *
 * Narrator-like tabs map to the chat panel window; a workspace opens its whole
 * surface; a project opens the full app at its route (the flow graph is not a
 * panel). Structurally typed on purpose so this module stays clear of the
 * recent-tabs hooks.
 */
export function recentTabWindowHref(tab: {
	type: string;
	id: string;
	narratorId?: string;
}): string | null {
	switch (tab.type) {
		case "narrator":
		case "subagent":
			// A subagent recent tab IS a narrator session; the chat window renders it
			// directly (the "subagent" panel kind is for embedding beside its host).
			return buildPanelWindowBrowserHref({ panelType: "chat", narratorId: tab.id });
		case "chapter":
			return tab.narratorId
				? buildPanelWindowBrowserHref({
						panelType: "chat",
						narratorId: tab.narratorId,
						chapterId: tab.id,
					})
				: null;
		case "workspace":
			return assetUrl(`/windows/workspaces/${encodeURIComponent(tab.id)}`);
		case "project":
			return assetUrl(`/projects/${encodeURIComponent(tab.id)}`);
		default:
			return null;
	}
}
