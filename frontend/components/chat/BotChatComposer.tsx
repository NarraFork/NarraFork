/**
 * BotChatComposer.tsx — The narrator composer, posting into a bot room.
 *
 * Talking to a bot is typing into its input, so its chat gets the same editor as
 * the narrator page: inline images and files, `#file` references into the bot's
 * working directory, @mentions, input history, prompt optimization, fullscreen
 * editing and drag-and-drop. What it sends is still an ordinary chat post — the
 * text plus uploaded chat attachments — because the room is where the bot's
 * conversation lives and `admitBotPost` is how it reaches the bot.
 *
 * Two things differ from the narrator page on purpose:
 *  - The draft stays in this browser, keyed by room. The bot's own server draft is
 *    its monitor composer, which a person chatting must not overwrite.
 *  - No slash menu: chat text reaches the bot literally (`executionIntent.literal`),
 *    so offering commands would promise something that never happens.
 */

import { ActionIcon, Box, Button, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { composerDocumentText, parseComposerDocument } from "@shared/composer-document";
import { IconPaperclip, IconSend } from "@tabler/icons-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useSendChatMessage } from "../../hooks/useChat";
import { useWorkspaceContext, workspaceFileTarget } from "../../hooks/useWorkspaceContext";
import { api } from "../../lib/api";
import type { ChatMessage } from "../../lib/api/chat";
import { hasSendableComposerContent } from "../narrator/composer/composer-send-gate";
import { FileReferenceScopeProvider } from "../narrator/composer/FileReferenceScope";
import { trimFileReferenceInput } from "../narrator/composer/file-reference-input";
import {
	NarratorComposer,
	type NarratorComposerHandle,
} from "../narrator/composer/NarratorComposer";
import { DropOverlay } from "../narrator/interaction/DropOverlay";
import { UploadProgressBar } from "../narrator/interaction/UploadProgressBar";
import { useComposerAttachments } from "../narrator/interaction/use-composer-attachments";
import { useComposerFileIngest } from "../narrator/interaction/use-composer-file-ingest";
import {
	type NarratorSendingState,
	snapshotComposerFiles,
} from "../narrator/interaction/use-narrator-send";
import { CHAT_ATTACHMENTS_PER_MESSAGE_MAX, CHAT_MESSAGE_MAX_CHARS } from "./chat-limits";

/** Local key for this room's draft, input history and staged files. Names no narrator. */
export function botChatComposerKey(roomId: string): string {
	return `bot-chat:${roomId}`;
}

export interface BotChatComposerProps {
	/** The bot: file search and prompt optimization run against it. */
	narratorId: string;
	roomId: string;
	/** The message being answered, owned by the room view (it renders the strip). */
	replyTo: ChatMessage | null;
	onSent: () => void;
}

export function BotChatComposer({ narratorId, roomId, replyTo, onSent }: BotChatComposerProps) {
	const { t } = useTranslation("chat");
	const { t: tn } = useTranslation("narrator");
	const { data: currentUser } = useCurrentUser();
	const currentUserId = currentUser?.id ? String(currentUser.id) : null;
	const composerKey = botChatComposerKey(roomId);
	const sendMessage = useSendChatMessage(roomId);
	const { data: workspaceContext } = useWorkspaceContext(narratorId);
	const fileScope = useMemo(
		() => ({ narratorId, context: workspaceFileTarget(workspaceContext) }),
		[narratorId, workspaceContext],
	);

	const [hasText, setHasText] = useState(false);
	const [sendingState, setSendingState] = useState<NarratorSendingState | null>(null);
	const composerRef = useRef<NarratorComposerHandle>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const sendingRef = useRef(false);
	const sendAbortRef = useRef<AbortController | null>(null);

	const {
		attachedImages,
		attachedTextFiles,
		attachmentsHydrating,
		attachmentsRestoreFailed,
		retryAttachmentRestore,
		restoredAttachmentResources,
		isDragging,
		setIsDragging,
		dragCounterRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		reconcileDocumentAssets,
		clearAttachedFilesAndDraft,
	} = useComposerAttachments({ narratorId: composerKey, currentUserId, sendingRef, t: tn });
	const { handleFileInputChange, handleComposerPasteImages, dropZoneProps, ingestingRef } =
		useComposerFileIngest({
			narratorId: composerKey,
			sendingRef,
			updateAttachedImages,
			updateAttachedTextFiles,
			setIsDragging,
			dragCounterRef,
			captureInsertion: (origin) => composerRef.current?.captureAttachmentInsertion(origin),
			onAcceptedFiles: (files, bookmark) =>
				composerRef.current?.insertAcceptedFiles(files, bookmark) ?? false,
			t: tn,
		});
	const hasAttachments = attachedImages.length + attachedTextFiles.length > 0;

	const fail = (message: string) =>
		notifications.show({ color: "red", title: t("sendFailed"), message });

	const send = async () => {
		const composer = composerRef.current;
		if (!composer || sendingRef.current || ingestingRef.current) return;
		const rawText = composer.getText();
		const liveDocument = composer.getDocument();
		const document = liveDocument ? parseComposerDocument(liveDocument) : undefined;
		const { text, fileReferences, composerDocument } = document
			? { ...composerDocumentText(document), composerDocument: document }
			: {
					...trimFileReferenceInput({
						text: rawText,
						fileReferences: composer.getFileReferences(),
					}),
					composerDocument: undefined,
				};
		const files = snapshotComposerFiles(composerDocument, attachedImages, attachedTextFiles);
		if (!files || composer.hasMissingAssets()) {
			fail(tn("composerMissingAssets"));
			return;
		}
		const all = [...files.images, ...files.textFiles];
		if (
			!hasSendableComposerContent({
				text: rawText,
				imageCount: files.images.length,
				textFileCount: files.textFiles.length,
				fileReferenceCount: fileReferences.length,
			})
		)
			return;
		// The room's limits, checked before anything is uploaded: the server would refuse
		// the post anyway, after the files had already gone up.
		const body = text.trim();
		if (body.length > CHAT_MESSAGE_MAX_CHARS) {
			fail(t("messageTooLong", { count: CHAT_MESSAGE_MAX_CHARS }));
			return;
		}
		if (all.length > CHAT_ATTACHMENTS_PER_MESSAGE_MAX) {
			fail(t("attachmentLimit", { count: CHAT_ATTACHMENTS_PER_MESSAGE_MAX }));
			return;
		}

		sendingRef.current = true;
		const abort = new AbortController();
		sendAbortRef.current = abort;
		setSendingState({
			attachmentCount: all.length,
			progress: all.length > 0 ? 0 : null,
			canCancel: all.length > 0,
		});
		const uploaded: string[] = [];
		try {
			for (const file of all) {
				if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
				uploaded.push((await api.uploadChatAttachment(roomId, file)).id);
				setSendingState((state) =>
					state ? { ...state, progress: uploaded.length / all.length } : state,
				);
			}
			if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
			setSendingState((state) => (state ? { ...state, canCancel: false } : state));
			await sendMessage.mutateAsync({
				text: body,
				replyToMessageId: replyTo?.id ?? null,
				...(uploaded.length > 0 ? { attachmentIds: uploaded } : {}),
			});
			composer.noteSent(text, fileReferences, composerDocument);
			composer.clearTextAndDraft();
			clearAttachedFilesAndDraft();
			onSent();
		} catch (error) {
			// The composer still holds every file, so a retry uploads them again; the drafts
			// this attempt made would otherwise wait for the storage sweep.
			for (const id of uploaded) api.deleteChatAttachment(id).catch(() => {});
			if (error instanceof DOMException && error.name === "AbortError") {
				notifications.show({ message: tn("sendCancelled"), color: "gray", autoClose: 2000 });
			} else {
				fail(error instanceof Error ? error.message : String(error));
			}
		} finally {
			sendingRef.current = false;
			sendAbortRef.current = null;
			setSendingState(null);
		}
	};

	const sending = sendingState != null;

	return (
		<FileReferenceScopeProvider value={fileScope}>
			<Box
				{...dropZoneProps}
				px="sm"
				py="xs"
				style={{
					position: "relative",
					flexShrink: 0,
					borderTop: "1px solid var(--mantine-color-default-border)",
				}}
			>
				<DropOverlay visible={isDragging} />
				<UploadProgressBar
					sendingState={sendingState}
					cancelSending={() => sendAbortRef.current?.abort()}
				/>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					style={{ display: "none" }}
					onChange={handleFileInputChange}
					disabled={sending}
				/>
				<NarratorComposer
					ref={composerRef}
					narratorId={composerKey}
					draft={{ cwd: null, sessionId: narratorId, commands: false }}
					sendingRef={sendingRef}
					sending={sending}
					permEnterActive={false}
					hasAttachments={hasAttachments}
					enterMode="turn"
					ctrlEnterMode="turn"
					onSendWithMode={() => send()}
					onTextFlagsChange={setHasText}
					onPasteImages={handleComposerPasteImages}
					attachedImages={attachedImages}
					attachedTextFiles={attachedTextFiles}
					attachmentsHydrating={attachmentsHydrating}
					attachmentsRestoreFailed={attachmentsRestoreFailed}
					onRetryAttachments={retryAttachmentRestore}
					restoredAttachmentResources={restoredAttachmentResources}
					onDocumentAssetsChange={reconcileDocumentAssets}
					onAttachmentsChange={(images, textFiles) => {
						updateAttachedImages(images);
						updateAttachedTextFiles(textFiles);
					}}
					controls={
						<Tooltip label={tn("attachFile")}>
							<ActionIcon
								aria-label={tn("attachFile")}
								variant="subtle"
								color="gray"
								disabled={sending}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => {
									composerRef.current?.captureAttachmentSelection();
									fileInputRef.current?.click();
								}}
							>
								<IconPaperclip size={18} />
							</ActionIcon>
						</Tooltip>
					}
					actions={
						<Button
							onClick={() => void send()}
							loading={sending}
							disabled={!hasText && !hasAttachments}
							leftSection={<IconSend size={14} />}
						>
							{t("send")}
						</Button>
					}
				/>
			</Box>
		</FileReferenceScopeProvider>
	);
}
