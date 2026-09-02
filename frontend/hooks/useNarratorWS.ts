import type { PendingPermission } from "@frontend/types/narrator";
import type { BackgroundTaskListDelta } from "@shared/background-task-list";
import type { CatchUpCursor } from "@shared/narrator-catch-up";
import { coerceProgressSnapshot, type ProgressSnapshot } from "@shared/progress-phase";
import {
	normalizeSubagentToolInputSummary,
	type SubagentToolInputSummary,
} from "@shared/subagent-tool-summary";
import { readToolProgressPayload, type ToolProgressPayload } from "@shared/tool-progress";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	BufferMessageSummary,
	SubagentActivityCatchUp,
	SubagentActivitySummary,
	SubagentToolCallHeader,
	SubagentToolCallTiming,
	TreeMessage,
} from "../lib/api";
import {
	type ListenerHandle,
	type NarratorMessageSnapshot,
	type NarratorSubscriptionKind,
	narratorWSManager,
	type SubscriptionHandle,
} from "../lib/narrator-ws-manager";

function nonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed || null;
}

/**
 * Read the subagent-activity fields off a raw tool frame.
 *
 * Exported for tests: the summary crosses several renames between the wire and the
 * rendered row, so the chain is asserted end to end from the real frame shape rather
 * than from a hand-built meta object.
 */
export function subagentToolEventMeta(data: Record<string, unknown>): SubagentToolEventMeta {
	const rawTiming =
		data.timing && typeof data.timing === "object"
			? (data.timing as SubagentToolCallTiming)
			: undefined;
	const timing: SubagentToolCallTiming = {
		...(rawTiming ?? {}),
		...(data.startedAt != null ? { startedAt: data.startedAt as string | number } : {}),
		...(data.streamStartedAt != null
			? { streamStartedAt: data.streamStartedAt as string | number }
			: {}),
		...(data.permissionStartedAt != null
			? { permissionStartedAt: data.permissionStartedAt as string | number }
			: {}),
		...(data.executionStartedAt != null
			? { executionStartedAt: data.executionStartedAt as string | number }
			: {}),
		...(data.completedAt != null ? { completedAt: data.completedAt as string | number } : {}),
		...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
	};
	return {
		toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
		toolName: typeof data.toolName === "string" ? data.toolName : null,
		createdAt:
			typeof data.createdAt === "string" || typeof data.createdAt === "number"
				? data.createdAt
				: null,
		timing: Object.keys(timing).length > 0 ? timing : null,
		subagentNarratorId:
			typeof data.subagentNarratorId === "string" ? data.subagentNarratorId : null,
		model: nonEmptyString(data.model),
		// Re-normalized rather than trusted: the same cap and key whitelist the server
		// applied, so a hand-crafted frame cannot widen the payload the row renders.
		inputSummary: normalizeSubagentToolInputSummary(data.inputSummary),
	};
}

function normalizeSubagentActivityHeader(value: unknown): SubagentToolCallHeader | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.toolUseId !== "string" || typeof record.toolName !== "string") return null;
	const eventMeta = subagentToolEventMeta(record);
	return {
		toolCallId: typeof record.toolCallId === "string" ? record.toolCallId : null,
		toolUseId: record.toolUseId,
		toolName: record.toolName,
		status: typeof record.status === "string" ? record.status : "initializing",
		createdAt:
			typeof record.createdAt === "string" || typeof record.createdAt === "number"
				? record.createdAt
				: null,
		timing: eventMeta.timing ?? null,
		// Reconnect catch-up ships the SAME server-side projection the REST fetch does
		// (`loadLatestSubagentToolCalls`). Dropping it here re-blanked every row the
		// moment a reconnect snapshot replaced the fetched activity.
		...(eventMeta.inputSummary ? { inputSummary: eventMeta.inputSummary } : {}),
	};
}

function normalizeSubagentActivitySummary(value: unknown): SubagentActivitySummary | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const latestToolCalls = Array.isArray(record.latestToolCalls)
		? record.latestToolCalls
				.map(normalizeSubagentActivityHeader)
				.filter((header): header is SubagentToolCallHeader => header !== null)
				.slice(-3)
		: [];
	const reasoningEffort = nonEmptyString(record.reasoningEffort);
	return {
		subagentNarratorId:
			typeof record.subagentNarratorId === "string" ? record.subagentNarratorId : null,
		model: nonEmptyString(record.model),
		...(reasoningEffort ? { reasoningEffort } : {}),
		latestToolCalls,
	};
}

export function normalizeSubagentActivityCatchUp(value: unknown): SubagentActivityCatchUp[] {
	if (!Array.isArray(value)) return [];
	const entries: Array<[string, unknown]> = value.flatMap((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		return typeof record.parentToolUseId === "string"
			? [[record.parentToolUseId, record.activity] as [string, unknown]]
			: [];
	});
	return entries.flatMap(([parentToolUseId, rawActivity]) => {
		const activity = normalizeSubagentActivitySummary(rawActivity);
		return activity ? [{ parentToolUseId, activity }] : [];
	});
}

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

/** Identity aliases attached to a COW compact replacement event. */
export interface MessageReplacementAliases {
	oldMessageId?: string;
	replacedMessageId?: string;
	messageId?: string;
	newMessageId?: string;
	replacementMessageId?: string;
}

