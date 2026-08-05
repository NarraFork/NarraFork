/**
 * line-fragments.tsx — Makes a visual line's fragments COPYABLE as the text they
 * came from.
 *
 * Every vlist text line is an absolutely positioned `display:flex` row (flex is what
 * vertically centers the fragments inside the reserved line box), and each pretext
 * fragment is a `display:inline-block` span painted with the exact font the measure
 * layer used. Two separate defects fall out of that shape when a reader copies a
 * selection; both are fixed here, and both were verified in real Chrome 146.
 *
 * ## Defect 1 — a newline around every inline fragment
 *
 * CSS BLOCKIFIES flex items: a flex item's `display` computes to its block-level
 * equivalent, so each `inline-block` fragment is treated as a BLOCK. The plain-text
 * serializer breaks at block boundaries, so
 *
 *     Firefox: `clipboardData.files` is empty.
 *
 * copied out as
 *
 *     "Firefox: \nclipboardData.files\n is empty."
 *
 * — a stray newline before AND after every inline code span, link, or bold run, i.e.
 * anything the parser emits as its own fragment. The trigger is purely the flex line
 * container, independent of what `display` the fragments themselves declare.
 *
 * Fix: `LineFragments` wraps all of a line's fragments in ONE block span, which
 * becomes the single flex item. The fragments are then ordinary inline-level children
 * of a block, so no block boundary sits between them.
 *
 * ### Why `flexShrink: 0` is load-bearing
 *
 * A flex item defaults to `flex-shrink: 1`. That is harmless per-fragment: a
 * `white-space: pre` inline-block has min-content == its full text width, so there is
 * nothing to shrink. Once wrapped, the item is a block whose min-content collapses to
 * its widest CHILD, because the inline content may break between the inline-blocks. In
 * a line narrower than its content the wrapper is then squeezed and the fragments
 * REWRAP onto extra rows — the rendered height silently exceeds the reserved height,
 * which CONTRACT §0 iron law 2 forbids. Most lines are guarded by
 * `min-width: max-content` on the line box, but `TableCellView`'s line is pinned to
 * the solved column width with no such guard, and a bare wrapper does wrap there
 * (reproduced at all three column alignments). `flexShrink: 0` restores the
 * pre-wrapper behaviour everywhere: overflow instead of reflow.
 *
 * ## Defect 2 — the space between fragments is not text at all
 *
 * pretext encodes an inter-fragment space as `gapBefore` PIXELS, painted as
 * `margin-left`. The space is geometry, never a character, so it cannot be copied:
 *
 *     "See **bold** and `code` here."  ->  "Seeboldandcodehere."
 *
 * This predates defect 1 and was MASKED by it — every place a space went missing had
 * a spurious newline standing in for it, so the copied text looked plausible. Fixing
 * only the newlines would have turned a wrong-but-readable result into an unreadable
 * one, which is why both are fixed together.
 *
 * Fix: `FragmentGap` emits the real space character at `font-size: 0`, so it carries
 * NO advance (the `margin-left` still provides the exact measured gap) while the
 * serializer still sees it. Verified advance-free: fragment offsets are identical to
 * the separator-less rendering. Alternatives that clip the space instead
 * (`width: 0; overflow: hidden`, absolute positioning with zero width) are silently
 * dropped from serialization by Chrome, so they do not work.
 *
 * Because the separator is driven by `gapBefore > 0`, a boundary the source had no
 * space at — Chinese prose meeting inline code — correctly gains nothing.
 */

import type { ReactNode } from "react";

/**
 * The single flex item of a visual line. Every render-*.tsx that paints pretext
 * fragments inside a flex line MUST route them through this, or the line
 * reintroduces the stray newlines described above.
 */
export function LineFragments({ children }: { children: ReactNode }) {
	return (
		<span
			data-vlist-line-frags
			style={{
				// Block, so its inline children have no block boundary between them and
				// the plain-text serializer keeps them on one line.
				display: "block",
				// Never let the flex line squeeze this below its content: the fragments
				// would rewrap and break the reserved height (see the note above).
				flexShrink: 0,
				// Size to content so centered / right-aligned lines place fragments at
				// the same offsets as the unwrapped version.
				width: "max-content",
			}}
		>
			{children}
		</span>
	);
}

/**
 * The copyable stand-in for a fragment's `gapBefore`.
 *
 * Render as the fragment's PRECEDING SIBLING, never as its child: the space belongs
 * to the boundary BEFORE the fragment, not to the fragment's own text. Nesting it
 * put the space inside the element, so `a.textContent` for a link became
 * `" 示例"` instead of `"示例"` — which leaks into copying a single link and into
 * anything reading an element's text (caught by RenderMarkdown.link.test.tsx). The
 * fragment keeps its `marginLeft: gapBefore` for layout either way.
 *
 * Renders nothing when the gap is zero, so boundaries the source had no space at
 * stay unspaced (Chinese prose meeting inline code).
 *
 * `fontSize: 0` is the whole mechanism: the glyph gets no advance (so measured
 * geometry is untouched) but remains real text for the selection serializer.
 * `aria-hidden` keeps it out of the accessibility tree, where the surrounding text
 * nodes already read naturally.
 */
export function FragmentGap({ gapBefore }: { gapBefore: number }) {
	if (!(gapBefore > 0)) return null;
	return (
		<span aria-hidden data-vlist-frag-gap style={{ fontSize: 0 }}>
			{" "}
		</span>
	);
}
