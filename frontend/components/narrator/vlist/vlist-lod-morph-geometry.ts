/**
 * Document-space geometry for the two LOD morph planners.
 *
 * Published items/specs/measurements and exact layouts are immutable snapshots. Scroll
 * commits change admission and origins, not these sources. Keep only the latest committed
 * geometry; the shell must still roll both planners' baselines forward on every commit.
 */

import type { PretextLayoutIndex } from "@shared/pretext-layout";
import type { ListLayout } from "@shared/pretext-layout/vlist-virtualization";
import type { LodElementSource } from "./vlist-lod-morph";
import type { MorphElement } from "./vlist-morph-plan";
import type { VListItem } from "./vlist-pipeline";

export interface LodMorphGeometryInput {
	readonly narratorId: string;
	readonly items: readonly VListItem[];
	readonly layout: ListLayout;
	/** Same key-to-measurement binding as the shell's current measured getter. */
	readonly index: Pick<PretextLayoutIndex, "itemByKey"> | undefined;
}

export interface LodMorphGeometry {
	readonly elements: readonly LodElementSource[];
	readonly unifiedElements: readonly MorphElement[];
}

/**
 * Reuse the keyframe path's element list for the unified planner.
 *
 * Only the unit-box field name differs (`groupBox` → `unitBox`); `MorphElement` needs no
 * `unitAnchored` flag because it always prefers a unit box when one is present. Module-level
 * so the per-frame roll-forward does not re-allocate a closure on every commit.
 */
