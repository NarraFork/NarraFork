/**
 * pinch-zoom-guard.ts — keep multi-touch gestures inside the app.
 *
 * `index.html` declares `user-scalable=no, maximum-scale=1.0`, and Chromium plus
 * iOS home-screen web apps honour it. Safari in a browser tab (iOS 10+) ignores
 * both, so on a tablet a two-finger gesture zooms the *page* instead of reaching
 * the handler under the fingers: the narrator list's LOD pinch, the ruler camera,
 * the terminal font size.
 *
 * The meta tag cannot be patched up from inside a component, because of the ORDER
 * in which a gesture is claimed. Every in-app pinch handler calls preventDefault()
 * only once its own threshold is crossed — PretextExactMessageList and
 * ChunkedMessageList both wait for the 1.2 distance ratio — but the engine decides
 * who owns the gesture on its FIRST two-finger move. By then the viewport has taken
 * it, and a later preventDefault() cannot take it back.
 *
 * So the browser's zoom is refused up front, in the capture phase, before any
 * component handler runs. preventDefault() suppresses the default action only;
 * propagation is untouched, so every existing pinch handler still receives the whole
 * gesture — it just no longer competes with the viewport for it.
 *
 * Two hooks, with deliberately different breadth:
 *
 *   - `gesturestart` / `gesturechange` / `gestureend` — WebKit's own pinch/rotate
 *     stream, refused unconditionally. This is Safari's viewport zoom and nothing
 *     else: these events do not fire for scrolling, so blocking them costs nothing.
 *     This alone covers the reported iPad case.
 *
 *   - `touchmove` with two or more touches — cross-engine cover for anything that
 *     ignores the meta tag AND has no gesture events. Refused only once the distance
 *     between the fingers actually *changes*, because a constant-distance two-finger
 *     drag is a pan, and on a tablet that is a normal way to scroll. Blocking every
 *     two-finger move would freeze that scroll app-wide.
 *
 * Deliberately NOT guarded: single-finger touchmove (that is scrolling, which the app
 * depends on) and ctrl+wheel (a desktop pointer zoom, not the touch gesture this owns,
 * and no in-app gesture competes with it).
 */

/**
 * Capture so the guard resolves before component handlers, non-passive so
 * preventDefault() is honoured rather than logged as an intervention.
 */
const GUARD_LISTENER_OPTIONS = { capture: true, passive: false } as const;

/** Symmetric options for teardown: the capture flag is part of a listener's identity. */
const GUARD_REMOVE_OPTIONS = { capture: true } as const;

/** WebKit's non-standard pinch/rotate gesture stream. */
export const WEBKIT_GESTURE_EVENTS = ["gesturestart", "gesturechange", "gestureend"] as const;

/**
 * How far the finger distance may drift before the gesture counts as a zoom.
 *
 * Set well below the 1.2 ratio the LOD handlers act on, so the guard has already
 * claimed the gesture by the time an in-app handler wants it, yet above the jitter of
 * a two-finger pan (fingers wobble by a few px while dragging) so panning still
 * scrolls.
 */
export const PAGE_ZOOM_SCALE_TOLERANCE = 0.05;

/** Minimum two-touch coordinates the gate needs; a real TouchList satisfies it. */
export interface GateTouchPoint {
	clientX: number;
	clientY: number;
}

/** Distance between the first two touches, or 0 when fewer than two are down. */
export function touchSpread(touches: ReadonlyArray<GateTouchPoint>): number {
	const a = touches[0];
	const b = touches[1];
	if (!a || !b) return 0;
	return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * The stateful half of the touch hook, kept DOM-free so the pan-vs-zoom decision is
 * unit-testable without synthesizing TouchEvents.
 *
 * Latching matters: once a gesture is identified as a zoom it stays blocked until the
 * fingers lift. Re-deciding per frame would let a pinch that pauses mid-gesture hand
 * the viewport back a frame of zoom.
 */
export function createPageZoomTouchGate(tolerance: number = PAGE_ZOOM_SCALE_TOLERANCE): {
	/** Whether this move must be refused. Also advances the gate's state. */
	shouldRefuse: (touches: ReadonlyArray<GateTouchPoint>) => boolean;
	/** Called when a touch ends/cancels; resets once fewer than two fingers remain. */
	release: (remainingTouches: number) => void;
} {
	let baseline = 0;
	let latched = false;
	return {
		shouldRefuse(touches) {
			if (touches.length < 2) {
				// One finger is a scroll, and it also ends any pinch that was running.
				baseline = 0;
				latched = false;
				return false;
			}
			if (latched) return true;
			const spread = touchSpread(touches);
			if (baseline <= 0) {
				// First frame of the gesture: no distance change is observable yet, so it
				// is indistinguishable from a pan. Recording the baseline is all that can
				// be done honestly here.
				baseline = spread;
				return false;
			}
			if (Math.abs(spread / baseline - 1) <= tolerance) return false;
			latched = true;
			return true;
		},
		release(remainingTouches) {
			if (remainingTouches >= 2) return;
			baseline = 0;
			latched = false;
		},
	};
}

/**
 * Refuse browser page zoom for the lifetime of the document.
 *
 * Installed once at bootstrap (see `main.tsx`) rather than per route or per panel:
 * the no-zoom contract is app-wide and stated in `index.html`, and a listener that
 * came and went with a route would leave gaps exactly where a gesture starts.
 *
 * @returns a disposer that removes every listener it added.
 */
export function installPinchZoomGuard(targetDocument: Document = document): () => void {
	const gate = createPageZoomTouchGate();

	const refuse = (event: Event) => {
		// A touchmove stops being cancelable once the engine has committed to a scroll;
		// calling preventDefault() then is a console warning and nothing else.
		if (event.cancelable) event.preventDefault();
	};
	const onTouchMove = (event: Event) => {
		const touches = (event as TouchEvent).touches;
		if (!gate.shouldRefuse(touches ? Array.from(touches) : [])) return;
		refuse(event);
	};
	const onTouchEnd = (event: Event) => {
		gate.release((event as TouchEvent).touches?.length ?? 0);
	};

	for (const type of WEBKIT_GESTURE_EVENTS) {
		targetDocument.addEventListener(type, refuse, GUARD_LISTENER_OPTIONS);
	}
	targetDocument.addEventListener("touchmove", onTouchMove, GUARD_LISTENER_OPTIONS);
	targetDocument.addEventListener("touchend", onTouchEnd, GUARD_LISTENER_OPTIONS);
	targetDocument.addEventListener("touchcancel", onTouchEnd, GUARD_LISTENER_OPTIONS);

	return () => {
		for (const type of WEBKIT_GESTURE_EVENTS) {
			targetDocument.removeEventListener(type, refuse, GUARD_REMOVE_OPTIONS);
		}
		targetDocument.removeEventListener("touchmove", onTouchMove, GUARD_REMOVE_OPTIONS);
		targetDocument.removeEventListener("touchend", onTouchEnd, GUARD_REMOVE_OPTIONS);
		targetDocument.removeEventListener("touchcancel", onTouchEnd, GUARD_REMOVE_OPTIONS);
	};
}
