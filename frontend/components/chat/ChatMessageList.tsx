/**
 * ChatMessageList.tsx — Chat history rendered by the SHARED narrator vlist.
 *
 * This is a thin binding, not a renderer. The room's messages are projected to
 * TreeMessages (`chat-vlist-adapter`) and fed to `PretextExactMessageList`
 * through its dataSource seam:
 *
 *   - `fetchPage` reads the REST page AND writes it into the React Query cache,
 *     so the room view's selection/forward/delete actions keep reading the same
 *     window the list is showing;
 *   - realtime rides the same `narratorWSManager` the narrator panel uses
 *     (`chat:message` / `chat:message_deleted` → upsert, reconnect → reload);
 *   - `viewerId` drives bubble side; `locateMessage` powers quote jumps.
 *
 * What stays here is only what the shell cannot know: the reply/delete row
 * actions (custom menu items) and the message-level selection bridge. The lazy
 * import is required by the vlist isolation guard.
 */

import { Loader } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCornerUpLeft, IconTrash } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { chatKeys } from "../../hooks/useChat";
import type { NarratorWSCallbacks } from "../../hooks/useNarratorWS";
import { type ChatMessage, type ChatMessagePage, chatApi } from "../../lib/api/chat";
import type { PretextDocumentPageResult } from "../../lib/api/types";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import type { CustomMessageMenuItem } from "../narrator/message/MessageContextMenuCtx";
import { downloadChatAttachment } from "./chat-attachment-download";
import {
	type ChatTreeProjectionLabels,
	chatMessageTombstone,
	projectChatDeletion,
	projectChatLiveMessage,
	projectChatMessagesToTree,
} from "./chat-vlist-adapter";

const PretextExactMessageListLazy = lazy(() =>
	import("../narrator/vlist/PretextExactMessageList").then((module) => ({
		default: module.PretextExactMessageList,
	})),
);

/** The lazy shell's types across the dynamic boundary. */
type VListDataSource = import("../narrator/vlist/vlist-data-source").VListDataSource;

export interface ChatMessageListProps {
	roomId: string;
	currentUserId: string | null;
	/** Highest seq currently visible — drives the read watermark. */
	onVisibleSeq?: (seq: number) => void;
	/** Selection is owned by the parent so the toolbar can act on it. */
	selectedIds?: ReadonlySet<string>;
	onToggleSelect?: (messageId: string, index: number, shiftKey: boolean) => void;
	onReply?: (message: ChatMessage) => void;
	onDelete?: (message: ChatMessage) => void;
}

/** Chat has no document version; edits/deletes arrive as WS upserts instead. */
const CHAT_DOCUMENT_VERSION = 0;

