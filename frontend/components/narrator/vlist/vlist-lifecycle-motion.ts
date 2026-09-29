/**
 * vlist-lifecycle-motion.ts — The PURE arithmetic behind LIFECYCLE transitions: an
 * element changing shape because its CONTENT moved to another phase, with no reader
 * action behind it.
 *
 * ## Why a third channel
 *
 * The canvas already animates two kinds of change, and both are gated on the reader:
 *
 *  - a FOLD plays only for the commit a click produced (a capture taken in the click
 *    handler, consumed by that click's rebuild);
 *  - an LOD MORPH plays only for a commit whose level moved.
 *
 * Everything else is deliberately instant (CONTRACT §4.6: a global transition would turn
 * every live patch, page and width settle into visible motion, and those rebuilds are
 * anchored precisely so they are NOT seen). That left the lifecycle of a live call with
 * no transition at all, although it is exactly where the reader's eye is:
 *
 *  - L3+: a running card is force-expanded, and the moment it finishes it snaps to its
 *    header — a card of several hundred pixels vanishing in one frame;
 *  - L3+: a live reasoning card is shown expanded, and the moment it persists it snaps
 *    to its collapsed header;
 *  - L1/L2: a call blocked on a permission request is drilled open onto its card for the
 *    form, and closes again once the request is answered.
 *
 * ## What qualifies — an enumerated SHAPE signature, never "any height change"
 *
 * Growth from content arriving (stdout, a streaming body, a fetched payload) must stay
 * instant, or the list would animate itself on every delta. So an element takes part
 * only when its SHAPE flipped — the discrete state that decides which of its forms is
 * painted — and the signature enumerates exactly those states per kind:
 *
 *  - `tool-call`:      open/closed, and whether a permission form is reserved (not its height)
 *  - `subagent-card`:  open/closed
 *  - `reasoning`:      its form (streaming / count / collapsed / expanded)
 *  - `activity-trace`: per nested row, whether it is drilled open
 *
 * Every other kind has no signature and can never trigger a plan. An element present
 * in only one frame (it appeared, or left the window) has nothing to transition from.
 *
 * The geometry the plan animates is the same fold arithmetic the reader's clicks use
 * (`planFoldMotion` with a SET of toggled elements, `planFoldNestedRowMotion`,
 * `planFoldNestedRowResize`), so a lifecycle collapse is indistinguishable from the
 * reader clicking the chevron — the header stays still, the body goes, and everything
 * below closes the gap in the same 200ms.
 *
 * ## Pairing across the hand-off
 *
 * A live content block keys as `__streaming__-b<i>` and its persisted copy as
 * `<msgId>-b<j>`, so the SAME reasoning run has two keys on either side of the
 * moment it settles. Elements are therefore paired by `lifecycleId ?? key` (a modern
 * block's global id, `blk:<id>`), and the kind must match as well — the key-only
 * fallback cannot tell a live reasoning card from the answer text that inherits its
 * streaming index one frame later, and pairing those would be worse than not animating.
 *
 * Pure: plain numbers in, plans out. No DOM, no React.
 */

import {
	type FoldNestedRowMotion,
	type FoldNestedRowResize,
	type FoldNestedRowsSnapshot,
	type FoldRowGeometry,
	type FoldRowMotion,
	planFoldMotion,
	planFoldNestedRowMotion,
	planFoldNestedRowResize,
} from "./vlist-fold-animation";

/** One top-level element as it was committed. */
export interface LifecycleElementSource {
	/** `spec.key` — also the element's `data-nf-row-key`, i.e. how its node is found. */
	readonly key: string;
	readonly kind: string;
	/** Hand-off-stable identity (`ElementSpec.lifecycleId`), when it has one. */
	readonly lifecycleId?: string;
	/** Document px. */
	readonly top: number;
	readonly height: number;
	/** The element's measured payload, read for its shape signature. */
	readonly measured: unknown;
}

/** One element of a snapshot, keyed by its pairing identity. */
export interface LifecycleElement {
	/** The node key the op resolves (`data-nf-row-key` / `data-nf-row-body`). */
	readonly domKey: string;
	readonly kind: string;
	readonly geometry: FoldRowGeometry;
	/** Top-level shape signature, or null for a kind that never transitions. */
	readonly signature: string | null;
	/** For an activity trace: its nested rows (local geometry + drill flag). */
	readonly nested: ReadonlyMap<string, LifecycleNestedRow> | null;
}

export interface LifecycleNestedRow {
	readonly top: number;
	readonly height: number;
	readonly drilled: boolean;
}

/** A committed frame, keyed by `lifecycleId ?? key`. */
export type LifecycleSnapshot = ReadonlyMap<string, LifecycleElement>;

/** The pairing identity of an element. */
export function lifecycleIdentity(source: Pick<LifecycleElementSource, "key" | "lifecycleId">) {
	return source.lifecycleId ?? source.key;
}

/**
 * The SHAPE of an element — the discrete state that selects which of its forms paints —
 * or null for a kind that has no lifecycle transition.
 *
 * Reads only primitives off the measured payload; O(1) per element except the trace's
 * nested rows, which are handled separately.
 */
