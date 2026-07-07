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
 * vertically). Portrait: rail on top (secondaries in a grid), primary below.
 * Ported from the pre-dockview DirectorPanelLayout.
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
		const railWidth = Math.max(0, width - DIRECTOR_PADDING * 2);
		const maxColumns = Math.max(
			1,
			Math.min(
				3,
				Math.floor(
					(railWidth + DIRECTOR_GAP) / (DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH + DIRECTOR_GAP),
				),
			),
		);
		const columns = Math.min(secondaryCount, maxColumns);
		const rows = Math.ceil(secondaryCount / columns);
		const railHeight = Math.max(0, railThickness - DIRECTOR_PADDING * 2);
		const availableWidth = Math.max(0, railWidth - DIRECTOR_GAP * Math.max(0, columns - 1));
		const availableHeight = Math.max(0, railHeight - DIRECTOR_GAP * Math.max(0, rows - 1));
		const itemWidth =
			columns > 0 ? Math.min(availableWidth / columns, DIRECTOR_SECONDARY_MAX_PORTRAIT) : 0;
		const itemHeight = rows > 0 ? availableHeight / rows : 0;
		const column = columns > 0 ? index % columns : 0;
		const row = columns > 0 ? Math.floor(index / columns) : 0;
		secondaryFrames.push({
			left: DIRECTOR_PADDING + column * (itemWidth + DIRECTOR_GAP),
			top: DIRECTOR_PADDING + row * (itemHeight + DIRECTOR_GAP),
			width: itemWidth,
			height: itemHeight,
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
