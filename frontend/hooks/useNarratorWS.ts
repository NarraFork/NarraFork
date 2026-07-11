import type { PendingPermission } from "@frontend/types/narrator";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BufferMessageSummary, SideCarRecord, TreeMessage } from "../lib/api";
import {
	type ListenerHandle,
	type NarratorSubscriptionKind,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";

function eventDiagnosticMessage(data: Record<string, unknown>, fallback = "Unknown error"): string {
	for (const key of ["reason", "message", "error", "code"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return fallback;
}

export interface CommitSyncErrorEvent {
	chapterId: string;
	code?: string;
	reason?: string;
	error?: string;
	message?: string;
	fallback?: boolean;
	fatal?: boolean;
	backgroundSync?: boolean;
	[key: string]: unknown;
}

export function coerceCommitSyncErrorEvent(
	data: Record<string, unknown>,
): CommitSyncErrorEvent | null {
	if (typeof data.chapterId !== "string" || !data.chapterId) return null;
	return {
		...data,
		chapterId: data.chapterId,
		code: typeof data.code === "string" ? data.code : undefined,
		reason: typeof data.reason === "string" ? data.reason : undefined,
		error: typeof data.error === "string" ? data.error : undefined,
		message: typeof data.message === "string" ? data.message : undefined,
		fallback: typeof data.fallback === "boolean" ? data.fallback : undefined,
		fatal: typeof data.fatal === "boolean" ? data.fatal : undefined,
		backgroundSync: typeof data.backgroundSync === "boolean" ? data.backgroundSync : undefined,
	};
}

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
		subagentNarratorId?: string,
	) => void;
	onDangerReflectionStarted?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		danger?: unknown;
	}) => void;
	onDangerReflectionResolved?: (data: {
		requestId: string;
		toolUseId: string;
		decision: "allow" | "deny" | "aborted";
		reason?: string;
	}) => void;
	onDangerReflectionStopped?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		danger?: unknown;
		inputJson?: Record<string, unknown>;
		reason?: string;
	}) => void;
	onPlanReflectionStarted?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		inputJson?: Record<string, unknown>;
		reason?: string;
	}) => void;
	onPlanReflectionResolved?: (data: {
		requestId: string;
		toolUseId: string;
		decision: "allow" | "deny" | "aborted";
		reason?: string;
	}) => void;
	onPlanReflectionStopped?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		inputJson?: Record<string, unknown>;
		reason?: string;
	}) => void;
	onTaskReflectionStarted?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		inputJson?: Record<string, unknown>;
		mutations?: unknown;
		reason?: string;
	}) => void;
	onTaskReflectionResolved?: (data: {
		requestId: string;
		toolUseId: string;
		decision: "allow" | "deny" | "aborted";
		reason?: string;
		nextSteps?: string;
	}) => void;
	onTaskReflectionStopped?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		inputJson?: Record<string, unknown>;
		mutations?: unknown;
		reason?: string;
	}) => void;
	onQuestionReflectionStarted?: (data: {
		requestId: string;
		toolUseId: string;
		toolName: string;
		inputJson?: Record<string, unknown>;
		reason?: string;
	}) => void;
	onQuestionReflectionResolved?: (data: {
		requestId: string;
		toolUseId: string;
		decision: "allow" | "deny" | "aborted";
		reason?: string;
	}) => void;
	onQuestionReflectionDisarmed?: (data: { requestId: string; toolUseId: string }) => void;
	onStatusChange?: (status: string, turnStartedAt?: string, substatus?: string[]) => void;
	onSubstatusChange?: (substatus: string[]) => void;
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
		metadata?: Record<string, unknown>,
		streamingField?: { name: string; delta: string },
	) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		durationMs?: number,
		updatedInput?: Record<string, unknown>,
		metadata?: Record<string, unknown>,
		parentToolUseId?: string,
		sideCars?: SideCarRecord[],
	) => void;
	onSideCars?: (sideCars: SideCarRecord[], parentToolUseId?: string) => void;
	onToolLongRunning?: (toolUseId: string, elapsed: number, parentToolUseId?: string) => void;
	onTimeoutUpdated?: (toolUseId: string, timeoutMs: number) => void;
	onToolOutput?: (toolUseId: string, output: string, parentToolUseId?: string) => void;
	onTitleUpdated?: (title: string) => void;
	onBufferSet?: (messages: BufferMessageSummary[]) => void;
	onBufferConsumed?: (messageId: string, remaining: BufferMessageSummary[]) => void;
	onQueuedNewNarratorCreated?: (messageId: string, newNarratorId: string) => void;
	onBufferCleared?: (reason: "cancelled" | "sent" | "narrator_error") => void;
	onBufferPreserved?: (messages: BufferMessageSummary[]) => void;
	onPermissionModeChanged?: (permissionMode: string) => void;
	onPlanModeChanged?: (planMode: boolean, traits?: string[]) => void;
	onCustomTraitsChanged?: (traits?: string[]) => void;
	onDraftChanged?: (draft: {
		hasDraft: boolean;
		text: string;
		updatedAt: string | null;
		updatedBy: string | null;
		sourceId: string | null;
	}) => void;
	onRelaxedPlanChanged?: (relaxedPlan: boolean) => void;
	onReflectionOverridesChanged?: (overrides: {
		planReflectionAutoApproveOverride?: "inherit" | "on" | "off";
		dangerReflectionOverride?: "inherit" | "on" | "off" | "light" | "standard" | "strict";
	}) => void;
	onCompacting?: (mode?: "blocking" | "background") => void;
	onCompactDone?: (
		contextPercentAfter?: number,
		isSegment?: boolean,
		mode?: "blocking" | "background",
	) => void;
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
	onQuotaBalance?: (quotaBalance: string | null, detailedQuotaBalance?: string | null) => void;
	onPaymentRequired?: (info: {
		providerId?: string;
		providerPrefix?: string;
		balance?: number;
		required?: number;
		resumeAction: "retry" | "continue";
	}) => void;
	onQueueStatus?: (position?: number, queueDepth?: number, queueMessage?: string) => void;
	onWebSearch?: (
		id: string,
		status: "in_progress" | "searching" | "completed",
		query?: string,
		queries?: string[],
		outputIndex?: number,
		parentToolUseId?: string,
	) => void;
	onImageGeneration?: (
		id: string,
		status: "in_progress" | "generating" | "completed",
		revisedPrompt?: string,
		outputIndex?: number,
		partialImageIndex?: number,
		partialSavedPath?: string,
		savedPath?: string,
		width?: number,
		height?: number,
		parentToolUseId?: string,
	) => void;
	onNarratorError?: (error: string, errorCode?: string) => void;
	onNarratorWarning?: (info: {
		message: string;
		retryCount?: number;
		maxRetries?: number;
		delayMs?: number;
	}) => void;
	onLeakedToolCall?: (info: {
		phase: "stream_captured" | "recovered" | "unrecovered";
		apiRequestId: string;
		toolUseIds?: string[];
		toolNames?: string[];
		snippet?: string;
	}) => void;
	onModelChanged?: (model: string) => void;
	onCatchUp?: (orphanChildren: TreeMessage[], topLevel: TreeMessage[]) => void;
	onFullReload?: () => void;
	onSyncOk?: () => void;
	onCommitsUpdated?: (chapterId: string, newCount: number) => void;
	onCommitSyncError?: (event: CommitSyncErrorEvent) => void;
	onBackgroundTaskStarted?: (
		taskNarratorId: string,
		toolUseId: string,
		subagentType: string,
	) => void;
	onSubagentStarted?: (toolUseId: string, model?: string) => void;
	onSubagentSuspended?: (subagentNarratorId: string, toolUseId: string) => void;
	onSubagentStatusChanged?: (
		subagentNarratorId: string,
		status: string,
		substatus?: string[],
	) => void;
	onSubagentWarning?: (
		subagentNarratorId: string,
		info: {
			message: string;
			retryCount?: number;
			maxRetries?: number;
			delayMs?: number;
		},
	) => void;
	onSubagentConclusionUpdated?: (
		subagentNarratorId: string,
		toolUseId: string,
		output: string,
		hasError: boolean,
	) => void;
	onBackgroundTaskCompleted?: (
		taskNarratorId: string,
		toolUseId: string,
		resultPreview: string,
	) => void;
	onBackgroundTaskFailed?: (taskNarratorId: string, toolUseId: string, error: string) => void;
	onBackgroundTaskCancelled?: (taskNarratorId: string, toolUseId: string) => void;
	onBackgroundTaskStatusChanged?: (taskId: string, status: string, narratorId: string) => void;
	onBackgroundTaskOutput?: (taskId: string, narratorId: string) => void;
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
			| { type: "reasoning"; id?: string; outputIndex?: number; text: string }
			| {
					type: "web_search";
					id: string;
					status: string;
					query?: string;
					queries?: string[];
					outputIndex?: number;
			  }
			| {
					type: "image_generation";
					id: string;
					status: string;
					revisedPrompt?: string;
					result?: string;
					partialImageIndex?: number;
					partialSavedPath?: string;
					savedPath?: string;
					width?: number;
					height?: number;
					outputIndex?: number;
			  }
			| { type: "text"; text: string; outputIndex?: number }
		>;
		toolChunks: Array<{
			toolUseId: string;
			toolName: string;
			inputCharsTotal: number;
			parentToolUseId?: string;
			extractedFilePath?: string;
			contentCharsReceived?: number;
			extractedFields?: Record<string, string>;
			metadata?: Record<string, unknown>;
			started?: boolean;
			input?: unknown;
			streamStartedAt?: number;
			streamingOutput?: string;
		}>;
	}) => void;
	onBrowserSessionCount?: (count: number) => void;
	onBrowserSessionVisualChange?: (sessionId: string) => void;
	/** A reasoning-only dead turn was discarded — drop any live streaming blocks. */
	onStreamingReset?: (parentToolUseId?: string) => void;
}

