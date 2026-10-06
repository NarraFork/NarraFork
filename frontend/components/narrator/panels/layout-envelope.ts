/**
 * Shared layout-envelope helpers for every dockview surface.
 *
 * Both the focus dock (localStorage) and the workspace (server `workspaces.tree`)
 * persist a small versioned envelope wrapping dockview's native
 * `SerializedDockview`. This module holds the format-agnostic pieces they share:
 *
 *   - the "panel seed" format: an ordered `PanelSpec[]` that can be built
 *     imperatively via `addPanel` when there is no live `DockviewApi` to call
 *     `toJSON()` on (e.g. when the sidebar creates a workspace from a drag).
 *     This replaces the old "write a legacy split-tree, migrate it on read"
 *     round-trip.
 *
 * The seed types are generic over the concrete panel-params vocabulary so each
 * surface can seed panels in its own params shape during the transition to a
 * fully unified vocabulary. Surface-specific persistence (which storage backend,
 * director state) stays in each surface's own module.
 */

import type { Direction, SerializedDockview } from "dockview-react";

/**
 * Remove narrator/chapter identity from every panel's serialized params.
 *
 * Panels derive their host identity from the live page context (the focus page's
 * `NarratorDockProvider`, a workspace shard, a graph node's provider), NOT from
 * serialized params, so persisting `narratorId`/`chapterId` is (a) useless and
 * (b) the source of the "open A, see B" bug: a baked id could resurface on a
 * different narrator's surface.
 *
 * Only HOST identity is removed. Resource identity — a subagent panel's
 * `subagentNarratorId`, a file panel's `filePath` — must survive serialization
 * or the panel would come back pointing at nothing.
 *
 * One-shot REQUESTS are removed for the opposite reason: a subagent panel's
 * `highlightMessageId` / `highlightRequestId` record that the reader just clicked a
 * row pointing at one message. That is true at click time only. Persisting it would
 * make every later restore of the layout re-run a jump from a previous visit, yanking
 * the reader away from wherever they had actually left the session.
 *
 * Operates on a `structuredClone`, never the live layout.
 *
 * Shared by every surface that persists a layout so the strip rule cannot drift
 * between them.
 */
export function stripIdentityFromLayout(layout: SerializedDockview): SerializedDockview {
	const clone = stripNavigationFromLayout(layout);
	const panels = (clone as { panels?: Record<string, { params?: Record<string, unknown> }> })
		.panels;
	if (panels) {
		for (const panel of Object.values(panels)) {
			if (panel?.params) {
				delete panel.params.narratorId;
				delete panel.params.chapterId;
			}
		}
	}
	return clone;
}

/** Workspace membership needs narrator ids, but no surface should replay navigation. */
export function stripNavigationFromLayout(layout: SerializedDockview): SerializedDockview {
	const clone = structuredClone(layout);
	const panels = (clone as { panels?: Record<string, { params?: Record<string, unknown> }> })
		.panels;
	for (const panel of Object.values(panels ?? {})) {
		if (!panel?.params) continue;
		delete panel.params.highlightMessageId;
		delete panel.params.highlightRequestId;
		if (panel.params.panelType === "file") delete panel.params.selection;
	}
	return clone;
}

/**
 * A serialized layout looks usable if it has at least one panel. An empty
 * envelope would restore a blank surface with no way back to the chat panel.
 */
export function isRestorableLayout(layout: SerializedDockview | undefined | null): boolean {
	if (!layout || typeof layout !== "object") return false;
	const panels = layout.panels as Record<string, unknown> | undefined;
	return !!panels && Object.keys(panels).length > 0;
}

/** Recognize only the retired tool, never unrelated file viewers. */
export function isRetiredFilemodPanel(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const panel = value as {
		component?: unknown;
		contentComponent?: unknown;
		params?: Record<string, unknown>;
	};
	return (
		panel.component === "filemod" ||
		panel.contentComponent === "filemod" ||
		panel.params?.panelType === "filemod" ||
		(panel.params?.panelType === "narrator-tool" && panel.params.toolType === "filemod")
	);
}

/** Upgrade old layouts without resetting the arrangement of surviving panels. */
export function removeRetiredFilemodPanels(layout: SerializedDockview): SerializedDockview | null {
	const dropped = new Set(
		Object.entries(layout.panels ?? {})
			.filter(([, panel]) => isRetiredFilemodPanel(panel))
			.map(([id]) => id),
	);
	if (dropped.size === 0) return isRestorableLayout(layout) ? layout : null;
	const pruned = pruneDockviewLayout(layout, dropped, { allowEmptyGrid: true });
	return isRestorableLayout(pruned) ? pruned : null;
}

/** A panel to (re)create when building a layout imperatively (no live api). */
export interface PanelSpec<P> {
	id: string;
	params: P;
	title: string;
	/** How to place this panel relative to a previously-added one. */
	placement: { kind: "first" } | { kind: "relative"; referenceId: string; direction: Direction };
}

