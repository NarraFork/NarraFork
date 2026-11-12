/**
 * QueuedMessageRow.tsx — one row of the queued-message list above the composer.
 *
 * Split out of NarratorPanel when queued messages became editable as a whole
 * rather than text-only: the row now hosts a small attachment editor, and
 * inlining that would have meant threading five more pieces of draft state
 * through the panel.
 *
 * Following MessageEditorPanel, the row owns its edit draft and is only mounted
 * in edit mode by the parent (`isEditing`), which decides when to unmount. The
 * parent keeps just the id of the row being edited.
 *
 * Idle rows always identify their sender and show attachment previews directly.
 * Double-clicking message content enters edit mode; actions/previews stay independent.
 * Edit mode always shows the retained and newly selected attachments.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Box,
	Button,
	CloseButton,
	Group,
	Menu,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import { type MediaRef, mediaModality, mediaRefToContentBlock } from "@shared/media-attachments";
import {
	IconArrowForwardUp,
	IconBolt,
	IconCheck,
	IconClock,
	IconDotsVertical,
	IconFile,
	IconGripVertical,
	IconPencil,
	IconX,
} from "@tabler/icons-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../../lib/api/types";
import { UserAvatar } from "../../UserAvatar";
import { composerPreviewText } from "../composer/composer-quotes";
import { QueuedImageThumb } from "../composer/EditAttachmentChips";
import { fileReferenceToken } from "../composer/file-reference-input";
import type { QueueMode } from "../composer/SendOptionsSplitButton";
import { EditableComposerDocument } from "../message/EditableComposerDocument";
import { MediaAttachment } from "../message/MediaAttachment";
import { queuedMessageMode } from "./queue-message-mode";
import type { ComposerEditSnapshot, QueuedEditPayload } from "./queued-attachment-edit";

export interface QueuedMessageRowProps {
	msg: BufferMessageSummary;
	/** Legacy images without an explicit upload owner belong to this narrator. */
	narratorId?: string;
	index: number;
	isEditing: boolean;
	onStartEdit: (msg: BufferMessageSummary) => void;
	onCancelEdit: () => void;
	/** Resolves false when the server rejected the edit, so the editor stays open. */
	onSaveEdit: (
		msg: BufferMessageSummary,
		text: string,
		payload: QueuedEditPayload,
	) => Promise<boolean>;
	onRemove: (id: string) => void;
	onRetry: (id: string) => Promise<{ ok: true; resumed: boolean }>;
	cancelBufferLabel: string;
	editLabel: string;
	canMoveUp?: boolean;
	canMoveDown?: boolean;
	/** false rejects the action; void remains compatible with external row hosts. */
	onChangeMode: (id: string, mode: QueueMode) => Promise<boolean> | Promise<void>;
	onMove: (id: string, direction: -1 | 1) => void;
	onClearAll?: () => void;
	urgentStatus?: "sending" | "failed";
	urgentError?: string;
}

function QueuedAttachmentPreview({
	narratorId,
	images,
	textFiles,
	media = [],
	fileReferences = [],
}: {
	narratorId?: string;
	images: BufferedImageSummary[];
	textFiles: BufferedTextFileSummary[];
	media?: MediaRef[];
	fileReferences?: FileReference[];
}) {
	if (
		images.length === 0 &&
		textFiles.length === 0 &&
		media.length === 0 &&
		fileReferences.length === 0
	)
		return null;
	return (
		<Group gap={4} wrap="wrap" data-queue-attachment-preview style={{ minWidth: 0 }}>
			{media.map((attachment) => (
				<MediaAttachment
					key={attachment.mediaId}
					narratorId={narratorId ?? ""}
					block={mediaRefToContentBlock(attachment)}
				/>
			))}
			{images.map((image) => (
				<Box
					key={image.imageId}
					data-queue-image={image.imageId}
					title={image.filename ?? undefined}
					style={{ flexShrink: 0 }}
				>
					<QueuedImageThumb
						imageId={image.imageId}
						filename={image.filename}
						uploadNarratorId={image.uploadNarratorId ?? narratorId}
						contextNarratorId={narratorId}
						size={24}
					/>
				</Box>
			))}
			{fileReferences.map((reference) => (
				<Tooltip key={reference.id} label={`${reference.deviceId}: ${reference.path}`} withinPortal>
					<Text size="xs" c="blue" truncate style={{ maxWidth: 160 }}>
						{fileReferenceToken(reference)}
					</Text>
				</Tooltip>
			))}
			{textFiles.map((file) => (
				<Tooltip key={`${file.index}:${file.filename}`} label={file.filename} withinPortal>
					<Group gap={2} wrap="nowrap" style={{ maxWidth: 160, minWidth: 0 }}>
						<IconFile size={14} color="var(--mantine-color-blue-5)" style={{ flexShrink: 0 }} />
						<Text size="xs" c="blue" truncate>
							{file.filename}
						</Text>
					</Group>
				</Tooltip>
			))}
		</Group>
	);
}

