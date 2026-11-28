/**
 * ChatMessageList.tsx — Chat history rendered by the SHARED narrator vlist.
 *
 * This is a thin binding, not a renderer. The room's messages are projected to
 * TreeMessages (`chat-vlist-adapter`) and fed to `PretextExactMessageList`
 * through its dataSource seam:
 *
 *   - `fetchPage` reads cancellable REST pages; `onWindowChange` mirrors only
 *     the committed window into this mounted view's React Query cache;
 *   - a single room owner establishes an ACK barrier before fixed-range recovery;
 *     live changes buffer through canonical commit, with a last-await deletion fence;
 *   - `viewerId` drives bubble side; `locateMessage` powers quote jumps.
 *
 * What stays here is only what the shell cannot know: the reply/delete row
 * actions (custom menu items) and the message-level selection bridge. The lazy
 * import is required by the vlist isolation guard.
 */

import { Button, Loader, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCornerUpLeft, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { chatKeys } from "../../hooks/useChat";
import type { NarratorWSCallbacks } from "../../hooks/useNarratorWS";
import { type ChatMessage, type ChatMessagePage, chatApi } from "../../lib/api/chat";
import { ApiError, getToken, onTokenChange } from "../../lib/api/client";
import type { PretextDocumentPageResult } from "../../lib/api/types";
import type { CustomMessageMenuItem } from "../narrator/message/MessageContextMenuCtx";
import { useEditorPanelVisible } from "../narrator/narrator-panel-visibility";
import { downloadChatAttachment } from "./chat-attachment-download";
import { type ChatRoomLease, ChatRoomSession } from "./chat-room-session";
import {
	type ChatTreeProjectionLabels,
	chatMessageTombstone,
	projectChatDeletion,
	projectChatLiveMessage,
	projectChatMessagesToTree,
} from "./chat-vlist-adapter";
import { CHAT_NEW_MESSAGE_BUDGET, recoverChatRange } from "./chat-window-recovery";

const PretextExactMessageListLazy = lazy(() =>
	import("../narrator/vlist/PretextExactMessageList").then((module) => ({
		default: module.PretextExactMessageList,
	})),
);

/** The lazy shell's types across the dynamic boundary. */
type VListDataSource = import("../narrator/vlist/vlist-data-source").VListDataSource;
type PretextDocumentInput =
	import("../narrator/vlist/pretext-document-loader").PretextDocumentInput;
interface ChatWindowRecovery {
	rows: ChatMessage[];
	rowIds: Set<string>;
	live: Map<string, ChatMessage>;
	deleted: Set<string>;
	lease?: ChatRoomLease;
	result?: PretextDocumentInput;
	stopAbort?: () => void;
}

export interface ChatMessageListProps {
	roomId: string;
	permissionNarratorId?: string;
	/** Per-mounted-view mirror: two readers may show different windows of one room. */
	messageCacheKey?: readonly unknown[];
	suspended?: boolean;
	currentUserId: string | null;
	/** Highest seq currently visible — drives the read watermark. */
	onVisibleSeq?: (seq: number) => void;
	onAuthorizationChange?: (allowed: boolean) => void;
	/** Selection is owned by the parent so the toolbar can act on it. */
	selectedIds?: ReadonlySet<string>;
	onToggleSelect?: (messageId: string, index: number, shiftKey: boolean) => void;
	onReply?: (message: ChatMessage) => void;
	onDelete?: (message: ChatMessage) => void;
}

/** Required layout DTO slot only; ACK + fixed seq reads, never this value, establish freshness. */
const CHAT_LAYOUT_PLACEHOLDER_VERSION = 0;

/** Room page ACLs intentionally hide inaccessible rooms behind HTTP 404. */
function roomPageFailure(error: unknown): unknown {
	return (error as { status?: number })?.status === 404
		? new ApiError("Chat room is no longer available", 403, { sourceStatus: 404 })
		: error;
}

export function ChatMessageList({
	roomId,
	permissionNarratorId,
	messageCacheKey,
	suspended = false,
	currentUserId,
	onVisibleSeq,
	onAuthorizationChange,
	selectedIds,
	onToggleSelect,
	onReply,
	onDelete,
}: ChatMessageListProps) {
	const { t } = useTranslation("chat");
	const queryClient = useQueryClient();
	const defaultMessageKey = useMemo(() => chatKeys.messages(roomId), [roomId]);
	const messageKey = messageCacheKey ?? defaultMessageKey;
	const active = useEditorPanelVisible(!suspended);
	const activeRef = useRef(active);
	activeRef.current = active;
	const token = useSyncExternalStore(onTokenChange, getToken, () => null);
	const previousPrincipal = useRef({ token, currentUserId });
	useEffect(() => {
		const previous = previousPrincipal.current;
		previousPrincipal.current = { token, currentUserId };
		if (previous.token !== token || previous.currentUserId !== currentUserId)
			queryClient.removeQueries({ queryKey: messageKey, exact: true });
	}, [token, currentUserId, messageKey, queryClient]);
	const [recoveryError, setRecoveryError] = useState<string | null>(null);
	const reloadRef = useRef<(() => void) | undefined>(undefined);
	const liveFrameRef = useRef<((data: Record<string, unknown>) => void) | undefined>(undefined);
	const authorizationRef = useRef(onAuthorizationChange);
	authorizationRef.current = onAuthorizationChange;

	const labels = useMemo<ChatTreeProjectionLabels>(
		() => ({
			messageDeleted: t("messageDeleted"),
			replyToDeleted: t("replyToDeleted"),
			replyUnavailable: t("replyUnavailable"),
			guestMarker: t("shareGuest"),
		}),
		[t],
	);
	const labelsRef = useRef(labels);
	labelsRef.current = labels;

	// Row actions act on the full ChatMessage; resolve ids through the query
	// cache the fetchPage writes (and the WS path patches) into.
	const lookupMessage = useCallback(
		(messageId: string): ChatMessage | undefined => {
			const data = queryClient.getQueryData(messageKey) as { pages: ChatMessagePage[] } | undefined;
			for (const page of data?.pages ?? []) {
				const found = page.messages.find((message) => message.id === messageId);
				if (found) return found;
			}
			return undefined;
		},
		[queryClient, messageKey],
	);

	const onReplyRef = useRef(onReply);
	onReplyRef.current = onReply;
	const onDeleteRef = useRef(onDelete);
	onDeleteRef.current = onDelete;

	const downloadAttachment = useCallback(
		(url: string, filename: string) => {
			void downloadChatAttachment(url, filename)
				.then((ok) => {
					if (!ok) notifications.show({ color: "red", message: t("common:operationFailed") });
				})
				.catch(() => notifications.show({ color: "red", message: t("common:operationFailed") }));
		},
		[t],
	);

	// The coordinator can keep an earlier fetchPage closure after host props change.
	// Every source generation for this room must share the same delete barriers and
	// loaded rows, including pending REST requests and replacement WS listeners.
	const roomWindow = useMemo(
		() => ({
			roomId,
			viewerId: currentUserId,
			token,
			loaded: new Map<string, ChatMessage>(),
			deletions: new Map<string, string>(),
			session: new ChatRoomSession(roomId, permissionNarratorId),
			tailSeq: 0,
			pendingFetches: 0,
			committedIds: new Set<string>(),
			bufferedLive: new Map<string, ChatMessage>(),
			recovery: null as ChatWindowRecovery | null,
		}),
		[roomId, currentUserId, token, permissionNarratorId],
	);
	useEffect(() => {
		if (!active) return;
		return roomWindow.session.activate(
			() => reloadRef.current?.(),
			(data) => {
				if (!activeRef.current || document.visibilityState === "hidden") return;
				if (
					data.type === "chat:message_deleted" &&
					typeof data.messageId === "string" &&
					(roomWindow.pendingFetches > 0 ||
						roomWindow.loaded.has(data.messageId) ||
						roomWindow.bufferedLive.has(data.messageId) ||
						roomWindow.recovery?.rowIds.has(data.messageId) ||
						roomWindow.recovery?.live.has(data.messageId))
				) {
					roomWindow.deletions.set(data.messageId, new Date().toISOString());
				}
				if (liveFrameRef.current) liveFrameRef.current(data);
				else if (data.type === "chat:message") {
					const message = data.message as ChatMessage;
					if (roomWindow.bufferedLive.size < CHAT_NEW_MESSAGE_BUDGET)
						roomWindow.bufferedLive.set(message.id, message);
					else
						setRecoveryError("There are newer messages. Your historical position has been kept.");
				}
			},
		);
	}, [active, roomWindow]);
	const dataSource = useMemo<VListDataSource>(() => {
		// Independent of callback registration order: useChatRoomLive may erase the
		// cache first, and reconnect/tail replacement may omit loaded historical rows.
		const { loaded, deletions } = roomWindow;
		const retireBarriers = () => {
			if (roomWindow.pendingFetches) return;
			for (const id of deletions.keys())
				if (
					!loaded.has(id) &&
					!roomWindow.bufferedLive.has(id) &&
					!roomWindow.recovery?.rowIds.has(id) &&
					!roomWindow.recovery?.live.has(id) &&
					!roomWindow.recovery?.deleted.has(id)
				)
					deletions.delete(id);
		};
		const assertReadable = () => {
			if (!activeRef.current || document.visibilityState === "hidden")
				throw new DOMException("Chat room suspended", "AbortError");
		};
		const finishRecovery = (recovery: ChatWindowRecovery, committed?: PretextDocumentInput) => {
			if (roomWindow.recovery !== recovery) return;
			roomWindow.recovery = null;
			recovery.stopAbort?.();
			queueMicrotask(() => {
				if (!activeRef.current || document.visibilityState === "hidden") return;
				if (recovery.lease) {
					try {
						roomWindow.session.assertCurrent(recovery.lease);
					} catch {
						return;
					}
				}
				const committedRows = new Map(committed?.messages.map((message) => [message.id, message]));
				for (const id of recovery.deleted) {
					if (committedRows.get(id)?.deletedLabel) continue;
					liveFrameRef.current?.({ type: "chat:message_deleted", roomId, messageId: id });
				}
				for (const message of [...recovery.live.values()].sort((a, b) => a.seq - b.seq)) {
					if (committedRows.has(message.id)) continue;
					liveFrameRef.current?.({ type: "chat:message", roomId, message });
				}
				retireBarriers();
			});
		};
		const reportDenied = (error: unknown) => {
			const status = (error as { status?: number })?.status;
			if (status !== 401 && status !== 403) return;
			roomWindow.recovery?.stopAbort?.();
			roomWindow.recovery = null;
			loaded.clear();
			deletions.clear();
			roomWindow.bufferedLive.clear();
			queryClient.setQueryData(messageKey, { pages: [], pageParams: [] });
			authorizationRef.current?.(false);
		};
		const waitReady = async (signal: AbortSignal) => {
			try {
				assertReadable();
				const lease = await roomWindow.session.waitReady(signal);
				assertReadable();
				return lease;
			} catch (error) {
				if (!signal.aborted) reportDenied(error);
				throw error;
			}
		};
		return {
			onFetchAttachment: downloadAttachment,
			viewerId: currentUserId,
			fetchPage: async (id, opts): Promise<PretextDocumentPageResult> => {
				const signal = opts.signal ?? new AbortController().signal;
				const lease = await waitReady(signal);
				roomWindow.session.assertCurrent(lease, signal);
				roomWindow.pendingFetches++;
				try {
					const page = await chatApi.listChatMessages(id, {
						afterSeq: opts.afterSeq,
						beforeSeq: opts.beforeSeq,
						limit: opts.limit,
						signal,
					});
					roomWindow.session.assertCurrent(lease, signal);
					authorizationRef.current?.(true);
					page.messages = page.messages.map((message) => {
						const deletedAt = deletions.get(message.id);
						const current = deletedAt ? chatMessageTombstone(message, deletedAt) : message;
						loaded.set(current.id, current);
						return current;
					});
					if (opts.beforeSeq === undefined) roomWindow.tailSeq = lease.tailSeq;
					return {
						messages: projectChatMessagesToTree(page.messages, labelsRef.current),
						minSeq: page.messages[0]?.seq ?? null,
						maxSeq: page.messages.at(-1)?.seq ?? null,
						hasNext: page.hasNext ?? false,
						hasPrev: page.hasMore,
						messageVersion: CHAT_LAYOUT_PLACEHOLDER_VERSION,
					};
				} catch (error) {
					roomWindow.session.assertCurrent(lease, signal);
					const failure = roomPageFailure(error);
					reportDenied(failure);
					throw failure;
				} finally {
					roomWindow.pendingFetches--;
					retireBarriers();
				}
			},
			locateMessage: async (id, messageId, signal) => {
				const requestSignal = signal ?? new AbortController().signal;
				const lease = await waitReady(requestSignal);
				try {
					const location = await chatApi.getChatMessageLocation(id, messageId, requestSignal);
					roomWindow.session.assertCurrent(lease, requestSignal);
					return location;
				} catch (error) {
					roomWindow.session.assertCurrent(lease, requestSignal);
					reportDenied(error);
					throw error;
				}
			},
			refreshFailurePolicy: "retain",
			onRefreshError: (error) => {
				if (roomWindow.recovery) finishRecovery(roomWindow.recovery);
				setRecoveryError(
					error instanceof Error
						? error.message
						: "Chat recovery failed; retry to keep your position",
				);
			},
			refreshWindow: async ({ narratorId, window, signal }) => {
				const recovery: ChatWindowRecovery = {
					rows: [],
					rowIds: new Set(),
					live: new Map(),
					deleted: new Set(),
				};
				roomWindow.recovery?.stopAbort?.();
				roomWindow.recovery = recovery;
				const abort = () => finishRecovery(recovery);
				signal.addEventListener("abort", abort, { once: true });
				recovery.stopAbort = () => signal.removeEventListener("abort", abort);
				roomWindow.pendingFetches++;
				let returned = false;
				try {
					const lease = await waitReady(signal);
					recovery.lease = lease;
					roomWindow.session.assertCurrent(lease, signal);
					const seqs = window.messages
						.map((message) => message.seq)
						.filter((seq): seq is number => typeof seq === "number");
					if (!seqs.length && lease.tailSeq === 0) {
						authorizationRef.current?.(true);
						recovery.result = window;
						returned = true;
						return window;
					}
					const minSeq = seqs.length ? Math.min(...seqs) : 1;
					const previousMax = seqs.length ? Math.max(...seqs) : 0;
					const atTail = !seqs.length || previousMax >= roomWindow.tailSeq;
					const gap = Math.max(0, lease.tailSeq - previousMax);
					const withinBudget = gap <= CHAT_NEW_MESSAGE_BUDGET;
					const maxSeq =
						atTail && withinBudget ? Math.max(previousMax, lease.tailSeq) : previousMax;
					const messages = await recoverChatRange({
						minSeq,
						maxSeq,
						signal,
						fetchPage: (params) => chatApi.listChatMessages(narratorId, params),
						assertCurrent: () => roomWindow.session.assertCurrent(lease, signal),
					});
					roomWindow.session.assertCurrent(lease, signal);
					authorizationRef.current?.(true);
					recovery.rows = messages.map((message) => {
						const deletedAt = deletions.get(message.id);
						const current = deletedAt ? chatMessageTombstone(message, deletedAt) : message;
						loaded.set(current.id, current);
						return current;
					});
					recovery.rowIds = new Set(recovery.rows.map((message) => message.id));
					roomWindow.tailSeq = lease.tailSeq;
					setRecoveryError(
						gap > 0 && (!atTail || !withinBudget)
							? "There are newer messages. Your historical position has been kept."
							: null,
					);
					recovery.result = {
						...window,
						messages: projectChatMessagesToTree(recovery.rows, labelsRef.current),
						oldestLoadedSeq: recovery.rows[0]?.seq ?? null,
					};
					returned = true;
					return recovery.result;
				} catch (error) {
					if (recovery.lease) roomWindow.session.assertCurrent(recovery.lease, signal);
					const failure = roomPageFailure(error);
					if (!signal.aborted) {
						reportDenied(failure);
						finishRecovery(recovery);
					}
					throw failure;
				} finally {
					roomWindow.pendingFetches--;
					if (!returned && roomWindow.recovery === recovery) {
						recovery.stopAbort?.();
						roomWindow.recovery = null;
					}
					retireBarriers();
				}
			},
			finalizeRefreshWindow: (window) => {
				const recovery = roomWindow.recovery;
				if (!recovery || recovery.result !== window) return window;
				// Synchronous last-await barrier: no old REST body can outlive a newer delete.
				recovery.rows = recovery.rows.map((message) => {
					const deletedAt = deletions.get(message.id);
					const current = deletedAt ? chatMessageTombstone(message, deletedAt) : message;
					loaded.set(current.id, current);
					return current;
				});
				recovery.result = {
					...window,
					messages: projectChatMessagesToTree(recovery.rows, labelsRef.current),
				};
				return recovery.result;
			},
			onWindowChange: (window) => {
				if (roomWindow.recovery?.result === window) {
					for (const message of roomWindow.recovery.rows) loaded.set(message.id, message);
				}
				const ids = new Set(window.messages.map((message) => message.id));
				roomWindow.committedIds = ids;
				for (const id of loaded.keys()) if (!ids.has(id)) loaded.delete(id);
				// Retire deletion barriers only after every old REST epoch has settled.
				retireBarriers();
				const messages = [...loaded.values()].sort((a, b) => a.seq - b.seq);
				queryClient.setQueryData(messageKey, {
					pages: [{ messages, hasMore: window.hasPrev, nextBeforeSeq: window.oldestLoadedSeq }],
					pageParams: [undefined],
				});
				if (roomWindow.recovery?.result === window) finishRecovery(roomWindow.recovery, window);
			},
			subscribeMessages: (handlers: NarratorWSCallbacks) => {
				reloadRef.current = () => handlers.onFullReload?.();
				const receive = (data: Record<string, unknown>) => {
					if (data.roomId !== roomId) return;
					const recovery = roomWindow.recovery;
					if (recovery) {
						// Room-owned catch-up is atomic. Live structural upserts would abort
						// the generic canonical read and leave hidden-time deletions behind.
						if (data.type === "chat:message") {
							const message = data.message as ChatMessage;
							if (recovery.live.size < CHAT_NEW_MESSAGE_BUDGET)
								recovery.live.set(message.id, message);
							else
								setRecoveryError(
									"There are newer messages. Your historical position has been kept.",
								);
						} else if (data.type === "chat:message_deleted") {
							const id = data.messageId as string;
							if (
								loaded.has(id) ||
								recovery.rowIds.has(id) ||
								recovery.live.has(id) ||
								deletions.has(id)
							) {
								deletions.set(id, deletions.get(id) ?? new Date().toISOString());
								recovery.deleted.add(id);
							}
						}
						return;
					}
					if (data.type === "chat:message") {
						const incoming = data.message as ChatMessage;
						const deletedAt = deletions.get(incoming.id);
						const message = deletedAt ? chatMessageTombstone(incoming, deletedAt) : incoming;
						const currentMax = Math.max(0, ...[...loaded.values()].map((row) => row.seq));
						if (
							!loaded.has(message.id) &&
							currentMax < roomWindow.tailSeq &&
							message.seq > currentMax
						) {
							setRecoveryError("There are newer messages. Your historical position has been kept.");
							return;
						}
						roomWindow.tailSeq = Math.max(roomWindow.tailSeq, message.seq);
						loaded.set(message.id, message);
						const projected = projectChatLiveMessage(message, loaded, labelsRef.current);
						if (projected) handlers.onMessage?.({ message: projected });
						return;
					}
					if (data.type === "chat:message_deleted") {
						const messageId = data.messageId as string;
						const deletedAt = deletions.get(messageId) ?? new Date().toISOString();
						const cache = queryClient.getQueryData<{ pages: ChatMessagePage[] }>(messageKey);
						const window = new Map(loaded);
						for (const page of cache?.pages ?? []) {
							for (const message of page.messages) window.set(message.id, message);
						}
						if (!window.has(messageId) && !roomWindow.pendingFetches) return;
						deletions.set(messageId, deletedAt);
						const result = projectChatDeletion(
							[...window.values()].sort((a, b) => a.seq - b.seq),
							messageId,
							deletedAt,
							labelsRef.current,
						);
						for (const message of result.messages) loaded.set(message.id, message);
						queryClient.setQueryData<{ pages: ChatMessagePage[]; pageParams: unknown[] }>(
							messageKey,
							(old) =>
								old
									? {
											...old,
											pages: old.pages.map((page) => ({
												...page,
												messages: page.messages.map((message) =>
													message.id === messageId
														? chatMessageTombstone(message, deletedAt)
														: message,
												),
											})),
										}
									: old,
						);
						for (const message of result.upserts) handlers.onMessage?.({ message });
					}
				};
				liveFrameRef.current = receive;
				for (const message of roomWindow.bufferedLive.values())
					receive({ type: "chat:message", roomId, message });
				roomWindow.bufferedLive.clear();
				return () => {
					reloadRef.current = undefined;
					liveFrameRef.current = undefined;
				};
			},
		};
	}, [roomId, roomWindow, currentUserId, queryClient, downloadAttachment, messageKey]);

	const customMessageActions = useCallback(
		(messageId: string): CustomMessageMenuItem[] | undefined => {
			const items: CustomMessageMenuItem[] = [];
			if (onReplyRef.current) {
				items.push({
					key: "reply",
					label: t("reply"),
					icon: <IconCornerUpLeft size={14} />,
					onClick: () => {
						const message = lookupMessage(messageId);
						if (message) onReplyRef.current?.(message);
					},
				});
			}
			if (onDeleteRef.current) {
				items.push({
					key: "delete",
					label: t("delete"),
					icon: <IconTrash size={14} />,
					danger: true,
					onClick: () => {
						const message = lookupMessage(messageId);
						if (message) onDeleteRef.current?.(message);
					},
				});
			}
			return items.length > 0 ? items : undefined;
		},
		[t, lookupMessage],
	);

	const handleToggleSelect = useCallback(
		(messageId: string, opts: { shiftKey: boolean }) => {
			onToggleSelect?.(messageId, -1, opts.shiftKey);
		},
		[onToggleSelect],
	);

	const handleVisibleMessages = useCallback(
		(last: { id: string; seq: number | null } | null) => {
			if (active && document.visibilityState !== "hidden" && last?.seq != null)
				onVisibleSeq?.(last.seq);
		},
		[active, onVisibleSeq],
	);

	return (
		<Suspense
			fallback={
				<div style={{ height: "100%", display: "grid", placeItems: "center" }}>
					<Loader size="sm" />
				</div>
			}
		>
			{recoveryError && active ? (
				<div role="status">
					<Text size="xs">{recoveryError}</Text>
					<Button size="compact-xs" variant="subtle" onClick={() => reloadRef.current?.()}>
						{t("common:retry")}
					</Button>
				</div>
			) : null}
			<PretextExactMessageListLazy
				narratorId={roomId}
				suspended={!active}
				dataSource={dataSource}
				enableNarratorErrorActions={false}
				isActive={false}
				rowHandlers={{ customMessageActions }}
				selectedMessageIds={selectedIds}
				onToggleMessageSelect={handleToggleSelect}
				onVisibleMessagesChange={handleVisibleMessages}
			/>
		</Suspense>
	);
}
