/**
 * Swap the grid positions of two Dockview panels.
 *
 * Pure Dockview API usage — no React, no domain knowledge. Reused by any
 * surface that offers a "swap" drop intent.
 *
 * Swap is content-only: panels trade places, but the two layout slots keep
 * their pre-swap geometry (width on a horizontal split, height on a vertical
 * one). Without restoring sizes, Dockview re-splits after a sole-member
 * `moveTo` and the user's carefully resized proportions collapse toward a
 * fresh default — the bug this module exists to avoid.
 */

import type { DockviewApi, IDockviewPanel, Position } from "dockview-react";

/** The dockview group object carried on a panel's api (structural, to avoid a
 *  non-exported class type). We only need its bounding box for geometry. */
type PanelGroup = IDockviewPanel["api"]["group"];

interface Box {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** Which side `a` sits on relative to `b`, from their group bounding boxes. */
function relativeSide(a: PanelGroup | undefined, b: PanelGroup | undefined): Position {
	const ba = a?.api.boundingBox;
	const bb = b?.api.boundingBox;
	if (!ba || !bb) return "right";
	return boxSide(ba, bb);
}

/** Relative side of box `a` vs box `b`, preferring the axis of larger separation. */
function boxSide(a: Box, b: Box): Position {
	const acx = a.left + a.width / 2;
	const acy = a.top + a.height / 2;
	const bcx = b.left + b.width / 2;
	const bcy = b.top + b.height / 2;
	const dx = acx - bcx;
	const dy = acy - bcy;
	if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? "left" : "right";
	return dy < 0 ? "top" : "bottom";
}

const OPPOSITE: Record<Position, Position> = {
	left: "right",
	right: "left",
	top: "bottom",
	bottom: "top",
	center: "center",
};

/**
 * Whether the dominant split axis between two slots is horizontal (left/right).
 * Used to decide which dimension (`width` vs `height`) a slot size restore owns.
 */
function isHorizontalSplit(a: Box, b: Box): boolean {
	const dx = Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
	const dy = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
	return dx >= dy;
}

/** Size of `box` along the dominant split axis. */
function axisSize(box: Box, horizontal: boolean): number {
	return horizontal ? box.width : box.height;
}

/**
 * Restore the two layout slots to their pre-swap geometry after content has
 * moved. Slots are positional: the geometric first slot (left/top) keeps the
 * size the first slot had before the swap, regardless of which panel now
 * fills it.
 *
 * Safe no-op when boxes are missing, the panels ended up in the same group,
 * or Dockview has not laid the groups out yet.
 */
function restoreSlotProportions(
	api: DockviewApi,
	panelIdA: string,
	panelIdB: string,
	slotA: Box | undefined,
	slotB: Box | undefined,
): void {
	if (!slotA || !slotB) return;
	const a = api.getPanel(panelIdA);
	const b = api.getPanel(panelIdB);
	const groupA = a?.api.group;
	const groupB = b?.api.group;
	if (!groupA || !groupB || groupA.id === groupB.id) return;

	const nowA = groupA.api.boundingBox;
	const nowB = groupB.api.boundingBox;
	if (!nowA || !nowB) return;

	const horizontal = isHorizontalSplit(slotA, slotB);
	const slotAFirst = horizontal
		? slotA.left + slotA.width / 2 <= slotB.left + slotB.width / 2
		: slotA.top + slotA.height / 2 <= slotB.top + slotB.height / 2;
	const nowAFirst = horizontal
		? nowA.left + nowA.width / 2 <= nowB.left + nowB.width / 2
		: nowA.top + nowA.height / 2 <= nowB.top + nowB.height / 2;

	const sizeFirst = axisSize(slotAFirst ? slotA : slotB, horizontal);
	const sizeSecond = axisSize(slotAFirst ? slotB : slotA, horizontal);
	const groupFirst = nowAFirst ? groupA : groupB;
	const groupSecond = nowAFirst ? groupB : groupA;

	if (horizontal) {
		groupFirst.api.setSize({ width: sizeFirst });
		groupSecond.api.setSize({ width: sizeSecond });
	} else {
		groupFirst.api.setSize({ height: sizeFirst });
		groupSecond.api.setSize({ height: sizeSecond });
	}
}

/**
 * Exchange the content of two panels while keeping layout-slot proportions.
 *
 * The tricky case is when a panel is the SOLE member of its group: moving it
 * away destroys its (now empty) group, so a naive "move A into B's group, then
 * move B into A's old group" leaves B with nowhere to go — both panels pile
 * into one group and the other pane vanishes.
 *
 * Strategy:
 *  - Same group → swap tab order by index (slots unchanged; no size restore).
 *  - A is sole member of its group → move A to the OPPOSITE side of B's group.
 *    Since A occupied one whole pane, relocating that pane to B's other side is
 *    exactly the position swap (one move, no orphaned group).
 *  - Otherwise (A shares its group) but B is sole member → do the symmetric
 *    move with B.
 *  - Both groups are multi-member → move A into B's slot, then B into A's old
 *    slot (neither group empties, so both survive).
 *
 * After any cross-group path, the two slots are resized back to their pre-swap
 * geometry so only content moved — not the user's split ratio.
 */
export function swapPanels(api: DockviewApi, panelIdA: string, panelIdB: string): void {
	if (panelIdA === panelIdB) return;
	const a = api.getPanel(panelIdA);
	const b = api.getPanel(panelIdB);
	if (!a || !b) return;
	const groupA = a.api.group;
	const groupB = b.api.group;
	if (!groupA || !groupB) return;

	if (groupA.id === groupB.id) {
		// Same group → swap tab order via index. Geometry is per-group, so the
		// split ratio cannot change; nothing to restore.
		const idxA = groupA.panels.findIndex((p) => p.id === panelIdA);
		const idxB = groupA.panels.findIndex((p) => p.id === panelIdB);
		if (idxA === -1 || idxB === -1) return;
		a.api.moveTo({ group: groupA, index: idxB });
		b.api.moveTo({ group: groupA, index: idxA });
		return;
	}

	// Capture slot geometry BEFORE any move. Sole-member moves destroy a group
	// and Dockview re-splits the freed space; without these numbers the new
	// sizes are defaults, not the user's proportions.
	const slotA = groupA.api.boundingBox;
	const slotB = groupB.api.boundingBox;

	const aSole = groupA.panels.length === 1;
	const bSole = groupB.panels.length === 1;

	if (aSole) {
		// Relocate A's pane to the opposite side of B → content trades places.
		const side = OPPOSITE[relativeSide(groupA, groupB)];
		a.api.moveTo({ group: groupB, position: side });
		a.api.setActive();
		restoreSlotProportions(api, panelIdA, panelIdB, slotA, slotB);
		return;
	}

	if (bSole) {
		// Symmetric: relocate B's pane to the opposite side of A.
		const side = OPPOSITE[relativeSide(groupB, groupA)];
		b.api.moveTo({ group: groupA, position: side });
		a.api.setActive();
		restoreSlotProportions(api, panelIdA, panelIdB, slotA, slotB);
		return;
	}

	// Both groups keep other members after the move, so neither is destroyed.
	// Swap tab slots across the two groups.
	const idxA = groupA.panels.findIndex((p) => p.id === panelIdA);
	const idxB = groupB.panels.findIndex((p) => p.id === panelIdB);
	a.api.moveTo({ group: groupB, index: idxB >= 0 ? idxB : undefined });
	b.api.moveTo({ group: groupA, index: idxA >= 0 ? idxA : undefined });
	a.api.setActive();
	// Groups stay in place; sizes are already correct. Restore anyway so a
	// multi-member swap that also nudges geometry keeps the pre-swap ratio.
	restoreSlotProportions(api, panelIdA, panelIdB, slotA, slotB);
}