export function QueuedMessageRow({
	msg,
	narratorId,
	index,
	isEditing,
	onStartEdit,
	onCancelEdit,
	onSaveEdit,
	onRemove,
	onRetry,
	cancelBufferLabel,
	editLabel,
	canMoveUp,
	canMoveDown,
	onChangeMode,
	onMove,
	onClearAll,
	urgentStatus,
	urgentError,
}: QueuedMessageRowProps) {
	const { t } = useTranslation("narrator");
	const mode = urgentStatus ? "interrupt" : queuedMessageMode(msg);
	const [textExpanded, setTextExpanded] = useState(false);
	const borderColor =
		mode === "interrupt"
			? "var(--mantine-color-orange-5)"
			: mode === "tool"
				? "var(--mantine-color-indigo-4)"
				: "var(--mantine-color-default-border)";
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: msg.id,
		disabled: mode !== "turn" || isEditing || urgentStatus !== undefined,
	});
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};
	const failed = msg.state === "failed";
	const [retrying, setRetrying] = useState(false);
	const retryingRef = useRef(false);
	const [localChangingMode, setChangingMode] = useState<QueueMode | null>(null);
	const changingMode = urgentStatus === "sending" ? "interrupt" : localChangingMode;
	const changingModeRef = useRef(false);
	const [urgentRequested, setUrgentRequested] = useState(false);
	const urgentRequestedRef = useRef(false);
	const urgentCommitted = urgentRequested;
	const urgentOnly = mode === "interrupt" || urgentStatus !== undefined;
	const nextMode = mode === "turn" ? "tool" : "turn";
	const toggleLabel = t(mode === "turn" ? "queuedSwitchToGuidance" : "queuedSwitchToNextStep");
	const urgentLabel = t(
		urgentCommitted
			? "queuedUrgentRequested"
			: urgentOnly
				? "queuedUrgentRetry"
				: "queuedSendUrgently",
	);
	const changeMode = async (next: QueueMode) => {
		if (
			changingModeRef.current ||
			retryingRef.current ||
			urgentRequestedRef.current ||
			urgentStatus === "sending" ||
			(urgentOnly && next !== "interrupt") ||
			isEditing ||
			(next === "interrupt" && failed && !urgentOnly)
		)
			return;
		changingModeRef.current = true;
		setChangingMode(next);
		try {
			const accepted = await onChangeMode(msg.id, next);
			if (accepted === true && next === "interrupt") {
				// Lock immediately after acceptance, even before the authoritative WS
				// snapshot removes the row or changes its mode. Urgent cannot be undone.
				urgentRequestedRef.current = true;
				setUrgentRequested(true);
			}
		} catch (error) {
			notifications.show({
				color: "red",
				title: t("queuedModeFailed"),
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			changingModeRef.current = false;
			setChangingMode(null);
		}
	};
	const canEdit =
		!isEditing && !retrying && changingMode === null && !urgentCommitted && !urgentOnly;
	const startEditing = () => {
		if (
			isEditing ||
			retryingRef.current ||
			changingModeRef.current ||
			urgentRequestedRef.current ||
			urgentOnly
		)
			return;
		onStartEdit(msg);
	};
	const senderHeader = (
		<Group gap={4} wrap="nowrap" data-queue-sender style={{ minWidth: 0 }}>
			{msg.creator && (
				<UserAvatar
					username={msg.creator.username}
					userId={msg.creator.id}
					avatarColor={msg.creator.avatarColor}
					avatarImageId={msg.creator.avatarImageId}
					size={18}
					showTooltip={false}
				/>
			)}
			<Text size="xs" c="dimmed" truncate title={msg.creator?.username} style={{ minWidth: 0 }}>
				{msg.creator?.username ?? t("queuedSenderUnknown")}
			</Text>
		</Group>
	);
	const [retryError, setRetryError] = useState<string | null>(null);
	const retry = async () => {
		if (retryingRef.current || changingModeRef.current || !failed) return;
		retryingRef.current = true;
		setRetrying(true);
		setRetryError(null);
		try {
			await onRetry(msg.id);
			// Admission may leave this queued without waking a narrator. Never claim execution.
			notifications.show({ color: "blue", message: t("queuedRetrySuccess") });
		} catch (error) {
			setRetryError(error instanceof Error ? error.message : String(error));
		} finally {
			retryingRef.current = false;
			setRetrying(false);
		}
	};
	const failureNotice = failed ? (
		<Stack gap={2}>
			<Text size="xs" c="red" fw={500}>
				{t("queuedFailed")}
			</Text>
			<Text size="xs" c="red" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{msg.error || t("queuedFailureUnknown")}
			</Text>
			{retryError && (
				<Text size="xs" c="red" role="alert" style={{ overflowWrap: "anywhere" }}>
					{t("queuedRetryFailed", { error: retryError })}
				</Text>
			)}
		</Stack>
	) : null;

	const [snapshot, setSnapshot] = useState<ComposerEditSnapshot>();
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const msgRef = useRef(msg);
	msgRef.current = msg;
	const canSubmit =
		!!snapshot &&
		(!!snapshot.text.trim() ||
			snapshot.fileReferences.length > 0 ||
			snapshot.composerDocument.assets.length > 0);
	const submit = useCallback(async () => {
		if (!snapshot || !canSubmit || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			const ok = await onSaveEdit(msgRef.current, snapshot.text, snapshot);
			if (ok) onCancelEdit();
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}, [snapshot, canSubmit, onSaveEdit, onCancelEdit]);

	const dragHandle = (children: React.ReactNode) => (
		<div
			{...attributes}
			{...listeners}
			data-queue-drag-handle
			style={{
				cursor: "grab",
				display: "flex",
				alignItems: "center",
				flexShrink: 0,
				touchAction: "none",
				minWidth: 24,
				minHeight: 24,
				justifyContent: "center",
			}}
		>
			{children}
		</div>
	);

	if (!isEditing) {
		return (
			<Group
				ref={setNodeRef}
				style={style}
				px="md"
				py={4}
				gap="xs"
				wrap="nowrap"
				bg="var(--mantine-color-default-hover)"
				data-queue-message-row={msg.id}
				onDoubleClick={(event) => {
					const target = event.target;
					if (!(target instanceof Element) || !event.currentTarget.contains(target)) return;
					if (
						target.closest(
							"button, a, input, textarea, select, [role='button'], [data-queue-attachment-preview], [data-queue-drag-handle]",
						)
					)
						return;
					event.preventDefault();
					startEditing();
				}}
			>
				{mode === "turn" &&
					dragHandle(<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />)}
				<Stack
					gap={2}
					data-queue-mode={mode}
					style={{
						flex: 1,
						minWidth: 0,
						borderLeft: `2px solid ${borderColor}`,
						paddingLeft: 8,
					}}
				>
					{senderHeader}
					<Text
						component="button"
						type="button"
						size="xs"
						lineClamp={textExpanded ? undefined : 2}
						aria-expanded={textExpanded}
						aria-label={t(textExpanded ? "queuedCollapseText" : "queuedExpandText")}
						title={t("queuedDoubleClickEdit")}
						onDoubleClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							startEditing();
						}}
						onClick={() => setTextExpanded((expanded) => !expanded)}
						onKeyDown={(event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								setTextExpanded((expanded) => !expanded);
							}
						}}
						style={{
							overflowWrap: "anywhere",
							whiteSpace: "pre-wrap",
							border: 0,
							padding: 0,
							background: "transparent",
							color: "inherit",
							textAlign: "left",
							cursor: "pointer",
						}}
					>
						{composerPreviewText(msg.text, {
							images: (msg.images ?? []).map((image) => image.filename),
							files: (msg.textFiles ?? []).map((file) => file.filename),
						})}
					</Text>
					<QueuedAttachmentPreview
						narratorId={narratorId}
						images={msg.images ?? []}
						media={msg.media ?? []}
						textFiles={msg.textFiles ?? []}
						fileReferences={msg.fileReferences}
					/>
					{urgentOnly && (
						<Text
							size="xs"
							c={urgentStatus === "sending" ? "orange" : "red"}
							role="status"
							data-urgent-status={urgentStatus ?? "failed"}
						>
							{t(urgentStatus === "sending" ? "queuedUrgentSending" : "queuedUrgentUndelivered")}
							{urgentError && `: ${urgentError}`}
						</Text>
					)}
					{failureNotice}
				</Stack>
				{failed && !urgentOnly && (
					<Button
						size="compact-xs"
						color="red"
						variant="light"
						loading={retrying}
						disabled={retrying || changingMode !== null}
						onClick={() => void retry()}
					>
						{t("queuedRetry")}
					</Button>
				)}
				{!urgentCommitted && !urgentOnly && (
					<Tooltip label={toggleLabel} withinPortal>
						<ActionIcon
							size="sm"
							variant="subtle"
							color={mode === "turn" ? "indigo" : "gray"}
							aria-label={toggleLabel}
							disabled={retrying || changingMode !== null}
							loading={changingMode !== null && changingMode !== "interrupt"}
							onClick={() => void changeMode(nextMode)}
						>
							{mode === "turn" ? <IconArrowForwardUp size={14} /> : <IconClock size={14} />}
						</ActionIcon>
					</Tooltip>
				)}
				<Tooltip
					label={urgentCommitted ? urgentLabel : `${urgentLabel}. ${t("queuedInterruptWarning")}`}
					withinPortal
					multiline
					maw={260}
				>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="orange"
						aria-label={urgentLabel}
						disabled={
							(failed && !urgentOnly) || retrying || changingMode !== null || urgentCommitted
						}
						loading={changingMode === "interrupt"}
						onClick={() => void changeMode("interrupt")}
					>
						<IconBolt size={14} />
					</ActionIcon>
				</Tooltip>
				<Menu withinPortal position="top-end">
					<Menu.Target>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							disabled={retrying || changingMode !== null}
							aria-label={t("queuedActions")}
						>
							<IconDotsVertical size={14} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item
							leftSection={<IconPencil size={14} />}
							disabled={!canEdit}
							onClick={startEditing}
						>
							{editLabel}
						</Menu.Item>

						{mode === "turn" && (
							<>
								<Menu.Divider />
								<Menu.Item disabled={!canMoveUp} onClick={() => onMove(msg.id, -1)}>
									{t("queuedMoveUp")}
								</Menu.Item>
								<Menu.Item disabled={!canMoveDown} onClick={() => onMove(msg.id, 1)}>
									{t("queuedMoveDown")}
								</Menu.Item>
							</>
						)}
						<Menu.Divider />
						<Menu.Item color="red" onClick={() => onRemove(msg.id)}>
							{cancelBufferLabel}
						</Menu.Item>
						{onClearAll && (
							<Menu.Item color="red" onClick={onClearAll}>
								{t("clearAllQueued")}
							</Menu.Item>
						)}
					</Menu.Dropdown>
				</Menu>
				<Tooltip label={cancelBufferLabel} withinPortal>
					<CloseButton
						size="sm"
						variant="subtle"
						aria-label={cancelBufferLabel}
						title={cancelBufferLabel}
						disabled={retrying || changingMode !== null}
						onClick={(event) => {
							event.stopPropagation();
							if (!retryingRef.current && !changingModeRef.current) onRemove(msg.id);
						}}
					/>
				</Tooltip>
			</Group>
		);
	}

	return (
		<Group
			ref={setNodeRef}
			style={style}
			px="md"
			py={4}
			gap="xs"
			align="flex-start"
			wrap="nowrap"
			bg="var(--mantine-color-default-hover)"
		>
			{mode === "turn" &&
				dragHandle(
					<Text size="xs" c="dimmed" w={16} ta="center">
						{index + 1}
					</Text>,
				)}
			<Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
				{senderHeader}
				{failureNotice}
				<EditableComposerDocument
					key={msg.id}
					text={msg.text}
					fileReferences={msg.fileReferences ?? []}
					attachments={[
						...(msg.images ?? []).map((image) => ({
							kind: "image" as const,
							imageId: image.imageId,
							name: image.filename ?? "image",
							size: 0,
							mimeType: image.mediaType,
							uploadNarratorId: image.uploadNarratorId ?? narratorId,
						})),
						...(msg.media ?? []).map((media) => ({
							kind: mediaModality(media.mediaType) ?? "audio",
							mediaId: media.mediaId,
							name: media.filename,
							size: media.size,
							mimeType: media.mediaType,
							uploadNarratorId: media.uploadNarratorId ?? narratorId,
						})),
						...(msg.textFiles ?? []).map((file) => ({
							kind: "textFile" as const,
							index: file.index,
							name: file.filename,
							size: file.size,
							mimeType: "text/plain",
						})),
					]}
					loadDocument={
						narratorId
							? (signal) => api.getBufferedMessageComposerDocument(narratorId, msg.id, signal)
							: undefined
					}
					narratorId={narratorId}
					messageId={msg.id}
					onChange={setSnapshot}
					disabled={submitting}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void submit();
						}
						if (event.key === "Escape" && !submittingRef.current) onCancelEdit();
					}}
				/>
			</Stack>
			<ActionIcon
				size="xs"
				variant="subtle"
				color="green"
				disabled={!canSubmit}
				loading={submitting}
				onClick={() => void submit()}
			>
				<IconCheck size={12} />
			</ActionIcon>
			<ActionIcon
				size="xs"
				variant="subtle"
				color="gray"
				disabled={submitting}
				onClick={onCancelEdit}
			>
				<IconX size={12} />
			</ActionIcon>
		</Group>
	);
}

/** Re-exported so the collapsed summary bar can show the same attachment strip. */
export { QueuedAttachmentPreview };
