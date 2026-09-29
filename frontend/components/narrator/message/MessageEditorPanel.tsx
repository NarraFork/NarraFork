/**
 * MessageEditorPanel.tsx — the inline message editor, shared by BOTH message
 * render paths.
 *
 * Extracted verbatim from MessageBubble's edit mode so the pretext vlist can host
 * the SAME editor instead of reimplementing it (which would immediately drift).
 * It owns the whole editing interaction:
 *   - user messages: textarea + kept/new image & text-file attachments, the
 *     revert confirmation modal (shared with rollback-to-block), and the
 *     edit-and-regenerate submit;
 *   - assistant messages: a plain textarea that persists the edited text without
 *     truncating later messages or regenerating.
 *
 * The panel is mounted ONLY while editing: its state is seeded from `blocks` on
 * mount, and the parent decides when to unmount (`onClose`). It registers itself
 * with EditingMessageCtx so NarratorPanel's bottom send button becomes the submit
 * button, exactly as before.
 *
 * Deliberately placed OUTSIDE vlist/ so both paths can import it (the isolation
 * guard forbids non-vlist files from statically importing vlist/, not the reverse
 * — same reasoning as TraceRowInteraction.tsx).
 */

import { useEditRegeneratePreview } from "@frontend/hooks/useNarrator";
import { usePromptOptimize } from "@frontend/hooks/usePromptOptimize";
import {
	ActionIcon,
	Button,
	CloseButton,
	Group,
	Paper,
	Stack,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import {
	isTextFile,
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
	MAX_TEXT_FILE_SIZE,
} from "@shared/text-file-types";
import { IconPaperclip } from "@tabler/icons-react";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RevertScope } from "../../../lib/api/narrators";
import { shouldClearEditDraft } from "../../../lib/api/narrators";
import { UserAvatar } from "../../UserAvatar";
import { ComposerFullscreenModal } from "../composer/ComposerFullscreenModal";
import {
	EditExistingImageThumb,
	EditNewImageThumb,
	EditTextFileChip,
} from "../composer/EditAttachmentChips";
import {
	editFileReferenceInput,
	type FileReferenceInput,
	fileReferenceToken,
	readFileReferences,
	trimFileReferenceInput,
} from "../composer/file-reference-input";
import {
	TextareaOptimizeControls,
	textareaOptimizeControlsWidth,
} from "../composer/TextareaOptimizeControls";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "../narrator-panel-types";
import { RevertScopeConfirmModal } from "../permission/RevertScopeConfirmModal";
import { EditingMessageCtx } from "./EditingMessageCtx";
import { editRevertNeedsConfirm } from "./message-edit-text";

/**
 * Maximum attachments an edit may carry, per type. Images allow far more than
 * text files (a message may legitimately carry many screenshots); both mirror
 * the server's own bounds so the composer never accepts what the API rejects.
 */
const MAX_EDIT_IMAGES = MAX_EDIT_IMAGES_PER_MESSAGE;
const MAX_EDIT_TEXT_FILES = MAX_EDIT_TEXT_FILES_PER_MESSAGE;

// The pure text helpers live in their own module so callers that only decide
// whether editing is possible need not import this component (and its graph).
export {
	collectTextBlocksPreview,
	MAX_ASSISTANT_MESSAGE_EDIT_CHARS,
	MAX_USER_MESSAGE_EDIT_CHARS,
	resolveEditorInitialText,
} from "./message-edit-text";

