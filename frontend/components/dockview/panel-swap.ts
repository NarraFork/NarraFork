/**
 * Swap the grid positions of two Dockview panels.
 *
 * Pure Dockview API usage — no React, no domain knowledge. Reused by any
 * surface that offers a "swap" drop intent.
 */

import type { DockviewApi, IDockviewPanel, Position } from "dockview-react";

/** The dockview group object carried on a panel's api (structural, to avoid a
 *  non-exported class type). We only need its bounding box for geometry. */
type PanelGroup = IDockviewPanel["api"]["group"];

/** Which side `a` sits on relative to `b`, from their group bounding boxes. */
function relativeSide(a: PanelGroup | undefined, b: PanelGroup | undefined): Position {
	const ba = a?.api.boundingBox;
	const bb = b?.api.boundingBox;
	if (!ba || !bb) return "right";
	// Prefer the axis with the larger separation between the two group centers.
	const acx = ba.left + ba.width / 2;
	const acy = ba.top + ba.height / 2;
	const bcx = bb.left + bb.width / 2;
	const bcy = bb.top + bb.height / 2;
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
 * Exchange the grid positions of two panels.
 *
 * The tricky case is when a panel is the SOLE member of its group: moving it
 * away destroys its (now empty) group, so a naive "move A into B's group, then
 * move B into A's old group" leaves B with nowhere to go — both panels pile
 * into one group and the other pane vanishes.
 *
 * Strategy:
 *  - Same group → swap tab order by index.
 *  - A is sole member of its group → move A to the OPPOSITE side of B's group.
 *    Since A occupied one whole pane, relocating that pane to B's other side is
 *    exactly the position swap (one move, no orphaned group).
 *  - Otherwise (A shares its group) but B is sole member → do the symmetric
 *    move with B.
 *  - Both groups are multi-member → move A into B's slot, then B into A's old
 *    slot (neither group empties, so both survive).
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
		// Same group → swap tab order via index.
		const idxA = groupA.panels.findIndex((p) => p.id === panelIdA);
		const idxB = groupA.panels.findIndex((p) => p.id === panelIdB);
		if (idxA === -1 || idxB === -1) return;
		a.api.moveTo({ group: groupA, index: idxB });
		b.api.moveTo({ group: groupA, index: idxA });
		return;
	}

	const aSole = groupA.panels.length === 1;
	const bSole = groupB.panels.length === 1;

	if (aSole) {
		// Relocate A's pane to the opposite side of B → swaps the two panes.
		const side = OPPOSITE[relativeSide(groupA, groupB)];
		a.api.moveTo({ group: groupB, position: side });
		a.api.setActive();
		return;
	}

	if (bSole) {
		// Symmetric: relocate B's pane to the opposite side of A.
		const side = OPPOSITE[relativeSide(groupB, groupA)];
		b.api.moveTo({ group: groupA, position: side });
		a.api.setActive();
		return;
	}

	// Both groups keep other members after the move, so neither is destroyed.
	// Swap tab slots across the two groups.
	const idxA = groupA.panels.findIndex((p) => p.id === panelIdA);
	const idxB = groupB.panels.findIndex((p) => p.id === panelIdB);
	a.api.moveTo({ group: groupB, index: idxB >= 0 ? idxB : undefined });
	b.api.moveTo({ group: groupA, index: idxA >= 0 ? idxA : undefined });
	a.api.setActive();
}
