/**
 * vlist-lod-morph.ts — The PURE arithmetic behind LOD-switch morphs, driven by a
 * DECLARATIVE element-level diff (same paradigm as vlist-drill-morph, but the
 * scope is the element layer).
 *
 * ## Why a separate channel
 *
 * The fold transition pairs rows by `spec.key` within ONE level and the drill morph
 * pairs trace rows by `traceKey::rowKey`; neither is planned across a level switch,
 * because the rebuild re-themes an element into a DIFFERENT component (a tool call
 * is a `tool-call` card at L3+ and a folded row inside an `activity-trace` at
 * L1/L2). So an LOD switch is diffed HERE, on the element layer: snapshot the
 * viewport×3 window before and after, pair, and morph each pair from its old screen
 * position to its new one.
 *
 * ## Pairing identity: `unitId ?? key`
 *
 * Two kinds of element need pairing and they need different identities:
 *
 *  - **Re-themed content** — a tool call / subagent card whose `spec.key` really is
 *    minted per level (a folded batch keys as `toolrun-count-tool-<id>` off its first
 *    member). For these the adapter attaches `unitId` (`tool-<toolUseId>`), the
 *    LOD-independent identity that exists precisely so the two renderings pair.
 *  - **Everything else** — markdown bodies, user bubbles, system cards, turn-usage
 *    rows, dividers. These carry NO `unitId`, and used to be skipped outright, which
 *    is what made a level switch half-smooth: the cards eased into place while the
 *    document body they sit in teleported. Their `spec.key` is already LOD-invariant
 *    by construction (`${msgId}-b{blockIndex}`, `${msgId}-bubble`, `${idBase}-sys`,
 *    `${idBase}-usage-*` — none of those strings mention the level), so `key` IS
 *    their cross-level identity and no new id has to be minted.
 *
 * `unitId` takes precedence where present. The two namespaces cannot collide:
 * wherever the adapter sets `unitId` it sets it TO the element's own `key`
 * (`adaptToolItemFull`), so a `unitId` is never a string some other element uses as
 * its `key`. A key that exists at only one level (`toolrun-count-*`, `activity-*`)
 * simply finds no counterpart and appears — it cannot pair with the wrong element.
 *
 * ## Only a re-theme fades
 *
 * A morph carries `fade` so the DOM edge knows which of two visually different
 * things it is doing. The cross-fade exists to MASK A COMPONENT SWAP; a markdown
 * body that merely moved is the same component with the same content, and fading it
 * would make unchanged prose blink — worse than not animating it at all. So `fade`
 * is set only when the element's `kind` actually changed.
 *
 * ## Scope: viewport ×3, all in one frame
 *
 * Only elements intersecting `scrollTop ± viewportHeight` (one screen above, the
 * viewport, one screen below) are snapshotted — an LOD switch re-themes the whole
 * document, and morphing off-screen elements is wasted work. All paired morphs play
 * in the SAME frame (no stagger), per the product decision.
 *
 * ## The L2/L3 boundary: rows INSIDE a folded trace pair too
 *
 * This is the boundary with the largest visual jump, because it is the one where the
 * component genuinely changes: a tool call is a summary ROW inside an `activity-trace`
 * at L1/L2 and a full CARD at L3+. Both renderings carry the same `unitId`
 * (`tool-<toolUseId>`), so the pairing is 1:1 — one row to one card — and the trace
 * element containing them is not itself a participant.
 *
 * So nested rows are snapshotted alongside top-level elements, with their geometry
 * lifted into document space (`traceTop + row.top`).
 *
 * ## Why the two directions are NOT symmetric
 *
 * A nested row is absolutely positioned inside its trace element, and the shell clips
 * an item to its arithmetic height (`overflow: hidden`, the non-dynamic row path). A
 * top-level card is clipped by nothing. Since a morph animates the NEW node, which
 * node is clipped depends on which way the reader zoomed:
 *
 *  - **L2 → L3 (row → card).** The new node is the top-level card: unclipped, free to
 *    travel from wherever the row was. This is the direction that gets a full slide.
 *  - **L3 → L2 (card → row).** The new node is the nested row, clipped to its trace's
 *    box. The card it came from is usually far outside that box, so translating the row
 *    there would put it under the clip and make it vanish for the duration — a blink,
 *    which reads worse than a jump.
 *
 * Rather than open the clip for the duration (exactly the cleanup path `fill: "none"`
 * was chosen to eliminate, and one that would let a row paint over its neighbours), a
 * morph whose start box falls outside its own clip keeps the fade and drops the slide:
 * `deltaY: 0, fade: true`. The reader still gets a cross-fade tying the two forms
 * together at the row's committed position, which is the part that carries the
 * identity; only the travel is given up, and only where it could not have been seen.
 *
 * `clipFor` is what makes that decision, and it is deliberately made HERE rather than
 * at the DOM edge: it is arithmetic over offsets the layout already published, so it
 * stays testable and the player stays a dumb WAAPI edge.
 *
 * Pure data, zero DOM: every number comes from the exact layout's own offsets.
 */

