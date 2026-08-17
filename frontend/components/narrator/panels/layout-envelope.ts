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
	const clone = structuredClone(layout) as SerializedDockview;
	const panels = (clone as { panels?: Record<string, { params?: Record<string, unknown> }> })
		.panels;
	if (panels) {
		for (const panel of Object.values(panels)) {
			if (panel?.params) {
				delete panel.params.narratorId;
				delete panel.params.chapterId;
				delete panel.params.highlightMessageId;
				delete panel.params.highlightRequestId;
			}
		}
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
