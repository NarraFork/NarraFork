import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator } from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { api, type BufferMessageSummary } from "../../lib/api";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { localizeNarratorError } from "./error-localization";
import { clearToolBlockCache, type StreamingBlock } from "./message-segments";
import {
	evictOldestPages,
	findMsgByToolUseIdInTree,
	insertChildIntoCache,
	type MessageIndex,
	mergeFieldsByIndex,
	removeSubagentStreamingChunk,
	updateToolCallByIndex,
	updateToolUseIndex,
	upsertStreamingToolBlock,
	upsertSubagentStreamingChunk,
} from "./message-tree-utils";
import {
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

function getStreamingBlockOutputIndex(block: StreamingBlock): number | undefined {
	return "outputIndex" in block && typeof block.outputIndex === "number"
		? block.outputIndex
		: undefined;
}

function findStreamingInsertIndex(
	blocks: StreamingBlock[],
	outputIndex: number | undefined,
): number {
	if (outputIndex == null) return blocks.length;
	for (let i = 0; i < blocks.length; i++) {
		const currentOrder = getStreamingBlockOutputIndex(blocks[i]);
		if (currentOrder != null && currentOrder > outputIndex) return i;
	}
	return blocks.length;
}

export interface UseNarratorPanelWSOptions {
	narratorId: string;
	narratorStatus?: string;
	narratorErrorMessage?: string | null;
	messagesData?: { pages: MessagesPage[] };
	messagesQueryKey: readonly unknown[];
	/** Ref to isAtBottom state for unread tracking */
	isAtBottomRef: React.RefObject<boolean>;
	scrollToBottom: (instant?: boolean) => void;
	/** Narrator prop for initial todos */
	narratorTodosJson?: TodoItem[] | null;
	narratorTodosToolUseId?: string | null;
	/** Whether this narrator is a subagent — skip mark-read to preserve done/error status for ContinueTask */
	isSubagent?: boolean;
	/** Persisted substatus from narrator data — used to seed the reducer on mount so that
	 *  substatus survives page navigation (the WS-only path starts from []). */
	narratorSubstatus?: string[];
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
	promptTokens: number | null;
	contextWindow: number | null;
	isEstimated: boolean;
	activePruneStart: number | null;
	activeCompactStart: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
	// Browser sessions
	browserSessionCount: number;
	// Retry
	retryInfo: RetryInfo | null;
	// Todos
	currentTodos: TodoItem[] | null;
	todosToolUseId: string | null;
	// Tool expand
	expandedToolUseId: string | null;
	setExpandedToolUseId: React.Dispatch<React.SetStateAction<string | null>>;
	editExpandOverride: boolean | null;
	setEditExpandOverride: React.Dispatch<React.SetStateAction<boolean | null>>;
	// Unread
	unreadCount: number;
	setUnreadCount: React.Dispatch<React.SetStateAction<number>>;
	// Viewers
	viewers: ViewerInfo[];
}

/** Max messages to keep in cache while the user is at the bottom. */
const MAX_LIVE_MESSAGES = 200;

// --- Reducer for co-updated state ---
// These fields are frequently set together in the same WS callback
// (onStatusChange, onContextUsage, onPruneBoundary, onCompactDone, etc.).
// Merging them into a single useReducer avoids multiple independent re-renders
// per callback since React batches reducer dispatches into one update.

interface StatusState {
	substatus: string[];
	contextPercent: number | null;
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

function applyPendingPermissionsToCache(
	old: MessagesQueryData | undefined,
	perms: PendingPermission[],
	index: MessageIndex,
): MessagesQueryData | undefined {
	if (!old?.pages?.length || perms.length === 0) return old;
	let result = old as MessagesQueryData | undefined;
	for (const perm of perms) {
		if (!perm.toolUseId || !result) continue;
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
		isAtBottomRef,
		scrollToBottom,
		narratorTodosJson,
		narratorTodosToolUseId,
		isSubagent,
		narratorSubstatus,
	} = opts;
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const interruptMutation = useInterruptNarrator();

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
		if (!streamingRafRef.current) {
			streamingRafRef.current = requestAnimationFrame(() => {
				streamingRafRef.current = 0;
				setStreamingVersion((v) => v + 1);
			});
		}
	}, []);

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
				streamingFieldName?: string;
				streamingFieldValue?: string;
			}
		>
	>(new Map());
	const topLevelStreamingCreatedAtRef = useRef<string | null>(null);
	/** Accumulated streaming field value per tool (persists across RAF frames) */
	const toolStreamingFieldRef = useRef<Map<string, { name: string; value: string }>>(new Map());
	const toolChunkRafRef = useRef(0);

	// Cancel pending RAF handles and clear module-level streaming caches on unmount.
	useEffect(() => {
		return () => {
			if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current);
			if (toolChunkRafRef.current) cancelAnimationFrame(toolChunkRafRef.current);
			if (cacheUpdateRafRef.current) cancelAnimationFrame(cacheUpdateRafRef.current);
			streamingBlocksRef.current = [];
			pendingToolChunkRef.current.clear();
			toolStreamingFieldRef.current.clear();
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
		setStreamingVersion((v) => v + 1);
	}, []);

	// Helper: cancel any pending tool chunk RAF and clear temporary streaming tool state.
	// Only clears top-level chunks by default — subagent pending chunks (those with
	// parentToolUseId) are preserved so concurrent subagents don't lose their streaming
	// state when the parent narrator's assistant message arrives or another subagent
	// completes. Pass includeSubagent=true for terminal cleanup (status change, error).
	const cancelPendingToolChunks = useCallback((notify = true, includeSubagent = false) => {
		if (includeSubagent) {
			pendingToolChunkRef.current.clear();
			toolStreamingFieldRef.current.clear();
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
			bumpTopLevelStreamingChunksVersion((v) => v + 1);
		}
	}, []);

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
	// Flush all pending cache updaters synchronously in a single setQueryData call.
	const flushCacheUpdatesSync = useCallback(() => {
		if (cacheUpdateRafRef.current) {
			cancelAnimationFrame(cacheUpdateRafRef.current);
			cacheUpdateRafRef.current = 0;
		}
		const fns = pendingCacheUpdatesRef.current;
		if (fns.length === 0) return;
		pendingCacheUpdatesRef.current = [];
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			let result: MessagesQueryData | undefined | { pages: unknown[]; pageParams?: unknown[] } =
				old;
			for (const updater of fns) {
				result = updater(result as MessagesQueryData | undefined);
			}
			return result;
		});
	}, [qc, messagesQueryKey]);
	const scheduleCacheUpdate = useCallback(
		(fn: CacheUpdater) => {
			pendingCacheUpdatesRef.current.push(fn);
			if (!cacheUpdateRafRef.current) {
				cacheUpdateRafRef.current = requestAnimationFrame(() => {
					cacheUpdateRafRef.current = 0;
					const fns = pendingCacheUpdatesRef.current;
					if (fns.length === 0) return;
					pendingCacheUpdatesRef.current = [];
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						let result:
							| MessagesQueryData
							| undefined
							| { pages: unknown[]; pageParams?: unknown[] } = old;
						for (const updater of fns) {
							result = updater(result as MessagesQueryData | undefined);
						}
						return result;
					});
				});
			}
		},
		[qc, messagesQueryKey],
	);

	// --- Permission state ---
	const [pendingPermsMap, setPendingPermsMap] = useState<Map<string, PendingPermission>>(
		() => new Map(),
	);
	const pendingPermission = useMemo<PendingPermission | null>(() => {
		if (pendingPermsMap.size === 0) return null;
		return pendingPermsMap.values().next().value ?? null;
	}, [pendingPermsMap]);

	// Overseer review status for pending permissions — keyed by toolUseId
	const [overseerReviewMap, setOverseerReviewMap] = useState<Map<string, "reviewing" | "queued">>(
		() => new Map(),
	);

	// --- Misc state (co-updated fields merged into reducer) ---
	const [queuedMessages, setQueuedMessages] = useState<BufferMessageSummary[]>([]);
	const [statusState, dispatchStatus] = useReducer(statusReducer, {
		substatus: [],
		contextPercent: null,
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
		promptTokens,
		contextWindow,
		isEstimated,
		activePruneStart,
		activeCompactStart,
		pruneBoundaryMessageId,
		prunedPercent,
	} = statusState;

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
	const interruptCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (interruptCheckTimeoutRef.current) {
				clearTimeout(interruptCheckTimeoutRef.current);
				interruptCheckTimeoutRef.current = null;
			}
		};
	}, []);
	const [browserSessionCount, setBrowserSessionCount] = useState(0);
	);
	useEffect(() => {
		}
	const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
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
	const [editExpandOverride, setEditExpandOverride] = useState<boolean | null>(null);
	const [bgRetryDismissedIds, setBgRetryDismissedIds] = useState<Set<string>>(() => new Set());

	useEffect(() => {
		if (!expandedToolUseId) return;
		const timer = setTimeout(() => setExpandedToolUseId(null), 500);
		return () => clearTimeout(timer);
	}, [expandedToolUseId]);

	// --- Initialize contextPercent from initial data ---
	const contextInitRef = useRef(false);
	useEffect(() => {
		if (contextInitRef.current || !messagesData?.pages?.length) return;
		const firstPage = messagesData.pages[0];
		const patch: Partial<StatusState> = {};
		if (firstPage?.pruneBoundaryMessageId) {
			patch.pruneBoundaryMessageId = firstPage.pruneBoundaryMessageId;
		}
		if (firstPage?.prunedPercent != null) {
			patch.prunedPercent = firstPage.prunedPercent;
		}
		const msgs = firstPage?.messages;
		if (!msgs?.length) {
			if (Object.keys(patch).length > 0) {
				dispatchStatus({ type: "patch", payload: patch });
			}
			return;
		}
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as unknown as Record<string, unknown>;
			const cp = m.contextPercent;
			if (cp != null) {
				patch.contextPercent = cp as number;
				// Restore promptTokens / contextWindow / isEstimated from turnUsageJson
				const tu = m.turnUsageJson as Record<string, unknown> | null | undefined;
				if (tu) {
					if (tu.input_tokens != null) patch.promptTokens = tu.input_tokens as number;
					if (tu.context_window != null) patch.contextWindow = tu.context_window as number;
					patch.isEstimated = !!tu.is_estimated;
				} else if (m.tokensIn != null) {
					patch.promptTokens = m.tokensIn as number;
				}
				break;
			}
		}
		if (Object.keys(patch).length > 0) {
			dispatchStatus({ type: "patch", payload: patch });
		}
		contextInitRef.current = true;
	}, [messagesData]);

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
		const chunks = [...topLevelStreamingChunkRef.current.values()];
		if (chunks.length === 0) return null;

		let blocks: ContentBlock[] = [];
		let toolCalls = [] as NonNullable<NarratorMsg["toolCalls"]>;
		for (const chunk of chunks) {
			// biome-ignore lint/suspicious/noExplicitAny: extended sentinel fields
			const ext = chunk as any;
			if (ext._started) {
				// Tool has been promoted to "started" or "completed" — render as a real
				// tool call card with actual input instead of the streaming indicator.
				const inputJson = ext._input ?? {};
				const next = upsertStreamingToolBlock(
					blocks,
					toolCalls,
					chunk.toolUseId,
					chunk.toolName,
					inputJson,
				);
				blocks = next.blocks;
				toolCalls = next.toolCalls;
				// Patch status, timing, and output so the card reflects real state
				const tcIdx = toolCalls.findIndex((tc) => tc.toolUseId === chunk.toolUseId);
				if (tcIdx !== -1) {
					toolCalls[tcIdx] = {
						...toolCalls[tcIdx],
						status: ext._status ?? "running",
						...(ext._startedAt && { startedAt: ext._startedAt }),
						...(ext._output !== undefined && { outputJson: ext._output }),
						...(ext._durationMs != null && { durationMs: ext._durationMs }),
						...(ext._metadata && { _metadata: ext._metadata }),
						...(ext._longRunning && { _longRunning: true }),
						...(ext._streamingOutput && { _streamingOutput: ext._streamingOutput }),
					};
				}
			} else {
				const next = upsertStreamingToolBlock(blocks, toolCalls, chunk.toolUseId, chunk.toolName, {
					_streamingChars: chunk.inputCharsTotal,
					...(chunk.extractedFilePath && { _streamingFilePath: chunk.extractedFilePath }),
					...(chunk.contentCharsReceived != null && {
						_streamingContentChars: chunk.contentCharsReceived,
					}),
					...(chunk.extractedFields && { _streamingFields: chunk.extractedFields }),
					...(chunk.streamingFieldName && {
						_streamingFieldName: chunk.streamingFieldName,
					}),
					...(chunk.streamingFieldValue && {
						_streamingFieldValue: chunk.streamingFieldValue,
					}),
				});
				blocks = next.blocks;
				toolCalls = next.toolCalls;
			}
		}

		return {
			id: STREAMING_CHUNKS_MSG_ID,
			narratorId,
			parentToolUseId: null,
			role: "assistant",
			contentJson: blocks,
			contentText: null,
			toolCalls,
			createdAt: topLevelStreamingCreatedAtRef.current ?? new Date().toISOString(),
			children: [],
		};
	}, [topLevelChunksVersion, narratorId]);

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
	const sendBufferMessageRef = useRef<((targetNarratorId: string, text: string) => boolean) | null>(
		null,
	);
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
			const wsSent = sendPermissionDecisionRef.current?.(
				requestId,
				decision,
				undefined,
				undefined,
				feedbackText,
				compactAfter,
				updatedPlan,
			);
			// Fallback to HTTP API when WS send fails (e.g. reconnecting)
			if (!wsSent) {
				if (decision === "allow") {
					api.approvePermission(requestId).catch(() => {});
				} else {
					api.denyPermission(requestId, feedbackText).catch(() => {});
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
					// Optimistically update inputJson when plan was edited
					const inputUpdate =
						updatedPlan !== undefined && perm?.inputJson
							? { inputJson: { ...perm.inputJson, plan: updatedPlan } }
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
		[qc, messagesQueryKey, resolveAndRemovePerm],
	);

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
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
		[qc, messagesQueryKey, resolveAndRemovePerm],
	);

	const handleQuestionDeny = useCallback(
		(requestId: string) => {
			sendPermissionDecisionRef.current?.(requestId, "deny", "User skipped the question");
			const { toolUseId } = resolveAndRemovePerm(requestId);
			if (toolUseId) {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(old, toolUseId, { status: "fail" }, toolUseIndexRef.current);
				});
			}
		},
		[qc, messagesQueryKey, resolveAndRemovePerm],
	);

	const handleBgAgentRetry = useCallback(
		(toolUseId: string) => {
			setBgRetryDismissedIds((prev) => new Set(prev).add(toolUseId));
			sendBufferMessageRef.current?.(narratorId, t("bgAgentRetryPrompt"));
			interruptMutation.mutate(narratorId);
		},
		[narratorId, interruptMutation, t],
	);

	// --- Stable permission callbacks ---
	const permCbRef = useRef<PermissionCallbacks | null>(null);
	permCbRef.current = {
		pendingPermission,
		pendingPermsMap,
		onPermissionDecision: handlePermissionDecision,
		onQuestionSubmit: handleQuestionSubmit,
		onQuestionDeny: handleQuestionDeny,
		onBgAgentRetry: handleBgAgentRetry,
		bgRetryDismissedIds,
		overseerReviewMap,
	};
	const stablePermCb = useMemo<PermissionCallbacks>(
		() => ({
			pendingPermission: null,
			pendingPermsMap: new Map(),
			onPermissionDecision: (...args) => permCbRef.current?.onPermissionDecision(...args),
			onQuestionSubmit: (...args) => permCbRef.current?.onQuestionSubmit(...args),
			onQuestionDeny: (...args) => permCbRef.current?.onQuestionDeny(...args),
			onBgAgentRetry: (...args) => permCbRef.current?.onBgAgentRetry?.(...args),
			bgRetryDismissedIds: new Set(),
			overseerReviewMap: new Map(),
		}),
		[],
	);
	const renderPermCb = useMemo(
		() => ({
			...stablePermCb,
			pendingPermission,
			pendingPermsMap,
			bgRetryDismissedIds,
			overseerReviewMap,
		}),
		[stablePermCb, pendingPermission, pendingPermsMap, bgRetryDismissedIds, overseerReviewMap],
	);

	const firstPageHasMoreAfter = messagesData?.pages?.[0]?.hasMoreAfter ?? false;

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
				if (ev.delta.type === "text_delta") {
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
						if (existing.type === "text") existing.text += ev.delta.text;
					} else {
						const lastBlock = blocks[blocks.length - 1];
						if (lastBlock?.type === "text" && outputIndex == null) {
							lastBlock.text += ev.delta.text;
						} else {
							blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
								type: "text",
								text: ev.delta.text,
								...(outputIndex != null ? { outputIndex } : {}),
							});
						}
					}
					flushStreamingVersion();
					return;
				}
				if (ev.delta.type === "reasoning_delta") {
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
							existing.text += ev.delta.text;
							if (reasoningId) existing.id = reasoningId;
							if (outputIndex != null) existing.outputIndex = outputIndex;
						}
					} else {
						blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
							type: "reasoning",
							text: ev.delta.text,
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
					(b: ContentBlock) => b.type === "compact" && b.subtype !== "plan",
				);
				if (compactBlock) {
					const patch: Partial<StatusState> = {};
					if (compactBlock.status === "compacted" && wsData.message?.contextPercent != null) {
						patch.contextPercent = wsData.message.contextPercent as number;
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
								updated[existingIdx] = newMsg;
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
								updated[optimisticIdx] = newMsg;
								firstPage.messages = updated;
							} else {
								firstPage.messages = [...firstPage.messages, newMsg];
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
						setStreamingVersion((v) => v + 1);
						bumpTopLevelStreamingChunksVersion((v) => v + 1);
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

						updated[optimisticIdx] = newMsg;
						firstPage.messages = updated;
					} else {
						firstPage.messages = [...firstPage.messages, newMsg];
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
			) => {
				// Discard any pending RAF chunk and accumulated raw input for this tool
				pendingToolChunkRef.current.delete(toolUseId);
				toolStreamingFieldRef.current.delete(toolUseId);

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
							_output: output,
							_durationMs: durationMs,
							_metadata: metadata,
							// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
						} as any);
						bumpTopLevelStreamingChunksVersion((v) => v + 1);
					}
				}

				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					let result = updateToolCallByIndex(
						old,
						toolUseId,
						status,
						output,
						toolUseIndexRef.current,
						durationMs,
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
					return result;
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
						bumpTopLevelStreamingChunksVersion((v) => v + 1);
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
				// 实时更新 bash 工具的流式输出到已持久化的 tool call 上
				scheduleCacheUpdate((old) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ _streamingOutput: output },
						toolUseIndexRef.current,
					);
				});
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
						bumpTopLevelStreamingChunksVersion((v) => v + 1);
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
					// Extract timeout for bash tools so the timer can show elapsed/timeout
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
				streamingField?: { name: string; delta: string },
			) => {
				// Accumulate streaming field value across frames (not cleared per RAF)
				if (streamingField) {
					const prev = toolStreamingFieldRef.current.get(toolUseId);
					if (prev && prev.name === streamingField.name) {
						prev.value += streamingField.delta;
					} else {
						toolStreamingFieldRef.current.set(toolUseId, {
							name: streamingField.name,
							value: streamingField.delta,
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
								streamingFieldName: sf?.name,
								streamingFieldValue: sf?.value,
							});
							topLevelChanged = true;
						}
						if (topLevelChanged) {
							bumpTopLevelStreamingChunksVersion((v) => v + 1);
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
					// Clear overseer review status for this permission
					setOverseerReviewMap((prev) => {
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
			onOverseerReviewing: (_requestId, toolUseId, status) => {
				if (toolUseId) {
					if (status === "cleared") {
						setOverseerReviewMap((prev) => {
							if (!prev.has(toolUseId)) return prev;
							const next = new Map(prev);
							next.delete(toolUseId);
							return next;
						});
					} else {
						setOverseerReviewMap((prev) => {
							const next = new Map(prev);
							next.set(toolUseId, status);
							return next;
						});
					}
				}
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
			onPermissionModeChanged: (permissionMode) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, permissionMode } : old,
				);
			},
			onRelaxedPlanChanged: (relaxedPlan) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, relaxedPlan } : old,
				);
			},
			onContextUsage: (percentage, pTokens, ctxWindow, isEst, pruneStart, compactStart) => {
				dispatchStatus({
					type: "patch",
					payload: {
						contextPercent: percentage,
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
				// Sync back to settings cache so provider info stays up-to-date
					// biome-ignore lint/suspicious/noExplicitAny: dynamic settings shape
					qc.setQueryData(["settings"], (old: any) => {
						return {
							...old,
									quotaBalance: balance,
								},
							},
						};
					});
				}
			},
				// Queue position now comes via substatus_change — no-op here.
			},
			onQuotaBalance: (_balance) => {
				// Generic gateway quota balance — currently a no-op.
			},
			onQueueStatus: (_position, _queueDepth) => {
				// Queue position now comes via substatus_change — no-op here.
			},
			onBrowserSessionCount: (count) => {
				setBrowserSessionCount(count);
				qc.invalidateQueries({ queryKey: ["browser-sessions", narratorId] });
			},
			onWebSearch: (id, status, query, queries, outputIndex) => {
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
			onImageGeneration: (id, status, revisedPrompt, outputIndex) => {
				const blocks = streamingBlocksRef.current;
				const existingIdx = blocks.findIndex((b) => b.type === "image_generation" && b.id === id);
				if (existingIdx !== -1) {
					const existing = blocks[existingIdx];
					if (existing.type === "image_generation") {
						existing.status = status;
						if (revisedPrompt) existing.revisedPrompt = revisedPrompt;
						if (outputIndex != null) existing.outputIndex = outputIndex;
					}
				} else {
					blocks.splice(findStreamingInsertIndex(blocks, outputIndex), 0, {
						type: "image_generation",
						id,
						status,
						revisedPrompt,
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
			onCompactDone: (contextPercentAfter?: number, isSegment?: boolean) => {
				dispatchStatus({
					type: "patch",
					payload: {
						pruneBoundaryMessageId: null,
						prunedPercent: null,
					},
				});
				cancelPendingToolChunks(true, true);
				removeStreamingChunksMsg(qc, messagesQueryKey);
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
			onInterruptChecking: () => {
				// isCheckingInterrupt now comes via substatus_change.
				// Safety timeout: if the backend never sends interrupt_check_done
				// (e.g. WS glitch, backend crash), remove the checking_interrupt tag
				// after 20 s so the UI doesn't stay stuck forever.
				if (interruptCheckTimeoutRef.current) {
					clearTimeout(interruptCheckTimeoutRef.current);
				}
				interruptCheckTimeoutRef.current = setTimeout(() => {
					dispatchStatus({
						type: "patch",
						payload: {
							substatus: statusState.substatus.filter((s) => s !== "checking_interrupt"),
						},
					});
					interruptCheckTimeoutRef.current = null;
				}, 20_000);
			},
			onInterruptCheckDone: () => {
				// isCheckingInterrupt now comes via substatus_change.
				if (interruptCheckTimeoutRef.current) {
					clearTimeout(interruptCheckTimeoutRef.current);
					interruptCheckTimeoutRef.current = null;
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
			onModelChanged: (model) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, model } : old,
				);
			},
			onCatchUp: (orphanChildren, topLevel) => {
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
						const existingIds = new Set(firstPage.messages.map((m: NarratorMsg) => m.id));
						const newMsgs = topLevel
							.filter((m: NarratorMsg) => m?.id && m?.createdAt && !existingIds.has(m.id))
							.map((m: NarratorMsg) => ({ ...m, children: m.children ?? [] }));
						if (newMsgs.length > 0) {
							firstPage.messages = [...firstPage.messages, ...newMsgs];
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
				qc.invalidateQueries({ queryKey: messagesQueryKey });
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
							});
							topLevelChanged = true;
						}
					}
					if (topLevelChanged) {
						bumpTopLevelStreamingChunksVersion((v) => v + 1);
					}
				}
			},
		},
		lastMessageId,
	);

	// Keep refs in sync
	sendPermissionDecisionRef.current = sendPermissionDecision;
	sendBufferMessageRef.current = sendBufferMessage;

	// --- Sync on page navigation (mount with existing cache) ---
	// When the user navigates away and back, the global WS stays connected but
	// the component unmounts/remounts.  staleTime=Infinity means React Query
	// won't refetch, and the WS catch-up may not fire (lastMessageId was
	// cleared on unsubscribe).  Fix: on mount, if we already have cached data
	// (i.e. returning to the page), fetch the latest page and merge it.
	// NOTE: permissions and buffered messages are synced by the mount/reconnect
	// effect below — no need to duplicate here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: mount-only effect — intentionally runs once
	useEffect(() => {
		const cached = qc.getQueryData(messagesQueryKey) as MessagesQueryData | undefined;
		if (!cached?.pages?.length) return; // first load — nothing to sync
		if (firstPageHasMoreAfter) return; // around-mode (deep link) — skip

		let cancelled = false;

		// Fetch latest page and merge into cache
		api
			.getNarratorMessages(narratorId, { limit: 20 })
			.then((latestPage) => {
				if (cancelled) return;
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					const pages = [...old.pages];
					const firstPage = { ...pages[0] };
					const existingMap = new Map(firstPage.messages.map((m: NarratorMsg) => [m.id, m]));

					// Update existing messages with fresh data (children, tool status, etc.)
					const updatedMessages = firstPage.messages.map((existing: NarratorMsg) => {
						// Preserve synthetic messages
						if (existing.id === STREAMING_CHUNKS_MSG_ID) return existing;
						const fresh = latestPage.messages.find((m: NarratorMsg) => m.id === existing.id);
						if (!fresh) return existing;
						return { ...fresh, children: fresh.children ?? existing.children ?? [] };
					});

					// Append genuinely new messages
					const newMsgs = latestPage.messages
						.filter((m: NarratorMsg) => m.id && !existingMap.has(m.id))
						.map((m: NarratorMsg) => ({ ...m, children: m.children ?? [] }));

					firstPage.messages =
						newMsgs.length > 0 ? [...updatedMessages, ...newMsgs] : updatedMessages;
					pages[0] = firstPage;
					return { ...old, pages };
				});
			})
			.catch(() => {});

		return () => {
			cancelled = true;
		};
	}, []);

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
			qc.invalidateQueries({ queryKey: messagesQueryKey });
		}

		api
			.getPendingPermissions(narratorId)
			.then((perms) => {
				if (perms.length > 0) {
					setPendingPermsMap((prev) => {
						const next = new Map(prev);
						for (const p of perms) {
							if (p.toolUseId) next.set(p.toolUseId, p);
						}
						return next;
					});
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) =>
						applyPendingPermissionsToCache(old, perms, toolUseIndexRef.current),
					);
				}
			})
			.catch(() => {});
		api
			.getBufferedMessages(narratorId)
			.then((msgs) => setQueuedMessages(msgs ?? []))
			.catch(() => {});
	}, [narratorId, connected]);

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
								if (p.toolUseId) next.set(p.toolUseId, p);
							}
							return next;
						});
						qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) =>
							applyPendingPermissionsToCache(old, perms, toolUseIndexRef.current),
						);
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
	}, [narratorId, narratorStatus, pendingPermsMap.size, messagesQueryKey, qc]);

	// --- Mark "done" narrator as read ---
	// With substatus refactor, "done" is now idle + substatus includes "unread".
	const hasUnreadSubstatus = substatus.includes("unread");
	useEffect(() => {
		// Subagents must stay in done/error so ContinueTask can pick them up.
		if (isSubagent) return;
		// Preserve error sessions: do not auto-clear when an error exists.
		if (narratorStatus === "idle" && hasUnreadSubstatus && !narratorErrorMessage) {
			// Optimistically update cache so the UI reflects "idle" immediately,
			// even if the WS event arrives late or is missed entirely.
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, status: "idle", substatus: [] } : old,
			);
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narratorStatus, hasUnreadSubstatus, narratorErrorMessage, isSubagent, qc]);

	// --- Derive compacting substatus from persisted messages ---
	// On initial load (before WS connects), detect if the last message has an
	// active compact block and seed the substatus accordingly.
	useEffect(() => {
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
			dispatchStatus({
				type: "patch",
				payload: { substatus: ["compacting"] },
			});
		}
	}, [messagesData]);

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
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			browserSessionCount,
			retryInfo,
			currentTodos,
			todosToolUseId,
			expandedToolUseId,
			setExpandedToolUseId,
			editExpandOverride,
			setEditExpandOverride,
			unreadCount,
			setUnreadCount,
			viewers,
		}),
		// Note: streamingBlocksRef (useRef) and useState setters (setQueuedMessages,
		// setExpandedToolUseId, setEditExpandOverride, setUnreadCount) are stable
		// references and intentionally omitted from the dependency array.
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
			promptTokens,
			contextWindow,
			isEstimated,
			activePruneStart,
			activeCompactStart,
			pruneBoundaryMessageId,
			prunedPercent,
			browserSessionCount,
			retryInfo,
			currentTodos,
			todosToolUseId,
			expandedToolUseId,
			editExpandOverride,
			unreadCount,
			viewers,
		],
	);
}
