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
		function onVisibilityChange() {
			if (document.hidden) {
				// Page went to background — start countdown
				timerRef.current = setTimeout(() => {
					setUnloaded(true);
				}, timeoutMs);
			} else {
				// Page came back — cancel pending timer & restore
				clearTimeout(timerRef.current);
				setUnloaded(false);
			}
		}

		document.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			clearTimeout(timerRef.current);
			document.removeEventListener("visibilitychange", onVisibilityChange);
		};
	}, [timeoutMs]);

	return unloaded;
}
