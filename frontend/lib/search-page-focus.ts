/**
 * "Put the cursor in the search page's box": asked by ⌘K / Ctrl+K and the sidebar's
 * Search row. The page may not be mounted yet (the shortcut navigates there first), so
 * the request is held until the box takes it.
 */

let pending = false;
const listeners = new Set<() => void>();

export function requestSearchPageFocus(): void {
	pending = true;
	for (const listener of listeners) listener();
}

export function takeSearchPageFocusRequest(): boolean {
	const was = pending;
	pending = false;
	return was;
}

export function subscribeSearchPageFocus(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