/**
 * A seed envelope: a portable, api-free description of an initial layout.
 * Persisted when a surface is created before any `DockviewApi` exists; the
 * mounting surface materialises it via `addPanel` and immediately re-serializes
 * to the native dockview envelope on first layout change.
 */
export interface SeedEnvelope<P> {
	kind: "seed";
	seed: PanelSpec<P>[];
}

/** Serialize a seed envelope to a JSON string (for `workspaces.tree`). */
export function serializeSeedEnvelope<P>(envelope: SeedEnvelope<P>): string {
	return JSON.stringify(envelope);
}

/** Type guard: does this parsed value look like a seed envelope? */
export function isSeedEnvelope(value: unknown): value is SeedEnvelope<unknown> {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return v.kind === "seed" && Array.isArray(v.seed);
}

/**
 * Prune panel references in every Dockview location on a clone of the layout.
 * Membership restore falls back to its member list when the main grid is empty.
 * Serialization may instead keep a legal empty root (including float-only layouts).
 */
export function pruneDockviewLayout(
	layout: SerializedDockview,
	dropped: ReadonlySet<string>,
	options: { allowEmptyGrid?: boolean; activeGroup?: string | null } = {},
): SerializedDockview | null {
	let clone: SerializedDockview;
	try {
		clone = structuredClone(layout);
	} catch {
		return null;
	}

	const panels = clone.panels;
	if (!panels || !clone.grid?.root) return null;
	for (const panelId of dropped) delete panels[panelId];
	const keptPanels = new Set(Object.keys(panels));
	const groupIds = new Set<string>();

	const pruneGroup = (value: unknown): Record<string, unknown> | null => {
		if (!value || typeof value !== "object") return null;
		const group = value as Record<string, unknown>;
		const views = Array.isArray(group.views)
			? group.views.filter((id): id is string => typeof id === "string" && keptPanels.has(id))
			: [];
		if (views.length === 0) return null;
		group.views = views;
		if (typeof group.activeView !== "string" || !views.includes(group.activeView)) {
			group.activeView = views[0];
		}
		if (Array.isArray(group.tabGroups)) {
			group.tabGroups = group.tabGroups.filter((value) => {
				if (!value || typeof value !== "object") return false;
				const tabGroup = value as Record<string, unknown>;
				tabGroup.panelIds = Array.isArray(tabGroup.panelIds)
					? tabGroup.panelIds.filter((id) => views.includes(id))
					: [];
				return (tabGroup.panelIds as unknown[]).length > 0;
			});
		}
		if (typeof group.id === "string") groupIds.add(group.id);
		return group;
	};

	const pruneNode = (value: unknown): unknown | null => {
		if (!value || typeof value !== "object") return null;
		const node = value as Record<string, unknown>;
		if (node.type === "branch" && Array.isArray(node.data)) {
			node.data = node.data.map(pruneNode).filter((child) => child !== null);
			return (node.data as unknown[]).length > 0 ? node : null;
		}
		if (node.type !== "leaf") return null;
		const group = pruneGroup(node.data);
		if (!group) return null;
		node.data = group;
		return node;
	};

	const root = pruneNode(clone.grid.root);
	if (!root && !options.allowEmptyGrid) return null;
	clone.grid.root = (root ?? { type: "branch", data: [] }) as typeof clone.grid.root;

	// Both window forms are native Dockview formats: legacy single-group `data`
	// and a nested `grid`. Never discard persistent floating windows wholesale.
	const pruneWindows = <T extends { data?: unknown; grid?: { root: unknown } }>(
		windows: T[],
	): T[] =>
		windows.filter((window) => {
			if (window.grid) {
				const root = pruneNode(window.grid.root);
				if (!root) return false;
				window.grid.root = root;
				return true;
			}
			const group = pruneGroup(window.data);
			if (!group) return false;
			window.data = group;
			return true;
		});
	if (clone.floatingGroups) clone.floatingGroups = pruneWindows(clone.floatingGroups);
	if (clone.popoutGroups) clone.popoutGroups = pruneWindows(clone.popoutGroups);
	if (clone.edgeGroups) {
		for (const position of ["top", "bottom", "left", "right"] as const) {
			const edge = clone.edgeGroups[position];
			if (!edge) continue;
			const group = pruneGroup(edge.group);
			if (group) edge.group = group;
			else delete clone.edgeGroups[position];
		}
	}
	for (const window of clone.popoutGroups ?? []) {
		if (window.gridReferenceGroup && !groupIds.has(window.gridReferenceGroup)) {
			delete window.gridReferenceGroup;
		}
	}

	// Insertion order prefers the fixed grid when temporary focus disappeared.
	const activeGroup = options.activeGroup === undefined ? clone.activeGroup : options.activeGroup;
	if (activeGroup && groupIds.has(activeGroup)) clone.activeGroup = activeGroup;
	else {
		const fallback = groupIds.values().next().value;
		if (fallback) clone.activeGroup = fallback;
		else delete clone.activeGroup;
	}
	return clone;
}
