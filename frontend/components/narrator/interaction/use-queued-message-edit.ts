import { notifications } from "@mantine/notifications";
import type { FileReference } from "@shared/file-reference";
import { isTextFile, MAX_TEXT_FILE_SIZE } from "@shared/text-file-types";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../../lib/api/types";
import { editFileReferenceInput, type FileReferenceInput } from "../composer/file-reference-input";
import {
	ACCEPTED_TYPES,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	resizeImageIfNeeded,
} from "../narrator-panel-types";
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

export interface UseQueuedMessageEditOptions {
	msg: BufferMessageSummary;
	isEditing: boolean;
	onSaveEdit: (
		msg: BufferMessageSummary,
		text: string,
		payload: QueuedEditPayload,
	) => Promise<boolean>;
	onCancelEdit: () => void;
	t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * The whole edit-draft concern of a queued-message row: six pieces of draft state
 * (text + kept/new images + kept/new text files + file references), the undo stack
 * and IME/beforeinput bookkeeping, attachment ingestion with room limits, seeding
 * on entering edit mode, and the textarea event handlers.
 *
 * Extracted from QueuedMessageRow so the component's edit branch is declarative.
 * The seeding effect deliberately depends only on `isEditing` (see the inline
 * note): a `buffer_set` broadcast swaps `msg`'s identity on every queue change,
 * and re-seeding would wipe an in-progress edit, so the latest summary is read
 * through a ref instead.
 */
export function useQueuedMessageEdit({
	msg,
	isEditing,
	onSaveEdit,
	onCancelEdit,
	t,
}: UseQueuedMessageEditOptions) {
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

	const onTextareaChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
		},
		[text, fileReferences],
	);

	const onTextareaKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
		},
		[captureEditRange, submit, onCancelEdit],
	);

	const onCompositionStart = useCallback(
		(e: React.CompositionEvent<HTMLTextAreaElement>) => {
			captureEditRange(e.currentTarget);
			composingRef.current = true;
			compositionUndoSavedRef.current = false;
		},
		[captureEditRange],
	);

	const onCompositionEnd = useCallback(() => {
		composingRef.current = false;
	}, []);

	return {
		// draft state
		text,
		keptImages,
		setKeptImages,
		newImages,
		setNewImages,
		keptTextFiles,
		setKeptTextFiles,
		newTextFiles,
		setNewTextFiles,
		fileReferences,
		setFileReferences,
		submitting,
		canSubmit,
		// refs
		textareaRef,
		fileInputRef,
		// attachment ingestion
		addImages,
		addTextFiles,
		// submit
		submit,
		// textarea handlers
		handlePaste,
		onTextareaChange,
		onTextareaKeyDown,
		onCompositionStart,
		onCompositionEnd,
	};
}
