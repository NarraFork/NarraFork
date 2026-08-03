/**
 * vlist-highlight.ts — Flash a row after the list jumped to it.
 *
 * Deliberately NOT a port of the chunked path's highlight, which has three
 * problems this design avoids:
 *
 *  1. It keeps the highlighted id in React state at the panel level, so one flash
 *     costs two full re-renders of the message tree (on and off). In the exact
 *     list every row's memo compares a dozen props, so a decorative effect would
 *     turn into a full-window prop diff — twice.
 *  2. It guesses the timing: `scheduleHighlight(id, 400)` waits a fixed 400ms in
 *     the hope that the scroll has landed. Here the jump is an async function
 *     that reports success, so the flash can start exactly when the row is in
 *     view — and never at all when the jump failed.
 *  3. It animates `background-color`, which OVERWRITES the row's own background.
 *     User bubbles (indigo) and system cards (per-kind tints) get flattened to
 *     yellow and then snap back. An `outline` composites on top instead, so the
 *     row keeps its identity while it flashes.
 *
 * Zero layout impact: `outline` does not participate in layout (unlike `border`),
 * and no measured height, cached measurement or React state is touched. The DOM
 * write goes straight to the row node via the Web Animations API, so the flash is
 * invisible to the virtualization pipeline.
 *
 * DOM-touching by design (it is a shell-level effect, not a measure path), so it
 * lives outside the zero-DOM guard's module list.
 */

/** How long one flash lasts. Matches the chunked keyframes' 1.5s. */
export const HIGHLIGHT_DURATION_MS = 1500;

/** Outline width (px) — thin enough to read as a glow, not a layout change. */
const HIGHLIGHT_OUTLINE_WIDTH = 2;

/**
 * Keyframes: transparent → tinted → transparent, so the row settles back to its
 * own appearance with nothing left to clean up. Mirrors the chunked animation's
 * 0/25/75/100 shape, which reads as a single deliberate pulse rather than a blink.
 */
function highlightKeyframes(): Keyframe[] {
	const on = `${HIGHLIGHT_OUTLINE_WIDTH}px solid var(--mantine-color-yellow-5)`;
	const off = `${HIGHLIGHT_OUTLINE_WIDTH}px solid transparent`;
	return [
		{ offset: 0, outline: off, outlineOffset: "0px" },
		{ offset: 0.25, outline: on, outlineOffset: "2px" },
		{ offset: 0.75, outline: on, outlineOffset: "2px" },
		{ offset: 1, outline: off, outlineOffset: "0px" },
	];
}

/** The subset of Element the flash needs; keeps this unit-testable without a DOM. */
export interface HighlightTarget {
	animate?: (
		keyframes: Keyframe[],
		options: KeyframeAnimationOptions,
	) => { cancel: () => void } | undefined;
}

/** A running flash, so a later jump to the same row can restart it cleanly. */
export interface HighlightHandle {
	cancel: () => void;
}

/**
 * Start one flash on `element`, returning a handle or null when the environment
 * has no Web Animations support (older WebViews / a test DOM) — in which case the
 * jump still works and only the decoration is skipped. Never throws.
 */
export function flashHighlight(
	element: HighlightTarget | null | undefined,
	durationMs: number = HIGHLIGHT_DURATION_MS,
): HighlightHandle | null {
	if (!element || typeof element.animate !== "function") return null;
	try {
		const animation = element.animate(highlightKeyframes(), {
			duration: durationMs,
			easing: "ease",
			// The row must end up exactly as it started: no fill, so the final
			// transparent frame is not retained as an inline style.
			fill: "none",
		});
		return animation ? { cancel: () => animation.cancel() } : null;
	} catch {
		return null;
	}
}

/**
 * A one-flash-at-a-time controller.
 *
 * Repeated jumps to the same message (clicking the same search hit twice) must
 * re-flash rather than be swallowed, which is why there is no "already
 * highlighted" short-circuit: the previous animation is cancelled and a new one
 * starts. That also means the caller does not have to reset any state between
 * jumps — the very thing the chunked path needs `lastHighlightTargetRef` for.
 */
export function createHighlightController(): {
	flash: (element: HighlightTarget | null | undefined, durationMs?: number) => void;
	cancel: () => void;
} {
	let active: HighlightHandle | null = null;
	const cancel = () => {
		active?.cancel();
		active = null;
	};
	return {
		flash: (element, durationMs) => {
			cancel();
			active = flashHighlight(element, durationMs);
		},
		cancel,
	};
}
