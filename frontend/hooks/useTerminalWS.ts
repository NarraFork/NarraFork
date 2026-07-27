/**
 * Terminal WebSocket hook — singleton connection, subscribe/unsubscribe model.
 *
 * A single WS connection to /ws/terminal manages all terminal subscriptions.
 * Components call useTerminalConnection(terminalId, callbacks) to subscribe
 * to a specific terminal's output.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";
import { buildWsUrl, safeCloseWs } from "../lib/ws";
import { removeWSStatus, setWSStatus } from "../lib/ws-status";

// === Types ===

interface TerminalWSCallbacks {
	onOutput?: (data: string) => void;
	onScrollback?: (data: string, dims: { cols: number; rows: number }) => void;
	onExit?: (code: number) => void;
	onError?: (message: string) => void;
	onRequestResize?: () => void;
	onBufferState?: (state: { mouseTracking: boolean; cursorVisible: boolean }) => void;
}

type Listener = {
	callbacks: TerminalWSCallbacks;
};

function terminalDiagnosticMessage(
	msg: Record<string, unknown>,
	fallback = "Terminal error",
): string {
	for (const key of ["reason", "message", "error", "code"]) {
		const value = msg[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return fallback;
}

// === Singleton WS Manager ===

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** After this many fast retries, we consider the connection "disconnected" (show UI). */
const DISCONNECTED_THRESHOLD = 3;
/**
 * Stop reconnecting after this many consecutive failures.
 * With exponential backoff capped at 30s this is roughly 25 minutes.
 */
const MAX_RECONNECT_ATTEMPTS = 50;
/** Server close code for "the session token that opened this socket expired". */
const SESSION_EXPIRED_CLOSE_CODE = 4001;
/** Close the connection if no server ping is received within this window. */
const CLIENT_PING_TIMEOUT_MS = 60_000;
/**
 * How long the tab must be hidden before we force a reconnect on return.
 * Matches the server heartbeat interval — if we missed at least one ping
 * cycle, the connection state is unreliable.
 */
const VISIBILITY_RECONNECT_THRESHOLD_MS = 30_000;

class TerminalWSManager {
	private ws: WebSocket | null = null;
	private listeners = new Map<string, Set<Listener>>();
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private pingTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private _connected = false;
	private _disconnected = false;
	private statusListeners = new Set<() => void>();

	// --- Visibility change tracking ---
	private _boundVisibilityHandler: (() => void) | null = null;
	private _hiddenAt = 0;

	get connected() {
		return this._connected;
	}
	get disconnected() {
		return this._disconnected;
	}

