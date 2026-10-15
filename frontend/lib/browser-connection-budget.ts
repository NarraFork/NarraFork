/**
 * How long a hidden tab may keep its WebSocket before giving the slot back.
 *
 * Chrome allows six HTTP/1.1 connections per host, and each open WebSocket
 * occupies one for the life of the socket. NarraFork opens that socket in
 * every tab. A handful of background tabs therefore fills the pool, and the
 * next request — the one people notice is PATCH /api/settings — sits in
 * DevTools as "Stalled" (已停止) and never leaves the browser. Clearing site
 * data does not close those sockets, which is why another browser can save
 * while this one cannot.
 *
 * A short hide keeps the socket: alt-tab should not tear down a live narrator.
 * A tab that stays in the background releases it. Coming back to the tab
 * reconnects through the existing foreground recovery.
 */
export const HIDDEN_CONNECTION_RELEASE_MS = 15_000;

export function shouldReleaseHiddenConnection(hiddenForMs: number): boolean {
	return Number.isFinite(hiddenForMs) && hiddenForMs >= HIDDEN_CONNECTION_RELEASE_MS;
}

export function isDocumentHidden(visibilityState: DocumentVisibilityState | undefined): boolean {
	return visibilityState === "hidden";
}