export function coerceMessageReplacementAliases(
	data: Record<string, unknown>,
): MessageReplacementAliases | undefined {
	const aliases: MessageReplacementAliases = {};
	for (const key of [
		"oldMessageId",
		"replacedMessageId",
		"messageId",
		"newMessageId",
		"replacementMessageId",
	] as const) {
		if (typeof data[key] === "string" && data[key]) aliases[key] = data[key] as string;
	}
	return Object.keys(aliases).length > 0 ? aliases : undefined;
}

export interface CompactProgressEvent extends ProgressSnapshot {
	messageId: string;
	isSegment: boolean;
	mode: "blocking" | "background";
}

export function coerceCompactProgressEvent(
	data: Record<string, unknown>,
): CompactProgressEvent | null {
	if (typeof data.messageId !== "string" || !data.messageId) return null;
	if (typeof data.outputChars !== "number" || !Number.isFinite(data.outputChars)) return null;
	return {
		messageId: data.messageId,
		// Payloads from an older server carry no phase/thinkingChars, which
		// normalizes to the previous output-only behaviour.
		...coerceProgressSnapshot(data),
		isSegment: data.isSegment === true,
		mode: data.mode === "background" ? "background" : "blocking",
	};
}

/** Live progress for a running reflection gate (danger / plan / task / question). */
export interface ReflectionProgressEvent extends ProgressSnapshot, PermissionRoutingFields {
	requestId: string;
	toolUseId: string;
	kind: string;
}

export function coerceReflectionProgressEvent(
	data: Record<string, unknown>,
): ReflectionProgressEvent | null {
	if (typeof data.requestId !== "string" || !data.requestId) return null;
	if (typeof data.toolUseId !== "string" || !data.toolUseId) return null;
	if (typeof data.kind !== "string" || !data.kind) return null;
	return {
		requestId: data.requestId,
		toolUseId: data.toolUseId,
		kind: data.kind,
		...coerceProgressSnapshot(data),
		...coercePermissionRoutingFields(data),
	};
}

export interface SubagentToolEventMeta {
	toolCallId?: string | null;
	toolName?: string | null;
	createdAt?: string | number | null;
	timing?: SubagentToolCallTiming | null;
	subagentNarratorId?: string | null;
	model?: string | null;
	/**
	 * Short whitelisted input keys for the activity row's label, sent on the parent
	 * copy of a child tool event (which withholds the raw `input`). Absent when the
	 * input carried none of the keys — never `{}`, so a later event that omits it
	 * cannot blank a label already shown.
	 */
	inputSummary?: SubagentToolInputSummary | null;
}

export interface PermissionRoutingFields {
	parentToolUseId?: string;
	subagentNarratorId?: string;
	ownerNarratorId?: string;
}

