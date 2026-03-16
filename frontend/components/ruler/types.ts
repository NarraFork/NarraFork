/** Ruler orientation: horizontal (ticks along X) or vertical (ticks along Y) */
export type RulerOrientation = "horizontal" | "vertical";

/** Which edge the ruler is pinned to.
 *  - horizontal + start = top
 *  - horizontal + end   = bottom
 *  - vertical   + start = left
 *  - vertical   + end   = right
 */
export type RulerEdge = "start" | "end";

/** Default (minimum) ruler track thickness in px. */
export const DEFAULT_RULER_THICKNESS = 72;

/** Maximum ruler track thickness when dragged open. */
export const MAX_RULER_THICKNESS = 200;
