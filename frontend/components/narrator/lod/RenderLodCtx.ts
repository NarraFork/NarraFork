import { createContext, useContext } from "react";

/**
 * Render detail level for the narrator message list.
 * Higher number = more detail. Internal/design use only — never shown in the UI.
 *
 * The scale is upstream's five steps, unchanged and in upstream order:
 *
 *  L5 (most detailed): all tool cards expanded, full text
 *  L4 (default): only the most recent two assistant run-segments expanded; earlier collapsed to headers
 *  L3: all tool cards collapsed to headers
 *  L2: reasoning and completed tool calls merge into a visible activity trace; full text
 *  L1 (simplest): the merged activity trace starts collapsed; long assistant text is clamped
 *
 * Round folding is NOT a step on this scale. It used to have its own top level (a
 * sixth, "all expanded" step) which made the control read as six notches against
 * upstream's five, and left the reader unable to fold at L5 or unfold at L1.
 * It is now an independent switch (`narrafork_round_folding`) that works at every
 * level, because "do I want to see the process of finished rounds" is a different
 * question from "how much detail do I want inside each row".
 *
 * Reasoning is level-INDEPENDENT in shape: a structured reasoning run is always a
 * step trace whose rows expand to that step's markdown on click (at L1/L2 those
 * rows live inside the merged activity trace, at L3+ in their own trace). There is
 * no "titles only, body never expands" level — a reader who sees a step title can
 * always open it.
 */
export type RenderLod = 1 | 2 | 3 | 4 | 5;

export const MIN_RENDER_LOD: RenderLod = 1;
export const MAX_RENDER_LOD: RenderLod = 5;
export const DEFAULT_RENDER_LOD: RenderLod = 4;

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

/** Current detail level (1 = simplest, 5 = most detailed). */
export function useRenderLod(): RenderLod {
	return useContext(RenderLodCtx).lod;
}

/** Whether the current render surface allows interaction. */
export function useRenderInteractive(): boolean {
	return useContext(RenderLodCtx).interactive;
}
