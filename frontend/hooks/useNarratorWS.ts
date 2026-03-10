import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "../components/narrator/ToolCallCard";
import type { TreeMessage } from "../lib/api";
import { getToken } from "../lib/api";
import { buildWsUrl, safeCloseWs } from "../lib/ws";
import { removeWSStatus, setWSStatus } from "../lib/ws-status";

interface NarratorWSCallbacks {
	onMessage?: (data: { message?: TreeMessage; [key: string]: unknown }) => void;
	onUserMessage?: (data: { message?: TreeMessage; [key: string]: unknown }) => void;
	onStreamEvent?: (data: { event?: Record<string, unknown>; [key: string]: unknown }) => void;
	onPermissionRequest?: (request: PendingPermission) => void;
	onPermissionResolved?: (
		requestId: string,
		toolUseId?: string,
		updatedInput?: Record<string, unknown>,
	) => void;
	onStatusChange?: (status: string) => void;
	onToolStarted?: (
		toolUseId: string,
		toolName: string,
		streamStartedAt?: number,
		input?: Record<string, unknown>,
	) => void;
	onToolUseChunk?: (
		toolUseId: string,
		toolName: string,
		inputCharsTotal: number,
		parentToolUseId?: string,
		extractedFilePath?: string,
		contentCharsReceived?: number,
	) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		durationMs?: number,
		updatedInput?: Record<string, unknown>,
		metadata?: Record<string, unknown>,
	) => void;
	onToolLongRunning?: (toolUseId: string, elapsed: number) => void;
	onTitleUpdated?: (title: string) => void;
	onTodosUpdated?: (
		todos: { id?: string; content?: string; status?: string }[],
		toolUseId?: string,
	) => void;
	onBufferSet?: (text: string, bufferedAt: string) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "narrator_error") => void;
	onPermissionModeChanged?: (permissionMode: string) => void;
	onRelaxedPlanChanged?: (relaxedPlan: boolean) => void;
	onCompacting?: () => void;
	onCompactDone?: () => void;
	onContextUsage?: (percentage: number, promptTokens?: number, contextWindow?: number) => void;
	onPruneBoundary?: (boundaryMessageId: string | null, prunedPercent: number | null) => void;
	onGitStatus?: (data: {
		chapterId: string;
		commitsAhead: number;
		baseBranch: string;
		linesAdded: number;
		linesRemoved: number;
	}) => void;
	onCommitReminder?: (data: {
		chapterId: string;
		linesAdded: number;
		linesRemoved: number;
		filesChanged: number;
	}) => void;
	onForceCommitDone?: (data: {
		chapterId: string;
		commitSha: string;
		message: string;
		linesAdded: number;
		linesRemoved: number;
		filesChanged: number;
	}) => void;
	onMetering?: (unit: string, unitPlural: string, usage: number) => void;
	onWebSearch?: (
		id: string,
		status: "in_progress" | "searching" | "completed",
		query?: string,
		queries?: string[],
	) => void;
	onNarratorError?: (error: string) => void;
	onNarratorWarning?: (message: string) => void;
	onCatchUp?: (orphanChildren: TreeMessage[], topLevel: TreeMessage[]) => void;
	onFullReload?: () => void;
	onCommitsUpdated?: (chapterId: string, newCount: number) => void;
	onBackgroundTaskStarted?: (
		taskNarratorId: string,
		toolUseId: string,
		subagentType: string,
	) => void;
	onBackgroundTaskCompleted?: (
		taskNarratorId: string,
		toolUseId: string,
		resultPreview: string,
	) => void;
	onBackgroundTaskFailed?: (taskNarratorId: string, toolUseId: string, error: string) => void;
	onBackgroundTaskCancelled?: (taskNarratorId: string, toolUseId: string) => void;
	onMessagesDeleted?: (deletedMessageIds: string[]) => void;
	onPresenceUpdate?: (
		viewers: Array<{
			userId: string;
			username: string;
			avatarColor: string | null;
			avatarImageId: string | null;
		}>,
	) => void;
}

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const DISCONNECTED_THRESHOLD = 3;
/** If no ping is received within this window, assume the connection is dead. */
const CLIENT_PING_TIMEOUT_MS = 60_000;