export function lifecycleShapeSignature(kind: string, measured: unknown): string | null {
	if (measured == null || typeof measured !== "object") return null;
	const m = measured as Record<string, unknown>;
	switch (kind) {
		case "tool-call": {
			// Only WHETHER a form is reserved is shape; its height is content. A reported
			// painted height correcting the prediction, or the reader typing a second line of
			// feedback, must stay instant like any other content growth.
			const form = typeof m.permissionFormHeight === "number" ? m.permissionFormHeight : 0;
			return `${m.effectiveOpened === true ? "open" : "closed"}|pf:${form > 0 ? 1 : 0}`;
		}
		case "subagent-card":
			return m.effectiveExpanded === true ? "open" : "closed";
		case "reasoning":
			return typeof m.form === "string" ? m.form : null;
		default:
			return null;
	}
}

/** Build a committed frame's snapshot from the mounted elements. */
export function buildLifecycleSnapshot(
	elements: readonly LifecycleElementSource[],
): LifecycleSnapshot {
	const out = new Map<string, LifecycleElement>();
	const collided = new Set<string>();
	for (const element of elements) {
		const identity = lifecycleIdentity(element);
		// Elements sharing one identity cannot be told apart; none of them is paired —
		// including a third one, which must not slip back in after the first two left.
		if (collided.has(identity)) continue;
		if (out.has(identity)) {
			out.delete(identity);
			collided.add(identity);
			continue;
		}
		out.set(identity, {
			domKey: element.key,
			kind: element.kind,
			geometry: { top: element.top, height: element.height },
			signature: lifecycleShapeSignature(element.kind, element.measured),
			nested: element.kind === "activity-trace" ? nestedRowsOf(element.measured) : null,
		});
	}
	return out;
}

function nestedRowsOf(measured: unknown): ReadonlyMap<string, LifecycleNestedRow> | null {
	const rows = (measured as { rows?: unknown } | null | undefined)?.rows;
	if (!Array.isArray(rows)) return null;
	const out = new Map<string, LifecycleNestedRow>();
	for (const row of rows) {
		if (row == null || typeof row !== "object") continue;
		const r = row as {
			key?: unknown;
			top?: unknown;
			blockHeight?: unknown;
			cardMeasured?: unknown;
		};
		if (typeof r.key !== "string" || typeof r.top !== "number") continue;
		if (typeof r.blockHeight !== "number") continue;
		out.set(r.key, { top: r.top, height: r.blockHeight, drilled: r.cardMeasured != null });
	}
	return out;
}

/** The plan for one lifecycle commit. */
export interface LifecyclePlan {
	/** Top-level motions, keyed by the elements' DOM keys. */
	readonly rows: FoldRowMotion[];
	readonly nestedMotions: FoldNestedRowMotion[];
	readonly nestedResizes: FoldNestedRowResize[];
}

const EMPTY_PLAN: LifecyclePlan = { rows: [], nestedMotions: [], nestedResizes: [] };

/**
 * Diff two committed frames and plan the lifecycle transition, if any.
 *
 * Returns an empty plan unless at least one paired element's shape flipped. When one
 * did, the flipped elements are the "toggled" set and every paired element's visible
 * displacement is planned with them — exactly what a click on those elements would
 * have produced, so the rows below a collapsing card close the gap with it instead of
 * teleporting.
 *
 * `beforeScrollTop` / `afterScrollTop` put the comparison in VIEWPORT coordinates
 * (see `planFoldMotion`): an anchored rebuild that held the content still on screen
 * yields no shift at all.
 */
export function planLifecycleMotion(input: {
	readonly before: LifecycleSnapshot;
	readonly after: LifecycleSnapshot;
	readonly beforeScrollTop: number;
	readonly afterScrollTop: number;
}): LifecyclePlan {
	const { before, after } = input;
	const toggled = new Set<string>();
	const beforeGeometry = new Map<string, FoldRowGeometry>();
	const afterGeometry = new Map<string, FoldRowGeometry>();
	const beforeNested = new Map<string, FoldNestedRowsSnapshot>();
	const afterNested = new Map<string, FoldNestedRowsSnapshot>();
	for (const [identity, next] of after) {
		const prev = before.get(identity);
		// A kind change is a component swap (e.g. a folded batch becoming cards), which
		// is not a lifecycle transition and has no shared geometry to animate.
		if (!prev || prev.kind !== next.kind) continue;
		// Both frames address the element by its CURRENT dom key: the op resolves the
		// node committed now, and a key that moved at the hand-off is still one element.
		beforeGeometry.set(next.domKey, prev.geometry);
		afterGeometry.set(next.domKey, next.geometry);
		if (next.signature !== null && prev.signature !== next.signature) toggled.add(next.domKey);
		if (prev.nested && next.nested) {
			let drillFlipped = false;
			for (const [rowKey, row] of next.nested) {
				const prevRow = prev.nested.get(rowKey);
				if (prevRow && prevRow.drilled !== row.drilled) {
					drillFlipped = true;
					break;
				}
			}
			if (drillFlipped) {
				toggled.add(next.domKey);
				beforeNested.set(next.domKey, { rows: prev.nested });
				afterNested.set(next.domKey, { rows: next.nested });
			}
		}
	}
	if (toggled.size === 0) return EMPTY_PLAN;
	return {
		rows: planFoldMotion({
			before: beforeGeometry,
			after: afterGeometry,
			toggledKeys: toggled,
			beforeScrollTop: input.beforeScrollTop,
			afterScrollTop: input.afterScrollTop,
		}),
		nestedMotions: planFoldNestedRowMotion({ before: beforeNested, after: afterNested }),
		nestedResizes: planFoldNestedRowResize({ before: beforeNested, after: afterNested }),
	};
}
