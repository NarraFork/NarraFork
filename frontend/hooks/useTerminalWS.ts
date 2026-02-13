import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface TerminalWSCallbacks {
	onOutput?: (data: string) => void;
	onExit?: (code: number) => void;
	onError?: (message: string) => void;
}

export function useTerminalWS(terminalId: string | undefined, callbacks: TerminalWSCallbacks) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		if (!terminalId) return;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.hostname;
		const port = import.meta.env.DEV ? "7778" : window.location.port;
		const token = getToken();
		const tokenParam = token ? `&token=${encodeURIComponent(token)}` : "";
		const ws = new WebSocket(
			`${protocol}//${host}:${port}/ws/terminal?terminalId=${terminalId}${tokenParam}`,
		);
		wsRef.current = ws;

		ws.onopen = () => setConnected(true);

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
				}
			} catch {
				// ignore non-JSON
			}
		};

		ws.onclose = () => setConnected(false);
		ws.onerror = () => setConnected(false);

		return () => {
			ws.close();
		};
	}, [terminalId]);

	const write = useCallback((data: string) => {
		wsRef.current?.send(data);
	}, []);

	const resize = useCallback((cols: number, rows: number) => {
		wsRef.current?.send(JSON.stringify({ type: "resize", cols, rows }));
	}, []);

	return { connected, write, resize };
}
