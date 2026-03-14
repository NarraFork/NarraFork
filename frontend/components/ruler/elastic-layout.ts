/**
 * Elastic spacing engine for the ruler.
 *
 * tick.x is scale-independent — it only depends on commit index and
 * which segments are expanded. Scale is applied purely via CSS transform.
 */

import type { RulerSegment } from "../../hooks/useRuler";

export interface TickPosition {
	/** Index in the commits array */
	index: number;
	/** Computed X coordinate (scale-independent world space) */
	x: number;
	/** The commit SHA */
	sha: string;
	/** The segment starting at this tick (if any) */
	segment?: RulerSegment;
}

export interface ElasticLayout {
	/** Position of each commit tick */
	ticks: TickPosition[];
	/** Total width of the ruler (scale-independent world space) */
	totalWidth: number;
}

/** Fixed gap between ticks in collapsed state (world-space pixels) */
export const COLLAPSED_GAP = 80;

const CARD_SLOT = 236; // 220 card + 16 gap
const PADDING = 40;

/**
 * Compute the expanded segment size based on chapter count and panel state.
 */
function computeExpandedSize(params: {
	chapterCount: number;
	hasOpenPanel: boolean;
	openPanelWidth: number;
}): number {
	const { chapterCount, hasOpenPanel, openPanelWidth } = params;

	if (hasOpenPanel) {
		return Math.max(openPanelWidth + CARD_SLOT + PADDING, 500);
	}

	let cols: number;
	if (chapterCount <= 3) cols = chapterCount;
	else if (chapterCount <= 8) cols = 4;
	else cols = 5;

	return Math.max(400, cols * CARD_SLOT + PADDING);
}

/**
 * Compute tick positions with elastic spacing.
 * All segments are always expanded — there is no collapsed/expanded toggle.
 * tick.x is scale-independent.
 */
export function computeElasticLayout(
	commitShas: string[],
	segments: RulerSegment[],
): ElasticLayout {
	const segmentBySha = new Map<string, RulerSegment>();
	for (const seg of segments) {
		segmentBySha.set(seg.fromSha, seg);
	}

	const ticks: TickPosition[] = [];
	let x = 0;

	for (let i = 0; i < commitShas.length; i++) {
		const sha = commitShas[i];
		const segment = segmentBySha.get(sha);

		ticks.push({ index: i, x, sha, segment });

		if (segment) {
			x += computeExpandedSize({
				chapterCount: segment.totalChapterCount,
				hasOpenPanel: false,
				openPanelWidth: 0,
			});
		} else {
			x += COLLAPSED_GAP;
		}
	}

	return { ticks, totalWidth: x };
}

/**
 * Find the tick index at a given X coordinate (for hit testing).
 * Uses binary search for efficiency.
 */
export function findTickAtX(ticks: TickPosition[], targetX: number): number {
	if (ticks.length === 0) return -1;

	let lo = 0;
	let hi = ticks.length - 1;

	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (ticks[mid].x <= targetX) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}

	return lo;
}