export function useNarratorWS(
	narratorId: string | undefined,
	callbacks: NarratorWSCallbacks,
	lastMessageId?: string,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const lastMessageIdRef = useRef(lastMessageId);
	// Keep in sync with the prop, and allow internal updates from
	// incoming WS messages so that reconnect catch-up uses the latest cursor.
	// When the prop becomes undefined (e.g. narrator switch), clear the ref
	// so reconnect doesn't use a stale cursor from a different narrator.
	useEffect(() => {
		if (lastMessageId !== undefined) {
			lastMessageIdRef.current = lastMessageId;
		} else {
			lastMessageIdRef.current = undefined;
		}
	}, [lastMessageId]);
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const disconnectedRef = useRef(false);
	const [reconnectKey, setReconnectKey] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reconnectKey triggers manual reconnection
	useEffect(() => {
		if (!narratorId) return;

		const wsStatusId = `narrator:${narratorId}`;
		// Capture the narratorId for this effect invocation so we can guard
		// against stale messages that arrive after the user navigated away
		// (e.g. in-flight events from a pre-fork narrator).
		const subscribedId = narratorId;

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
		let pingTimeoutTimer: ReturnType<typeof setTimeout> | undefined;

		function resetPingTimeout(ws: WebSocket) {
			clearTimeout(pingTimeoutTimer);
			pingTimeoutTimer = setTimeout(() => {
				// No ping received within the timeout window — assume dead connection
				if (!cancelled && ws.readyState === WebSocket.OPEN) {
					ws.close(4000, "ping timeout");
				}
			}, CLIENT_PING_TIMEOUT_MS);
		}

		function connect() {
			if (cancelled) return;

			const token = getToken();
			const tokenQuery = token ? `token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(buildWsUrl("/ws/narrator", tokenQuery));
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
				resetPingTimeout(ws);
				const subscribeMsg: Record<string, unknown> = {
					type: "subscribe",
					narratorIds: [subscribedId],
				};
				if (lastMessageIdRef.current) {
					subscribeMsg.lastMessageId = lastMessageIdRef.current;
				}
				ws.send(JSON.stringify(subscribeMsg));
				ws.send(JSON.stringify({ type: "presence_join", narratorId: subscribedId }));
			};
			ws.onmessage = (event) => {
				if (cancelled) return;
				try {
					const data = JSON.parse(event.data);
					// Respond to server heartbeat ping and reset timeout
					if (data.type === "ping") {
						ws.send(JSON.stringify({ type: "pong" }));
						resetPingTimeout(ws);
						return;
					}
					// Guard: discard messages targeting a different narrator.
					// This prevents stale in-flight events (e.g. from a pre-fork
					// narrator) from being applied to the wrong message cache when
					// the user navigates between narrators.
					if (data.narratorId && data.narratorId !== subscribedId) return;
					switch (data.type) {
						case "message":
							callbacksRef.current.onMessage?.(data);
							if (data.message?.id) lastMessageIdRef.current = data.message.id;
							break;
						case "user_message":
							callbacksRef.current.onUserMessage?.(data);
							if (data.message?.id) lastMessageIdRef.current = data.message.id;
							break;
						case "stream_event":
							callbacksRef.current.onStreamEvent?.(data);
							break;
						case "permission_request":
							if (data.request) {
								callbacksRef.current.onPermissionRequest?.(data.request);
							}
							break;
						case "permission_resolved":
							callbacksRef.current.onPermissionResolved?.(
								data.requestId,
								data.toolUseId,
								data.updatedInput,
							);
							break;
						case "status_change":
							callbacksRef.current.onStatusChange?.(data.status);
							break;
						case "tool_started":
							callbacksRef.current.onToolStarted?.(
								data.toolUseId,
								data.toolName,
								data.streamStartedAt,
								data.input,
							);
							break;
						case "tool_use_chunk":
							callbacksRef.current.onToolUseChunk?.(
								data.toolUseId,
								data.toolName,
								data.inputCharsTotal,
								data.parentToolUseId,
								data.extractedFilePath,
								data.contentCharsReceived,
							);
							break;
						case "tool_completed":
							callbacksRef.current.onToolCompleted?.(
								data.toolUseId,
								data.status,
								data.output,
								data.durationMs,
								data.updatedInput,
								data.metadata,
							);
							break;
						case "tool_long_running":
							callbacksRef.current.onToolLongRunning?.(data.toolUseId, data.elapsed);
							break;
						case "todos_updated":
							callbacksRef.current.onTodosUpdated?.(data.todos, data.toolUseId);
							break;
						case "title_updated":
							callbacksRef.current.onTitleUpdated?.(data.title);
							break;
						case "buffer_set":
							callbacksRef.current.onBufferSet?.(data.text, data.bufferedAt);
							break;
						case "buffer_cleared":
							callbacksRef.current.onBufferCleared?.(data.reason);
							break;
						case "permission_mode_changed":
							callbacksRef.current.onPermissionModeChanged?.(data.permissionMode);
							break;
						case "relaxed_plan_changed":
							callbacksRef.current.onRelaxedPlanChanged?.(data.relaxedPlan);
							break;
						case "compacting":
							callbacksRef.current.onCompacting?.();
							break;
						case "compact_done":
						case "compact_failed":
							callbacksRef.current.onCompactDone?.();
							break;
						case "context_usage":
							if (!data.isSubagent) {
								callbacksRef.current.onContextUsage?.(
									data.percentage,
									data.promptTokens,
									data.contextWindow,
								);
							}
							break;
						case "prune_boundary":
							callbacksRef.current.onPruneBoundary?.(
								data.boundaryMessageId ?? null,
								data.prunedPercent ?? null,
							);
							break;
						case "git_status":
							if (data.chapterId) {
								callbacksRef.current.onGitStatus?.({
									chapterId: data.chapterId,
									commitsAhead: data.commitsAhead ?? 0,
									baseBranch: data.baseBranch ?? "",
									linesAdded: data.linesAdded ?? 0,
									linesRemoved: data.linesRemoved ?? 0,
								});
							}
							break;
						case "commit_reminder":
							if (data.chapterId) {
								callbacksRef.current.onCommitReminder?.({
									chapterId: data.chapterId,
									linesAdded: data.linesAdded ?? 0,
									linesRemoved: data.linesRemoved ?? 0,
									filesChanged: data.filesChanged ?? 0,
								});
							}
							break;
						case "force_commit_done":
							if (data.chapterId) {
								callbacksRef.current.onForceCommitDone?.({
									chapterId: data.chapterId,
									commitSha: data.commitSha ?? "",
									message: data.message ?? "",
									linesAdded: data.linesAdded ?? 0,
									linesRemoved: data.linesRemoved ?? 0,
									filesChanged: data.filesChanged ?? 0,
								});
							}
							break;
						case "metering":
							if (!data.isSubagent) {
								callbacksRef.current.onMetering?.(data.unit, data.unitPlural, data.usage);
							}
							break;
							break;
						case "web_search":
							callbacksRef.current.onWebSearch?.(data.id, data.status, data.query, data.queries);
							break;
						case "narrator_error":
							callbacksRef.current.onNarratorError?.(data.error);
							break;
						case "warning":
							callbacksRef.current.onNarratorWarning?.(data.message);
							break;
						case "catch_up": {
							const topLevel: TreeMessage[] = data.topLevel ?? [];
							const orphanChildren: TreeMessage[] = data.orphanChildren ?? [];
							callbacksRef.current.onCatchUp?.(orphanChildren, topLevel);
							// Update cursor to the latest caught-up message
							if (topLevel.length > 0) {
								lastMessageIdRef.current = topLevel[topLevel.length - 1].id;
							}
							break;
						}
						case "full_reload":
							callbacksRef.current.onFullReload?.();
							break;
						case "messages_deleted":
							if (data.deletedMessageIds) {
								callbacksRef.current.onMessagesDeleted?.(data.deletedMessageIds);
							}
							break;
						case "commits_updated":
							if (data.chapterId) {
								callbacksRef.current.onCommitsUpdated?.(data.chapterId, data.newCount ?? 0);
							}
							break;
						case "background_task_started":
							callbacksRef.current.onBackgroundTaskStarted?.(
								data.taskNarratorId,
								data.toolUseId,
								data.subagentType,
							);
							break;
						case "background_task_completed":
							callbacksRef.current.onBackgroundTaskCompleted?.(
								data.taskNarratorId,
								data.toolUseId,
								data.resultPreview,
							);
							break;
						case "background_task_failed":
							callbacksRef.current.onBackgroundTaskFailed?.(
								data.taskNarratorId,
								data.toolUseId,
								data.error,
							);
							break;
						case "background_task_cancelled":
							callbacksRef.current.onBackgroundTaskCancelled?.(data.taskNarratorId, data.toolUseId);
							break;
						case "presence_update":
							callbacksRef.current.onPresenceUpdate?.(data.viewers ?? []);
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
			clearTimeout(pingTimeoutTimer);
			removeWSStatus(wsStatusId);
			const ws = wsRef.current;
			safeCloseWs(ws, (w) => {
				w.send(JSON.stringify({ type: "presence_leave", narratorId: subscribedId }));
				w.send(JSON.stringify({ type: "unsubscribe", narratorIds: [subscribedId] }));
			});
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
			updatedPlan?: string,
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
					updatedPlan,
				}),
			);
			return true;
		},
		[],
	);

	const sendBufferMessage = useCallback((targetNarratorId: string, text: string): boolean => {
		if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
		wsRef.current.send(
			JSON.stringify({ type: "buffer_message", narratorId: targetNarratorId, text }),
		);
		return true;
	}, []);

	const cancelBuffer = useCallback((targetNarratorId: string): boolean => {
		if (wsRef.current?.readyState !== WebSocket.OPEN) return false;
		wsRef.current.send(JSON.stringify({ type: "cancel_buffer", narratorId: targetNarratorId }));
		return true;
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
export interface NarratorListWSEvent {
	type: "status" | "title" | "permissionMode" | "presence" | "terminalCount" | "containerStatus";
	status?: string;
	title?: string;
	permissionMode?: string;
	viewers?: Array<{
		userId: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	}>;
	activeTerminalCount?: number;
	containerStatus?: "created" | "running" | "paused" | "stopped" | null;
}

export function useNarratorsListWS(
	narratorIds: string[],
	onUpdate: (narratorId: string, event: NarratorListWSEvent) => void,
	onGlobalEvent?: (event: { type: string; [key: string]: unknown }) => void,
) {
	const wsRef = useRef<WebSocket | null>(null);
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const onGlobalEventRef = useRef(onGlobalEvent);
	onGlobalEventRef.current = onGlobalEvent;
	const [connected, setConnected] = useState(false);
	const [disconnected, setDisconnected] = useState(false);
	const disconnectedRef = useRef(false);
	const [reconnectKey, setReconnectKey] = useState(0);

	// Stable serialized key for dependency comparison
	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds; reconnectKey triggers manual reconnection
	useEffect(() => {
		// Connect if we have narrator IDs to subscribe to, or a global event handler
		if (!narratorIds.length && !onGlobalEventRef.current) return;

		const wsStatusId = "narrator-list";

		function syncGlobalStatus(isConnected: boolean) {
			setWSStatus(wsStatusId, {
				label: "Narrator List",
				connected: isConnected,
				reconnect: () => setReconnectKey((k) => k + 1),
			});
		}

		let cancelled = false;
		let attempts = 0;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let pingTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
		const currentIds = narratorIds;

		function resetPingTimeout(ws: WebSocket) {
			clearTimeout(pingTimeoutTimer);
			pingTimeoutTimer = setTimeout(() => {
				if (!cancelled && ws.readyState === WebSocket.OPEN) {
					ws.close(4000, "ping timeout");
				}
			}, CLIENT_PING_TIMEOUT_MS);
		}

		function connect() {
			if (cancelled) return;

			const token = getToken();
			const tokenQuery = token ? `token=${encodeURIComponent(token)}` : "";
			const ws = new WebSocket(buildWsUrl("/ws/narrator", tokenQuery));
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
				resetPingTimeout(ws);
				if (currentIds.length) {
					ws.send(JSON.stringify({ type: "subscribe", narratorIds: currentIds }));
				}
			};
			ws.onmessage = (event) => {
				if (cancelled) return;
				try {
					const data = JSON.parse(event.data);
					// Respond to server heartbeat ping and reset timeout
					if (data.type === "ping") {
						ws.send(JSON.stringify({ type: "pong" }));
						resetPingTimeout(ws);
						return;
					}
					const nId = data.narratorId;
					if (data.type === "status_change") {
						onUpdateRef.current(nId, { type: "status", status: data.status });
					} else if (data.type === "title_updated") {
						onUpdateRef.current(nId, { type: "title", title: data.title });
					} else if (data.type === "permission_mode_changed") {
						onUpdateRef.current(nId, {
							type: "permissionMode",
							permissionMode: data.permissionMode,
						});
					} else if (data.type === "presence_update") {
						onUpdateRef.current(nId, { type: "presence", viewers: data.viewers });
					} else if (data.type.startsWith("user:")) {
						onGlobalEventRef.current?.(data);
					}
				} catch (err) {
					if (import.meta.env.DEV)
						console.warn("[useNarratorsListWS] Failed to parse WS message:", err);
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
			clearTimeout(pingTimeoutTimer);
			removeWSStatus(wsStatusId);
			const ws = wsRef.current;
			safeCloseWs(ws, (w) => {
				if (currentIds.length) {
					w.send(JSON.stringify({ type: "unsubscribe", narratorIds: currentIds }));
				}
			});
		};
	}, [idsKey, reconnectKey]);

	const reconnect = useCallback(() => {
		setReconnectKey((k) => k + 1);
	}, []);

	return { connected, disconnected, reconnect };
}