function toMorphElements(src: readonly LodElementSource[]): MorphElement[] {
	return src.map((el) => ({
		unitId: el.unitId,
		key: el.key,
		kind: el.kind,
		top: el.top,
		height: el.height,
		clip: el.clip ?? null,
		nested: el.nested,
		unitBox: el.groupBox ?? null,
	}));
}
/** Pure construction; no viewport crop and no mutation of an earlier frame's boxes. */
export function buildLodMorphGeometry(input: LodMorphGeometryInput): LodMorphGeometry {
	const { items, layout, index: documentIndex } = input;
	const elements: LodElementSource[] = [];
	/**
	 * Box of the render-UNIT each item belongs to, spanning all of its specs.
	 *
	 * The admission window has to judge one unit's content the same way at both levels,
	 * and the two forms differ enormously: at L1/L2 an activity unit is a single short
	 * fold, at L3+ it is a stack of full cards spanning thousands of pixels. Judged on
	 * their own boxes, the unit's later CARDS fall outside the window in the expanded
	 * frame while its ROWS all sit inside it in the folded one — so those members have
	 * no counterpart and are planned nothing, silently.
	 *
	 * Grouping comes from `spec.morphGroupId`, which the layout assigns from the
	 * activity grouping that applies at a low LOD — computed at every level, so both
	 * sides agree on the membership. See the note on the loop below.
	 */
	const unitBoxes: Array<{ top: number; height: number } | null> = new Array(items.length).fill(
		null,
	);
	{
		// One SHARED, mutable box per unit: every index in a unit points at the same
		// object, so growing it as later specs are seen retroactively widens the box the
		// earlier ones already reference.
		//
		// ⚠️ Grouped by `spec.morphGroupId`, NOT by `spec.unitStart`.
		//
		// `unitStart` marks the first spec of each RENDER unit, and at L3+ grouping is
		// off (`groupRenderUnits(segments, lod <= 2)`), so every spec starts its own
		// unit and the flag is true for all of them. The box then degenerated to each
		// element's OWN box — exactly what it exists to avoid. Measured on a 12-tool
		// group at scrollTop 9500: 3 of 12 members paired with the degenerate box
		// versus all 12 with the real group box.
		//
		// `morphGroupId` is computed from the activity grouping that would apply at a
		// low LOD regardless of the current level (see buildPretextDocumentLayout), so
		// the members of one group share it at BOTH levels and the box spans the whole
		// group on each side. Specs outside any activity group have none and fall back
		// to their own box, which is correct for them: their two forms are the same
		// element.
		const boxes = new Map<string, { top: number; height: number }>();
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			const g = layout.items[i];
			if (!it || !g) continue;
			const groupId = it.spec.morphGroupId;
			if (!groupId) {
				unitBoxes[i] = { top: g.top, height: g.height };
				continue;
			}
			const existing = boxes.get(groupId);
			if (!existing) {
				const box = { top: g.top, height: g.height };
				boxes.set(groupId, box);
				unitBoxes[i] = box;
				continue;
			}
			// Mutated in place so the members already pointing at this box widen with it.
			existing.height = Math.max(existing.height, g.top + g.height - existing.top);
			unitBoxes[i] = existing;
		}
	}
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const geo = layout.items[index];
		if (!item || !geo) continue;
		// `key` and `kind` travel with `unitId`: the planner pairs on `unitId ?? key`
		// (so the document body — markdown, bubbles, system cards — is no longer
		// skipped for want of a unitId) and reads `kind` to decide whether the morph
		// is a component swap worth cross-fading. See vlist-lod-morph.ts.
		elements.push({
			unitId: item.spec.unitId,
			key: item.spec.key,
			kind: item.spec.kind,
			top: geo.top,
			height: geo.height,
			// Anchored to the whole unit, so a tool CARD at L3+ is admitted on the same
			// basis as the folded ROW it pairs with at L1/L2. Without this the fix on the
			// folded side alone changes nothing: the card is a top-level element with its
			// own tall box, so the unit's later cards still prune themselves out of the
			// expanded frame and still have no counterpart.
			groupBox: unitBoxes[index],
			unitAnchored: true,
		});
		// The L2/L3 boundary: a tool call is a summary ROW inside this trace at L1/L2
		// and a top-level CARD at L3+, both carrying the same `unitId`. Without the
		// nested rows the pairing has an empty intersection exactly at the switch that
		// changes the most, so nothing animates where it matters.
		//
		// `clip` is the item's own painted box: the shell clips a non-dynamic row to
		// its arithmetic height, so a nested row animated from far outside that box
		// would be invisible mid-flight. The planner drops the travel (keeping the
		// fade) for that case — see clipFor.
		const measuredIndex = documentIndex?.itemByKey(item.spec.key)?.index;
		const measured = (measuredIndex == null ? undefined : items[measuredIndex]?.measured) as
			| { rows?: { top: number; rowHeight: number; unitId?: string }[] }
			| undefined;
		if (!measured?.rows) continue;
		const clip = { top: geo.top, bottom: geo.top + geo.height };
		for (const row of measured.rows) {
			if (!row.unitId) continue;
			elements.push({
				unitId: row.unitId,
				// A row key is scoped to its trace, so it is not a usable cross-level
				// identity; `nested` tells the builder not to fall back to it.
				key: row.unitId,
				// The kind the ROW is, not the trace's: pairing it against the card's
				// `tool-call` is what marks this morph as a re-theme worth fading.
				kind: "trace-row",
				top: geo.top + row.top,
				// The title LINE, not the row block: a drilled-in row's block is a whole
				// card tall, and the perceived thing that moves is the summary line.
				height: row.rowHeight,
				clip,
				nested: true,
				// Admission is decided by the GROUP's box, not this row's. At L3+ the same
				// content spans an order of magnitude more height (10 rows of 19px become
				// 10 cards of ~400px), so judged on their own boxes the later members fall
				// outside the ×3 window in the expanded frame only — no counterpart, no
				// plan, and the reader sees the first few rows animate while the rest
				// teleport. The group's box is short and stable at both levels.
				groupBox: { top: geo.top, height: geo.height },
			});
		}
	}
	return { elements, unifiedElements: toMorphElements(elements) };
}

/**
 * Single-entry, list-local cache. Call get only from the committed layout effect, never
 * during render: an abandoned concurrent render must not publish a morph baseline.
 *
 * Items change on content/spec/measurement builds, including same-height resize previews;
 * layouts change on index/height overrides. Index identity additionally protects the
 * key-to-measurement binding. No scroll, viewport height, preference or documentRevision
 * is a geometry key. Those frame-dependent values remain the shell's responsibility.
 */
export function createLodMorphGeometryCache() {
	let current: (LodMorphGeometryInput & { readonly geometry: LodMorphGeometry }) | undefined;
	return {
		get(input: LodMorphGeometryInput): LodMorphGeometry {
			if (
				current &&
				current.narratorId === input.narratorId &&
				current.items === input.items &&
				current.layout === input.layout &&
				current.index === input.index
			) {
				return current.geometry;
			}
			const geometry = buildLodMorphGeometry(input);
			current = {
				narratorId: input.narratorId,
				items: input.items,
				layout: input.layout,
				index: input.index,
				geometry,
			};
			return geometry;
		},
	};
}
