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
import { removeStreamingChunksMsg } from "./narrator-message-helpers";
import type {
	ContentBlock,
	MessagesPage,
	MessagesQueryData,
	NarratorMsg,
	PermissionCallbacks,
	TodoItem,
	ToolCallRow,
} from "./narrator-panel-types";
import { STREAMING_CHUNKS_MSG_ID } from "./narrator-panel-types";
import type { PendingPermission } from "./ToolCallCard";

export interface UseNarratorPanelWSOptions {
	narratorId: string;
	narratorStatus?: string;
	narratorErrorMessage?: string | null;
	messagesData?: { pages: MessagesPage[] };
	messagesQueryKey: unknown[];
	/** Ref to isAtBottom state for unread tracking */
	isAtBottomRef: React.RefObject<boolean>;
	scrollToBottom: (instant?: boolean) => void;
	/** Narrator prop for initial todos */
	narratorTodosJson?: TodoItem[] | null;
	narratorTodosToolUseId?: string | null;
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
	) => void;
	// Streaming
	streamingRef: React.RefObject<string>;
	streamingReasoningRef: React.RefObject<string>;
	streamingVersion: number;
	// Permissions
	pendingPermsMap: Map<string, PendingPermission>;
	pendingPermission: PendingPermission | null;
	renderPermCb: PermissionCallbacks;
	// State
	bufferedText: string | null;
	setBufferedText: React.Dispatch<React.SetStateAction<string | null>>;
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
	} = opts;
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const interruptMutation = useInterruptNarrator();

	// --- Streaming state ---
	const streamingRef = useRef("");
	const streamingReasoningRef = useRef("");
	const [streamingVersion, setStreamingVersion] = useState(0);

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

	// Helper: cancel any pending tool chunk RAF and clear the accumulator
	const cancelPendingToolChunks = useCallback(() => {
		pendingToolChunkRef.current.clear();
		if (toolChunkRafRef.current) {
			cancelAnimationFrame(toolChunkRafRef.current);
			toolChunkRafRef.current = 0;
		}
	}, []);

	// Helper: once any leading text/reasoning appears, streaming tool chunks should
	// render after StreamingBubble (not merged into the main message list above it).
	const markStreamingChunkNoMerge = useCallback(() => {
		qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
			if (!old?.pages?.length) return old;
			const pages = [...old.pages];
			const firstPage = { ...pages[0] };
			const idx = firstPage.messages.findIndex(
				(m: NarratorMsg) => m.id === STREAMING_CHUNKS_MSG_ID,
			);
			if (idx === -1) return old;
			const current = firstPage.messages[idx];
			if (current?._noMerge) return old;
			const updated = [...firstPage.messages];
			updated[idx] = { ...current, _noMerge: true };
			firstPage.messages = updated;
			pages[0] = firstPage;
			return { ...old, pages };
		});
	}, [qc, messagesQueryKey]);

	// --- Permission state ---
	const [pendingPermsMap, setPendingPermsMap] = useState<Map<string, PendingPermission>>(
		() => new Map(),
	);
	const pendingPermission = useMemo<PendingPermission | null>(() => {
		if (pendingPermsMap.size === 0) return null;
		return pendingPermsMap.values().next().value ?? null;
	}, [pendingPermsMap]);

	// --- Misc state ---
	const [bufferedText, setBufferedText] = useState<string | null>(null);
	const [isCompacting, setIsCompacting] = useState(false);
	const [contextPercent, setContextPercent] = useState<number | null>(null);
	const [promptTokens, setPromptTokens] = useState<number | null>(null);
	const [contextWindow, setContextWindow] = useState<number | null>(null);
	const [pruneBoundaryMessageId, setPruneBoundaryMessageId] = useState<string | null>(null);
	const [prunedPercent, setPrunedPercent] = useState<number | null>(null);
	const [unreadCount, setUnreadCount] = useState(0);

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

	// --- Permission decision refs ---
	const sendPermissionDecisionRef = useRef<
		| ((
				requestId: string,
				decision: "allow" | "deny",
				message?: string,
				answers?: Record<string, string>,
				feedbackText?: string,
				compactAfter?: boolean,
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
		) => {
			sendPermissionDecisionRef.current?.(
				requestId,
				decision,
				undefined,
				undefined,
				feedbackText,
				compactAfter,
			);
			const { toolUseId } = resolveAndRemovePerm(requestId);
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
					return mergeFieldsByIndex(old, toolUseId, { status: "running" }, toolUseIndexRef.current);
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
				const mergedInput = { ...perm.inputJson, answers };
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

	// --- lastMessageId for WS catch-up ---
	const lastMessageId = useMemo(() => {
		const pages = messagesData?.pages;
		if (!pages?.length) return undefined;
		const firstPage = pages[0];
		if (!firstPage?.messages?.length) return undefined;
		// Walk backwards to find the last real (non-synthetic) message
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
	}, [messagesData]);

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
					markStreamingChunkNoMerge();
					return;
				}
				if (ev.delta.type === "reasoning_delta") {
					streamingReasoningRef.current += ev.delta.text;
					flushStreamingVersion();
					markStreamingChunkNoMerge();
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
						clearStreamingState();
					}
					if (wsData.message?.role === "assistant") {
						// Clear pending RAF chunks — real message supersedes synthetic state
						cancelPendingToolChunks();
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
							if (Array.isArray(om.contentJson)) {
								for (const block of om.contentJson) {
									if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
								}
							}
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
					const optimisticIdx = firstPage.messages.findIndex(
						(m: NarratorMsg) =>
							String(m.id).startsWith("optimistic-") &&
							m.role === "user" &&
							m.contentText === newMsg.contentText,
					);
					if (optimisticIdx !== -1) {
						const updated = [...firstPage.messages];
						const om = updated[optimisticIdx];
						if (Array.isArray(om.contentJson)) {
							for (const block of om.contentJson) {
								if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
							}
						}
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
			) => {
				// Discard any pending RAF chunk for this tool — real state takes precedence
				pendingToolChunkRef.current.delete(toolUseId);

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
					return result;
				});
			},
			onToolStarted: (toolUseId: string, _toolName: string, streamStartedAt?: number) => {
				// Discard any pending RAF chunk for this tool — real state takes precedence
				pendingToolChunkRef.current.delete(toolUseId);

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

						// Apply all pending chunks in a single setQueryData call
						qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
							let result = old;
							for (const chunk of chunks) {
								if (!result) continue;
								if (chunk.parentToolUseId) {
									result = upsertSubagentStreamingChunk(
										result,
										chunk.parentToolUseId,
										narratorId,
										chunk.toolUseId,
										chunk.toolName,
										chunk.inputCharsTotal,
										toolUseIndexRef.current,
									) as MessagesQueryData;
									continue;
								}
								// Top-level streaming chunk
								const pages = result.pages?.length ? [...result.pages] : [];
								const firstPage =
									pages.length > 0
										? { ...pages[0] }
										: { messages: [], hasMore: false, nextCursor: null };
								const existingIdx = firstPage.messages.findIndex(
									(m: NarratorMsg) => m.id === STREAMING_CHUNKS_MSG_ID,
								);
								const existing = existingIdx !== -1 ? firstPage.messages[existingIdx] : null;

								const { blocks, toolCalls } = upsertStreamingToolBlock(
									existing ? [...(existing.contentJson as ContentBlock[])] : [],
									existing ? [...(existing.toolCalls as ToolCallRow[])] : [],
									chunk.toolUseId,
									chunk.toolName,
									{
										_streamingChars: chunk.inputCharsTotal,
										...(chunk.extractedFilePath && {
											_streamingFilePath: chunk.extractedFilePath,
										}),
										...(chunk.contentCharsReceived != null && {
											_streamingContentChars: chunk.contentCharsReceived,
										}),
									},
								);

								const hasLeadingContent = !!streamingRef.current || !!streamingReasoningRef.current;
								const syntheticMsg: NarratorMsg = {
									id: STREAMING_CHUNKS_MSG_ID,
									narratorId,
									parentToolUseId: null,
									role: "assistant",
									contentJson: blocks,
									contentText: null,
									toolCalls: toolCalls,
									createdAt: existing?.createdAt ?? new Date().toISOString(),
									children: [],
									_noMerge: hasLeadingContent,
								};
								if (existingIdx !== -1) {
									firstPage.messages = [...firstPage.messages];
									firstPage.messages[existingIdx] = syntheticMsg;
								} else {
									firstPage.messages = [...firstPage.messages, syntheticMsg];
								}
								pages[0] = firstPage;
								result = { ...result, pages } as MessagesQueryData;
							}
							return result;
						});
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
			onPermissionResolved: (_requestId, toolUseId) => {
				if (toolUseId) {
					setPendingPermsMap((prev) => {
						if (!prev.has(toolUseId)) return prev;
						const next = new Map(prev);
						next.delete(toolUseId);
						return next;
					});
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						return mergeFieldsByIndex(
							old,
							toolUseId,
							{ status: "running", startedAt: Date.now() },
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
					clearStreamingState();
				}
				if (status === "idle") {
					// Cancel any pending RAF tool chunk flush
					cancelPendingToolChunks();
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
			onBufferSet: (text) => {
				setBufferedText(text);
			},
			onBufferCleared: () => {
				setBufferedText(null);
			},
			onPlanModeChanged: (planMode) => {
				qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
					old ? { ...old, planMode } : old,
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
				// Session error may leave synthetic streaming chunks in the cache
				cancelPendingToolChunks();
				removeStreamingChunksMsg(qc, messagesQueryKey);
				if (streamingRef.current) {
					streamingRef.current = "";
				}
				if (streamingReasoningRef.current) {
					streamingReasoningRef.current = "";
				}
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
				// Clean up synthetic streaming state before full reload
				cancelPendingToolChunks();
				removeStreamingChunksMsg(qc, messagesQueryKey);
				if (streamingRef.current) {
					streamingRef.current = "";
				}
				if (streamingReasoningRef.current) {
					streamingReasoningRef.current = "";
				}
				clearStreamingState();
				qc.invalidateQueries({ queryKey: messagesQueryKey });
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
		// Force a refetch so the UI shows the latest state.
		if (isReconnect && narratorStatus !== "thinking") {
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
					qc.invalidateQueries({ queryKey: messagesQueryKey });
				}
			})
			.catch(() => {});
		api
			.getBufferedMessage(narratorId)
			.then((buf) => setBufferedText(buf?.text ?? null))
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
						qc.invalidateQueries({ queryKey: messagesQueryKey });
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
	}, [narratorId, narratorStatus, pendingPermsMap.size, messagesQueryKey, qc.invalidateQueries]);

	// --- Mark "done" narrator as read ---
	useEffect(() => {
		// Preserve error sessions: do not auto-clear done->idle when an error exists.
		if (narratorStatus === "done" && !narratorErrorMessage) {
			// Optimistically update cache so the UI reflects "idle" immediately,
			// even if the WS event arrives late or is missed entirely.
			qc.setQueryData(["narrators", narratorId], (old: Record<string, unknown> | undefined) =>
				old ? { ...old, status: "idle" } : old,
			);
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narratorStatus, narratorErrorMessage, qc]);

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
		pendingPermsMap,
		pendingPermission,
		renderPermCb,
		bufferedText,
		setBufferedText,
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
	};
}
