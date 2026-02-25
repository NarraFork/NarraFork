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
	mergeToolCallFieldsInTree,
	removeSubagentStreamingChunk,
	updateToolCallByIndex,
	updateToolUseIndex,
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
	sendBufferMessage: (narratorId: string, text: string) => void;
	cancelBuffer: (narratorId: string) => void;
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
	const [streamingVersion, setStreamingVersion] = useState(0);

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
			const cp = (msgs[i] as unknown as Record<string, unknown>).contextPercent;
			if (cp != null) {
				setContextPercent(cp as number);
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
	const sendBufferMessageRef = useRef<((targetNarratorId: string, text: string) => void) | null>(
		null,
	);
	const pendingPermsMapRef = useRef(pendingPermsMap);
	pendingPermsMapRef.current = pendingPermsMap;

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
			const map = pendingPermsMapRef.current;
			let toolUseId: string | undefined;
			for (const [tuId, perm] of map) {
				if (perm.id === requestId || tuId === requestId) {
					toolUseId = tuId;
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
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, {
							status: "running",
						});
						if (changed) anyChanged = true;
						return changed ? { ...page, messages } : page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
			}
		},
		[qc, messagesQueryKey],
	);

	const handleQuestionSubmit = useCallback(
		(requestId: string, answers: Record<string, string>) => {
			sendPermissionDecisionRef.current?.(requestId, "allow", undefined, answers);
			const map = pendingPermsMapRef.current;
			let perm: PendingPermission | undefined;
			for (const [, p] of map) {
				if (p.id === requestId || p.toolUseId === requestId) {
					perm = p;
					break;
				}
			}
			if (perm?.toolUseId) {
				const tuId = perm.toolUseId;
				const mergedInput = { ...perm.inputJson, answers };
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const { messages: m1, changed: c1 } = mergeToolCallFieldsInTree(page.messages, tuId, {
							inputJson: mergedInput,
							status: "running",
						});
						if (c1) anyChanged = true;
						return c1 ? { ...page, messages: m1 } : page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					next.delete(tuId);
					return next;
				});
			} else {
				setPendingPermsMap(new Map());
			}
		},
		[qc, messagesQueryKey],
	);

	const handleQuestionDeny = useCallback(
		(requestId: string) => {
			sendPermissionDecisionRef.current?.(requestId, "deny", "User skipped the question");
			const map = pendingPermsMapRef.current;
			let toolUseId: string | undefined;
			for (const [tuId, p] of map) {
				if (p.id === requestId || tuId === requestId) {
					toolUseId = tuId;
					break;
				}
			}
			if (toolUseId) {
				setPendingPermsMap((prev) => {
					const next = new Map(prev);
					next.delete(toolUseId);
					return next;
				});
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, {
							status: "fail",
						});
						if (changed) anyChanged = true;
						return changed ? { ...page, messages } : page;
					});
					return anyChanged ? { ...old, pages } : old;
				});
			} else {
				setPendingPermsMap(new Map());
			}
		},
		[qc, messagesQueryKey],
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
		const last = firstPage.messages[firstPage.messages.length - 1];
		if (!last) return undefined;
		let deepest: NarratorMsg = last;
		while (deepest.children?.length) {
			deepest = deepest.children[deepest.children.length - 1];
		}
		return deepest.id as string | undefined;
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
				if (
					ev?.type === "content_block_delta" &&
					ev.delta?.type === "text_delta" &&
					ev.delta.text &&
					!ev.subagentToolUseId
				) {
					streamingRef.current += ev.delta.text;
					setStreamingVersion((v) => v + 1);
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
					if (wsData.message?.role === "assistant" && streamingRef.current) {
						streamingRef.current = "";
						setStreamingVersion((v) => v + 1);
					}
					if (wsData.message?.role === "assistant") {
						removeStreamingChunksMsg(qc, messagesQueryKey);
					}
					if (newMsg.parentToolUseId && wsData.message?.role === "assistant") {
						const ptuId = newMsg.parentToolUseId;
						qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
							if (!old?.pages?.length) return old;
							return removeSubagentStreamingChunk(old, ptuId);
						});
					}
					const isNewCompactMsg =
						newMsg.role === "system" &&
						Array.isArray(newMsg.contentJson) &&
						newMsg.contentJson.some((b: ContentBlock) => b.type === "compact");

					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						if (newMsg.parentToolUseId) {
							return insertChildIntoCache(old, newMsg);
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
						const optimistic = firstPage.messages.filter(
							(m: NarratorMsg) => String(m.id).startsWith("optimistic-") && m.role === newMsg.role,
						);
						for (const om of optimistic) {
							if (Array.isArray(om.contentJson)) {
								for (const block of om.contentJson) {
									if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
								}
							}
						}
						const withoutOptimistic = firstPage.messages.filter(
							(m: NarratorMsg) => !String(m.id).startsWith("optimistic-") || m.role !== newMsg.role,
						);
						firstPage.messages = [...withoutOptimistic, newMsg];
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
					const optimistic = firstPage.messages.filter(
						(m: NarratorMsg) => String(m.id).startsWith("optimistic-") && m.role === "user",
					);
					for (const om of optimistic) {
						if (Array.isArray(om.contentJson)) {
							for (const block of om.contentJson) {
								if (block.previewUrl) URL.revokeObjectURL(block.previewUrl);
							}
						}
					}
					const withoutOptimistic = firstPage.messages.filter(
						(m: NarratorMsg) => !String(m.id).startsWith("optimistic-") || m.role !== "user",
					);
					firstPage.messages = [...withoutOptimistic, newMsg];
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
						let anyChanged = false;
						// biome-ignore lint/suspicious/noExplicitAny: dynamic cache structure
						const pages = result.pages.map((page: any) => {
							const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, {
								inputJson: updatedInput,
							});
							if (changed) anyChanged = true;
							return changed ? { ...page, messages } : page;
						});
						if (anyChanged) result = { ...result, pages } as MessagesQueryData;
					}
					return result;
				});
			},
			onToolStarted: (toolUseId: string, _toolName: string, streamStartedAt?: number) => {
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					let anyChanged = false;
					const pages = old.pages.map((page: MessagesPage) => {
						const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, {
							status: "running",
							startedAt: streamStartedAt ?? Date.now(),
						});
						if (changed) anyChanged = true;
						return changed ? { ...page, messages } : page;
					});
					return anyChanged ? { ...old, pages } : old;
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
				if (parentToolUseId) {
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						return upsertSubagentStreamingChunk(
							old,
							parentToolUseId,
							narratorId,
							toolUseId,
							toolName,
							inputCharsTotal,
						);
					});
					return;
				}
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					const pages = old?.pages?.length ? [...old.pages] : [];
					const firstPage =
						pages.length > 0 ? { ...pages[0] } : { messages: [], hasMore: false, nextCursor: null };
					const existingIdx = firstPage.messages.findIndex(
						(m: NarratorMsg) => m.id === STREAMING_CHUNKS_MSG_ID,
					);
					const existing = existingIdx !== -1 ? firstPage.messages[existingIdx] : null;
					const prevBlocks: ContentBlock[] = existing
						? [...(existing.contentJson as ContentBlock[])]
						: [];
					const prevToolCalls = existing ? [...(existing.toolCalls as ToolCallRow[])] : [];
					const blockIdx = prevBlocks.findIndex(
						(b: ContentBlock) => b.type === "tool_use" && b.id === toolUseId,
					);
					if (blockIdx === -1) {
						prevBlocks.push({ type: "tool_use", id: toolUseId, name: toolName, input: {} });
						prevToolCalls.push({
							toolUseId,
							toolName,
							inputJson: {},
							status: "initializing",
							createdAt: new Date().toISOString(),
						} as ToolCallRow);
					}
					const tcIdx = prevToolCalls.findIndex((tc: ToolCallRow) => tc.toolUseId === toolUseId);
					if (tcIdx !== -1) {
						prevToolCalls[tcIdx] = {
							...prevToolCalls[tcIdx],
							inputJson: {
								_streamingChars: inputCharsTotal,
								...(extractedFilePath && { _streamingFilePath: extractedFilePath }),
								...(contentCharsReceived != null && {
									_streamingContentChars: contentCharsReceived,
								}),
							},
						};
					}
					const hasLeadingText = !!streamingRef.current;
					const syntheticMsg: NarratorMsg = {
						id: STREAMING_CHUNKS_MSG_ID,
						narratorId,
						parentToolUseId: null,
						role: "assistant",
						contentJson: prevBlocks,
						contentText: null,
						toolCalls: prevToolCalls,
						createdAt: existing?.createdAt ?? new Date().toISOString(),
						children: [],
						_noMerge: hasLeadingText,
					};
					if (existingIdx !== -1) {
						firstPage.messages = [...firstPage.messages];
						firstPage.messages[existingIdx] = syntheticMsg;
					} else {
						firstPage.messages = [...firstPage.messages, syntheticMsg];
					}
					pages[0] = firstPage;
					return { ...old, pages } as MessagesQueryData;
				});
			},
			onPermissionRequest: (request) => {
				if (request.toolUseId) {
					setPendingPermsMap((prev) => {
						const next = new Map(prev);
						next.set(request.toolUseId, request);
						return next;
					});
				}
				if (request.toolUseId) {
					qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
						if (!old?.pages?.length) return old;
						let anyChanged = false;
						const pages = old.pages.map((page: MessagesPage) => {
							const { messages, changed } = mergeToolCallFieldsInTree(
								page.messages,
								request.toolUseId,
								{ status: "pending" },
							);
							if (changed) anyChanged = true;
							return changed ? { ...page, messages } : page;
						});
						return anyChanged ? { ...old, pages } : old;
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
						let anyChanged = false;
						const pages = old.pages.map((page: MessagesPage) => {
							const { messages, changed } = mergeToolCallFieldsInTree(page.messages, toolUseId, {
								status: "running",
								startedAt: Date.now(),
							});
							if (changed) anyChanged = true;
							return changed ? { ...page, messages } : page;
						});
						return anyChanged ? { ...old, pages } : old;
					});
				}
			},
			onStatusChange: (status) => {
				setIsCompacting(false);
				if (status === "idle" && streamingRef.current) {
					streamingRef.current = "";
					setStreamingVersion((v) => v + 1);
				}
				if (status === "idle") {
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
			onContextUsage: (percentage) => {
				setContextPercent(percentage);
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
			},
			onCompacting: () => {
				setIsCompacting(true);
			},
			onCompactDone: () => {
				setIsCompacting(false);
				setPruneBoundaryMessageId(null);
				setPrunedPercent(null);
				qc.invalidateQueries({ queryKey: ["narrators", narratorId] });
				qc.invalidateQueries({ queryKey: messagesQueryKey });
			},
			onNarratorError: (error) => {
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
				qc.setQueryData(messagesQueryKey, (old: MessagesQueryData | undefined) => {
					if (!old?.pages?.length) return old;
					let result: MessagesQueryData = old;
					for (const child of orphanChildren) {
						if (child?.id && child?.parentToolUseId) {
							result = insertChildIntoCache(result, {
								...child,
								children: child.children ?? [],
							}) as MessagesQueryData;
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
		if (connected) prevConnectedRef.current = true;
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
		if (narratorStatus === "done") {
			api.markNarratorRead(narratorId).catch(() => {});
		}
	}, [narratorId, narratorStatus]);

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
		streamingVersion,
		pendingPermsMap,
		pendingPermission,
		renderPermCb,
		bufferedText,
		setBufferedText,
		isCompacting,
		contextPercent,
		setContextPercent,
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