	connect() {
		// Guard: prevent duplicate connections when already connected or connecting
		if (this.ws || this.disposed) return;

		this._listenVisibility();

		const token = getToken();
		if (!token) {
			// No token yet — retry after a short delay instead of connecting
			// with empty credentials (which would waste reconnect attempts).
			this.reconnectTimer = setTimeout(() => this.connect(), 1000);
			return;
		}

		const tokenQuery = `token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(buildWsUrl("/ws/terminal", tokenQuery));
		this.ws = ws;

		ws.onopen = () => {
			if (this.disposed || this.ws !== ws) {
				ws.close();
				return;
			}
			this._connected = true;
			this._disconnected = false;
			this.reconnectAttempts = 0;
			this.notifyStatus();
			this.syncGlobalStatus();
			this.resetPingTimeout();
			// Re-subscribe all active terminals
			const ids = [...this.listeners.keys()];
			if (ids.length > 0) {
				this.send({ type: "subscribe", terminalIds: ids });
			}
		};

		ws.onmessage = (event) => {
			if (this.disposed || this.ws !== ws) return;
			try {
				const msg = JSON.parse(event.data);
				// Respond to server heartbeat ping
				if (msg.type === "ping") {
					ws.send(JSON.stringify({ type: "pong" }));
					this.resetPingTimeout();
					return;
				}
				this.handleMessage(msg);
			} catch {
				// ignore parse errors
			}
		};

		ws.onclose = (ev) => {
			if (this.disposed || this.ws !== ws) return;
			this.ws = null;
			clearTimeout(this.pingTimeoutTimer);
			this._connected = false;
			// 1001 = Going Away — server is shutting down, don't reconnect.
			if (ev.code === 1001) this._disconnected = true;
			this.notifyStatus();
			this.syncGlobalStatus();
			if (ev.code === 1001) return;
			// 4001 = the session token this socket was opened with expired. HTTP
			// sliding renewal has very likely already stored a fresh one, so retry
			// immediately with whatever is in localStorage instead of backing off.
			if (ev.code === SESSION_EXPIRED_CLOSE_CODE) {
				this.reconnectAttempts = 0;
			}
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			// onclose will fire after this — no need to schedule reconnect here
		};
	}

	private scheduleReconnect() {
		if (this.disposed) return;
		if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
			// Give up — server is likely down for good.
			if (!this._disconnected) {
				this._disconnected = true;
				this.notifyStatus();
				this.syncGlobalStatus();
			}
			return;
		}
		if (this.reconnectAttempts >= DISCONNECTED_THRESHOLD && !this._disconnected) {
			this._disconnected = true;
			this.notifyStatus();
			this.syncGlobalStatus();
		}
		const delay = Math.min(
			RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempts,
			RECONNECT_MAX_DELAY_MS,
		);
		this.reconnectAttempts++;
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	/** Reset retry counter and reconnect immediately. */
	resetReconnect() {
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
		this.reconnectAttempts = 0;
		this._disconnected = false;
		this.notifyStatus();
		this.syncGlobalStatus();
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			safeCloseWs(ws);
		}
		this.connect();
	}

	// -----------------------------------------------------------------------
	// Ping timeout — detect half-open connections
	// -----------------------------------------------------------------------

	private resetPingTimeout(): void {
		clearTimeout(this.pingTimeoutTimer);
		this.pingTimeoutTimer = setTimeout(() => {
			if (!this.disposed && this.ws?.readyState === WebSocket.OPEN) {
				this.ws.close(4000, "ping timeout");
			}
		}, CLIENT_PING_TIMEOUT_MS);
	}

	// -----------------------------------------------------------------------
	// Visibility change — recover from browser background throttling
	// -----------------------------------------------------------------------

	private _listenVisibility(): void {
		if (this._boundVisibilityHandler) return;
		this._boundVisibilityHandler = () => this._handleVisibilityChange();
		document.addEventListener("visibilitychange", this._boundVisibilityHandler);
	}

	private _unlistenVisibility(): void {
		if (this._boundVisibilityHandler) {
			document.removeEventListener("visibilitychange", this._boundVisibilityHandler);
			this._boundVisibilityHandler = null;
		}
	}

	private _handleVisibilityChange(): void {
		if (this.disposed) return;

		if (document.visibilityState === "hidden") {
			this._hiddenAt = Date.now();
			return;
		}

		// visible
		const elapsed = this._hiddenAt ? Date.now() - this._hiddenAt : 0;
		this._hiddenAt = 0;

		// If reconnection was exhausted (ws is null, no pending timer), always
		// try again when the tab becomes visible — this is the only automatic
		// recovery path after MAX_RECONNECT_ATTEMPTS.
		if (!this.ws && !this.reconnectTimer) {
			this.resetReconnect();
			return;
		}

		// Only act if the tab was hidden long enough for messages to be lost
		if (elapsed < VISIBILITY_RECONNECT_THRESHOLD_MS) return;

		// Force a clean reconnect
		this.resetReconnect();
	}

	private syncGlobalStatus() {
		if (this.listeners.size === 0) {
			removeWSStatus("terminal");
			return;
		}
		setWSStatus("terminal", {
			label: "Terminal",
			connected: this._connected || !this._disconnected,
			reconnect: () => this.resetReconnect(),
		});
	}

	private handleMessage(msg: Record<string, unknown>) {
		const type = msg.type as string;
		const terminalId = msg.terminalId as string | undefined;

		if (!terminalId) return;
		const listeners = this.listeners.get(terminalId);
		if (!listeners) return;

		for (const listener of listeners) {
			const { callbacks } = listener;
			switch (type) {
				case "output":
					callbacks.onOutput?.(msg.data as string);
					break;
				case "scrollback":
					callbacks.onScrollback?.(msg.data as string, {
						cols: (msg.cols as number) || 80,
						rows: (msg.rows as number) || 24,
					});
					break;
				case "exit":
					callbacks.onExit?.(msg.code as number);
					break;
				case "error":
					callbacks.onError?.(terminalDiagnosticMessage(msg));
					break;
				case "requestResize":
					callbacks.onRequestResize?.();
					break;
				case "bufferState":
					callbacks.onBufferState?.({
						mouseTracking: msg.mouseTracking as boolean,
						cursorVisible: msg.cursorVisible as boolean,
					});
					break;
			}
		}
	}

	subscribe(terminalId: string, listener: Listener): () => void {
		this.ensureConnected();
		let set = this.listeners.get(terminalId);
		if (!set) {
			set = new Set();
			this.listeners.set(terminalId, set);
			// First subscriber for this terminal — send subscribe message
			if (this._connected) {
				this.send({ type: "subscribe", terminalIds: [terminalId] });
			}
		}
		set.add(listener);

		return () => {
			set?.delete(listener);
			if (set?.size === 0) {
				this.listeners.delete(terminalId);
				if (this._connected) {
					this.send({ type: "unsubscribe", terminalIds: [terminalId] });
				}
			}
			disposeManagerIfIdle(this);
		};
	}

	sendInput(terminalId: string, data: string) {
		this.send({ type: "input", terminalId, data });
	}

	sendResize(terminalId: string, cols: number, rows: number) {
		this.send({ type: "resize", terminalId, cols, rows });
	}

	onStatusChange(cb: () => void): () => void {
		this.statusListeners.add(cb);
		return () => this.statusListeners.delete(cb);
	}

	private ensureConnected() {
		if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) {
			this.ws = null;
			this.connect();
		}
	}

	private send(msg: Record<string, unknown>) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	private notifyStatus() {
		for (const cb of this.statusListeners) cb();
	}

	hasListeners() {
		return this.listeners.size > 0;
	}

	releaseConnection() {
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.pingTimeoutTimer);
		this._unlistenVisibility();
		this.reconnectAttempts = 0;
		this._connected = false;
		this._disconnected = false;
		const ws = this.ws;
		this.ws = null;
		safeCloseWs(ws);
		removeWSStatus("terminal");
	}

	dispose() {
		this.disposed = true;
		this.releaseConnection();
		this.statusListeners.clear();
	}
}

// Module-level singleton
let manager: TerminalWSManager | null = null;

function getManager(): TerminalWSManager {
	if (!manager) {
		manager = new TerminalWSManager();
		manager.connect();
	}
	return manager;
}

function disposeManagerIfIdle(target: TerminalWSManager) {
	if (target.hasListeners()) return;
	target.dispose();
	if (manager === target) {
		manager = null;
	}
}

// === React Hooks ===

/**
 * Subscribe to a terminal's output via the singleton WS connection.
 * Drop-in replacement for the old per-terminal useTerminalWS hook.
 */
export function useTerminalWS(terminalId: string | undefined, callbacks: TerminalWSCallbacks) {
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);

	useEffect(() => {
		if (!terminalId) return;
		const mgr = getManager();

		const listener: Listener = {
			callbacks: {
				onOutput: (data) => callbacksRef.current.onOutput?.(data),
				onScrollback: (data, dims) => callbacksRef.current.onScrollback?.(data, dims),
				onExit: (code) => callbacksRef.current.onExit?.(code),
				onError: (msg) => callbacksRef.current.onError?.(msg),
				onRequestResize: () => callbacksRef.current.onRequestResize?.(),
				onBufferState: (state) => callbacksRef.current.onBufferState?.(state),
			},
		};

		const unsubscribe = mgr.subscribe(terminalId, listener);
		const unsubStatus = mgr.onStatusChange(() => {
			setConnected(mgr.connected);
			setDisconnected(mgr.disconnected);
		});
		setConnected(mgr.connected);
		setDisconnected(mgr.disconnected);

		return () => {
			unsubStatus();
			unsubscribe();
		};
	}, [terminalId]);

	const write = useCallback(
		(data: string) => {
			if (terminalId) getManager().sendInput(terminalId, data);
		},
		[terminalId],
	);

	const resize = useCallback(
		(cols: number, rows: number) => {
			if (terminalId) getManager().sendResize(terminalId, cols, rows);
		},
		[terminalId],
	);

	return { connected, disconnected, write, resize };
}

/** Access the singleton manager for imperative operations (sendInput/sendResize) */
export function getTerminalWSManager(): TerminalWSManager {
	return getManager();
}
