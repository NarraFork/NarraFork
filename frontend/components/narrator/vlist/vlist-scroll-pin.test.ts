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
import { resolveOlderHistoryAutoLoad } from "../older-history-auto-load";
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

describe("upward scroll intent loads older history without a wheel event", () => {
	const baseInput = {
		now: 10_000,
		autoLoadEnabled: true,
		hasOlder: true,
		expanding: false,
		atBottom: false,
		scrollTop: 0,
		triggerPx: 400,
	};

	it("loads when a scrollbar drag or keyboard scroll reaches the top", async () => {
		const { isUpwardHistoryScroll } = await import("./PretextExactMessageList");
		for (const previousTop of [4000, 600, 3]) {
			const intentAt = isUpwardHistoryScroll(previousTop, 0, false) ? baseInput.now : null;
			expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt })).toEqual({
				shouldLoad: true,
				nextIntentAt: null,
			});
		}
	});

	it("refreshes intent during a drag longer than the gesture timeout", async () => {
		const { isUpwardHistoryScroll } = await import("./PretextExactMessageList");
		const travelling = resolveOlderHistoryAutoLoad({
			...baseInput,
			scrollTop: 500,
			intentAt: isUpwardHistoryScroll(4000, 500, false) ? baseInput.now : null,
		});
		expect(travelling.shouldLoad).toBe(false);
		const now = baseInput.now + 4000;
		expect(
			resolveOlderHistoryAutoLoad({
				...baseInput,
				now,
				intentAt: isUpwardHistoryScroll(500, 0, false) ? now : travelling.nextIntentAt,
			}).shouldLoad,
		).toBe(true);
	});

	it("ignores programmatic echoes, unchanged positions, downward scrolls and pixel jitter", async () => {
		const { isUpwardHistoryScroll } = await import("./PretextExactMessageList");
		expect(isUpwardHistoryScroll(1000, 0, true)).toBe(false);
		// writeScrollTop updates the live ref, so even a delayed echo after the
		// suppression window closes cannot renew an already-consumed intent.
		expect(isUpwardHistoryScroll(0, 0, false)).toBe(false);
		expect(isUpwardHistoryScroll(0, 300, false)).toBe(false);
		expect(isUpwardHistoryScroll(300, 299.5, false)).toBe(false);
		expect(isUpwardHistoryScroll(300, 299, false)).toBe(false);
	});

	it("recognizes a drag even while a different programmatic position is suppressed", async () => {
		const { isSuppressedScrollEcho, isUpwardHistoryScroll } = await import(
			"./PretextExactMessageList"
		);
		expect(isUpwardHistoryScroll(1000, 0, isSuppressedScrollEcho(true, 1000, 0))).toBe(true);
	});

	it("preserves manual mode, the loading lock and the end-of-history guard", async () => {
		const { isUpwardHistoryScroll } = await import("./PretextExactMessageList");
		const intentAt = isUpwardHistoryScroll(1000, 0, false) ? baseInput.now : null;
		for (const guard of [{ autoLoadEnabled: false }, { expanding: true }, { hasOlder: false }]) {
			expect(resolveOlderHistoryAutoLoad({ ...baseInput, intentAt, ...guard }).shouldLoad).toBe(
				false,
			);
		}
	});

	it("consumes intent once and does not re-arm from a prepend correction or an idle top", async () => {
		const { isUpwardHistoryScroll } = await import("./PretextExactMessageList");
		const loaded = resolveOlderHistoryAutoLoad({ ...baseInput, intentAt: baseInput.now });
		expect(loaded).toEqual({ shouldLoad: true, nextIntentAt: null });
		for (const [previousTop, nextTop, isEcho] of [
			[0, 0, false],
			[300, 300, true],
			[300, 300, false],
		] as const) {
			const intentAt = isUpwardHistoryScroll(previousTop, nextTop, isEcho)
				? baseInput.now
				: loaded.nextIntentAt;
			expect(
				resolveOlderHistoryAutoLoad({ ...baseInput, intentAt, scrollTop: nextTop }).shouldLoad,
			).toBe(false);
		}
	});

	it("records scroll-frame intent before evaluating the auto-load gate", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const frame = source.slice(
			source.indexOf("const processScrollFrame = useCallback("),
			source.indexOf("const onScroll = useCallback("),
		);
		expect(frame).toContain("if (isUpwardHistoryScroll(previousTop, nextTop, isEcho))");
		const intentWrite = frame.indexOf("olderHistoryIntentAtRef.current = Date.now();");
		expect(intentWrite).toBeGreaterThan(-1);
		expect(intentWrite).toBeLessThan(frame.indexOf("maybeAutoLoadOlder("));
	});

	it("records native message reveals as programmatic scrolls too", async () => {
		const source = await Bun.file(
			new URL("./PretextExactMessageList.tsx", import.meta.url).pathname,
		).text();
		const reveal = source.slice(
			source.indexOf("const revealMounted = () =>"),
			source.indexOf("const revealByLayout = async"),
		);
		expect(reveal).toContain('behavior: "instant"');
		expect(reveal).toContain("writeScrollTop(node.scrollTop)");
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
		// The re-glue SNAPS: what reaches it is a row settling its post-paint height,
		// not content arriving. It only stands down for an active chase so it cannot
		// cut a streaming glide short. (See the settle-vs-arrival group below.)
		expect(frame).toContain(
			"if (grewBeneathReader && smoothFollowerRef.current?.isActive() !== true)",
		);
		expect(frame).toContain("writeScrollTop(getScrollBottomTarget(node));");
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

	/**
	 * ONE writer glides, and that is the whole point.
	 *
	 * "Content ARRIVED for a reader who is watching" is the only thing worth
	 * animating. The other bottom writers answer a document being ESTABLISHED or
	 * SETTLING — a fresh load, a narrator switch, a prepend re-pin, a row reporting
	 * its post-paint height, a footer resolving, a resize — and every one of those is
	 * a small delta, so routing them through the same gate made the list animate its
	 * own mount: opening a narrator visibly scrolled DOWN into place instead of
	 * opening at the bottom. That was a shipped regression, twice removed from
	 * anything a test on the pure gate could have caught.
	 */
	it("glides ONLY the stamped tail-growth correction", async () => {
		const source = await shell();
		// The one glide entry point: a bottom correction the coordinator stamped as
		// tail growth (streaming row / appended message / live patch at the tail).
		expect(source).toContain('anchorKind === "bottom" && smoothFollow === true');
		expect(source).toContain("getSmoothFollower().ensure();");
		// And it is the ONLY one. `ensure()` anywhere else is how the mount animation
		// came back.
		expect(source.match(/getSmoothFollower\(\)\.ensure\(\)/g)?.length).toBe(1);
	});

	it("the pin effect SNAPS, standing down only for an active chase", async () => {
		const source = await shell();
		const pinEffect = source.slice(
			source.indexOf("const scrollGeometryRevision ="),
			source.indexOf("const scrollGeometryRevision =") + 1800,
		);
		// Yields to a chase (an unconditional write would land at the bottom on the
		// next frame and cut every streaming glide short)…
		expect(pinEffect).toContain("if (smoothFollowerRef.current?.isActive() === true) return;");
		// …otherwise snaps, exactly as it did before any of this work.
		expect(pinEffect).toContain("writeScrollTop(getScrollBottomTarget(viewportRef.current));");
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
