import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface NarratorWSCallbacks {
	onMessage?: (data: any) => void;
	onStreamEvent?: (data: any) => void;
	onPermissionRequest?: (request: any) => void;
	onPermissionResolved?: (requestId: string) => void;
	onStatusChange?: (status: string) => void;
	onToolProgress?: (toolUseId: string, elapsed: number) => void;
	onToolCompleted?: (toolUseId: string, status: string, output?: unknown) => void;
	onTitleUpdated?: (title: string) => void;
	onTodosUpdated?: (todos: any[], toolUseId?: string) => void;
	onBufferSet?: (text: string, bufferedAt: string) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "session_error") => void;
	onSdkPlanModeChanged?: (sdkPlanMode: boolean) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

export function useNarratorWS(narratorId: string | undefined, callbacks: NarratorWSCallbacks) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const [reconnectKey, setReconnectKey] = useState(0);
	const reconnectAttempts = useRef(0);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
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
							callbacksRef.current.onMessage?.(data);
							break;
						case "stream_event":
							callbacksRef.current.onStreamEvent?.(data);
							break;
						case "permission_request":
						case "narrator:permission_request":
							if (data.request) {
								callbacksRef.current.onPermissionRequest?.(data.request);
							}
							break;
						case "permission_resolved":
							callbacksRef.current.onPermissionResolved?.(data.requestId);
							break;
						case "status_change":
						case "narrator:status_changed":
							callbacksRef.current.onStatusChange?.(data.status);
							break;
						case "tool_progress":
							callbacksRef.current.onToolProgress?.(data.toolUseId, data.elapsed);
							break;
						case "tool_completed":
							callbacksRef.current.onToolCompleted?.(data.toolUseId, data.status, data.output);
							break;
						case "todos_updated":
							callbacksRef.current.onTodosUpdated?.(data.todos, data.toolUseId);
							break;
						case "title_updated":
						case "narrator:title_updated":
							callbacksRef.current.onTitleUpdated?.(data.title);
							break;
						case "buffer_set":
							callbacksRef.current.onBufferSet?.(data.text, data.bufferedAt);
							break;
						case "buffer_cleared":
							callbacksRef.current.onBufferCleared?.(data.reason);
							break;
						case "sdk_plan_mode_changed":
							callbacksRef.current.onSdkPlanModeChanged?.(data.sdkPlanMode);
							break;
					}
				} catch (err) {
					if (import.meta.env.DEV) console.warn("[useNarratorWS] Failed to parse WS message:", err);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey is used to trigger manual reconnection
	}, [narratorId, reconnectKey]);

	const sendPermissionDecision = useCallback(
		(
			requestId: string,
			decision: "allow" | "deny",
			message?: string,
			answers?: Record<string, string>,
			feedbackText?: string,
		): boolean => {
			if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
			wsRef.current.send(
				JSON.stringify({
					type: "permission_decision",
					requestId,
					decision,
					message,
					answers,
					feedbackText,
				}),
			);
			return true;
		},
		[],
	);

	const sendBufferMessage = useCallback((targetNarratorId: string, text: string) => {
		wsRef.current?.send(
			JSON.stringify({ type: "buffer_message", narratorId: targetNarratorId, text }),
		);
	}, []);

	const cancelBuffer = useCallback((targetNarratorId: string) => {
		wsRef.current?.send(JSON.stringify({ type: "cancel_buffer", narratorId: targetNarratorId }));
	}, []);

	const reconnect = useCallback(() => {
		reconnectAttempts.current = 0;
		setReconnectKey((k) => k + 1);
	}, []);

	return { connected, disconnected, sendPermissionDecision, sendBufferMessage, cancelBuffer, reconnect };
}

/**
 * Subscribe to status/title changes for a list of narrator IDs (used on session list pages).
 * Calls `onUpdate` whenever any subscribed narrator changes status or title.
 */
export function useSessionsListWS(narratorIds: string[], onUpdate: () => void) {
	const wsRef = useRef<WebSocket | null>(null);
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const idsRef = useRef<string[]>(narratorIds);
	const unmountedRef = useRef(false);
	const reconnectAttempts = useRef(0);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

	// Stable serialized key for dependency comparison
	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds; using the array directly would reconnect on every render
	useEffect(() => {
		if (!narratorIds.length) return;
		unmountedRef.current = false;
		reconnectAttempts.current = 0;
		idsRef.current = narratorIds;

		function connect() {
			if (unmountedRef.current) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const token = getToken();
			const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(`${protocol}//${window.location.host}/ws/narrator${tokenParam}`);
			wsRef.current = ws;

			ws.onopen = () => {
				reconnectAttempts.current = 0;
				ws.send(JSON.stringify({ type: "subscribe", narratorIds: idsRef.current }));
			};
			ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					if (
						data.type === "status_change" ||
						data.type === "narrator:status_changed" ||
						data.type === "title_updated" ||
						data.type === "narrator:title_updated" ||
						data.type === "sdk_plan_mode_changed"
					) {
						onUpdateRef.current();
					}
				} catch (err) {
					if (import.meta.env.DEV) console.warn("[useSessionsListWS] Failed to parse WS message:", err);
				}
			};
			ws.onclose = () => {
				scheduleReconnect();
			};
			ws.onerror = () => {};
		}

		function scheduleReconnect() {
			if (unmountedRef.current) return;
			if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) return;
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
					ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: idsRef.current }));
				}
				ws.close();
			}
		};
	}, [idsKey]);
}
