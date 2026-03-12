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

/**
 * Compute tick positions with elastic spacing.
 *
 * @param commitShas - Ordered array of commit SHAs (newest first from git log)
 * @param segments - Segments from the ruler API
 * @param expandedSegments - Set of fromSha values that are currently expanded
 * @param expandedSizes - Optional map of fromSha → custom expanded size (px)
 */
export function computeElasticLayout(
	commitShas: string[],
	segments: RulerSegment[],
	expandedSegments: Set<string>,
	expandedSizes?: Map<string, number>,
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

export { COLLAPSED_GAP, EXPANDED_MIN_GAP };
