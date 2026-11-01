/**
 * Pure geometry for the timeline panel: time ↔ x, tick spacing, zoom bounds and
 * the dashed branch connector from a parent lane to a child lane.
 */

import type { TimelineCategory, TimelineLane } from "@shared/narrator-timeline";

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

export function clampPxPerSec(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, value));
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

/** Tick offsets (ms from origin) covering `[0, spanMs]`. Bounded to 400 ticks. */
export function ticks(spanMs: number, stepMs: number): number[] {
	const out: number[] = [];
	for (let t = 0; t <= spanMs && out.length < 400; t += stepMs) out.push(t);
	return out;
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
