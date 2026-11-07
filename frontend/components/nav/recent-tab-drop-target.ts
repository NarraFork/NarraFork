/**
 * Where a dragged tab would land in the sidebar — for the sidebar's own drags and for a
 * narrator dragged in from the list page alike.
 *
 * Pure on purpose: these rules are the part that fails silently (a drop one slot off,
 * a merge where the user meant to reorder), so they are testable without a DOM. Rows are
 * measured rects of what is rendered; the resolver never consults the tab list itself.
 *
 * Every rendered row is one of:
 *   - a top-level tab;
 *   - a folder header;
 *   - a VISIBLE folder member (members hidden by a collapsed or preview-limited folder
 *     are not rendered, so they are not rows).
 */

export interface RecentTabDropRow {
	/** `type:id` of the rendered tab (a folder header's key is `folder:<id>`). */
	key: string;
	/** Viewport-space vertical bounds of the rendered row. */
	top: number;
	bottom: number;
	kind: "tab" | "folder" | "member";
	/** Top-level unit is pinned (for a member: its folder is pinned). */
	pinned: boolean;
	/** Folder member only: pinned inside its folder. */
	memberPinned?: boolean;
	/** Folder header: its own id. Folder member: the folder it belongs to. */
	folderId?: string;
	/** Session tabs can merge into / join a folder; projects and folders cannot. */
	canNest: boolean;
}

export type RecentTabDropTarget =
	/**
	 * Top-level placement next to a top-level unit (a folder anchor means the whole folder).
	 * `pinned` is set when the slot lies in the other block than the source: the drop pins
	 * or unpins it (see `zoneTarget`).
	 */
	| { kind: "before"; key: string; pinned?: boolean }
	| { kind: "after"; key: string; pinned?: boolean }
	/** Placement inside a folder, next to one of its visible members. */
	| { kind: "member-before"; folderId: string; key: string }
	| { kind: "member-after"; folderId: string; key: string }
	/** Drop ONTO a top-level session tab: create a folder from the two. */
	| { kind: "merge"; key: string }
	/** Drop onto a folder header: append to that folder. */
	| { kind: "into-folder"; folderId: string }
	/** The section has no rendered rows; an empty sidebar must still accept a drop. */
	| { kind: "empty" };

/** What is being dragged; decides which targets are legal. */
export interface RecentTabDropSource {
	key: string;
	kind: "tab" | "folder" | "member";
	pinned: boolean;
	folderId?: string;
	canNest: boolean;
}

/**
 * Fraction of a row's height, from each edge, that means "between rows". The middle
 * remainder means "onto this row" (merge / join) where that is legal.
 */
export const RECENT_TAB_DROP_EDGE = 0.25;

function unitKeyOf(row: RecentTabDropRow): string {
	return row.kind === "member" && row.folderId ? `folder:${row.folderId}` : row.key;
}

/** Top/bottom of a whole top-level unit (a folder spans its header and visible members). */
function unitBounds(
	rows: RecentTabDropRow[],
	unitKey: string,
): { top: number; bottom: number } | null {
	const members = rows.filter((row) => unitKeyOf(row) === unitKey);
	if (members.length === 0) return null;
	return {
		top: Math.min(...members.map((row) => row.top)),
		bottom: Math.max(...members.map((row) => row.bottom)),
	};
}

/**
 * Pinned top-level units are positional on the server (`getPinnedSectionEndIndex` walks
 * from the top while units are pinned), so a unit's pinned state follows the block it is
 * dropped into: above the pin divider it is pinned, below it unpinned. Dragging across
 * the divider is how a tab is pinned or unpinned by hand.
 *
 * `zonePinned` is which side of the divider the pointer is on. The target is kept inside
 * that block (a slot aimed past the block's edge lands at its edge), and carries
 * `pinned` when the source comes from the other block.
 */
function zoneTarget(
	rows: RecentTabDropRow[],
	target: { kind: "before" | "after"; key: string },
	zonePinned: boolean,
	sourcePinned: boolean,
): RecentTabDropTarget | null {
	const units: string[] = [];
	for (const row of rows) {
		const unit = unitKeyOf(row);
		if (!units.includes(unit)) units.push(unit);
	}
	if (units.length === 0) return null;
	const pinnedOf = (unit: string) => !!rows.find((row) => unitKeyOf(row) === unit)?.pinned;
	const zone = units.filter((unit) => pinnedOf(unit) === zonePinned);
	let placed: { kind: "before" | "after"; key: string } = target;
	if (zone.length === 0) {
		// Nothing rendered in that block yet: the pinned block starts before every unit,
		// the unpinned one after them all.
		placed = zonePinned
			? { kind: "before", key: units[0] }
			: { kind: "after", key: units[units.length - 1] };
	} else if (!zone.includes(target.key)) {
		const targetIndex = units.indexOf(target.key);
		placed =
			targetIndex < units.indexOf(zone[0])
				? { kind: "before", key: zone[0] }
				: { kind: "after", key: zone[zone.length - 1] };
	}
	return zonePinned === sourcePinned ? placed : { ...placed, pinned: zonePinned };
}

/**
 * Resolve a pointer to a drop target for `source`. `rows` must be in rendered order.
 * Returns null when nothing should happen (dropping in place, or no legal spot).
 */
