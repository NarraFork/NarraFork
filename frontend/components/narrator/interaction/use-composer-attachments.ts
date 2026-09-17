import { notifications } from "@mantine/notifications";
import type React from "react";
import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import {
	clearDraftImageAttachments,
	getDraftImageAttachmentKey,
	loadDraftImageAttachments,
	saveDraftImageAttachments,
} from "../composer/draft-image-attachments";

export interface UseComposerAttachmentsOptions {
	narratorId: string;
	/** Current user id (draft records are keyed per user+narrator); null when unknown. */
	currentUserId: string | null;
	/** Shared send-in-flight flag — the autosave effect skips while a send is running. */
	sendingRef: React.RefObject<boolean>;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UseComposerAttachmentsResult {
	attachedImages: File[];
	attachedTextFiles: File[];
	/** Live mirror of `attachedImages` for callbacks registered once (user-chat bridge). */
	attachedImagesRef: React.RefObject<File[]>;
	/** Live mirror of `attachedTextFiles`. */
	attachedTextFilesRef: React.RefObject<File[]>;
	isDragging: boolean;
	setIsDragging: React.Dispatch<React.SetStateAction<boolean>>;
	/** Drag-enter/leave depth counter so nested dragenter/leave don't flicker the overlay. */
	dragCounterRef: React.RefObject<number>;
	/** Mutate images through this (bumps the shared draft version counter). */
	updateAttachedImages: (next: SetStateAction<File[]>) => void;
	/** Text-file counterpart of `updateAttachedImages`. */
	updateAttachedTextFiles: (next: SetStateAction<File[]>) => void;
	/** Clear on-screen attachments for an in-flight send WITHOUT touching the stored draft. */
	hideAttachedFilesForSend: () => void;
	/** Clear attachments AND the persisted draft record. */
	clearAttachedFilesAndDraft: () => void;
}

/**
 * Pending composer attachments (images + text files) and their IndexedDB draft
 * persistence. Extracted verbatim from NarratorPanel.
 *
 * Both kinds share ONE set of bookkeeping refs (local-version / save-seq /
 * hydrated-key) because they are stored in a SINGLE record per (user, narrator);
 * two independent version counters would race on that one record. All mutations
 * must go through `updateAttachedImages` / `updateAttachedTextFiles` so the
 * shared version counter bumps — otherwise an in-flight hydrate could overwrite a
 * file the user just attached. The send flow (hide/clear/restore) and drag
 * handlers live in NarratorPanel and consume the exports here.
 */
export function useComposerAttachments(
	options: UseComposerAttachmentsOptions,
): UseComposerAttachmentsResult {
	const { narratorId, currentUserId, sendingRef, t } = options;

	const [attachedImages, setAttachedImages] = useState<File[]>([]);
	const attachedImagesRef = useRef<File[]>(attachedImages);
	attachedImagesRef.current = attachedImages;
	const attachmentDraftHydratedKeyRef = useRef<string | null>(null);
	const attachmentDraftSaveSeqRef = useRef(0);
	const attachmentDraftLocalVersionRef = useRef(0);
	const [attachedTextFiles, setAttachedTextFiles] = useState<File[]>([]);
	// Mirrors `attachedTextFiles` for the same reason `attachedImagesRef` exists:
	// callers registered once (the user-chat forward bridge) must read the CURRENT
	// attachments without re-registering on every change.
	const attachedTextFilesRef = useRef<File[]>(attachedTextFiles);
	attachedTextFilesRef.current = attachedTextFiles;
	const [isDragging, setIsDragging] = useState(false);
	const dragCounterRef = useRef(0);
	const warnDraftAttachmentsPersistenceFailure = useCallback((action: string, err: unknown) => {
		if (import.meta.env.DEV) {
			console.warn(`[NarratorPanel] Failed to ${action} draft attachments:`, err);
		}
	}, []);
	const updateAttachedImages = useCallback((next: SetStateAction<File[]>) => {
		attachmentDraftLocalVersionRef.current++;
		setAttachedImages((prev) => {
			const resolved = typeof next === "function" ? (next as (prev: File[]) => File[])(prev) : next;
			attachedImagesRef.current = resolved;
			return resolved;
		});
	}, []);
	/**
	 * Text-file counterpart of `updateAttachedImages`.
	 *
	 * Every mutation of `attachedTextFiles` must go through this rather than the
	 * raw setter: it is what bumps the shared local-version counter, without which
	 * an in-flight hydrate would overwrite a file the user just attached.
	 */
	const updateAttachedTextFiles = useCallback((next: SetStateAction<File[]>) => {
		attachmentDraftLocalVersionRef.current++;
		setAttachedTextFiles((prev) => {
			const resolved = typeof next === "function" ? (next as (prev: File[]) => File[])(prev) : next;
			attachedTextFilesRef.current = resolved;
			return resolved;
		});
	}, []);
	const persistCurrentDraftAttachments = useCallback(
		(targetUserId: string, targetNarratorId: string) => {
			const seq = ++attachmentDraftSaveSeqRef.current;
			void saveDraftImageAttachments(
				targetUserId,
				targetNarratorId,
				attachedImagesRef.current,
				attachedTextFilesRef.current,
			).catch((err) => {
				if (seq === attachmentDraftSaveSeqRef.current) {
					warnDraftAttachmentsPersistenceFailure("save", err);
				}
			});
		},
		[warnDraftAttachmentsPersistenceFailure],
	);
	/**
	 * Clear the on-screen attachments for an in-flight send, WITHOUT touching the
	 * stored draft — a failed send restores them, and the record has to still be
	 * there for that to mean anything.
	 */
	const hideAttachedFilesForSend = useCallback(() => {
		attachmentDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
	}, []);
	const clearAttachedFilesAndDraft = useCallback(() => {
		attachmentDraftLocalVersionRef.current++;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
		if (!currentUserId) return;
		const seq = ++attachmentDraftSaveSeqRef.current;
		void clearDraftImageAttachments(currentUserId, narratorId).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("clear", err);
			}
		});
	}, [currentUserId, narratorId, warnDraftAttachmentsPersistenceFailure]);

	useEffect(() => {
		let cancelled = false;
		const localVersionAtRequest = attachmentDraftLocalVersionRef.current;
		const draftKey = currentUserId ? getDraftImageAttachmentKey(currentUserId, narratorId) : null;
		attachmentDraftHydratedKeyRef.current = null;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		setAttachedImages([]);
		setAttachedTextFiles([]);
		if (!currentUserId || !draftKey) return;

		const persistLocalChanges = () => {
			if (attachmentDraftLocalVersionRef.current !== localVersionAtRequest) {
				persistCurrentDraftAttachments(currentUserId, narratorId);
			}
		};

		void loadDraftImageAttachments(currentUserId, narratorId)
			.then((loaded) => {
				if (cancelled) return;
				attachmentDraftHydratedKeyRef.current = draftKey;
				if (attachmentDraftLocalVersionRef.current === localVersionAtRequest) {
					attachedImagesRef.current = loaded.images;
					attachedTextFilesRef.current = loaded.textFiles;
					setAttachedImages(loaded.images);
					setAttachedTextFiles(loaded.textFiles);
					// An entry that was stored but cannot be rebuilt (blob evicted by the
					// browser, unreadable record) must be reported: silently restoring
					// two of three attachments looks like the user misremembered.
					if (loaded.droppedCount > 0) {
						notifications.show({
							color: "yellow",
							title: t("draftAttachmentsRestoreFailedTitle"),
							message: t("draftAttachmentsRestoreFailed", { count: loaded.droppedCount }),
						});
					}
				} else {
					persistLocalChanges();
				}
			})
			.catch((err) => {
				if (cancelled) return;
				warnDraftAttachmentsPersistenceFailure("load", err);
				attachmentDraftHydratedKeyRef.current = draftKey;
				persistLocalChanges();
			});

		return () => {
			cancelled = true;
		};
	}, [
		currentUserId,
		narratorId,
		persistCurrentDraftAttachments,
		warnDraftAttachmentsPersistenceFailure,
		t,
	]);

	useEffect(() => {
		if (
			!currentUserId ||
			sendingRef.current ||
			attachmentDraftHydratedKeyRef.current !==
				getDraftImageAttachmentKey(currentUserId, narratorId)
		)
			return;
		const seq = ++attachmentDraftSaveSeqRef.current;
		void saveDraftImageAttachments(
			currentUserId,
			narratorId,
			attachedImages,
			attachedTextFiles,
		).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("save", err);
			}
		});
	}, [
		attachedImages,
		attachedTextFiles,
		currentUserId,
		narratorId,
		sendingRef,
		warnDraftAttachmentsPersistenceFailure,
	]);

	return {
		attachedImages,
		attachedTextFiles,
		attachedImagesRef,
		attachedTextFilesRef,
		isDragging,
		setIsDragging,
		dragCounterRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		hideAttachedFilesForSend,
		clearAttachedFilesAndDraft,
	};
}
