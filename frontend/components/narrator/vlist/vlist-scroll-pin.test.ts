/**
 * vlist-scroll-pin.test.ts — The scroll-position invariants that streaming broke.
 *
 * Three separate defects lived here, all of them only visible while output streamed
 * (because that is when the list writes scrollTop every frame):
 *
 * 1. The reader's own scrolling was swallowed. Suppression of the pinned-state update
 *    was TIME-based — a flag set on each programmatic write, cleared next frame — so
 *    while the pin effect wrote every frame the window never really closed. A gentle
 *    upward drag was discarded and the next write pulled the reader back to the
 *    bottom. Now the suppression is VALUE-based.
 * 2. The browser's own scroll anchoring competed with those writes
 *    (`overflow-anchor: none`, asserted on the rendered container elsewhere).
 * 3. An anchored rebuild could jump by up to one inter-item gap: a scroll position
 *    sitting in the gap between two items resolved to the following item with its
 *    offset clamped to zero, so restoring pulled that item's top to the viewport top.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { installCanvasStub } from "./measure/test-canvas-stub";

beforeAll(() => {
	installCanvasStub();
});

describe("isSuppressedScrollEcho — telling our own write from the reader", () => {
	it("treats a scroll event matching our written value as our own echo", async () => {
		const { isSuppressedScrollEcho } = await import("./PretextExactMessageList");
		expect(isSuppressedScrollEcho(true, 1000, 1000)).toBe(true);
		// The browser may settle a programmatic write a fraction of a pixel away.
		expect(isSuppressedScrollEcho(true, 1000, 1000.4)).toBe(true);
		expect(isSuppressedScrollEcho(true, 1000, 999.7)).toBe(true);
	});

	it("honours the reader from ANY input source that moved the position", async () => {
		const { isSuppressedScrollEcho } = await import("./PretextExactMessageList");
		// This is what makes the fix cover keyboard and scrollbar dragging too: the
		// list does not need a listener per gesture, only to notice the position is not
		// the one it wrote. (Only wheel/touch ever had explicit detach handlers.)
		expect(isSuppressedScrollEcho(true, 1000, 700)).toBe(false); // scrollbar drag
		expect(isSuppressedScrollEcho(true, 1000, 400)).toBe(false); // PageUp
		expect(isSuppressedScrollEcho(true, 1000, 997)).toBe(false); // gentle 3px nudge
	});

	it("is inert when no write is being suppressed", async () => {
		const { isSuppressedScrollEcho } = await import("./PretextExactMessageList");
		expect(isSuppressedScrollEcho(false, 1000, 1000)).toBe(false);
		expect(isSuppressedScrollEcho(false, null, 42)).toBe(false);
	});

	it("stays conservative when the written value is unknown", async () => {
		const { isSuppressedScrollEcho } = await import("./PretextExactMessageList");
		expect(isSuppressedScrollEcho(true, null, 123)).toBe(true);
	});
});

describe("isBottomLostToContentGrowth — a row growing beneath a pinned reader", () => {
	/**
	 * The shipped defect: a PENDING PERMISSION row is measured after paint (the real
	 * InlinePermission / AskUserQuestionBanner mounts, then its ResizeObserver reports
	 * again as the feedback textarea / target block / reflection notice settle). Between
	 * two reports a scroll frame saw a large distance-from-bottom with the reader never
	 * having touched anything, and unpinned auto-follow — permanently, because the pin
	 * effect is gated on `pinnedToBottom`, so every later message landed off-screen.
	 */
	it("keeps the pin when the bottom moved but scrollTop did not", async () => {
		const { isBottomLostToContentGrowth } = await import("./PretextExactMessageList");
		// The permission form grew 120px below the viewport: same scrollTop, new bottom.
		expect(isBottomLostToContentGrowth(true, 4000, 4000)).toBe(true);
		// Sub-pixel settling of a programmatic write is not an upward gesture.
		expect(isBottomLostToContentGrowth(true, 4000, 3999.6)).toBe(true);
		// A shrinking viewport (composer grew, window resized) moves the bottom the same way.
		expect(isBottomLostToContentGrowth(true, 0, 0)).toBe(true);
	});

	it("releases the pin as soon as the reader actually travels upward", async () => {
		const { isBottomLostToContentGrowth } = await import("./PretextExactMessageList");
		// Every gesture toward earlier content LOWERS scrollTop, which is the whole
		// discriminator — no per-gesture listener needed.
		expect(isBottomLostToContentGrowth(true, 4000, 3800)).toBe(false); // wheel / drag
		expect(isBottomLostToContentGrowth(true, 4000, 2000)).toBe(false); // PageUp
		expect(isBottomLostToContentGrowth(true, 4000, 3997)).toBe(false); // gentle 3px nudge
	});

	it("never re-pins a reader who had already left the bottom", async () => {
		const { isBottomLostToContentGrowth } = await import("./PretextExactMessageList");
		// Reading history while output streams: growth below must not drag them back.
		expect(isBottomLostToContentGrowth(false, 1000, 1000)).toBe(false);
		expect(isBottomLostToContentGrowth(false, 1000, 1200)).toBe(false);
	});
});