/** How long an LOD morph lasts. Slightly longer than a fold: a level switch re-themes many elements at once. */
export const LOD_MORPH_DURATION_MS = 250;

/**
 * Largest on-screen displacement (px) still worth animating.
 *
 * Same bound, and the same reasoning, as the fold transition's `FOLD_MAX_SHIFT_PX`:
 * sliding across tens of thousands of pixels in 250ms is a blur rather than a
 * transition, and it costs the reader the line they were on. Past this the element
 * simply appears at its committed offset.
 *
 * This matters more here than it does for a fold. Collapsing L5 → L1 turns a
 * multi-thousand-pixel card stack into a handful of 19px rows, so the elements below
 * it can travel arbitrarily far — and now that the pairing covers the whole document
 * body (see above), without a bound they would ALL try to.
 *
 * The accepted cost: an element past the bound teleports while its under-bound
 * neighbour eases, so a very large switch tears in places. The fold transition has
 * lived with the same trade since it shipped, on the grounds that a displacement that
 * large does not read as motion anyway.
 */
export const LOD_MORPH_MAX_SHIFT_PX = 2000;

/**
 * The vertical bounds a node is clipped to by its ancestor, in the same coordinate
 * space as the snapshot that carries it.
 *
 * Only NESTED nodes have one: a trace row is absolutely positioned inside its element,
 * and the shell clips an item to its arithmetic height. A top-level element is clipped
 * by nothing and carries `null`.
 */
export interface LodClipBounds {
	readonly top: number;
	readonly bottom: number;
}

/** One pairable element's geometry at a committed frame, in viewport px. */
export interface LodElementSnapshot {
	/** Cross-level identity: the source's `unitId` when it has one, else its `key`. */
	readonly unitId: string;
	/**
	 * The element's registry kind at this frame. Compared across the two frames to
	 * tell a component SWAP (fade) from a plain move (no fade).
	 */
	readonly kind: string;
	/** Element's top edge in VIEWPORT px (document top − scrollTop). */
	readonly viewportTop: number;
	/** Element's committed height (px). */
	readonly height: number;
	/**
	 * The clip this node lives inside, in VIEWPORT px, or null when unclipped.
	 *
	 * Consulted on the AFTER side only: it bounds where the new node may be animated
	 * FROM, since that is the node the morph actually writes to. See `clipFor`.
	 */
	readonly clip: LodClipBounds | null;
}

/** The minimal shape the snapshot builder needs from one laid-out element. */
export interface LodElementSource {
	/** LOD-independent content identity, when the adapter attached one. */
	readonly unitId: string | null | undefined;
	/**
	 * The element's `spec.key`. Serves as the pairing identity for everything with
	 * no `unitId` — those keys are already LOD-invariant (see the module note).
	 */
	readonly key: string;
	/** The element's `spec.kind`, carried so the diff can detect a re-theme. */
	readonly kind: string;
	/** Element's top in DOCUMENT px (from the exact layout). */
	readonly top: number;
	readonly height: number;
	/**
	 * The clipping ancestor's bounds in DOCUMENT px, for a NESTED node (a trace row).
	 * Omitted / null for a top-level element, which nothing clips.
	 */
	readonly clip?: LodClipBounds | null;
	/**
	 * True for a node reached THROUGH a container rather than as a document item (a
	 * trace row). Such a node only ever pairs on `unitId`: its row `key` is scoped to
	 * its trace, so pairing it on `key` could collide with a top-level element's.
	 */
	readonly nested?: boolean;
}

/** What `diffLodSnapshots` produces for one paired element. */
export interface LodMorphPlan {
	readonly unitId: string;
	/**
	 * Vertical distance from the element's OLD screen position to its NEW one. The
	 * DOM edge starts the (new) node at `translateY(deltaY)` and settles it at 0.
	 */
	readonly deltaY: number;
	/**
	 * Whether the morph should cross-fade as well as slide.
	 *
	 * True when the element's `kind` changed, i.e. the level switch replaced the
	 * component and the fade has a swap to mask. False for an element that merely
	 * moved — fading unchanged content makes it blink (see the module note).
	 *
	 * Also true, with `deltaY: 0`, for a re-theme whose travel had to be dropped
	 * because the start box fell outside the new node's own clip.
	 */
	readonly fade: boolean;
	readonly durationMs: number;
}