function getDeepestMessageId(message: TreeMessage | undefined): string | undefined {
	if (!message?.id) return undefined;
	let deepest = message;
	while (deepest.children?.length) {
		deepest = deepest.children[deepest.children.length - 1];
	}
	return deepest.id;
}

function getLastCatchUpMessageId(
	topLevel: TreeMessage[],
	orphanChildren: TreeMessage[],
): string | undefined {
	const lastTopLevelId = getDeepestMessageId(topLevel[topLevel.length - 1]);
	if (lastTopLevelId) return lastTopLevelId;
	return orphanChildren[orphanChildren.length - 1]?.id;
}

export function useNarratorWS(
	narratorId: string | undefined,
	callbacks: NarratorWSCallbacks,
	lastMessageId?: string,
	options?: { trackRealtimeMessageVersion?: boolean; kind?: NarratorSubscriptionKind },
) {
	const callbacksRef = useRef(callbacks);
	callbacksRef.current = callbacks;
	const trackRealtimeMessageVersionRef = useRef(options?.trackRealtimeMessageVersion ?? true);
	trackRealtimeMessageVersionRef.current = options?.trackRealtimeMessageVersion ?? true;
	const subscriptionKind = options?.kind ?? "messages";
	const providedLastMessageIdRef = useRef(lastMessageId);
	const lastMessageIdRef = useRef(lastMessageId);
	useEffect(() => {
		providedLastMessageIdRef.current = lastMessageId;
		if (lastMessageId !== undefined) {
			lastMessageIdRef.current = lastMessageId;
			if (narratorId) narratorWSManager.updateLastMessageId(narratorId, lastMessageId);
		} else {
			lastMessageIdRef.current = undefined;
		}
	}, [lastMessageId, narratorId]);

	const [connected, setConnected] = useState(narratorWSManager.connected);
	const [disconnected, setDisconnected] = useState(narratorWSManager.disconnected);

	useEffect(() => {
		if (!narratorId) return;

		const subscribedId = narratorId;

		const subHandle: SubscriptionHandle = narratorWSManager.subscribe([subscribedId], {
			lastMessageId: lastMessageIdRef.current || undefined,
			kind: subscriptionKind,
		});

		// Join presence
		narratorWSManager.joinPresence(subscribedId, subHandle._id);

		// Register message listener
		const listenerHandle: ListenerHandle = narratorWSManager.addListener(
			{ narratorIds: [subscribedId], subscriptionId: subHandle._id },
			(data) => {
				// Guard: discard messages targeting a different narrator
				if (data.narratorId && data.narratorId !== subscribedId) return;

				switch (data.type) {
					case "message":
						callbacksRef.current.onMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							const msg = data.message as TreeMessage;
							lastMessageIdRef.current = msg.id;
							narratorWSManager.noteMessage(subscribedId, msg);
							if (trackRealtimeMessageVersionRef.current) {
								narratorWSManager.bumpMessageVersion(subscribedId);
							}
						}
						break;
					case "user_message":
						callbacksRef.current.onUserMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							const msg = data.message as TreeMessage;
							lastMessageIdRef.current = msg.id;
							narratorWSManager.noteMessage(subscribedId, msg);
							if (trackRealtimeMessageVersionRef.current) {
								narratorWSManager.bumpMessageVersion(subscribedId);
							}
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
							data.subagentNarratorId as string | undefined,
						);
						break;
					case "danger_reflection_started":
						callbacksRef.current.onDangerReflectionStarted?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							danger: data.danger,
						});
						break;
					case "danger_reflection_resolved":
						callbacksRef.current.onDangerReflectionResolved?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "danger_reflection_stopped":
						callbacksRef.current.onDangerReflectionStopped?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							danger: data.danger,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_started":
						callbacksRef.current.onPlanReflectionStarted?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_resolved":
						callbacksRef.current.onPlanReflectionResolved?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_stopped":
						callbacksRef.current.onPlanReflectionStopped?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "task_reflection_started":
						callbacksRef.current.onTaskReflectionStarted?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							mutations: data.mutations,
							reason: data.reason as string | undefined,
						});
						break;
					case "task_reflection_resolved":
						callbacksRef.current.onTaskReflectionResolved?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
							nextSteps: data.nextSteps as string | undefined,
						});
						break;
					case "task_reflection_stopped":
						callbacksRef.current.onTaskReflectionStopped?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							mutations: data.mutations,
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_started":
						callbacksRef.current.onQuestionReflectionStarted?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_resolved":
						callbacksRef.current.onQuestionReflectionResolved?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_disarmed":
						callbacksRef.current.onQuestionReflectionDisarmed?.({
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
						});
						break;
					case "status_change":
						callbacksRef.current.onStatusChange?.(
							data.status as string,
							data.turnStartedAt as string | undefined,
							data.substatus as string[] | undefined,
						);
						break;
					case "substatus_change":
						callbacksRef.current.onSubstatusChange?.(data.substatus as string[]);
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
							data.metadata as Record<string, unknown> | undefined,
							data.streamingField as { name: string; delta: string } | undefined,
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
							data.sideCars as SideCarRecord[] | undefined,
						);
						if (trackRealtimeMessageVersionRef.current) {
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
						break;
					case "sidecars":
						callbacksRef.current.onSideCars?.(
							data.sideCars as SideCarRecord[],
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
					case "timeout_updated":
						callbacksRef.current.onTimeoutUpdated?.(
							data.toolUseId as string,
							data.timeoutMs as number,
						);
						break;
					case "tool_output":
						callbacksRef.current.onToolOutput?.(
							data.toolUseId as string,
							data.output as string,
							data.parentToolUseId as string | undefined,
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
					case "queued_new_narrator_created":
						callbacksRef.current.onQueuedNewNarratorCreated?.(
							data.messageId as string,
							data.newNarratorId as string,
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
					case "plan_mode_changed":
						callbacksRef.current.onPlanModeChanged?.(
							data.planMode as boolean,
							Array.isArray(data.traits) ? (data.traits as string[]) : undefined,
						);
						break;
					case "custom_traits_changed":
						callbacksRef.current.onCustomTraitsChanged?.(
							Array.isArray(data.traits) ? (data.traits as string[]) : undefined,
						);
						break;
					case "draft_changed":
						callbacksRef.current.onDraftChanged?.({
							hasDraft: !!data.hasDraft,
							text: typeof data.text === "string" ? data.text : "",
							updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
							updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
							sourceId: typeof data.sourceId === "string" ? data.sourceId : null,
						});
						break;
					case "relaxed_plan_changed":
						callbacksRef.current.onRelaxedPlanChanged?.(data.relaxedPlan as boolean);
						break;
					case "reflection_overrides_changed":
						callbacksRef.current.onReflectionOverridesChanged?.({
							planReflectionAutoApproveOverride: data.planReflectionAutoApproveOverride as
								| "inherit"
								| "on"
								| "off"
								| undefined,
							dangerReflectionOverride: data.dangerReflectionOverride as
								| "inherit"
								| "on"
								| "off"
								| "light"
								| "standard"
								| "strict"
								| undefined,
						});
						break;
					case "compacting":
						callbacksRef.current.onCompacting?.(
							data.mode === "background" ? "background" : "blocking",
						);
						break;
					case "compact_done":
					case "compact_failed":
						callbacksRef.current.onCompactDone?.(
							data.contextPercentAfter as number | undefined,
							data.isSegment as boolean | undefined,
							data.mode === "background" ? "background" : "blocking",
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
					case "quota_balance": {
						const quotaBalance = data.quotaBalance;
						const detailedQuotaBalance = data.detailedQuotaBalance;
						const detailedText = detailedQuotaBalance == null ? null : String(detailedQuotaBalance);
						callbacksRef.current.onQuotaBalance?.(
							quotaBalance == null ? null : String(quotaBalance),
							detailedText?.trim() ? detailedText : null,
						);
						break;
					}
					case "payment_required":
						callbacksRef.current.onPaymentRequired?.({
							providerId: data.providerId as string | undefined,
							providerPrefix: data.providerPrefix as string | undefined,
							balance: data.balance as number | undefined,
							required: data.required as number | undefined,
							resumeAction: (data.resumeAction as "retry" | "continue") ?? "retry",
						});
						break;
					case "queue_status":
						callbacksRef.current.onQueueStatus?.(
							data.position as number | undefined,
							data.queueDepth as number | undefined,
							data.queueMessage as string | undefined,
						);
						break;
					case "web_search":
						callbacksRef.current.onWebSearch?.(
							data.id as string,
							data.status as "in_progress" | "searching" | "completed",
							data.query as string | undefined,
							data.queries as string[] | undefined,
							data.outputIndex as number | undefined,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "image_generation":
						callbacksRef.current.onImageGeneration?.(
							data.id as string,
							data.status as "in_progress" | "generating" | "completed",
							data.revisedPrompt as string | undefined,
							data.outputIndex as number | undefined,
							data.partialImageIndex as number | undefined,
							data.partialSavedPath as string | undefined,
							data.savedPath as string | undefined,
							data.width as number | undefined,
							data.height as number | undefined,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "narrator_error":
						callbacksRef.current.onNarratorError?.(
							eventDiagnosticMessage(data),
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
					case "leaked_tool_call_notice":
						callbacksRef.current.onLeakedToolCall?.({
							phase: data.phase as "stream_captured" | "recovered" | "unrecovered",
							apiRequestId: data.apiRequestId as string,
							toolUseIds: data.toolUseIds as string[] | undefined,
							toolNames: data.toolNames as string[] | undefined,
							snippet: data.snippet as string | undefined,
						});
						break;
					case "model_changed":
						if (data.model) {
							callbacksRef.current.onModelChanged?.(data.model as string);
						}
						break;
					case "model_switched":
					case "model_settings_changed":
					case "model_settings_applied":
						// Runtime/applied model events describe the concrete model being used for the
						// current request. Do not write them into the narrator query cache, because
						// narrator.model may intentionally remain __default__ or an aggregation ref.
						break;
					case "catch_up": {
						const topLevel = (data.topLevel ?? []) as TreeMessage[];
						const orphanChildren = (data.orphanChildren ?? []) as TreeMessage[];
						callbacksRef.current.onCatchUp?.(orphanChildren, topLevel);
						const cursor = data.cursor as CatchUpCursor | undefined;
						if (cursor) narratorWSManager.updateCatchUpCursor(subscribedId, cursor);
						const lastId = getLastCatchUpMessageId(topLevel, orphanChildren);
						if (lastId) {
							lastMessageIdRef.current = lastId;
							if (!cursor) narratorWSManager.updateLastMessageId(subscribedId, lastId);
						}
						// Track messageVersion from catch_up response
						if (typeof data.messageVersion === "number") {
							narratorWSManager.updateMessageVersion(subscribedId, data.messageVersion as number);
						}
						break;
					}
					case "full_reload": {
						narratorWSManager.clearCatchUpState(subscribedId);
						const providedLastMessageId = providedLastMessageIdRef.current;
						lastMessageIdRef.current = providedLastMessageId;
						if (providedLastMessageId) {
							narratorWSManager.updateLastMessageId(subscribedId, providedLastMessageId);
						}
						callbacksRef.current.onFullReload?.();
						break;
					}
					case "sync_ok":
						// Server confirmed we're in sync — update tracked version
						if (typeof data.version === "number") {
							narratorWSManager.updateMessageVersion(subscribedId, data.version as number);
						}
						callbacksRef.current.onSyncOk?.();
						break;
					case "messages_deleted":
						if (data.deletedMessageIds) {
							callbacksRef.current.onMessagesDeleted?.(data.deletedMessageIds as string[]);
							if (trackRealtimeMessageVersionRef.current) {
								narratorWSManager.bumpMessageVersion(subscribedId);
							}
						}
						break;
					case "message_updated":
						if (data.message) {
							callbacksRef.current.onMessageUpdated?.(data.message as TreeMessage);
							if (trackRealtimeMessageVersionRef.current) {
								narratorWSManager.bumpMessageVersion(subscribedId);
							}
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
					case "commit_sync_error": {
						const event = coerceCommitSyncErrorEvent(data);
						if (event) callbacksRef.current.onCommitSyncError?.(event);
						break;
					}
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
					case "subagent_suspended":
						callbacksRef.current.onSubagentSuspended?.(
							data.subagentNarratorId as string,
							data.toolUseId as string,
						);
						break;
					case "subagent_status_changed":
						callbacksRef.current.onSubagentStatusChanged?.(
							data.subagentNarratorId as string,
							data.status as string,
							data.substatus as string[] | undefined,
						);
						break;
					case "subagent_warning":
						callbacksRef.current.onSubagentWarning?.(data.subagentNarratorId as string, {
							message: data.message as string,
							retryCount: data.retryCount as number | undefined,
							maxRetries: data.maxRetries as number | undefined,
							delayMs: data.delayMs as number | undefined,
						});
						break;
					case "subagent_conclusion_updated":
						callbacksRef.current.onSubagentConclusionUpdated?.(
							data.subagentNarratorId as string,
							data.toolUseId as string,
							data.output as string,
							data.hasError as boolean,
						);
						if (trackRealtimeMessageVersionRef.current) {
							narratorWSManager.bumpMessageVersion(subscribedId);
						}
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
							eventDiagnosticMessage(data),
						);
						break;
					case "background_task_cancelled":
						callbacksRef.current.onBackgroundTaskCancelled?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
						);
						break;
					case "background_task_status_changed":
						callbacksRef.current.onBackgroundTaskStatusChanged?.(
							data.taskId as string,
							data.status as string,
							data.narratorId as string,
						);
						break;
					case "background_task_output":
						callbacksRef.current.onBackgroundTaskOutput?.(
							data.taskId as string,
							data.narratorId as string,
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
								| { type: "reasoning"; id?: string; outputIndex?: number; text: string }
								| {
										type: "web_search";
										id: string;
										status: string;
										query?: string;
										queries?: string[];
										outputIndex?: number;
								  }
								| {
										type: "image_generation";
										id: string;
										status: string;
										revisedPrompt?: string;
										result?: string;
										outputIndex?: number;
								  }
								| { type: "text"; text: string; outputIndex?: number }
							>,
							toolChunks: (data.toolChunks ?? []) as Array<{
								toolUseId: string;
								toolName: string;
								inputCharsTotal: number;
								parentToolUseId?: string;
								extractedFilePath?: string;
								contentCharsReceived?: number;
								extractedFields?: Record<string, string>;
								metadata?: Record<string, unknown>;
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
					case "browser_session_visual_change":
						callbacksRef.current.onBrowserSessionVisualChange?.(data.sessionId as string);
						break;
					case "streaming_reset":
						callbacksRef.current.onStreamingReset?.(data.parentToolUseId as string | undefined);
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
	}, [narratorId, subscriptionKind]);

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

	return useMemo(
		() => ({
			connected,
			disconnected,
			sendPermissionDecision,
			sendBufferMessage,
			cancelBuffer,
			reconnect,
		}),
		[connected, disconnected, sendPermissionDecision, sendBufferMessage, cancelBuffer, reconnect],
	);
}

/**
 * Subscribe to status/title changes for a list of narrator IDs (used on session list pages).
 * Calls `onUpdate` with the specific narrator ID and event data for targeted cache updates.
 */
export interface NarratorListWSEvent {
	type:
		| "status"
		| "title"
		| "permissionMode"
		| "presence"
		| "terminalCount"
		| "containerStatus"
		| "draft";
	status?: string;
	substatus?: string[];
	/** Execution generation for the current/last turn — used to dedup notifications per turn. */
	turnStartedAt?: string;
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
	hasDraft?: boolean;
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
		if (!narratorIds.length) {
			// No narrators to watch — release any stale subscription/listener from a previous run.
			if (listenerHandleRef.current) {
				narratorWSManager.removeListener(listenerHandleRef.current);
				listenerHandleRef.current = null;
			}
			if (subHandleRef.current) {
				narratorWSManager.unsubscribe(subHandleRef.current);
				subHandleRef.current = null;
			}
			return;
		}

		// First mount or IDs changed — manage subscription
		if (!subHandleRef.current) {
			subHandleRef.current = narratorWSManager.subscribe(narratorIds, { kind: "list" });
		} else {
			narratorWSManager.updateSubscription(subHandleRef.current, narratorIds);
		}

		// Re-register listener with the current narrator IDs for precise filtering
		if (listenerHandleRef.current) {
			narratorWSManager.removeListener(listenerHandleRef.current);
		}
		listenerHandleRef.current = narratorWSManager.addListener(
			{
				narratorIds,
				types: [
					"status_change",
					"substatus_change",
					"title_updated",
					"permission_mode_changed",
					"presence_update",
				],
			},
			(data) => {
				const nId = data.narratorId as string | undefined;
				if (data.type === "status_change") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "status",
							status: data.status as string,
							substatus: data.substatus as string[] | undefined,
						});
				} else if (data.type === "substatus_change") {
					if (nId)
						onUpdateRef.current(nId, {
							type: "status",
							substatus: data.substatus as string[],
						});
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
		// Separate listener for global events (not narrator-scoped).
		globalListenerHandleRef.current = narratorWSManager.addListener(
			{ typePrefixes: ["user:", "merge:"] },
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

	return useMemo(
		() => ({ connected, disconnected, reconnect }),
		[connected, disconnected, reconnect],
	);
}
