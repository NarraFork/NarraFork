/**
 * Workspace layout persistence + legacy migration for the Dockview-based workspace.
 *
 * The workspace row stores a JSON string in `workspaces.tree`. Historically this
 * was a NarraFork split-tree (`{ tree, presentation }`). We now persist Dockview's
 * native `SerializedDockview` wrapped with a small envelope so we can:
 *   - version the format,
 *   - carry NarraFork-specific presentation state (director mode),
 *   - detect + migrate legacy split-tree payloads on load.
 */

import type { Direction, DockviewApi, SerializedDockview } from "dockview-react";
import {
	getAllLeaves,
	leafPanelType,
	parseWorkspaceLayout,
	type SplitBranch,
	type SplitLeaf,
	type SplitNode,
} from "../split-tree";
import { PANEL_COMPONENT, type WorkspacePanelParams } from "./panel-types";

/** Current envelope schema version. */
export const WORKSPACE_LAYOUT_VERSION = 2 as const;

export type WorkspaceDirectorState = {
	mode: "grid" | "director";
	/** Panel id promoted to primary in director mode. */
	primaryPanelId: string | null;
};

export const DEFAULT_DIRECTOR_STATE: WorkspaceDirectorState = {
	mode: "grid",
	primaryPanelId: null,
};

/** Versioned envelope persisted to `workspaces.tree`. */
export interface WorkspaceLayoutEnvelope {
	version: typeof WORKSPACE_LAYOUT_VERSION;
	kind: "dockview";
	layout: SerializedDockview;
	director: WorkspaceDirectorState;
}

/** A panel to (re)create when there is no valid Dockview layout to restore. */
export interface PanelSpec {
	id: string;
	params: WorkspacePanelParams;
	title: string;
	/** How to place this panel relative to the previously-added one. */
	placement: { kind: "first" } | { kind: "relative"; referenceId: string; direction: Direction };
}

/** Result of resolving a stored tree string into something we can render. */
export type ResolvedLayout =
	| { kind: "dockview"; layout: SerializedDockview; director: WorkspaceDirectorState }
	| { kind: "panels"; panels: PanelSpec[]; director: WorkspaceDirectorState };

// ── Serialization ──

/** Serialize the current Dockview layout + director state into the envelope string. */
export function serializeWorkspaceLayout(
	api: DockviewApi,
	director: WorkspaceDirectorState,
): string {
	const envelope: WorkspaceLayoutEnvelope = {
		version: WORKSPACE_LAYOUT_VERSION,
		kind: "dockview",
		layout: api.toJSON(),
		director,
	};
	return JSON.stringify(envelope);
}

// ── Resolution / migration ──

/** Type guard: does this parsed value look like a Dockview envelope? */
function isDockviewEnvelope(value: unknown): value is WorkspaceLayoutEnvelope {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.kind === "dockview" && !!v.layout && typeof v.layout === "object";
}

/** Type guard: does this look like a raw SerializedDockview (grid + panels)? */
function isSerializedDockview(value: unknown): value is SerializedDockview {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return !!v.grid && typeof v.grid === "object" && !!v.panels && typeof v.panels === "object";
}

/**
 * Resolve a stored tree string into a renderable layout.
 *
 * Order of precedence:
 *   1. Dockview envelope (current format) → restore verbatim.
 *   2. Raw SerializedDockview (defensive) → wrap with default director state.
 *   3. Legacy split-tree → migrate into a panel list ("extract & re-arrange").
 *   4. Anything else / parse failure → empty panel list.
 */
export function resolveWorkspaceLayout(treeJson: string | null | undefined): ResolvedLayout {
	if (treeJson) {
		try {
			const parsed = JSON.parse(treeJson);
			if (isDockviewEnvelope(parsed)) {
				return {
					kind: "dockview",
					layout: parsed.layout,
					director: normalizeDirector(parsed.director),
				};
			}
			if (isSerializedDockview(parsed)) {
				return { kind: "dockview", layout: parsed, director: DEFAULT_DIRECTOR_STATE };
			}
		} catch {
			// fall through to legacy handling
		}
	}

	// Legacy split-tree (or empty) → extract panels and re-arrange.
	const legacy = parseWorkspaceLayout(treeJson ?? "");
	const panels = migrateLegacyTree(legacy.tree);
	return { kind: "panels", panels, director: DEFAULT_DIRECTOR_STATE };
}

function normalizeDirector(value: unknown): WorkspaceDirectorState {
	if (!value || typeof value !== "object") return { ...DEFAULT_DIRECTOR_STATE };
	const v = value as Record<string, unknown>;
	return {
		mode: v.mode === "director" ? "director" : "grid",
		primaryPanelId: typeof v.primaryPanelId === "string" ? v.primaryPanelId : null,
	};
}

let panelIdCounter = 0;
function nextPanelId(): string {
	panelIdCounter += 1;
	return `dvp_${Date.now().toString(36)}_${panelIdCounter}`;
}

