/**
 * "Put the cursor in the home page's composer."
 *
 * The sidebar's "New session" goes to `/` and asks for focus. The composer may not be
 * mounted yet (the route is still loading) or may already be on screen, so the request
 * is held until a composer takes it: an already-mounted composer takes it at once, a
 * composer mounting afterwards takes it on mount.
 */

type Listener = () => void;

let pending = false;
const listeners = new Set<Listener>();

export function requestDashboardComposerFocus(): void {
	pending = true;
	for (const listener of listeners) listener();
}

/** Returns true (and clears the request) when a focus request is waiting. */
export function takeDashboardComposerFocusRequest(): boolean {
	const was = pending;
	pending = false;
	return was;
}

export function subscribeDashboardComposerFocus(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
