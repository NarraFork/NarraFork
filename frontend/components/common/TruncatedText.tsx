import { Text, type TextProps, Tooltip } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";

/**
 * Sub-pixel layout makes `scrollWidth` and `clientWidth` differ by fractions on
 * text that actually fits, so an exact `>` comparison reports phantom overflow
 * and every short label would grow a redundant tooltip.
 */
const TEXT_CLIP_EPSILON_PX = 1;

/** Keep long tooltips readable instead of stretching across the viewport. */
const DEFAULT_TOOLTIP_MAX_WIDTH_PX = 420;

/**
 * Whether a single-line element is actually clipped by `text-overflow: ellipsis`.
 *
 * Returns false when the measurements are unavailable (SSR, test DOMs without a
 * layout engine) or when the element has no width yet, so an unmeasurable
 * element never claims to be truncated.
 */
export function isTextClipped(element: { scrollWidth?: number; clientWidth?: number }): boolean {
	const { scrollWidth, clientWidth } = element;
	if (!Number.isFinite(scrollWidth) || !Number.isFinite(clientWidth)) return false;
	if ((clientWidth as number) <= 0) return false;
	return (scrollWidth as number) - (clientWidth as number) > TEXT_CLIP_EPSILON_PX;
}

export interface TruncatedTextProps extends Omit<TextProps, "truncate" | "children"> {
	/** The single-line string to render; also the default tooltip content. */
	text: string;
	/** Tooltip content override (defaults to `text`). */
	tooltipLabel?: ReactNode;
	/** Hover delay before the tooltip appears, in ms. */
	openDelay?: number;
	/** Max width of the tooltip bubble, in px. */
	tooltipMaxWidth?: number;
}

/**
 * TruncatedText — a single-line `Text` that ellipsizes and reveals the full
 * string on hover (desktop) or tap (touch), but ONLY while it is really clipped.
 *
 * The tooltip is measurement-gated rather than always-on: a status label that
 * fits must not gain a hover card that repeats what is already on screen. The
 * measurement re-runs on content change and on every resize of the text box, so
 * shrinking the panel turns the tooltip on and widening it turns it back off.
 *
 * `events.touch` is enabled because the status bar is also used on mobile, where
 * there is no hover to reveal the clipped tail.
 */
export function TruncatedText({
	text,
	tooltipLabel,
	openDelay = 300,
	tooltipMaxWidth = DEFAULT_TOOLTIP_MAX_WIDTH_PX,
	...textProps
}: TruncatedTextProps) {
	// A state node (not a ref) so the measuring effect re-runs when the element
	// is attached, which a ref mutation would not trigger.
	const [node, setNode] = useState<HTMLElement | null>(null);
	const [clipped, setClipped] = useState(false);

	useEffect(() => {
		// Re-runs on `text` as well: new content can start or stop overflowing
		// without the box ever changing size, so the observer alone would miss it.
		if (!node || text.length === 0) {
			setClipped(false);
			return;
		}
		// Only the tooltip's `disabled` prop depends on this, so writing it back
		// from a ResizeObserver cannot feed into layout and loop.
		const measure = () => setClipped(isTextClipped(node));
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(node);
		return () => observer.disconnect();
	}, [node, text]);

	return (
		<Tooltip
			label={tooltipLabel ?? text}
			disabled={!clipped}
			multiline
			maw={tooltipMaxWidth}
			openDelay={openDelay}
			withinPortal
			events={{ hover: true, focus: true, touch: true }}
		>
			{/* `data-overflow-tooltip` mirrors the gate that drives `disabled` above,
			    making the decision observable to tests and devtools (Mantine renders
			    nothing for a closed tooltip). */}
			<Text
				ref={setNode}
				truncate
				data-overflow-tooltip={clipped ? "armed" : undefined}
				{...textProps}
			>
				{text}
			</Text>
		</Tooltip>
	);
}
