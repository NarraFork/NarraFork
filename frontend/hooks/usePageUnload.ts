import { useEffect, useRef, useState } from "react";

/**
 * Tracks page visibility and returns `true` when the page has been hidden
 * (i.e. the browser tab is in the background) for longer than `timeoutMs`.
 *
 * When the user returns, `unloaded` resets to `false` so the consumer can
 * remount heavy components (WebSocket connections, terminals, etc.).
 *
 * @param timeoutMs  Duration in ms before a hidden page is considered "unloaded". Default: 1 minute.
 */
export function usePageUnload(timeoutMs = 60_000): boolean {
	const [unloaded, setUnloaded] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		function clearTimer() {
			if (timerRef.current !== undefined) {
				clearTimeout(timerRef.current);
				timerRef.current = undefined;
			}
		}

		function scheduleUnload() {
			clearTimer();
			timerRef.current = setTimeout(() => {
				timerRef.current = undefined;
				// Only mark as unloaded if the page is *still* hidden. A mobile
				// browser may freeze a backgrounded tab and fire this pending
				// timer late — right when the page is resumed. Without this guard
				// the state would flip to `true` after the user already returned,
				// and since no further `visibilitychange -> visible` event fires,
				// it would stay stuck on the "paused" screen forever.
				if (document.hidden) {
					setUnloaded(true);
				}
			}, timeoutMs);
		}

		function restore() {
			clearTimer();
			setUnloaded(false);
		}

		function onVisibilityChange() {
			if (document.hidden) {
				// Page went to background — start countdown
				scheduleUnload();
			} else {
				// Page came back — cancel pending timer & restore
				restore();
			}
		}

		document.addEventListener("visibilitychange", onVisibilityChange);
		// Extra safety nets: some mobile browsers restore a frozen / bfcached
		// page without a reliable `visibilitychange -> visible` event. These
		// guarantee we always recover when the page becomes active again.
		window.addEventListener("focus", restore);
		window.addEventListener("pageshow", restore);

		// Reconcile on mount / effect re-run: if we're currently visible, make
		// sure we're not stuck in the unloaded state.
		if (!document.hidden) {
			restore();
		}

		return () => {
			clearTimer();
			document.removeEventListener("visibilitychange", onVisibilityChange);
			window.removeEventListener("focus", restore);
			window.removeEventListener("pageshow", restore);
		};
	}, [timeoutMs]);

	return unloaded;
}
