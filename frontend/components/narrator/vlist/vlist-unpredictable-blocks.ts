/**
 * vlist-unpredictable-blocks.ts — Which rows host content whose real pixel height
 * the arithmetic model cannot predict.
 *
 * The exact list derives every row's geometry from pure arithmetic. `PreparedUnknownBlock`
 * is the CONTRACT's one controlled exception: a mermaid diagram or an image of unknown
 * intrinsic size only reserves a conservative PLACEHOLDER, and the render layer reports
 * the settled height back through `onUnknownHeight` so the shell can override it.
 *
 * That reporting only happens for rows the shell marked dynamic. Mermaid rows were never
 * in that set, so a diagram taller than its 240px placeholder was clipped by the row's
 * fixed-height box — and switching a diagram to "actual size" grew it inside a box that
 * never re-measured, hiding everything below it. This module is the pure predicate the
 * shell uses to include them, kept free of React/DOM so it is unit-testable.
 *
 * Display math is deliberately NOT unpredictable: katex-geometry measures it exactly
 * (signalled by `intrinsicWidth`), so routing it through a post-paint correction would
 * let a ResizeObserver move a committed row with no user action behind it.
 */

import type { MeasuredElement, PreparedBlock, PreparedUnknownBlock } from "./prepared-block";

/**
 * True when this unknown block's geometry was in fact measured exactly, so no
 * post-paint DOM measurement is needed. MUST stay in sync with RenderMarkdown's
 * `isExactlyMeasured`: the shell decides whether to hand out a reporter, the
 * renderer decides whether to observe — disagreement means either a clipped row
 * (shell says static, renderer never reports) or a row on the flowing path with
 * nobody recording its height.
 */
export function isExactlyMeasuredUnknownBlock(block: PreparedUnknownBlock): boolean {
	return block.tag === "katex" && block.intrinsicWidth != null;
}

/** True when any block in the list needs a post-paint height correction. */
export function hasUnpredictableBlock(blocks: readonly PreparedBlock[]): boolean {
	for (const block of blocks) {
		if (block.kind !== "unknown") continue;
		if (!isExactlyMeasuredUnknownBlock(block)) return true;
	}
	return false;
}

/**
 * True when a measured element hosts an unpredictable block AND its render path
 * actually forwards `onUnknownHeight`.
 *
 * The kind gate matters: only `markdown`, `message-bubble`, `reasoning` and
 * `plan-card` forward the callback (see render-registry). A tool card holds its
 * bodies in capped, internally scrolling boxes and deliberately does NOT forward it
 * — marking such a row dynamic would drop its fixed-height clip and let the card
 * decide its own height, which is exactly what the cap exists to prevent.
 */
export function hostsUnpredictableBlock(kind: string, measured: MeasuredElement): boolean {
	if (!UNKNOWN_HEIGHT_FORWARDING_KINDS.has(kind)) return false;
	return hasUnpredictableBlock(measured.blocks);
}

/**
 * Element kinds whose renderer forwards `onUnknownHeight` down to RenderMarkdown.
 * Mirrors render-registry.renderElement; a kind absent here can host an unknown
 * block without ever reporting its height, so it must not be marked dynamic.
 */
export const UNKNOWN_HEIGHT_FORWARDING_KINDS: ReadonlySet<string> = new Set([
	"markdown",
	"message-bubble",
	"reasoning",
	"plan-card",
]);
