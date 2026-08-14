/**
 * vlist-lod-morph.ts — The PURE arithmetic behind LOD-switch morphs, driven by a
 * DECLARATIVE element-level diff (same paradigm as vlist-drill-morph, but the
 * pairing key is `unitId` and the scope is the element layer).
 *
 * ## Why a separate channel
 *
 * The fold transition pairs rows by `spec.key` and the drill morph pairs trace rows
 * by `traceKey::rowKey`; BOTH identities dissolve on an LOD switch, because the
 * rebuild mints new keys/kinds for every element (a tool call becomes `tool-call`
 * at L4+, a `tool-run-summary` row at L3, an `activity-trace` row at L1/L2). What
 * survives is `unitId` (`tool-<toolUseId>`), the LOD-independent identity the
 * adapter attaches precisely so two renderings of one call can be paired across a
 * level change.
 *
 * So an LOD switch is diffed HERE, on the element layer, keyed by `unitId`:
 * snapshot every unitId-bearing element in the viewport×3 window before and after,
 * pair by unitId, and morph each pair from its old screen position to its new one.
 *
 * ## Scope: viewport ×3, all in one frame
 *
 * Only elements intersecting `scrollTop ± viewportHeight` (one screen above, the
 * viewport, one screen below) are snapshotted — an LOD switch re-themes the whole
 * document, and morphing off-screen elements is wasted work. All paired morphs play
 * in the SAME frame (no stagger), per the product decision.
 *
 * Pure data, zero DOM: every number comes from the exact layout's own offsets.
 */

/** How long an LOD morph lasts. Slightly longer than a fold: a level switch re-themes many elements at once. */
export const LOD_MORPH_DURATION_MS = 250;

/** One unitId-bearing element's geometry at a committed frame, in viewport px. */
export interface LodElementSnapshot {
	readonly unitId: string;
	/** Element's top edge in VIEWPORT px (document top − scrollTop). */
	readonly viewportTop: number;
	/** Element's committed height (px). */
	readonly height: number;
}

/** The minimal shape the snapshot builder needs from one laid-out element. */
export interface LodElementSource {
	readonly unitId: string | null | undefined;
	/** Element's top in DOCUMENT px (from the exact layout). */
	readonly top: number;
	readonly height: number;
}

/** What `diffLodSnapshots` produces for one paired element. */
export interface LodMorphPlan {
	readonly unitId: string;
	/**
	 * Vertical distance from the element's OLD screen position to its NEW one. The
	 * DOM edge starts the (new) node at `translateY(deltaY)` and settles it at 0.
	 */
	readonly deltaY: number;
	readonly durationMs: number;
}

/**
 * Snapshot every unitId-bearing element whose [top, bottom) intersects the
 * viewport×3 window, keyed by unitId.
 *
 * `viewportHeight` doubles as the overscan: the window is `scrollTop −
 * viewportHeight` to `scrollTop + 2·viewportHeight` — one screen above, the
 * viewport, one screen below. Elements without a unitId are skipped (markdown
 * bodies, system cards): they carry no cross-level identity to pair, and their
 * position continuity rides on the paired elements' morphs.
 */
export function buildLodSnapshots(
	elements: readonly LodElementSource[],
	scrollTop: number,
	viewportHeight: number,
): Map<string, LodElementSnapshot> {
	const out = new Map<string, LodElementSnapshot>();
	const minY = scrollTop - viewportHeight;
	const maxY = scrollTop + viewportHeight * 2;
	for (const el of elements) {
		if (!el.unitId) continue;
		const bottom = el.top + el.height;
		if (bottom <= minY || el.top >= maxY) continue;
		// First occurrence wins: a duplicated unitId (a degenerate double-render)
		// morphs to its first instance; the rest simply appear.
		if (out.has(el.unitId)) continue;
		out.set(el.unitId, {
			unitId: el.unitId,
			viewportTop: el.top - scrollTop,
			height: el.height,
		});
	}
	return out;
}

/**
 * Pair two committed snapshots by unitId and plan each pair's morph.
 *
 * An element morphs only when it exists in BOTH frames (a level switch keeps the
 * same content, so a unitId present in both is the same call in two forms) AND its
 * screen position actually moved. A unitId in only one frame — a call that has no
 * unitId-bearing form at one level, or that scrolled out of the ×3 window — has no
 * counterpart to morph between and simply appears.
 */
export function diffLodSnapshots(
	prev: ReadonlyMap<string, LodElementSnapshot>,
	next: ReadonlyMap<string, LodElementSnapshot>,
): LodMorphPlan[] {
	const out: LodMorphPlan[] = [];
	for (const [unitId, after] of next) {
		const before = prev.get(unitId);
		if (!before) continue;
		const deltaY = before.viewportTop - after.viewportTop;
		// A sub-pixel move is invisible; animating it only costs a composited layer.
		if (Math.abs(deltaY) < 1) continue;
		out.push({ unitId, deltaY, durationMs: LOD_MORPH_DURATION_MS });
	}
	return out;
}
