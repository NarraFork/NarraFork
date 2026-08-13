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

import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../lib/api/types";

/** Attachments (per type) a queued message may carry; mirrors the server limit. */
export const MAX_QUEUED_ATTACHMENTS = 10;

export interface QueuedEditAttachmentState {
	text: string;
	keptImages: BufferedImageSummary[];
	newImages: File[];
	keptTextFiles: BufferedTextFileSummary[];
	newTextFiles: File[];
}

export interface QueuedEditPayload {
	keepImageIds: string[];
	keepTextFiles: { index: number; filename: string }[];
	newImages: File[];
	newTextFiles: File[];
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
} {
	return {
		keptImages: [...(msg.images ?? [])],
		keptTextFiles: [...(msg.textFiles ?? [])],
	};
}

/** How many more attachments of one type may still be added. */
export function remainingAttachmentRoom(keptCount: number, newCount: number): number {
	return Math.max(0, MAX_QUEUED_ATTACHMENTS - keptCount - newCount);
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
		state.newTextFiles.length > 0
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
		state.keptTextFiles.length !== originalTextFiles.length
	);
}
