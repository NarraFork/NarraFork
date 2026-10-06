/**
 * Director-mode layout math and constants (pure logic, no React).
 *
 * Director mode presents ONE full primary panel plus a rail of shrunken preview
 * panels. Clicking a preview promotes it to primary (a *switch*, not an
 * in-place interaction). This mirrors the pre-dockview implementation; the math
 * here is ported verbatim so the visual behaviour matches.
 *
 * Kept free of React/dockview imports so the frame math and ratio clamping can
 * be unit-tested in isolation.
 */

import type { WorkspacePanelParams } from "./panel-types";

// ── Layout constants (px) ──
export const DIRECTOR_PADDING = 8;
export const DIRECTOR_GAP = 8;
export const DIRECTOR_RAIL_MAX = 360;
export const DIRECTOR_RAIL_MIN_LANDSCAPE = 220;
export const DIRECTOR_RAIL_MIN_PORTRAIT = 180;
export const DIRECTOR_SECONDARY_MAX_LANDSCAPE = 220;
export const DIRECTOR_SECONDARY_MAX_PORTRAIT = 280;
export const DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH = 140;
export const DIRECTOR_PREVIEW_SCALE = 0.82;
/** Narrower previews scale down further for legibility. */
export const DIRECTOR_PREVIEW_SCALE_NARROW = 0.68;
export const DIRECTOR_PREVIEW_NARROW_WIDTH = 320;
export const DIRECTOR_DIVIDER_HIT_SIZE = 28;
export const DIRECTOR_DIVIDER_LINE_SIZE = 2;

// ── Primary ratio ──
export const MIN_DIRECTOR_PRIMARY_RATIO = 0.55;
export const MAX_DIRECTOR_PRIMARY_RATIO = 0.85;
export const DEFAULT_DIRECTOR_PRIMARY_RATIO = 0.72;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Clamp a primary ratio into the valid range, falling back to the default. */
export function normalizeDirectorPrimaryRatio(ratio?: number | null): number {
	if (typeof ratio !== "number" || Number.isNaN(ratio)) return DEFAULT_DIRECTOR_PRIMARY_RATIO;
	return clamp(ratio, MIN_DIRECTOR_PRIMARY_RATIO, MAX_DIRECTOR_PRIMARY_RATIO);
}

// ── Leaf model (derived from dockview panels) ──
export interface DirectorLeaf {
	id: string;
	params: WorkspacePanelParams;
	title: string;
}

export function isDirectorRenderablePanel(params: WorkspacePanelParams): boolean {
	return (
		params.panelType === "narrator" ||
		params.panelType === "terminal" ||
		params.panelType === "webview" ||
		params.panelType === "plugin"
	);
}

/**
 * Resolve which leaf is primary. The persisted `primaryPanelId` wins when it
 * still matches a live leaf; otherwise fall back to the first leaf.
 */
export function resolvePrimaryLeaf(
	leaves: DirectorLeaf[],
	primaryPanelId: string | null,
): DirectorLeaf | undefined {
	if (primaryPanelId) {
		const found = leaves.find((l) => l.id === primaryPanelId);
		if (found) return found;
	}
	return leaves[0];
}

// ── Frame geometry ──
export interface DirectorFrame {
	left: number;
	top: number;
	width: number;
	height: number;
}

export interface DirectorFrames {
	/** Rail thickness (0 when there are no secondary panels). */
	railThickness: number;
	primaryFrame: DirectorFrame;
	/** One frame per secondary panel, in order. */
	secondaryFrames: DirectorFrame[];
}

/**
 * Compute the primary + secondary frames for director mode.
 *
 * Landscape: primary on the left, rail on the right (secondaries stacked
 * vertically). Portrait: rail on top (secondaries in ONE row — when the row
 * outgrows the rail the surface scrolls it horizontally instead of wrapping
 * into a grid), primary below.
 */
