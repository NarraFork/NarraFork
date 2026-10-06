/**
 * Page lifecycle observer shared by the WebSocket managers.
 *
 * `visibilitychange` alone is not enough to detect that a browser threw away a
 * connection:
 *
 * - Entering the back/forward cache fires `pagehide` (with `persisted: true`),
 *   and Chrome's tab freezing fires `freeze`. Neither is guaranteed to be
 *   preceded by a `visibilitychange`, so a manager that only tracks
 *   `visibilitychange` never records that the page went away and computes a
 *   hidden duration of 0 on return.
 * - Restoring from the back/forward cache (`pageshow` with `persisted: true`)
 *   and resuming from a freeze (`resume`) are *deterministic* signals that the
 *   socket is gone — the resurrected `WebSocket` object may still report
 *   `readyState === OPEN` for a while, so `readyState` must not be trusted for
 *   this decision.
 *
 * The event target is injectable so tests can drive the sequences without a
 * real browser.
 */

export interface PageLifecycleHandlers {
	/**
	 * The page went to the background, was frozen, or is being unloaded.
	 * `persisted` is true when the page is entering the back/forward cache
	 * (or was frozen), i.e. it can come back later.
	 */
	onHidden?: (info: { persisted: boolean }) => void;
	/**
	 * The browser definitively discarded this page's connections and brought the
	 * page back: restored from the back/forward cache, or resumed from a freeze.
	 */
	onRestoredFromCache?: () => void;
	/** The page may be in the foreground again (visible / focused / shown). */
	onForeground?: () => void;
}

export interface PageLifecycleTarget {
	window: EventTarget & { addEventListener: EventTarget["addEventListener"] };
	document: EventTarget & { visibilityState?: DocumentVisibilityState };
}

function defaultTarget(): PageLifecycleTarget | null {
	if (typeof window === "undefined" || typeof document === "undefined") return null;
	return { window, document };
}

/**
 * Subscribe to the page lifecycle events that matter for connection recovery.
 * Returns an idempotent unsubscribe function.
 */
export function observePageLifecycle(
	handlers: PageLifecycleHandlers,
	target: PageLifecycleTarget | null = defaultTarget(),
): () => void {
	if (!target) return () => {};
	const { window: windowTarget, document: documentTarget } = target;

	const onVisibilityChange = () => {
		if (documentTarget.visibilityState === "hidden") handlers.onHidden?.({ persisted: false });
		else handlers.onForeground?.();
	};
	const onPageHide = (event: Event) => {
		// A bfcache-bound pagehide keeps the page alive; a real unload does not.
		handlers.onHidden?.({ persisted: (event as PageTransitionEvent).persisted === true });
	};
	// Chrome freezes background tabs. The socket is dropped without a close event
	// the page can observe, so treat it exactly like a bfcache entry.
	const onFreeze = () => handlers.onHidden?.({ persisted: true });
	const onPageShow = (event: Event) => {
		if ((event as PageTransitionEvent).persisted === true) handlers.onRestoredFromCache?.();
		handlers.onForeground?.();
	};
	const onResume = () => {
		handlers.onRestoredFromCache?.();
		handlers.onForeground?.();
	};
	const onFocus = () => handlers.onForeground?.();

	documentTarget.addEventListener("visibilitychange", onVisibilityChange);
	// `freeze`/`resume` are document-level Page Lifecycle events. Registering them
	// where they are unsupported is a no-op, so no feature detection is needed.
	documentTarget.addEventListener("freeze", onFreeze);
	documentTarget.addEventListener("resume", onResume);
	windowTarget.addEventListener("pagehide", onPageHide);
	windowTarget.addEventListener("pageshow", onPageShow);
	windowTarget.addEventListener("focus", onFocus);

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		documentTarget.removeEventListener("visibilitychange", onVisibilityChange);
		documentTarget.removeEventListener("freeze", onFreeze);
		documentTarget.removeEventListener("resume", onResume);
		windowTarget.removeEventListener("pagehide", onPageHide);
		windowTarget.removeEventListener("pageshow", onPageShow);
		windowTarget.removeEventListener("focus", onFocus);
	};
}
