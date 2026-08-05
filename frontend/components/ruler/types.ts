/** Ruler orientation: horizontal (ticks along X) or vertical (ticks along Y) */
export type RulerOrientation = "horizontal" | "vertical";

/** Which edge the ruler is pinned to.
 *  - horizontal + start = top
 *  - horizontal + end   = bottom
 *  - vertical   + start = left
 *  - vertical   + end   = right
 */
export type RulerEdge = "start" | "end";

/**
 * The chapter fields SegmentCanvas hands to RulerFlow for Pixi rendering.
 *
 * Previously this shape was written out inline at every producer and consumer,
 * which made it easy to add a field in one place and silently drop it in the
 * next. Keep it here so the layout/render chain shares a single definition.
 */
export interface RulerPixiChapterPayload {
	id: string;
	status: string;
	title: string;
	branch: string;
	role: string;
	parentChapterId?: string | null;
	narratorId: string | null;
	narratorStatus: string | null;
	/**
	 * Narrator is parked until an unavailable model recovers. Carried separately
	 * from `narratorStatus` (which stays `"waiting"`) because the Pixi card draws
	 * and measures the status string as raw text. Drives color plus offscreen
	 * bubble suppression only.
	 */
	narratorModelUnavailable?: boolean;
	reviewStatus?: string | null;
	startCommitSha: string | null;
	mergeCommitSha?: string | null;
	layoutX: number;
	layoutY: number;
}

/** Default (minimum) ruler track thickness in px. */
export const DEFAULT_RULER_THICKNESS = 72;

/** Maximum ruler track thickness when dragged open. */
export const MAX_RULER_THICKNESS = 200;