export function computeDirectorFrames(opts: {
	width: number;
	height: number;
	isLandscape: boolean;
	secondaryCount: number;
	primaryRatio: number;
}): DirectorFrames {
	const { width, height, isLandscape, secondaryCount, primaryRatio } = opts;
	const hasSecondary = secondaryCount > 0;
	const ratio = normalizeDirectorPrimaryRatio(primaryRatio);

	const projectedRailThickness = clamp(
		Math.round((isLandscape ? width : height) * (1 - ratio)),
		isLandscape ? DIRECTOR_RAIL_MIN_LANDSCAPE : DIRECTOR_RAIL_MIN_PORTRAIT,
		DIRECTOR_RAIL_MAX,
	);
	const railThickness = hasSecondary ? projectedRailThickness : 0;

	const primaryFrame: DirectorFrame = isLandscape
		? {
				left: DIRECTOR_PADDING,
				top: DIRECTOR_PADDING,
				width: Math.max(0, width - railThickness - DIRECTOR_PADDING * 2),
				height: Math.max(0, height - DIRECTOR_PADDING * 2),
			}
		: {
				left: DIRECTOR_PADDING,
				top: railThickness + DIRECTOR_PADDING,
				width: Math.max(0, width - DIRECTOR_PADDING * 2),
				height: Math.max(0, height - railThickness - DIRECTOR_PADDING * 2),
			};

	const secondaryFrames: DirectorFrame[] = [];
	for (let index = 0; index < secondaryCount; index++) {
		if (isLandscape) {
			const railLeft = Math.max(0, width - railThickness);
			const railHeight = Math.max(0, height - DIRECTOR_PADDING * 2);
			const availableHeight = Math.max(0, railHeight - DIRECTOR_GAP * (secondaryCount - 1));
			const itemHeight =
				secondaryCount > 0
					? Math.min(availableHeight / secondaryCount, DIRECTOR_SECONDARY_MAX_LANDSCAPE)
					: 0;
			secondaryFrames.push({
				left: railLeft + DIRECTOR_PADDING,
				top: DIRECTOR_PADDING + index * (itemHeight + DIRECTOR_GAP),
				width: Math.max(0, railThickness - DIRECTOR_PADDING * 2),
				height: itemHeight,
			});
			continue;
		}
		// One row, uniform width: share the rail when everything fits, hold the
		// target width and let the row overflow (the surface scrolls) when it
		// does not. Frames are rail-content coordinates; the scrolled offset is
		// applied at render time, not here.
		const railWidth = Math.max(0, width - DIRECTOR_PADDING * 2);
		const fitWidth = (railWidth - DIRECTOR_GAP * (secondaryCount - 1)) / secondaryCount;
		const itemWidth = clamp(
			fitWidth,
			DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH,
			DIRECTOR_SECONDARY_MAX_PORTRAIT,
		);
		secondaryFrames.push({
			left: DIRECTOR_PADDING + index * (itemWidth + DIRECTOR_GAP),
			top: DIRECTOR_PADDING,
			width: itemWidth,
			height: Math.max(0, railThickness - DIRECTOR_PADDING * 2),
		});
	}

	return { railThickness, primaryFrame, secondaryFrames };
}

/** Preview scale for a secondary panel given its frame width. */
export function previewScaleForWidth(frameWidth: number): number {
	return frameWidth <= DIRECTOR_PREVIEW_NARROW_WIDTH
		? DIRECTOR_PREVIEW_SCALE_NARROW
		: DIRECTOR_PREVIEW_SCALE;
}

/**
 * Index of the portrait-rail frame containing `x` (rail-content coordinates),
 * or -1 when the point lands in a gap or outside the row. Frames never overlap
 * (they are separated by DIRECTOR_GAP), so at most one can contain a point.
 */
export function directorRailIndexAtX(frames: DirectorFrame[], x: number): number {
	return frames.findIndex((f) => x >= f.left && x <= f.left + f.width);
}
