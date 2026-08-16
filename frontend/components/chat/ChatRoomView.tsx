/**
 * ChatRoomView.tsx — One chat room: history, selection toolbar, composer.
 *
 * Shared by both surfaces (the `/messages` page and the narrator dock panel), so
 * everything room-specific lives here and the surfaces only supply a `roomId`
 * plus, in the dock's case, a way to forward a selection to the narrator.
 *
 * ## Selection is index-based, not DOM-based
 *
 * The narrator list's `MessageSelectionCtx` resolves a range by walking
 * `[data-block-id]` in DOM order. That cannot work here: a virtual list only has
 * its mounted window in the DOM, so a range spanning off-screen messages would
 * silently drop everything not currently painted. Chat messages are a flat array,
 * so a range is a slice of indices — exact regardless of what is mounted.
 */

import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCopy, IconSend, IconSparkles, IconX } from "@tabler/icons-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	useChatMessages,
	useChatRoomLive,
	useDeleteChatMessage,
	useFlatChatMessages,
	useMarkChatRead,
	useSendChatMessage,
	useSummarizeChat,
} from "../../hooks/useChat";
import type { ChatMessage } from "../../lib/api/chat";
import { ApiError } from "../../lib/api/client";
import { copyTextToClipboard } from "../../lib/clipboard";
import { ChatMessageList } from "./ChatMessageList";
import { buildForwardText } from "./chat-forward-text";

/** Server-side cap, mirrored so the composer can show the remaining budget. */
const CHAT_MESSAGE_MAX_CHARS = 8_000;

export interface ChatRoomViewProps {
	roomId: string | undefined;
	/**
	 * Forward text to the narrator beside this room, as a normal user message.
	 * Absent on surfaces with no narrator (the standalone `/messages` page), where
	 * the forward actions are hidden and only "copy" remains.
	 */
	onForwardToNarrator?: (text: string) => void;
	/** Room title shown above the history (peer name, or the narrator's title). */
	title?: string;
	/** Optional extra controls in the header (e.g. the dock's close button). */
	headerActions?: React.ReactNode;
}

