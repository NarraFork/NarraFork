/**
 * Window Controls Overlay (WCO) tracking.
 *
 * When the installed PWA runs with `display-mode: window-controls-overlay`, the OS
 * window buttons float over the page and the whole title-bar strip is ours to paint
 * (see `display_override` in the web manifest). The layout adapts via the
 * `data-nf-wco` attribute on <html> plus CSS `env(titlebar-area-*)` variables
 * (styles/wco.css); this module owns the attribute, nothing else.
 *
 * Why JS at all: the geometry comes from `env(titlebar-area-*)`, but no CSS feature
 * can tell WHICH SIDE the buttons are on. `getTitlebarAreaRect()` can — the free
 * area starts after the buttons on macOS/RTL (rect.x > 0) and ends before them on
 * Windows/Linux (rect.x == 0). VS Code uses the same signal.
 */

export type WcoControlsSide = "left" | "right";

export const WCO_ATTRIBUTE = "data-nf-wco";

interface WindowControlsOverlayLike {
	visible: boolean;
	getTitlebarAreaRect: () => { x: number };
	addEventListener?: (type: string, listener: () => void) => void;
	removeEventListener?: (type: string, listener: () => void) => void;
}

function readOverlay(targetWindow: Window): WindowControlsOverlayLike | undefined {
	return (
		targetWindow.navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike }
	).windowControlsOverlay;
}

/**
 * Which side the OS buttons occupy, or null when the overlay is not showing.
 *
 * `visible` (not just the API's presence) is the gate: it is true even in
 * fullscreen where the buttons are hidden, but it is false whenever the page is
 * not running with the overlay — a plain tab never gets the attribute and never
 * pays for the CSS.
 */
export function readWcoControlsSide(targetWindow: Window): WcoControlsSide | null {
	const overlay = readOverlay(targetWindow);
	if (!overlay || overlay.visible !== true) return null;
	let x = 0;
	try {
		x = overlay.getTitlebarAreaRect().x;
	} catch {
		// A throwing getter must not take down shell startup; "right" matches the
		// zero-inset default the CSS variables already assume.
		x = 0;
	}
	return x > 0 ? "left" : "right";
}

/**
 * Keep `data-nf-wco` on <html> in sync with the overlay's visibility and side.
 * Initial state is applied synchronously so a PWA launch never paints the wide
 * header first; `geometrychange` covers window moves between screens and
 * fullscreen transitions, the media-query listener covers display-mode changes.
 */
export function installWcoTracking(
	targetWindow: Window = window,
	targetDocument: Document = document,
): () => void {
	const root = targetDocument.documentElement;
	const overlay = readOverlay(targetWindow);
	const mediaQuery = targetWindow.matchMedia?.("(display-mode: window-controls-overlay)");

	const update = () => {
		const side = readWcoControlsSide(targetWindow);
		if (side) root.setAttribute(WCO_ATTRIBUTE, side);
		else root.removeAttribute(WCO_ATTRIBUTE);
	};

	overlay?.addEventListener?.("geometrychange", update);
	mediaQuery?.addEventListener?.("change", update);
	update();

	return () => {
		overlay?.removeEventListener?.("geometrychange", update);
		mediaQuery?.removeEventListener?.("change", update);
		root.removeAttribute(WCO_ATTRIBUTE);
	};
}
