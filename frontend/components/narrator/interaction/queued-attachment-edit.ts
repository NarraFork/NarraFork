/**
 * queued-attachment-edit.ts — the attachment bookkeeping behind editing a queued
 * message.
 *
 * Kept out of NarratorPanel so the rules that decide what the server is told —
 * which existing attachments survive, how much room is left, whether the edit may
 * be submitted at all — are testable without mounting the panel.
 *
 * Identity differs by attachment type, and that difference is load-bearing:
 * images are keyed by their globally-unique `imageId`, text files by their
 * position in the message. A taken-over subagent's queue holds the raw File
 * objects, where two attachments can share a filename, so a name is not an
 * identity there.
 */

import type { FileReference } from "@shared/file-reference";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
} from "@shared/text-file-types";
import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../../lib/api/types";
import { trimFileReferenceInput } from "../composer/file-reference-input";

/**
 * Attachments a queued message may carry, per type; mirrors the server limits.
 * Images and text files differ: a message may legitimately carry many
 * screenshots, while text files stay at the lower bound.
 */
export const MAX_QUEUED_IMAGES = MAX_EDIT_IMAGES_PER_MESSAGE;
export const MAX_QUEUED_TEXT_FILES = MAX_EDIT_TEXT_FILES_PER_MESSAGE;

export interface QueuedEditAttachmentState {
	text: string;
	keptImages: BufferedImageSummary[];
	newImages: File[];
	keptTextFiles: BufferedTextFileSummary[];
	newTextFiles: File[];
	fileReferences: FileReference[];
}

export interface QueuedEditPayload {
	keepImageIds: string[];
	keepTextFiles: { index: number; filename: string }[];
	newImages: File[];
	newTextFiles: File[];
	fileReferences: FileReference[];
}

/**
 * Seed the editor from a queue summary.
 *
 * A summary from an older server has no attachment arrays at all; treating that
 * as "no attachments" is safe because such a server also ignores keep lists and
 * therefore preserves whatever it holds.
 */
export function seedQueuedEditAttachments(msg: BufferMessageSummary): {
	keptImages: BufferedImageSummary[];
	keptTextFiles: BufferedTextFileSummary[];
	fileReferences: FileReference[];
} {
	return {
		keptImages: [...(msg.images ?? [])],
		keptTextFiles: [...(msg.textFiles ?? [])],
		fileReferences: structuredClone(msg.fileReferences ?? []),
	};
}

/** How many more images may still be added. */
export function remainingImageRoom(keptCount: number, newCount: number): number {
	return Math.max(0, MAX_QUEUED_IMAGES - keptCount - newCount);
}

/** How many more text files may still be added. */
export function remainingTextFileRoom(keptCount: number, newCount: number): number {
	return Math.max(0, MAX_QUEUED_TEXT_FILES - keptCount - newCount);
}

/**
 * An attachment carries a message on its own, so clearing the wording while
 * keeping an image is a legitimate edit — matching the composer's send gate and
 * the server's own emptiness check.
 */
export function canSubmitQueuedEdit(state: QueuedEditAttachmentState): boolean {
	if (state.text.trim().length > 0) return true;
	return (
		state.keptImages.length > 0 ||
		state.newImages.length > 0 ||
		state.keptTextFiles.length > 0 ||
		state.newTextFiles.length > 0 ||
		state.fileReferences.length > 0
	);
}

/**
 * Build the request payload.
 *
 * Keep lists are always sent (never omitted), because omission means "keep
 * everything" server-side: leaving them out after the user removed an attachment
 * would silently resurrect it.
 */
export function buildQueuedEditPayload(state: QueuedEditAttachmentState): QueuedEditPayload {
	return {
		keepImageIds: state.keptImages.map((image) => image.imageId),
		keepTextFiles: state.keptTextFiles.map((file) => ({
			index: file.index,
			filename: file.filename,
		})),
		newImages: [...state.newImages],
		newTextFiles: [...state.newTextFiles],
		fileReferences: structuredClone(trimFileReferenceInput(state).fileReferences),
	};
}

/** Whether this edit changes any attachment, i.e. whether it must send keep lists. */
export function queuedEditTouchesAttachments(
	original: BufferMessageSummary,
	state: QueuedEditAttachmentState,
): boolean {
	const originalImages = original.images ?? [];
	const originalTextFiles = original.textFiles ?? [];
	return (
		state.newImages.length > 0 ||
		state.newTextFiles.length > 0 ||
		state.keptImages.length !== originalImages.length ||
		state.keptTextFiles.length !== originalTextFiles.length ||
		JSON.stringify(state.fileReferences) !== JSON.stringify(original.fileReferences ?? [])
	);
}
