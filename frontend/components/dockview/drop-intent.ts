/**
 * Three-zone drop intent for Dockview surfaces.
 *
 * Pure geometry — no React. Given a pointer position over the dockview root,
 * resolve which group is under the cursor and what a drop there should mean:
 *   - center small square → `swap` the dragged panel with the target's panel
 *   - surrounding area     → `merge` (tab into the target group)
 *   - outer edge bands     → split `left` / `right` / `above` / `below`
 *
 * Reused by any Dockview instance that wants NarraFork's drag semantics.
 */

import type { Direction, DockviewApi, DockviewGroupPanel } from "dockview-react";

/**
 * What a drop under the cursor should do:
 * - `swap`  → exchange grid positions of the dragged panel and the target panel
 * - `merge` → tab the dragged panel into the target group
 * - split   → place the dragged panel on an edge of the target group
 */
export type DropIntent = "swap" | "merge" | "left" | "right" | "above" | "below";

export interface DropIndicator {
	left: number;
	top: number;
	width: number;
	height: number;
	/** Rendering hint so the overlay can style swap distinctly from merge/split. */
	variant: DropIntent;
}

export interface GroupHit {
	group: DockviewGroupPanel;
	intent: DropIntent;
	/** The active panel id of the target group (used for swap). */
	targetPanelId: string | undefined;
	/** Group bounding box relative to the dockview root (px). */
	box: { left: number; top: number; width: number; height: number };
}

/** Split directions a surface is allowed to offer. */
export type SplitDirection = "left" | "right" | "above" | "below";

export interface DropZoneThresholds {
	/** Edge band thickness (fraction of group size) that maps to a split. */
	edge: number;
	/** Half-size of the central swap square (fraction of group size). */
	swapHalf: number;
	/**
	 * Which edge splits are allowed. An edge whose direction is not listed
	 * falls through to `merge`. Defaults to all four. Use e.g.
	 * `["above", "below"]` for a narrow column (mobile drawer) that should only
	 * stack vertically.
	 */
	allowedSplits?: readonly SplitDirection[];
}

const ALL_SPLITS: readonly SplitDirection[] = ["left", "right", "above", "below"];

export const DEFAULT_THRESHOLDS: DropZoneThresholds = {
	edge: 0.2,
	swapHalf: 0.14,
};

/** Vertical-only split preset (mobile drawer): stack above/below + tab/swap. */
export const VERTICAL_ONLY_THRESHOLDS: DropZoneThresholds = {
	edge: 0.2,
	swapHalf: 0.14,
	allowedSplits: ["above", "below"],
};

/**
 * Find the group under the cursor and resolve the three-zone drop intent.
 * `draggedPanelId` lets us avoid offering a self-swap onto the dragged panel.
 */
export function hitTestGroups(
	api: DockviewApi,
	clientX: number,
	clientY: number,
	draggedPanelId?: string,
	thresholds: DropZoneThresholds = DEFAULT_THRESHOLDS,
): GroupHit | null {
	const { edge, swapHalf } = thresholds;
	const allowed = thresholds.allowedSplits ?? ALL_SPLITS;
	const canSplit = (dir: SplitDirection) => allowed.includes(dir);
	for (const group of api.groups) {
		const box = group.api.boundingBox;
		if (!box) continue;
		// Use the group element's own client rect for absolute (viewport) hit-testing.
		const el = (group as unknown as { element?: HTMLElement }).element;
		const rect = el?.getBoundingClientRect();
		if (!rect) continue;
		if (
			clientX < rect.left ||
			clientX > rect.right ||
			clientY < rect.top ||
			clientY > rect.bottom
		) {
			continue;
		}
		const rx = (clientX - rect.left) / rect.width;
		const ry = (clientY - rect.top) / rect.height;
		const targetPanelId = group.activePanel?.id;

		// Outer edge bands → split (only for allowed directions; disallowed edges
		// fall through to merge).
		let intent: DropIntent | null = null;
		if (rx < edge && canSplit("left")) intent = "left";
		else if (rx > 1 - edge && canSplit("right")) intent = "right";
		else if (ry < edge && canSplit("above")) intent = "above";
		else if (ry > 1 - edge && canSplit("below")) intent = "below";
		if (intent === null) {
			if (
				// Central square → swap, unless it would swap a panel with itself.
				Math.abs(rx - 0.5) < swapHalf &&
				Math.abs(ry - 0.5) < swapHalf &&
				targetPanelId &&
				targetPanelId !== draggedPanelId
			) {
				intent = "swap";
			} else {
				// Everything else → merge (tab).
				intent = "merge";
			}
		}

		return {
			group,
			intent,
			targetPanelId,
			box: { left: box.left, top: box.top, width: box.width, height: box.height },
		};
	}
	return null;
}

/** Compute the highlight rectangle for a group hit, relative to the root. */
export function toIndicator(
	hit: GroupHit,
	thresholds: DropZoneThresholds = DEFAULT_THRESHOLDS,
): DropIndicator {
	const { box, intent } = hit;
	const half = { w: box.width / 2, h: box.height / 2 };
	switch (intent) {
		case "left":
			return { left: box.left, top: box.top, width: half.w, height: box.height, variant: intent };
		case "right":
			return {
				left: box.left + half.w,
				top: box.top,
				width: half.w,
				height: box.height,
				variant: intent,
			};
		case "above":
			return { left: box.left, top: box.top, width: box.width, height: half.h, variant: intent };
		case "below":
			return {
				left: box.left,
				top: box.top + half.h,
				width: box.width,
				height: half.h,
				variant: intent,
			};
		case "swap": {
			// Small centered square hint.
			const w = box.width * thresholds.swapHalf * 2;
			const h = box.height * thresholds.swapHalf * 2;
			return {
				left: box.left + (box.width - w) / 2,
				top: box.top + (box.height - h) / 2,
				width: w,
				height: h,
				variant: intent,
			};
		}
		default:
			return {
				left: box.left,
				top: box.top,
				width: box.width,
				height: box.height,
				variant: "merge",
			};
	}
}

/** Map a split/merge intent to a Dockview drop Position. */
export function intentToPosition(
	intent: DropIntent,
): "left" | "right" | "top" | "bottom" | "center" {
	switch (intent) {
		case "left":
			return "left";
		case "right":
			return "right";
		case "above":
			return "top";
		case "below":
			return "bottom";
		default:
			return "center";
	}
}

/** Map a split/merge intent to a Dockview add-panel Direction. */
export function intentToDirection(intent: DropIntent): Direction {
	switch (intent) {
		case "left":
			return "left";
		case "right":
			return "right";
		case "above":
			return "above";
		case "below":
			return "below";
		default:
			return "within";
	}
}
