import { useEffect, useRef } from "react";

/**
 * Requests a Screen Wake Lock while `enabled` is true.
 * Automatically re-acquires the lock when the page becomes visible again.
 * Silently no-ops if the browser doesn't support the Wake Lock API.
 */
export function useWakeLock(enabled: boolean) {
	const lockRef = useRef<WakeLockSentinel | null>(null);

	useEffect(() => {
		if (!enabled || !("wakeLock" in navigator)) return;

		let cancelled = false;

		const acquire = async () => {
			try {
				const sentinel = await navigator.wakeLock.request("screen");
				if (cancelled) {
					sentinel.release();
					return;
				}
				lockRef.current = sentinel;
				sentinel.addEventListener("release", () => {
					if (lockRef.current === sentinel) lockRef.current = null;
				});
			} catch {
				// Permission denied or other error — ignore
			}
		};

		const onVisibilityChange = () => {
			if (document.visibilityState === "visible" && !lockRef.current && !cancelled) {
				acquire();
			}
		};

		acquire();
		document.addEventListener("visibilitychange", onVisibilityChange);

		return () => {
			cancelled = true;
			document.removeEventListener("visibilitychange", onVisibilityChange);
			lockRef.current?.release();
			lockRef.current = null;
		};
	}, [enabled]);
}
