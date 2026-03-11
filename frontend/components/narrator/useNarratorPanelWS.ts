import { notifications } from "@mantine/notifications";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useInterruptNarrator } from "../../hooks/useNarrator";
import { useNarratorWS } from "../../hooks/useNarratorWS";
import { api } from "../../lib/api";
import {
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
	streamingRef: React.RefObject<string>;
	streamingReasoningRef: React.RefObject<string>;
	streamingVersion: number;
	topLevelStreamingChunks: NarratorMsg | null;
	webSearchRef: React.RefObject<{
		id: string;
		status: "in_progress" | "searching" | "completed";
		query?: string;
	} | null>;
	// Permissions
	pendingPermsMap: Map<string, PendingPermission>;
	pendingPermission: PendingPermission | null;
	renderPermCb: PermissionCallbacks;
	// State
	queuedMessages: Array<{ id: string; text: string; bufferedAt: string }>;
	setQueuedMessages: React.Dispatch<
		React.SetStateAction<Array<{ id: string; text: string; bufferedAt: string }>>
	>;
	isCompacting: boolean;
	contextPercent: number | null;
	setContextPercent: React.Dispatch<React.SetStateAction<number | null>>;
	promptTokens: number | null;
	contextWindow: number | null;
	pruneBoundaryMessageId: string | null;
	prunedPercent: number | null;
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
	} = opts;
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const interruptMutation = useInterruptNarrator();

	// --- Streaming state ---
	const streamingRef = useRef("");
	const streamingReasoningRef = useRef("");
	const [streamingVersion, setStreamingVersion] = useState(0);
	const [topLevelChunksVersion, bumpTopLevelStreamingChunksVersion] = useState(0);
	// Native web search status (Codex web_search tool) — stored as ref to avoid extra re-renders;
	// streamingVersion bump handles the render trigger.
	const webSearchRef = useRef<{
		id: string;
		status: "in_progress" | "searching" | "completed";
		query?: string;
	} | null>(null);

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
			}
		>
	>(new Map());
	const topLevelStreamingCreatedAtRef = useRef<string | null>(null);
	const toolChunkRafRef = useRef(0);

	// Cancel pending RAF handles on unmount
	useEffect(() => {
		return () => {
			if (streamingRafRef.current) cancelAnimationFrame(streamingRafRef.current);
			if (toolChunkRafRef.current) cancelAnimationFrame(toolChunkRafRef.current);
		};
	}, []);

	// Helper: immediately flush streaming version (for clear/reset paths)
	const clearStreamingState = useCallback(() => {
		if (streamingRafRef.current) {
			cancelAnimationFrame(streamingRafRef.current);
			streamingRafRef.current = 0;
		}
		setStreamingVersion((v) => v + 1);
	}, []);

	// Helper: cancel any pending tool chunk RAF and clear temporary streaming tool state.
	const cancelPendingToolChunks = useCallback((notify = true) => {
		pendingToolChunkRef.current.clear();
		const hadTopLevelChunks = topLevelStreamingChunkRef.current.size > 0;
		topLevelStreamingChunkRef.current.clear();
		topLevelStreamingCreatedAtRef.current = null;
		if (toolChunkRafRef.current) {
			cancelAnimationFrame(toolChunkRafRef.current);
			toolChunkRafRef.current = 0;
		}
		if (notify && hadTopLevelChunks) {
			bumpTopLevelStreamingChunksVersion((v) => v + 1);
		}
	}, []);

	// --- Permission state ---
	const [pendingPermsMap, setPendingPermsMap] = useState<Map<string, PendingPermission>>(
		() => new Map(),
	);
	const pendingPermission = useMemo<PendingPermission | null>(() => {
		if (pendingPermsMap.size === 0) return null;
		return pendingPermsMap.values().next().value ?? null;
	}, [pendingPermsMap]);

	// --- Misc state ---
	const [queuedMessages, setQueuedMessages] = useState<
		Array<{ id: string; text: string; bufferedAt: string }>
	>([]);
	const [isCompacting, setIsCompacting] = useState(false);
	const [contextPercent, setContextPercent] = useState<number | null>(null);
	const [promptTokens, setPromptTokens] = useState<number | null>(null);
	const [contextWindow, setContextWindow] = useState<number | null>(null);
	const [pruneBoundaryMessageId, setPruneBoundaryMessageId] = useState<string | null>(null);
	const [prunedPercent, setPrunedPercent] = useState<number | null>(null);
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
		if (firstPage?.pruneBoundaryMessageId) {
			setPruneBoundaryMessageId(firstPage.pruneBoundaryMessageId);
		}
		if (firstPage?.prunedPercent != null) {
			setPrunedPercent(firstPage.prunedPercent);
		}
		const msgs = firstPage?.messages;
		if (!msgs?.length) return;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i] as unknown as Record<string, unknown>;
			const cp = m.contextPercent;
			if (cp != null) {
				setContextPercent(cp as number);
				// Restore promptTokens / contextWindow from turnUsageJson
				const tu = m.turnUsageJson as Record<string, number> | null | undefined;
				if (tu) {
					if (tu.input_tokens != null) setPromptTokens(tu.input_tokens);
					if (tu.context_window != null) setContextWindow(tu.context_window);
				} else if (m.tokensIn != null) {
					setPromptTokens(m.tokensIn as number);
				}
				break;
			}
		}
		contextInitRef.current = true;
	}, [messagesData]);

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
					};
				}
			} else {
				const next = upsertStreamingToolBlock(blocks, toolCalls, chunk.toolUseId, chunk.toolName, {
					_streamingChars: chunk.inputCharsTotal,
					...(chunk.extractedFilePath && { _streamingFilePath: chunk.extractedFilePath }),
					...(chunk.contentCharsReceived != null && {
						_streamingContentChars: chunk.contentCharsReceived,
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
		  ) => void)
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
			sendPermissionDecisionRef.current?.(
				requestId,
				decision,
				undefined,
				undefined,
				feedbackText,
				compactAfter,
				updatedPlan,
			);
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
		}),
		[],
	);
	const renderPermCb = useMemo(
		() => ({ ...stablePermCb, pendingPermission, pendingPermsMap, bgRetryDismissedIds }),
		[stablePermCb, pendingPermission, pendingPermsMap, bgRetryDismissedIds],
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
				if (ev?.type !== "content_block_delta" || !ev.delta?.text || ev.subagentToolUseId) {
					return;
				}
				if (ev.delta.type === "text_delta") {
					streamingRef.current += ev.delta.text;
					flushStreamingVersion();
					return;
				}
				if (ev.delta.type === "reasoning_delta") {
					streamingReasoningRef.current += ev.delta.text;
					flushStreamingVersion();
					return;
				}
			},
			onMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				const blocks = Array.isArray(wsData.message?.contentJson) ? wsData.message.contentJson : [];
				const compactBlock = blocks.find(
					(b: ContentBlock) => b.type === "compact" && b.subtype !== "plan",
				);
				if (compactBlock) {
					setIsCompacting(compactBlock.status === "compacting");
					if (compactBlock.status === "compacted" && wsData.message?.contextPercent != null) {
						setContextPercent(wsData.message.contextPercent as number);
					}
					if (compactBlock.status === "failed") {
						setIsCompacting(false);
					}
				} else {
					setIsCompacting(false);
				}
				if (wsData.message?.id && wsData.message?.createdAt) {
					const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };
					if (wsData.message?.role === "assistant") {
						if (streamingRef.current) {
							streamingRef.current = "";
						}
						if (streamingReasoningRef.current) {
							streamingReasoningRef.current = "";
						}
						webSearchRef.current = null;
						clearStreamingState();
						// Clear pending RAF chunks — real message supersedes synthetic state.
						// Notify (bump version) so topLevelStreamingChunks memo recomputes
						// to null immediately, since onToolStarted/onToolCompleted no longer
						// remove individual entries from the streaming ref.
						cancelPendingToolChunks(true);
						removeStreamingChunksMsg(qc, messagesQueryKey);
					}
					if (newMsg.parentToolUseId && wsData.message?.role === "assistant") {
						const ptuId = newMsg.parentToolUseId;
						qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
							if (!old?.pages?.length) return old;
							return removeSubagentStreamingChunk(old, ptuId, toolUseIndexRef.current);
						});
					}
					const isNewCompactMsg =
						newMsg.role === "system" &&
						Array.isArray(newMsg.contentJson) &&
						newMsg.contentJson.some((b: ContentBlock) => b.type === "compact");

					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						if (newMsg.parentToolUseId) {
							return insertChildIntoCache(old, newMsg, toolUseIndexRef.current);
						}
						const pages = [...old.pages];
						const firstPage = { ...pages[0] };
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
						if (isNewCompactMsg) return old;
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
						return { ...old, pages };
					});
					if (isNewCompactMsg) {
						qc.invalidateQueries({ queryKey: messagesQueryKey });
					}
				} else {
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			},
			onUserMessage: (wsData: { message?: NarratorMsg; [key: string]: unknown }) => {
				if (!wsData.message?.id || !wsData.message?.createdAt) return;
				const newMsg = { ...wsData.message, children: wsData.message.children ?? [] };
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
					const optimisticIdx = firstPage.messages.findIndex(
						(m: NarratorMsg) =>
							String(m.id).startsWith("optimistic-") &&
							m.role === "user" &&
							(m.contentText === newMsg.contentText ||
								(m.commandText && newMsg.commandText && m.commandText === newMsg.commandText)),
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
					return { ...old, pages };
				});
			},
			onToolCompleted: (
				toolUseId: string,
				status: string,
				output?: unknown,
				durationMs?: number,
				updatedInput?: Record<string, unknown>,
				metadata?: Record<string, unknown>,
			) => {
				// Discard any pending RAF chunk for this tool — real state takes precedence
				pendingToolChunkRef.current.delete(toolUseId);

				// Update the streaming chunk entry if it still exists (assistant_message
				// may not have arrived yet). Patch status/output/duration so the card
				// renders as completed while we wait for the real message.
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

				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
			onToolLongRunning: (toolUseId: string, _elapsed: number) => {
				// Mark the tool call as long-running so the UI can show a terminate button.
				// Update both the streaming chunk (if still active) and the query cache.

				// 更新流式 chunk 的 _longRunning 标记，使 topLevelStreamingChunks memo
				// 重算时传递给 ToolCallCard（streaming 阶段的渲染路径）
				const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
				if (streamingEntry) {
					topLevelStreamingChunkRef.current.set(toolUseId, {
						...streamingEntry,
						_longRunning: true,
						// biome-ignore lint/suspicious/noExplicitAny: sentinel fields on streaming chunk
					} as any);
					bumpTopLevelStreamingChunksVersion((v) => v + 1);
				}

				// 同时更新已持久化的消息缓存，确保 streaming chunk 被清除后
				// _longRunning 状态仍保留（query cache 渲染路径）
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ _longRunning: true },
						toolUseIndexRef.current,
					);
				});
			},
			onToolStarted: (
				toolUseId: string,
				toolName: string,
				streamStartedAt?: number,
				input?: Record<string, unknown>,
			) => {
				// Discard any pending RAF chunk for this tool — real state takes precedence
				pendingToolChunkRef.current.delete(toolUseId);

				// Promote the streaming chunk to a "started" state: remove the synthetic
				// _streamingChars marker so ToolCallCard renders it as a real (expandable)
				// tool card with the actual input. The chunk stays in the ref until
				// onMessage's cancelPendingToolChunks() clears it, preventing the card
				// from disappearing when assistant_message hasn't arrived yet.
				const streamingEntry = topLevelStreamingChunkRef.current.get(toolUseId);
				if (streamingEntry) {
					// Replace with a sentinel that marks it as "started" (no longer streaming).
					// We set inputCharsTotal to -1 as a flag — the memo builder will detect
					// this and produce a non-streaming tool call card.
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

				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return mergeFieldsByIndex(
						old,
						toolUseId,
						{ status: "running", startedAt: streamStartedAt ?? Date.now() },
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
			) => {
				// Accumulate the latest state for each toolUseId; flush once per frame
				pendingToolChunkRef.current.set(toolUseId, {
					toolUseId,
					toolName,
					inputCharsTotal,
					parentToolUseId,
					extractedFilePath,
					contentCharsReceived,
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
							qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
							topLevelStreamingChunkRef.current.set(chunk.toolUseId, {
								toolUseId: chunk.toolUseId,
								toolName: chunk.toolName,
								inputCharsTotal: chunk.inputCharsTotal,
								extractedFilePath: chunk.extractedFilePath,
								contentCharsReceived: chunk.contentCharsReceived,
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
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						return mergeFieldsByIndex(old, tuId, { status: "pending" }, toolUseIndexRef.current);
					});
				}
			},
			onPermissionResolved: (_requestId, toolUseId, updatedInput, decision, feedbackText) => {
				if (toolUseId) {
					setPendingPermsMap((prev) => {
						if (!prev.has(toolUseId)) return prev;
						const next = new Map(prev);
						next.delete(toolUseId);
						return next;
					});
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
				}
			},
			onStatusChange: (status) => {
				setIsCompacting(false);
				if (status === "idle") {
					if (streamingRef.current) {
						streamingRef.current = "";
					}
					if (streamingReasoningRef.current) {
						streamingReasoningRef.current = "";
					}
					webSearchRef.current = null;
					clearStreamingState();
				}
				if (status === "idle") {
					// Cancel any pending RAF tool chunk flush.
					cancelPendingToolChunks(false);
					removeStreamingChunksMsg(qc, messagesQueryKey);
				}
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, status } : old,
				);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
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
			onContextUsage: (percentage, promptTokens, contextWindow) => {
				setContextPercent(percentage);
				setPromptTokens(promptTokens ?? null);
				setContextWindow(contextWindow ?? null);
			},
			onPruneBoundary: (boundaryMessageId, prunedPct) => {
				setPruneBoundaryMessageId(boundaryMessageId);
				setPrunedPercent(prunedPct);
			},
			},
			onWebSearch: (id, status, query) => {
				webSearchRef.current = { id, status, query };
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
				setIsCompacting(true);
			},
			onCompactDone: () => {
				setIsCompacting(false);
				setPruneBoundaryMessageId(null);
				setPrunedPercent(null);
				cancelPendingToolChunks();
				removeStreamingChunksMsg(qc, messagesQueryKey);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			},
			onNarratorError: (error) => {
				// Session error may leave synthetic streaming chunks in the cache.
				cancelPendingToolChunks(false);
				removeStreamingChunksMsg(qc, messagesQueryKey);
				if (streamingRef.current) {
					streamingRef.current = "";
				}
				if (streamingReasoningRef.current) {
					streamingReasoningRef.current = "";
				}
				webSearchRef.current = null;
				clearStreamingState();
				notifications.show({
					title: t("narratorError"),
					message: error,
					color: "red",
					autoClose: 8000,
				});
			},
			onNarratorWarning: (message) => {
				notifications.show({
					title: t("narratorRetrying"),
					message,
					color: "yellow",
					autoClose: 10000,
				});
			},
			onCatchUp: (orphanChildren, topLevel) => {
				// Clean up any residual streaming chunks from before the disconnect
				cancelPendingToolChunks();
				removeStreamingChunksMsg(qc, messagesQueryKey);
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
					return result;
				});
				if (isAtBottomRef.current) {
					requestAnimationFrame(() => scrollToBottom(true));
				}
			},
			onFullReload: () => {
				// Clean up synthetic streaming state before full reload.
				cancelPendingToolChunks(false);
				removeStreamingChunksMsg(qc, messagesQueryKey);
				if (streamingRef.current) {
					streamingRef.current = "";
				}
				if (streamingReasoningRef.current) {
					streamingReasoningRef.current = "";
				}
				webSearchRef.current = null;
				clearStreamingState();
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			},
			onMessagesDeleted: (deletedMessageIds: string[]) => {
				// Remove deleted messages from cache
				const deletedSet = new Set(deletedMessageIds);
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
			},
			onBackgroundTaskFailed: (_taskNarratorId, toolUseId, error) => {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
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
			},
			onBackgroundTaskCancelled: (_taskNarratorId, toolUseId) => {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					return updateToolCallByIndex(
						old,
						toolUseId,
						"fail",
						[{ type: "text", text: "Cancelled" }],
						toolUseIndexRef.current,
					);
				});
			},
			onPresenceUpdate: (v) => {
				setViewers(v);
			},
		},
		lastMessageId,
	);

	// Keep refs in sync
	sendPermissionDecisionRef.current = sendPermissionDecision;
	sendBufferMessageRef.current = sendBufferMessage;

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

		// On reconnect, if the narrator is no longer thinking, the WS catch-up
		// may have missed messages (e.g. user switched tabs while AI was running).
		// Skip this for bounded around-windows, where refetching would still keep a
		// truncated view and only add network churn.
		if (isReconnect && narratorStatus !== "thinking" && !firstPageHasMoreAfter) {
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
	useEffect(() => {
		// Subagents must stay in done/error so ContinueTask can pick them up.
		if (isSubagent) return;
		// Preserve error sessions: do not auto-clear done->idle when an error exists.
		if (narratorStatus === "done" && !narratorErrorMessage) {
			// Optimistically update cache so the UI reflects "idle" immediately,
			// even if the WS event arrives late or is missed entirely.
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, status: "idle" } : old,
			);
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narratorStatus, narratorErrorMessage, isSubagent, qc]);

	// --- Derive isCompacting from persisted messages ---
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
		if (compactBlock) {
			setIsCompacting(compactBlock.status === "compacting");
		}
	}, [messagesData]);

	return {
		connected,
		disconnected,
		reconnect,
		sendBufferMessage,
		cancelBuffer,
		sendPermissionDecision,
		streamingRef,
		streamingReasoningRef,
		streamingVersion,
		topLevelStreamingChunks,
		webSearchRef,
		pendingPermsMap,
		pendingPermission,
		renderPermCb,
		queuedMessages,
		setQueuedMessages,
		isCompacting,
		contextPercent,
		setContextPercent,
		promptTokens,
		contextWindow,
		pruneBoundaryMessageId,
		prunedPercent,
		currentTodos,
		todosToolUseId,
		expandedToolUseId,
		setExpandedToolUseId,
		editExpandOverride,
		setEditExpandOverride,
		unreadCount,
		setUnreadCount,
		viewers,
	};
}