export function resolveRecentTabDropTarget(
	rows: RecentTabDropRow[],
	y: number,
	source: RecentTabDropSource | null,
	/**
	 * The rendered pin divider, when the caller has it. Above it is the pinned block even
	 * when nothing is pinned yet; without it the zone is inferred from the target row.
	 */
	pinDivider?: { top: number; bottom: number } | null,
): RecentTabDropTarget | null {
	const others = source
		? rows.filter(
				(row) =>
					row.key !== source.key &&
					// A dragged folder carries its members with it; they are not targets.
					!(source.kind === "folder" && row.kind === "member" && row.folderId === source.folderId),
			)
		: rows;
	if (others.length === 0) return rows.length === 0 ? { kind: "empty" } : null;
	const sourcePinned = source?.pinned ?? false;
	const canNest = source ? source.canNest && source.kind !== "folder" : true;
	// Which side of the pin divider the pointer is on. With the divider measured, that is
	// exact and works with an empty pinned block; otherwise fall back to the target row's
	// block, with the line after the last pinned unit reading as unpinned (one line, one
	// outcome, like the in-folder boundary).
	const place = (target: { kind: "before" | "after"; key: string }) =>
		zoneTarget(
			others,
			target,
			pinDivider ? y < (pinDivider.top + pinDivider.bottom) / 2 : slotPinned(others, target),
			sourcePinned,
		);

	const hovered = others.find((row) => y >= row.top && y < row.bottom);
	if (!hovered) {
		// Above everything, below everything, or in a gap: place relative to the nearest
		// unit above (or before the first one).
		const above = [...others].reverse().find((row) => y >= row.bottom);
		return place(
			above
				? { kind: "after", key: unitKeyOf(above) }
				: { kind: "before", key: unitKeyOf(others[0]) },
		);
	}

	const height = hovered.bottom - hovered.top;
	const offset = (y - hovered.top) / (height || 1);
	const inMiddle = offset >= RECENT_TAB_DROP_EDGE && offset < 1 - RECENT_TAB_DROP_EDGE;
	const upper = offset < 0.5;

	if (hovered.kind === "member" && hovered.folderId) {
		// Only session tabs live in folders; anything else is placed around the folder.
		if (!canNest) {
			const bounds = unitBounds(others, `folder:${hovered.folderId}`);
			const before = bounds ? y < (bounds.top + bounds.bottom) / 2 : upper;
			return place({ kind: before ? "before" : "after", key: `folder:${hovered.folderId}` });
		}
		if (!upper && hovered.memberPinned) {
			// The line under the last pinned member is also the line above the first
			// unpinned one. Resolve that boundary one way (unpinned), so one line never means
			// two outcomes; the pinned zone is still reachable from its own rows' upper halves.
			const index = others.indexOf(hovered);
			const next = others[index + 1];
			if (next?.kind === "member" && next.folderId === hovered.folderId && !next.memberPinned) {
				return { kind: "member-before", folderId: hovered.folderId, key: next.key };
			}
		}
		return {
			kind: upper ? "member-before" : "member-after",
			folderId: hovered.folderId,
			key: hovered.key,
		};
	}

	if (hovered.kind === "folder" && hovered.folderId) {
		if (canNest && inMiddle) return { kind: "into-folder", folderId: hovered.folderId };
		if (!upper && canNest) {
			// The lower edge of a header with visible members means "first in the folder" —
			// first of the unpinned zone, so a drop there never silently pins the tab. With
			// only pinned members visible it is a plain join.
			const members = others.filter(
				(row) => row.kind === "member" && row.folderId === hovered.folderId,
			);
			if (members.length > 0) {
				const firstUnpinned = members.find((row) => !row.memberPinned);
				return firstUnpinned
					? { kind: "member-before", folderId: hovered.folderId, key: firstUnpinned.key }
					: { kind: "into-folder", folderId: hovered.folderId };
			}
		}
		return place({ kind: upper ? "before" : "after", key: hovered.key });
	}

	if (canNest && hovered.canNest && inMiddle) return { kind: "merge", key: hovered.key };
	return place({ kind: upper ? "before" : "after", key: hovered.key });
}

/**
 * Whether a top-level slot lies in the pinned block: next to a pinned unit, but not on
 * the divider (after the last pinned unit).
 */
function slotPinned(
	rows: RecentTabDropRow[],
	target: { kind: "before" | "after"; key: string },
): boolean {
	const units: string[] = [];
	for (const row of rows) {
		const unit = unitKeyOf(row);
		if (!units.includes(unit)) units.push(unit);
	}
	const pinnedOf = (unit: string | undefined) =>
		unit !== undefined && !!rows.find((row) => unitKeyOf(row) === unit)?.pinned;
	if (!pinnedOf(target.key)) return false;
	if (target.kind === "before") return true;
	return pinnedOf(units[units.indexOf(target.key) + 1]);
}

/** Bounds to highlight for a merge / join target, or null for line targets. */
export function recentTabDropHighlight(
	rows: RecentTabDropRow[],
	target: RecentTabDropTarget,
): { top: number; bottom: number } | null {
	if (target.kind === "merge") {
		const row = rows.find((candidate) => candidate.key === target.key);
		return row ? { top: row.top, bottom: row.bottom } : null;
	}
	if (target.kind === "into-folder") return unitBounds(rows, `folder:${target.folderId}`);
	return null;
}

/**
 * The rendered row a line target is drawn against, and on which side. A top-level
 * "after" a folder draws under the folder's last visible row, not under its header.
 */
export function recentTabDropIndicatorRow(
	rows: RecentTabDropRow[],
	target: RecentTabDropTarget,
): { row: RecentTabDropRow; side: "top" | "bottom" } | null {
	if (target.kind === "member-before" || target.kind === "member-after") {
		const row = rows.find((candidate) => candidate.key === target.key);
		return row ? { row, side: target.kind === "member-before" ? "top" : "bottom" } : null;
	}
	if (target.kind !== "before" && target.kind !== "after") return null;
	const unit = rows.filter((row) => unitKeyOf(row) === target.key);
	const row = target.kind === "before" ? unit[0] : unit.at(-1);
	return row ? { row, side: target.kind === "before" ? "top" : "bottom" } : null;
}
