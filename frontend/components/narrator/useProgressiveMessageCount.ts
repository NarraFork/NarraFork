import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Progressive message rendering: render messages in batches to avoid blocking
 * the main thread when there are many cached messages (100–200+).
 */
export function useProgressiveMessageCount(
	totalMessages: number,
	batchSize: number,
	skip: boolean,
	resetKey: string,
	viewportRef: React.RefObject<HTMLDivElement | null>,
): { visibleCount: number; done: boolean } {
	const [count, setCount] = useState(batchSize);
	const prevTotalRef = useRef(totalMessages);
	const prevResetKeyRef = useRef(resetKey);
	const needsSnapRef = useRef(false);
	// Track the effectiveCount that actually drives DOM rendering, so the
	// useLayoutEffect can fire on the *same* render that changes the DOM —
	// not one render later when the queued setCount finally takes effect.
	const prevEffectiveRef = useRef(count);

	let effectiveCount = count;
	if (prevResetKeyRef.current !== resetKey) {
		// Narrator switch — force progressive re-render from scratch.
		// ⚠️ DO NOT skip progressive rendering even when cached data exists!
		// The whole point of progressive rendering is to avoid blocking the
		// main thread when there are many cached messages (100–200+). Rendering
		// them all at once causes a visible hang / frame drop on entry.
		prevResetKeyRef.current = resetKey;
		prevTotalRef.current = totalMessages;
		setCount(batchSize);
		effectiveCount = batchSize;
		needsSnapRef.current = true;
	} else if (prevTotalRef.current !== totalMessages) {
		const prevTotal = prevTotalRef.current;
		prevTotalRef.current = totalMessages;
		if (count > totalMessages) {
			// Fewer messages than before (e.g. switched context) — reset
			setCount(batchSize);
			effectiveCount = batchSize;
		} else if (prevTotal === 0 && totalMessages > batchSize) {
			// Initial data load (was empty, now has messages) — start progressive
			setCount(batchSize);
			effectiveCount = batchSize;
			needsSnapRef.current = true;
		} else if (totalMessages > count) {
			// Both loadOlder (large batch) and WS append (small) — render immediately.
			// overflow-anchor handles scroll compensation for prepended content;
			// the useLayoutEffect scrollTop=1 hack prevents anchor latching to top.
			setCount(totalMessages);
			effectiveCount = totalMessages;
		}
	}

	useEffect(() => {
		if (skip || count >= totalMessages) return;
		const id = setTimeout(() => {
			setCount((c) => Math.min(c + batchSize, totalMessages));
		}, 50);
		return () => clearTimeout(id);
	}, [skip, count, totalMessages, batchSize]);

	// After each batch renders to DOM (useLayoutEffect = before browser paint):
	// 1. Snap to bottom on initial load / narrator switch (needsSnapRef).
	// 2. Otherwise, ensure scrollTop > 0 so overflow-anchor doesn't latch onto
	//    the top edge — which would cause the viewport to stick to the top
	//    instead of compensating for prepended content.
	//    Done here (not in the timer callback) to avoid racing with the
	//    browser's anchor recalculation between frames.
	//
	// We track effectiveCount via a ref instead of depending on `count` state,
	// because when loading older messages, effectiveCount is set synchronously
	// in the render phase (the DOM changes immediately), but the `setCount`
	// state update only takes effect on the *next* render. If we depended on
	// `count`, the scrollTop=1 hack would be one frame too late, allowing
	// overflow-anchor to latch onto the top edge in the intervening paint.
	const effectiveChanged = prevEffectiveRef.current !== effectiveCount;
	prevEffectiveRef.current = effectiveCount;
	const isProgressing = !skip && totalMessages > effectiveCount;
	// Also snap when needsSnapRef was just set (e.g. initial data load where
	// effectiveCount stays at batchSize — the value didn't change but we still
	// need to scroll to bottom on the very first batch).
	const needsInitialSnap = needsSnapRef.current && effectiveCount >= batchSize;
	useLayoutEffect(() => {
		if (!effectiveChanged && !needsInitialSnap) return;
		const vp = viewportRef.current;
		if (!vp) return;
		if (needsSnapRef.current) {
			if (effectiveCount < batchSize) return;
			// Keep snapping to bottom throughout the entire progressive rendering
			// phase — not just the first batch. overflow-anchor alone is unreliable
			// across rapid successive DOM insertions, causing visible jitter when
			// switching back to a narrator with many cached messages.
			if (!isProgressing) {
				needsSnapRef.current = false;
			}
			vp.scrollTop = vp.scrollHeight;
			return;
		}
		// Only apply the scrollTop=1 anchor hack when content actually overflows
		// the viewport. When content is shorter than the viewport (early batches),
		// setting scrollTop=1 is meaningless and can trick the auto-load-older
		// detection into firing prematurely after initialScrollDone.
		if (vp.scrollTop === 0 && vp.scrollHeight > vp.clientHeight) {
			vp.scrollTop = 1;
		}
	});

	if (skip || totalMessages <= effectiveCount) return { visibleCount: totalMessages, done: true };
	return { visibleCount: effectiveCount, done: false };
}
