/** Ruler orientation: horizontal (ticks along X) or vertical (ticks along Y) */
export type RulerOrientation = "horizontal" | "vertical";

/** Which edge the ruler is pinned to.
 *  - horizontal + start = top
 *  - horizontal + end   = bottom
 *  - vertical   + start = left
 *  - vertical   + end   = right
 */
export type RulerEdge = "start" | "end";

/** The ruler track thickness in px (same for both orientations). */
export const RULER_THICKNESS = 48;
