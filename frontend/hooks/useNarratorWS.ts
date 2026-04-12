import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PendingPermission } from "../components/narrator/ToolCallCard";
import type { BufferMessageSummary, TreeMessage } from "../lib/api";
import {
	type ListenerHandle,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";

interface NarratorWSCallbacks {
	onMessage?: (data: { message?: TreeMessage; [key: string]: unknown }) => void;
	onUserMessage?: (data: { message?: TreeMessage; [key: string]: unknown }) => void;
	onStreamEvent?: (data: { event?: Record<string, unknown>; [key: string]: unknown }) => void;
	onPermissionRequest?: (request: PendingPermission) => void;
	onPermissionResolved?: (
		requestId: string,
		toolUseId?: string,
		updatedInput?: Record<string, unknown>,
		decision?: "allow" | "deny",
		feedbackText?: string,
	) => void;
	onStatusChange?: (status: string, turnStartedAt?: string) => void;
	onToolStarted?: (
		toolUseId: string,
		toolName: string,
		streamStartedAt?: number,
		input?: Record<string, unknown>,
		parentToolUseId?: string,
	) => void;
	onToolUseChunk?: (
		toolUseId: string,
		toolName: string,
		inputCharsTotal: number,
		parentToolUseId?: string,
		extractedFilePath?: string,
		contentCharsReceived?: number,
		extractedFields?: Record<string, string>,
	) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		durationMs?: number,
		updatedInput?: Record<string, unknown>,
		metadata?: Record<string, unknown>,
		parentToolUseId?: string,
	) => void;
	onToolLongRunning?: (toolUseId: string, elapsed: number, parentToolUseId?: string) => void;
	onToolOutput?: (toolUseId: string, output: string, parentToolUseId?: string) => void;
	onTitleUpdated?: (title: string) => void;
	onTodosUpdated?: (
		todos: { id?: string; content?: string; status?: string }[],
		toolUseId?: string,
	) => void;
	onBufferSet?: (messages: BufferMessageSummary[]) => void;
	onBufferConsumed?: (messageId: string, remaining: BufferMessageSummary[]) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "narrator_error") => void;
	onBufferPreserved?: (messages: BufferMessageSummary[]) => void;
	onPermissionModeChanged?: (permissionMode: string) => void;
	onRelaxedPlanChanged?: (relaxedPlan: boolean) => void;
	onOverseerReviewing?: (
		requestId: string,
		toolUseId: string,
		status: "reviewing" | "queued" | "cleared",
		overseerId?: string,
	) => void;
	onCompacting?: () => void;
	onCompactDone?: (contextPercentAfter?: number, isSegment?: boolean) => void;
	onSegmentCompactHide?: (hiddenMessageIds: string[]) => void;
	onContextUsage?: (
		percentage: number,
		promptTokens?: number,
		contextWindow?: number,
		isEstimated?: boolean,
		pruneStart?: number,
		compactStart?: number,
	) => void;
	onPruneBoundary?: (boundaryMessageId: string | null, prunedPercent: number | null) => void;
	onGitStatus?: (data: {
		chapterId: string;
		commitsAhead: number;
		baseBranch: string;
		linesAdded: number;
		linesRemoved: number;
	}) => void;
	onMetering?: (unit: string, unitPlural: string, usage: number) => void;
	onWebSearch?: (
		id: string,
		status: "in_progress" | "searching" | "completed",
		query?: string,
		queries?: string[],
	) => void;
	onNarratorError?: (error: string, errorCode?: string) => void;
	onNarratorWarning?: (info: {
		message: string;
		retryCount?: number;
		maxRetries?: number;
		delayMs?: number;
	}) => void;
	onInterruptChecking?: () => void;
	onInterruptCheckDone?: () => void;
	onModelChanged?: (model: string) => void;
	onCatchUp?: (orphanChildren: TreeMessage[], topLevel: TreeMessage[]) => void;
	onFullReload?: () => void;
	onCommitsUpdated?: (chapterId: string, newCount: number) => void;
	onBackgroundTaskStarted?: (
		taskNarratorId: string,
		toolUseId: string,
		subagentType: string,
	) => void;
	onSubagentStarted?: (toolUseId: string, model?: string) => void;
	onBackgroundTaskCompleted?: (
		taskNarratorId: string,
		toolUseId: string,
		resultPreview: string,
	) => void;
	onBackgroundTaskFailed?: (taskNarratorId: string, toolUseId: string, error: string) => void;
	onBackgroundTaskCancelled?: (taskNarratorId: string, toolUseId: string) => void;
	onMessagesDeleted?: (deletedMessageIds: string[]) => void;
	onMessageUpdated?: (message: TreeMessage) => void;
	onPresenceUpdate?: (
		viewers: Array<{
			userId: string;
			username: string;
			avatarColor: string | null;
			avatarImageId: string | null;
		}>,
	) => void;
	onStreamingSnapshot?: (snapshot: {
		streamingBlocks: Array<
			| { type: "reasoning"; text: string }
			| { type: "web_search"; id: string; status: string; query?: string; queries?: string[] }
			| { type: "text"; text: string }
		>;
		toolChunks: Array<{
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
			parentToolUseId?: string;
			extractedFilePath?: string;
			contentCharsReceived?: number;
			started?: boolean;
			input?: unknown;
			streamStartedAt?: number;
			streamingOutput?: string;
		}>;
	}) => void;
	onBrowserSessionCount?: (count: number) => void;
}