export interface MessageEditorPanelProps {
	/** Named `messageRole` (not `role`) so it is never mistaken for an ARIA role. */
	messageRole: "user" | "assistant";
	/** Owning panel narrator (attachment upload fallback). */
	narratorId?: string;
	messageId: string;
	/** `message.narratorId ?? narratorId` — resolves kept image blobs. */
	imageNarratorId?: string;
	/** The message's contentJson: seeds the kept attachments. */
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON blocks
	blocks: any[];
	creator?: {
		id: string;
		username: string;
		avatarColor?: string | null;
		avatarImageId?: string | null;
	} | null;
	/** Pre-resolved initial text (see resolveEditorInitialText). */
	initialText: string;
	/**
	 * Whether this is the newest user message.
	 *
	 * No longer decides whether the confirmation appears — that follows from what the
	 * server says the edit would destroy. Editing the last user message still reverts
	 * files, so skipping the prompt for it hid a destructive action.
	 */
	isLastUserMessage?: boolean;
	/**
	 * Narrator is bound to a chapter (git).
	 *
	 * Informational only: whether files can be reverted is answered by the preview,
	 * which reports an empty change set for a workspace without snapshots.
	 */
	hasChapter?: boolean;
	onEditAndRegenerate?: (
		messageId: string,
		newContent: string,
		revertOpts: { skipRevert: boolean; scope?: RevertScope },
		opts?: {
			keepImageIds: string[];
			newImages: File[];
			keepTextFilePaths: string[];
			newTextFiles: File[];
			fileReferences: FileReference[];
		},
	) => Promise<boolean>;
	onEditAssistantMessage?: (messageId: string, newContent: string) => void;
	/** Cancel, or a successful submit — the parent unmounts the panel. */
	onClose: () => void;
}

