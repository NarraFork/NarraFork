import { createContext, useContext } from "react";

/**
 * Render detail level for the narrator message list.
 * Higher number = more detail. Internal/design use only — never shown in the UI.
 *
 *  L6 (most detailed): all tool cards expanded, reasoning expanded, full text
 *  L5 (default): only the most recent two assistant run-segments expanded; earlier collapsed to headers
 *  L4: all tool cards collapsed to headers; reasoning as title list
 *  L3: a tool-run folds into a "tool calls ×N" summary block (like the reasoning trace)
 *  L2: reasoning and completed tool calls merge into a visible activity trace; full text
 *  L1 (simplest): the merged activity trace starts collapsed; long assistant text is clamped
 */
export type RenderLod = 1 | 2 | 3 | 4 | 5 | 6;

export const MIN_RENDER_LOD: RenderLod = 1;
export const MAX_RENDER_LOD: RenderLod = 6;
export const DEFAULT_RENDER_LOD: RenderLod = 5;

export interface RenderLodValue {
	lod: RenderLod;
	/**
	 * Whether the rendered content is interactive (hover toolbars, swipe menus,
	 * context menus, block selection, toggles). Read-only / preview surfaces set
	 * this to false. Orthogonal to `lod` — preview is about interaction, not detail.
	 */
	interactive: boolean;
}

const DEFAULT_VALUE: RenderLodValue = { lod: DEFAULT_RENDER_LOD, interactive: true };

export const RenderLodCtx = createContext<RenderLodValue>(DEFAULT_VALUE);

/** Clamp an arbitrary number into the valid RenderLod range. */
export function clampRenderLod(value: number): RenderLod {
	const rounded = Math.round(value);
	if (rounded < MIN_RENDER_LOD) return MIN_RENDER_LOD;
	if (rounded > MAX_RENDER_LOD) return MAX_RENDER_LOD;
	return rounded as RenderLod;
}

/** Current detail level (1 = simplest, 6 = most detailed). */
export function useRenderLod(): RenderLod {
	return useContext(RenderLodCtx).lod;
}

/** Whether the current render surface allows interaction. */
export function useRenderInteractive(): boolean {
	return useContext(RenderLodCtx).interactive;
}