export function useNarratorWS(
	narratorId: string | undefined,
	callbacks: NarratorWSCallbacks,
	lastMessageId?: string,
) {
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const lastMessageIdRef = useRef(lastMessageId);
	useEffect(() => {
		if (lastMessageId !== undefined) {
			lastMessageIdRef.current = lastMessageId;
		} else {
			lastMessageIdRef.current = undefined;
		}
	}, [lastMessageId]);

	const [connected, setConnected] = useState(narratorWSManager.connected);
	const [disconnected, setDisconnected] = useState(narratorWSManager.disconnected);

	useEffect(() => {
		if (!narratorId) return;

		const subscribedId = narratorId;

		// Subscribe to this narrator (fullSubscribe ensures the server always
		// sends back the streaming snapshot even when a list-level subscriber
		// already holds a ref-count for this narrator ID).
		const subHandle: SubscriptionHandle = narratorWSManager.subscribe([subscribedId], {
			lastMessageId: lastMessageIdRef.current || undefined,
			fullSubscribe: true,
		});

		// Join presence
		narratorWSManager.joinPresence(subscribedId, subHandle._id);

		// Register message listener
		const listenerHandle: ListenerHandle = narratorWSManager.addListener(
			{ narratorIds: [subscribedId] },
			(data) => {
				// Guard: discard messages targeting a different narrator
				if (data.narratorId && data.narratorId !== subscribedId) return;

				switch (data.type) {
					case "message":
						callbacksRef.current.onMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							const msgId = (data.message as TreeMessage).id;
							lastMessageIdRef.current = msgId;
							narratorWSManager.updateLastMessageId(subscribedId, msgId);
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
						break;
					case "user_message":
						callbacksRef.current.onUserMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							const msgId = (data.message as TreeMessage).id;
							lastMessageIdRef.current = msgId;
							narratorWSManager.updateLastMessageId(subscribedId, msgId);
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
						break;
					case "stream_event":
						callbacksRef.current.onStreamEvent?.(data);
						break;
					case "permission_request":
						if (data.request) {
							callbacksRef.current.onPermissionRequest?.(data.request as PendingPermission);
						}
						break;
					case "permission_resolved":
						callbacksRef.current.onPermissionResolved?.(
							data.requestId as string,
							data.toolUseId as string | undefined,
							data.updatedInput as Record<string, unknown> | undefined,
							data.decision as "allow" | "deny" | undefined,
							data.feedbackText as string | undefined,
						);
						break;
					case "status_change":
						callbacksRef.current.onStatusChange?.(
							data.status as string,
							data.turnStartedAt as string | undefined,
						);
						break;
					case "tool_started":
						callbacksRef.current.onToolStarted?.(
							data.toolUseId as string,
							data.toolName as string,
							data.streamStartedAt as number | undefined,
							data.input as Record<string, unknown> | undefined,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "tool_use_chunk":
						callbacksRef.current.onToolUseChunk?.(
							data.toolUseId as string,
							data.toolName as string,
							data.inputCharsTotal as number,
							data.parentToolUseId as string | undefined,
							data.extractedFilePath as string | undefined,
							data.contentCharsReceived as number | undefined,
							data.extractedFields as Record<string, string> | undefined,
						);
						break;
					case "tool_completed":
						callbacksRef.current.onToolCompleted?.(
							data.toolUseId as string,
							data.status as string,
							data.output,
							data.durationMs as number | undefined,
							data.updatedInput as Record<string, unknown> | undefined,
							data.metadata as Record<string, unknown> | undefined,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "tool_long_running":
						callbacksRef.current.onToolLongRunning?.(
							data.toolUseId as string,
							data.elapsed as number,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "tool_output":
						callbacksRef.current.onToolOutput?.(
							data.toolUseId as string,
							data.output as string,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "todos_updated":
						callbacksRef.current.onTodosUpdated?.(
							data.todos as { id?: string; content?: string; status?: string }[],
							data.toolUseId as string | undefined,
						);
						break;
					case "title_updated":
						callbacksRef.current.onTitleUpdated?.(data.title as string);
						break;
					case "buffer_set":
						callbacksRef.current.onBufferSet?.(data.messages as BufferMessageSummary[]);
						break;
					case "buffer_consumed":
						callbacksRef.current.onBufferConsumed?.(
							data.messageId as string,
							data.remaining as BufferMessageSummary[],
						);
						break;
					case "buffer_cleared":
						callbacksRef.current.onBufferCleared?.(
							data.reason as "cancelled" | "sent" | "narrator_error",
						);
						break;
					case "buffer_preserved":
						callbacksRef.current.onBufferPreserved?.(data.messages as BufferMessageSummary[]);
						break;
					case "permission_mode_changed":
						callbacksRef.current.onPermissionModeChanged?.(data.permissionMode as string);
						break;
					case "relaxed_plan_changed":
						callbacksRef.current.onRelaxedPlanChanged?.(data.relaxedPlan as boolean);
						break;
					case "overseer_reviewing":
						callbacksRef.current.onOverseerReviewing?.(
							data.requestId as string,
							data.toolUseId as string,
							data.status as "reviewing" | "queued" | "cleared",
							data.overseerId as string | undefined,
						);
						break;
					case "compacting":
						callbacksRef.current.onCompacting?.();
						break;
					case "compact_done":
					case "compact_failed":
						callbacksRef.current.onCompactDone?.(
							data.contextPercentAfter as number | undefined,
							data.isSegment as boolean | undefined,
						);
						break;
					case "segment_compact_hide":
						if (data.hiddenMessageIds) {
							callbacksRef.current.onSegmentCompactHide?.(data.hiddenMessageIds as string[]);
						}
						break;
					case "context_usage":
						if (!data.isSubagent) {
							callbacksRef.current.onContextUsage?.(
								data.percentage as number,
								data.promptTokens as number | undefined,
								data.contextWindow as number | undefined,
								data.isEstimated as boolean | undefined,
								data.pruneStart as number | undefined,
								data.compactStart as number | undefined,
							);
						}
						break;
					case "prune_boundary":
						callbacksRef.current.onPruneBoundary?.(
							(data.boundaryMessageId as string) ?? null,
							(data.prunedPercent as number) ?? null,
						);
						break;
					case "git_status":
						if (data.chapterId) {
							callbacksRef.current.onGitStatus?.({
								chapterId: data.chapterId as string,
								commitsAhead: (data.commitsAhead as number) ?? 0,
								baseBranch: (data.baseBranch as string) ?? "",
								linesAdded: (data.linesAdded as number) ?? 0,
								linesRemoved: (data.linesRemoved as number) ?? 0,
							});
						}
						break;
					case "metering":
						if (!data.isSubagent) {
							callbacksRef.current.onMetering?.(
								data.unit as string,
								data.unitPlural as string,
								data.usage as number,
							);
						}
						break;
						break;
							data.position as number,
							data.queueDepth as number,
						);
						break;
					case "web_search":
						callbacksRef.current.onWebSearch?.(
							data.id as string,
							data.status as "in_progress" | "searching" | "completed",
							data.query as string | undefined,
							data.queries as string[] | undefined,
						);
						break;
					case "narrator_error":
						callbacksRef.current.onNarratorError?.(
							data.error as string,
							data.errorCode as string | undefined,
						);
						break;
					case "warning":
						callbacksRef.current.onNarratorWarning?.({
							message: data.message as string,
							retryCount: data.retryCount as number | undefined,
							maxRetries: data.maxRetries as number | undefined,
							delayMs: data.delayMs as number | undefined,
						});
						break;
					case "interrupt_checking":
						callbacksRef.current.onInterruptChecking?.();
						break;
					case "interrupt_check_done":
						callbacksRef.current.onInterruptCheckDone?.();
						break;
					case "model_changed":
					case "model_switched":
						if (data.model) {
							callbacksRef.current.onModelChanged?.(data.model as string);
						}
						break;
					case "catch_up": {
						const topLevel = (data.topLevel ?? []) as TreeMessage[];
						const orphanChildren = (data.orphanChildren ?? []) as TreeMessage[];
						callbacksRef.current.onCatchUp?.(orphanChildren, topLevel);
						if (topLevel.length > 0) {
							const lastId = topLevel[topLevel.length - 1].id;
							lastMessageIdRef.current = lastId;
							narratorWSManager.updateLastMessageId(subscribedId, lastId);
						}
						// Track messageVersion from catch_up response
						if (typeof data.messageVersion === "number") {
							narratorWSManager.updateMessageVersion(subscribedId, data.messageVersion as number);
						}
						break;
					}
					case "full_reload":
						callbacksRef.current.onFullReload?.();
						break;
					case "sync_ok":
						// Server confirmed we're in sync — update tracked version
						if (typeof data.version === "number") {
							narratorWSManager.updateMessageVersion(subscribedId, data.version as number);
						}
						break;
					case "messages_deleted":
						if (data.deletedMessageIds) {
							callbacksRef.current.onMessagesDeleted?.(data.deletedMessageIds as string[]);
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
						break;
					case "message_updated":
						if (data.message) {
							callbacksRef.current.onMessageUpdated?.(data.message as TreeMessage);
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
						break;
					case "commits_updated":
						if (data.chapterId) {
							callbacksRef.current.onCommitsUpdated?.(
								data.chapterId as string,
								(data.newCount as number) ?? 0,
							);
						}
						break;
					case "background_task_started":
						callbacksRef.current.onBackgroundTaskStarted?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							data.subagentType as string,
						);
						break;
					case "subagent_started":
						callbacksRef.current.onSubagentStarted?.(
							data.toolUseId as string,
							data.model as string | undefined,
						);
						break;
					case "background_task_completed":
						callbacksRef.current.onBackgroundTaskCompleted?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							data.resultPreview as string,
						);
						break;
					case "background_task_failed":
						callbacksRef.current.onBackgroundTaskFailed?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							data.error as string,
						);
						break;
					case "background_task_cancelled":
						callbacksRef.current.onBackgroundTaskCancelled?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
						);
						break;
					case "presence_update":
						callbacksRef.current.onPresenceUpdate?.(
							(data.viewers ?? []) as Array<{
								userId: string;
								username: string;
								avatarColor: string | null;
								avatarImageId: string | null;
							}>,
						);
						break;
					case "streaming_snapshot":
						callbacksRef.current.onStreamingSnapshot?.({
							streamingBlocks: (data.streamingBlocks ?? []) as Array<
								| { type: "reasoning"; text: string }
								| {
										type: "web_search";
										id: string;
										status: string;
										query?: string;
										queries?: string[];
								  }
								| { type: "text"; text: string }
							>,
							toolChunks: (data.toolChunks ?? []) as Array<{
								toolUseId: string;
								toolName: string;
								inputCharsTotal: number;
								parentToolUseId?: string;
								extractedFilePath?: string;
								contentCharsReceived?: number;
								started?: boolean;
								input?: unknown;
								streamStartedAt?: number;
								streamingOutput?: string;
							}>,
						});
						break;
					case "browser_session_count":
						callbacksRef.current.onBrowserSessionCount?.(
							(data.activeBrowserSessions as number) ?? 0,
						);
						break;
				}
			},
		);

		// Connection state tracking
		const unsubConnection = narratorWSManager.onConnectionChange((conn) => {
			setConnected(conn);
			setDisconnected(narratorWSManager.disconnected);
		});

		return () => {
			unsubConnection();
			narratorWSManager.removeListener(listenerHandle);
			narratorWSManager.leavePresence(subscribedId, subHandle._id);
			narratorWSManager.unsubscribe(subHandle);
		};
	}, [narratorId]);

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
			return narratorWSManager.send({
				type: "permission_decision",
				requestId,
				decision,
				message,
				answers,
				feedbackText,
				compactAfter,
				updatedPlan,
			});
		},
		[],
	);

	const sendBufferMessage = useCallback((targetNarratorId: string, text: string): boolean => {
		return narratorWSManager.send({
			type: "buffer_message",
			narratorId: targetNarratorId,
			text,
		});
	}, []);

	const cancelBuffer = useCallback((targetNarratorId: string): boolean => {
		return narratorWSManager.send({
			type: "cancel_buffer",
			narratorId: targetNarratorId,
		});
	}, []);

	const reconnect = useCallback(() => {
		narratorWSManager.reconnect();
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
	const onUpdateRef = useRef(onUpdate);
	onUpdateRef.current = onUpdate;
	const onGlobalEventRef = useRef(onGlobalEvent);
	onGlobalEventRef.current = onGlobalEvent;
	const [connected, setConnected] = useState(narratorWSManager.connected);
	const [disconnected, setDisconnected] = useState(narratorWSManager.disconnected);

	const idsKey = useMemo(() => narratorIds.join(","), [narratorIds]);

	// Subscription handle ref — persists across ID changes
	const subHandleRef = useRef<SubscriptionHandle | null>(null);
	const listenerHandleRef = useRef<ListenerHandle | null>(null);
	const globalListenerHandleRef = useRef<ListenerHandle | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: idsKey is a stable memoized serialization of narratorIds
	useEffect(() => {
		if (!narratorIds.length && !onGlobalEventRef.current) {
			// No narrators to watch — clean up any stale listener from a previous run
			if (listenerHandleRef.current) {
				narratorWSManager.removeListener(listenerHandleRef.current);
				listenerHandleRef.current = null;
			}
			return;
		}

		// First mount or IDs changed — manage subscription
		if (!subHandleRef.current) {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds);
		} else {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		}

		// Re-register listener with the current narrator IDs for precise filtering
		if (listenerHandleRef.current) {
			narratorWSManager.removeListener(listenerHandleRef.current);
		}
		listenerHandleRef.current = narratorWSManager.addListener(
			{
				narratorIds: narratorIds.length > 0 ? narratorIds : "*",
				types: ["status_change", "title_updated", "permission_mode_changed", "presence_update"],
			},
			(data) => {
				const nId = data.narratorId as string | undefined;
				if (data.type === "status_change") {
					if (nId) onUpdateRef.current(nId, { type: "status", status: data.status as string });
				} else if (data.type === "title_updated") {
					if (nId) onUpdateRef.current(nId, { type: "title", title: data.title as string });
				} else if (data.type === "permission_mode_changed") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "permissionMode",
							permissionMode: data.permissionMode as string,
						});
				} else if (data.type === "presence_update") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "presence",
							viewers: data.viewers as NarratorListWSEvent["viewers"],
						});
				}
			},
		);

		// We don't return cleanup here — that's handled by the mount-only effect below
	}, [idsKey]);

	// Mount-only: global event listener + connection tracking, cleanup on unmount
	useEffect(() => {
		// Separate listener for global "user:*" events (not narrator-scoped)
		globalListenerHandleRef.current = narratorWSManager.addListener(
			{ typePrefixes: ["user:"] },
			(data) => {
				onGlobalEventRef.current?.(data as { type: string; [key: string]: unknown });
			},
		);

		const unsubConnection = narratorWSManager.onConnectionChange((conn) => {
			setConnected(conn);
			setDisconnected(narratorWSManager.disconnected);
		});

		return () => {
			unsubConnection();
			if (listenerHandleRef.current) {
				narratorWSManager.removeListener(listenerHandleRef.current);
				listenerHandleRef.current = null;
			}
			if (globalListenerHandleRef.current) {
				narratorWSManager.removeListener(globalListenerHandleRef.current);
				globalListenerHandleRef.current = null;
			}
			if (subHandleRef.current) {
				narratorWSManager.unsubscribe(subHandleRef.current);
				subHandleRef.current = null;
			}
		};
	}, []);

	const reconnect = useCallback(() => {
		narratorWSManager.reconnect();
	}, []);

	return { connected, disconnected, reconnect };
}
