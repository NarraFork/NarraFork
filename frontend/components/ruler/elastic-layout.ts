/**
 * Elastic spacing engine for the ruler.
 *
 * Computes the X coordinate of each commit tick based on:
 * - A base spacing for collapsed segments
 * - An expanded size for open segments
 *
 * Segments are identified by their `fromSha` (the commit where chapters fork from).
 * When a segment is expanded, the gap after that commit is enlarged.
 */

import type { RulerSegment } from "../../hooks/useRuler";
import type { AnimatedSegment } from "./spring";

export interface TickPosition {
	/** Index in the commits array */
	index: number;
	/** Computed X coordinate (before global scale) */
	x: number;
	/** The commit SHA */
	sha: string;
	/** Whether this tick starts an expandable segment */
	segment?: RulerSegment;
	/** Whether this segment is currently expanded */
	isExpanded?: boolean;
}

export interface ElasticLayout {
	/** Position of each commit tick */
	ticks: TickPosition[];
	/** Total width of the ruler (before global scale) */
	totalWidth: number;
}

const COLLAPSED_GAP = 80; // px between ticks in collapsed state
const EXPANDED_MIN_GAP = 400; // minimum px for an expanded segment

const CARD_SLOT = 236; // 220 card + 16 gap
const PADDING = 40;

/**
 * Scale-aware collapsed gap.
 * - L0 (scale < 0.25): ultra-compact → 20px
 * - L1 (0.25 ≤ scale < 0.6): linear 40→80px
 * - L2+ (scale ≥ 0.6): standard 80px
 */
export function getCollapsedGap(scale: number): number {
	if (scale < 0.25) return 20;
	if (scale < 0.6) return 40 + ((scale - 0.25) / 0.35) * 40;
	return 80;
}

/**
 * Compute the expanded segment size based on chapter count and panel state.
 */
export function computeExpandedSize(params: {
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
 *
 * @param commitShas - Ordered array of commit SHAs (newest first from git log)
 * @param segments - Segments from the ruler API
 * @param expandedSegments - Set of fromSha values that are currently expanded
 * @param expandedSizes - Optional map of fromSha → custom expanded size (px)
 * @param scale - Current zoom scale (default 1), affects collapsed gap
 */
export function computeElasticLayout(
	commitShas: string[],
	segments: RulerSegment[],
	expandedSegments: Set<string>,
	expandedSizes?: Map<string, number>,
	scale?: number,
): ElasticLayout {
	// Build segment lookup
	const segmentBySha = new Map<string, RulerSegment>();
	for (const seg of segments) {
		segmentBySha.set(seg.fromSha, seg);
	}

	const ticks: TickPosition[] = [];
	let x = 0;

	for (let i = 0; i < commitShas.length; i++) {
		const sha = commitShas[i];
		const segment = segmentBySha.get(sha);
		const isExpanded = segment ? expandedSegments.has(sha) : false;

		ticks.push({
			index: i,
			x,
			sha,
			segment,
			isExpanded,
		});

		// Determine gap after this tick
		if (isExpanded && segment) {
			const customSize = expandedSizes?.get(sha);
			x += customSize ?? EXPANDED_MIN_GAP;
		} else {
			x += getCollapsedGap(scale ?? 1);
		}
	}

	return { ticks, totalWidth: x };
}

/**
 * Like `computeElasticLayout` but reads in-flight animated sizes for expanded
 * segments, falling back to `computeExpandedSize` when no animation state exists.
 */
export function computeElasticLayoutAnimated(
	commitShas: string[],
	segments: RulerSegment[],
	expandedSegments: Set<string>,
	animatedSizes: Map<string, AnimatedSegment>,
	scale?: number,
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
		const isExpanded = segment ? expandedSegments.has(sha) : false;

		ticks.push({ index: i, x, sha, segment, isExpanded });

		if (isExpanded && segment) {
			const animated = animatedSizes.get(sha);
			x += animated
				? animated.currentSize
				: computeExpandedSize({
						chapterCount: segment.totalChapterCount,
						hasOpenPanel: false,
						openPanelWidth: 0,
					});
		} else {
			x += getCollapsedGap(scale ?? 1);
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

export { COLLAPSED_GAP, EXPANDED_MIN_GAP };
