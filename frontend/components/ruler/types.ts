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
	/**
	 * Backbone commit the merge connector is drawn to.
	 *
	 * Falls back to the target's pre-merge HEAD for a commit-free merge, which
	 * produces no merge commit at all — anchoring on `mergeCommitSha` alone made
	 * those chapters draw no connector and read as never merged.
	 */
	mergeAnchorCommitSha?: string | null;
	/**
	 * Snapshot holding uncommitted work an earlier rebase parked and could not put back.
	 *
	 * Carried through the layout chain because the recovery panel used to exist only in
	 * the rebase response: a reload erased it while the server still refused the next
	 * rebase with `REBASE_PARKED_WORK_CONFLICT`, leaving no UI able to act on the work.
	 */
	parkedSnapshot?: string | null;
	layoutX: number;
	layoutY: number;
}

/** Default (minimum) ruler track thickness in px. */
export const DEFAULT_RULER_THICKNESS = 72;

/** Maximum ruler track thickness when dragged open. */
export const MAX_RULER_THICKNESS = 200;
