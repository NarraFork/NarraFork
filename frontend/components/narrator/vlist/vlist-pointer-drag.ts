/**
 * vlist-pointer-drag.ts — Live "is a drag in progress" signal.
 *
 * The width-settle rule needs to know whether the user is mid-drag. That fact
 * cannot be inferred from a clock (see vlist-width-settle), and it cannot come from
 * the resizing library either: the narrator list is dragged by at least two
 * independent hosts (dockview sashes, the ruler/graph node resizers) and is also
 * embedded in places that resize it for reasons of their own. Subscribing to each
 * host's private drag events would couple this list to all of them and still miss
 * the next one.
 *
 * A document-level listener is host-agnostic and exact. It is deliberately coarse —
 * it reports "something is being held", not "this list is being resized" — which is
 * the right trade: a press that is NOT a resize costs nothing, because the deferral
 * only engages when a width change arrives at the same time. The reverse error
 * (missing a real drag) is the one that hurts.
 *
 * BOTH EVENT FAMILIES ARE OBSERVED, and that is not redundancy.
 * ------------------------------------------------------------
 * A pointer-only version of this module silently failed on the app's own side nav,
 * which then resized through `mousedown`/`mousemove`/`mouseup` (hooks/useResizableNav.ts
 * has since moved to the pointer family, but the lesson stands): any host — or any
 * synthetic/automated gesture — that emits only mouse events becomes invisible to a
 * pointer-only tracker, and the failure mode is silent (no error, just jank returning).
 *
 * A real mouse press occupies two slots: its `pointerId` and MOUSE_ID. Normal
 * `mouseup` clears both. HTML5 drag/drop is DIFFERENT: the browser sends
 * `pointercancel` when it takes over the drag, and can finish without mouseup.
 * Native dragstart therefore holds its own slot until drop/dragend clears ALL
 * slots. Otherwise the orphaned MOUSE_ID defers a Dockview merge/swap's new width
 * until the 3s backstop, even though the user has already released the panel.
 *
 * Listeners use the CAPTURE phase with `passive: true`: capture runs before any
 * bubble-phase `stopPropagation` an intermediate node might apply, and passive
 * guarantees we never delay the gesture. (Checked: dockview's splitview attaches
 * `pointerdown` on the sash and then `pointermove`/`pointerup`/`pointercancel` on
 * `document`, and stops propagation on none of them — so capture is defensive
 * headroom for other hosts rather than a workaround for that one. Also checked: the
 * nav handle calls `preventDefault()` on `mousedown`, which per the Pointer Events
 * compatibility mapping CANNOT suppress the `pointerdown` that already fired before
 * it — so that call was never the cause.)
 *
 * `contextmenu` counts as a release too. It is how dockview itself ends a sash drag,
 * and a right-click mid-gesture can otherwise leave the button we counted without a
 * matching release — which would hold the deferral open until the backstop.
 */

export interface PointerDragTracker {
	/** True while a pointer / mouse button or browser-owned native drag is active. */
	isDown: () => boolean;
	/** Stop listening. */
	dispose: () => void;
}

/**
 * Counter slot for the mouse family, which carries no `pointerId`.
 *
 * Negative so it can never collide with a real `pointerId` (those are non-negative),
 * while still letting a physical mouse's `pointerdown` + `mousedown` pair resolve to
 * at most two slots that are both cleared by their matching releases.
 */
const MOUSE_ID = -1;
/** Browser-owned HTML5 drag: survives pointercancel until drop/dragend. */
const NATIVE_DRAG_ID = -2;

/**
 * Track pointer-down state at the document level.
 *
 * `onRelease` fires when the last active pointer goes up (or the gesture is
 * cancelled), which is the deferred rebuild's commit point.
 */
