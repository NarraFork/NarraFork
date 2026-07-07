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

import type { Direction } from "dockview-react";

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