/** Convert a legacy split-tree leaf into panel params (or null if unusable). */
function leafToParams(leaf: SplitLeaf): { params: WorkspacePanelParams; title: string } | null {
	const type = leafPanelType(leaf);
	if (type === "terminal" && leaf.terminalConfig) {
		return {
			params: { panelType: "terminal", terminalConfig: leaf.terminalConfig },
			title: "Terminal",
		};
	}
	if (type === "webview" && leaf.webviewConfig) {
		return {
			params: { panelType: "webview", webviewConfig: leaf.webviewConfig },
			title: leaf.webviewConfig.title || leaf.webviewConfig.url || "Webview",
		};
	}
	if (type === "narrator" && leaf.narratorId) {
		return {
			params: { panelType: "narrator", narratorId: leaf.narratorId },
			title: "Narrator",
		};
	}
	return null;
}

/**
 * Migrate a legacy split-tree into an ordered list of PanelSpec.
 *
 * We preserve coarse split structure: the first leaf becomes the root panel,
 * and each subsequent leaf is placed relative to the previous panel using the
 * direction implied by its nearest branch (`horizontal` → right, `vertical` →
 * below). Exact size ratios are intentionally dropped (per migration decision).
 */
export function migrateLegacyTree(tree: SplitNode): PanelSpec[] {
	const specs: PanelSpec[] = [];
	let previousId: string | null = null;

	const walk = (node: SplitNode, dirFromParent: Direction) => {
		if (node.type === "leaf") {
			const resolved = leafToParams(node);
			if (!resolved) return;
			const id = nextPanelId();
			specs.push({
				id,
				params: resolved.params,
				title: resolved.title,
				placement:
					previousId === null
						? { kind: "first" }
						: { kind: "relative", referenceId: previousId, direction: dirFromParent },
			});
			previousId = id;
			return;
		}
		const branch = node as SplitBranch;
		const childDir: Direction = branch.direction === "horizontal" ? "right" : "below";
		branch.children.forEach((child, idx) => {
			// First child inherits the branch's own placement direction; siblings
			// stack along the branch's split axis.
			walk(child, idx === 0 ? dirFromParent : childDir);
		});
	};

	walk(tree, "right");
	return specs;
}

/**
 * Apply a resolved layout to a fresh DockviewApi.
 * For the "panels" case we build the layout imperatively via addPanel.
 */
export function applyResolvedLayout(api: DockviewApi, resolved: ResolvedLayout): void {
	if (resolved.kind === "dockview") {
		api.fromJSON(resolved.layout);
		return;
	}
	for (const spec of resolved.panels) {
		api.addPanel({
			id: spec.id,
			component: componentForParams(spec.params),
			title: spec.title,
			params: spec.params,
			position:
				spec.placement.kind === "relative"
					? {
							referencePanel: spec.placement.referenceId,
							direction: spec.placement.direction,
						}
					: undefined,
		});
	}
}

/** Map panel params to the registered Dockview component name. */
export function componentForParams(params: WorkspacePanelParams): string {
	switch (params.panelType) {
		case "terminal":
			return PANEL_COMPONENT.terminal;
		case "webview":
			return PANEL_COMPONENT.webview;
		default:
			return PANEL_COMPONENT.narrator;
	}
}

/** Collect the narrator ids currently present in a resolved/legacy layout. */
export function collectNarratorIdsFromTree(treeJson: string | null | undefined): string[] {
	const legacy = parseWorkspaceLayout(treeJson ?? "");
	return getAllLeaves(legacy.tree)
		.filter((l) => leafPanelType(l) === "narrator" && l.narratorId)
		.map((l) => l.narratorId as string);
}

// ── Pending-panel handoff ──
// Lets the sidebar (or other callers) request that a panel be added to a
// workspace without knowing anything about the Dockview layout format. The
// DockviewWorkspace instance drains these when it mounts / becomes active.

const pendingPanels = new Map<string, WorkspacePanelParams[]>();
const pendingListeners = new Map<string, Set<() => void>>();

/** Queue a panel to be added to a workspace the next time it is (re)opened. */
export function queuePendingPanel(workspaceId: string, params: WorkspacePanelParams): void {
	const list = pendingPanels.get(workspaceId) ?? [];
	list.push(params);
	pendingPanels.set(workspaceId, list);
	// Notify any mounted workspace instance so it can drain immediately.
	for (const fn of pendingListeners.get(workspaceId) ?? []) fn();
}

/** Drain and return any panels queued for a workspace. */
export function drainPendingPanels(workspaceId: string): WorkspacePanelParams[] {
	const list = pendingPanels.get(workspaceId) ?? [];
	pendingPanels.delete(workspaceId);
	return list;
}

/** Subscribe to pending-panel additions for a workspace; returns an unsubscribe. */
export function onPendingPanel(workspaceId: string, fn: () => void): () => void {
	const set = pendingListeners.get(workspaceId) ?? new Set();
	set.add(fn);
	pendingListeners.set(workspaceId, set);
	return () => {
		set.delete(fn);
		if (set.size === 0) pendingListeners.delete(workspaceId);
	};
}
