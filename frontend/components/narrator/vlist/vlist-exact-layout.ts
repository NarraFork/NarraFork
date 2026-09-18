/**
 * vlist-exact-layout.ts — the exact-layout shell's geometry helpers.
 *
 * Extracted from `PretextExactMessageList.tsx` unchanged. Everything here turns the
 * published layout index into the numbers the shell renders with: item boxes, hit
 * boxes, decorative tool-run frames, and the small identity/escaping helpers the fold
 * transition keys its animations on.
 *
 * Pure by construction — no DOM reads, no React. That is deliberate rather than
 * incidental: these values ARE the height model, so a measurement creeping in here
 * would make the browser a second source of truth for a geometry the pretext path
 * owns (CONTRACT.md §0 rule 2).
 */

import type { PretextLayoutIndex } from "@shared/pretext-layout";
import type { LaidOutItem, ListLayout } from "@shared/pretext-layout/vlist-virtualization";
import type { VListItem } from "./vlist-pipeline";

/** Project the shared prefix index into absolute-position item boxes. */
export function buildExactListLayout(
	index: PretextLayoutIndex | undefined,
): ListLayout | undefined {
	if (!index) return undefined;
	const items: LaidOutItem[] = index.itemStarts.map((top, itemIndex) => {
		const end = index.itemEnds[itemIndex] ?? top;
		return { top, height: Math.max(0, end - top), bottom: end };
	});
	return { items, totalHeight: index.totalHeight };
}

/**
 * Memo term for one trace's closing rows (see `closingRows`).
 *
 * Sorted so the string is order-independent — a Set's iteration order follows insertion,
 * and two identical closing sets built in different orders must not look like a change.
 * Empty string when nothing in this trace is closing, which is the overwhelming majority
 * of rows at any moment.
 */
export function closingRowSig(
	closing: ReadonlyMap<string, ReadonlySet<string>>,
	key: string,
): string {
	const rows = closing.get(key);
	if (!rows || rows.size === 0) return "";
	return [...rows].sort().join(",");
}

/**
 * Height of a row's HIT box — the row's own height PLUS the gap below it, so
 * consecutive rows tile the canvas with no bare strip between them.
 *
 * Why this exists: every row and every text line inside it is absolutely
 * positioned (the zero-DOM height model), so the inter-item gaps are bare canvas
 * with no in-flow line box. During a drag-selection the browser cannot resolve a
 * caret position over such a strip and falls back to the container's FIRST
 * position — the selection focus snaps to the top of the history mid-drag. Making
 * the hit boxes tile removes those dead strips; an inner clip box keeps the exact
 * arithmetic height, so geometry and visuals are unchanged.
 *
 * The returned value is never smaller than the row's own height, and the last row
 * extends to the bottom of the canvas (absorbing the trailing padding).
 */
export function resolveRowHitHeight(
	items: readonly LaidOutItem[],
	index: number,
	totalHeight: number,
): number {
	const current = items[index];
	if (!current) return 0;
	const own = Math.max(0, current.height);
	const next = items[index + 1];
	const boundary = next ? next.top : totalHeight;
	if (!Number.isFinite(boundary)) return own;
	return Math.max(own, boundary - current.top);
}

/**
 * True when a rendered item is a frameless in-run card (tool-call in a multi-card
 * run, or an in-run subagent card). These carry no border of their own and rely
 * on the grouping frame the legacy path draws around a whole tool-run.
 */
export function isFramedRunItem(item: VListItem | undefined): boolean {
	if (!item) return false;
	const m = item.measured as { inRun?: boolean; borderHeight?: number };
	if (item.spec.kind === "tool-call") return m.inRun === true;
	if (item.spec.kind === "subagent-card") return m.borderHeight === 0;
	return false;
}

/**
 * Maximal consecutive runs (length ≥ 2) of frameless in-run tool/subagent cards.
 * Each run is drawn inside one decorative frame — parity with the legacy
 * ToolRunFrame's `isMultiRun && lod >= 3` grouping. Single in-run items never
 * occur (a lone tool-run item renders standalone with its own border), but the
 * ≥ 2 guard keeps this defensive.
 */
export function computeToolRunFrames(
	items: readonly (VListItem | undefined)[],
): Array<{ key: string; start: number; end: number }> {
	const runs: Array<{ key: string; start: number; end: number }> = [];
	let i = 0;
	while (i < items.length) {
		if (isFramedRunItem(items[i])) {
			let j = i;
			while (j + 1 < items.length && isFramedRunItem(items[j + 1])) j++;
			// Keyed by the FIRST member's spec key, not by the index. The index is not an
			// identity: a fold anywhere earlier in the document renumbers every run after
			// it, so an index-keyed frame would be paired with a different run's geometry
			// across the very rebuild the fold transition has to diff. The first member's
			// spec key survives a fold (only the toggled element's own key can change),
			// which is exactly the pairing the FLIP needs.
			if (j > i) runs.push({ key: `run:${items[i]?.spec.key ?? i}`, start: i, end: j });
			i = j + 1;
		} else {
			i++;
		}
	}
	return runs;
}

/**
 * Normalize a manifest `documentRevision` to a number for the fold capture's
 * validity check.
 *
 * The manifest types it as `string | number` (it is built as a composite string:
 * `messageVersion~k:…~f:…`), while the fold only needs "is this the same document as
 * when the click happened". Hashing the string gives that as a cheap scalar; two
 * different documents colliding would at worst animate one fold from a slightly
 * wrong offset, and the age bound in `isFoldCaptureUsable` limits even that to the
 * ~400ms after a click.
 */
export function foldRevisionOf(revision: string | number | undefined): number {
	if (typeof revision === "number") return revision;
	if (typeof revision !== "string") return -1;
	let hash = 0;
	for (let i = 0; i < revision.length; i++) {
		hash = (hash * 31 + revision.charCodeAt(i)) | 0;
	}
	return hash;
}

/**
 * Escape a spec key for use inside an attribute selector.
 *
 * Spec keys are generated (`tool-<toolUseId>`, `<messageId>-b3`), so in practice they
 * are alphanumeric with dashes — but they are DATA, and building a selector by
 * interpolating data is how a stray quote turns into a thrown `SyntaxError` that
 * takes the whole render down. `CSS.escape` where available, a conservative manual
 * escape otherwise (linkedom / older WebViews).
 */
export function cssAttrEscape(value: string): string {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return value.replace(/["\\]/g, "\\$&");
}

/** The distinct source message ids one rendered item was built from. */
export function sourceIdsForItem(
	item: VListItem,
	manifestItem: { sourceMessageIds: readonly string[] } | undefined,
): string[] {
	const data = item.spec.data as { id?: unknown } | null;
	const ids = [
		typeof data?.id === "string" ? data.id : null,
		...(manifestItem?.sourceMessageIds ?? []),
	].filter((id): id is string => !!id);
	return [...new Set(ids)];
}

/** The DOM id a jump target resolves against, when the item carries one. */
export function domIdForItem(item: VListItem, sourceIds: readonly string[]): string | undefined {
	const data = item.spec.data as { id?: unknown } | null;
	const id = typeof data?.id === "string" ? data.id : sourceIds[0];
	return id ? `msg-${id}` : undefined;
}
