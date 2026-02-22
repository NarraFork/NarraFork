import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "../lib/api";
import { removeWSStatus, setWSStatus } from "../lib/ws-status";

interface NarratorWSCallbacks {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	onMessage?: (data: any) => void;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	onUserMessage?: (data: any) => void;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	onStreamEvent?: (data: any) => void;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	onPermissionRequest?: (request: any) => void;
	onPermissionResolved?: (requestId: string, toolUseId?: string) => void;
	onStatusChange?: (status: string) => void;
	onToolProgress?: (toolUseId: string, elapsed: number) => void;
	onToolStarted?: (toolUseId: string, toolName: string) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		durationMs?: number,
	) => void;
	onTitleUpdated?: (title: string) => void;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
	onTodosUpdated?: (todos: any[], toolUseId?: string) => void;
	onBufferSet?: (text: string, bufferedAt: string) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "session_error") => void;
	onPlanModeChanged?: (planMode: boolean) => void;
	onCompacting?: () => void;
	onCompactDone?: () => void;
	onContextUsage?: (percentage: number) => void;
	onMetering?: (unit: string, unitPlural: string, usage: number) => void;
	onNarratorError?: (error: string) => void;
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const DISCONNECTED_THRESHOLD = 3;

export function useNarratorWS(
	narratorId: string | undefined,
	callbacks: NarratorWSCallbacks,
	lastMessageId?: string,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const lastMessageIdRef = useRef(lastMessageId);
	lastMessageIdRef.current = lastMessageId;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const disconnectedRef = useRef(false);
	const [reconnectKey, setReconnectKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey triggers manual reconnection
	useEffect(() => {
		if (!narratorId) return;

		const wsStatusId = `narrator:${narratorId}`;

		function syncGlobalStatus(isConnected: boolean) {
			setWSStatus(wsStatusId, {
				label: `Narrator`,
				connected: isConnected,
				reconnect: () => setReconnectKey((k) => k + 1),
			});
		}

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
				disconnectedRef.current = false;
				attempts = 0;
				syncGlobalStatus(true);
				const subscribeMsg: Record<string, unknown> = {
					type: "subscribe",
					narratorIds: [narratorId],
				};
				if (lastMessageIdRef.current) {
					subscribeMsg.lastMessageId = lastMessageIdRef.current;
				}
				ws.send(JSON.stringify(subscribeMsg));
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
							callbacksRef.current.onPermissionResolved?.(data.requestId, data.toolUseId);
							break;
						case "status_change":
						case "narrator:status_changed":
							callbacksRef.current.onStatusChange?.(data.status);
							break;
						case "tool_progress":
							callbacksRef.current.onToolProgress?.(data.toolUseId, data.elapsed);
							break;
						case "tool_started":
							callbacksRef.current.onToolStarted?.(data.toolUseId, data.toolName);
							break;
						case "tool_completed":
							callbacksRef.current.onToolCompleted?.(
								data.toolUseId,
								data.status,
								data.output,
								data.durationMs,
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
						case "plan_mode_changed":
							callbacksRef.current.onPlanModeChanged?.(data.planMode);
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
						case "metering":
							callbacksRef.current.onMetering?.(data.unit, data.unitPlural, data.usage);
							break;
						case "narrator:error":
							callbacksRef.current.onNarratorError?.(data.error);
							break;
					}
				} catch (err) {
					if (import.meta.env.DEV) console.warn("[useNarratorWS] Failed to parse WS message:", err);
				}
			};

			ws.onclose = () => {
				if (cancelled) return;
				setConnected(false);
				syncGlobalStatus(false);
				scheduleReconnect();
			};
			ws.onerror = () => {
				if (cancelled) return;
				setConnected(false);
			};
		}

		function scheduleReconnect() {
			if (cancelled) return;
			if (attempts >= DISCONNECTED_THRESHOLD && !disconnectedRef.current) {
				disconnectedRef.current = true;
				setDisconnected(true);
				syncGlobalStatus(false);
			}
			const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
			attempts++;
			reconnectTimer = setTimeout(connect, delay);
		}

		connect();

		return () => {
			cancelled = true;
			disconnectedRef.current = false;
			clearTimeout(reconnectTimer);
			removeWSStatus(wsStatusId);
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
			compactAfter?: boolean,
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
					compactAfter,
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
	planMode?: boolean;
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
					} else if (data.type === "plan_mode_changed") {
						onUpdateRef.current(nId, { type: "planMode", planMode: data.planMode });
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
			const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempts, RECONNECT_MAX_DELAY_MS);
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
