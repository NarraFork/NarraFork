import { notifications } from "@mantine/notifications";
import type React from "react";
import { useCallback, useRef } from "react";
import {
	ACCEPTED_TYPES,
	isTextFile,
	MAX_IMAGE_LONG_EDGE,
	MAX_IMAGE_SIZE,
	MAX_TEXT_FILE_SIZE,
	resizeImageIfNeeded,
} from "../narrator-panel-types";

export interface UseComposerFileIngestOptions {
	updateAttachedImages: React.Dispatch<React.SetStateAction<File[]>>;
	updateAttachedTextFiles: React.Dispatch<React.SetStateAction<File[]>>;
	setIsDragging: (dragging: boolean) => void;
	/** Nested-drag counter so child enter/leave events don't flicker the overlay. */
	dragCounterRef: React.RefObject<number>;
	t: (key: string) => string;
}

/**
 * File ingestion for the composer: image/text-file validation + resize, the file
 * picker handler, the stable paste bridge, and the whole-panel drag-and-drop
 * dropzone handlers.
 *
 * Extracted from NarratorPanel. The dropzone handlers stay wired to the panel's
 * root element (the entire panel is the drop target, not just the composer), so
 * this hook is called by the panel; it does not sink into a child. It exists to
 * declutter the panel body, not to move the drop target.
 */
export function useComposerFileIngest(options: UseComposerFileIngestOptions) {
	const { updateAttachedImages, updateAttachedTextFiles, setIsDragging, dragCounterRef, t } =
		options;

	const addImages = async (files: File[]) => {
		const valid = files.filter((f) => {
			if (!ACCEPTED_TYPES.includes(f.type)) return false;
			if (f.size > MAX_IMAGE_SIZE) return false;
			return true;
		});
		if (valid.length === 0) return;
		const processed: File[] = [];
		for (const f of valid) {
			// GIF: skip resize (may be animated)
			if (f.type === "image/gif") {
				processed.push(f);
				continue;
			}
			try {
				const resized = await resizeImageIfNeeded(f, MAX_IMAGE_LONG_EDGE);
				processed.push(resized);
			} catch {
				processed.push(f); // fallback to original on error
			}
		}
		updateAttachedImages((prev) => [...prev, ...processed]);
	};

	const addTextFiles = (files: File[]) => {
		const valid = files.filter((f) => {
			if (!isTextFile(f.name)) {
				notifications.show({
					title: t("unsupportedFileType"),
					message: f.name,
					color: "yellow",
				});
				return false;
			}
			if (f.size > MAX_TEXT_FILE_SIZE) {
				notifications.show({
					title: t("textFileTooLarge"),
					message: `${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB)`,
					color: "yellow",
				});
				return false;
			}
			return true;
		});
		if (valid.length > 0) {
			updateAttachedTextFiles((prev) => [...prev, ...valid]);
		}
	};

	// File picker change: classify the selection into images / text files and
	// warn about anything unsupported. Co-located with addImages/addTextFiles.
	const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (e.target.files) {
			const files = Array.from(e.target.files);
			const imageFiles: File[] = [];
			const textFileList: File[] = [];
			const unsupported: string[] = [];
			for (const f of files) {
				if (ACCEPTED_TYPES.includes(f.type)) {
					imageFiles.push(f);
				} else if (isTextFile(f.name)) {
					textFileList.push(f);
				} else {
					unsupported.push(f.name);
				}
			}
			if (unsupported.length > 0) {
				notifications.show({
					title: t("unsupportedFileType"),
					message: unsupported.join(", "),
					color: "yellow",
				});
			}
			if (imageFiles.length > 0) addImages(imageFiles);
			if (textFileList.length > 0) addTextFiles(textFileList);
			e.target.value = "";
		}
	};

	// Stable paste bridge for <NarratorComposer> (it re-renders per keystroke, so
	// every callback prop must hold its identity).
	const addImagesRef = useRef(addImages);
	addImagesRef.current = addImages;
	const handleComposerPasteImages = useCallback((files: File[]) => addImagesRef.current(files), []);

	const isFileDragEvent = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

	const handleDragEnter = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current++;
		setIsDragging(true);
	};

	const handleDragLeave = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
		if (dragCounterRef.current === 0) {
			setIsDragging(false);
		}
	};

	const handleDragOver = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
	};

	const handleDrop = (e: React.DragEvent) => {
		if (!isFileDragEvent(e)) return;
		e.preventDefault();
		e.stopPropagation();
		dragCounterRef.current = 0;
		setIsDragging(false);
		const files = Array.from(e.dataTransfer.files);
		if (files.length === 0) return;
		const imageFiles: File[] = [];
		const textFileList: File[] = [];
		const unsupported: string[] = [];
		for (const f of files) {
			if (ACCEPTED_TYPES.includes(f.type)) {
				imageFiles.push(f);
			} else if (isTextFile(f.name)) {
				textFileList.push(f);
			} else {
				unsupported.push(f.name);
			}
		}
		if (unsupported.length > 0) {
			notifications.show({
				title: t("unsupportedFileType"),
				message: unsupported.join(", "),
				color: "yellow",
			});
		}
		if (imageFiles.length > 0) addImages(imageFiles);
		if (textFileList.length > 0) addTextFiles(textFileList);
	};

	return {
		addImages,
		addTextFiles,
		handleFileInputChange,
		handleComposerPasteImages,
		/** Spread onto the panel root element to make it a file drop target. */
		dropZoneProps: {
			onDragEnter: handleDragEnter,
			onDragLeave: handleDragLeave,
			onDragOver: handleDragOver,
			onDrop: handleDrop,
		},
	};
}
