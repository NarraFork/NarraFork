/**
 * Terminal WebSocket hook — singleton connection, subscribe/unsubscribe model.
 *
 * A single WS connection to /ws/terminal manages all terminal subscriptions.
 * Components call useTerminalConnection(terminalId, callbacks) to subscribe
 * to a specific terminal's output.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";
import { removeWSStatus, setWSStatus } from "../lib/ws-status";

// === Types ===

interface TerminalWSCallbacks {
	onOutput?: (data: string) => void;
	onScrollback?: (data: string) => void;
	onExit?: (code: number) => void;
	onError?: (message: string) => void;
	onRequestResize?: () => void;
	onBufferState?: (state: { mouseTracking: boolean; cursorVisible: boolean }) => void;
}

type Listener = {
	callbacks: TerminalWSCallbacks;
};

// === Singleton WS Manager ===

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/** After this many fast retries, we consider the connection "disconnected" (show UI). */
const DISCONNECTED_THRESHOLD = 3;

class TerminalWSManager {
	private ws: WebSocket | null = null;
	private listeners = new Map<string, Set<Listener>>();
	private reconnectAttempts = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private _connected = false;
	private _disconnected = false;
	private statusListeners = new Set<() => void>();

	get connected() {
		return this._connected;
	}
	get disconnected() {
		return this._disconnected;
	}

	connect() {
		if (this.ws?.readyState === WebSocket.OPEN || this.disposed) return;
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const token = getToken();
		const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws/terminal${tokenParam}`);
		this.ws = ws;

		ws.onopen = () => {
			this._connected = true;
			this._disconnected = false;
			this.reconnectAttempts = 0;
			this.notifyStatus();
			this.syncGlobalStatus();
			// Re-subscribe all active terminals
			const ids = [...this.listeners.keys()];
			if (ids.length > 0) {
				this.send({ type: "subscribe", terminalIds: ids });
			}
		};

		ws.onmessage = (event) => {
			try {
				const msg = JSON.parse(event.data);
				this.handleMessage(msg);
			} catch {
				// ignore parse errors
			}
		};

		ws.onclose = () => {
			this._connected = false;
			this.notifyStatus();
			this.syncGlobalStatus();
			this.scheduleReconnect();
		};

		ws.onerror = () => {
			this._connected = false;
			this.notifyStatus();
		};
	}

	private scheduleReconnect() {
		if (this.disposed) return;
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
		this.reconnectAttempts = 0;
		this._disconnected = false;
		this.notifyStatus();
		this.ws?.close();
		this.ws = null;
		this.connect();
	}

	private syncGlobalStatus() {
		if (this.listeners.size === 0) return;
		setWSStatus("terminal", {
			label: "Terminal",
			connected: this._connected,
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
					callbacks.onScrollback?.(msg.data as string);
					break;
				case "exit":
					callbacks.onExit?.(msg.code as number);
					break;
				case "error":
					callbacks.onError?.(msg.message as string);
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
		if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
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

	dispose() {
		this.disposed = true;
		clearTimeout(this.reconnectTimer);
		this.ws?.close();
		this.ws = null;
		removeWSStatus("terminal");
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
				onScrollback: (data) => callbacksRef.current.onScrollback?.(data),
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
			unsubscribe();
			unsubStatus();
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
