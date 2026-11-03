/**
 * Pure geometry for the timeline panel: time ↔ x, tick spacing, zoom bounds and
 * the dashed branch connector from a parent lane to a child lane.
 */

import type { TimelineCategory, TimelineLane, TimelineSegment } from "@shared/narrator-timeline";

export const LANE_HEIGHT = 30;
export const LANE_GAP = 10;
export const BAR_HEIGHT = 16;
export const AXIS_HEIGHT = 22;
export const MIN_SEGMENT_PX = 1;
export const MIN_PX_PER_SEC = 0.02;
export const MAX_PX_PER_SEC = 400;

/** Mantine colour per category; `after_turn` is drawn as a hatch over gray. */
export const CATEGORY_COLOR: Record<TimelineCategory, string> = {
	model_wait: "var(--mantine-color-indigo-3)",
	model_output: "var(--mantine-color-indigo-6)",
	tool: "var(--mantine-color-teal-6)",
	permission_wait: "var(--mantine-color-orange-6)",
	user_reply_wait: "var(--mantine-color-yellow-5)",
	review: "var(--mantine-color-grape-6)",
	subagent_wait: "var(--mantine-color-cyan-5)",
	compact: "var(--mantine-color-pink-5)",
	overhead: "var(--mantine-color-gray-5)",
	after_turn: "var(--mantine-color-gray-6)",
};

/** Lighter categories read as "not doing work". */
export const CATEGORY_OPACITY: Partial<Record<TimelineCategory, number>> = {
	overhead: 0.35,
	after_turn: 0.25,
};

/** Widest scrollable track; browsers stop laying out elements somewhere past 16M px. */
export const MAX_CONTENT_PX = 8_000_000;

/** Clamp a zoom; with `spanMs`, also keep the whole track within {@link MAX_CONTENT_PX}. */
export function clampPxPerSec(value: number, spanMs?: number): number {
	if (!Number.isFinite(value)) return 1;
	const max =
		spanMs && spanMs > 0
			? Math.max(MIN_PX_PER_SEC, Math.min(MAX_PX_PER_SEC, (MAX_CONTENT_PX * 1000) / spanMs))
			: MAX_PX_PER_SEC;
	return Math.min(max, Math.max(MIN_PX_PER_SEC, value));
}

/** Zoom that fits `spanMs` into `widthPx`. */
export function fitPxPerSec(spanMs: number, widthPx: number): number {
	if (spanMs <= 0 || widthPx <= 0) return 1;
	return clampPxPerSec((widthPx / spanMs) * 1000);
}

export function timeToX(ms: number, originMs: number, pxPerSec: number): number {
	return ((ms - originMs) / 1000) * pxPerSec;
}

const TICK_STEPS_MS = [
	100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
	900_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 43_200_000, 86_400_000,
];

/** Smallest step whose spacing is at least `minGapPx`. */
export function chooseTickStep(pxPerSec: number, minGapPx = 80): number {
	for (const step of TICK_STEPS_MS) {
		if ((step / 1000) * pxPerSec >= minGapPx) return step;
	}
	return TICK_STEPS_MS[TICK_STEPS_MS.length - 1];
}

/**
 * Tick offsets (ms from origin) on the step grid within `[fromMs, toMs] ∩ [0, spanMs]`.
 * Bounded to 400 ticks; callers pass the visible window, so any zoom stays labelled.
 */
export function ticks(spanMs: number, stepMs: number, fromMs = 0, toMs = spanMs): number[] {
	const out: number[] = [];
	if (!(stepMs > 0)) return out;
	const last = Math.min(spanMs, toMs);
	for (let t = Math.max(0, Math.ceil(fromMs / stepMs) * stepMs); t <= last; t += stepMs) {
		out.push(t);
		if (out.length >= 400) break;
	}
	return out;
}

/**
 * Indices of the segments to draw for the track pixels `[fromPx, toPx)`. Segments are sorted
 * and contiguous, so the first one is found by binary search; a segment entirely under the
 * previously drawn one (slivers narrower than {@link MIN_SEGMENT_PX}) is not drawn, except
 * that the longest sliver of such a run takes the slot. Output is bounded by the pixel width
 * of the range, however many segments the lane has.
 */
export function visibleSegmentIndices(
	segments: readonly TimelineSegment[],
	originMs: number,
	pxPerSec: number,
	fromPx: number,
	toPx: number,
): number[] {
	let lo = 0;
	let hi = segments.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (timeToX(segments[mid].endMs, originMs, pxPerSec) <= fromPx) lo = mid + 1;
		else hi = mid;
	}
	const out: number[] = [];
	let drawnRight = Number.NEGATIVE_INFINITY;
	let drawnIsSliver = false;
	for (let i = lo; i < segments.length; i++) {
		const segment = segments[i];
		const left = timeToX(segment.startMs, originMs, pxPerSec);
		if (left >= toPx) break;
		const right = timeToX(segment.endMs, originMs, pxPerSec);
		if (right <= drawnRight) {
			const drawn = segments[out[out.length - 1]];
			if (drawnIsSliver && drawn && segment.endMs - segment.startMs > drawn.endMs - drawn.startMs) {
				out[out.length - 1] = i;
			}
			continue;
		}
		out.push(i);
		drawnIsSliver = right - left < MIN_SEGMENT_PX;
		drawnRight = Math.max(right, left + MIN_SEGMENT_PX);
	}
	return out;
}

/** Index of the segment starting exactly at `startMs`, or -1. */
export function segmentIndexAt(segments: readonly TimelineSegment[], startMs: number): number {
	let lo = 0;
	let hi = segments.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const at = segments[mid].startMs;
		if (at === startMs) return mid;
		if (at < startMs) lo = mid + 1;
		else hi = mid - 1;
	}
	return -1;
}

/** Compact relative duration label: 850ms, 12.3s, 4m 05s, 1h 02m. */
export function formatSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "-";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`;
	const totalSec = Math.round(sec);
	const minutes = Math.floor(totalSec / 60);
	const seconds = totalSec % 60;
	if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Y of a lane's bar centre, given its row index. */
export function laneCenterY(row: number): number {
	return AXIS_HEIGHT + row * (LANE_HEIGHT + LANE_GAP) + LANE_HEIGHT / 2;
}

export interface BranchConnector {
	childNarratorId: string;
	/** Spawn point on the parent lane. */
	x1: number;
	y1: number;
	/** Child lane start. */
	x2: number;
	y2: number;
}

/**
 * One dashed connector per child lane: down from the spawn moment on the parent's
 * bar, then across to where the child lane begins.
 */
export function branchConnectors(
	lanes: readonly TimelineLane[],
	originMs: number,
	pxPerSec: number,
): BranchConnector[] {
	const rowOf = new Map<string, number>();
	lanes.forEach((lane, row) => {
		rowOf.set(lane.narratorId, row);
	});
	const out: BranchConnector[] = [];
	lanes.forEach((lane, row) => {
		if (!lane.parentNarratorId || lane.spawnAtMs === null) return;
		const parentRow = rowOf.get(lane.parentNarratorId);
		if (parentRow === undefined) return;
		out.push({
			childNarratorId: lane.narratorId,
			x1: timeToX(lane.spawnAtMs, originMs, pxPerSec),
			y1: laneCenterY(parentRow) + BAR_HEIGHT / 2,
			x2: timeToX(lane.startMs, originMs, pxPerSec),
			y2: laneCenterY(row),
		});
	});
	return out;
}

/** SVG path for a connector: vertical drop then horizontal run. */
export function connectorPath(connector: BranchConnector): string {
	const { x1, y1, x2, y2 } = connector;
	return `M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`;
}
