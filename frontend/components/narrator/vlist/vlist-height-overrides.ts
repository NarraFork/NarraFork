/**
 * vlist-height-overrides.ts — Local height correction for the exact-layout shell.
 *
 * The exact canvas normally derives every row's geometry from the pure arithmetic
 * `PretextLayoutIndex` (zero DOM). A few rows, however, host content whose real
 * pixel height cannot be predicted arithmetically and must be measured once after
 * paint (the CONTRACT's controlled exception): mermaid / katex / unknown-size
 * images, and — added here — the live permission form (InlinePermission /
 * AskUserQuestionBanner) mounted for a pending-permission tool card.
 *
 * A row reports its settled height via `onUnknownHeight`; the shell records it in
 * a `key → height` override map and re-derives the canvas geometry with a single
 * O(window) prefix-sum pass. This module is the pure math for that pass so it is
 * unit-testable and free of React/DOM.
 *
 * Design mirrors `vlist-virtualization.layoutItems`: same gap/padding accumulation,
 * but the per-item height is `override ?? manifestHeight`.
 */

import type { ListLayout } from "@shared/pretext-layout/vlist-virtualization";

/** The minimal geometry inputs the override pass needs from the layout index. */
export interface HeightOverrideInput {
	/** Per-item arithmetic heights (manifest order). */
	readonly heights: readonly number[];
	/** Per-item stable keys (manifest order); parallel to `heights`. */
	readonly keys: readonly string[];
	/** Inter-item vertical gap (px). */
	readonly gap: number;
	/** Canvas top padding (px). */
	readonly topPadding: number;
	/** Canvas bottom padding (px). */
	readonly bottomPadding: number;
}

/**
 * True when at least one override key is present in `keys` with a value that
 * differs from the arithmetic height — i.e. applying overrides would change the
 * geometry. When false, the caller can skip the correction and reuse the base
 * layout unchanged (zero overhead in the common no-override case).
 */
export function hasEffectiveHeightOverride(
	keys: readonly string[],
	heights: readonly number[],
	overrides: ReadonlyMap<string, number>,
): boolean {
	if (overrides.size === 0) return false;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key === undefined) continue;
		const override = overrides.get(key);
		if (override === undefined) continue;
		if (override !== heights[i]) return true;
	}
	return false;
}

/**
 * Re-lay out items applying per-key height overrides. Rows without an override
 * keep their arithmetic height. Returns a fresh `ListLayout` with corrected
 * top/height/bottom + totalHeight.
 *
 * A negative or non-finite override is ignored (falls back to the arithmetic
 * height) so a bad ResizeObserver reading can never corrupt the canvas.
 */
export function layoutItemsWithOverrides(
	input: HeightOverrideInput,
	overrides: ReadonlyMap<string, number>,
): ListLayout {
	const { heights, keys, gap, topPadding, bottomPadding } = input;
	const items = new Array(heights.length);
	let y = topPadding;
	for (let i = 0; i < heights.length; i++) {
		const base = heights[i];
		if (base === undefined) continue;
		const key = keys[i];
		const override = key !== undefined ? overrides.get(key) : undefined;
		const height =
			override !== undefined && Number.isFinite(override) && override >= 0 ? override : base;
		const top = y;
		const bottom = top + height;
		items[i] = { top, height, bottom };
		y = bottom + gap;
	}
	const totalHeight = heights.length === 0 ? topPadding + bottomPadding : y - gap + bottomPadding;
	return { items, totalHeight };
}

/**
 * Prune override entries whose key no longer exists in the current manifest (the
 * item was removed, e.g. a permission resolved and its dynamic row collapsed back
 * to a pure-arithmetic card). Keeps the override map from growing unbounded and
 * avoids applying a stale override to a recycled key. Returns the same map when
 * nothing changed (referentially stable → no needless re-render).
 */
export function pruneHeightOverrides(
	overrides: ReadonlyMap<string, number>,
	liveKeys: ReadonlySet<string>,
): Map<string, number> | null {
	let changed = false;
	for (const key of overrides.keys()) {
		if (!liveKeys.has(key)) {
			changed = true;
			break;
		}
	}
	if (!changed) return null;
	const next = new Map<string, number>();
	for (const [key, value] of overrides) {
		if (liveKeys.has(key)) next.set(key, value);
	}
	return next;
}
