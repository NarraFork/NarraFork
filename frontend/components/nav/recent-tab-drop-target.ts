/**
 * Where an EXTERNAL drag (a narrator card from the list page) would land in the sidebar.
 *
 * The sidebar's own reordering runs through @dnd-kit, whose sortable ids are built from
 * the tabs that already exist. A narrator that is not in the list yet has no sortable id,
 * so it can never be an `active` item there — which is why an external drop is resolved
 * here, geometrically, against the rendered row rects, and then persisted through the
 * same before/after primitive `moveRecentTab` already uses.
 *
 * Pure on purpose: the rules below are the part that fails silently (a drop that lands
 * one slot off, or inside a group it should not split), so they are testable without a DOM.
 */

export interface RecentTabDropRow {
	/** `type:id` for a tab row, or `dir:<path>` for a directory header. */
	key: string;
	/** Viewport-space vertical bounds of the rendered row. */
	top: number;
	bottom: number;
	/**
	 * True for rows in the pinned section. Pinned rows never accept a before/after
	 * anchor — see {@link resolveRecentTabDropTarget}.
	 */
	pinned: boolean;
	/** Set when the row is a workspace header or one of its children. */
	workspaceId?: string;
	/**
	 * The tab keys this row occupies in the server's FLAT order, in visible order.
	 *
	 * One key for a plain tab; the whole block for a directory row or a workspace group
	 * (mirrors `directoryRowKeyBlock`). Anchors collapse to the block edges so a drop
	 * next to a multi-row unit lands outside it instead of splitting it — the server
	 * would then regroup and the tab would appear somewhere the user did not aim for.
	 */
	keyBlock: string[];
}

export type RecentTabDropTarget =
	| { kind: "before"; key: string }
	| { kind: "after"; key: string }
	/** Join this workspace, rather than being ordered next to it. */
	| { kind: "workspace"; workspaceId: string }
	/**
	 * No anchor available — the section has no rendered rows.
	 *
	 * A distinct target rather than a null result: an empty sidebar section is a normal
	 * state (a fresh install, or right after "clear tabs"), and it is the one case where
	 * dropping MUST still work. It maps to a plain anchor-free upsert, whose default
	 * insertion point in an empty list is the first slot.
	 */
	| { kind: "empty" };

function blockStart(row: RecentTabDropRow): string {
	return row.keyBlock[0] ?? row.key;
}

function blockEnd(row: RecentTabDropRow): string {
	return row.keyBlock.at(-1) ?? row.key;
}

/**
 * The first row an external tab may be anchored against.
 *
 * Everything above it is pinned, and the pinned section is defined positionally on the
 * server (`getPinnedSectionEndIndex` walks from the top while rows are pinned). Inserting
 * an unpinned tab into the middle of it would end that walk early, so every pinned tab
 * below the insertion point would stop being treated as pinned — silently, and for every
 * later mutation. So a drop aimed at the pinned area is pulled down to the first unpinned
 * row instead of being rejected: the user's intent ("put it near the top") survives, the
 * invariant holds.
 */
function firstUnpinnedIndex(rows: RecentTabDropRow[]): number {
	return rows.findIndex((row) => !row.pinned);
}

/**
 * Resolve a pointer position to a drop target.
 *
 * `rows` must be in rendered (top-to-bottom) order. Always returns a target: an empty
 * section resolves to `{ kind: "empty" }` rather than to nothing, so a drop into a
 * freshly cleared sidebar still lands.
 */
export function resolveRecentTabDropTarget(
	rows: RecentTabDropRow[],
	y: number,
): RecentTabDropTarget {
	if (rows.length === 0) return { kind: "empty" };

	const hovered = rows.find((row) => y >= row.top && y < row.bottom);

	// A workspace is a structure the user assembled by hand, so pointing at any part of
	// one means "put this narrator IN it". Checked before the before/after split because
	// joining is the stronger intent — ordering a tab next to a workspace is reachable by
	// aiming at the rows around it.
	//
	// Pinned workspaces are included: joining does not change the pinned section's shape
	// (the tab becomes a child of the header, and the server keeps children adjacent to it).
	if (hovered?.workspaceId) return { kind: "workspace", workspaceId: hovered.workspaceId };

	const unpinnedStart = firstUnpinnedIndex(rows);

	// No unpinned rows at all: the only legal position is after the whole pinned section.
	if (unpinnedStart < 0) return { kind: "after", key: blockEnd(rows[rows.length - 1]) };

	// Above the first unpinned row (inside the pinned area, or above the list entirely).
	if (!hovered) {
		if (y < rows[unpinnedStart].top)
			return { kind: "before", key: blockStart(rows[unpinnedStart]) };
		// Below every row, or in a gap between rows: anchor after the last row above `y`.
		const above = [...rows].reverse().find((row) => y >= row.bottom);
		if (!above) return { kind: "before", key: blockStart(rows[unpinnedStart]) };
		return above.pinned
			? { kind: "before", key: blockStart(rows[unpinnedStart]) }
			: { kind: "after", key: blockEnd(above) };
	}

	if (hovered.pinned) return { kind: "before", key: blockStart(rows[unpinnedStart]) };

	const isUpperHalf = y < hovered.top + (hovered.bottom - hovered.top) / 2;
	return isUpperHalf
		? { kind: "before", key: blockStart(hovered) }
		: { kind: "after", key: blockEnd(hovered) };
}

/**
 * The rendered row a target should be drawn against, and on which side.
 *
 * Separate from {@link resolveRecentTabDropTarget} because the indicator has to point at a
 * ROW (it is a line above or below something visible), while the target names a tab key
 * inside that row's block. For a multi-row unit those differ: the anchor is the block's
 * last key, but the line belongs under the unit's last rendered row.
 *
 * Hence the asymmetry: `before` takes the FIRST row carrying the key and `after` the LAST.
 * An expanded directory group gives every one of its rows the same block, so a single
 * `find` would draw the "after the group" line under the group's HEADER — above the very
 * members it is supposed to be below.
 */
export function recentTabDropIndicatorRow(
	rows: RecentTabDropRow[],
	target: RecentTabDropTarget,
): { row: RecentTabDropRow; side: "top" | "bottom" } | null {
	if (target.kind === "workspace" || target.kind === "empty") return null;
	const carries = (candidate: RecentTabDropRow) => candidate.keyBlock.includes(target.key);
	const row = target.kind === "before" ? rows.find(carries) : [...rows].reverse().find(carries);
	if (!row) return null;
	return { row, side: target.kind === "before" ? "top" : "bottom" };
}

/**
 * Vertical bounds of a workspace group, for the "join this workspace" highlight.
 *
 * Returns null when the group has no rendered rows (it scrolled out of the loaded window),
 * so the caller draws nothing rather than a zero-height box at the top of the list.
 */
export function recentTabWorkspaceBounds(
	rows: RecentTabDropRow[],
	workspaceId: string,
): { top: number; bottom: number } | null {
	const members = rows.filter((row) => row.workspaceId === workspaceId);
	if (members.length === 0) return null;
	return {
		top: Math.min(...members.map((row) => row.top)),
		bottom: Math.max(...members.map((row) => row.bottom)),
	};
}