export function createPointerDragTracker(onRelease: () => void): PointerDragTracker {
	// Ref-count by pointerId rather than a boolean: a multi-touch gesture releases
	// its pointers one at a time, and a boolean would report "released" on the first
	// of them while the drag is still in progress.
	const active = new Set<number>();
	// Guard against environments without a document (SSR, non-DOM test runs).
	const target: Document | undefined = typeof document === "undefined" ? undefined : document;

	/** Slot for an event: its `pointerId`, or the shared mouse slot. */
	const slotOf = (event: Event): number => {
		const pointerId = (event as PointerEvent).pointerId;
		return typeof pointerId === "number" ? pointerId : MOUSE_ID;
	};

	const onDown = (event: Event) => {
		active.add(slotOf(event));
	};
	const onDragStart = () => {
		active.add(NATIVE_DRAG_ID);
	};
	/**
	 * Release ONE pointer. Reports a release only when it was the last one held.
	 *
	 * The empty-set guard makes this consistent with `releaseAll`: an unmatched
	 * `pointerup` (the press began before this list mounted, or a host replayed one)
	 * describes a gesture we were never tracking, so announcing a release for it would
	 * commit a rebuild on an event that changed nothing. The commit callback happens to
	 * be idempotent today — it self-guards on `deferred` — but relying on that made the
	 * three release paths mean three different things.
	 */
	const onUp = (event: Event) => {
		if (active.size === 0) return;
		active.delete(slotOf(event));
		if (active.size === 0) onRelease();
	};
	/**
	 * Release EVERY counted pointer at once.
	 *
	 * Clearing wholesale is deliberate: mouseup, drop/dragend, contextmenu and
	 * window blur all end the gesture, regardless of which event family opened it.
	 * Deleting only one slot leaves orphaned aliases when the browser suppresses
	 * mouseup during HTML5 DnD. The empty-set guard also makes drop → dragend a
	 * single release, not two layout commits.
	 */
	const releaseAll = () => {
		if (active.size === 0) return;
		active.clear();
		onRelease();
	};

	if (target) {
		target.addEventListener("pointerdown", onDown, { capture: true, passive: true });
		target.addEventListener("pointerup", onUp, { capture: true, passive: true });
		// A cancelled gesture (the browser takes over for a scroll/zoom, the pointer
		// leaves the window) never sends `pointerup`. Without this the set would keep
		// the id forever and the list would stay deferred until the backstop.
		target.addEventListener("pointercancel", onUp, { capture: true, passive: true });
		// The mouse family, for hosts that drive resizing from it (the app's own side
		// nav does — see the module comment). `mouseup` is the last event of a mouse
		// sequence, so it clears every slot rather than just the mouse one.
		target.addEventListener("mousedown", onDown, { capture: true, passive: true });
		target.addEventListener("mouseup", releaseAll, { capture: true, passive: true });
		// Browser-owned tab DnD may send neither pointerup nor mouseup. Preserve
		// the freeze through its pointercancel, then release it at the real end.
		target.addEventListener("dragstart", onDragStart, { capture: true, passive: true });
		target.addEventListener("drop", releaseAll, { capture: true, passive: true });
		target.addEventListener("dragend", releaseAll, { capture: true, passive: true });
		target.defaultView?.addEventListener("blur", releaseAll);
		// `contextmenu` carries no pointerId, and it ends the gesture however many
		// buttons were counted — so it clears them all too. (Dockview itself ends a sash
		// drag this way; a right-click mid-gesture otherwise leaves a counted button
		// without a matching release.)
		target.addEventListener("contextmenu", releaseAll, { capture: true, passive: true });
	}

	return {
		isDown: () => active.size > 0,
		dispose: () => {
			if (!target) return;
			target.removeEventListener("pointerdown", onDown, { capture: true });
			target.removeEventListener("pointerup", onUp, { capture: true });
			target.removeEventListener("pointercancel", onUp, { capture: true });
			target.removeEventListener("mousedown", onDown, { capture: true });
			target.removeEventListener("mouseup", releaseAll, { capture: true });
			target.removeEventListener("dragstart", onDragStart, { capture: true });
			target.removeEventListener("drop", releaseAll, { capture: true });
			target.removeEventListener("dragend", releaseAll, { capture: true });
			target.defaultView?.removeEventListener("blur", releaseAll);
			target.removeEventListener("contextmenu", releaseAll, { capture: true });
			active.clear();
		},
	};
}
