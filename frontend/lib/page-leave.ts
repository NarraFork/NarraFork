/**
 * "The page is going away": one listener for the whole tab on `pagehide` and on the document
 * becoming hidden (the last moment a phone's browser reliably gives), handed to whoever
 * registered. For state that is written after a short delay (the outline's folding): what is
 * still waiting goes out at once, with `keepalive`.
 *
 * It lives in `lib` because components of the outline may not listen on the window or the
 * document themselves (`OutlineSurface.test.tsx`, "hosting rules": several trees can be on
 * screen, and each would add its own listener); they register here instead.
 */

const flushers = new Set<() => void>();
let installed = false;

function flushAll(): void {
	for (const flush of [...flushers]) {
		try {
			flush();
		} catch {
			// One failing flusher does not keep the others from running.
		}
	}
}

function onVisibility(): void {
	if (document.visibilityState === "hidden") flushAll();
}

/** Call `flush` when the page is hidden or goes away; returns the unregister. */
export function onPageLeave(flush: () => void): () => void {
	flushers.add(flush);
	if (!installed && typeof window !== "undefined" && typeof document !== "undefined") {
		installed = true;
		window.addEventListener("pagehide", flushAll);
		document.addEventListener("visibilitychange", onVisibility);
	}
	return () => {
		flushers.delete(flush);
	};
}

const holds = new Set<symbol>();

function askBeforeLeaving(event: BeforeUnloadEvent): void {
	event.preventDefault();
	// Older browsers show the prompt only when a value is set.
	event.returnValue = "";
}

/**
 * Ask before the page goes away while something must not be cut short (an outline restore
 * running call after call): the browser's own "leave this page?" prompt, while any hold is
 * held. Returns the release.
 */
export function holdPageLeave(): () => void {
	const hold = Symbol("hold");
	if (holds.size === 0 && typeof window !== "undefined")
		window.addEventListener("beforeunload", askBeforeLeaving);
	holds.add(hold);
	return () => {
		if (!holds.delete(hold)) return;
		if (holds.size === 0 && typeof window !== "undefined")
			window.removeEventListener("beforeunload", askBeforeLeaving);
	};
}
