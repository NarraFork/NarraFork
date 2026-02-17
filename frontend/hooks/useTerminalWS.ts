import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface TerminalWSCallbacks {
	onOutput?: (data: string) => void;
	onExit?: (code: number) => void;
	onError?: (message: string) => void;
	onRequestResize?: () => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

export function useTerminalWS(terminalId: string | undefined, callbacks: TerminalWSCallbacks) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const reconnectAttempts = useRef(0);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	const unmountedRef = useRef(false);

	useEffect(() => {
		if (!terminalId) return;
		unmountedRef.current = false;

		function connect() {
			if (unmountedRef.current) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const token = getToken();
			const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
			// Use current host:port — Vite proxy handles /ws in dev
			const ws = new WebSocket(
				`${protocol}//${window.location.host}/ws/terminal?terminalId=${terminalId}${tokenParam}`,
			);
			wsRef.current = ws;

			ws.onopen = () => {
				setConnected(true);
				setDisconnected(false);
				reconnectAttempts.current = 0;
			};

			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					switch (data.type) {
						case "output":
							callbacksRef.current.onOutput?.(data.data);
							break;
						case "exit":
							callbacksRef.current.onExit?.(data.code);
							break;
						case "error":
							callbacksRef.current.onError?.(data.message);
							break;
						case "requestResize":
							callbacksRef.current.onRequestResize?.();
							break;
					}
				} catch (err) {
					if (import.meta.env.DEV) console.warn("[useTerminalWS] Failed to parse WS message:", err);
				}
			};

			ws.onclose = () => {
				setConnected(false);
				scheduleReconnect();
			};
			ws.onerror = () => {
				setConnected(false);
			};
		}

		function scheduleReconnect() {
			if (unmountedRef.current) return;
			if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
				setDisconnected(true);
				return;
			}
			const delay = RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts.current;
			reconnectAttempts.current++;
			reconnectTimer.current = setTimeout(connect, delay);
		}

		connect();

		return () => {
			unmountedRef.current = true;
			clearTimeout(reconnectTimer.current);
			const ws = wsRef.current;
			if (ws) {
				ws.close();
			}
		};
	}, [terminalId]);

	const write = useCallback((data: string) => {
		wsRef.current?.send(data);
	}, []);

	const resize = useCallback((cols: number, rows: number) => {
		wsRef.current?.send(JSON.stringify({ type: "resize", cols, rows }));
	}, []);

	return { connected, disconnected, write, resize };
}