export function coercePermissionRoutingFields(
	data: Record<string, unknown>,
): PermissionRoutingFields {
	return {
		parentToolUseId: typeof data.parentToolUseId === "string" ? data.parentToolUseId : undefined,
		subagentNarratorId:
			typeof data.subagentNarratorId === "string" ? data.subagentNarratorId : undefined,
		ownerNarratorId: typeof data.ownerNarratorId === "string" ? data.ownerNarratorId : undefined,
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
	onDangerReflectionStarted?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			danger?: unknown;
		},
	) => void;
	onDangerReflectionResolved?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
		},
	) => void;
	onDangerReflectionStopped?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			danger?: unknown;
			inputJson?: Record<string, unknown>;
			reason?: string;
		},
	) => void;
	onPlanReflectionStarted?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson?: Record<string, unknown>;
			reason?: string;
		},
	) => void;
	onPlanReflectionResolved?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
		},
	) => void;
	onPlanReflectionStopped?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson?: Record<string, unknown>;
			reason?: string;
		},
	) => void;
	onTaskReflectionStarted?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson?: Record<string, unknown>;
			mutations?: unknown;
			reason?: string;
		},
	) => void;
	onTaskReflectionResolved?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
			nextSteps?: string;
		},
	) => void;
	onTaskReflectionStopped?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson?: Record<string, unknown>;
			mutations?: unknown;
			reason?: string;
		},
	) => void;
	onQuestionReflectionStarted?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			toolName: string;
			inputJson?: Record<string, unknown>;
			reason?: string;
		},
	) => void;
	onQuestionReflectionResolved?: (
		data: PermissionRoutingFields & {
			requestId: string;
			toolUseId: string;
			decision: "allow" | "deny" | "aborted";
			reason?: string;
		},
	) => void;
	onQuestionReflectionDisarmed?: (
		data: PermissionRoutingFields & { requestId: string; toolUseId: string },
	) => void;
	/**
	 * Live progress of a running reflection gate. Fires on a throttled cadence, so
	 * consumers must treat it as render-only state — routing it through a document
	 * rebuild would re-layout the list several times per second.
	 */
	onReflectionProgress?: (data: ReflectionProgressEvent) => void;
	onStatusChange?: (status: string, turnStartedAt?: string, substatus?: string[]) => void;
	onSubstatusChange?: (substatus: string[]) => void;
	onToolStarted?: (
		toolUseId: string,
		toolName: string,
		streamStartedAt?: number,
		input?: Record<string, unknown>,
		parentToolUseId?: string,
		meta?: SubagentToolEventMeta,
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
		meta?: SubagentToolEventMeta,
	) => void;
	onToolCompleted?: (
		toolUseId: string,
		status: string,
		output?: unknown,
		durationMs?: number,
		updatedInput?: Record<string, unknown>,
		metadata?: Record<string, unknown>,
		parentToolUseId?: string,
		meta?: SubagentToolEventMeta,
	) => void;
	/**
	 * The tool passed its permission gate and began executing.
	 *
	 * The signal that lets a live card stop guessing: `onToolStarted` only means the
	 * input finished parsing, so anything painted from it alone claims work has begun
	 * while the narrator may still be waiting on a human approval.
	 */
	onToolExecuting?: (
		toolUseId: string,
		executionStartedAt: number,
		parentToolUseId?: string,
	) => void;
	onToolLongRunning?: (toolUseId: string, elapsed: number, parentToolUseId?: string) => void;
	onTimeoutUpdated?: (toolUseId: string, timeoutMs: number) => void;
	onToolOutput?: (toolUseId: string, output: string, parentToolUseId?: string) => void;
	/**
	 * A determinate "N of M done" measurement from a running tool (TransferFile),
	 * rendered as an actual progress bar rather than parsed out of its text output.
	 */
	onToolStructuredProgress?: (
		toolUseId: string,
		progress: ToolProgressPayload,
		parentToolUseId?: string,
	) => void;
	/**
	 * A running Await-agent call learned which child narrator it is waiting on.
	 * Lets the card offer "open session" before the wait returns (the id is not in
	 * the persisted row until then).
	 */
	onAwaitAgentResolved?: (
		toolUseId: string,
		subagentNarratorId: string,
		parentToolUseId?: string,
	) => void;
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
		revision: number;
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
	onCompactProgress?: (progress: CompactProgressEvent) => void;
	onCompactDone?: (
		contextPercentAfter?: number,
		isSegment?: boolean,
		mode?: "blocking" | "background",
		replacement?: MessageReplacementAliases,
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
	/**
	 * Individual worktree paths changed, so a file tree can patch the affected
	 * directories instead of refetching.
	 *
	 * Paths are worktree-RELATIVE. Only delivered while the server's native watcher is
	 * running (it is opt-in); the default polling fallback observes no paths, so a
	 * consumer must treat this as an accelerator over its own on-demand fetching.
	 *
	 * `truncated` means the batch hit the watcher's cap and `changes` is a sample
	 * rather than the whole set — invalidate broadly instead of applying it literally.
	 */
	onWorkspacePathsChanged?: (data: {
		chapterId: string;
		changes: { path: string; kind: "added" | "updated" | "deleted" }[];
		truncated: boolean;
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
	/** The narrator is suspended waiting for a NUG model to recover (credential pool exhausted). */
	onModelUnavailableWaiting?: (info: {
		message: string;
		model: string;
		providerId?: string;
		providerPrefix?: string;
		nugModelId?: string;
	}) => void;
	/** A suspended narrator's NUG model recovered; it is resuming. */
	onModelUnavailableRecovered?: (info: { model: string; nugModelId?: string }) => void;
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
	onNarratorError?: (
		error: string,
		errorCode?: string,
		diagnostics?: Record<string, unknown>,
	) => void;
	onNarratorWarning?: (info: {
		message: string;
		retryCount?: number;
		maxRetries?: number;
		delayMs?: number;
		/** Structured cause of the retry. The server always sends this; dropping it
		 *  here is what forced retry toasts to show raw English provider text. */
		diagnostics?: Record<string, unknown>;
	}) => void;
	onLeakedToolCall?: (info: {
		phase: "stream_captured" | "recovered" | "unrecovered";
		apiRequestId: string;
		toolUseIds?: string[];
		toolNames?: string[];
		snippet?: string;
	}) => void;
	onModelChanged?: (model: string) => void;
	/** Return true when a structural reconcile is pending; messageVersion stays deferred until it succeeds. */
	onCatchUp?: (
		orphanChildren: TreeMessage[],
		topLevel: TreeMessage[],
		subagentActivities: SubagentActivityCatchUp[],
	) => boolean | undefined;
	onFullReload?: () => void;
	onSyncOk?: () => void;
	/**
	 * The server refused this subscription: the narrator is not shared with this
	 * user, or does not exist (deliberately the same answer). Without handling it the
	 * UI would wait for events that will never arrive.
	 */
	onSubscribeDenied?: () => void;
	/** Sharing settings changed; anything showing access state should re-read it. */
	onAccessChanged?: (reason: string) => void;
	onCommitsUpdated?: (chapterId: string, newCount: number) => void;
	onCommitSyncError?: (event: CommitSyncErrorEvent) => void;
	onBackgroundTaskStarted?: (
		taskNarratorId: string,
		toolUseId: string,
		subagentType: string,
	) => void;
	onSubagentStarted?: (
		toolUseId: string,
		model?: string,
		subagentNarratorId?: string,
		reasoningEffort?: string,
	) => void;
	onSubagentSuspended?: (subagentNarratorId: string, toolUseId: string) => void;
	onSubagentStatusChanged?: (
		subagentNarratorId: string,
		status: string,
		substatus?: string[],
	) => void;
	/**
	 * The user took over (or released) a subagent, so the parent's waiting CARD is
	 * blocked on a person. Separate from `onSubagentStatusChanged`, which serves the
	 * panel's status chip and is excluded from the message subscription.
	 *
	 * `toolUseId` is best-effort; without it the consumer matches the card by
	 * `subagentNarratorId`.
	 */
	onSubagentTakeoverChanged?: (info: {
		subagentNarratorId: string;
		toolUseId?: string;
		takenOver: boolean;
	}) => void;
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
		completedAt?: string | number,
		durationMs?: number,
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
	/**
	 * Incremental background-task list update. This is what replaced the list's
	 * polling, so a surface that shows tasks must handle it (or refetch) rather
	 * than relying on a timer.
	 */
	onBackgroundTaskListDelta?: (delta: BackgroundTaskListDelta, narratorId: string) => void;
	onMessagesDeleted?: (
		deletedMessageIds: string[],
		replacement?: MessageReplacementAliases,
	) => void;
	onMessageUpdated?: (message: TreeMessage, replacement?: MessageReplacementAliases) => void;
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
			/** The INPUT finished parsing — NOT "executing" (see `executing`). */
			started?: boolean;
			/** Permission granted and execution under way. */
			executing?: boolean;
			input?: unknown;
			streamStartedAt?: number;
			streamingOutput?: string;
			/** Latest determinate progress, so a reconnect paints the bar immediately. */
			structuredProgress?: ToolProgressPayload;
			toolCallId?: string | null;
			createdAt?: string | number | null;
			timing?: SubagentToolCallTiming | null;
			subagentNarratorId?: string | null;
			model?: string | null;
			/** Row label for a subagent chunk, which carries no `input`. */
			inputSummary?: SubagentToolInputSummary | null;
		}>;
	}) => void;
	onBrowserSessionCount?: (count: number) => void;
	onBrowserSessionVisualChange?: (sessionId: string) => void;
	/** A reasoning-only dead turn was discarded — drop any live streaming blocks. */
	onStreamingReset?: (parentToolUseId?: string) => void;
	/**
	 * Live tool cards whose attempt was abandoned and replayed. They never
	 * persisted, so nothing else will retire them — drop them or they stay
	 * "running" forever with a live elapsed timer.
	 */
	onToolUseDiscarded?: (toolUseIds: string[], parentToolUseId?: string) => void;
}

