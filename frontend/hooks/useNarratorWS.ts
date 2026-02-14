import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface NarratorWSCallbacks {
	onMessage?: (data: any) => void;
	onPermissionRequest?: (request: any) => void;
	onStatusChange?: (status: string) => void;
	onToolProgress?: (toolUseId: string, elapsed: number) => void;
	onTitleUpdated?: (title: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

export function useNarratorWS(narratorId: string | undefined, callbacks: NarratorWSCallbacks) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const reconnectAttempts = useRef(0);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout>>();
	const unmountedRef = useRef(false);

	useEffect(() => {
		if (!narratorId) return;
		unmountedRef.current = false;

		function connect() {
			if (unmountedRef.current) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const token = getToken();
			const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(`${protocol}//${window.location.host}/ws/narrator${tokenParam}`);
			wsRef.current = ws;

			ws.onopen = () => {
				setConnected(true);
				setDisconnected(false);
				reconnectAttempts.current = 0;
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
							if (data.request) {
								callbacksRef.current.onPermissionRequest?.(data.request);
							}
							break;
						case "status_change":
						case "narrator:status_changed":
							callbacksRef.current.onStatusChange?.(data.status);
							break;
						case "tool_progress":
							callbacksRef.current.onToolProgress?.(data.toolUseId, data.elapsed);
							break;
						case "title_updated":
						case "narrator:title_updated":
							callbacksRef.current.onTitleUpdated?.(data.title);
							break;
					}
				} catch {
					// ignore parse errors
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
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: [narratorId] }));
				}
				ws.close();
			}
		};
	}, [narratorId]);

	const sendPermissionDecision = useCallback(
		(
			requestId: string,
			decision: "allow" | "deny",
			message?: string,
			answers?: Record<string, string>,
		) => {
			wsRef.current?.send(
				JSON.stringify({
					type: "permission_decision",
					requestId,
					decision,
					message,
					answers,
				}),
			);
		},
		[],
	);

	return { connected, disconnected, sendPermissionDecision };
}
