/**
 * Global swipe-menu coordination.
 * Only one swipe menu (ContentViewer or ToolCallCard) can be open at a time.
 */

let globalCloseSwipe: (() => void) | null = null;

export function getGlobalCloseSwipe() {
	return globalCloseSwipe;
}

export function setGlobalCloseSwipe(fn: (() => void) | null) {
	globalCloseSwipe = fn;
}