export function ChatRoomView({
	roomId,
	onForwardToNarrator,
	title,
	headerActions,
}: ChatRoomViewProps) {
	const { t } = useTranslation("chat");
	const { data: currentUser } = useCurrentUser();
	const currentUserId = (currentUser as { id?: string } | undefined)?.id ?? null;

	useChatRoomLive(roomId);
	const messagesQuery = useChatMessages(roomId);
	const messages = useFlatChatMessages(messagesQuery.data);
	const sendMessage = useSendChatMessage(roomId);
	const deleteMessage = useDeleteChatMessage(roomId);
	const summarize = useSummarizeChat(roomId);
	const markRead = useMarkChatRead(roomId);

	const [draft, setDraft] = useState("");
	const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
	const anchorIndexRef = useRef<number | null>(null);
	const [summaryPreview, setSummaryPreview] = useState<string | null>(null);

	const messageIndexById = useMemo(() => {
		const map = new Map<string, number>();
		for (let index = 0; index < messages.length; index++) {
			map.set(messages[index].id, index);
		}
		return map;
	}, [messages]);

	// Index-based range selection (see the module note on why not DOM order).
	const toggleSelect = useCallback(
		(messageId: string, index: number, shiftKey: boolean) => {
			setSelectedIds((previous) => {
				const next = new Set(previous);
				const anchor = anchorIndexRef.current;
				if (shiftKey && anchor !== null) {
					const lo = Math.min(anchor, index);
					const hi = Math.max(anchor, index);
					for (let i = lo; i <= hi; i++) {
						const id = messages[i]?.id;
						if (id) next.add(id);
					}
					return next;
				}
				if (next.has(messageId)) next.delete(messageId);
				else next.add(messageId);
				anchorIndexRef.current = index;
				return next;
			});
		},
		[messages],
	);

	const clearSelection = useCallback(() => {
		anchorIndexRef.current = null;
		setSelectedIds(new Set());
	}, []);

	/** Selected messages in conversation order, regardless of click order. */
	const selectedMessages = useMemo(
		() =>
			[...selectedIds]
				.map((id) => messageIndexById.get(id))
				.filter((index): index is number => index !== undefined)
				.sort((a, b) => a - b)
				.map((index) => messages[index])
				.filter((message): message is ChatMessage => !!message),
		[messages, messageIndexById, selectedIds],
	);

	const handleSend = useCallback(() => {
		const text = draft.trim();
		if (!text || !roomId || sendMessage.isPending) return;
		sendMessage.mutate(
			{ text, replyToMessageId: replyTo?.id ?? null },
			{
				onSuccess: () => {
					setDraft("");
					setReplyTo(null);
				},
				onError: (error) => {
					notifications.show({
						color: "red",
						title: t("sendFailed"),
						message: error instanceof Error ? error.message : "",
					});
				},
			},
		);
	}, [draft, replyTo, roomId, sendMessage, t]);

	const handleDelete = useCallback(
		(message: ChatMessage) => {
			deleteMessage.mutate(message.id, {
				onError: (error) =>
					notifications.show({
						color: "red",
						// The server answers 403 when the message is someone else's. Reporting it
						// as a generic failure would invite the user to retry something that can
						// never succeed.
						title:
							error instanceof ApiError && error.status === 403
								? t("deleteForbidden")
								: t("deleteFailed"),
						message: error instanceof Error ? error.message : "",
					}),
			});
		},
		[deleteMessage, t],
	);

	const handleForwardQuoted = useCallback(() => {
		if (!onForwardToNarrator || selectedMessages.length === 0) return;
		onForwardToNarrator(buildForwardText(selectedMessages));
		clearSelection();
	}, [clearSelection, onForwardToNarrator, selectedMessages]);

	const handleSummarize = useCallback(() => {
		if (selectedMessages.length === 0 || !roomId) return;
		summarize.mutate(
			selectedMessages.map((message) => message.id),
			{
				onSuccess: (result) => setSummaryPreview(result.summary),
				onError: (error) =>
					notifications.show({
						color: "red",
						// Summarizing spends model quota, so the server rate-limits it per user.
						// Without naming that, a 429 reads as "summarizing is broken".
						title:
							error instanceof ApiError && error.status === 429
								? t("summarizeRateLimited")
								: t("summarizeFailed"),
						message: error instanceof Error ? error.message : "",
					}),
			},
		);
	}, [roomId, selectedMessages, summarize, t]);

	const handleCopy = useCallback(() => {
		if (selectedMessages.length === 0) return;
		void copyTextToClipboard(buildForwardText(selectedMessages));
	}, [selectedMessages]);

	if (!roomId) {
		return (
			<Box style={{ height: "100%", display: "grid", placeItems: "center" }}>
				<Text size="sm" c="dimmed">
					{t("noRoomSelected")}
				</Text>
			</Box>
		);
	}

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
			{title || headerActions ? (
				<Group
					gap="xs"
					px="md"
					py="xs"
					wrap="nowrap"
					style={{
						flexShrink: 0,
						borderBottom: "1px solid var(--mantine-color-default-border)",
					}}
				>
					<Text size="sm" fw={600} truncate style={{ flex: 1 }}>
						{title}
					</Text>
					{headerActions}
				</Group>
			) : null}

			<Box style={{ flex: 1, minHeight: 0 }}>
				{messagesQuery.isLoading ? (
					<Box style={{ height: "100%", display: "grid", placeItems: "center" }}>
						<Loader size="sm" />
					</Box>
				) : (
					<ChatMessageList
						messages={messages}
						currentUserId={currentUserId}
						hasOlder={messagesQuery.hasNextPage}
						isLoadingOlder={messagesQuery.isFetchingNextPage}
						onLoadOlder={() => messagesQuery.fetchNextPage()}
						onVisibleSeq={markRead}
						selectedIds={selectedIds}
						onToggleSelect={toggleSelect}
						onReply={setReplyTo}
						onDelete={handleDelete}
					/>
				)}
			</Box>

			{selectedIds.size > 0 ? (
				<Group
					gap="xs"
					px="md"
					py={6}
					wrap="nowrap"
					style={{
						flexShrink: 0,
						borderTop: "1px solid var(--mantine-color-default-border)",
						background: "var(--mantine-color-default-hover)",
					}}
				>
					<Badge size="sm" variant="light">
						{t("selectedCount", { count: selectedIds.size })}
					</Badge>
					{onForwardToNarrator ? (
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconSend size={12} />}
							onClick={handleForwardQuoted}
						>
							{t("sendToNarrator")}
						</Button>
					) : null}
					{onForwardToNarrator ? (
						<Button
							size="compact-xs"
							variant="light"
							color="grape"
							leftSection={<IconSparkles size={12} />}
							loading={summarize.isPending}
							onClick={handleSummarize}
						>
							{t("summarizeAndSend")}
						</Button>
					) : null}
					<Button
						size="compact-xs"
						variant="subtle"
						leftSection={<IconCopy size={12} />}
						onClick={handleCopy}
					>
						{t("copySelection")}
					</Button>
					<Tooltip label={t("clearSelection")}>
						<ActionIcon size="sm" variant="subtle" color="gray" onClick={clearSelection}>
							<IconX size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			) : null}

			{replyTo ? (
				<Group
					gap="xs"
					px="md"
					py={4}
					wrap="nowrap"
					style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}
				>
					<Text size="xs" c="dimmed" truncate style={{ flex: 1 }}>
						{t("replyingTo", {
							name: replyTo.sender?.username ?? t("unknownSender"),
						})}
						{": "}
						{replyTo.contentText.slice(0, 80)}
					</Text>
					<ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setReplyTo(null)}>
						<IconX size={14} />
					</ActionIcon>
				</Group>
			) : null}

			<Group
				gap="xs"
				align="flex-end"
				p="sm"
				wrap="nowrap"
				style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				<Textarea
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value.slice(0, CHAT_MESSAGE_MAX_CHARS))}
					placeholder={t("composerPlaceholder")}
					autosize
					minRows={1}
					maxRows={6}
					style={{ flex: 1 }}
					onKeyDown={(event) => {
						// Enter sends, Shift+Enter breaks the line. The IME guard matters for
						// CJK input: committing a candidate fires Enter with
						// `isComposing` true, which would otherwise send a half-typed line.
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							handleSend();
						}
					}}
				/>
				<Button
					onClick={handleSend}
					loading={sendMessage.isPending}
					disabled={!draft.trim()}
					leftSection={<IconSend size={14} />}
				>
					{t("send")}
				</Button>
			</Group>

			<Modal
				opened={summaryPreview !== null}
				onClose={() => setSummaryPreview(null)}
				title={t("summaryPreviewTitle")}
				size="lg"
			>
				<Stack gap="sm">
					<Text size="xs" c="dimmed">
						{t("summaryPreviewHint")}
					</Text>
					<Textarea
						value={summaryPreview ?? ""}
						onChange={(event) => setSummaryPreview(event.currentTarget.value)}
						autosize
						minRows={6}
						maxRows={20}
					/>
					<Group justify="flex-end">
						<Button variant="subtle" onClick={() => setSummaryPreview(null)}>
							{t("cancel")}
						</Button>
						<Button
							leftSection={<IconSend size={14} />}
							disabled={!summaryPreview?.trim()}
							onClick={() => {
								const text = summaryPreview?.trim();
								if (!text || !onForwardToNarrator) return;
								onForwardToNarrator(text);
								setSummaryPreview(null);
								clearSelection();
							}}
						>
							{t("sendToNarrator")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</Box>
	);
}
