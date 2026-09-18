/**
 * vlist-exact-scroll.ts — the exact-layout shell's scroll predicates.
 *
 * Extracted from `PretextExactMessageList.tsx` unchanged. These are the decisions that
 * separate "the reader moved" from "the canvas moved under the reader", which is the
 * distinction the whole auto-follow behaviour rests on: get it wrong in either
 * direction and the list either fights a scrolling reader or silently stops following
 * a stream. They are pure, so they are also the part of the shell that a unit test can
 * check directly (see `vlist-scroll-pin.test.ts`, which imports them).
 *
 * The shell keeps the STATE (refs, the suppression window, the pin flag); this module
 * only answers questions about numbers.
 */

/** Scroll position at which a container is scrolled fully to the bottom. */
export function getScrollBottomTarget(node: HTMLElement | null): number {
	return node ? Math.max(0, node.scrollHeight - node.clientHeight) : 0;
}

/** Distance in px from the container's current position to its bottom. */
export function getDistanceFromBottom(node: HTMLElement): number {
	return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight);
}

/**
 * Tolerance (px) for recognising a scroll event as the echo of our own write.
 *
 * The browser can settle a programmatic `scrollTop` a fraction of a pixel away from
 * the requested value (fractional device pixels / zoom), so an exact comparison
 * would classify our own write as user input. One pixel is far below any real
 * gesture and matches the bottom-detection epsilon.
 */
const SCROLL_ECHO_EPSILON = 1;

/**
 * True when a scroll event is the echo of our own programmatic write, rather than
 * the reader moving.
 *
 * This is what makes the suppression window safe during streaming. The window used
 * to be time-only: a flag set on every write and cleared next frame. While output
 * streamed, the pin effect wrote scrollTop every frame, so the window never really
 * closed and a gentle upward drag was discarded — after which the next frame's write
 * dragged the reader back to the bottom. Comparing the reported position against the
 * value we actually wrote separates the two cases exactly.
 *
 * Exported for the unit test; pure.
 */
export function isSuppressedScrollEcho(
	suppressing: boolean,
	suppressedScrollTop: number | null,
	reportedScrollTop: number,
): boolean {
	if (!suppressing) return false;
	// Suppressing with no recorded value: treat as an echo (conservative — this is the
	// pre-existing behaviour for writes whose settled value could not be read back).
	if (suppressedScrollTop == null) return true;
	return Math.abs(reportedScrollTop - suppressedScrollTop) <= SCROLL_ECHO_EPSILON;
}

/**
 * Upward movement from any input source (including the scrollbar and keyboard).
 * Programmatic writes update scrollTopRef synchronously, so their delayed events
 * cannot look like fresh movement even after the echo-suppression window closes.
 */
export function isUpwardHistoryScroll(
	previousScrollTop: number,
	reportedScrollTop: number,
	isEcho: boolean,
): boolean {
	return !isEcho && reportedScrollTop < previousScrollTop - SCROLL_ECHO_EPSILON;
}

/**
 * True when a scroll frame reporting "not at the bottom" describes the CONTENT
 * GROWING BENEATH a reader who is pinned there — not the reader leaving.
 *
 * The reader cannot leave the bottom without moving the scroll position: every
 * gesture that travels toward earlier content LOWERS scrollTop. Content growing
 * below the viewport (or the viewport itself getting shorter) leaves scrollTop
 * untouched and moves the bottom away from it. So "scrollTop did not decrease" is
 * the exact discriminator between the two, and it needs no per-gesture listener.
 *
 * ## The defect this closes
 *
 * A pending PERMISSION row is one of the few rows measured after paint (see
 * vlist-permission-bridge): the real InlinePermission / AskUserQuestionBanner
 * mounts, reports its height, and its ResizeObserver reports AGAIN as the feedback
 * textarea, the target/badge block or a reflection notice settle — each report
 * growing the canvas. Between two of those reports a scroll frame observed a
 * distance-from-bottom of tens of pixels with the reader never having touched
 * anything, and unpinned auto-follow.
 *
 * That loss was PERMANENT rather than a one-frame glitch: the pin effect is gated on
 * `pinnedToBottom`, so once unpinned nothing re-glued the view, and every later
 * message landed off-screen until the reader scrolled down by hand. The same shape
 * covers a shrinking viewport (a growing composer, a window resize), which moves the
 * bottom for exactly the same reason.
 *
 * Exported for the unit test; pure.
 */
export function isBottomLostToContentGrowth(
	pinnedToBottom: boolean,
	previousScrollTop: number,
	reportedScrollTop: number,
): boolean {
	if (!pinnedToBottom) return false;
	// Same 1px tolerance as the echo/bottom comparisons: sub-pixel settling of a
	// programmatic write must not read as an upward gesture. A real gesture moves
	// further than the epsilon the bottom itself is detected with.
	return reportedScrollTop >= previousScrollTop - SCROLL_ECHO_EPSILON;
}

/**
 * The scroll position an anchored rebuild should actually write.
 *
 * A bottom anchor has to clear the footer as well as the canvas; an item anchor is
 * already expressed in canvas coordinates and must not be shifted.
 */
export function applyExactScrollCorrection(
	nextTop: number,
	anchorKind: "bottom" | "item",
	footerHeight: number,
): number {
	return nextTop + (anchorKind === "bottom" ? Math.max(0, footerHeight) : 0);
}
