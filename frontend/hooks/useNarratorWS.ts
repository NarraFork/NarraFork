import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "../lib/api";

interface NarratorWSCallbacks {
	onMessage?: (data: any) => void;
	onUserMessage?: (data: any) => void;
	onStreamEvent?: (data: any) => void;
	onPermissionRequest?: (request: any) => void;
	onPermissionResolved?: (requestId: string) => void;
	onStatusChange?: (status: string) => void;
	onToolProgress?: (toolUseId: string, elapsed: number) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		permissionRequest?: { id: string; toolName: string; inputJson: unknown },
	) => void;
	onTitleUpdated?: (title: string) => void;
	onTodosUpdated?: (todos: any[], toolUseId?: string) => void;
	onBufferSet?: (text: string, bufferedAt: string) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "session_error") => void;
	onSdkPlanModeChanged?: (sdkPlanMode: boolean) => void;
	onCompacting?: () => void;
	onCompactDone?: () => void;
	onContextUsage?: (percentage: number) => void;
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

	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey triggers manual reconnection
	useEffect(() => {
		if (!narratorId) return;

		// Per-invocation flag: set to true when this effect is cleaned up.
		// Each effect run gets its own `cancelled` captured by its closures,
		// preventing stale onclose handlers from spawning duplicate connections.
		let cancelled = false;
		let attempts = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

		function connect() {
			if (cancelled) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const token = getToken();
			const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(`${protocol}//${window.location.host}/ws/narrator${tokenParam}`);
			wsRef.current = ws;

			ws.onopen = () => {
				if (cancelled) {
					ws.close();
					return;
				}
				setConnected(true);
				setDisconnected(false);
				attempts = 0;
				ws.send(JSON.stringify({ type: "subscribe", narratorIds: [narratorId] }));
			};
			ws.onmessage = (event) => {
				if (cancelled) return;
				try {
					const data = JSON.parse(event.data);
					switch (data.type) {
						case "message":
							callbacksRef.current.onMessage?.(data);
							break;
						case "user_message":
							callbacksRef.current.onUserMessage?.(data);
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
							callbacksRef.current.onToolCompleted?.(
								data.toolUseId,
								data.status,
								data.output,
								data.permissionRequest,
							);
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
						case "compacting":
							callbacksRef.current.onCompacting?.();
							break;
						case "compact_done":
							callbacksRef.current.onCompactDone?.();
							break;
						case "context_usage":
							callbacksRef.current.onContextUsage?.(data.percentage);
							break;
					}
				} catch (err) {
					if (import.meta.env.DEV) console.warn("[useNarratorWS] Failed to parse WS message:", err);
				}
			};

			ws.onclose = () => {
				if (cancelled) return;
				setConnected(false);
				scheduleReconnect();
			};
			ws.onerror = () => {
				if (cancelled) return;
				setConnected(false);
			};
		}

		function scheduleReconnect() {
			if (cancelled) return;
			if (attempts >= MAX_RECONNECT_ATTEMPTS) {
				setDisconnected(true);
				return;
			}
			const delay = RECONNECT_BASE_DELAY_MS * 2 ** attempts;
			attempts++;
			reconnectTimer = setTimeout(connect, delay);
		}

		connect();

		return () => {
			cancelled = true;
			clearTimeout(reconnectTimer);
			const ws = wsRef.current;
			if (ws) {
				// Suppress handlers before closing to avoid any late-firing events
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: [narratorId] }));
				}
				ws.close();
			}
		};
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
		setReconnectKey((k) => k + 1);
	}, []);

	return {
		connected,
		disconnected,
		sendPermissionDecision,
		sendBufferMessage,
		cancelBuffer,
		reconnect,
	};
}

/**
 * Subscribe to status/title changes for a list of narrator IDs (used on session list pages).
 * Calls `onUpdate` with the specific narrator ID and event data for targeted cache updates.
 */
export interface SessionListWSEvent {
	type: "status" | "title" | "planMode";
	status?: string;
	title?: string;
	sdkPlanMode?: boolean;
}

export function useSessionsListWS(
	narratorIds: string[],
	onUpdate: (narratorId: string, event: SessionListWSEvent) => void,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;

	// Stable serialized key for dependency comparison
	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds; using the array directly would reconnect on every render
	useEffect(() => {
		if (!narratorIds.length) return;

		let cancelled = false;
		let attempts = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		const currentIds = narratorIds;

		function connect() {
			if (cancelled) return;

			const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const token = getToken();
			const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(`${protocol}//${window.location.host}/ws/narrator${tokenParam}`);
			wsRef.current = ws;

			ws.onopen = () => {
				if (cancelled) {
					ws.close();
					return;
				}
				attempts = 0;
				ws.send(JSON.stringify({ type: "subscribe", narratorIds: currentIds }));
			};
			ws.onmessage = (event) => {
				if (cancelled) return;
				try {
					const data = JSON.parse(event.data);
					const nId = data.narratorId;
					if (data.type === "status_change" || data.type === "narrator:status_changed") {
						onUpdateRef.current(nId, { type: "status", status: data.status });
					} else if (data.type === "title_updated" || data.type === "narrator:title_updated") {
						onUpdateRef.current(nId, { type: "title", title: data.title });
					} else if (data.type === "sdk_plan_mode_changed") {
						onUpdateRef.current(nId, { type: "planMode", sdkPlanMode: data.sdkPlanMode });
					}
				} catch (err) {
					if (import.meta.env.DEV)
						console.warn("[useSessionsListWS] Failed to parse WS message:", err);
				}
			};
			ws.onclose = () => {
				if (cancelled) return;
				scheduleReconnect();
			};
			ws.onerror = () => {};
		}

		function scheduleReconnect() {
			if (cancelled) return;
			if (attempts >= MAX_RECONNECT_ATTEMPTS) return;
			const delay = RECONNECT_BASE_DELAY_MS * 2 ** attempts;
			attempts++;
			reconnectTimer = setTimeout(connect, delay);
		}

		connect();

		return () => {
			cancelled = true;
			clearTimeout(reconnectTimer);
			const ws = wsRef.current;
			if (ws) {
				ws.onopen = null;
				ws.onmessage = null;
				ws.onclose = null;
				ws.onerror = null;
				if (ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "unsubscribe", narratorIds: currentIds }));
				}
				ws.close();
			}
		};
	}, [idsKey]);
}