export function MessageEditorPanel({
	messageRole,
	narratorId,
	messageId,
	imageNarratorId,
	blocks,
	creator,
	initialText,
	// `isLastUserMessage` and `hasChapter` are deliberately not destructured: the
	// confirmation now follows from the server's preview, so neither influences this
	// component. They stay on the props because both are threaded down a long chain
	// (NarratorPanel → list → MessageBubble) and MessageBubble's memo compares them.
	onEditAndRegenerate,
	onEditAssistantMessage,
	onClose,
}: MessageEditorPanelProps) {
	const { t } = useTranslation("narrator");
	const isUser = messageRole === "user";

	const [editContent, setEditContent] = useState(initialText);
	const [showConfirmModal, setShowConfirmModal] = useState(false);
	// Prefetched while the user is still typing, so the submit handler already knows
	// whether anything would be destroyed. Works for subagents too: the endpoint keys
	// off the narrator id alone, and a subagent has its own record and worktree.
	const { data: revertPreview, isLoading: revertPreviewLoading } = useEditRegeneratePreview(
		narratorId ?? "",
		messageId,
		isUser && !!narratorId && !!messageId,
	);
	// Existing image blocks kept during editing (user can remove some) + newly
	// added image files. Only meaningful for user messages.
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON image blocks
	const [editKeptImages, setEditKeptImages] = useState<any[]>(() =>
		isUser
			? blocks.filter(
					(b: { type?: string; imageId?: unknown }) =>
						b.type === "image" && typeof b.imageId === "string",
				)
			: [],
	);
	const [editNewImages, setEditNewImages] = useState<File[]>([]);
	// Text file attachments (kept + new), similar pattern
	// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON text_file blocks
	const [editKeptTextFiles, setEditKeptTextFiles] = useState<any[]>(() =>
		isUser
			? blocks.filter(
					(b: { type?: string; filePath?: unknown }) =>
						b.type === "text_file" && typeof b.filePath === "string",
				)
			: [],
	);
	const [editNewTextFiles, setEditNewTextFiles] = useState<File[]>([]);
	// File references (in-text markers like #file(...)). Like the two initializers
	// above, the persisted metadata lives on the message's `file_reference` blocks;
	// `initialText` only carries the surrounding text, so seeding from it yields []
	// and silently drops every reference the message already had.
	const [editFileReferences, setEditFileReferences] = useState<FileReference[]>(() =>
		isUser
			? readFileReferences(
					blocks.filter((block) => block.type === "file_reference").map((block) => block.reference),
				)
			: [],
	);
	const [isSubmittingEdit, setIsSubmittingEdit] = useState(false);

	// Refs
	const isSubmittingEditRef = useRef(false);
	const editKeptCountRef = useRef(0);
	editKeptCountRef.current = editKeptImages.length;
	const editFileInputRef = useRef<HTMLInputElement | null>(null);
	const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Fullscreen Modal state
	const [fullscreenOpened, { open: openFullscreen, close: closeFullscreen }] = useDisclosure(false);

	// Prompt optimization hook
	const optimizeHook = usePromptOptimize({
		narratorId: narratorId ?? "",
		messageId,
		textareaRef: editTextareaRef,
		onOptimized: (text) => {
			// Fallback: if execCommand fails, update state directly
			setEditContent(text);
		},
	});
	// Undo stack for the edit textarea. React controls the textarea `value`, which
	// disables native Ctrl+Z, so we keep our own bounded stack of prior snapshots.
	const editUndoStackRef = useRef<FileReferenceInput[]>([]);
	const beforeEditRef = useRef<{ start: number; end: number; backward?: boolean } | undefined>(
		undefined,
	);
	const composingRef = useRef(false);
	const compositionUndoSavedRef = useRef(false);
	const captureEditRange = useCallback((textarea: HTMLTextAreaElement, inputType = "") => {
		beforeEditRef.current = {
			start: textarea.selectionStart,
			end: textarea.selectionEnd,
			backward: inputType.includes("Backward"),
		};
	}, []);
	// Native beforeinput also covers deletion/paste, which React's synthesized
	// onBeforeInput does not consistently emit. Read selection BEFORE DOM mutation.
	useEffect(() => {
		const textarea = editTextareaRef.current;
		if (!textarea) return;
		const beforeInput = (event: Event) =>
			captureEditRange(textarea, (event as InputEvent).inputType);
		textarea.addEventListener("beforeinput", beforeInput);
		return () => textarea.removeEventListener("beforeinput", beforeInput);
	}, [captureEditRange]);
	const editImageNarratorId = imageNarratorId ?? narratorId;
	const hasEditImages = editKeptImages.length > 0 || editNewImages.length > 0;
	const hasEditTextFiles = editKeptTextFiles.length > 0 || editNewTextFiles.length > 0;
	const canSubmitEdit =
		!!editContent.trim() || hasEditImages || hasEditTextFiles || editFileReferences.length > 0;

	const removeKeptImage = useCallback((imageId: string) => {
		setEditKeptImages((prev) => prev.filter((b) => b.imageId !== imageId));
	}, []);

	const removeNewImage = useCallback((index: number) => {
		setEditNewImages((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const removeKeptTextFile = useCallback((filePath: string) => {
		setEditKeptTextFiles((prev) => prev.filter((b) => b.filePath !== filePath));
	}, []);

	const removeNewTextFile = useCallback((index: number) => {
		setEditNewTextFiles((prev) => prev.filter((_, i) => i !== index));
	}, []);

	const handleAddEditTextFiles = useCallback(
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
			setEditNewTextFiles((prev) => {
				const room = Math.max(0, MAX_EDIT_TEXT_FILES - editKeptTextFiles.length - prev.length);
				if (valid.length > room) {
					notifications.show({
						color: "yellow",
						message: t("editTooManyFiles", { max: MAX_EDIT_TEXT_FILES }),
					});
				}
				return [...prev, ...valid.slice(0, room)];
			});
		},
		[editKeptTextFiles.length, t],
	);

	const handleAddEditImages = useCallback(
		async (files: File[]) => {
			const valid = files.filter(
				(f) => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_IMAGE_SIZE,
			);
			if (valid.length === 0) return;
			const processed: File[] = [];
			for (const f of valid) {
				// GIF: skip resize (may be animated)
				if (f.type === "image/gif") {
					processed.push(f);
					continue;
				}
				try {
					processed.push(await resizeImageIfNeeded(f, MAX_IMAGE_LONG_EDGE));
				} catch {
					processed.push(f);
				}
			}
			setEditNewImages((prev) => {
				// Read the kept count from the ref so a removal during the await above
				// is reflected here rather than using the stale closure value.
				const room = Math.max(0, MAX_EDIT_IMAGES - editKeptCountRef.current - prev.length);
				if (processed.length > room) {
					notifications.show({
						color: "yellow",
						message: t("editTooManyImages", { max: MAX_EDIT_IMAGES }),
					});
				}
				return [...prev, ...processed.slice(0, room)];
			});
		},
		[t],
	);

	// Paste files or images directly into the edit textarea (user messages only).
	// Image clipboard items → image attachments; other file items → text files
	// (validated by extension/size). Unknown items are ignored so normal text
	// paste still works.
	const handleEditPaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			captureEditRange(e.currentTarget);
			if (!isUser) return;
			const imageFiles: File[] = [];
			const textFiles: File[] = [];
			for (const item of e.clipboardData.items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) imageFiles.push(file);
				} else if (item.kind === "file") {
					const file = item.getAsFile();
					if (file && isTextFile(file.name) && file.size <= MAX_TEXT_FILE_SIZE) {
						textFiles.push(file);
					}
				}
			}
			if (imageFiles.length > 0 || textFiles.length > 0) {
				e.preventDefault();
				if (imageFiles.length > 0) void handleAddEditImages(imageFiles);
				if (textFiles.length > 0) handleAddEditTextFiles(textFiles);
			}
		},
		[isUser, handleAddEditImages, handleAddEditTextFiles, captureEditRange],
	);

	const buildEditImageOpts = useCallback(
		() => ({
			keepImageIds: editKeptImages
				.map((b) => b.imageId)
				.filter((id): id is string => typeof id === "string"),
			newImages: editNewImages,
			keepTextFilePaths: editKeptTextFiles
				.map((b) => b.filePath)
				.filter((p): p is string => typeof p === "string"),
			newTextFiles: editNewTextFiles,
			fileReferences: trimFileReferenceInput({
				text: editContent,
				fileReferences: editFileReferences,
			}).fileReferences,
		}),
		[
			editKeptImages,
			editNewImages,
			editKeptTextFiles,
			editNewTextFiles,
			editContent,
			editFileReferences,
		],
	);

	const submitUserEdit = useCallback(
		async (revertOpts: { skipRevert: boolean; scope?: RevertScope }) => {
			if (!messageId || !onEditAndRegenerate || !canSubmitEdit || isSubmittingEditRef.current) {
				return;
			}
			isSubmittingEditRef.current = true;
			setIsSubmittingEdit(true);
			try {
				const result: unknown = await onEditAndRegenerate(
					messageId,
					editContent.trim(),
					revertOpts,
					buildEditImageOpts(),
				);
				// Only an explicit successful response may discard the draft attachments
				// and undo history. Errors and ok:false leave the editor untouched.
				if (shouldClearEditDraft(result)) {
					setShowConfirmModal(false);
					onClose();
				}
			} finally {
				if (isSubmittingEditRef.current) {
					isSubmittingEditRef.current = false;
					setIsSubmittingEdit(false);
				}
			}
		},
		[messageId, onEditAndRegenerate, canSubmitEdit, editContent, buildEditImageOpts, onClose],
	);

	const handleConfirmClick = useCallback(() => {
		// Assistant messages: persist the edited text without truncating later messages or regenerating.
		if (!isUser) {
			if (!editContent.trim()) return;
			if (!messageId || !onEditAssistantMessage) return;
			onEditAssistantMessage(messageId, editContent.trim());
			onClose();
			return;
		}
		if (!canSubmitEdit || isSubmittingEditRef.current) return;
		// Ask whenever the edit would destroy something the editor does not show: a
		// file the rollback would change, or a later message it would delete. Only a
		// preview that reports neither submits straight through — and then reverting
		// is a no-op, so the choice would be meaningless anyway.
		if (!editRevertNeedsConfirm(revertPreview)) {
			void submitUserEdit({ skipRevert: false });
			return;
		}
		setShowConfirmModal(true);
	}, [
		editContent,
		canSubmitEdit,
		isUser,
		messageId,
		onEditAssistantMessage,
		submitUserEdit,
		onClose,
		revertPreview,
	]);

	const submitEdit = useCallback(
		(revertOpts: { skipRevert: boolean; scope?: RevertScope }) => {
			void submitUserEdit(revertOpts);
		},
		[submitUserEdit],
	);

	// Controlled onChange that also records the prior value on the undo stack so
	// Ctrl+Z can restore it (React-controlled textareas disable native undo).
	// Snapshots are pushed only when the value actually changed, capped at 100.
	const handleEditContentChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const next = e.currentTarget.value;
			const range = beforeEditRef.current;
			beforeEditRef.current = undefined;
			if (editContent === next) return;
			const previous = { text: editContent, fileReferences: editFileReferences };
			const stack = editUndoStackRef.current;
			if (!composingRef.current || !compositionUndoSavedRef.current) {
				stack.push(previous);
				if (stack.length > 100) stack.shift();
				if (composingRef.current) compositionUndoSavedRef.current = true;
			}
			// Collapsed deletion ranges exclude the deleted characters. Anchor the
			// actual removed length at the caret, including word/line deletion.
			if (range && range.start === range.end && next.length < editContent.length) {
				const removed = editContent.length - next.length;
				if (range.backward) range.start = Math.max(0, range.start - removed);
				else range.end += removed;
			}
			const edited = editFileReferenceInput(previous, next, range);
			setEditContent(edited.text);
			setEditFileReferences(edited.fileReferences);
		},
		[editContent, editFileReferences],
	);

	// Handle keyboard shortcuts in edit mode. Editing a message has no queue
	// semantics, so Enter and Ctrl/Cmd+Enter both submit; Shift+Enter inserts a
	// native newline.
	const handleEditKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			captureEditRange(e.currentTarget, e.key === "Backspace" ? "deleteBackward" : "");
			if (composingRef.current || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
				return;
			// Ctrl+Z / Cmd+Z (without shift) → pop the undo stack. Redo (shift+Z)
			// is left to native behaviour and ignored here.
			if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
				if (editUndoStackRef.current.length > 0) {
					e.preventDefault();
					const prev = editUndoStackRef.current.pop();
					if (prev !== undefined) {
						beforeEditRef.current = undefined;
						setEditContent(prev.text);
						setEditFileReferences(prev.fileReferences);
					}
				}
				return;
			}
			if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
			if (e.shiftKey) return; // native newline
			e.preventDefault();
			handleConfirmClick();
		},
		[handleConfirmClick, captureEditRange],
	);

	// Register/unregister editing state with the parent NarratorPanel so the
	// bottom send/retry button can trigger the edit submit.
	const editingCtx = useContext(EditingMessageCtx);
	const handleConfirmClickRef = useRef(handleConfirmClick);
	handleConfirmClickRef.current = handleConfirmClick;

	// Lifecycle: focus on mount, unregister only on unmount. Splitting this from
	// the state-sync effect below avoids the unregister→register cycle that would
	// flash `editingMessageState` to null on every canSubmit/isSubmitting change.
	useEffect(() => {
		const timer = setTimeout(() => {
			editTextareaRef.current?.focus();
		}, 50);
		return () => {
			clearTimeout(timer);
			editingCtx.unregister();
		};
	}, [editingCtx]);

	// Sync canSubmit/isSubmitting to the parent as an upsert (no unregister).
	useEffect(() => {
		editingCtx.register({
			submit: () => handleConfirmClickRef.current(),
			canSubmit: canSubmitEdit && !isSubmittingEdit,
			isSubmitting: isSubmittingEdit,
		});
	}, [canSubmitEdit, isSubmittingEdit, editingCtx]);

	// Assistant edit mode UI: save edited text without deleting later messages or regenerating.
	if (!isUser) {
		return (
			<Paper p="sm" radius="md" withBorder>
				<Stack gap="xs">
					<Text size="xs" fw={600} c="dimmed">
						{t("editAssistantTitle")}
					</Text>
					<Textarea
						ref={editTextareaRef}
						value={editContent}
						onCompositionStart={(e) => {
							captureEditRange(e.currentTarget);
							composingRef.current = true;
							compositionUndoSavedRef.current = false;
						}}
						onCompositionEnd={() => {
							composingRef.current = false;
						}}
						onChange={handleEditContentChange}
						onKeyDown={handleEditKeyDown}
						autosize
						minRows={3}
						maxRows={16}
						rightSection={
							<TextareaOptimizeControls
								disabled={!editContent.trim() || optimizeHook.loading}
								loading={optimizeHook.loading}
								withContext={optimizeHook.withContext}
								onToggleContext={optimizeHook.toggleContext}
								onOptimize={optimizeHook.handleOptimize}
								onExpand={openFullscreen}
								contextMessageCount={optimizeHook.contextMessageCount}
								onContextMessageCountChange={optimizeHook.setContextMessageCount}
							/>
						}
						// Reserved width, not "auto": see textareaOptimizeControlsWidth.
						rightSectionWidth={textareaOptimizeControlsWidth(true)}
					/>
					<Text size="xs" c="dimmed">
						{t("editAssistantHint")}
					</Text>
					<Group gap="xs" justify="flex-end">
						<Button size="xs" variant="subtle" onClick={onClose}>
							{t("editCancel")}
						</Button>
						<Button size="xs" onClick={handleConfirmClick} disabled={!editContent.trim()}>
							{t("editAssistantSubmit")}
						</Button>
					</Group>
				</Stack>
			</Paper>
		);
	}

	return (
		<>
			<Paper p="sm" radius="md" style={{ backgroundColor: "var(--mantine-color-indigo-light)" }}>
				<Stack gap="xs">
					<Group gap={6}>
						{creator && (
							<UserAvatar
								username={creator.username}
								avatarColor={creator.avatarColor}
								avatarImageId={creator.avatarImageId}
								userId={creator.id}
								size={20}
								showTooltip={false}
							/>
						)}
						<Text size="xs" fw={600} c="indigo">
							{creator?.username ?? t("you")}
						</Text>
					</Group>
					<Textarea
						ref={editTextareaRef}
						value={editContent}
						disabled={isSubmittingEdit}
						onCompositionStart={(e) => {
							captureEditRange(e.currentTarget);
							composingRef.current = true;
							compositionUndoSavedRef.current = false;
						}}
						onCompositionEnd={() => {
							composingRef.current = false;
						}}
						onChange={handleEditContentChange}
						onKeyDown={handleEditKeyDown}
						onPaste={handleEditPaste}
						autosize
						minRows={2}
						maxRows={10}
						rightSection={
							<TextareaOptimizeControls
								disabled={!editContent.trim() || optimizeHook.loading || isSubmittingEdit}
								loading={optimizeHook.loading}
								withContext={optimizeHook.withContext}
								onToggleContext={optimizeHook.toggleContext}
								onOptimize={optimizeHook.handleOptimize}
								onExpand={openFullscreen}
								contextMessageCount={optimizeHook.contextMessageCount}
								onContextMessageCountChange={optimizeHook.setContextMessageCount}
							/>
						}
						// Reserved width, not "auto": see textareaOptimizeControlsWidth.
						rightSectionWidth={textareaOptimizeControlsWidth(true)}
					/>
					{hasEditImages && (
						<Group gap="xs">
							{editKeptImages.map((imgBlock) => (
								<EditExistingImageThumb
									key={`kept-${imgBlock.imageId}`}
									block={imgBlock}
									imageNarratorId={editImageNarratorId}
									onRemove={() => removeKeptImage(imgBlock.imageId)}
									disabled={isSubmittingEdit}
								/>
							))}
							{editNewImages.map((file, i) => (
								<EditNewImageThumb
									// biome-ignore lint/suspicious/noArrayIndexKey: new images have no stable id
									key={`new-${i}-${file.name}-${file.size}`}
									file={file}
									onRemove={() => removeNewImage(i)}
									disabled={isSubmittingEdit}
								/>
							))}
						</Group>
					)}
					{hasEditTextFiles && (
						<Group gap="xs" wrap="wrap">
							{editKeptTextFiles.map((fileBlock) => (
								<EditTextFileChip
									key={`kept-file-${fileBlock.filePath}`}
									filename={fileBlock.filename}
									size={fileBlock.size}
									onRemove={() => removeKeptTextFile(fileBlock.filePath)}
									disabled={isSubmittingEdit}
								/>
							))}
							{editNewTextFiles.map((file, i) => (
								<EditTextFileChip
									// biome-ignore lint/suspicious/noArrayIndexKey: new files have no stable id
									key={`new-file-${i}-${file.name}-${file.size}`}
									filename={file.name}
									size={file.size}
									onRemove={() => removeNewTextFile(i)}
									disabled={isSubmittingEdit}
								/>
							))}
						</Group>
					)}
					{editFileReferences.length > 0 && (
						<Group gap="xs" wrap="wrap">
							{editFileReferences.map((reference) => (
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
										disabled={isSubmittingEdit}
										aria-label={`${t("removeFile")}: ${reference.label}`}
										onClick={() =>
											setEditFileReferences((previous) =>
												previous.filter((item) => item.id !== reference.id),
											)
										}
									/>
								</Group>
							))}
						</Group>
					)}
					<input
						ref={editFileInputRef}
						type="file"
						multiple
						disabled={isSubmittingEdit}
						style={{ display: "none" }}
						onChange={(e) => {
							const files = Array.from(e.target.files ?? []);
							// Route images to the image flow and everything else to the
							// text-file flow, mirroring the main composer's attach button.
							const images = files.filter((file) => ACCEPTED_TYPES.includes(file.type));
							const others = files.filter((file) => !ACCEPTED_TYPES.includes(file.type));
							if (images.length > 0) void handleAddEditImages(images);
							if (others.length > 0) handleAddEditTextFiles(others);
							e.target.value = "";
						}}
					/>
					<Group gap="xs" justify="space-between">
						<Tooltip label={t("attachFile")}>
							<ActionIcon
								variant="subtle"
								color="gray"
								disabled={isSubmittingEdit}
								onClick={() => editFileInputRef.current?.click()}
								aria-label={t("attachFile")}
							>
								<IconPaperclip size={18} />
							</ActionIcon>
						</Tooltip>
						<Group gap="xs">
							<Button size="xs" variant="subtle" onClick={onClose} disabled={isSubmittingEdit}>
								{t("editCancel")}
							</Button>
							<Button
								size="xs"
								onClick={handleConfirmClick}
								disabled={!canSubmitEdit || isSubmittingEdit}
								loading={isSubmittingEdit}
							>
								{t("editSubmit")}
							</Button>
						</Group>
					</Group>
				</Stack>
			</Paper>
			{/* The same dialog rollback-to-block uses: the scope choice, the exact files,
			    and a history-only exit. Editing used to offer a "keep code changes"
			    button the server ignored, so this is what makes the choice real. */}
			<RevertScopeConfirmModal
				opened={showConfirmModal}
				title={t("editRevertConfirmTitle")}
				description={
					(revertPreview?.deletedMessageCount ?? 0) > 0
						? t("editRevertConfirmDesc", { messageCount: revertPreview?.deletedMessageCount ?? 0 })
						: t("editRevertConfirmDescNoMessages")
				}
				data={revertPreview}
				isLoading={revertPreviewLoading}
				submitting={isSubmittingEdit}
				confirmWithRevertLabel={t("editRevertConfirmWithRevert")}
				confirmNoFilesLabel={t("editRevertConfirmNoFiles")}
				messagesOnlyLabel={t("editRevertConfirmMessagesOnly")}
				onConfirm={submitEdit}
				onCancel={() => {
					if (!isSubmittingEdit) setShowConfirmModal(false);
				}}
			/>
			<ComposerFullscreenModal
				opened={fullscreenOpened}
				onClose={closeFullscreen}
				initialText={editContent}
				onSubmit={(text) => {
					setEditContent(text);
					closeFullscreen();
					requestAnimationFrame(() => editTextareaRef.current?.focus());
				}}
				optimizeHook={optimizeHook}
				narratorId={narratorId}
				messageId={messageId}
			/>
		</>
	);
}