export function ChatMessageList({
	roomId,
	currentUserId,
	onVisibleSeq,
	selectedIds,
	onToggleSelect,
	onReply,
	onDelete,
}: ChatMessageListProps) {
	const { t } = useTranslation("chat");
	const queryClient = useQueryClient();

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
			const data = queryClient.getQueryData(chatKeys.messages(roomId)) as
				| { pages: ChatMessagePage[] }
				| undefined;
			for (const page of data?.pages ?? []) {
				const found = page.messages.find((message) => message.id === messageId);
				if (found) return found;
			}
			return undefined;
		},
		[queryClient, roomId],
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
			loaded: new Map<string, ChatMessage>(),
			deletions: new Map<string, string>(),
		}),
		[roomId],
	);
	const dataSource = useMemo<VListDataSource>(() => {
		// Independent of callback registration order: useChatRoomLive may erase the
		// cache first, and reconnect/tail replacement may omit loaded historical rows.
		const { loaded, deletions } = roomWindow;
		return {
			onFetchAttachment: downloadAttachment,
			viewerId: currentUserId,
			fetchPage: async (id, opts): Promise<PretextDocumentPageResult> => {
				const page = await chatApi.listChatMessages(id, {
					beforeSeq: opts.beforeSeq,
					limit: opts.limit,
				});
				page.messages = page.messages.map((message) => {
					const deletedAt = deletions.get(message.id);
					const current = deletedAt ? chatMessageTombstone(message, deletedAt) : message;
					loaded.set(current.id, current);
					return current;
				});
				// Write-through into the room's query cache so the room view's
				// selection/forward actions see exactly the window the list shows.
				mergeChatPageIntoCache(queryClient, id, page, opts.beforeSeq);
				return {
					messages: projectChatMessagesToTree(page.messages, labelsRef.current),
					minSeq: page.messages[0]?.seq ?? null,
					maxSeq: page.messages.at(-1)?.seq ?? null,
					hasNext: false,
					hasPrev: page.hasMore,
					messageVersion: CHAT_DOCUMENT_VERSION,
				};
			},
			locateMessage: async (id, messageId) => chatApi.getChatMessageLocation(id, messageId),
			subscribeMessages: (handlers: NarratorWSCallbacks) => {
				const handleId = narratorWSManager.allocateId();
				narratorWSManager.joinChatRoom(roomId, handleId);
				const listener = narratorWSManager.addListener(
					{ narratorIds: "*", types: ["chat:message", "chat:message_deleted"] },
					(data) => {
						if (data.roomId !== roomId) return;
						if (data.type === "chat:message") {
							const incoming = data.message as ChatMessage;
							const deletedAt = deletions.get(incoming.id);
							const message = deletedAt ? chatMessageTombstone(incoming, deletedAt) : incoming;
							loaded.set(message.id, message);
							const projected = projectChatLiveMessage(message, loaded, labelsRef.current);
							if (projected) handlers.onMessage?.({ message: projected });
							return;
						}
						if (data.type === "chat:message_deleted") {
							const messageId = data.messageId as string;
							const deletedAt = deletions.get(messageId) ?? new Date().toISOString();
							deletions.set(messageId, deletedAt);
							const cache = queryClient.getQueryData<{ pages: ChatMessagePage[] }>(
								chatKeys.messages(roomId),
							);
							const window = new Map(loaded);
							for (const page of cache?.pages ?? []) {
								for (const message of page.messages) window.set(message.id, message);
							}
							const result = projectChatDeletion(
								[...window.values()].sort((a, b) => a.seq - b.seq),
								messageId,
								deletedAt,
								labelsRef.current,
							);
							for (const message of result.messages) loaded.set(message.id, message);
							queryClient.setQueryData<{ pages: ChatMessagePage[]; pageParams: unknown[] }>(
								chatKeys.messages(roomId),
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
					},
				);
				const unsubscribeConnection = narratorWSManager.onConnectionChange(
					(connected, isReconnect) => {
						if (connected && isReconnect) handlers.onFullReload?.();
					},
				);
				return () => {
					unsubscribeConnection();
					narratorWSManager.removeListener(listener);
					narratorWSManager.leaveChatRoom(roomId, handleId);
				};
			},
		};
	}, [roomId, roomWindow, currentUserId, queryClient, downloadAttachment]);

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
			if (last?.seq != null) onVisibleSeq?.(last.seq);
		},
		[onVisibleSeq],
	);

	return (
		<Suspense
			fallback={
				<div style={{ height: "100%", display: "grid", placeItems: "center" }}>
					<Loader size="sm" />
				</div>
			}
		>
			<PretextExactMessageListLazy
				narratorId={roomId}
				dataSource={dataSource}
				isActive={false}
				rowHandlers={{ customMessageActions }}
				selectedMessageIds={selectedIds}
				onToggleMessageSelect={handleToggleSelect}
				onVisibleMessagesChange={handleVisibleMessages}
			/>
		</Suspense>
	);
}

/**
 * Merge one fetched page into the room's infinite-query cache.
 *
 * Pages are newest-window-first: index 0 is the tail, and older pages append.
 * A tail refetch (no beforeSeq) replaces page 0; an older page appends once
 * (the shell pages each cursor exactly once). The WS append path writes into
 * page 0 separately and is untouched here.
 */
function mergeChatPageIntoCache(
	queryClient: ReturnType<typeof useQueryClient>,
	roomId: string,
	page: ChatMessagePage,
	beforeSeq: number | undefined,
): void {
	queryClient.setQueryData(
		chatKeys.messages(roomId),
		(old: { pages: ChatMessagePage[]; pageParams: unknown[] } | undefined) => {
			if (!old || old.pages.length === 0) {
				return { pages: [page], pageParams: [beforeSeq] };
			}
			if (beforeSeq === undefined) {
				// Tail (re)fetch: replace the newest window, keep older pages.
				return {
					pages: [page, ...old.pages.slice(1)],
					pageParams: [undefined, ...old.pageParams.slice(1)],
				};
			}
			if (old.pageParams.includes(beforeSeq)) return old;
			return { pages: [...old.pages, page], pageParams: [...old.pageParams, beforeSeq] };
		},
	);
}
