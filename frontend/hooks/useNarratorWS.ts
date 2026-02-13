import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface NarratorWSCallbacks {
	onMessage?: (data: any) => void;
	onPermissionRequest?: (request: any) => void;
	onStatusChange?: (status: string) => void;
	onToolProgress?: (toolUseId: string, elapsed: number) => void;
}

export function useNarratorWS(narratorId: string | undefined, callbacks: NarratorWSCallbacks) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);

	useEffect(() => {
		if (!narratorId) return;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const host = window.location.hostname;
		// In dev, WS goes to backend port via Vite proxy or direct
		const port = import.meta.env.DEV ? "7778" : window.location.port;
		const token = getToken();
		const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
		const ws = new WebSocket(`${protocol}//${host}:${port}/ws/narrator${tokenParam}`);
		wsRef.current = ws;

		ws.onopen = () => {
			setConnected(true);
			ws.send(JSON.stringify({ type: "subscribe", narratorIds: [narratorId] }));
		};

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				switch (data.type) {
					case "message":
					case "narrator:message":
						callbacksRef.current.onMessage?.(data);
						break;
					case "permission_request":
					case "narrator:permission_request":
						callbacksRef.current.onPermissionRequest?.(data.request ?? data);
						break;
					case "status_change":
						callbacksRef.current.onStatusChange?.(data.status);
						break;
					case "tool_progress":
						callbacksRef.current.onToolProgress?.(data.toolUseId, data.elapsed);
						break;
				}
			} catch {
				// ignore parse errors
			}
		};

		ws.onclose = () => setConnected(false);
		ws.onerror = () => setConnected(false);

		return () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: [narratorId] }));
			}
			ws.close();
		};
	}, [narratorId]);

	const sendPermissionDecision = useCallback(
		(requestId: string, decision: "allow" | "deny", message?: string) => {
			wsRef.current?.send(
				JSON.stringify({ type: "permission_decision", requestId, decision, message }),
			);
		},
		[],
	);

	return { connected, sendPermissionDecision };
}
