import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { useNarratorPermissionsCapability } from "../../hooks/usePlatform";
import {
	api,
	type BufferMessageSummary,
	type NarratorGoal,
	type SideCarRecord,
} from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { localizeNarratorError } from "./error-localization";
import {
	clearToolBlockCache,
	findStreamingInsertIndex,
	type StreamingBlock,
} from "./message-segments";
import {
	evictOldestPages,
	findMsgByToolUseIdInTree,
	insertChildIntoCache,
	type MessageIndex,
	mergeFieldsByIndex,
	removeSubagentStreamingChunk,
	updateToolCallByIndex,
	updateToolUseIndex,
	upsertSubagentStreamingChunk,
} from "./message-tree-utils";
import {
	appendSideCarsToLatestAssistant,
	appendStreamingTextPreview,
	buildTopLevelStreamingChunksMsg,
	getStreamingFieldPreview,
	getToolOutputPreview,
	insertTopLevelMessageBySeq,
	isActiveReflectionPermissionLike,
	isReflectionPermissionLike,
	preserveCompleteStreamedOutput,
	preserveLiveSideCars,
	removeStreamingChunksMsg,
	revokeContentBlockPreviewUrls,
} from "./narrator-message-helpers";
import type {
	ContentBlock,
	MessagesPage,
	MessagesQueryData,
	NarratorMsg,
	PendingPermission,
	PermissionCallbacks,
	TodoItem,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";

export interface ViewerInfo {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface RetryInfo {
	message: string;
	retryCount: number;
	maxRetries: number;
	/** Timestamp (ms) when the retry delay expires */
	retryAt: number;
}

export interface PaymentRequiredInfo {
	providerId?: string;
	providerPrefix?: string;
	balance?: number;
	required?: number;
	resumeAction: "retry" | "continue";
}

/** Leaked XML tool-call diagnostic surfaced for the recovered/unrecovered dialog. */
export interface LeakedToolEvent {
	phase: "recovered" | "unrecovered";
	apiRequestId: string;
	toolNames?: string[];
	snippet?: string;
}

function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

function usePageVisibility(): boolean {
	const [visible, setVisible] = useState(isPageVisible);

	useEffect(() => {
		if (typeof document === "undefined") return;
		const handleVisibilityChange = () => setVisible(isPageVisible());
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
	}, []);

	return visible;
}

function numericUsageField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function promptTokensFromTurnUsage(turnUsage: Record<string, unknown>): number | undefined {
	const promptTokens = numericUsageField(turnUsage.prompt_tokens);
	if (promptTokens != null) return promptTokens;
	const inputTokens = numericUsageField(turnUsage.input_tokens);
	if (inputTokens == null) return undefined;
	return (
		inputTokens +
		(numericUsageField(turnUsage.cached_input_tokens) ?? 0) +
		(numericUsageField(turnUsage.cache_creation_input_tokens) ?? 0)
	);
}

interface InitialMessageStatus {
	statusReady?: boolean;
	contextPercent?: number | null;
	turnUsageJson?: NarratorMsg["turnUsageJson"] | null;
	pruneBoundaryMessageId?: string | null;
	prunedPercent?: number | null;
}

export interface UseNarratorPanelWSOptions {
	narratorId: string;
	narratorStatus?: string;
	narratorErrorMessage?: string | null;
	messagesData?: { pages: MessagesPage[] };
	messagesQueryKey: readonly unknown[];
	initialMessageStatus?: InitialMessageStatus;
	/** Disable legacy message-cache / streaming-render updates when chunk mode owns messages. */
	legacyMessageCacheUpdatesEnabled?: boolean;
	/** Ref to isAtBottom state for unread tracking */
	isAtBottomRef: React.RefObject<boolean>;
	scrollToBottom: (instant?: boolean) => void;
	/** Narrator prop for initial todos */
	narratorTodosJson?: TodoItem[] | null;
	narratorTodosToolUseId?: string | null;
	/** Whether this narrator is a subagent — skip mark-read to preserve done/error status for follow-up Send */
	isSubagent?: boolean;
	/** Initial generic gateway/API quota balance from settings cache. */
	initialQuotaBalance?: string | null;
	/** Initial generic gateway/API quota details from settings cache. */
	initialDetailedQuotaBalance?: string | null;
	/** Custom API provider ID for the current narrator model (used to sync quota back to settings cache). */
	customApiProviderId?: string | null;
	/** NUG provider ID for the current narrator model (used to sync quota back to NUG cache). */
	nugProviderId?: string | null;
	/** Generic provider key for resetting runtime quota/payment state when provider changes. */
	quotaProviderKey?: string | null;
	/** Persisted substatus from narrator data — used to seed the reducer on mount so that
	 *  substatus survives page navigation (the WS-only path starts from []). */
	narratorSubstatus?: string[];
	onDraftChanged?: (draft: {
		hasDraft: boolean;
		text: string;
		updatedAt: string | null;
		updatedBy: string | null;
		sourceId: string | null;
	}) => void;
	onQueuedNewNarratorCreated?: (newNarratorId: string) => void;
}

export interface UseNarratorPanelWSReturn {
	// WS connection
	connected: boolean;
	disconnected: boolean;
	reconnect: () => void;
	sendBufferMessage: (narratorId: string, text: string) => boolean;
	cancelBuffer: (narratorId: string) => boolean;
	sendPermissionDecision: (
		requestId: string,
		decision: "allow" | "deny",
		message?: string,
		answers?: Record<string, string>,
		feedbackText?: string,
		compactAfter?: boolean,
		updatedPlan?: string,
	) => void;
	// Streaming
	streamingVersion: number;
	topLevelStreamingChunks: NarratorMsg | null;
	streamingBlocksRef: React.RefObject<StreamingBlock[]>;
	// Permissions
	pendingPermsMap: Map<string, PendingPermission>;
	pendingPermission: PendingPermission | null;
	renderPermCb: PermissionCallbacks;
	// State
	queuedMessages: BufferMessageSummary[];
	setQueuedMessages: React.Dispatch<React.SetStateAction<BufferMessageSummary[]>>;
	substatus: string[];
	contextPercent: number | null;
	setContextPercent: React.Dispatch<React.SetStateAction<number | null>>;
	/**
	 * True when the displayed context usage may be inaccurate because the
	 * conversation history changed locally (compact / clear / delete) without a
	 * fresh server-reported `context_usage`. Cleared on the next real
	 * `context_usage` event.
	 */
	contextStale: boolean;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activePruneStart: number | null;
	activeCompactStart: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	quotaBalance: string | null;
	detailedQuotaBalance: string | null;
	// Browser sessions
	browserSessionCount: number;
	browserVisualChange: { sessionId: string; seq: number } | null;
	// Retry
	retryInfo: RetryInfo | null;
	paymentRequired: PaymentRequiredInfo | null;
	setPaymentRequired: React.Dispatch<React.SetStateAction<PaymentRequiredInfo | null>>;
	leakedToolEvent: LeakedToolEvent | null;
	setLeakedToolEvent: React.Dispatch<React.SetStateAction<LeakedToolEvent | null>>;
	// Todos
	currentTodos: TodoItem[] | null;
	todosToolUseId: string | null;
	// Tool expand
	expandedToolUseId: string | null;
	setExpandedToolUseId: React.Dispatch<React.SetStateAction<string | null>>;
	// Unread
	unreadCount: number;
	setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
	// Viewers
	viewers: ViewerInfo[];
}

/** Max messages to keep in cache while the user is at the bottom. */
const MAX_LIVE_MESSAGES = 200;
const STREAMING_TOOL_OUTPUT_THROTTLE_MIN_CHARS = 12_000;
const STREAMING_TOOL_OUTPUT_THROTTLE_MS = 250;
const CACHE_UPDATE_FALLBACK_MS = 250;

interface ToolOutputPreviewState {
	preview: string;
	lastFlushedPreview: string;
	lastFlushAt: number;
	timer: ReturnType<typeof setTimeout> | null;
}

// --- Reducer for co-updated state ---
// These fields are frequently set together in the same WS callback
// (onStatusChange, onContextUsage, onPruneBoundary, onCompactDone, etc.).
// Merging them into a single useReducer avoids multiple independent re-renders
// per callback since React batches reducer dispatches into one update.

interface StatusState {
	substatus: string[];
	contextPercent: number | null;
	contextStale: boolean;
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activePruneStart: number | null;
	activeCompactStart: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
}

type StatusAction = { type: "patch"; payload: Partial<StatusState> };

function arraysEqual(a: unknown, b: unknown): boolean {
	if (!Array.isArray(a) || !Array.isArray(b)) return false;
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

function statusReducer(state: StatusState, action: StatusAction): StatusState {
	if (action.type === "patch") {
		// Bail out early if nothing actually changed — avoids a re-render.
		const keys = Object.keys(action.payload) as (keyof StatusState)[];
		if (
			keys.every((k) => {
				const sv = state[k];
				const pv = action.payload[k];
				if (Array.isArray(sv) || Array.isArray(pv)) return arraysEqual(sv, pv);
				return sv === pv;
			})
		)
			return state;
		return { ...state, ...action.payload };
	}
	return state;
}

function withoutQueueMessageSubstatus(substatus: string[]): string[] {
	return substatus.filter((s) => !s.startsWith("queue_message:"));
}

function hasActiveCompactSubstatus(substatus: string[]): boolean {
	return substatus.includes("compacting") || substatus.includes("background_compacting");
}

function withoutCompactingSubstatus(substatus: unknown): string[] {
	return Array.isArray(substatus)
		? substatus.filter((s) => s !== "compacting" && s !== "background_compacting")
		: [];
}

function withCompactingSubstatus(substatus: string[], compactSubstatus: string): string[] {
	return [...withoutCompactingSubstatus(substatus), compactSubstatus];
}

function withoutSubstatusTag(substatus: unknown, tag: string): string[] {
	return Array.isArray(substatus) ? substatus.filter((s) => s !== tag) : [];
}

function withQueueSubstatus(
	substatus: string[],
	position?: number,
	queueDepth?: number,
	queueMessage?: string,
): string[] {
	const withoutQueue = substatus.filter(
		(s) =>
			!s.startsWith("queue_position:") &&
			!s.startsWith("queue_depth:") &&
			!s.startsWith("queue_message:"),
	);
	const nextSubstatus = [...withoutQueue];
	const safePosition = typeof position === "number" && Number.isFinite(position) ? position : null;
	if (safePosition != null && safePosition > 0) {
		const safeDepth =
			typeof queueDepth === "number" && Number.isFinite(queueDepth) ? Math.max(0, queueDepth) : 0;
		nextSubstatus.push(`queue_position:${safePosition}`, `queue_depth:${safeDepth}`);
	}
	if (queueMessage) {
		nextSubstatus.push(`queue_message:${encodeURIComponent(queueMessage)}`);
	}
	return nextSubstatus;
}

function applyPendingPermissionsToCache(
	old: MessagesQueryData | undefined,
	perms: PendingPermission[],
	index: MessageIndex,
): MessagesQueryData | undefined {
	if (!old?.pages?.length || perms.length === 0) return old;
	let result = old as MessagesQueryData | undefined;
	for (const perm of perms) {
		if (
			!perm.toolUseId ||
			!result ||
			(isReflectionPermissionLike(perm) && !isActiveReflectionPermissionLike(perm))
		) {
			continue;
		}
		result = mergeFieldsByIndex(result, perm.toolUseId, { status: "pending" }, index) as
			| MessagesQueryData
			| undefined;
	}
	return result;
}

export function useNarratorPanelWS(opts: UseNarratorPanelWSOptions): UseNarratorPanelWSReturn {
	const {
		narratorId,
		narratorStatus,
		narratorErrorMessage,
		messagesData,
		messagesQueryKey,
		initialMessageStatus,
		legacyMessageCacheUpdatesEnabled = true,
		isAtBottomRef,
		scrollToBottom,
		narratorTodosJson,
		narratorTodosToolUseId,
		isSubagent,
		initialQuotaBalance,
		initialDetailedQuotaBalance,
		customApiProviderId,
		nugProviderId,
		quotaProviderKey,
		narratorSubstatus,
		onDraftChanged,
		onQueuedNewNarratorCreated,
	} = opts;
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const narratorPermissionsCapability = useNarratorPermissionsCapability();
	const permissionDecisionsSupported =
		narratorPermissionsCapability.supported && narratorPermissionsCapability.approveDeny;
	const updatedPermissionInputSupported =
		narratorPermissionsCapability.supported && narratorPermissionsCapability.updatedInput;
	const pageVisible = usePageVisibility();

	// --- Streaming state ---
	const [streamingVersion, setStreamingVersion] = useState(0);
	const [topLevelChunksVersion, bumpTopLevelStreamingChunksVersion] = useState(0);

	// Ordered streaming blocks — preserves temporal order of reasoning, web_search, and text
	// blocks as events arrive, so the UI renders them in the correct sequence instead of
	// grouping all reasoning before all search.
	const streamingBlocksRef = useRef<StreamingBlock[]>([]);

	// RAF-based throttle: coalesce rapid streaming updates into one render per frame
	const streamingRafRef = useRef(0);
	const flushStreamingVersion = useCallback(() => {
		if (!legacyMessageCacheUpdatesEnabled) return;
		if (!streamingRafRef.current) {
			streamingRafRef.current = requestAnimationFrame(() => {
				streamingRafRef.current = 0;
				setStreamingVersion((v) => v + 1);
			});
		}
	}, [legacyMessageCacheUpdatesEnabled]);

	// RAF-based throttle for tool_use_chunk cache updates
	const pendingToolChunkRef = useRef<
		Map<
			string,
			{
				toolUseId: string;
				toolName: string;
				inputCharsTotal: number;
				parentToolUseId?: string;
				extractedFilePath?: string;
				contentCharsReceived?: number;
				extractedFields?: Record<string, string>;
				metadata?: Record<string, unknown>;
			}
		>
	>(new Map());
	const topLevelStreamingChunkRef = useRef<
		Map<
			string,
			{
				toolUseId: string;
				toolName: string;
				inputCharsTotal: number;
				extractedFilePath?: string;
				contentCharsReceived?: number;
				extractedFields?: Record<string, string>;
				metadata?: Record<string, unknown>;
				streamingFieldName?: string;
				streamingFieldValue?: string;
			}
		>
	>(new Map());
	const topLevelStreamingCreatedAtRef = useRef<string | null>(null);
	/** Accumulated streaming field value per tool (persists across RAF frames) */
	const toolStreamingFieldRef = useRef<Map<string, { name: string; value: string }>>(new Map());
	const toolChunkRafRef = useRef(0);
	const toolOutputPreviewRef = useRef<Map<string, ToolOutputPreviewState>>(new Map());

	// Cancel pending RAF handles and clear module-level streaming caches on unmount.
	useEffect(() => {
		return () => {
			if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current);
			if (toolChunkRafRef.current) cancelAnimationFrame(toolChunkRafRef.current);
			if (cacheUpdateRafRef.current) cancelAnimationFrame(cacheUpdateRafRef.current);
			if (cacheUpdateTimeoutRef.current) clearTimeout(cacheUpdateTimeoutRef.current);
			streamingBlocksRef.current = [];
			pendingToolChunkRef.current.clear();
			toolStreamingFieldRef.current.clear();
			for (const state of toolOutputPreviewRef.current.values()) {
				if (state.timer) clearTimeout(state.timer);
			}
			toolOutputPreviewRef.current.clear();
			clearToolBlockCache();
		};
	}, []);

	// Helper: immediately flush streaming version (for clear/reset paths)
	const clearStreamingState = useCallback(() => {
		if (streamingRafRef.current) {
			cancelAnimationFrame(streamingRafRef.current);
			streamingRafRef.current = 0;
		}
		clearToolBlockCache();
		if (legacyMessageCacheUpdatesEnabled) {
			setStreamingVersion((v) => v + 1);
		}
	}, [legacyMessageCacheUpdatesEnabled]);
	const bumpLegacyTopLevelStreamingChunksVersion = useCallback(() => {
		if (legacyMessageCacheUpdatesEnabled) {
			bumpTopLevelStreamingChunksVersion((v) => v + 1);
		}
	}, [legacyMessageCacheUpdatesEnabled]);

	// Helper: cancel any pending tool chunk RAF and clear temporary streaming tool state.
	// Only clears top-level chunks by default — subagent pending chunks (those with
	// parentToolUseId) are preserved so concurrent subagents don't lose their streaming
	// state when the parent narrator's assistant message arrives or another subagent
	// completes. Pass includeSubagent=true for terminal cleanup (status change, error).
	const cancelPendingToolChunks = useCallback(
		(notify = true, includeSubagent = false) => {
			if (includeSubagent) {
				pendingToolChunkRef.current.clear();
				toolStreamingFieldRef.current.clear();
				for (const state of toolOutputPreviewRef.current.values()) {
					if (state.timer) clearTimeout(state.timer);
				}
				toolOutputPreviewRef.current.clear();
			} else {
				// Only remove top-level entries; keep subagent chunks intact.
				// NOTE: Deleting during Map iteration is safe per ES2015 spec §23.1.3.5.
				for (const [key, chunk] of pendingToolChunkRef.current) {
					if (!chunk.parentToolUseId) {
						pendingToolChunkRef.current.delete(key);
						toolStreamingFieldRef.current.delete(key);
					}
				}
			}
			const hadTopLevelChunks = topLevelStreamingChunkRef.current.size > 0;
			topLevelStreamingChunkRef.current.clear();
			topLevelStreamingCreatedAtRef.current = null;
			// Only cancel the RAF if no subagent chunks remain to be flushed.
			// When subagent chunks survive, the next RAF tick will consume them
			// normally (the RAF callback calls pending.clear() after processing).
			if (toolChunkRafRef.current && pendingToolChunkRef.current.size === 0) {
				cancelAnimationFrame(toolChunkRafRef.current);
				toolChunkRafRef.current = 0;
			}
			if (notify && hadTopLevelChunks) {
				bumpLegacyTopLevelStreamingChunksVersion();
			}
		},
		[bumpLegacyTopLevelStreamingChunksVersion],
	);

	// --- RAF-batched cache update queue for messagesQueryKey ---
	// Instead of calling qc.setQueryData(messagesQueryKey, fn) on every WS event,
	// we queue updater functions and flush them all in a single setQueryData call
	// per animation frame. This collapses N WS events into 1 React Query cache
	// update + 1 re-render.
	type CacheUpdater = (
		old: MessagesQueryData | undefined,
	) => MessagesQueryData | undefined | { pages: unknown[]; pageParams?: unknown[] };
	const pendingCacheUpdatesRef = useRef<CacheUpdater[]>([]);
	const cacheUpdateRafRef = useRef(0);
	const cacheUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Flush all pending cache updaters synchronously in a single setQueryData call.
	const flushCacheUpdatesSync = useCallback(() => {
		if (cacheUpdateRafRef.current) {
			cancelAnimationFrame(cacheUpdateRafRef.current);
			cacheUpdateRafRef.current = 0;
		}
		if (cacheUpdateTimeoutRef.current) {
			clearTimeout(cacheUpdateTimeoutRef.current);
			cacheUpdateTimeoutRef.current = null;
		}
		const fns = pendingCacheUpdatesRef.current;
		if (fns.length === 0) return;
		pendingCacheUpdatesRef.current = [];
		if (!legacyMessageCacheUpdatesEnabled) return;
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			let result: MessagesQueryData | undefined | { pages: unknown[]; pageParams?: unknown[] } =
				old;
			for (const updater of fns) {
				result = updater(result as MessagesQueryData | undefined);
			}
			return result;
		});
	}, [legacyMessageCacheUpdatesEnabled, qc, messagesQueryKey]);
	const scheduleCacheUpdate = useCallback(
		(fn: CacheUpdater) => {
			if (!legacyMessageCacheUpdatesEnabled) return;
			pendingCacheUpdatesRef.current.push(fn);
			if (pageVisible && !cacheUpdateRafRef.current) {
				cacheUpdateRafRef.current = requestAnimationFrame(() => {
					cacheUpdateRafRef.current = 0;
					flushCacheUpdatesSync();
				});
			}
			if (!cacheUpdateTimeoutRef.current) {
				cacheUpdateTimeoutRef.current = setTimeout(() => {
					cacheUpdateTimeoutRef.current = null;
					flushCacheUpdatesSync();
				}, CACHE_UPDATE_FALLBACK_MS);
			}
		},
		[flushCacheUpdatesSync, legacyMessageCacheUpdatesEnabled, pageVisible],
	);

	const flushToolOutputPreview = useCallback(
		(toolUseId: string, preview: string) => {
			const state = toolOutputPreviewRef.current.get(toolUseId);
			if (state) {
				if (preview === state.lastFlushedPreview) return;
				state.lastFlushedPreview = preview;
				state.lastFlushAt = Date.now();
			}
			scheduleCacheUpdate((old) => {
				if (!old?.pages?.length) return old;
				return mergeFieldsByIndex(
					old,
					toolUseId,
					{ _streamingOutput: preview },
					toolUseIndexRef.current,
				);
			});
		},
		[scheduleCacheUpdate],
	);

	const clearToolOutputPreviewState = useCallback((toolUseId: string) => {
		const state = toolOutputPreviewRef.current.get(toolUseId);
		if (state?.timer) clearTimeout(state.timer);
		toolOutputPreviewRef.current.delete(toolUseId);
	}, []);

	// --- Permission state ---
	const [pendingPermsMap, setPendingPermsMap] = useState<Map<string, PendingPermission>>(
		() => new Map(),
	);
	const pendingPermission = useMemo<PendingPermission | null>(() => {
		if (pendingPermsMap.size === 0) return null;
		return pendingPermsMap.values().next().value ?? null;
	}, [pendingPermsMap]);

	// --- Misc state (co-updated fields merged into reducer) ---
	const [queuedMessages, setQueuedMessages] = useState<BufferMessageSummary[]>([]);
	const [statusState, dispatchStatus] = useReducer(statusReducer, {
		substatus: [],
		contextPercent: null,
		contextStale: false,
		promptTokens: null,
		contextWindow: null,
		isEstimated: false,
		activePruneStart: null,
		activeCompactStart: null,
		pruneBoundaryMessageId: null,
		prunedPercent: null,
	});
	const {
		substatus,
		contextPercent,
		contextStale,
		promptTokens,
		contextWindow,
		isEstimated,
		activePruneStart,
		activeCompactStart,
		pruneBoundaryMessageId,
		prunedPercent,
	} = statusState;
	const suppressMessageDerivedCompactingRef = useRef(false);

	// --- Seed substatus from persisted narrator data ---
	// The reducer starts with substatus=[] and is normally updated via WS events.
	// When the user navigates away and back, the WS may not re-emit a status_change
	// for an idle narrator, so the substatus stays []. Seed it from the server data
	// once on mount so that "Update Conclusion" and other substatus-dependent UI
	// survives page navigation.
	const substatusSeededRef = useRef(false);
	useEffect(() => {
		if (substatusSeededRef.current) return;
		if (!narratorSubstatus?.length) return;
		// Only seed for non-active states — active states get real-time WS updates
		if (narratorStatus === "working" || narratorStatus === "waiting") return;
		dispatchStatus({ type: "patch", payload: { substatus: narratorSubstatus } });
		substatusSeededRef.current = true;
	}, [narratorSubstatus, narratorStatus]);
	// Reset seed flag when narrator changes so the next narrator's substatus is seeded.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on narratorId change
	useEffect(() => {
		substatusSeededRef.current = false;
	}, [narratorId]);

	const setContextPercent = useCallback(
		(v: React.SetStateAction<number | null>) => {
			dispatchStatus({
				type: "patch",
				payload: {
					contextPercent: typeof v === "function" ? v(statusState.contextPercent) : v,
				},
			});
		},
		[statusState.contextPercent],
	);
	const [browserSessionCount, setBrowserSessionCount] = useState(0);
	// Carries a monotonic seq alongside the sessionId so consecutive visual
	// changes to the SAME session still produce a new object reference and
	// trigger the screenshot auto-refresh (a bare string would bail out of
	// React state updates when unchanged).
	const [browserVisualChange, setBrowserVisualChange] = useState<{
		sessionId: string;
		seq: number;
	} | null>(null);
	const [quotaBalance, setQuotaBalance] = useState<string | null>(initialQuotaBalance ?? null);
	const [detailedQuotaBalance, setDetailedQuotaBalance] = useState<string | null>(
		initialDetailedQuotaBalance ?? null,
	);
	// Sync initial generic quota when switching narrators or custom API providers.
	// biome-ignore lint/correctness/useExhaustiveDependencies: narratorId/providerId must reset same-balance stale runtime state.
	useEffect(() => {
		setQuotaBalance(initialQuotaBalance ?? null);
		setDetailedQuotaBalance(initialDetailedQuotaBalance ?? null);
		setPaymentRequired(null);
	}, [narratorId, quotaProviderKey, initialQuotaBalance, initialDetailedQuotaBalance]);
	const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
	const [paymentRequired, setPaymentRequired] = useState<PaymentRequiredInfo | null>(null);
	const [leakedToolEvent, setLeakedToolEvent] = useState<LeakedToolEvent | null>(null);
	const retryInfoRef = useRef<RetryInfo | null>(null);
	const clearRetryIfActive = useCallback(() => {
		if (retryInfoRef.current) {
			retryInfoRef.current = null;
			setRetryInfo(null);
		}
	}, []);
	const [unreadCount, setUnreadCount] = useState(0);

	// --- Viewers ---
	const [viewers, setViewers] = useState<ViewerInfo[]>([]);

	// --- Todos ---
	const [currentTodos, setCurrentTodos] = useState<TodoItem[] | null>(narratorTodosJson ?? null);
	const [todosToolUseId, setTodosToolUseId] = useState<string | null>(
		narratorTodosToolUseId ?? null,
	);
	useEffect(() => {
		if (narratorTodosJson) setCurrentTodos(narratorTodosJson);
	}, [narratorTodosJson]);

	// --- Tool expand ---
	const [expandedToolUseId, setExpandedToolUseId] = useState<string | null>(null);

	useEffect(() => {
		if (!expandedToolUseId) return;
		const timer = setTimeout(() => setExpandedToolUseId(null), 500);
		return () => clearTimeout(timer);
	}, [expandedToolUseId]);

	// --- Initialize context/prune state from initial message data ---
	const contextInitRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when narratorId changes
	useEffect(() => {
		contextInitRef.current = false;
		// A different narrator starts with a fresh (non-stale) context reading —
		// the staleness flag is per-session and must not leak across switches.
		dispatchStatus({ type: "patch", payload: { contextStale: false } });
	}, [narratorId]);
	useEffect(() => {
		if (contextInitRef.current) return;
		const patch: Partial<StatusState> = {};
		let hasInitialSource = false;

		const applyTurnUsage = (turnUsageJson: Record<string, unknown> | null | undefined) => {
			if (!turnUsageJson) return;
			const restoredPromptTokens = promptTokensFromTurnUsage(turnUsageJson);
			if (restoredPromptTokens != null) patch.promptTokens = restoredPromptTokens;
			if (turnUsageJson.context_window != null) {
				patch.contextWindow = turnUsageJson.context_window as number;
			}
			patch.isEstimated = !!turnUsageJson.is_estimated;
		};

		if (messagesData?.pages?.length) {
			hasInitialSource = true;
			const firstPage = messagesData.pages[0];
			if (firstPage?.pruneBoundaryMessageId) {
				patch.pruneBoundaryMessageId = firstPage.pruneBoundaryMessageId;
			}
			if (firstPage?.prunedPercent != null) {
				patch.prunedPercent = firstPage.prunedPercent;
			}
			const msgs = firstPage?.messages;
			for (let i = (msgs?.length ?? 0) - 1; i >= 0; i--) {
				const m = msgs?.[i] as unknown as Record<string, unknown> | undefined;
				if (!m) continue;
				const cp = m.contextPercent;
				if (cp != null) {
					patch.contextPercent = cp as number;
					applyTurnUsage(m.turnUsageJson as Record<string, unknown> | null | undefined);
					if (patch.promptTokens == null && m.tokensIn != null) {
						patch.promptTokens = m.tokensIn as number;
					}
					break;
				}
			}
		} else if (initialMessageStatus?.statusReady) {
			hasInitialSource = true;
			if (initialMessageStatus.pruneBoundaryMessageId !== undefined) {
				patch.pruneBoundaryMessageId = initialMessageStatus.pruneBoundaryMessageId ?? null;
			}
			if (initialMessageStatus.prunedPercent !== undefined) {
				patch.prunedPercent = initialMessageStatus.prunedPercent ?? null;
			}
			if (initialMessageStatus.contextPercent != null) {
				patch.contextPercent = initialMessageStatus.contextPercent;
				applyTurnUsage(
					initialMessageStatus.turnUsageJson as Record<string, unknown> | null | undefined,
				);
			}
		}

		if (!hasInitialSource) return;
		if (Object.keys(patch).length > 0) {
			dispatchStatus({ type: "patch", payload: patch });
		}
		contextInitRef.current = true;
	}, [initialMessageStatus, messagesData]);

	// --- Initialize messageVersion from initial data ---
	const versionInitRef = useRef(false);
	useEffect(() => {
		if (versionInitRef.current || !messagesData?.pages?.length) return;
		const firstPage = messagesData.pages[0] as Record<string, unknown> | undefined;
		if (firstPage && typeof firstPage.messageVersion === "number") {
			narratorWSManager.updateMessageVersion(narratorId, firstPage.messageVersion as number);
			versionInitRef.current = true;
		}
	}, [messagesData, narratorId]);

	// --- toolUseId index (for O(1) lookups in WS callbacks) ---
	const hydrated = !!messagesData?.pages;
	const prevPagesForIndexRef = useRef<MessagesPage[]>([]);
	const toolUseIndexRef = useRef<MessageIndex>(new Map());
	const toolUseIndex = useMemo(() => {
		if (!hydrated || !messagesData?.pages) return new Map();
		const result = updateToolUseIndex(
			toolUseIndexRef.current,
			prevPagesForIndexRef.current,
			messagesData.pages,
		);
		prevPagesForIndexRef.current = messagesData.pages;
		return result;
	}, [hydrated, messagesData]);
	toolUseIndexRef.current = toolUseIndex;

	const topLevelStreamingChunks: NarratorMsg | null = useMemo(() => {
		// topLevelChunksVersion triggers recalculation when chunks are added/cleared
		void topLevelChunksVersion;
		if (!legacyMessageCacheUpdatesEnabled) return null;
		return buildTopLevelStreamingChunksMsg(
			[...topLevelStreamingChunkRef.current.values()],
			narratorId,
			topLevelStreamingCreatedAtRef.current,
		);
	}, [legacyMessageCacheUpdatesEnabled, topLevelChunksVersion, narratorId]);

	// --- Permission decision refs ---
	const sendPermissionDecisionRef = useRef<
		| ((
				requestId: string,
				decision: "allow" | "deny",
				message?: string,
				answers?: Record<string, string>,
				feedbackText?: string,
				compactAfter?: boolean,
				updatedPlan?: string,
		  ) => boolean)
		| null
	>(null);
	const pendingPermsMapRef = useRef(pendingPermsMap);
	pendingPermsMapRef.current = pendingPermsMap;

	/** Find a pending permission by requestId and remove it from the map. Returns the toolUseId. */
	const resolveAndRemovePerm = useCallback(
		(requestId: string): { toolUseId: string | undefined; perm: PendingPermission | undefined } => {
			const map = pendingPermsMapRef.current;
			let toolUseId: string | undefined;
			let perm: PendingPermission | undefined;
			for (const [tuId, p] of map) {
				if (p.id === requestId || tuId === requestId) {
					toolUseId = tuId;
					perm = p;
					break;
				}
			}
			if (toolUseId) {
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					next.delete(toolUseId);
					return next;
				});
			} else {
				setPendingPermsMap(new Map());
			}
			return { toolUseId, perm };
		},
		[],
	);

	// --- Permission decision handlers ---
	const handlePermissionDecision = useCallback(
		(
			requestId: string,
			decision: "allow" | "deny",
			feedbackText?: string,
			compactAfter?: boolean,
			updatedPlan?: string,
		) => {
			if (!permissionDecisionsSupported) return;
			const nextUpdatedPlan = updatedPermissionInputSupported ? updatedPlan : undefined;
			const wsSent = sendPermissionDecisionRef.current?.(
				requestId,
				decision,
				undefined,
				undefined,
				feedbackText,
				compactAfter,
				nextUpdatedPlan,
			);
			// Fallback to HTTP API when WS send fails (e.g. reconnecting)
			if (!wsSent) {
				const payload = {
					feedbackText,
					compactAfter,
					updatedPlan: nextUpdatedPlan,
				};
				if (decision === "allow") {
					api.approvePermission(requestId, payload).catch(() => {});
				} else {
					api.denyPermission(requestId, payload).catch(() => {});
				}
			}
			const { toolUseId, perm } = resolveAndRemovePerm(requestId);
			if (toolUseId) {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					if (compactAfter) {
						let anyChanged = false;
						const pages = old.pages.map((page: MessagesPage) => {
							const msg = findMsgByToolUseIdInTree(page.messages, toolUseId);
							if (!msg) return page;
							anyChanged = true;
							return {
								...page,
								messages: page.messages.filter((m: NarratorMsg) => m.id !== msg.id),
							};
						});
						return anyChanged ? { ...old, pages } : old;
					}
					// Optimistically update inputJson when plan was edited and the backend supports it.
					const inputUpdate =
						nextUpdatedPlan !== undefined && perm?.inputJson
							? { inputJson: { ...perm.inputJson, plan: nextUpdatedPlan } }
							: {};
					if (decision === "deny") {
						// Deny: immediately show as failed with user feedback
						return mergeFieldsByIndex(
							old,
							toolUseId,
							{
								status: "fail",
								permissionDenyMessage: feedbackText?.trim() || null,
								...inputUpdate,
							},
							toolUseIndexRef.current,
						);
					}
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ status: "running", ...inputUpdate },
						toolUseIndexRef.current,
					);
				});
			}
		},
		[
			messagesQueryKey,
			permissionDecisionsSupported,
			qc,
			resolveAndRemovePerm,
			updatedPermissionInputSupported,
		],
	);

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			if (!permissionDecisionsSupported || !updatedPermissionInputSupported) return;
			const wsSent = sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
			if (!wsSent) {
				api.approvePermission(requestId, { answers }).catch(() => {});
			}
			const { toolUseId, perm } = resolveAndRemovePerm(requestId);
			if (toolUseId && perm) {
				const baseInput =
					perm.inputJson && typeof perm.inputJson === "object" ? perm.inputJson : {};
				const mergedInput = { ...baseInput, answers };
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ inputJson: mergedInput, status: "running" },
						toolUseIndexRef.current,
					);
				});
			}
		},
		[
			messagesQueryKey,
			permissionDecisionsSupported,
			qc,
			resolveAndRemovePerm,
			updatedPermissionInputSupported,
		],
	);

	const handleQuestionReflect = useCallback(
		async (requestId: string) => {
			if (!permissionDecisionsSupported || !updatedPermissionInputSupported) return;
			try {
				const { answers } = await api.reflectQuestion(requestId);
				const { toolUseId, perm } = resolveAndRemovePerm(requestId);
				if (toolUseId && perm) {
					const baseInput =
						perm.inputJson && typeof perm.inputJson === "object" ? perm.inputJson : {};
					const mergedInput = { ...baseInput, answers };
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						return mergeFieldsByIndex(
							old,
							toolUseId,
							{ inputJson: mergedInput, status: "running" },
							toolUseIndexRef.current,
						);
					});
				}
			} catch {
				notifications.show({
					message: t("questionReflectionFailed"),
					color: "red",
					autoClose: 3000,
				});
			}
		},
		[
			messagesQueryKey,
			permissionDecisionsSupported,
			qc,
			resolveAndRemovePerm,
			t,
			updatedPermissionInputSupported,
		],
	);

	const handleQuestionDeny = useCallback(
		(requestId: string) => {
			if (!permissionDecisionsSupported) return;
			const message = "User skipped the question";
			const wsSent = sendPermissionDecisionRef.current?.(requestId, "deny", message);
			if (!wsSent) {
				api.denyPermission(requestId, { message }).catch(() => {});
			}
			const { toolUseId } = resolveAndRemovePerm(requestId);
			if (toolUseId) {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(old, toolUseId, { status: "fail" }, toolUseIndexRef.current);
				});
			}
		},
		[qc, messagesQueryKey, permissionDecisionsSupported, resolveAndRemovePerm],
	);

	// --- Stable permission callbacks ---
	const permCbRef = useRef<PermissionCallbacks | null>(null);
	permCbRef.current = {
		pendingPermission,
		pendingPermsMap,
		onPermissionDecision: handlePermissionDecision,
		onQuestionSubmit: handleQuestionSubmit,
		onQuestionReflect: handleQuestionReflect,
		onQuestionDeny: handleQuestionDeny,
	};
	const stablePermCb = useMemo<PermissionCallbacks>(
		() => ({
			pendingPermission: null,
			pendingPermsMap: new Map(),
			onPermissionDecision: (...args) => permCbRef.current?.onPermissionDecision(...args),
			onQuestionSubmit: (...args) => permCbRef.current?.onQuestionSubmit(...args),
			onQuestionReflect: (...args) => permCbRef.current?.onQuestionReflect(...args),
			onQuestionDeny: (...args) => permCbRef.current?.onQuestionDeny(...args),
		}),
		[],
	);
	const renderPermCb = useMemo(
		() => ({
			...stablePermCb,
			pendingPermission,
			pendingPermsMap,
		}),
		[stablePermCb, pendingPermission, pendingPermsMap],
	);

	const firstPageHasMoreAfter = messagesData?.pages?.[0]?.hasMoreAfter ?? false;

	// Tracks whether the first catch-up response for the current narratorId
	// subscription has been received (catch_up / sync_ok / full_reload). Used by
	// onFullReload to distinguish the initial subscribe (where the REST first
	// page already holds the latest messages, so invalidate is redundant) from a
	// reconnect / fell-behind full_reload (where invalidate is required).
	const firstCatchUpDoneRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when narratorId changes
	useEffect(() => {
		firstCatchUpDoneRef.current = false;
	}, [narratorId]);

	// --- lastMessageId for WS catch-up ---
	const lastMessageId = useMemo(() => {
		if (firstPageHasMoreAfter) return undefined;
		const pages = messagesData?.pages;
		if (!pages?.length) return undefined;
		const firstPage = pages[0];
		if (!firstPage?.messages?.length) return undefined;
		// Walk backwards to find the last real (non-synthetic) message.
		// When the initial page is a bounded around-window with newer messages omitted,
		// skip catch-up entirely so WS subscribe does not immediately refill the tail.
		for (let i = firstPage.messages.length - 1; i >= 0; i--) {
			const msg = firstPage.messages[i];
			if (!msg?.id || msg.id === STREAMING_CHUNKS_MSG_ID) continue;
			let deepest: NarratorMsg = msg;
			while (deepest.children?.length) {
				deepest = deepest.children[deepest.children.length - 1];
			}
			return deepest.id as string | undefined;
		}
		return undefined;
	}, [firstPageHasMoreAfter, messagesData]);

	const applyQueueStatus = useCallback(
		(position?: number, queueDepth?: number, queueMessage?: string) => {
			const substatusWithQueue = withQueueSubstatus(
				statusState.substatus,
				position,
				queueDepth,
				queueMessage,
			);
			dispatchStatus({ type: "patch", payload: { substatus: substatusWithQueue } });
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, substatus: substatusWithQueue } : old,
			);
		},
		[narratorId, qc, statusState.substatus],
	);

	const clearQueueMessage = useCallback(() => {
		if (!statusState.substatus.some((s) => s.startsWith("queue_message:"))) return;
		const substatusWithoutQueueMessage = withoutQueueMessageSubstatus(statusState.substatus);
		dispatchStatus({ type: "patch", payload: { substatus: substatusWithoutQueueMessage } });
		qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
			old ? { ...old, substatus: substatusWithoutQueueMessage } : old,
		);
	}, [narratorId, qc, statusState.substatus]);

	// --- WebSocket ---
	const {
		connected,
		disconnected,
		sendPermissionDecision,
		sendBufferMessage,
		cancelBuffer,
		reconnect,
	} = useNarratorWS(
		narratorId,
		{
			onStreamEvent: (wsData: Record<string, unknown>) => {
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				const ev = wsData.event as Record<string, any> | undefined;
				// Skip non-delta events and subagent events (handled separately)
				if (ev?.type !== "content_block_delta" || ev.subagentToolUseId) {
					return;
				}
				// Skip deltas without text content
				if (!ev.delta?.text) {
					return;
				}
				if (!legacyMessageCacheUpdatesEnabled) {
					clearQueueMessage();
					clearRetryIfActive();
					return;
				}
				if (ev.delta.type === "text_delta") {
					// A real upstream event means queue-only explanatory text is no longer current.
					clearQueueMessage();
					// Streaming content arriving means any pending retry has succeeded.
					// Only call setRetryInfo when there is actually a retry to clear —
					// avoids a no-op setState on every delta that still increments
					// React's nested-update counter inside useLayoutEffect chains.
					clearRetryIfActive();
					// Maintain ordered blocks using provider outputIndex when available.
					const blocks = streamingBlocksRef.current;
					const outputIndex = typeof ev.outputIndex === "number" ? ev.outputIndex : undefined;
					const existingIdx =
						outputIndex != null
							? blocks.findIndex((b) => b.type === "text" && b.outputIndex === outputIndex)
							: -1;
					if (existingIdx !== -1) {
						const existing = blocks[existingIdx];
						if (existing.type === "text") {
							existing.text = appendStreamingTextPreview(existing.text, ev.delta.text);
						}
					} else {
						const lastBlock = blocks[blocks.length - 1];
						if (lastBlock?.type === "text" && outputIndex == null) {
							lastBlock.text = appendStreamingTextPreview(lastBlock.text, ev.delta.text);
						} else {
							blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
								type: "text",
								text: appendStreamingTextPreview("", ev.delta.text),
								...(outputIndex != null ? { outputIndex } : {}),
							});
						}
					}
					flushStreamingVersion();
					return;
				}
				if (ev.delta.type === "reasoning_delta") {
					// A real upstream event means queue-only explanatory text is no longer current.
					clearQueueMessage();
					clearRetryIfActive();
					const blocks = streamingBlocksRef.current;
					const reasoningId =
						typeof ev.delta.id === "string" && ev.delta.id.length > 0 ? ev.delta.id : undefined;
					const outputIndex =
						typeof ev.delta.outputIndex === "number" ? ev.delta.outputIndex : undefined;
					const existingIdx = blocks.findIndex((b) => {
						if (b.type !== "reasoning") return false;
						if (reasoningId) return b.id === reasoningId;
						if (outputIndex != null) return b.outputIndex === outputIndex;
						return !b.id && b.outputIndex == null;
					});
					if (existingIdx !== -1) {
						const existing = blocks[existingIdx];
						if (existing.type === "reasoning") {
							existing.text = appendStreamingTextPreview(existing.text, ev.delta.text);
							if (reasoningId) existing.id = reasoningId;
							if (outputIndex != null) existing.outputIndex = outputIndex;
						}
					} else {
						blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
							type: "reasoning",
							text: appendStreamingTextPreview("", ev.delta.text),
							...(reasoningId ? { id: reasoningId } : {}),
							...(outputIndex != null ? { outputIndex } : {}),
						});
					}
					flushStreamingVersion();
					return;
				}
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				let needsStreamingVersionBump = false;
				const blocks = Array.isArray(wsData.message?.contentJson) ? wsData.message.contentJson : [];
				const compactBlock = blocks.find(
					(b: ContentBlock) =>
						(b.type === "compact" && b.subtype !== "plan") || b.type === "segment_compact",
				);
				if (compactBlock) {
					const patch: Partial<StatusState> = {};
					if (compactBlock.status === "compacted" && wsData.message?.contextPercent != null) {
						patch.contextPercent = wsData.message.contextPercent as number;
					}
					const tu = wsData.message?.turnUsageJson as Record<string, unknown> | null | undefined;
					if (compactBlock.status === "compacted" && tu) {
						const restoredPromptTokens = promptTokensFromTurnUsage(tu);
						if (restoredPromptTokens != null) patch.promptTokens = restoredPromptTokens;
						if (tu.context_window != null) patch.contextWindow = tu.context_window as number;
						patch.isEstimated = !!tu.is_estimated;
					}
					if (Object.keys(patch).length > 0) {
						dispatchStatus({ type: "patch", payload: patch });
					}
				}
				// Note: compact status is now tracked via substatus — do NOT dispatch
				// isCompacting here. The substatus_change event handles it.
				if (wsData.message?.id && wsData.message?.createdAt) {
					const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };
					if (wsData.message?.role === "assistant") {
						// A real upstream message means queue-only explanatory text is no longer current.
						clearQueueMessage();
						// New assistant message means any pending retry succeeded
						clearRetryIfActive();
						// Only clear top-level streaming state for non-subagent messages.
						// Subagent assistant messages should NOT reset the parent narrator's
						// streaming text, tool chunks, or streaming version — the parent
						// may still be actively streaming while subagents complete.
						if (!newMsg.parentToolUseId) {
							// Clear streaming refs without bumping version yet — we want
							// the cache update (remove synthetic + insert real) and the
							// version bumps to land in the same React batch so there is
							// no intermediate frame where the message list is empty.
							streamingBlocksRef.current = [];
							// clearStreamingState without version bump:
							if (streamingRafRef.current) {
								cancelAnimationFrame(streamingRafRef.current);
								streamingRafRef.current = 0;
							}
							clearToolBlockCache();
							// cancelPendingToolChunks without notify:
							cancelPendingToolChunks(false);
							// Mark that we need to bump versions after the sync flush
							needsStreamingVersionBump = true;
						}
					}
					if (newMsg.parentToolUseId && wsData.message?.role === "assistant") {
						// Atomic remove-synthetic + insert-real in a single setQueryData
						// to avoid an intermediate render where the card disappears.
						const ptuId = newMsg.parentToolUseId;
						scheduleCacheUpdate((old) => {
							if (!old?.pages?.length) return old;
							let result = removeSubagentStreamingChunk(old, ptuId, toolUseIndexRef.current);
							result = insertChildIntoCache(
								result,
								newMsg,
								toolUseIndexRef.current,
							) as MessagesQueryData;
							return result;
						});
					} else if (newMsg.parentToolUseId) {
						// Non-assistant subagent message (e.g. user/system) — insert
						// into the message tree rather than appending as top-level.
						scheduleCacheUpdate((old) => {
							if (!old?.pages?.length) return old;
							return insertChildIntoCache(
								old,
								newMsg,
								toolUseIndexRef.current,
							) as MessagesQueryData;
						});
					} else {
						const isDisplayOrSystemMsg = newMsg.role === "system" || newMsg.role === "disp";
						const isNewCompactMsg =
							isDisplayOrSystemMsg &&
							Array.isArray(newMsg.contentJson) &&
							newMsg.contentJson.some((b: ContentBlock) => b.type === "compact");
						const isNewAskInPassingMsg =
							isDisplayOrSystemMsg &&
							Array.isArray(newMsg.contentJson) &&
							newMsg.contentJson.some((b: ContentBlock) => b.type === "ask_in_passing");
						const needsMiddleInsertReload = isNewCompactMsg || isNewAskInPassingMsg;

						scheduleCacheUpdate((old) => {
							if (!old?.pages?.length) return old;
							const pages = [...old.pages];
							const firstPage = { ...pages[0] };
							// Atomically strip the synthetic streaming-chunks message
							// in the same updater that inserts the real message, so
							// there is never an intermediate frame without either.
							if (needsStreamingVersionBump) {
								firstPage.messages = firstPage.messages.filter(
									(m: NarratorMsg) => m.id !== STREAMING_CHUNKS_MSG_ID,
								);
							}
							const existingIdx = firstPage.messages.findIndex(
								(m: NarratorMsg) => m.id === newMsg.id,
							);
							if (existingIdx !== -1) {
								const updated = [...firstPage.messages];
								updated[existingIdx] = preserveLiveSideCars(updated[existingIdx], newMsg);
								firstPage.messages = updated;
								pages[0] = firstPage;
								return { ...old, pages };
							}
							if (needsMiddleInsertReload) {
								pages[0] = firstPage;
								return { ...old, pages };
							}
							if (!isAtBottomRef.current && newMsg.role === "assistant") {
								setUnreadCount((c) => c + 1);
							}
							// Replace a matching optimistic message by content, or append.
							// Optimistic messages are only created with role "user", so for
							// assistant messages this simply appends without scanning.
							const optimisticIdx =
								newMsg.role === "user"
									? firstPage.messages.findIndex(
											(m: NarratorMsg) =>
												String(m.id).startsWith("optimistic-") &&
												m.role === "user" &&
												m.contentText === newMsg.contentText,
										)
									: -1;
							if (optimisticIdx !== -1) {
								const updated = [...firstPage.messages];
								const om = updated[optimisticIdx];
								revokeContentBlockPreviewUrls(om.contentJson);
								updated.splice(optimisticIdx, 1);
								firstPage.messages = insertTopLevelMessageBySeq(updated, newMsg);
							} else {
								firstPage.messages = insertTopLevelMessageBySeq(firstPage.messages, newMsg);
							}
							pages[0] = firstPage;
							// Evict oldest pages in the same callback to avoid an
							// intermediate render with the full (pre-evict) data.
							let result: MessagesQueryData = { ...old, pages };
							if (isAtBottomRef.current) {
								result = evictOldestPages(result, MAX_LIVE_MESSAGES) as MessagesQueryData;
							}
							return result;
						});
						if (needsMiddleInsertReload) {
							qc.invalidateQueries({ queryKey: messagesQueryKey });
						}
					}
					// When streaming state was cleared for a top-level assistant message,
					// synchronously flush the cache update and bump versions in the same
					// JS turn so React batches everything into a single render — no
					// intermediate frame where the message list is empty (no flicker).
					if (needsStreamingVersionBump) {
						flushCacheUpdatesSync();
						if (legacyMessageCacheUpdatesEnabled) {
							setStreamingVersion((v) => v + 1);
						}
						bumpLegacyTopLevelStreamingChunksVersion();
					}
				} else {
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			},
			onUserMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				if (!wsData.message?.id || !wsData.message?.createdAt) return;
				const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) {
						return {
							pages: [{ messages: [newMsg], hasMore: false, nextCursor: null }],
							pageParams: [undefined],
						};
					}
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					if (firstPage.messages.some((m: NarratorMsg) => m.id === newMsg.id)) {
						return old;
					}
					// Find the matching optimistic message by content (not by role alone)
					// to avoid removing unrelated optimistic messages when sending rapidly.
					// For slash commands, match by commandText since contentText differs
					// (optimistic has raw command, server has expanded prompt).
					// For text file attachments, server contentText includes <attached_files>
					// hint appended to the original text, so also check startsWith.
					const optimisticIdx = firstPage.messages.findIndex(
						(m: NarratorMsg) =>
							String(m.id).startsWith("optimistic-") &&
							m.role === "user" &&
							(m.contentText === newMsg.contentText ||
								(m.commandText && newMsg.commandText && m.commandText === newMsg.commandText) ||
								(m.contentText &&
									newMsg.contentText?.startsWith(m.contentText) &&
									newMsg.contentText.includes("<attached_files>"))),
					);
					if (optimisticIdx !== -1) {
						const updated = [...firstPage.messages];
						const om = updated[optimisticIdx];
						revokeContentBlockPreviewUrls(om.contentJson);

						updated.splice(optimisticIdx, 1);
						firstPage.messages = insertTopLevelMessageBySeq(updated, newMsg);
					} else {
						firstPage.messages = insertTopLevelMessageBySeq(firstPage.messages, newMsg);
					}
					pages[0] = firstPage;
					// Evict oldest pages in the same callback to avoid double render
					let result: MessagesQueryData = { ...old, pages };
					if (isAtBottomRef.current) {
						result = evictOldestPages(result, MAX_LIVE_MESSAGES) as MessagesQueryData;
					}
					return result;
				});
			},
			onToolCompleted: (
				toolUseId: string,
				status: string,
				output?: unknown,
				durationMs?: number,
				updatedInput?: Record<string, unknown>,
				metadata?: Record<string, unknown>,
				parentToolUseId?: string,
				sideCars?: SideCarRecord[],
			) => {
				const streamedOutput = toolOutputPreviewRef.current.get(toolUseId)?.preview;
				const completedOutput = preserveCompleteStreamedOutput(output, streamedOutput);

				// Discard any pending RAF chunk/output preview and accumulated raw input for this tool.
				// Read streamedOutput before this cleanup so a complete live response can be promoted
				// into the persisted frontend cache instead of being replaced by a 2KB final preview.
				pendingToolChunkRef.current.delete(toolUseId);
				toolStreamingFieldRef.current.delete(toolUseId);
				clearToolOutputPreviewState(toolUseId);

				// Update the streaming chunk entry if it still exists (top-level only)
				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							inputCharsTotal: -1,
							extractedFilePath: undefined,
							contentCharsReceived: undefined,
							_started: true,
							// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
							_input: updatedInput ?? (streamingEntry as any)._input,
							_status: status,
							_output: completedOutput.output,
							_durationMs: durationMs,
							_metadata: metadata,
							_sideCars: sideCars,
							_streamingOutput: undefined,
							_streamedFullOutput: completedOutput.preserved || undefined,
							// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
						} as any);
						bumpLegacyTopLevelStreamingChunksVersion();
					}
				}

				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					let result = updateToolCallByIndex(
						old,
						toolUseId,
						status,
						completedOutput.output,
						toolUseIndexRef.current,
						durationMs,
					);
					result = mergeFieldsByIndex(
						result,
						toolUseId,
						{
							_streamingOutput: undefined,
							...(completedOutput.preserved && { _streamedFullOutput: true }),
						},
						toolUseIndexRef.current,
					);
					if (updatedInput && result) {
						result = mergeFieldsByIndex(
							result,
							toolUseId,
							{ inputJson: updatedInput },
							toolUseIndexRef.current,
						);
					}
					if (metadata && result) {
						result = mergeFieldsByIndex(
							result,
							toolUseId,
							{ _metadata: metadata },
							toolUseIndexRef.current,
						);
					}
					if (sideCars?.length && result) {
						result = mergeFieldsByIndex(result, toolUseId, { sideCars }, toolUseIndexRef.current);
					}
					return result;
				});
			},
			onSideCars: (sideCars: SideCarRecord[], parentToolUseId?: string) => {
				const userSideCars = sideCars.filter((sc) => sc.target === "user_message");
				if (userSideCars.length === 0) return;
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
						const page = pages[pageIdx];
						const result = appendSideCarsToLatestAssistant(
							page.messages,
							userSideCars,
							parentToolUseId,
						);
						if (result.changed) {
							pages[pageIdx] = { ...page, messages: result.messages };
							return { ...old, pages };
						}
					}
					return old;
				});
			},
			onToolLongRunning: (toolUseId: string, _elapsed: number, parentToolUseId?: string) => {
				// Mark the tool call as long-running so the UI can show a terminate button.
				// Update both the streaming chunk (if still active) and the query cache.

				// 更新流式 chunk 的 _longRunning 标记，使 topLevelStreamingChunks memo
				// 重算时传递给 ToolCallCard（streaming 阶段的渲染路径）
				if (!parentToolUseId) {
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							_longRunning: true,
							// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
						} as any);
						bumpLegacyTopLevelStreamingChunksVersion();
					}
				}

				// 同时更新已持久化的消息缓存，确保 streaming chunk 被清除后
				// _longRunning 状态仍保留（query cache 渲染路径）
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ _longRunning: true },
						toolUseIndexRef.current,
					);
				});
			},
			onToolOutput: (toolUseId: string, output: string, _parentToolUseId?: string) => {
				if (!legacyMessageCacheUpdatesEnabled) return;
				// Store only a bounded live preview in React Query while preserving final outputJson

				// semantics when tool_completed arrives.
				const preview = getToolOutputPreview(output);
				const shouldThrottle = output.length >= STREAMING_TOOL_OUTPUT_THROTTLE_MIN_CHARS;
				const now = Date.now();
				let state = toolOutputPreviewRef.current.get(toolUseId);
				if (!state) {
					state = { preview: "", lastFlushedPreview: "", lastFlushAt: 0, timer: null };
					toolOutputPreviewRef.current.set(toolUseId, state);
				}
				if (preview === state.preview) return;
				state.preview = preview;

				if (!shouldThrottle) {
					if (state.timer) {
						clearTimeout(state.timer);
						state.timer = null;
					}
					flushToolOutputPreview(toolUseId, preview);
					return;
				}

				const elapsed = now - state.lastFlushAt;
				if (elapsed >= STREAMING_TOOL_OUTPUT_THROTTLE_MS) {
					if (state.timer) {
						clearTimeout(state.timer);
						state.timer = null;
					}
					flushToolOutputPreview(toolUseId, preview);
					return;
				}

				if (!state.timer) {
					state.timer = setTimeout(() => {
						const latest = toolOutputPreviewRef.current.get(toolUseId);
						if (!latest) return;
						latest.timer = null;
						flushToolOutputPreview(toolUseId, latest.preview);
					}, STREAMING_TOOL_OUTPUT_THROTTLE_MS - elapsed);
				}
			},
			onToolStarted: (
				toolUseId: string,
				toolName: string,
				streamStartedAt?: number,
				input?: Record<string, unknown>,
				parentToolUseId?: string,
			) => {
				// Tool execution starting means any pending retry has succeeded.
				clearRetryIfActive();
				// Discard any pending RAF chunk for this tool — real state takes precedence
				pendingToolChunkRef.current.delete(toolUseId);

				if (!parentToolUseId) {
					// Top-level tool: promote the streaming chunk to a "started" state
					const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
					if (streamingEntry) {
						topLevelStreamingChunkRef.current.set(toolUseId, {
							...streamingEntry,
							toolName,
							inputCharsTotal: -1, // sentinel: no longer streaming
							extractedFilePath: undefined,
							contentCharsReceived: undefined,
							_started: true,
							_input: input,
							_startedAt: streamStartedAt,
							// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
						} as any);
						bumpLegacyTopLevelStreamingChunksVersion();
					}
				}

				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					// For subagent tools, also replace the synthetic _streamingChars inputJson
					// with the real input so ToolCallCard stops showing the shimmer and renders
					// the actual tool card content.
					const fields: Record<string, unknown> = {
						status: "running",
						startedAt: streamStartedAt ?? Date.now(),
					};
					if (parentToolUseId && input) {
						fields.inputJson = input;
					}
					// Extract timeout for Bash/Await tools so the timer can show elapsed/timeout
					if (input?.timeout != null && typeof input.timeout === "number") {
						fields._timeoutMs = input.timeout;
					}
					// For Agent tools with an explicit model in input, eagerly set
					// _resolvedModel so the badge renders immediately instead of
					// waiting for the subagent_started WS event.
					if (toolName === "Agent" && input?.model && typeof input.model === "string") {
						fields._resolvedModel = input.model;
					}
					return mergeFieldsByIndex(old, toolUseId, fields, toolUseIndexRef.current);
				});
			},
			onSubagentStarted: (toolUseId: string, model?: string) => {
				if (!model) return;
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ _resolvedModel: model },
						toolUseIndexRef.current,
					);
				});
			},
			onSubagentSuspended: (subagentNarratorId: string, _toolUseId: string) => {
				// Invalidate the subagent narrator query so SubagentCard picks up "suspended" status
				qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
			},
			onSubagentStatusChanged: (
				subagentNarratorId: string,
				status: string,
				substatus?: string[],
			) => {
				qc.setQueryData(
					["narrators", subagentNarratorId],
					// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
					(old: any) =>
						old
							? {
									...old,
									status,
									...(substatus !== undefined ? { substatus } : {}),
									_retryInfo: undefined,
								}
							: old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
			},
			onSubagentTodosUpdated: (
				subagentNarratorId: string,
				todos: unknown[],
				_toolUseId?: string,
			) => {
				// Update the subagent narrator query cache with new todos
				qc.setQueryData(
					["narrators", subagentNarratorId],
					// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
					(old: any) => (old ? { ...old, todosJson: todos } : old),
				);
			},
			onSubagentWarning: (
				subagentNarratorId: string,
				info: {
					message: string;
					retryCount?: number;
					maxRetries?: number;
					delayMs?: number;
				},
			) => {
				// Store retry info on the subagent narrator cache so SubagentCard can display it
				qc.setQueryData(
					["narrators", subagentNarratorId],
					// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
					(old: any) =>
						old
							? {
									...old,
									_retryInfo: {
										message: info.message,
										retryCount: info.retryCount,
										maxRetries: info.maxRetries,
										retryAt: info.delayMs != null ? Date.now() + info.delayMs : undefined,
									},
								}
							: old,
				);
			},
			onSubagentConclusionUpdated: (
				_subagentNarratorId: string,
				toolUseId: string,
				output: unknown,
				hasError: boolean,
			) => {
				// Clean up client-only _retryInfo from the subagent narrator cache
				qc.setQueryData(
					["narrators", _subagentNarratorId],
					// biome-ignore lint/suspicious/noExplicitAny: dynamic narrator shape
					(old: any) => (old ? { ...old, _retryInfo: undefined } : old),
				);
				// Update the tool call's outputJson in the messages cache
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							outputJson: output,
							status: hasError ? "fail" : "success",
						},
						toolUseIndexRef.current,
					);
				});
			},
			onTimeoutUpdated: (toolUseId: string, timeoutMs: number) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ _timeoutMs: timeoutMs },
						toolUseIndexRef.current,
					);
				});
			},
			onToolUseChunk: (
				toolUseId: string,
				toolName: string,
				inputCharsTotal: number,
				parentToolUseId?: string,
				extractedFilePath?: string,
				contentCharsReceived?: number,
				extractedFields?: Record<string, string>,
				metadata?: Record<string, unknown>,
				streamingField?: { name: string; delta: string },
			) => {
				if (!legacyMessageCacheUpdatesEnabled) return;
				// Accumulate streaming field value across frames (not cleared per RAF)
				if (streamingField) {
					const prev = toolStreamingFieldRef.current.get(toolUseId);
					if (prev && prev.name === streamingField.name) {
						prev.value = getStreamingFieldPreview(prev.value + streamingField.delta);
					} else {
						toolStreamingFieldRef.current.set(toolUseId, {
							name: streamingField.name,
							value: getStreamingFieldPreview(streamingField.delta),
						});
					}
				}
				// Accumulate the latest state for each toolUseId; flush once per frame
				pendingToolChunkRef.current.set(toolUseId, {
					toolUseId,
					toolName,
					inputCharsTotal,
					parentToolUseId,
					extractedFilePath,
					contentCharsReceived,
					extractedFields,
					metadata,
				});
				if (!toolChunkRafRef.current) {
					toolChunkRafRef.current = requestAnimationFrame(() => {
						toolChunkRafRef.current = 0;
						const pending = pendingToolChunkRef.current;
						if (pending.size === 0) return;
						const chunks = [...pending.values()];
						pending.clear();

						let topLevelChanged = false;
						const subagentChunks = chunks.filter((chunk) => !!chunk.parentToolUseId);
						if (subagentChunks.length > 0) {
							scheduleCacheUpdate((old) => {
								let result = old;
								for (const chunk of subagentChunks) {
									if (!chunk.parentToolUseId || !result) continue;
									const sf = toolStreamingFieldRef.current.get(chunk.toolUseId);
									result = upsertSubagentStreamingChunk(
										result,
										chunk.parentToolUseId,
										narratorId,
										chunk.toolUseId,
										chunk.toolName,
										chunk.inputCharsTotal,
										toolUseIndexRef.current,
										chunk.extractedFilePath,
										chunk.contentCharsReceived,
										chunk.extractedFields,
										chunk.metadata,
										sf ? { name: sf.name, value: sf.value } : undefined,
									) as MessagesQueryData;
								}
								return result;
							});
						}
						for (const chunk of chunks) {
							if (chunk.parentToolUseId) continue;
							if (!topLevelStreamingCreatedAtRef.current) {
								topLevelStreamingCreatedAtRef.current = new Date().toISOString();
							}
							const sf = toolStreamingFieldRef.current.get(chunk.toolUseId);
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
								extractedFields: chunk.extractedFields,
								metadata: chunk.metadata,
								streamingFieldName: sf?.name,
								streamingFieldValue: sf?.value,
							});
							topLevelChanged = true;
						}
						if (topLevelChanged) {
							bumpLegacyTopLevelStreamingChunksVersion();
						}
					});
				}
			},
			onPermissionRequest: (request) => {
				const tuId = request.toolUseId;
				if (tuId) {
					setPendingPermsMap((prev) => {
						const next = new Map(prev);
						next.set(tuId, request);
						return next;
					});
				}
				if (tuId) {
					scheduleCacheUpdate((old) => {
						if (!old?.pages?.length) return old;
						return mergeFieldsByIndex(old, tuId, { status: "pending" }, toolUseIndexRef.current);
					});
				}
			},
			onPermissionResolved: (
				_requestId,
				toolUseId,
				updatedInput,
				decision,
				feedbackText,
				subagentNarratorId,
			) => {
				if (toolUseId) {
					setPendingPermsMap((prev) => {
						if (!prev.has(toolUseId)) return prev;
						const next = new Map(prev);
						next.delete(toolUseId);
						return next;
					});
					scheduleCacheUpdate((old) => {
						if (!old?.pages?.length) return old;
						if (decision === "deny") {
							return mergeFieldsByIndex(
								old,
								toolUseId,
								{
									status: "fail",
									permissionDenyMessage: feedbackText?.trim() || null,
								},
								toolUseIndexRef.current,
							);
						}
						if (decision !== "allow") return old;
						return mergeFieldsByIndex(
							old,
							toolUseId,
							{
								status: "running",
								startedAt: Date.now(),
								// Sync answers from other clients (e.g. AskUserQuestion)
								...(updatedInput ? { inputJson: updatedInput } : {}),
							},
							toolUseIndexRef.current,
						);
					});
					// Invalidate subagent narrator query so SubagentCard picks up "working" status
					if (subagentNarratorId) {
						qc.invalidateQueries({ queryKey: ["narrators", subagentNarratorId] });
					}
				}
			},
			onDangerReflectionStarted: ({ requestId, toolUseId, danger }) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							permissionDecisionReason:
								typeof danger === "object" && danger && "summary" in danger
									? `Danger reflection: ${String((danger as { summary?: unknown }).summary ?? "")}`
									: "Danger reflection in progress",
							permissionSuggestions: [
								{ type: "danger_reflection", status: "running", danger, requestId },
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onDangerReflectionStopped: ({
				requestId,
				toolUseId,
				toolName,
				danger,
				inputJson,
				reason,
			}) => {
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					const existing =
						next.get(toolUseId) ?? [...next.values()].find((perm) => perm.id === requestId);
					if (existing) next.delete(existing.toolUseId ?? toolUseId);
					next.set(toolUseId, {
						...(existing ?? {}),
						id: requestId,
						toolName,
						toolUseId,
						inputJson: existing?.inputJson ?? inputJson ?? {},
						decisionReason: reason ?? existing?.decisionReason,
						suggestions: [
							{ type: "danger_reflection", status: "awaiting_user", danger, requestId, reason },
						],
					});
					return next;
				});
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason:
								reason ?? "Danger reflection stopped; awaiting user decision",
							permissionSuggestions: [
								{ type: "danger_reflection", status: "awaiting_user", danger, requestId, reason },
							],
						},
						toolUseIndexRef.current,
					);
				});
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onDangerReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				setPendingPermsMap((prev) => {
					if (!prev.has(toolUseId) && ![...prev.values()].some((perm) => perm.id === requestId)) {
						return prev;
					}
					const next = new Map(prev);
					next.delete(toolUseId);
					for (const [key, perm] of next) {
						if (perm.id === requestId) next.delete(key);
					}
					return next;
				});
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const status = decision === "allow" ? "running" : "fail";
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "danger_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
								},
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onPlanReflectionStarted: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Plan reflection in progress",
							permissionSuggestions: [
								{ type: "plan_reflection", status: "running", requestId, reason },
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onPlanReflectionStopped: ({ requestId, toolUseId, inputJson, reason }) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Plan reflection stopped; awaiting user decision",
							permissionSuggestions: [
								{ type: "plan_reflection", status: "awaiting_user", requestId, reason },
							],
						},
						toolUseIndexRef.current,
					);
				});
				qc.invalidateQueries({ queryKey: ["permissions", narratorId] });
			},
			onPlanReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				setPendingPermsMap((prev) => {
					if (!prev.has(toolUseId) && ![...prev.values()].some((perm) => perm.id === requestId)) {
						return prev;
					}
					const next = new Map(prev);
					next.delete(toolUseId);
					for (const [key, perm] of next) {
						if (perm.id === requestId) next.delete(key);
					}
					return next;
				});
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const status = decision === "allow" ? "running" : "fail";
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "plan_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
								},
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onGoalReflectionStarted: ({ requestId, toolUseId, inputJson, activeGoal, reason }) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Goal completion reflection in progress",
							permissionSuggestions: [
								{ type: "goal_reflection", status: "running", requestId, reason, activeGoal },
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onGoalReflectionResolved: ({ requestId, toolUseId, decision, reason, nextSteps }) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const status = decision === "allow" ? "running" : "fail";
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status,
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							...(decision !== "allow" ? { errorMessage: reason ?? null } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{
									type: "goal_reflection",
									status:
										decision === "allow"
											? "confirmed"
											: decision === "aborted"
												? "aborted"
												: "cancelled",
									requestId,
									reason,
									nextSteps,
								},
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onQuestionReflectionStarted: ({ requestId, toolUseId, toolName, inputJson, reason }) => {
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					const existing =
						next.get(toolUseId) ?? [...next.values()].find((perm) => perm.id === requestId);
					if (existing) next.delete(existing.toolUseId ?? toolUseId);
					next.set(toolUseId, {
						...(existing ?? {}),
						id: requestId,
						toolName,
						toolUseId,
						inputJson: existing?.inputJson ?? inputJson ?? {},
						decisionReason: reason ?? existing?.decisionReason,
						suggestions: [{ type: "question_reflection", status: "running", requestId, reason }],
					});
					return next;
				});
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: "pending",
							...(inputJson ? { inputJson } : {}),
							permissionDecisionReason: reason ?? "Question reflection in progress",
							permissionSuggestions: [
								{ type: "question_reflection", status: "running", requestId, reason },
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onQuestionReflectionResolved: ({ requestId, toolUseId, decision, reason }) => {
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					if (decision === "allow") {
						next.delete(toolUseId);
						for (const [key, perm] of next) {
							if (perm.id === requestId) next.delete(key);
						}
						return next;
					}
					const existing =
						next.get(toolUseId) ?? [...next.values()].find((perm) => perm.id === requestId);
					if (!existing) return prev;
					if (existing.toolUseId) next.delete(existing.toolUseId);
					next.set(toolUseId, {
						...existing,
						id: requestId,
						toolUseId,
						decisionReason: reason ?? existing.decisionReason,
						suggestions: [
							{ type: "question_reflection", status: "awaiting_user", requestId, reason },
						],
					});
					return next;
				});
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const reflectionStatus =
						decision === "allow"
							? "confirmed"
							: decision === "aborted"
								? "awaiting_user"
								: "cancelled";
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{
							status: decision === "allow" ? "running" : "pending",
							...(decision === "allow" ? { startedAt: Date.now() } : {}),
							permissionDecisionReason: reason ?? null,
							permissionSuggestions: [
								{ type: "question_reflection", status: reflectionStatus, requestId, reason },
							],
						},
						toolUseIndexRef.current,
					);
				});
			},
			onStatusChange: (status, turnStartedAt, eventSubstatus) => {
				clearRetryIfActive();
				// Clean up streaming state when the narrator is no longer actively working.
				// "idle" and "archived" are non-working states; done/error/interrupted are
				// now represented as idle+substatus.
				const isNotWorking = status !== "working" && status !== "waiting";
				// Batch all reducer state updates into a single dispatch
				const patch: Partial<StatusState> = {};
				if (eventSubstatus !== undefined) {
					patch.substatus = eventSubstatus;
				} else if (isNotWorking) {
					// Clear substatus when transitioning to idle without explicit substatus
					patch.substatus = [];
				}
				if (patch.substatus !== undefined) {
					suppressMessageDerivedCompactingRef.current = !hasActiveCompactSubstatus(patch.substatus);
				}
				dispatchStatus({ type: "patch", payload: patch });
				if (isNotWorking) {
					const hadStreaming = streamingBlocksRef.current.length > 0;
					streamingBlocksRef.current = [];
					// Only bump streamingVersion when there was actual streaming content
					// to clear — avoids a redundant setState when onMessage already
					// cleared everything, reducing the nested-update count.
					if (hadStreaming) {
						clearStreamingState();
					}

					// Cancel any pending RAF tool chunk flush and notify so the memo
					// recomputes — otherwise stale streaming tool blocks linger on screen.
					// Include subagent chunks since the entire session is done.
					cancelPendingToolChunks(true, true);
					removeStreamingChunksMsg(qc, messagesQueryKey);
				}
				// Merge turnStartedAt only when the server explicitly sends it (i.e. at turn start).
				// Terminal-status broadcasts (idle) omit turnStartedAt on purpose so the
				// cached value from the "working" broadcast is preserved — the UI uses it to display
				// the elapsed duration of the last completed turn.
				// Note: errorMessage is NOT cleared here — it persists until user manually dismisses it.
				const narratorPatch: Record<string, unknown> = {
					status,
					...(turnStartedAt !== undefined && { turnStartedAt }),
				};
				if (eventSubstatus !== undefined) {
					narratorPatch.substatus = eventSubstatus;
				}
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, ...narratorPatch } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onSubstatusChange: (newSubstatus) => {
				suppressMessageDerivedCompactingRef.current = !hasActiveCompactSubstatus(newSubstatus);
				dispatchStatus({ type: "patch", payload: { substatus: newSubstatus } });
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, substatus: newSubstatus } : old,
				);
			},
			onTitleUpdated: () => {
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			},
			onTodosUpdated: (todos, toolUseId) => {
				setCurrentTodos(todos);
				if (toolUseId) setTodosToolUseId(toolUseId);
			},
			onBufferSet: (messages) => {
				setQueuedMessages(messages);
			},
			onBufferConsumed: (_messageId, remaining) => {
				setQueuedMessages(remaining);
			},
			onQueuedNewNarratorCreated: (_messageId, newNarratorId) => {
				qc.invalidateQueries({ queryKey: ["narrators"] });
				qc.invalidateQueries({ queryKey: ["narrators", newNarratorId], exact: true });
				onQueuedNewNarratorCreated?.(newNarratorId);
			},
			onBufferCleared: () => {
				setQueuedMessages([]);
			},
			onBufferPreserved: (messages) => {
				// Keep queued messages visible — they were preserved after an error.
				// Sync with the authoritative list from the server in case the
				// frontend state drifted (e.g. optimistic removes that didn't land).
				setQueuedMessages(messages);
				notifications.show({
					title: t("narratorError"),
					message: t("bufferPreservedNotice"),
					color: "yellow",
					autoClose: 6000,
				});
			},
			onGoalsSet: (goals: NarratorGoal[]) => {
				qc.setQueryData(["narrators", narratorId, "goals"], { goals });
			},
			onPermissionModeChanged: (permissionMode) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, permissionMode } : old,
				);
			},
			onPlanModeChanged: (planMode, traits) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, planMode, ...(traits ? { traits } : {}) } : old,
				);
			},
			onCustomTraitsChanged: (traits) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, ...(traits ? { traits } : {}) } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId, "custom-traits"] });
			},
			onDraftChanged: (draft) => {
				onDraftChanged?.(draft);
			},
			onRelaxedPlanChanged: (relaxedPlan) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, relaxedPlan } : old,
				);
			},
			onReflectionOverridesChanged: (overrides) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, ...overrides } : old,
				);
			},
			onContextUsage: (percentage, pTokens, ctxWindow, isEst, pruneStart, compactStart) => {
				dispatchStatus({
					type: "patch",
					payload: {
						contextPercent: percentage,
						contextStale: false,
						promptTokens: pTokens ?? null,
						contextWindow: ctxWindow ?? null,
						isEstimated: !!isEst,
						activePruneStart: pruneStart ?? null,
						activeCompactStart: compactStart ?? null,
					},
				});
			},
			onPruneBoundary: (boundaryMessageId, prunedPct) => {
				dispatchStatus({
					type: "patch",
					payload: {
						pruneBoundaryMessageId: boundaryMessageId,
						prunedPercent: prunedPct,
					},
				});
			},
			onQuotaBalance: (balance, detailedBalance) => {
				setQuotaBalance(balance);
				setDetailedQuotaBalance(detailedBalance ?? null);
				if (customApiProviderId) {
					const updateSettingsQuota = (old: unknown) => {
						if (!old || typeof old !== "object") return old;
						const settings = old as Record<string, unknown>;
						const customApiQuotas =
							settings.customApiQuotas && typeof settings.customApiQuotas === "object"
								? (settings.customApiQuotas as Record<string, unknown>)
								: {};
						const existing =
							customApiQuotas[customApiProviderId] &&
							typeof customApiQuotas[customApiProviderId] === "object"
								? (customApiQuotas[customApiProviderId] as Record<string, unknown>)
								: {};
						return {
							...settings,
							customApiQuotas: {
								...customApiQuotas,
								[customApiProviderId]: {
									...existing,
									quotaBalance: balance,
									detailedQuotaBalance: detailedBalance ?? null,
								},
							},
						};
					};
					qc.setQueryData(["settings"], updateSettingsQuota);
					qc.setQueryData(["admin", "settings"], updateSettingsQuota);
				}
				if (nugProviderId && balance != null) {
					const numericBalance = Number(balance);
					if (Number.isFinite(numericBalance)) {
						qc.setQueryData(["nug", "quotas"], (old: unknown) => {
							const quotas = old && typeof old === "object" ? (old as Record<string, unknown>) : {};
							const existing =
								quotas[nugProviderId] && typeof quotas[nugProviderId] === "object"
									? (quotas[nugProviderId] as Record<string, unknown>)
									: {};
							return {
								...quotas,
								[nugProviderId]: {
									...existing,
									balance: numericBalance,
									totalGranted: existing.totalGranted ?? null,
									detailedQuotaBalance: detailedBalance ?? existing.detailedQuotaBalance ?? null,
								},
							};
						});
					}
				}
			},
			onPaymentRequired: (info) => {
				setPaymentRequired(info);
			},
			onQueueStatus: (position, queueDepth, queueMessage) => {
				applyQueueStatus(position, queueDepth, queueMessage);
			},
			onBrowserSessionCount: (count) => {
				setBrowserSessionCount(count);
				qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
			},
			onBrowserSessionVisualChange: (sessionId) => {
				setBrowserVisualChange((prev) => ({ sessionId, seq: (prev?.seq ?? 0) + 1 }));
			},
			onWebSearch: (id, status, query, queries, outputIndex, parentToolUseId) => {
				// Subagent native searches are delivered to the parent for bookkeeping,
				// but must not populate the parent's top-level streaming message.
				if (parentToolUseId || !legacyMessageCacheUpdatesEnabled) return;
				const blocks = streamingBlocksRef.current;

				const existingIdx = blocks.findIndex((b) => b.type === "web_search" && b.id === id);
				if (existingIdx !== -1) {
					const existing = blocks[existingIdx];
					if (existing.type === "web_search") {
						existing.status = status;
						if (query) existing.query = query;
						if (queries) existing.queries = queries;
						if (outputIndex != null) existing.outputIndex = outputIndex;
					}
				} else {
					blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
						type: "web_search",
						id,
						status,
						query,
						queries,
						...(outputIndex != null ? { outputIndex } : {}),
					});
				}
				flushStreamingVersion();
			},
			onImageGeneration: (
				id,
				status,
				revisedPrompt,
				outputIndex,
				partialImageIndex,
				partialSavedPath,
				savedPath,
				width,
				height,
				parentToolUseId,
			) => {
				// Subagent native image generation events should stay out of the parent's
				// top-level streaming message; the subagent page receives an unlinked copy.
				if (parentToolUseId || !legacyMessageCacheUpdatesEnabled) return;
				const blocks = streamingBlocksRef.current;
				const existingIdx = blocks.findIndex((b) => b.type === "image_generation" && b.id === id);
				if (existingIdx !== -1) {
					const existing = blocks[existingIdx];
					if (existing.type === "image_generation") {
						existing.status = status;
						if (revisedPrompt) existing.revisedPrompt = revisedPrompt;
						if (outputIndex != null) existing.outputIndex = outputIndex;
						if (partialImageIndex != null) existing.partialImageIndex = partialImageIndex;
						if (partialSavedPath) existing.partialSavedPath = partialSavedPath;
						if (savedPath) existing.savedPath = savedPath;
						if (width != null && height != null) {
							existing.width = width;
							existing.height = height;
						}
					}
				} else {
					blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
						type: "image_generation",
						id,
						status,
						revisedPrompt,
						...(partialImageIndex != null ? { partialImageIndex } : {}),
						...(partialSavedPath ? { partialSavedPath } : {}),
						...(savedPath ? { savedPath } : {}),
						...(width != null && height != null ? { width, height } : {}),
						...(outputIndex != null ? { outputIndex } : {}),
					});
				}
				flushStreamingVersion();
			},
			onGitStatus: (data) => {
				qc.setQueryData(["chapterGitStatus", data.chapterId], {
					commitsAhead: data.commitsAhead,
					baseBranch: data.baseBranch,
					linesAdded: data.linesAdded,
					linesRemoved: data.linesRemoved,
				});
				// Also invalidate the detailed git status used by the Git panel
				qc.invalidateQueries({ queryKey: ["gitStatus", data.chapterId] });
			},
			onCommitSyncError: (event) => {
				qc.invalidateQueries({ queryKey: ["chapterGitStatus", event.chapterId] });
				qc.invalidateQueries({ queryKey: ["gitStatus", event.chapterId] });
				notifications.show({
					title: t("commitSyncErrorTitle"),
					message:
						event.reason ??
						event.message ??
						event.error ??
						event.code ??
						t("commitSyncErrorFallback"),
					color: "yellow",
					autoClose: 5000,
				});
			},
			onCompacting: () => {
				// Compacting status now comes via substatus_change.
				// Keep this callback for compact block detection in onMessage.
			},
			onSegmentCompactHide: (hiddenMessageIds: string[]) => {
				// Remove hidden messages from the cache immediately so the UI
				// reflects the fold before the compact summary arrives.
				if (hiddenMessageIds.length === 0) return;
				const idSet = new Set(hiddenMessageIds);
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const filtered = page.messages.filter((m: NarratorMsg) => !idSet.has(m.id as string));
						if (filtered.length !== page.messages.length) {
							anyChanged = true;
							return { ...page, messages: filtered };
						}
						return page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
			},
			onCompactDone: (
				contextPercentAfter?: number,
				isSegment?: boolean,
				mode?: "blocking" | "background",
			) => {
				const isBackgroundCompact = mode === "background";
				suppressMessageDerivedCompactingRef.current = true;
				const nextSubstatus = withoutCompactingSubstatus(statusState.substatus);
				dispatchStatus({
					type: "patch",
					payload: {
						substatus: nextSubstatus,
						pruneBoundaryMessageId: null,
						prunedPercent: null,
						// Compact / clear-context changed the history without a fresh
						// server-side context_usage. Mark the indicator inaccurate until
						// the next real turn reports usage.
						contextStale: true,
					},
				});
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, substatus: withoutCompactingSubstatus(old.substatus) } : old,
				);
				if (!isBackgroundCompact) {
					cancelPendingToolChunks(true, true);
					removeStreamingChunksMsg(qc, messagesQueryKey);
				}
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				qc.invalidateQueries({ queryKey: messagesQueryKey });
				if (contextPercentAfter != null) {
					notifications.show({
						title: t(isSegment ? "segmentCompactSuccess" : "compactSuccess"),
						message: t("compactSuccessDesc", {
							percent: Math.round(contextPercentAfter),
						}),
						color: "green",
						autoClose: 3000,
					});
				}
			},
			onNarratorError: (error, errorCode) => {
				// Session error may leave synthetic streaming chunks in the cache.
				cancelPendingToolChunks(false, true);
				removeStreamingChunksMsg(qc, messagesQueryKey);
				streamingBlocksRef.current = [];
				clearStreamingState();
				const localizedError = localizeNarratorError(error, t, errorCode) ?? error;
				// Update narrator cache with localized error message
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old
						? { ...old, status: "idle", substatus: ["error"], errorMessage: localizedError }
						: old,
				);
				notifications.show({
					title: t("narratorError"),
					message: localizedError,
					color: "red",
					autoClose: 8000,
				});
			},
			onNarratorWarning: (info) => {
				if (info.retryCount != null && info.maxRetries != null && info.delayMs != null) {
					const ri = {
						message: info.message,
						retryCount: info.retryCount,
						maxRetries: info.maxRetries,
						retryAt: Date.now() + info.delayMs,
					};
					retryInfoRef.current = ri;
					setRetryInfo(ri);
				}
				notifications.show({
					title: t("narratorRetrying"),
					message: info.message,
					color: "yellow",
					autoClose: 10000,
				});
			},
			onLeakedToolCall: (info) => {
				// the recovered/unrecovered phases need the download dialog.
				if (info.phase === "stream_captured") return;
				setLeakedToolEvent({
					phase: info.phase,
					apiRequestId: info.apiRequestId,
					toolNames: info.toolNames,
					snippet: info.snippet,
				});
			},
			onModelChanged: (model) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, model } : old,
				);
			},
			onCatchUp: (orphanChildren, topLevel) => {
				// First catch-up response for this narratorId subscription received.
				firstCatchUpDoneRef.current = true;
				// Clean up any residual streaming chunks from before the disconnect
				cancelPendingToolChunks(true, true);
				removeStreamingChunksMsg(qc, messagesQueryKey);
				// When catch-up brings persisted top-level messages, clear stale streaming
				// text blocks that were restored from streaming_snapshot — the same content
				// is now in the persisted messages.  If the narrator is still streaming,
				// new stream_event frames will repopulate streamingBlocksRef immediately.
				if (topLevel.length > 0) {
					streamingBlocksRef.current = [];
					clearStreamingState();
				}
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					let result: MessagesQueryData = old;
					for (const child of orphanChildren) {
						if (child?.id && child?.parentToolUseId) {
							result = insertChildIntoCache(
								result,
								{
									...child,
									children: child.children ?? [],
								},
								toolUseIndexRef.current,
							) as MessagesQueryData;
						}
					}
					if (topLevel.length > 0) {
						const pages = [...result.pages];
						const firstPage = { ...pages[0] };
						const incomingById = new Map(
							topLevel
								.filter((m: NarratorMsg) => m?.id && m?.createdAt)
								.map((m: NarratorMsg) => [m.id, { ...m, children: m.children ?? [] }]),
						);
						let refreshedExisting = false;
						const updatedMessages = firstPage.messages.map((existing: NarratorMsg) => {
							if (existing.id === STREAMING_CHUNKS_MSG_ID) return existing;
							const fresh = incomingById.get(existing.id);
							if (!fresh) return existing;
							refreshedExisting = true;
							return {
								...existing,
								...fresh,
								children: fresh.children?.length ? fresh.children : (existing.children ?? []),
							};
						});
						const existingIds = new Set(updatedMessages.map((m: NarratorMsg) => m.id));
						const newMsgs = [...incomingById.values()].filter(
							(m: NarratorMsg) => !existingIds.has(m.id),
						);
						if (refreshedExisting || newMsgs.length > 0) {
							firstPage.messages = newMsgs.reduce(
								(messages, msg) => insertTopLevelMessageBySeq(messages, msg),
								updatedMessages,
							);
							pages[0] = firstPage;
							result = { ...result, pages };
						}
					}
					// Evict oldest pages in the same callback to avoid double render
					if (isAtBottomRef.current) {
						result = evictOldestPages(result, MAX_LIVE_MESSAGES) as MessagesQueryData;
					}
					return result;
				});
				if (isAtBottomRef.current) {
					requestAnimationFrame(() => scrollToBottom());
				}
			},
			onFullReload: () => {
				// Clean up synthetic streaming state before full reload.
				cancelPendingToolChunks(false, true);
				removeStreamingChunksMsg(qc, messagesQueryKey);
				streamingBlocksRef.current = [];
				clearStreamingState();
				// If this is the FIRST catch-up response for this narratorId
				// subscription (i.e. we just switched to this narrator), the REST
				// first page — fetched with cursor=undefined — already holds the
				// latest DESC page, which is exactly what a full reload would
				// produce. Skip the redundant invalidate to avoid a second REST
				// round-trip and the flicker it causes.
				if (!firstCatchUpDoneRef.current) {
					firstCatchUpDoneRef.current = true;
					return;
				}
				// Otherwise (reconnect / fell too far behind after staying on the
				// page) we must reload to backfill missed messages.
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			},
			onSyncOk: () => {
				// First catch-up response for this narratorId subscription received
				// (server confirmed we are already in sync).
				firstCatchUpDoneRef.current = true;
			},
			onMessagesDeleted: (deletedMessageIds: string[]) => {
				// Remove deleted messages from cache
				const deletedSet = new Set(deletedMessageIds);
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const pages = old.pages.map((page) => ({
						...page,
						messages: page.messages.filter((m: NarratorMsg) => !deletedSet.has(m.id)),
					}));
					return { ...old, pages };
				});
				// Deleting messages (rollback / edit-regenerate / retry / segment
				// compact undo) shrinks the history, so the last reported context
				// usage no longer reflects what the next request will send.
				dispatchStatus({ type: "patch", payload: { contextStale: true } });
			},
			onMessageUpdated: (updatedMsg: NarratorMsg) => {
				// Update the message in cache
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const pages = old.pages.map((page) => ({
						...page,
						messages: page.messages.map((m: NarratorMsg) =>
							m.id === updatedMsg.id ? { ...m, ...updatedMsg, children: m.children } : m,
						),
					}));
					return { ...old, pages };
				});
			},
			onBackgroundTaskCompleted: (_taskNarratorId, toolUseId, resultPreview) => {
				// Update the tool call status in cache to reflect completion
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					const result = updateToolCallByIndex(
						old,
						toolUseId,
						"success",
						[{ type: "text", text: resultPreview }],
						toolUseIndexRef.current,
					);
					return result;
				});
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				notifications.show({
					title: t("backgroundTasks.completed"),
					message: resultPreview?.slice(0, 100) || "",
					color: "green",
					autoClose: 5000,
				});
			},
			onBackgroundTaskFailed: (_taskNarratorId, toolUseId, error) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					let result = updateToolCallByIndex(
						old,
						toolUseId,
						"fail",
						[{ type: "text", text: error }],
						toolUseIndexRef.current,
					);
					if (result) {
						result = mergeFieldsByIndex(
							result,
							toolUseId,
							{ errorMessage: error },
							toolUseIndexRef.current,
						);
					}
					return result;
				});
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
				notifications.show({
					title: t("backgroundTasks.failed"),
					message: error?.slice(0, 100) || "",
					color: "red",
					autoClose: 8000,
				});
			},
			onBackgroundTaskCancelled: (_taskNarratorId, toolUseId) => {
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return updateToolCallByIndex(
						old,
						toolUseId,
						"cancelled",
						[{ type: "text", text: "Cancelled" }],
						toolUseIndexRef.current,
					);
				});
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			},
			onBackgroundTaskStatusChanged: () => {
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			},
			onBackgroundTaskOutput: () => {
				qc.invalidateQueries({ queryKey: ["background-tasks", narratorId] });
			},
			onPresenceUpdate: (v) => {
				setViewers(v);
			},
			onStreamingReset: (parentToolUseId) => {
				// A reasoning-only dead turn was discarded server-side. Drop any live
				// top-level streaming blocks (e.g. the reasoning being shown) so the UI
				// does not keep stale reasoning that will never be persisted.
				// Subagent (parentToolUseId) streaming lives in the message cache and is
				// handled by the chunks WS hook, so only clear top-level state here.
				if (parentToolUseId) return;
				const hadStreaming = streamingBlocksRef.current.length > 0;
				streamingBlocksRef.current = [];
				cancelPendingToolChunks(true, false);
				if (hadStreaming) {
					clearStreamingState();
				}
			},
			onStreamingSnapshot: (snapshot) => {
				// Restore ordered streaming blocks from server snapshot
				if (snapshot.streamingBlocks.length > 0) {
					streamingBlocksRef.current = [...snapshot.streamingBlocks];
					flushStreamingVersion();
				}

				// Restore tool chunks
				if (snapshot.toolChunks.length > 0) {
					let topLevelChanged = false;
					for (const chunk of snapshot.toolChunks) {
						if (chunk.parentToolUseId) {
							// Subagent chunk — upsert into message cache
							scheduleCacheUpdate((old) => {
								if (!old?.pages?.length || !chunk.parentToolUseId) return old;
								return upsertSubagentStreamingChunk(
									old,
									chunk.parentToolUseId,
									narratorId,
									chunk.toolUseId,
									chunk.toolName,
									chunk.inputCharsTotal,
									toolUseIndexRef.current,
									chunk.extractedFilePath,
									chunk.contentCharsReceived,
									chunk.extractedFields,
									chunk.metadata,
								) as MessagesQueryData;
							});
						} else if (chunk.started) {
							// Tool already started executing — render as real tool card
							if (!topLevelStreamingCreatedAtRef.current) {
								topLevelStreamingCreatedAtRef.current = new Date().toISOString();
							}
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: -1, // sentinel: no longer streaming
								_started: true,
								_input: chunk.input,
								_startedAt: chunk.streamStartedAt,
								_streamingOutput: chunk.streamingOutput,
								_metadata: chunk.metadata,
								// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
							} as any);
							topLevelChanged = true;
						} else {
							// Still streaming input — render as streaming indicator
							if (!topLevelStreamingCreatedAtRef.current) {
								topLevelStreamingCreatedAtRef.current = new Date().toISOString();
							}
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
								extractedFields: chunk.extractedFields,
								metadata: chunk.metadata,
							});

							topLevelChanged = true;
						}
					}
					if (topLevelChanged) {
						bumpLegacyTopLevelStreamingChunksVersion();
					}
				}
			},
		},
		lastMessageId,
		{ trackRealtimeMessageVersion: legacyMessageCacheUpdatesEnabled },
	);

	// Keep refs in sync
	sendPermissionDecisionRef.current = sendPermissionDecision;

	// --- Load pending permissions on mount/reconnect ---
	const prevConnectedRef = useRef(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetch on mount and reconnect
	useEffect(() => {
		if (!connected && prevConnectedRef.current) {
			prevConnectedRef.current = false;
			return;
		}
		const isReconnect = connected && prevConnectedRef.current === false;
		if (connected) prevConnectedRef.current = true;

		// On reconnect, if the narrator is no longer working, the WS catch-up
		// may have missed messages (e.g. user switched tabs while AI was running).
		// Skip this for bounded around-windows, where refetching would still keep a
		// truncated view and only add network churn.
		if (isReconnect && narratorStatus !== "working" && !firstPageHasMoreAfter) {
			// Clear stale streaming state — the narrator is no longer working so any
			// leftover streamingBlocksRef content from a previous streaming_snapshot
			// would duplicate text that is now in the persisted messages.
			streamingBlocksRef.current = [];
			cancelPendingToolChunks(true, true);
			clearStreamingState();
			if (legacyMessageCacheUpdatesEnabled) {
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			}
		}

		api
			.getPendingPermissions(narratorId)
			.then((perms) => {
				if (perms.length > 0) {
					setPendingPermsMap((prev) => {
						const next = new Map(prev);
						for (const p of perms) {
							if (
								p.toolUseId &&
								(!isReflectionPermissionLike(p) || isActiveReflectionPermissionLike(p))
							) {
								next.set(p.toolUseId, p);
							}
						}
						return next;
					});
					if (legacyMessageCacheUpdatesEnabled) {
						qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) =>
							applyPendingPermissionsToCache(old, perms, toolUseIndexRef.current),
						);
					}
				}
			})
			.catch(() => {});
		api
			.getBufferedMessages(narratorId)
			.then((msgs) => setQueuedMessages(msgs ?? []))
			.catch(() => {});
	}, [narratorId, connected, legacyMessageCacheUpdatesEnabled]);

	// --- Fallback polling for permissions ---
	useEffect(() => {
		if (narratorStatus !== "waiting" || pendingPermsMap.size > 0) return;
		let cancelled = false;
		const poll = () => {
			api
				.getPendingPermissions(narratorId)
				.then((perms) => {
					if (cancelled) return;
					if (perms.length > 0) {
						setPendingPermsMap((prev) => {
							const next = new Map(prev);
							for (const p of perms) {
								if (
									p.toolUseId &&
									(!isReflectionPermissionLike(p) || isActiveReflectionPermissionLike(p))
								) {
									next.set(p.toolUseId, p);
								}
							}
							return next;
						});
						if (legacyMessageCacheUpdatesEnabled) {
							qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) =>
								applyPendingPermissionsToCache(old, perms, toolUseIndexRef.current),
							);
						}
					}
				})
				.catch(() => {});
		};
		poll();
		const timer = setInterval(poll, 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [
		narratorId,
		narratorStatus,
		pendingPermsMap.size,
		messagesQueryKey,
		qc,
		legacyMessageCacheUpdatesEnabled,
	]);

	// --- Mark "done" narrator as read ---
	// With substatus refactor, "done" is now idle + substatus includes "unread".
	const hasUnreadSubstatus = substatus.includes("unread");
	useEffect(() => {
		// Do not auto-clear unread while the page is in the background.
		if (!pageVisible) return;
		// Subagents must stay in done/error so follow-up Send can pick them up.
		if (isSubagent) return;
		// Preserve error sessions: do not auto-clear when an error exists.
		if (narratorStatus === "idle" && hasUnreadSubstatus && !narratorErrorMessage) {
			// Optimistically remove only the unread tag so coexisting transient tags
			// (for example background_compacting) keep their visible state.
			const nextSubstatus = withoutSubstatusTag(statusState.substatus, "unread");
			dispatchStatus({ type: "patch", payload: { substatus: nextSubstatus } });
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old
					? { ...old, status: "idle", substatus: withoutSubstatusTag(old.substatus, "unread") }
					: old,
			);
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [
		narratorId,
		narratorStatus,
		hasUnreadSubstatus,
		narratorErrorMessage,
		isSubagent,
		pageVisible,
		qc,
		statusState.substatus,
	]);

	// --- Derive compacting substatus from persisted messages ---
	// On initial load (before WS connects), detect if the last message has an
	// active compact block and seed the substatus accordingly.
	useEffect(() => {
		if (suppressMessageDerivedCompactingRef.current) return;
		if (!messagesData?.pages?.length) return;
		const firstPage = messagesData.pages[0];
		const msgs = firstPage?.messages;
		if (!msgs?.length) return;
		const last = msgs[msgs.length - 1];
		const blocks = Array.isArray(last.contentJson) ? last.contentJson : [];
		const compactBlock = blocks.find(
			(b: ContentBlock) => b.type === "compact" && b.subtype !== "plan",
		);
		if (compactBlock && compactBlock.status === "compacting") {
			const compactSubstatus =
				compactBlock.mode === "background" ? "background_compacting" : "compacting";
			dispatchStatus({
				type: "patch",
				payload: { substatus: withCompactingSubstatus(statusState.substatus, compactSubstatus) },
			});
		}
	}, [messagesData, statusState.substatus]);

	return useMemo(
		() => ({
			connected,
			disconnected,
			reconnect,
			sendBufferMessage,
			cancelBuffer,
			sendPermissionDecision,
			streamingVersion,
			topLevelStreamingChunks,
			streamingBlocksRef,
			pendingPermsMap,
			pendingPermission,
			renderPermCb,
			queuedMessages,
			setQueuedMessages,
			substatus,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			paymentRequired,
			setPaymentRequired,
			leakedToolEvent,
			setLeakedToolEvent,
			currentTodos,
			todosToolUseId,
			expandedToolUseId,
			setExpandedToolUseId,
			unreadCount,
			setUnreadCount,
			viewers,
		}),
		// Note: streamingBlocksRef (useRef) and useState setters (setQueuedMessages,
		// setExpandedToolUseId, setUnreadCount, setPaymentRequired)
		// are stable references and intentionally omitted from the dependency array.
		[
			connected,
			disconnected,
			reconnect,
			sendBufferMessage,
			cancelBuffer,
			sendPermissionDecision,
			streamingVersion,
			topLevelStreamingChunks,
			pendingPermsMap,
			pendingPermission,
			renderPermCb,
			queuedMessages,
			substatus,
			contextPercent,
			setContextPercent,
			contextStale,
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			quotaBalance,
			detailedQuotaBalance,
			browserSessionCount,
			browserVisualChange,
			retryInfo,
			paymentRequired,
			leakedToolEvent,
			currentTodos,
			todosToolUseId,
			expandedToolUseId,
			unreadCount,
			viewers,
		],
	);
}