export function useNarratorWS(
	narratorId: string | undefined,
	callbacks: NarratorWSCallbacks,
	initialMessageSnapshot?: NarratorMessageSnapshot,
	options?: {
		kind?: NarratorSubscriptionKind;
		excludeTypes?: readonly string[];
	},
) {
	const callbacksOwnerRef = useRef({ narratorId, generation: 0, callbacks });
	if (callbacksOwnerRef.current.narratorId !== narratorId) {
		callbacksOwnerRef.current = {
			narratorId,
			generation: callbacksOwnerRef.current.generation + 1,
			callbacks,
		};
	} else {
		callbacksOwnerRef.current.callbacks = callbacks;
	}
	const subscriptionKind = options?.kind ?? "messages";
	const initialMessageSnapshotRef = useRef<{
		narratorId: string | undefined;
		snapshot: NarratorMessageSnapshot | undefined;
	}>({ narratorId, snapshot: initialMessageSnapshot });
	if (initialMessageSnapshotRef.current.narratorId !== narratorId) {
		// Reset synchronously so the first subscription frame for a new narrator can
		// never inherit either half of the previous narrator's snapshot coordinate.
		initialMessageSnapshotRef.current = { narratorId, snapshot: initialMessageSnapshot };
	} else if (initialMessageSnapshot !== undefined) {
		initialMessageSnapshotRef.current.snapshot = initialMessageSnapshot;
	}
	useEffect(() => {
		if (narratorId && initialMessageSnapshot?.cursor !== undefined) {
			// Tail content commonly arrives after the subscription effect. Seed the
			// manager for reconnect/sync frames without restarting the subscription.
			narratorWSManager.seedCatchUpCursor(narratorId, initialMessageSnapshot.cursor);
		}
	}, [initialMessageSnapshot, narratorId]);

	const [connected, setConnected] = useState(narratorWSManager.connected);
	const [disconnected, setDisconnected] = useState(narratorWSManager.disconnected);

	useEffect(() => {
		if (!narratorId) return;

		const subscribedId = narratorId;
		const callbackOwner = callbacksOwnerRef.current;

		const initialSnapshot =
			initialMessageSnapshotRef.current.narratorId === subscribedId
				? initialMessageSnapshotRef.current.snapshot
				: undefined;
		const subHandle: SubscriptionHandle = narratorWSManager.subscribe([subscribedId], {
			catchUpCursor: initialSnapshot?.cursor,
			initialMessageSnapshot: initialSnapshot,
			kind: subscriptionKind,
		});

		// Join presence
		narratorWSManager.joinPresence(subscribedId, subHandle._id);

		// Register message listener
		const listenerHandle: ListenerHandle = narratorWSManager.addListener(
			{
				narratorIds: [subscribedId],
				subscriptionId: subHandle._id,
				...(options?.excludeTypes ? { excludeTypes: options.excludeTypes } : {}),
			},
			(data) => {
				// A narrator can change during render before React runs the previous effect cleanup.
				// Drop that old listener immediately instead of letting it read the new callbacks.
				if (
					callbacksOwnerRef.current.narratorId !== subscribedId ||
					callbacksOwnerRef.current.generation !== callbackOwner.generation
				)
					return;
				// Guard: discard messages targeting a different narrator
				if (data.narratorId && data.narratorId !== subscribedId) return;
				switch (data.type) {
					case "message":
						callbackOwner.callbacks.onMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							narratorWSManager.noteMessage(subscribedId, data.message as TreeMessage);
						}
						break;
					case "user_message":
						callbackOwner.callbacks.onUserMessage?.(
							data as { message?: TreeMessage; [key: string]: unknown },
						);
						if ((data.message as TreeMessage | undefined)?.id) {
							narratorWSManager.noteMessage(subscribedId, data.message as TreeMessage);
						}
						break;
					case "stream_event":
						callbackOwner.callbacks.onStreamEvent?.(data);
						break;
					case "permission_request":
						if (data.request) {
							callbackOwner.callbacks.onPermissionRequest?.(data.request as PendingPermission);
						}
						break;
					case "permission_resolved":
						callbackOwner.callbacks.onPermissionResolved?.(
							data.requestId as string,
							data.toolUseId as string | undefined,
							data.updatedInput as Record<string, unknown> | undefined,
							data.decision as "allow" | "deny" | undefined,
							data.feedbackText as string | undefined,
							data.subagentNarratorId as string | undefined,
						);
						break;
					case "danger_reflection_started":
						callbackOwner.callbacks.onDangerReflectionStarted?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							danger: data.danger,
						});
						break;
					case "danger_reflection_resolved":
						callbackOwner.callbacks.onDangerReflectionResolved?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "danger_reflection_stopped":
						callbackOwner.callbacks.onDangerReflectionStopped?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							danger: data.danger,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_started":
						callbackOwner.callbacks.onPlanReflectionStarted?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_resolved":
						callbackOwner.callbacks.onPlanReflectionResolved?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "plan_reflection_stopped":
						callbackOwner.callbacks.onPlanReflectionStopped?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "task_reflection_started":
						callbackOwner.callbacks.onTaskReflectionStarted?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							mutations: data.mutations,
							reason: data.reason as string | undefined,
						});
						break;
					case "task_reflection_resolved":
						callbackOwner.callbacks.onTaskReflectionResolved?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
							nextSteps: data.nextSteps as string | undefined,
						});
						break;
					case "task_reflection_stopped":
						callbackOwner.callbacks.onTaskReflectionStopped?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							mutations: data.mutations,
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_started":
						callbackOwner.callbacks.onQuestionReflectionStarted?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							toolName: data.toolName as string,
							inputJson: data.inputJson as Record<string, unknown> | undefined,
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_resolved":
						callbackOwner.callbacks.onQuestionReflectionResolved?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
							decision: data.decision as "allow" | "deny" | "aborted",
							reason: data.reason as string | undefined,
						});
						break;
					case "question_reflection_disarmed":
						callbackOwner.callbacks.onQuestionReflectionDisarmed?.({
							...coercePermissionRoutingFields(data),
							requestId: data.requestId as string,
							toolUseId: data.toolUseId as string,
						});
						break;
					case "reflection_progress": {
						const progress = coerceReflectionProgressEvent(data);
						if (progress) callbackOwner.callbacks.onReflectionProgress?.(progress);
						break;
					}
					case "status_change":
						callbackOwner.callbacks.onStatusChange?.(
							data.status as string,
							data.turnStartedAt as string | undefined,
							data.substatus as string[] | undefined,
						);
						break;
					case "substatus_change":
						callbackOwner.callbacks.onSubstatusChange?.(data.substatus as string[]);
						break;
					case "tool_started":
						callbackOwner.callbacks.onToolStarted?.(
							data.toolUseId as string,
							data.toolName as string,
							data.streamStartedAt as number | undefined,
							data.input as Record<string, unknown> | undefined,
							data.parentToolUseId as string | undefined,
							subagentToolEventMeta(data),
						);
						break;
					case "tool_use_chunk":
						callbackOwner.callbacks.onToolUseChunk?.(
							data.toolUseId as string,
							data.toolName as string,
							data.inputCharsTotal as number,
							data.parentToolUseId as string | undefined,
							data.extractedFilePath as string | undefined,
							data.contentCharsReceived as number | undefined,
							data.extractedFields as Record<string, string> | undefined,
							data.metadata as Record<string, unknown> | undefined,
							data.streamingField as { name: string; delta: string } | undefined,
							subagentToolEventMeta(data),
						);
						break;
					case "tool_completed":
						callbackOwner.callbacks.onToolCompleted?.(
							data.toolUseId as string,
							data.status as string,
							data.output,
							data.durationMs as number | undefined,
							data.updatedInput as Record<string, unknown> | undefined,
							data.metadata as Record<string, unknown> | undefined,
							data.parentToolUseId as string | undefined,
							subagentToolEventMeta(data),
						);
						break;
					case "tool_executing":
						callbackOwner.callbacks.onToolExecuting?.(
							data.toolUseId as string,
							data.executionStartedAt as number,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "tool_long_running":
						callbackOwner.callbacks.onToolLongRunning?.(
							data.toolUseId as string,
							data.elapsed as number,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "timeout_updated":
						callbackOwner.callbacks.onTimeoutUpdated?.(
							data.toolUseId as string,
							data.timeoutMs as number,
						);
						break;
					case "tool_output":
						callbackOwner.callbacks.onToolOutput?.(
							data.toolUseId as string,
							data.output as string,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "tool_structured_progress": {
						// Validated rather than cast: a malformed frame must degrade to a
						// barless card, not to a bar reading `NaN%`.
						const progress = readToolProgressPayload(data.progress);
						if (progress) {
							callbackOwner.callbacks.onToolStructuredProgress?.(
								data.toolUseId as string,
								progress,
								data.parentToolUseId as string | undefined,
							);
						}
						break;
					}
					case "await_agent_resolved":
						callbackOwner.callbacks.onAwaitAgentResolved?.(
							data.toolUseId as string,
							data.subagentNarratorId as string,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "title_updated":
						callbackOwner.callbacks.onTitleUpdated?.(data.title as string);
						break;
					case "buffer_set":
						callbackOwner.callbacks.onBufferSet?.(data.messages as BufferMessageSummary[]);
						break;
					case "buffer_consumed":
						callbackOwner.callbacks.onBufferConsumed?.(
							data.messageId as string,
							data.remaining as BufferMessageSummary[],
						);
						break;
					case "queued_new_narrator_created":
						callbackOwner.callbacks.onQueuedNewNarratorCreated?.(
							data.messageId as string,
							data.newNarratorId as string,
						);
						break;
					case "buffer_cleared":
						callbackOwner.callbacks.onBufferCleared?.(
							data.reason as "cancelled" | "sent" | "narrator_error",
						);
						break;
					case "buffer_preserved":
						callbackOwner.callbacks.onBufferPreserved?.(data.messages as BufferMessageSummary[]);
						break;
					case "permission_mode_changed":
						callbackOwner.callbacks.onPermissionModeChanged?.(data.permissionMode as string);
						break;
					case "plan_mode_changed":
						callbackOwner.callbacks.onPlanModeChanged?.(
							data.planMode as boolean,
							Array.isArray(data.traits) ? (data.traits as string[]) : undefined,
						);
						break;
					case "custom_traits_changed":
						callbackOwner.callbacks.onCustomTraitsChanged?.(
							Array.isArray(data.traits) ? (data.traits as string[]) : undefined,
						);
						break;
					case "draft_changed":
						callbackOwner.callbacks.onDraftChanged?.({
							hasDraft: !!data.hasDraft,
							text: typeof data.text === "string" ? data.text : "",
							revision: typeof data.revision === "number" ? data.revision : 0,
							updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
							updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : null,
							sourceId: typeof data.sourceId === "string" ? data.sourceId : null,
						});
						break;
					case "relaxed_plan_changed":
						callbackOwner.callbacks.onRelaxedPlanChanged?.(data.relaxedPlan as boolean);
						break;
					case "reflection_overrides_changed":
						callbackOwner.callbacks.onReflectionOverridesChanged?.({
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
						callbackOwner.callbacks.onCompacting?.(
							data.mode === "background" ? "background" : "blocking",
						);
						break;
					case "compact_progress": {
						const progress = coerceCompactProgressEvent(data);
						if (progress) callbackOwner.callbacks.onCompactProgress?.(progress);
						break;
					}
					case "compact_done":
					case "compact_failed":
						callbackOwner.callbacks.onCompactDone?.(
							data.contextPercentAfter as number | undefined,
							data.isSegment as boolean | undefined,
							data.mode === "background" ? "background" : "blocking",
							coerceMessageReplacementAliases(data),
						);
						break;
					case "segment_compact_hide":
						if (data.hiddenMessageIds) {
							callbackOwner.callbacks.onSegmentCompactHide?.(data.hiddenMessageIds as string[]);
						}
						break;
					case "context_usage":
						if (!data.isSubagent) {
							callbackOwner.callbacks.onContextUsage?.(
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
						callbackOwner.callbacks.onPruneBoundary?.(
							(data.boundaryMessageId as string) ?? null,
							(data.prunedPercent as number) ?? null,
						);
						break;
					case "git_status":
						if (data.chapterId) {
							callbackOwner.callbacks.onGitStatus?.({
								chapterId: data.chapterId as string,
								commitsAhead: (data.commitsAhead as number) ?? 0,
								baseBranch: (data.baseBranch as string) ?? "",
								linesAdded: (data.linesAdded as number) ?? 0,
								linesRemoved: (data.linesRemoved as number) ?? 0,
							});
						}
						break;
					case "workspace_paths_changed": {
						// An empty `changes` with `truncated` set is meaningful (everything is
						// suspect), so the array's emptiness is not a reason to skip the callback.
						const rawChanges = Array.isArray(data.changes) ? data.changes : [];
						const changes = rawChanges.flatMap((entry) => {
							const item = entry as { path?: unknown; kind?: unknown };
							if (typeof item.path !== "string" || !item.path) return [];
							const kind = item.kind === "added" || item.kind === "deleted" ? item.kind : "updated";
							return [{ path: item.path, kind } as const];
						});
						callbackOwner.callbacks.onWorkspacePathsChanged?.({
							chapterId: (data.chapterId as string) ?? "",
							changes,
							truncated: data.truncated === true,
						});
						break;
					}
					case "metering":
						if (!data.isSubagent) {
							callbackOwner.callbacks.onMetering?.(
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
						callbackOwner.callbacks.onQuotaBalance?.(
							quotaBalance == null ? null : String(quotaBalance),
							detailedText?.trim() ? detailedText : null,
						);
						break;
					}
					case "payment_required":
						callbackOwner.callbacks.onPaymentRequired?.({
							providerId: data.providerId as string | undefined,
							providerPrefix: data.providerPrefix as string | undefined,
							balance: data.balance as number | undefined,
							required: data.required as number | undefined,
							resumeAction: (data.resumeAction as "retry" | "continue") ?? "retry",
						});
						break;
					case "model_unavailable_waiting":
						callbackOwner.callbacks.onModelUnavailableWaiting?.({
							message: data.message as string,
							model: data.model as string,
							providerId: data.providerId as string | undefined,
							providerPrefix: data.providerPrefix as string | undefined,
							nugModelId: data.nugModelId as string | undefined,
						});
						break;
					case "model_unavailable_recovered":
						callbackOwner.callbacks.onModelUnavailableRecovered?.({
							model: data.model as string,
							nugModelId: data.nugModelId as string | undefined,
						});
						break;
					case "queue_status":
						callbackOwner.callbacks.onQueueStatus?.(
							data.position as number | undefined,
							data.queueDepth as number | undefined,
							data.queueMessage as string | undefined,
						);
						break;
					case "web_search":
						callbackOwner.callbacks.onWebSearch?.(
							data.id as string,
							data.status as "in_progress" | "searching" | "completed",
							data.query as string | undefined,
							data.queries as string[] | undefined,
							data.outputIndex as number | undefined,
							data.parentToolUseId as string | undefined,
						);
						break;
					case "image_generation":
						callbackOwner.callbacks.onImageGeneration?.(
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
						callbackOwner.callbacks.onNarratorError?.(
							eventDiagnosticMessage(data),
							data.errorCode as string | undefined,
							data.diagnostics &&
								typeof data.diagnostics === "object" &&
								!Array.isArray(data.diagnostics)
								? (data.diagnostics as Record<string, unknown>)
								: undefined,
						);
						break;
					case "warning":
						callbackOwner.callbacks.onNarratorWarning?.({
							message: data.message as string,
							retryCount: data.retryCount as number | undefined,
							maxRetries: data.maxRetries as number | undefined,
							delayMs: data.delayMs as number | undefined,
							diagnostics:
								data.diagnostics &&
								typeof data.diagnostics === "object" &&
								!Array.isArray(data.diagnostics)
									? (data.diagnostics as Record<string, unknown>)
									: undefined,
						});
						break;
					case "leaked_tool_call_notice":
						callbackOwner.callbacks.onLeakedToolCall?.({
							phase: data.phase as "stream_captured" | "recovered" | "unrecovered",
							apiRequestId: data.apiRequestId as string,
							toolUseIds: data.toolUseIds as string[] | undefined,
							toolNames: data.toolNames as string[] | undefined,
							snippet: data.snippet as string | undefined,
						});
						break;
					case "model_changed":
						if (data.model) {
							callbackOwner.callbacks.onModelChanged?.(data.model as string);
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
						const subagentActivities = normalizeSubagentActivityCatchUp(data.subagentActivities);
						const deferCommit =
							callbackOwner.callbacks.onCatchUp?.(orphanChildren, topLevel, subagentActivities) ===
							true;
						const cursor = data.cursor as CatchUpCursor | undefined;
						const messageVersion =
							typeof data.messageVersion === "number" ? (data.messageVersion as number) : undefined;

						const coordinate = {
							cursor,
							messageVersion,
							realtimeEpoch: narratorWSManager.getRealtimeEpoch(subscribedId),
						};
						if (deferCommit || narratorWSManager.isMessageReconcilePending(subscribedId)) {
							// Structural catch-up coordinates form one transaction with the chunk
							// manifest. Keep every sync token staged until that authoritative manifest
							// succeeds, otherwise a retry could skip the very messages being reconciled.
							narratorWSManager.stageCatchUpState(subscribedId, coordinate);
						} else {
							// Publish cursor + version as one coordinate; separate updates could
							// expose a version from one snapshot with a cursor from another.
							narratorWSManager.updateCatchUpCoordinate(subscribedId, coordinate);
						}
						break;
					}
					case "full_reload": {
						narratorWSManager.clearCatchUpState(subscribedId);
						callbackOwner.callbacks.onFullReload?.();
						break;
					}
					case "subscribe_denied":
						// Stop waiting: no snapshot or catch-up is coming for this narrator.
						narratorWSManager.clearCatchUpState(subscribedId);
						callbackOwner.callbacks.onSubscribeDenied?.();
						break;
					case "narrator_access_changed":
						callbackOwner.callbacks.onAccessChanged?.(
							typeof data.reason === "string" ? data.reason : "unknown",
						);
						break;
					case "sync_ok":
						// While a manifest reconcile is open, stage the authoritative version
						// instead of publishing it over a separately staged realtime cursor.
						if (typeof data.version === "number") {
							narratorWSManager.updateMessageVersion(subscribedId, data.version as number, {
								requestId:
									typeof data.subscriptionRequestId === "string"
										? data.subscriptionRequestId
										: undefined,
							});
						}
						callbackOwner.callbacks.onSyncOk?.();
						break;
					case "messages_deleted":
						if (data.deletedMessageIds) {
							callbackOwner.callbacks.onMessagesDeleted?.(
								data.deletedMessageIds as string[],
								coerceMessageReplacementAliases(data),
							);
						}
						break;
					case "message_updated":
						if (data.message) {
							callbackOwner.callbacks.onMessageUpdated?.(
								data.message as TreeMessage,
								coerceMessageReplacementAliases(data),
							);
						}
						break;
					case "commits_updated":
						if (data.chapterId) {
							callbackOwner.callbacks.onCommitsUpdated?.(
								data.chapterId as string,
								(data.newCount as number) ?? 0,
							);
						}
						break;
					case "commit_sync_error": {
						const event = coerceCommitSyncErrorEvent(data);
						if (event) callbackOwner.callbacks.onCommitSyncError?.(event);
						break;
					}
					case "background_task_started":
						callbackOwner.callbacks.onBackgroundTaskStarted?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							data.subagentType as string,
						);
						break;
					case "subagent_started":
						callbackOwner.callbacks.onSubagentStarted?.(
							data.toolUseId as string,
							data.model as string | undefined,
							data.subagentNarratorId as string | undefined,
							data.reasoningEffort as string | undefined,
						);
						break;
					case "subagent_suspended":
						callbackOwner.callbacks.onSubagentSuspended?.(
							data.subagentNarratorId as string,
							data.toolUseId as string,
						);
						break;
					case "subagent_status_changed":
						callbackOwner.callbacks.onSubagentStatusChanged?.(
							data.subagentNarratorId as string,
							data.status as string,
							data.substatus as string[] | undefined,
						);
						break;
					case "subagent_takeover_changed":
						callbackOwner.callbacks.onSubagentTakeoverChanged?.({
							subagentNarratorId: data.subagentNarratorId as string,
							toolUseId: data.toolUseId as string | undefined,
							takenOver: data.takenOver === true,
						});
						break;
					case "subagent_warning":
						callbackOwner.callbacks.onSubagentWarning?.(data.subagentNarratorId as string, {
							message: data.message as string,
							retryCount: data.retryCount as number | undefined,
							maxRetries: data.maxRetries as number | undefined,
							delayMs: data.delayMs as number | undefined,
						});
						break;
					case "subagent_conclusion_updated":
						callbackOwner.callbacks.onSubagentConclusionUpdated?.(
							data.subagentNarratorId as string,
							data.toolUseId as string,
							data.output as string,
							data.hasError as boolean,
							data.completedAt as string | number | undefined,
							data.durationMs as number | undefined,
						);
						break;
					case "background_task_completed":
						callbackOwner.callbacks.onBackgroundTaskCompleted?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							data.resultPreview as string,
						);
						break;
					case "background_task_failed":
						callbackOwner.callbacks.onBackgroundTaskFailed?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
							eventDiagnosticMessage(data),
						);
						break;
					case "background_task_cancelled":
						callbackOwner.callbacks.onBackgroundTaskCancelled?.(
							data.taskNarratorId as string,
							data.toolUseId as string,
						);
						break;
					case "background_task_status_changed":
						callbackOwner.callbacks.onBackgroundTaskStatusChanged?.(
							data.taskId as string,
							data.status as string,
							data.narratorId as string,
						);
						break;
					case "background_task_output":
						callbackOwner.callbacks.onBackgroundTaskOutput?.(
							data.taskId as string,
							data.narratorId as string,
						);
						break;
					case "background_task_list_delta":
						callbackOwner.callbacks.onBackgroundTaskListDelta?.(
							{
								listEpoch: data.listEpoch as string,
								version: data.version as number,
								activeCount: data.activeCount as number,
								upsert: data.upsert as BackgroundTaskListDelta["upsert"],
								removeIds: data.removeIds as string[] | undefined,
								invalidate: data.invalidate as boolean | undefined,
							},
							data.narratorId as string,
						);
						break;
					case "presence_update":
						callbackOwner.callbacks.onPresenceUpdate?.(
							(data.viewers ?? []) as Array<{
								userId: string;
								username: string;
								avatarColor: string | null;
								avatarImageId: string | null;
							}>,
						);
						break;
					case "streaming_snapshot":
						callbackOwner.callbacks.onStreamingSnapshot?.({
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
								/** The INPUT finished parsing — NOT "executing" (see `executing`). */
								started?: boolean;
								/** Permission granted and execution under way. */
								executing?: boolean;
								input?: unknown;
								streamStartedAt?: number;
								streamingOutput?: string;
								structuredProgress?: ToolProgressPayload;
								toolCallId?: string | null;
								createdAt?: string | number | null;
								timing?: SubagentToolCallTiming | null;
								subagentNarratorId?: string | null;
								model?: string | null;
							}>,
						});
						break;
					case "browser_session_count":
						callbackOwner.callbacks.onBrowserSessionCount?.(
							(data.activeBrowserSessions as number) ?? 0,
						);
						break;
					case "browser_session_visual_change":
						callbackOwner.callbacks.onBrowserSessionVisualChange?.(data.sessionId as string);
						break;
					case "streaming_reset":
						callbackOwner.callbacks.onStreamingReset?.(data.parentToolUseId as string | undefined);
						break;
					case "tool_use_discarded":
						callbackOwner.callbacks.onToolUseDiscarded?.(
							(data.toolUseIds ?? []) as string[],
							data.parentToolUseId as string | undefined,
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
	}, [narratorId, options?.excludeTypes, subscriptionKind]);

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
