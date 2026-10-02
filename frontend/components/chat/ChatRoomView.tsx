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
	FileButton,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCopy, IconPaperclip, IconSend, IconSparkles, IconX } from "@tabler/icons-react";
import { type InfiniteData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import {
	chatKeys,
	useChatRoomLive,
	useDeleteChatMessage,
	useDiscardChatAttachment,
	useFlatChatMessages,
	useMarkChatRead,
	useMaterializeChatAttachments,
	useSendChatMessage,
	useSummarizeChat,
	useUploadChatAttachment,
} from "../../hooks/useChat";
import type { ChatMessage, ChatMessagePage } from "../../lib/api/chat";
import { ApiError } from "../../lib/api/client";
import { copyTextToClipboard } from "../../lib/clipboard";
import { ChatComposerAttachments, type PendingChatAttachment } from "./ChatComposerAttachments";
import { ChatMessageList } from "./ChatMessageList";
import {
	clearChatComposerDraft,
	getChatDraftStorageId,
	persistChatComposerDraft,
	readChatComposerDraft,
	type StoredChatDraftAttachment,
} from "./chat-composer-draft";
import { buildForwardText } from "./chat-forward-text";
import { CHAT_HEADER_HEIGHT } from "./chat-header";

/** Server-side cap, mirrored so the composer can show the remaining budget. */
const CHAT_MESSAGE_MAX_CHARS = 8_000;
/** Mirror of `CHAT_ATTACHMENTS_PER_MESSAGE_MAX` (server). */
const CHAT_ATTACHMENTS_PER_MESSAGE_MAX = 10;
/**
 * Mirror of `CHAT_ATTACHMENTS_UNAVAILABLE_CODE` (server/lib/chat-attachments.ts).
 *
 * Mirrored, like the two above, because that module imports `node:path` and the
 * server data directory at module scope and cannot be bundled for the browser.
 */
const CHAT_ATTACHMENTS_UNAVAILABLE_CODE = "CHAT_ATTACHMENTS_UNAVAILABLE";

export interface ChatRoomViewProps {
	roomId: string | undefined;
	/**
	 * Forward text to the narrator beside this room, as a normal user message.
	 * Absent on surfaces with no narrator (the standalone `/messages` page), where
	 * the forward actions are hidden and only "copy" remains.
	 */
	onForwardToNarrator?: (text: string) => void;
	/**
	 * The narrator this room belongs to, when there is one.
	 *
	 * Needed for forwarding ATTACHMENTS: they are copied into that narrator's
	 * worktree before the forward text can name their paths. Absent on `/messages`,
	 * where `onForwardToNarrator` is also absent.
	 */
	narratorId?: string;
	/** Room title shown above the history (peer name, or the narrator's title). */
	title?: string;
	/** Optional extra controls in the header (e.g. the dock's close button). */
	headerActions?: React.ReactNode;
}

export function ChatRoomView({
	roomId,
	onForwardToNarrator,
	narratorId,
	title,
	headerActions,
}: ChatRoomViewProps) {
	const { t } = useTranslation("chat");
	const { data: currentUser } = useCurrentUser();
	const currentUserId = (currentUser as { id?: string } | undefined)?.id ?? null;

	useChatRoomLive(roomId);
	// The message list reads through the vlist's own paging (ChatMessageList's
	// fetchPage writes each page into this cache); the view subscribes passively
	// for the selection/forward/delete actions — no fetch ever starts here.
	const messagesQuery = useQuery<InfiniteData<ChatMessagePage>>({
		queryKey: chatKeys.messages(roomId ?? ""),
		enabled: false,
	});
	const messages = useFlatChatMessages(messagesQuery.data);
	const sendMessage = useSendChatMessage(roomId);
	const deleteMessage = useDeleteChatMessage(roomId);
	const summarize = useSummarizeChat(roomId);
	const markRead = useMarkChatRead(roomId);
	const uploadAttachment = useUploadChatAttachment(roomId);
	const discardAttachment = useDiscardChatAttachment();
	const materializeAttachments = useMaterializeChatAttachments(roomId);

	const [draft, setDraft] = useState("");
	const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
	const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
	const anchorIndexRef = useRef<number | null>(null);
	const [summaryPreview, setSummaryPreview] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingChatAttachment[]>([]);

	// ── Composer draft persistence ──────────────────────────────────────────
	//
	// A refresh AND a room switch both remount this view (`key={roomId}` at every
	// call site), so without this the typed text and the already-uploaded
	// attachments are dropped with no indication that anything was lost.

	/**
	 * Storage scope this mount has restored, or null before it has.
	 *
	 * Gates the persist effect below: writing before the read lands would store
	 * the empty initial state OVER a real draft, destroying exactly what this is
	 * meant to preserve. It is a ref rather than state because the persist effect
	 * must observe the change without re-running for it.
	 */
	const draftHydratedScopeRef = useRef<string | null>(null);

	/**
	 * Upload times for attachments picked in this mount, plus those restored.
	 *
	 * The expiry clock has to keep running across reloads: it measures the age of
	 * the server-side row, so re-stamping it on every save would let a draft that
	 * is reopened daily hold an id the server reclaimed on day one. A `PendingChatAttachment`
	 * has nowhere to carry this (it mirrors what the chip renders), so it lives
	 * beside it, keyed by attachment id.
	 */
	const restoredUploadedAtRef = useRef<Map<string, number>>(new Map());

	useEffect(() => {
		// `currentUserId` comes from a query, so it is null on the first render(s).
		// Hydration therefore has to be an effect keyed on it, not a lazy state
		// initialiser — the initialiser would run while the id is still unknown and
		// silently restore nothing.
		if (!currentUserId || !roomId) return;
		const scope = getChatDraftStorageId(currentUserId, roomId);
		if (draftHydratedScopeRef.current === scope) return;
		const stored = readChatComposerDraft(currentUserId, roomId);
		draftHydratedScopeRef.current = scope;
		// Anything typed before the user id resolved wins: it is newer than what was
		// stored, and overwriting it would lose keystrokes the user just made.
		setDraft((current) => (current ? current : stored.text));
		if (stored.attachments.length > 0) {
			restoredUploadedAtRef.current = new Map(
				stored.attachments.map((item) => [item.id, item.uploadedAtMs]),
			);
			setPending((current) =>
				current.length > 0
					? current
					: stored.attachments.map((item) => ({
							localId: `restored-${item.id}`,
							filename: item.filename,
							sizeBytes: item.sizeBytes,
							status: "ready" as const,
							attachment: {
								id: item.id,
								kind: item.kind,
								filename: item.filename,
								mediaType: item.mediaType,
								sizeBytes: item.sizeBytes,
								// Not stored: only the chat LIST needs dimensions (to reserve row
								// height without loading the image), and a composer chip never
								// renders the image. Persisting them would be dead weight.
								width: null,
								height: null,
							},
						})),
			);
		}
	}, [currentUserId, roomId]);

	useEffect(() => {
		if (!currentUserId || !roomId) return;
		if (draftHydratedScopeRef.current !== getChatDraftStorageId(currentUserId, roomId)) return;
		// Only `ready` chips are stored. An `uploading` one has no server id yet, and
		// an `error` one names nothing the server holds — restoring either would
		// produce a chip that can never be sent.
		const attachments: StoredChatDraftAttachment[] = [];
		for (const item of pending) {
			const attachment = item.attachment;
			if (item.status !== "ready" || !attachment) continue;
			attachments.push({
				id: attachment.id,
				filename: attachment.filename,
				sizeBytes: attachment.sizeBytes,
				kind: attachment.kind,
				mediaType: attachment.mediaType,
				// Preserve the original upload time when there is one; only a chip first
				// seen in this mount is stamped now.
				uploadedAtMs: restoredUploadedAtRef.current.get(attachment.id) ?? Date.now(),
			});
			restoredUploadedAtRef.current.set(
				attachment.id,
				attachments[attachments.length - 1].uploadedAtMs,
			);
		}
		persistChatComposerDraft(currentUserId, roomId, { text: draft, attachments });
	}, [currentUserId, draft, pending, roomId]);

	const messageIndexById = useMemo(() => {
		const map = new Map<string, number>();
		for (let index = 0; index < messages.length; index++) {
			map.set(messages[index].id, index);
		}
		return map;
	}, [messages]);

	// Index-based range selection (see the module note on why not DOM order).
	// The list is the shared vlist now, so the row index no longer arrives with
	// the click — resolve it from the message id against the cached window.
	const toggleSelect = useCallback(
		(messageId: string, index: number, shiftKey: boolean) => {
			const resolvedIndex = messageIndexById.get(messageId) ?? index;
			setSelectedIds((previous) => {
				const next = new Set(previous);
				const anchor = anchorIndexRef.current;
				if (shiftKey && anchor !== null && resolvedIndex >= 0) {
					const lo = Math.min(anchor, resolvedIndex);
					const hi = Math.max(anchor, resolvedIndex);
					for (let i = lo; i <= hi; i++) {
						const id = messages[i]?.id;
						if (id) next.add(id);
					}
					return next;
				}
				if (next.has(messageId)) next.delete(messageId);
				else next.add(messageId);
				anchorIndexRef.current = resolvedIndex >= 0 ? resolvedIndex : null;
				return next;
			});
		},
		[messages, messageIndexById],
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

	/** Uploaded-and-ready attachment ids, in pick order. */
	const readyAttachmentIds = useMemo(
		() =>
			pending
				.filter((item) => item.status === "ready" && item.attachment)
				.map((item) => item.attachment?.id)
				.filter((id): id is string => !!id),
		[pending],
	);
	const hasUploadsInFlight = pending.some((item) => item.status === "uploading");

	const handleSend = useCallback(() => {
		const text = draft.trim();
		// An attachment carries the message on its own, matching the server rule.
		if ((!text && readyAttachmentIds.length === 0) || !roomId || sendMessage.isPending) return;
		// Sending mid-upload would silently drop whatever had not finished, so the
		// button is disabled for that case and this is the belt-and-braces guard.
		if (hasUploadsInFlight) return;
		sendMessage.mutate(
			{
				text,
				replyToMessageId: replyTo?.id ?? null,
				...(readyAttachmentIds.length > 0 ? { attachmentIds: readyAttachmentIds } : {}),
			},
			{
				onSuccess: () => {
					setDraft("");
					setReplyTo(null);
					// Only the claimed drafts are cleared. A failed upload's chip stays so
					// the user can see what did NOT go out and retry it — dropping it here
					// would lose the attachment without ever saying so.
					setPending((previous) => previous.filter((item) => item.status === "error"));
					if (currentUserId && roomId) clearChatComposerDraft(currentUserId, roomId);
				},
				onError: (error) => {
					notifications.show({
						color: "red",
						title: t("sendFailed"),
						message: error instanceof Error ? error.message : "",
					});
					// A restored attachment may name a row the server has already reclaimed
					// (its 24h window elapsed, or it was sent from another tab). The server
					// answers that with a single "attachments are unavailable" for the whole
					// batch, so mark the ready chips as failed: the notification alone would
					// leave the user staring at chips that look fine but cannot be sent.
					if (error instanceof ApiError && error.data?.code === CHAT_ATTACHMENTS_UNAVAILABLE_CODE) {
						setPending((previous) =>
							previous.map((item) =>
								item.status === "ready"
									? { ...item, status: "error", error: t("attachmentNoLongerAvailable") }
									: item,
							),
						);
					}
				},
			},
		);
	}, [
		currentUserId,
		draft,
		hasUploadsInFlight,
		readyAttachmentIds,
		replyTo,
		roomId,
		sendMessage,
		t,
	]);

	// ── Attachments ─────────────────────────────────────────────────────────

	const handlePickFiles = useCallback(
		(files: File[]) => {
			if (!roomId || files.length === 0) return;
			const room = pending.length;
			if (room + files.length > CHAT_ATTACHMENTS_PER_MESSAGE_MAX) {
				notifications.show({
					color: "red",
					title: t("attachmentLimitTitle"),
					message: t("attachmentLimit", { count: CHAT_ATTACHMENTS_PER_MESSAGE_MAX }),
				});
				return;
			}
			for (const file of files) {
				// A client-side key, because the server id only exists once the upload
				// lands — the chip has to be visible (and removable) before then.
				const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				setPending((previous) => [
					...previous,
					{ localId, filename: file.name, sizeBytes: file.size, status: "uploading" },
				]);
				uploadAttachment.mutate(file, {
					onSuccess: (attachment) => {
						setPending((previous) =>
							previous.map((item) =>
								item.localId === localId ? { ...item, status: "ready", attachment } : item,
							),
						);
					},
					onError: (error) => {
						// Kept in the list as an error chip rather than removed: a vanishing
						// chip reads as "it worked", which is the opposite of what happened.
						setPending((previous) =>
							previous.map((item) =>
								item.localId === localId
									? {
											...item,
											status: "error",
											error: error instanceof Error ? error.message : t("attachmentUploadFailed"),
										}
									: item,
							),
						);
					},
				});
			}
		},
		[pending.length, roomId, t, uploadAttachment],
	);

	const handleRemovePending = useCallback(
		(localId: string) => {
			const target = pending.find((item) => item.localId === localId);
			setPending((previous) => previous.filter((item) => item.localId !== localId));
			// Best-effort server cleanup. A failure is not surfaced: the row is already
			// gone from the composer, and an unclaimed draft is reclaimed by the storage
			// sweep, so there is nothing the user could usefully do about it.
			if (target?.attachment) discardAttachment.mutate(target.attachment.id);
		},
		[discardAttachment, pending],
	);

	/**
	 * Paste handler: images on the clipboard become attachments.
	 *
	 * Only files are intercepted; a paste carrying text falls through to the
	 * textarea's own handling, so pasting a code snippet still types it.
	 */
	const handlePaste = useCallback(
		(event: React.ClipboardEvent) => {
			const files = Array.from(event.clipboardData?.files ?? []);
			if (files.length === 0) return;
			event.preventDefault();
			handlePickFiles(files);
		},
		[handlePickFiles],
	);

	// ── Jump to a quoted message ────────────────────────────────────────────
	// Handled entirely inside the vlist shell: the quote strip calls its jump
	// machinery, which pages older history until the target is covered.

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

	/**
	 * Copy the selection's attachments into the narrator's worktree and return the
	 * `<attached_files>` hint to append.
	 *
	 * Returns "" when there is nothing to copy, or when copying failed. A failure is
	 * reported but does NOT abort the forward: the transcript is the part the user
	 * selected, and losing it because one file could not be copied is the worse
	 * outcome. The hint is only appended when real paths came back, so the model is
	 * never told to read a file that is not there.
	 */
	const materializeSelectionAttachments = useCallback(async (): Promise<string> => {
		if (!narratorId || !roomId) return "";
		const attachmentIds = selectedMessages.flatMap((message) =>
			message.attachments.map((attachment) => attachment.id),
		);
		if (attachmentIds.length === 0) return "";
		try {
			const result = await materializeAttachments.mutateAsync({ narratorId, attachmentIds });
			return result.files.length > 0 ? result.hint : "";
		} catch (error) {
			notifications.show({
				color: "orange",
				title: t("attachmentForwardFailed"),
				message: error instanceof Error ? error.message : "",
			});
			return "";
		}
	}, [materializeAttachments, narratorId, roomId, selectedMessages, t]);

	const handleForwardQuoted = useCallback(() => {
		if (!onForwardToNarrator || selectedMessages.length === 0) return;
		void (async () => {
			const attachmentHint = await materializeSelectionAttachments();
			const text = buildForwardText(selectedMessages, { attachmentHint });
			if (!text.trim()) return;
			onForwardToNarrator(text);
			clearSelection();
		})();
	}, [clearSelection, materializeSelectionAttachments, onForwardToNarrator, selectedMessages]);

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
		// No attachment hint: copying to the clipboard does not (and must not) write
		// files into anyone's worktree, so there are no paths to name.
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
					// Fixed, not padding-derived: this bar sits beside the room list's bar and
					// the two must align across the divider (see chat-header.ts).
					h={CHAT_HEADER_HEIGHT}
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
				{roomId ? (
					<ChatMessageList
						roomId={roomId}
						currentUserId={currentUserId}
						onVisibleSeq={markRead}
						selectedIds={selectedIds}
						onToggleSelect={toggleSelect}
						onReply={setReplyTo}
						onDelete={handleDelete}
					/>
				) : null}
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
							name: replyTo.sender?.isGuest
								? `${replyTo.sender.username} (${t("shareGuest")})`
								: (replyTo.sender?.username ?? t("unknownSender")),
						})}
						{": "}
						{/* An attachment-only target has no body; naming its files is what
						    tells the user which message they are about to answer. */}
						{replyTo.contentText.trim()
							? replyTo.contentText.slice(0, 80)
							: replyTo.attachments.map((attachment) => attachment.filename).join(", ")}
					</Text>
					<ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setReplyTo(null)}>
						<IconX size={14} />
					</ActionIcon>
				</Group>
			) : null}

			<ChatComposerAttachments items={pending} onRemove={handleRemovePending} />

			<Group
				gap="xs"
				align="flex-end"
				p="sm"
				wrap="nowrap"
				style={{ flexShrink: 0, borderTop: "1px solid var(--mantine-color-default-border)" }}
			>
				{/*
				 * `accept` is deliberately unset: the server owns the admissibility rule
				 * (image magic bytes, or the shared text/code extension allowlist), and a
				 * narrower client filter would silently hide files the server accepts.
				 */}
				<FileButton onChange={handlePickFiles} multiple>
					{(props) => (
						<Tooltip label={t("attachFiles")}>
							<ActionIcon
								{...props}
								variant="subtle"
								color="gray"
								size="lg"
								disabled={pending.length >= CHAT_ATTACHMENTS_PER_MESSAGE_MAX}
							>
								<IconPaperclip size={18} />
							</ActionIcon>
						</Tooltip>
					)}
				</FileButton>
				<Textarea
					value={draft}
					onChange={(event) => setDraft(event.currentTarget.value.slice(0, CHAT_MESSAGE_MAX_CHARS))}
					placeholder={t("composerPlaceholder")}
					autosize
					minRows={1}
					maxRows={6}
					style={{ flex: 1 }}
					onPaste={handlePaste}
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
					// Enabled for an attachment-only message, and blocked while an upload is
					// still running — sending then would claim only the finished ids and drop
					// the rest without telling anyone.
					disabled={(!draft.trim() && readyAttachmentIds.length === 0) || hasUploadsInFlight}
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
								void (async () => {
									// The summary describes the selection, so the selection's files
									// have to travel with it — otherwise the summary can reference a
									// screenshot the narrator has no way to open.
									const attachmentHint = await materializeSelectionAttachments();
									onForwardToNarrator(attachmentHint ? `${text}\n${attachmentHint}` : text);
									setSummaryPreview(null);
									clearSelection();
								})();
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
