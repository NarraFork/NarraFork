/**
 * Build a WebSocket URL for the given path (e.g. "/ws/narrator").
 *
 * Bun's `node:http` compatibility layer does not correctly handle HTTP 101
 * upgrade responses (it fires `response` instead of `upgrade`), which breaks
 * Vite's http-proxy WebSocket forwarding when Vite runs under `bunx`.
 *
 * To work around this, set `VITE_BACKEND_WS` to the backend origin
 * (e.g. "ws://localhost:7778") so WebSocket connections bypass Vite's proxy
 * and connect to the backend directly.
 *
 * In production (or when the env var is unset and the page is served by the
 * backend itself), the URL is derived from `window.location`.
 */
export function buildWsUrl(path: string, query?: string): string {
	const override = import.meta.env.VITE_BACKEND_WS as string | undefined;
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