/**
 * Whether a node may be animated from `fromTop` without disappearing under its clip.
 *
 * A morph starts the NEW node displaced by `deltaY` and settles it at 0. If that
 * displaced box lies wholly outside the clip its ancestor imposes, the reader sees
 * nothing until the animation is nearly over — a blink. An unclipped node (`null`) can
 * always travel.
 *
 * "Wholly outside" is the right test rather than "fully inside": a row sliding in from
 * a partially-clipped position is still visible arriving, which is the point of the
 * slide. Only a start box with NO overlap at all is rejected.
 */
export function clipFor(clip: LodClipBounds | null, fromTop: number, height: number): boolean {
	if (!clip) return true;
	return fromTop < clip.bottom && fromTop + height > clip.top;
}

/**
 * Snapshot every element whose [top, bottom) intersects the viewport×3 window,
 * keyed by its cross-level identity (`unitId ?? key` — see the module note).
 *
 * `viewportHeight` doubles as the overscan: the window is `scrollTop −
 * viewportHeight` to `scrollTop + 2·viewportHeight` — one screen above, the
 * viewport, one screen below.
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
		// `unitId` wins where the adapter attached one (a re-themed tool call); every
		// top-level element pairs on its already LOD-invariant `key`. A NESTED row has
		// no such fallback: its row key is scoped to its trace, so pairing it on `key`
		// could collide with an unrelated top-level element's.
		const identity = el.nested ? el.unitId : el.unitId || el.key;
		if (!identity) continue;
		const bottom = el.top + el.height;
		if (bottom <= minY || el.top >= maxY) continue;
		// First occurrence wins: a duplicated identity (a degenerate double-render)
		// morphs to its first instance; the rest simply appear.
		if (out.has(identity)) continue;
		out.set(identity, {
			unitId: identity,
			kind: el.kind,
			viewportTop: el.top - scrollTop,
			height: el.height,
			// Viewport space, same as `viewportTop`, so the diff can compare a start box
			// against it without re-deriving the frame.
			clip: el.clip ? { top: el.clip.top - scrollTop, bottom: el.clip.bottom - scrollTop } : null,
		});
	}
	return out;
}

/**
 * Pair two committed snapshots and plan each pair's morph.
 *
 * An element morphs only when it exists in BOTH frames (a level switch keeps the
 * same content, so an identity present in both is the same content in two forms) AND
 * its screen position moved by a readable, bounded distance. An identity in only one
 * frame — an element with no counterpart at the other level, or one that scrolled out
 * of the ×3 window — has nothing to morph between and simply appears.
 */
export function diffLodSnapshots(
	prev: ReadonlyMap<string, LodElementSnapshot>,
	next: ReadonlyMap<string, LodElementSnapshot>,
): LodMorphPlan[] {
	const out: LodMorphPlan[] = [];
	for (const [unitId, after] of next) {
		const before = prev.get(unitId);
		if (!before) continue;
		// Only a real component swap gets the masking cross-fade.
		const fade = before.kind !== after.kind;
		const deltaY = before.viewportTop - after.viewportTop;
		if (!Number.isFinite(deltaY)) continue;
		const distance = Math.abs(deltaY);
		// A sub-pixel move is invisible; animating it only costs a composited layer.
		// A re-theme in place is the exception: the swap itself is worth fading even
		// though nothing travelled (an activity fold re-themes at deltaY ≈ 0).
		if (distance < 1) {
			if (fade) out.push({ unitId, deltaY: 0, fade: true, durationMs: LOD_MORPH_DURATION_MS });
			continue;
		}
		// Past the bound the slide is a blur, not a transition (see the constant). A
		// re-theme still fades in place rather than losing the transition entirely.
		if (distance > LOD_MORPH_MAX_SHIFT_PX) {
			if (fade) out.push({ unitId, deltaY: 0, fade: true, durationMs: LOD_MORPH_DURATION_MS });
			continue;
		}
		// Would the new node start outside its own clip? Then it would be invisible for
		// most of the animation, so keep the fade and drop the travel. This is the
		// L3 → L2 direction: the new node is a nested row, its counterpart a card far
		// outside the trace's box (see the module note on the asymmetry).
		if (!clipFor(after.clip, after.viewportTop + deltaY, after.height)) {
			if (fade) out.push({ unitId, deltaY: 0, fade: true, durationMs: LOD_MORPH_DURATION_MS });
			continue;
		}
		out.push({ unitId, deltaY, fade, durationMs: LOD_MORPH_DURATION_MS });
	}
	return out;
}
