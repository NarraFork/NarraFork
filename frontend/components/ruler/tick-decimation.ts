/**
 * Pixel-density tick decimation for the ruler.
 *
 * Decimation is based purely on global camera scale, NOT on fisheye-distorted
 * screen positions. This ensures the set of retained ticks is stable during pan
 * (only changes on zoom). Fisheye only affects rendering positions, not selection.
 *
 * The algorithm computes a stride from `COLLAPSED_GAP * scale` vs `MIN_TICK_WIDTH`,
 * then selects every Nth tick, with priority overrides for segment/fork/merge ticks.
 */

import type { RulerSegment } from "../../hooks/useRuler";
import { COLLAPSED_GAP, type TickPosition } from "./elastic-layout";

export type TickPriority = "segment" | "fork_merge" | "normal";

export interface DecimatedTick {
	/** Index in the original ticks array */
	index: number;
	sha: string;
	/** World-space X position */
	x: number;
	segment?: RulerSegment;
	priority: TickPriority;
	/** Number of original ticks between this and the next retained tick (0 = adjacent) */
	skippedCount: number;
}

/**
 * Minimum tick slot width in screen pixels.
 * Decimation guarantees every retained tick owns at least this much space.
 * Zooming in makes the actual slot wider; zooming out increases the stride
 * so the slot never shrinks below this value.
 */
export const MIN_TICK_WIDTH = 60;

/**
 * Compute the decimation stride from camera scale.
 * stride = ceil(MIN_TICK_WIDTH / (COLLAPSED_GAP * scale)), clamped to ≥ 1.
 * At scale=1 with COLLAPSED_GAP=80: stride=1 (every tick kept, slot=80px).
 * At scale=0.5: stride=2 (every other tick, slot=80px).
 * At scale=0.1: stride=8 (every 8th tick, slot=96px).
 */
export function computeStride(scale: number): number {
	const screenGap = COLLAPSED_GAP * scale;
	if (screenGap >= MIN_TICK_WIDTH) return 1;
	return Math.ceil(MIN_TICK_WIDTH / screenGap);
}

/**
 * Actual slot width for a given stride and scale (screen pixels).
 * This is the space each retained tick gets: stride * COLLAPSED_GAP * scale.
 * Always ≥ MIN_TICK_WIDTH.
 */
export function slotWidth(scale: number): number {
	const stride = computeStride(scale);
	return stride * COLLAPSED_GAP * scale;
}

/**
 * Decimate ticks based on global camera scale.
 *
 * The stride is computed from scale alone — pan and fisheye do not affect
 * which ticks are retained, eliminating jitter during panning.
 *
 * Priority rules:
 *   1. Segment ticks (chapter fork points) — always retained
 *   2. Fork/merge commit ticks — always retained
 *   3. Normal ticks — retained if `tick.index % stride === 0`
 *
 * @param ticks         Full tick array from elastic layout
 * @param forkMergeShas Set of commit SHAs that are fork or merge points
 * @param scale         Global camera scale (no fisheye)
 * @param visStartIdx   First visible tick index (from viewport culling)
 * @param visEndIdx     Last visible tick index (from viewport culling)
 */
export function decimateTicks(
	ticks: TickPosition[],
	forkMergeShas: Set<string>,
	scale: number,
	visStartIdx: number,
	visEndIdx: number,
): DecimatedTick[] {
	if (ticks.length === 0) return [];

	const stride = computeStride(scale);

	// Pass 1: select retained ticks
	const retained: Array<{
		tick: TickPosition;
		priority: TickPriority;
		candidateIdx: number; // sequential index among visible ticks
	}> = [];

	let candidateIdx = 0;
	for (let i = visStartIdx; i <= visEndIdx; i++) {
		const tick = ticks[i];
		let priority: TickPriority = "normal";
		if (tick.segment) {
			priority = "segment";
		} else if (forkMergeShas.has(tick.sha)) {
			priority = "fork_merge";
		}

		const keep = priority !== "normal" || tick.index % stride === 0;
		if (keep) {
			retained.push({ tick, priority, candidateIdx });
		}
		candidateIdx++;
	}

	// Pass 2: build result with skippedCount
	const result: DecimatedTick[] = [];
	for (let i = 0; i < retained.length; i++) {
		const r = retained[i];
		const next = retained[i + 1];
		const skippedCount = next ? next.candidateIdx - r.candidateIdx - 1 : 0;

		result.push({
			index: r.tick.index,
			sha: r.tick.sha,
			x: r.tick.x,
			segment: r.tick.segment,
			priority: r.priority,
			skippedCount,
		});
	}

	return result;
}
