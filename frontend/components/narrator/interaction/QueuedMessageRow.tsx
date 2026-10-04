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
 * Idle rows show attachment counts; users can expand previews on demand.
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
	Textarea,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import { isTextFile, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import {
	IconArrowForwardUp,
	IconBolt,
	IconCheck,
	IconClock,
	IconDotsVertical,
	IconFile,
	IconGripVertical,
	IconPaperclip,
	IconPencil,
	IconX,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../../lib/api/types";
import {
	EditNewImageThumb,
	EditTextFileChip,
	QueuedImageThumb,
} from "../composer/EditAttachmentChips";
import {
	editFileReferenceInput,
	type FileReferenceInput,
	fileReferenceToken,
} from "../composer/file-reference-input";
import type { QueueMode } from "../composer/SendOptionsSplitButton";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "../narrator-panel-types";
import { queuedMessageMode } from "./queue-message-mode";
import {
	buildQueuedEditPayload,
	canSubmitQueuedEdit,
	MAX_QUEUED_IMAGES,
	MAX_QUEUED_TEXT_FILES,
	type QueuedEditPayload,
	remainingImageRoom,
	remainingTextFileRoom,
	seedQueuedEditAttachments,
} from "./queued-attachment-edit";

/** Thumbnails shown inline before collapsing the rest into a "+N" badge. */
const INLINE_THUMB_LIMIT = 3;

export interface QueuedMessageRowProps {
	msg: BufferMessageSummary;
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
	showAuthor?: boolean;
	canMoveUp?: boolean;
	canMoveDown?: boolean;
	/** false rejects the action; void remains compatible with external row hosts. */
	onChangeMode: (id: string, mode: QueueMode) => Promise<boolean> | Promise<void>;
	onMove: (id: string, direction: -1 | 1) => void;
	onClearAll?: () => void;
}

/** Read-only attachment strip for the collapsed/idle row. */
function QueuedAttachmentPreview({
	images,
	textFiles,
	fileReferences = [],
}: {
	images: BufferedImageSummary[];
	textFiles: BufferedTextFileSummary[];
	fileReferences?: FileReference[];
}) {
	const { t } = useTranslation("narrator");
	if (images.length === 0 && textFiles.length === 0 && fileReferences.length === 0) return null;
	const shown = images.slice(0, INLINE_THUMB_LIMIT);
	const overflow = images.length - shown.length;
	return (
		<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			{shown.map((image) => (
				<QueuedImageThumb
					key={image.imageId}
					imageId={image.imageId}
					filename={image.filename}
					uploadNarratorId={image.uploadNarratorId}
				/>
			))}
			{fileReferences.map((reference) => (
				<Tooltip key={reference.id} label={`${reference.deviceId}: ${reference.path}`}>
					<Text size="xs" c="blue" truncate style={{ maxWidth: 160 }}>
						{fileReferenceToken(reference)}
					</Text>
				</Tooltip>
			))}
			{overflow > 0 && (
				<Text size="xs" c="blue">
					{t("queuedMoreImages", { count: overflow })}
				</Text>
			)}
			{textFiles.length > 0 && (
				<Tooltip label={textFiles.map((file) => file.filename).join("\n")} multiline>
					<Group gap={2} wrap="nowrap">
						<IconFile size={14} color="var(--mantine-color-blue-5)" />
						<Text size="xs" c="blue">
							{textFiles.length}
						</Text>
					</Group>
				</Tooltip>
			)}
		</Group>
	);
}

export function QueuedMessageRow({
	msg,
	index,
	isEditing,
	onStartEdit,
	onCancelEdit,
	onSaveEdit,
	onRemove,
	onRetry,
	cancelBufferLabel,
	editLabel,
	showAuthor,
	canMoveUp,
	canMoveDown,
	onChangeMode,
	onMove,
	onClearAll,
}: QueuedMessageRowProps) {
	const { t } = useTranslation("narrator");
	const mode = queuedMessageMode(msg);
	const [attachmentsExpanded, setAttachmentsExpanded] = useState(false);
	const [textExpanded, setTextExpanded] = useState(false);
	const borderColor =
		mode === "interrupt"
			? "var(--mantine-color-orange-5)"
			: mode === "tool"
				? "var(--mantine-color-indigo-4)"
				: "var(--mantine-color-default-border)";
	const attachmentCount =
		(msg.images?.length ?? 0) + (msg.textFiles?.length ?? 0) + (msg.fileReferences?.length ?? 0);
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: msg.id,
		disabled: mode !== "turn" || isEditing,
	});
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};
	const failed = msg.state === "failed";
	const [retrying, setRetrying] = useState(false);
	const retryingRef = useRef(false);
	const [changingMode, setChangingMode] = useState<QueueMode | null>(null);
	const changingModeRef = useRef(false);
	const [urgentRequested, setUrgentRequested] = useState(false);
	const urgentRequestedRef = useRef(false);
	const urgentCommitted = mode === "interrupt" || urgentRequested;
	const nextMode = mode === "turn" ? "tool" : "turn";
	const toggleLabel = t(mode === "turn" ? "queuedSwitchToGuidance" : "queuedSwitchToNextStep");
	const urgentLabel = t(
		urgentCommitted && !failed ? "queuedUrgentRequested" : "queuedSendUrgently",
	);
	const changeMode = async (next: QueueMode) => {
		if (
			changingModeRef.current ||
			retryingRef.current ||
			urgentRequestedRef.current ||
			mode === "interrupt" ||
			isEditing ||
			(next === "interrupt" && failed)
		)
			return;
		changingModeRef.current = true;
		setChangingMode(next);
		try {
			const accepted = await onChangeMode(msg.id, next);
			if (accepted !== false && next === "interrupt") {
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

	const [text, setText] = useState(msg.text);
	const [keptImages, setKeptImages] = useState<BufferedImageSummary[]>([]);
	const [newImages, setNewImages] = useState<File[]>([]);
	const [keptTextFiles, setKeptTextFiles] = useState<BufferedTextFileSummary[]>([]);
	const [newTextFiles, setNewTextFiles] = useState<File[]>([]);
	const [fileReferences, setFileReferences] = useState<FileReference[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);
	const beforeEditRef = useRef<{ start: number; end: number; backward?: boolean } | undefined>(
		undefined,
	);
	const undoStackRef = useRef<FileReferenceInput[]>([]);
	const composingRef = useRef(false);
	const compositionUndoSavedRef = useRef(false);
	const captureEditRange = useCallback((textarea: HTMLTextAreaElement, inputType = "") => {
		beforeEditRef.current = {
			start: textarea.selectionStart,
			end: textarea.selectionEnd,
			backward: inputType.includes("Backward"),
		};
	}, []);
	// Unlike React's synthesized onBeforeInput, native beforeinput includes
	// keyboard deletion and clipboard edits, before the DOM changes selection.
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea || !isEditing) return;
		const beforeInput = (event: Event) =>
			captureEditRange(textarea, (event as InputEvent).inputType);
		textarea.addEventListener("beforeinput", beforeInput);
		return () => textarea.removeEventListener("beforeinput", beforeInput);
	}, [isEditing, captureEditRange]);
	// The kept counts are read inside the async image flow, where a removal during
	// the await would otherwise be missed by a stale closure.
	const keptImageCountRef = useRef(0);
	keptImageCountRef.current = keptImages.length;

	// Latest summary, read by the seeding effect below.
	//
	// The effect must NOT depend on `msg` itself: a `buffer_set` broadcast replaces
	// the object identity on every queue change (someone else queues a message, the
	// queue reorders), and re-running the seed would wipe the edit in progress.
	// Seeding happens when this row enters edit mode, and a ref is what lets that
	// read the current summary without subscribing to its identity.
	const msgRef = useRef(msg);
	msgRef.current = msg;

	// Entering edit mode is the only trigger. The parent keys rows by message id,
	// so a row instance belongs to one queue entry for its whole life and there is
	// nothing else to re-seed on.
	useEffect(() => {
		if (!isEditing) return;
		beforeEditRef.current = undefined;
		undoStackRef.current = [];
		composingRef.current = false;
		compositionUndoSavedRef.current = false;
		const current = msgRef.current;
		const seeded = seedQueuedEditAttachments(current);
		setText(current.text);
		setKeptImages(seeded.keptImages);
		setKeptTextFiles(seeded.keptTextFiles);
		setFileReferences(seeded.fileReferences);
		setNewImages([]);
		setNewTextFiles([]);
	}, [isEditing]);

	const addImages = useCallback(
		async (files: File[]) => {
			const valid = files.filter(
				(file) => ACCEPTED_TYPES.includes(file.type) && file.size <= MAX_IMAGE_SIZE,
			);
			if (valid.length === 0) return;
			const processed: File[] = [];
			for (const file of valid) {
				// GIF may be animated; resizing would flatten it.
				if (file.type === "image/gif") {
					processed.push(file);
					continue;
				}
				try {
					processed.push(await resizeImageIfNeeded(file, MAX_IMAGE_LONG_EDGE));
				} catch {
					processed.push(file);
				}
			}
			setNewImages((prev) => {
				const room = remainingImageRoom(keptImageCountRef.current, prev.length);
				if (processed.length > room) {
					notifications.show({
						color: "yellow",
						message: t("editTooManyImages", { max: MAX_QUEUED_IMAGES }),
					});
				}
				return [...prev, ...processed.slice(0, room)];
			});
		},
		[t],
	);

	const addTextFiles = useCallback(
		(files: File[]) => {
			const valid: File[] = [];
			for (const file of files) {
				if (!isTextFile(file.name)) {
					notifications.show({
						color: "yellow",
						title: t("unsupportedFileType"),
						message: file.name,
					});
					continue;
				}
				if (file.size > MAX_TEXT_FILE_SIZE) {
					notifications.show({
						color: "yellow",
						title: t("textFileTooLarge"),
						message: `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
					});
					continue;
				}
				valid.push(file);
			}
			if (valid.length === 0) return;
			setNewTextFiles((prev) => {
				const room = remainingTextFileRoom(keptTextFiles.length, prev.length);
				if (valid.length > room) {
					notifications.show({
						color: "yellow",
						message: t("editTooManyFiles", { max: MAX_QUEUED_TEXT_FILES }),
					});
				}
				return [...prev, ...valid.slice(0, room)];
			});
		},
		[keptTextFiles.length, t],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			captureEditRange(e.currentTarget);
			const images: File[] = [];
			const files: File[] = [];
			for (const item of e.clipboardData.items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) images.push(file);
				} else if (item.kind === "file") {
					const file = item.getAsFile();
					if (file && isTextFile(file.name) && file.size <= MAX_TEXT_FILE_SIZE) {
						files.push(file);
					}
				}
			}
			if (images.length === 0 && files.length === 0) return;
			// Only claim the paste once we know it carried an attachment, so normal
			// text paste keeps working.
			e.preventDefault();
			if (images.length > 0) void addImages(images);
			if (files.length > 0) addTextFiles(files);
		},
		[addImages, addTextFiles, captureEditRange],
	);

	const editState = useMemo(
		() => ({ text, keptImages, newImages, keptTextFiles, newTextFiles, fileReferences }),
		[text, keptImages, newImages, keptTextFiles, newTextFiles, fileReferences],
	);
	const canSubmit = canSubmitQueuedEdit(editState);

	const submit = useCallback(async () => {
		if (!canSubmit || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		try {
			const ok = await onSaveEdit(msgRef.current, text.trim(), buildQueuedEditPayload(editState));
			// A rejected edit keeps the draft — including uploads the user selected —
			// so the attempt can be corrected instead of retyped.
			if (ok) onCancelEdit();
		} finally {
			submittingRef.current = false;
			setSubmitting(false);
		}
	}, [canSubmit, onSaveEdit, text, editState, onCancelEdit]);

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
					{showAuthor && msg.creator && (
						<Text size="xs" c="dimmed">
							{msg.creator.username}
						</Text>
					)}
					<Text
						component="button"
						type="button"
						size="xs"
						lineClamp={textExpanded ? undefined : 2}
						aria-expanded={textExpanded}
						aria-label={t(textExpanded ? "queuedCollapseText" : "queuedExpandText")}
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
						{msg.text}
					</Text>
					{attachmentCount > 0 && (
						<Button
							size="compact-xs"
							variant="subtle"
							color="gray"
							style={{ alignSelf: "flex-start" }}
							onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
							aria-expanded={attachmentsExpanded}
						>
							{t("queuedAttachments", { count: attachmentCount })}
						</Button>
					)}
					{attachmentsExpanded && (
						<QueuedAttachmentPreview
							images={msg.images ?? []}
							textFiles={msg.textFiles ?? []}
							fileReferences={msg.fileReferences}
						/>
					)}
					{failureNotice}
				</Stack>
				{failed && (
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
				{!urgentCommitted && (
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
						disabled={failed || retrying || changingMode !== null || urgentCommitted}
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
						<Menu.Item leftSection={<IconPencil size={14} />} onClick={() => onStartEdit(msg)}>
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
			</Group>
		);
	}

	const hasImages = keptImages.length > 0 || newImages.length > 0;
	const hasTextFiles = keptTextFiles.length > 0 || newTextFiles.length > 0;

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
				{failureNotice}
				<Textarea
					ref={textareaRef}
					size="xs"
					value={text}
					disabled={submitting}
					onCompositionStart={(e) => {
						captureEditRange(e.currentTarget);
						composingRef.current = true;
						compositionUndoSavedRef.current = false;
					}}
					onCompositionEnd={() => {
						composingRef.current = false;
					}}
					onChange={(e) => {
						const next = e.currentTarget.value;
						const range = beforeEditRef.current;
						beforeEditRef.current = undefined;
						if (next === text) return;
						const previous = { text, fileReferences };
						if (!composingRef.current || !compositionUndoSavedRef.current) {
							undoStackRef.current.push(previous);
							if (undoStackRef.current.length > 100) undoStackRef.current.shift();
							if (composingRef.current) compositionUndoSavedRef.current = true;
						}
						if (range && range.start === range.end && next.length < text.length) {
							const removed = text.length - next.length;
							if (range.backward) range.start = Math.max(0, range.start - removed);
							else range.end += removed;
						}
						const edited = editFileReferenceInput(previous, next, range);
						setText(edited.text);
						setFileReferences(edited.fileReferences);
					}}
					onPaste={handlePaste}
					onKeyDown={(e) => {
						captureEditRange(e.currentTarget, e.key === "Backspace" ? "deleteBackward" : "");
						if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
							return;
						if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
							const previous = undoStackRef.current.pop();
							if (previous) {
								e.preventDefault();
								beforeEditRef.current = undefined;
								setText(previous.text);
								setFileReferences(previous.fileReferences);
							}
							return;
						}
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void submit();
						}
						if (e.key === "Escape") onCancelEdit();
					}}
					autosize
					minRows={1}
					maxRows={6}
					autoFocus
				/>
				{hasImages && (
					<Group gap="xs" wrap="wrap">
						{keptImages.map((image) => (
							<Box key={`kept-${image.imageId}`} pos="relative" style={{ display: "inline-block" }}>
								<QueuedImageThumb
									imageId={image.imageId}
									filename={image.filename}
									uploadNarratorId={image.uploadNarratorId}
									size={44}
								/>
								<CloseButton
									size="xs"
									radius="xl"
									variant="filled"
									color="dark"
									style={{ position: "absolute", top: -6, right: -6 }}
									disabled={submitting}
									title={t("removeImage")}
									onClick={() =>
										setKeptImages((prev) => prev.filter((k) => k.imageId !== image.imageId))
									}
								/>
							</Box>
						))}
						{newImages.map((file, i) => (
							<EditNewImageThumb
								// biome-ignore lint/suspicious/noArrayIndexKey: new files have no stable id
								key={`new-${i}-${file.name}-${file.size}`}
								file={file}
								disabled={submitting}
								onRemove={() => setNewImages((prev) => prev.filter((_, idx) => idx !== i))}
							/>
						))}
					</Group>
				)}
				{hasTextFiles && (
					<Group gap="xs" wrap="wrap">
						{keptTextFiles.map((file) => (
							<EditTextFileChip
								key={`kept-file-${file.index}-${file.filename}`}
								filename={file.filename}
								size={file.size}
								disabled={submitting}
								onRemove={() =>
									setKeptTextFiles((prev) => prev.filter((k) => k.index !== file.index))
								}
							/>
						))}
						{newTextFiles.map((file, i) => (
							<EditTextFileChip
								// biome-ignore lint/suspicious/noArrayIndexKey: new files have no stable id
								key={`new-file-${i}-${file.name}-${file.size}`}
								filename={file.name}
								size={file.size}
								disabled={submitting}
								onRemove={() => setNewTextFiles((prev) => prev.filter((_, idx) => idx !== i))}
							/>
						))}
					</Group>
				)}
				{fileReferences.length > 0 && (
					<Group gap="xs" wrap="wrap">
						{fileReferences.map((reference) => (
							<Group
								key={reference.id}
								gap={4}
								wrap="nowrap"
								title={`${reference.deviceId}: ${reference.path}`}
							>
								<Text size="xs" c="blue" truncate style={{ maxWidth: 240 }}>
									{fileReferenceToken(reference)}
								</Text>
								<CloseButton
									size="xs"
									disabled={submitting}
									aria-label={`${t("removeFile")}: ${reference.label}`}
									onClick={() =>
										setFileReferences((previous) =>
											previous.filter((item) => item.id !== reference.id),
										)
									}
								/>
							</Group>
						))}
					</Group>
				)}
				<Group gap={4} justify="space-between">
					<Tooltip label={t("attachFile")}>
						<ActionIcon
							size="sm"
							variant="subtle"
							color="gray"
							disabled={submitting}
							aria-label={t("attachFile")}
							onClick={() => fileInputRef.current?.click()}
						>
							<IconPaperclip size={14} />
						</ActionIcon>
					</Tooltip>
					{!canSubmit && (
						<Text size="xs" c="dimmed">
							{t("queuedEditEmptyHint")}
						</Text>
					)}
				</Group>
				<input
					ref={fileInputRef}
					type="file"
					multiple
					disabled={submitting}
					style={{ display: "none" }}
					onChange={(e) => {
						const files = Array.from(e.target.files ?? []);
						const images = files.filter((file) => ACCEPTED_TYPES.includes(file.type));
						const others = files.filter((file) => !ACCEPTED_TYPES.includes(file.type));
						if (images.length > 0) void addImages(images);
						if (others.length > 0) addTextFiles(others);
						e.target.value = "";
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
