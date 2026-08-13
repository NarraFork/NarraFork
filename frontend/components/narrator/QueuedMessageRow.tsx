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
 * Attachment previews are shown in BOTH modes on purpose. A count alone ("2
 * images") made it impossible to tell two pending messages apart, or to notice
 * that the wrong screenshot had been attached, until the message had already run.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	ActionIcon,
	Badge,
	Box,
	CloseButton,
	Group,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { isTextFile, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import {
	IconBolt,
	IconCheck,
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
} from "../../lib/api/types";
import { UserAvatar } from "../UserAvatar";
import { EditNewImageThumb, EditTextFileChip, QueuedImageThumb } from "./EditAttachmentChips";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "./narrator-panel-types";
import {
	buildQueuedEditPayload,
	canSubmitQueuedEdit,
	type QueuedEditPayload,
	remainingAttachmentRoom,
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
	cancelBufferLabel: string;
	editLabel: string;
	priorityLabel: string;
	priorityNextRequestLabel: string;
}

/** Read-only attachment strip for the collapsed/idle row. */
function QueuedAttachmentPreview({
	images,
	textFiles,
}: {
	images: BufferedImageSummary[];
	textFiles: BufferedTextFileSummary[];
}) {
	const { t } = useTranslation("narrator");
	if (images.length === 0 && textFiles.length === 0) return null;
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
	cancelBufferLabel,
	editLabel,
	priorityLabel,
	priorityNextRequestLabel,
}: QueuedMessageRowProps) {
	const { t } = useTranslation("narrator");
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: msg.id,
	});
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.5 : 1,
	};
	const priorityText = index === 0 ? priorityNextRequestLabel : priorityLabel;

	const [text, setText] = useState(msg.text);
	const [keptImages, setKeptImages] = useState<BufferedImageSummary[]>([]);
	const [newImages, setNewImages] = useState<File[]>([]);
	const [keptTextFiles, setKeptTextFiles] = useState<BufferedTextFileSummary[]>([]);
	const [newTextFiles, setNewTextFiles] = useState<File[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const submittingRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
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
		const current = msgRef.current;
		const seeded = seedQueuedEditAttachments(current);
		setText(current.text);
		setKeptImages(seeded.keptImages);
		setKeptTextFiles(seeded.keptTextFiles);
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
				const room = remainingAttachmentRoom(keptImageCountRef.current, prev.length);
				if (processed.length > room) {
					notifications.show({ color: "yellow", message: t("editTooManyImages") });
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
				const room = remainingAttachmentRoom(keptTextFiles.length, prev.length);
				if (valid.length > room) {
					notifications.show({ color: "yellow", message: t("editTooManyFiles") });
				}
				return [...prev, ...valid.slice(0, room)];
			});
		},
		[keptTextFiles.length, t],
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
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
		[addImages, addTextFiles],
	);

	const editState = useMemo(
		() => ({ text, keptImages, newImages, keptTextFiles, newTextFiles }),
		[text, keptImages, newImages, keptTextFiles, newTextFiles],
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
				bg="var(--mantine-color-blue-light)"
			>
				{dragHandle(<IconGripVertical size={14} color="var(--mantine-color-dimmed)" />)}
				{msg.creator ? (
					<UserAvatar
						username={msg.creator.username}
						avatarColor={msg.creator.avatarColor}
						avatarImageId={msg.creator.avatarImageId}
						userId={msg.creator.id}
						size={16}
						showTooltip={false}
					/>
				) : (
					<Box w={16} h={16} style={{ flexShrink: 0 }} />
				)}
				<QueuedAttachmentPreview images={msg.images ?? []} textFiles={msg.textFiles ?? []} />
				{msg.priority && (
					<Badge
						size="xs"
						color="orange"
						variant="light"
						leftSection={<IconBolt size={10} />}
						style={{ flexShrink: 0 }}
					>
						{priorityText}
					</Badge>
				)}
				<Text size="xs" c="blue" truncate style={{ flex: 1 }}>
					{msg.text}
				</Text>
				<ActionIcon
					size="xs"
					variant="subtle"
					color="blue"
					onClick={() => onStartEdit(msg)}
					title={editLabel}
				>
					<IconPencil size={12} />
				</ActionIcon>
				<CloseButton size="xs" onClick={() => onRemove(msg.id)} title={cancelBufferLabel} />
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
			bg="var(--mantine-color-blue-light)"
		>
			{dragHandle(
				<Text size="xs" c="dimmed" w={16} ta="center">
					{index + 1}
				</Text>,
			)}
			<Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
				<Textarea
					size="xs"
					value={text}
					disabled={submitting}
					onChange={(e) => setText(e.currentTarget.value)}
					onPaste={handlePaste}
					onKeyDown={(e) => {
						if (e.nativeEvent.isComposing) return;
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
