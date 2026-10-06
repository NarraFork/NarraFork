/**
 * caret-filler.tsx — Selectable filler for the vlist's blank strips.
 *
 * The exact list renders every row, every markdown block and every text line at an
 * absolute offset (the zero-DOM height model). That leaves blank strips that belong
 * to no text box: inter-item gaps, paragraph margins, the empty tail of a clamped
 * code box, blockquote padding.
 *
 * Such a strip has no in-flow line box, so when a drag-selection passes over it the
 * browser cannot resolve a caret position and falls back to the FIRST position of
 * the scroll container — the selection focus snaps back to the start of the history
 * mid-drag, which reads as "selecting towards the end jumps to the beginning".
 *
 * A filler covers one strip with a real (but invisible) text node, so the strip
 * resolves to a caret in DOCUMENT ORDER at that spot. Placed BEFORE the content it
 * precedes, it reads as "end of the previous text"; placed AFTER, as "end of this
 * text". Either way the selection grows monotonically instead of collapsing.
 *
 * It is purely additive: `position:absolute` + the exact strip geometry, so no
 * measured height changes (zero-DOM contract preserved), and `aria-hidden` keeps
 * the zero-width space out of the accessibility tree.
 */

/** Minimum strip worth filling; sub-pixel bands are already caret-resolvable. */
const MIN_FILLER_HEIGHT = 0.5;

export function shouldFillCaretStrip(height: number | undefined): boolean {
	return typeof height === "number" && Number.isFinite(height) && height >= MIN_FILLER_HEIGHT;
}

export function CaretFiller({
	top,
	height,
	left = 0,
	width,
	centered = false,
}: {
	top: number;
	height: number;
	/** Left offset within the positioned ancestor (defaults to its content edge). */
	left?: number;
	/** Explicit width; omitted → span the full width of the positioned ancestor. */
	width?: number | string;
	/**
	 * Center the strip horizontally on `width` instead of anchoring it at `left`.
	 * Used by the list shell, whose rows are full-width but draw a centered column.
	 */
	centered?: boolean;
}) {
	if (!shouldFillCaretStrip(height)) return null;
	return (
		<div
			aria-hidden
			data-vlist-caret-filler
			style={{
				position: "absolute",
				top,
				...(centered ? { left: "50%", transform: `translateX(-50%)` } : { left }),
				width: width ?? "100%",
				height,
				overflow: "hidden",
				// Keep the glyph unrenderable: 1px text in a line box as tall as the
				// strip, fully transparent, clipped by the box itself.
				fontSize: 1,
				lineHeight: `${Math.max(1, height)}px`,
				color: "transparent",
				userSelect: "text",
				WebkitUserSelect: "text",
			}}
		>
			{"\u200b"}
		</div>
	);
}