describe("processScrollFrame answers content growth in the same frame", () => {
	/**
	 * Deciding to stay pinned is not enough on its own: the VIEW must also be pulled
	 * back to the new bottom. Leaving that to the geometry-revision pin effect is not
	 * sufficient — that effect is keyed on `exactLayout.totalHeight`, which only moves
	 * once a reported height lands in `heightOverrides`. A report inside the 1px jitter
	 * guard, or one for a row that already left the dynamic path, grows the real DOM box
	 * without changing the layout, so the effect never runs and the view sits a form's
	 * height short of the bottom.
	 */
	it("re-glues to the bottom and resolves the window from the settled position", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("isBottomLostToContentGrowth(");
		// The re-glue routes through the smooth-follow chase: growth beneath a pinned
		// reader is precisely the "content jumps up" case the chase glides over, and
		// its gate reproduces the old instant write for loads/switches/shrinks.
		expect(frame).toContain("if (grewBeneathReader) getSmoothFollower().ensure();");
		// The mounted window must come from where the viewport now is, not from the
		// pre-re-glue reading.
		expect(frame).toContain("const settledTop = scrollTopRef.current;");
		expect(frame).toContain("resolveVisibleWindow(layout, settledTop,");
	});

	/**
	 * The panel's affordances read the SAME value the pin does. Reporting the raw
	 * `atBottom` while staying pinned would flash the scroll-to-bottom button and count
	 * unread messages for a reader who is being followed (NarratorPanel:
	 * `showScrollToBottomButton = !isAtBottom || unreadCount > 0`).
	 */
	it("reports the effective pin to the panel, not the raw geometry reading", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("onAtBottomChange?.(effectiveAtBottom);");
		expect(frame).toContain("if (effectiveAtBottom) onUnreadCountChange?.(0);");
		expect(frame).not.toContain("onAtBottomChange?.(atBottom);");
	});
});

describe("the scroll container disables the browser's own anchoring", () => {
	it("sets overflow-anchor: none on the scroll viewport", async () => {
		// The list answers every geometry change with an explicit anchored write, so
		// the browser adjusting scrollTop for the same size changes would fight it —
		// most visibly while the streaming row grows each frame.
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		expect(source).toContain('overflowAnchor: "none"');
	});
});

describe("smooth bottom-follow wiring (vlist-smooth-follow)", () => {
	async function shell() {
		return Bun.file(new URL("./PretextExactMessageList.tsx", import.meta.url).pathname).text();
	}

	it("routes all three bottom-follow writers through the chase", async () => {
		const source = await shell();
		// 1. The streaming commit's bottom correction (only when the coordinator
		//    stamped it smooth, i.e. tail growth).
		expect(source).toContain('anchorKind === "bottom" && smoothFollow === true');
		// 2. The geometry-revision pin effect.
		const pinEffect = source.slice(
			source.indexOf("const scrollGeometryRevision ="),
			source.indexOf("const scrollGeometryRevision =") + 900,
		);
		expect(pinEffect).toContain("getSmoothFollower().ensure();");
		// 3. The same-frame re-glue (asserted in its own group above).
	});

	it("non-glide corrections still land instantly and kill any chase in flight", async () => {
		const source = await shell();
		const correction = source.slice(
			source.indexOf("const onScrollTopCorrection = useCallback("),
			source.indexOf("const onScrollTopCorrection = useCallback(") + 1200,
		);
		// Anchored rebuilds / fold / LOD / removals keep their committed-geometry
		// semantics: same instant write as before, and no chase survives them.
		expect(correction).toContain("getSmoothFollower().cancel();");
		expect(correction).toContain(
			"writeScrollTop(applyExactScrollCorrection(nextTop, anchorKind, footerHeightRef.current));",
		);
	});

	it("the chase dies with the pin on EVERY reader-intent path", async () => {
		const source = await shell();
		// wheel-up detach.
		const detach = source.slice(
			source.indexOf("const detachFromBottom = useCallback("),
			source.indexOf("const detachFromBottom = useCallback(") + 400,
		);
		expect(detach).toContain("getSmoothFollower().cancel();");
		// Any non-echo upward movement caught by processScrollFrame.
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("if (!effectiveAtBottom) getSmoothFollower().cancel();");
		// Explicit jumps: scrollToBottom handle, user-marker jump, message reveal.
		const toBottom = source.slice(
			source.indexOf("const scrollToBottom = useCallback("),
			source.indexOf("const scrollToBottom = useCallback(") + 500,
		);
		expect(toBottom).toContain("getSmoothFollower().cancel();");
		const reveal = source.slice(
			source.indexOf("const scrollToMessageTarget = useCallback("),
			source.indexOf("const scrollToMessageTarget = useCallback(") + 900,
		);
		expect(reveal).toContain("getSmoothFollower().cancel();");
	});

	it("fold and LOD transitions land the chase BEFORE capturing geometry", async () => {
		const source = await shell();
		// Both plan their FLIP/morph against the predicted bottom while pinned; a
		// chase still gliding would move rows under the running animation.
		const foldCapture = source.slice(
			source.indexOf("const captureFoldBefore = useCallback("),
			source.indexOf("const captureFoldBefore = useCallback(") + 700,
		);
		expect(foldCapture).toContain("smoothFollowerRef.current?.snapToTarget();");
		const lodEmit = source.slice(
			source.indexOf("const emit = (dir: 1 | -1"),
			source.indexOf("const emit = (dir: 1 | -1") + 500,
		);
		expect(lodEmit).toContain("smoothFollowerRef.current?.snapToTarget();");
	});

	it("readCurrentView treats an active chase AS the bottom pin", async () => {
		// Without this the chase's own lag makes every streaming commit capture an
		// ITEM anchor, whose correction cancels the chase it should feed (thrash).
		const source = await shell();
		const view = source.slice(
			source.indexOf("const readCurrentView = useCallback("),
			source.indexOf("const readCurrentView = useCallback(") + 1200,
		);
		expect(view).toContain("smoothFollowerRef.current?.isActive()");
	});

	it("the chase never outlives the shell", async () => {
		const source = await shell();
		expect(source).toContain("useEffect(() => () => smoothFollowerRef.current?.cancel(), []);");
	});
});

