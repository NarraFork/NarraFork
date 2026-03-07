/**
 * Build a WebSocket URL for the given path (e.g. "/ws/narrator").
 *
 * Bun's `node:http` compatibility layer does not correctly handle HTTP 101
 * upgrade responses, which breaks Vite's http-proxy WebSocket forwarding
 * when Vite runs under `bunx`.
 *
 * To work around this, in dev mode we detect whether the page is being
 * accessed directly via the Vite dev server (localhost + Vite port).  If so,
 * we rewrite the WS URL to point at the backend port directly, bypassing
 * Vite's broken proxy.
 *
 * When accessed through a reverse proxy (or in production), the URL is
 * derived from `window.location` so it always goes through the same host
 * the page was loaded from.
 */

declare const __DEV_VITE_PORT__: string | undefined;
declare const __DEV_BACKEND_PORT__: string | undefined;

export function buildWsUrl(path: string, query?: string): string {
	const suffix = query ? `?${query}` : "";

	// Dev mode: if we're hitting the Vite dev server directly on localhost,
	// bypass its broken WS proxy and connect to the backend port instead.
	if (
		typeof __DEV_VITE_PORT__ === "string" &&
		typeof __DEV_BACKEND_PORT__ === "string" &&
		isLocalViteDirect(__DEV_VITE_PORT__)
	) {
		return `ws://${window.location.hostname}:${__DEV_BACKEND_PORT__}${path}${suffix}`;
	}

	// Production / reverse-proxy: derive from the page URL.
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${window.location.host}${path}${suffix}`;
}

/**
 * Returns true when the browser is talking directly to the Vite dev server
 * (i.e. localhost/127.0.0.1 on the expected Vite port).
 * When behind a reverse proxy the host/port will differ, so this returns false.
 */
function isLocalViteDirect(vitePort: string): boolean {
	const { hostname, port } = window.location;
	const isLocal = hostname === "localhost" || hostname === "127.0.0.1";
	return isLocal && port === vitePort;
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
