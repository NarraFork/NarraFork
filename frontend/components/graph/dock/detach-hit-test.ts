/**
 * Where a tool-panel drag over the story-network canvas should land.
 *
 * A drag released over the canvas means "tear this panel out into its own node",
 * but only when the pointer is NOT over some node's dock — an expanded node lives
 * on the canvas too, so "inside the canvas" alone would also match a drop meant to
 * rearrange panels inside a dock (or to merge into another one).
 *
 * Pure geometry, so the precedence rule is testable without a canvas or a DOM.
 */

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export type CanvasDropTarget =
	/** Over blank canvas: releasing here detaches the panel into its own node. */
	| { kind: "detach" }
	/** Over a node's dock: that surface's own drop handling wins. */
	| { kind: "dock"; surfaceId: string }
	/** Over a standalone panel node: releasing here merges into it. */
	| { kind: "detachedNode"; nodeId: string }
	/** Outside the canvas entirely: nothing to do. */
	| { kind: "outside" };

export interface DockRect {
	/** The chapter id, which doubles as the dock surface's id. */
	surfaceId: string;
	rect: Rect;
}

export interface DetachedNodeRect {
	/** The detached canvas node's id. */
	nodeId: string;
	rect: Rect;
}

function contains(rect: Rect, x: number, y: number): boolean {
	return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Resolve what the pointer is over.
 *
 * Precedence, outermost check first: `outside` → `dock` → `detachedNode` →
 * `detach`. Docks and standalone nodes are both nested inside the canvas, so
 * checking the canvas first would classify them as blank space and detach a panel
 * the user was only dragging between tabs. Docks outrank standalone nodes because a
 * dock belongs to an expanded chapter node, which offers richer drop handling (its
 * own split/merge zones) than "merge into this node".
 *
 * When rects of the same kind overlap (a node dragged on top of another), the LAST
 * match wins, matching paint order — React Flow renders later nodes above earlier
 * ones, so the topmost is the one the user sees under the cursor. Callers therefore
 * pass rects in render order.
 */
export function resolveCanvasDropTarget(
	canvas: Rect | null,
	dockRects: readonly DockRect[],
	x: number,
	y: number,
	/** Standalone panel nodes, when the caller supports merging into them. */
	detachedRects: readonly DetachedNodeRect[] = [],
): CanvasDropTarget {
	if (!canvas || !contains(canvas, x, y)) return { kind: "outside" };
	let dockHit: string | null = null;
	for (const dock of dockRects) {
		if (contains(dock.rect, x, y)) dockHit = dock.surfaceId;
	}
	if (dockHit !== null) return { kind: "dock", surfaceId: dockHit };
	let nodeHit: string | null = null;
	for (const node of detachedRects) {
		if (contains(node.rect, x, y)) nodeHit = node.nodeId;
	}
	if (nodeHit !== null) return { kind: "detachedNode", nodeId: nodeHit };
	return { kind: "detach" };
}

/** Convert a DOMRect-like object into the plain rect this module uses. */
export function toRect(box: { left: number; top: number; right: number; bottom: number }): Rect {
	return { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
}
