/**
 * Build a WebSocket URL for the given path (e.g. "/ws/narrator").
 *
 * In development, when the page is served through an IDE port-forward that
 * does NOT proxy WebSocket upgrades, set `VITE_WS_URL` to the backend
 * origin (e.g. "ws://localhost:7779") so WS connections bypass the
 * port-forward and hit the backend directly.
 *
 * Falls back to deriving the URL from `window.location` (works when the
 * browser talks to Vite or the production server directly).
 */
export function buildWsUrl(path: string, query?: string): string {
	const override = import.meta.env.VITE_WS_URL as string | undefined;
	if (override) {
		const base = override.replace(/\/+$/, "");
		return `${base}${path}${query ? `?${query}` : ""}`;
	}
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}${path}${query ? `?${query}` : ""}`;
}

/**
 * Safely close a WebSocket, suppressing the "closed before established" warning
 * that occurs when React StrictMode unmounts during the CONNECTING phase.
 *
 * Detaches all handlers first, then either closes immediately (if OPEN) or
 * waits for the connection to open before closing (if CONNECTING).
 */
export function safeCloseWs(ws: WebSocket | null, beforeClose?: (ws: WebSocket) => void): void {
	if (!ws) return;
	ws.onmessage = null;
	ws.onerror = null;
	if (ws.readyState === WebSocket.CONNECTING) {
		// Wait for the connection to establish, then close it cleanly
		ws.onopen = () => ws.close();
		ws.onclose = null;
	} else {
		ws.onopen = null;
		ws.onclose = null;
		if (ws.readyState === WebSocket.OPEN) {
			beforeClose?.(ws);
		}
		ws.close();
	}
}
