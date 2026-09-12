import { useCallback, useEffect, useRef, useState } from "react";
import { isAltKey } from "../components/narrator/lod/lod-indicator";

/**
 * useLodIndicatorTrigger — "is Alt held with the pointer over THIS panel?"
 *
 * Holding Alt keeps the LOD indicator on screen. Two panels can be docked side by
 * side, so the modifier alone is not enough: the pointer must also be inside the
 * panel's message area, otherwise every mounted panel would light up.
 *
 * Pointer containment is derived from a ref-only mousemove listener (no state
 * writes, so no re-render per pixel) plus `elementFromPoint` at the moment Alt
 * goes down — the user may press Alt without moving the mouse first, and a
 * mouseenter that fired minutes ago is exactly the information we need then.
 *
 * Alt-held is resynced from every mouse/key event's `altKey`, because a keyup
 * can be swallowed (window switch, OS menu grabbing Alt) and a stuck "held"
 * state would leave the indicator pinned open. blur/focus/visibilitychange all
 * reset it: alt+tab swallows the keyup on the way OUT and gives us no way to
 * learn the key's real state on the way BACK IN, so returning to the page must
 * assume Alt is up rather than inherit a belief from before the switch.
 */
export function useLodIndicatorTrigger(
	containerRef: React.RefObject<HTMLElement | null>,
	enabled = true,
): boolean {
	const [active, setActive] = useState(false);
	const altHeldRef = useRef(false);
	const pointRef = useRef<{ x: number; y: number } | null>(null);

	const isInside = useCallback(
		(target: EventTarget | null): boolean => {
			const container = containerRef.current;
			if (!container) return false;
			if (target instanceof Node && container.contains(target)) return true;
			// No usable target (key events) — fall back to the last known pointer
			// position, which is what "pointer is over this panel" means here.
			const point = pointRef.current;
			if (!point) return false;
			const el = document.elementFromPoint(point.x, point.y);
			return !!el && container.contains(el);
		},
		[containerRef],
	);

	useEffect(() => {
		if (!enabled) {
			setActive(false);
			altHeldRef.current = false;
			return;
		}
		const sync = (altKey: boolean, target: EventTarget | null) => {
			altHeldRef.current = altKey;
			const next = altKey && isInside(target);
			setActive((prev) => (prev === next ? prev : next));
		};
		const onKeyDown = (e: KeyboardEvent) => {
			// Only Alt-alone reveals the indicator: Alt+letter combos are shortcuts and
			// must not flash an overlay the user did not ask for.
			if (!isAltKey(e.key)) {
				if (altHeldRef.current) sync(false, null);
				return;
			}
			sync(true, null);
		};
		const onKeyUp = (e: KeyboardEvent) => {
			if (e.altKey && !isAltKey(e.key)) return;
			sync(false, null);
		};
		const onMouseMove = (e: MouseEvent) => {
			pointRef.current = { x: e.clientX, y: e.clientY };
			if (!altHeldRef.current && !e.altKey) return;
			sync(e.altKey, e.target);
		};
		const reset = () => {
			altHeldRef.current = false;
			setActive((prev) => (prev ? false : prev));
		};
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		document.addEventListener("mousemove", onMouseMove, { passive: true });
		window.addEventListener("blur", reset);
		// Focus too, not just blur: alt+tab arrives back with Alt possibly released
		// outside the page, and the following keyup never reaches us.
		window.addEventListener("focus", reset);
		document.addEventListener("visibilitychange", reset);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			document.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("blur", reset);
			window.removeEventListener("focus", reset);
			document.removeEventListener("visibilitychange", reset);
		};
	}, [enabled, isInside]);

	return active;
}