describe("anchored rebuild keeps the reader's position exactly", () => {
	async function layoutIndex(itemCount: number) {
		const { buildPretextLayoutIndex } = await import("@shared/pretext-layout");
		return buildPretextLayoutIndex({
			layoutRevision: "pin",
			documentRevision: "pin",
			lod: 5,
			widthBucket: "800",
			metrics: { topPadding: 16, itemGap: 12, bottomPadding: 16 },
			items: Array.from({ length: itemCount }, (_, index) => ({
				itemKey: `pin-${index}`,
				firstSeq: index,
				lastSeq: index,
				sourceMessageIds: [`pin-m${index}`],
				kind: "markdown",
				height: 20,
			})),
		});
	}

	it("restores a position sitting in the gap BETWEEN two items without jumping", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const before = await layoutIndex(8);
		const after = await layoutIndex(9); // a message landed / the row grew
		// Items are at 16, 48, 80 … with a 12px gap, so 40 sits in a gap.
		for (const scrollTop of [36, 40, 44, 68, 72]) {
			const anchor = capturePretextLayoutAnchor(before, scrollTop, 600, false);
			expect(restorePretextLayoutAnchor(anchor, after, 600)).toBeCloseTo(scrollTop, 5);
		}
	});

	it("still restores a position INSIDE an item exactly (unchanged behaviour)", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const before = await layoutIndex(8);
		const after = await layoutIndex(9);
		for (const scrollTop of [16, 20, 48, 60, 80]) {
			const anchor = capturePretextLayoutAnchor(before, scrollTop, 600, false);
			expect(restorePretextLayoutAnchor(anchor, after, 600)).toBeCloseTo(scrollTop, 5);
		}
	});

	it("keeps honouring an explicit focus point (LOD zoom)", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		const index = await layoutIndex(8);
		// The content under the cursor must stay put, not jump to the viewport top.
		const anchor = capturePretextLayoutAnchor(index, 16, 600, false, { focusOffset: 84 });
		expect(anchor.kind).toBe("item");
		expect(restorePretextLayoutAnchor(anchor, index, 600)).toBeCloseTo(16, 5);
	});

	it("pins to the bottom by distance when the reader is at the bottom", async () => {
		const { capturePretextLayoutAnchor, restorePretextLayoutAnchor } = await import(
			"@shared/pretext-layout"
		);
		// Enough items that the content actually overflows the viewport, otherwise
		// there is no scroll range and every position is trivially 0.
		const viewportHeight = 300;
		const before = await layoutIndex(40);
		const after = await layoutIndex(44);
		expect(before.totalHeight).toBeGreaterThan(viewportHeight);
		const anchor = capturePretextLayoutAnchor(
			before,
			before.totalHeight - viewportHeight,
			viewportHeight,
			true,
		);
		expect(anchor.kind).toBe("bottom");
		// Still at the bottom of the GROWN document.
		expect(restorePretextLayoutAnchor(anchor, after, viewportHeight)).toBeCloseTo(
			after.totalHeight - viewportHeight,
			5,
		);
	});
});
