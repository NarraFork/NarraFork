import { notifications } from "@mantine/notifications";
import type { ComposerAsset } from "@shared/composer-document";
import { mediaModality } from "@shared/media-attachments";
import type React from "react";
import { type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { composerAssetsFromFiles } from "../composer/composer-document-adapter";
import {
	clearDraftImageAttachments,
	getComposerAssetId,
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
	/** Stable manifest for legacy array consumers adopting inline resource bindings. */
	composerAssets: ComposerAsset[];
	/** Whether the current known user's attachment draft is still being restored. */
	attachmentsHydrating: boolean;
	/** Whether the current owner's last attachment restore failed. */
	attachmentsRestoreFailed: boolean;
	/** Retry a failed restore without discarding this owner's local attachments. */
	retryAttachmentRestore: () => void;
	/** This owner's loaded files, including removed assets retained only for undo. */
	restoredAttachmentResources: ReadonlyMap<string, File>;
	attachedImages: File[];
	attachedTextFiles: File[];
	attachedMedia: File[];
	attachedMediaRef: React.RefObject<File[]>;
	updateAttachedMedia: (next: SetStateAction<File[]>) => void;
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
	/** Declare document-owned assets and remove unreferenced local blobs, including late hydrates. */
	reconcileDocumentAssets: (ids: readonly string[]) => void;
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
	const documentAssetsRef = useRef({
		narratorId,
		currentUserId,
		allowedIds: null as Set<string> | null,
		hydrated: false,
		readFailed: false,
		restoreGeneration: 0,
		hiddenForSend: false,
		restoredResources: new Map<string, File>(),
		restoredKinds: new Map<string, ComposerAsset["kind"]>(),
	});
	// Completion (including a failed load) must notify consumers, even when no
	// files changed. Owner identity is reset synchronously, not by this state.
	const [, setHydrationRevision] = useState(0);
	const [retryRequest, setRetryRequest] = useState<{
		scope: typeof documentAssetsRef.current;
		generation: number;
	} | null>(null);
	// Reset ownership during render, before a child can declare the new document
	// and before an old IndexedDB promise can apply to the new owner.
	if (
		documentAssetsRef.current.narratorId !== narratorId ||
		documentAssetsRef.current.currentUserId !== currentUserId
	) {
		documentAssetsRef.current = {
			narratorId,
			currentUserId,
			allowedIds: null,
			hydrated: false,
			readFailed: false,
			restoreGeneration: 0,
			hiddenForSend: false,
			restoredResources: new Map<string, File>(),
			restoredKinds: new Map<string, ComposerAsset["kind"]>(),
		};
	}

	const [imageState, setAttachedImages] = useState({
		scope: documentAssetsRef.current,
		files: [] as File[],
	});
	// Effect cleanup is too late for an owner switch: a child can cache these
	// files during that first render. Tag both state arrays, and derive the live
	// mirrors only from the current scope before exposing them to any consumer.
	const attachedImages = imageState.scope === documentAssetsRef.current ? imageState.files : [];
	const attachedImagesRef = useRef<File[]>(attachedImages);
	attachedImagesRef.current = attachedImages;
	const attachmentDraftHydratedKeyRef = useRef<string | null>(null);
	const attachmentDraftSaveSeqRef = useRef(0);
	const attachmentDraftLocalVersionRef = useRef(0);
	const sendHiddenVersionRef = useRef<{
		scope: typeof documentAssetsRef.current;
		version: number;
	} | null>(null);
	const [textFileState, setAttachedTextFiles] = useState({
		scope: documentAssetsRef.current,
		files: [] as File[],
	});
	const attachedTextFiles =
		textFileState.scope === documentAssetsRef.current ? textFileState.files : [];
	// Mirrors `attachedTextFiles` for the same reason `attachedImagesRef` exists:
	// callers registered once (the user-chat forward bridge) must read the CURRENT
	// attachments without re-registering on every change.
	const attachedTextFilesRef = useRef<File[]>(attachedTextFiles);
	attachedTextFilesRef.current = attachedTextFiles;
	const [mediaState, setAttachedMedia] = useState({
		scope: documentAssetsRef.current,
		files: [] as File[],
	});
	const attachedMedia = mediaState.scope === documentAssetsRef.current ? mediaState.files : [];
	const attachedMediaRef = useRef<File[]>(attachedMedia);
	attachedMediaRef.current = attachedMedia;
	const [isDragging, setIsDragging] = useState(false);
	const dragCounterRef = useRef(0);
	const warnDraftAttachmentsPersistenceFailure = useCallback((action: string, err: unknown) => {
		if (import.meta.env.DEV) {
			console.warn(`[NarratorPanel] Failed to ${action} draft attachments:`, err);
		}
	}, []);
	const updateRestoredResources = useCallback((files: File[], kind: ComposerAsset["kind"]) => {
		const scope = documentAssetsRef.current;
		let resources = scope.restoredResources;
		for (const file of files) {
			const id = getComposerAssetId(file);
			if (
				resources.has(id) &&
				(resources.get(id) !== file || scope.restoredKinds.get(id) !== kind)
			) {
				if (resources === scope.restoredResources) resources = new Map(resources);
				resources.set(id, file);
				scope.restoredKinds.set(id, kind);
			}
		}
		scope.restoredResources = resources;
	}, []);
	const updateAttachedImages = useCallback(
		(next: SetStateAction<File[]>) => {
			attachmentDraftLocalVersionRef.current++;
			documentAssetsRef.current.hiddenForSend = false;
			const resolved = typeof next === "function" ? next(attachedImagesRef.current) : next;
			for (const file of resolved) {
				const id = getComposerAssetId(file);
				// New local uploads are allowed before the document adopts their ids.
				documentAssetsRef.current.allowedIds?.add(id);
			}
			updateRestoredResources(resolved, "image");
			attachedImagesRef.current = resolved;
			setAttachedImages({ scope: documentAssetsRef.current, files: resolved });
		},
		[updateRestoredResources],
	);
	/**
	 * Text-file counterpart of `updateAttachedImages`.
	 *
	 * Every mutation of `attachedTextFiles` must go through this rather than the
	 * raw setter: it is what bumps the shared local-version counter, without which
	 * an in-flight hydrate would overwrite a file the user just attached.
	 */
	const updateAttachedTextFiles = useCallback(
		(next: SetStateAction<File[]>) => {
			attachmentDraftLocalVersionRef.current++;
			documentAssetsRef.current.hiddenForSend = false;
			const resolved = typeof next === "function" ? next(attachedTextFilesRef.current) : next;
			for (const file of resolved) {
				const id = getComposerAssetId(file);
				documentAssetsRef.current.allowedIds?.add(id);
			}
			updateRestoredResources(resolved, "textFile");
			attachedTextFilesRef.current = resolved;
			setAttachedTextFiles({ scope: documentAssetsRef.current, files: resolved });
		},
		[updateRestoredResources],
	);
	const updateAttachedMedia = useCallback(
		(next: SetStateAction<File[]>) => {
			attachmentDraftLocalVersionRef.current++;
			documentAssetsRef.current.hiddenForSend = false;
			const resolved = typeof next === "function" ? next(attachedMediaRef.current) : next;
			for (const file of resolved) {
				documentAssetsRef.current.allowedIds?.add(getComposerAssetId(file));
				updateRestoredResources([file], mediaModality(file.type) ?? "audio");
			}
			attachedMediaRef.current = resolved;
			setAttachedMedia({ scope: documentAssetsRef.current, files: resolved });
		},
		[updateRestoredResources],
	);
	const hasUnrestoredDocumentAssets = useCallback(() => {
		const scope = documentAssetsRef.current;
		if (!scope.readFailed) return false;
		// Without a membership declaration even an empty local cache cannot prove
		// that the unreadable record was empty. Only a new read or explicit clear
		// (which declares an empty set) may authorize replacement.
		if (!scope.allowedIds) return true;
		// A failed read says nothing about the stored blobs. Do not replace the
		// record until every still-referenced asset has a local file, or the user
		// explicitly removes the missing IDs from the document.
		const available = new Set([
			...attachedImagesRef.current.map(getComposerAssetId),
			...attachedTextFilesRef.current.map(getComposerAssetId),
			...attachedMediaRef.current.map(getComposerAssetId),
		]);
		for (const id of scope.allowedIds) {
			if (!available.has(id)) return true;
		}
		return false;
	}, []);
	const persistCurrentDraftAttachments = useCallback(
		(targetUserId: string, targetNarratorId: string) => {
			if (hasUnrestoredDocumentAssets()) return;
			const seq = ++attachmentDraftSaveSeqRef.current;
			void saveDraftImageAttachments(
				targetUserId,
				targetNarratorId,
				attachedImagesRef.current,
				attachedTextFilesRef.current,
				attachedMediaRef.current,
			).catch((err) => {
				if (seq === attachmentDraftSaveSeqRef.current) {
					warnDraftAttachmentsPersistenceFailure("save", err);
				}
			});
		},
		[hasUnrestoredDocumentAssets, warnDraftAttachmentsPersistenceFailure],
	);
	const reconcileDocumentAssets = useCallback(
		(ids: readonly string[]) => {
			const allowed = new Set(ids);
			const scope = documentAssetsRef.current;
			const previous = scope.allowedIds;
			scope.allowedIds = allowed;
			// This is a document ownership declaration, NOT a local edit. Hydration
			// reads the latest membership, even for assets not present in the cache yet.
			const images = attachedImagesRef.current.filter((file) =>
				allowed.has(getComposerAssetId(file)),
			);
			const textFiles = attachedTextFilesRef.current.filter((file) =>
				allowed.has(getComposerAssetId(file)),
			);
			const media = attachedMediaRef.current.filter((file) =>
				allowed.has(getComposerAssetId(file)),
			);
			if (scope.hydrated && !scope.hiddenForSend) {
				const active = new Set([...images, ...textFiles, ...media].map(getComposerAssetId));
				for (const id of allowed) {
					const file = scope.restoredResources.get(id);
					if (!file || active.has(id)) continue;
					if (scope.restoredKinds.get(id) === "image") images.push(file);
					else if (scope.restoredKinds.get(id) === "textFile") textFiles.push(file);
					else media.push(file);
					active.add(id);
				}
			}
			if (
				images.length !== attachedImagesRef.current.length ||
				images.some((file, index) => file !== attachedImagesRef.current[index])
			) {
				attachedImagesRef.current = images;
				setAttachedImages({ scope: documentAssetsRef.current, files: images });
			}
			if (
				textFiles.length !== attachedTextFilesRef.current.length ||
				textFiles.some((file, index) => file !== attachedTextFilesRef.current[index])
			) {
				attachedTextFilesRef.current = textFiles;
				setAttachedTextFiles({ scope: documentAssetsRef.current, files: textFiles });
			}
			if (
				media.length !== attachedMediaRef.current.length ||
				media.some((file, index) => file !== attachedMediaRef.current[index])
			) {
				attachedMediaRef.current = media;
				setAttachedMedia({ scope: documentAssetsRef.current, files: media });
			}
			if (
				scope.readFailed &&
				scope.hydrated &&
				!scope.hiddenForSend &&
				!sendingRef.current &&
				scope.currentUserId &&
				(!previous || previous.size !== allowed.size || ids.some((id) => !previous.has(id)))
			) {
				// Removing an unrestored ID may not change either file array. Attempt
				// the now-safe save here; the shared completeness guard still applies.
				persistCurrentDraftAttachments(scope.currentUserId, scope.narratorId);
			}
		},
		[persistCurrentDraftAttachments, sendingRef],
	);
	/**
	 * Clear the on-screen attachments for an in-flight send, WITHOUT touching the
	 * stored draft — a failed send restores them, and the record has to still be
	 * there for that to mean anything.
	 */
	const hideAttachedFilesForSend = useCallback(() => {
		attachmentDraftLocalVersionRef.current++;
		sendHiddenVersionRef.current = {
			scope: documentAssetsRef.current,
			version: attachmentDraftLocalVersionRef.current,
		};
		documentAssetsRef.current.allowedIds = new Set();
		documentAssetsRef.current.hiddenForSend = true;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		attachedMediaRef.current = [];
		setAttachedImages({ scope: documentAssetsRef.current, files: [] });
		setAttachedTextFiles({ scope: documentAssetsRef.current, files: [] });
		setAttachedMedia({ scope: documentAssetsRef.current, files: [] });
	}, []);
	const clearAttachedFilesAndDraft = useCallback(() => {
		const hidden = sendHiddenVersionRef.current;
		sendHiddenVersionRef.current = null;
		if (
			hidden?.scope === documentAssetsRef.current &&
			hidden.version !== attachmentDraftLocalVersionRef.current
		) {
			if (currentUserId) persistCurrentDraftAttachments(currentUserId, narratorId);
			return;
		}
		attachmentDraftLocalVersionRef.current++;
		const scope = documentAssetsRef.current;
		scope.allowedIds = new Set();
		scope.hiddenForSend = false;
		scope.readFailed = false;
		scope.hydrated = true;
		scope.restoreGeneration++;
		attachmentDraftHydratedKeyRef.current = currentUserId
			? getDraftImageAttachmentKey(currentUserId, narratorId)
			: null;
		attachedImagesRef.current = [];
		attachedTextFilesRef.current = [];
		attachedMediaRef.current = [];
		setAttachedImages({ scope: documentAssetsRef.current, files: [] });
		setAttachedTextFiles({ scope: documentAssetsRef.current, files: [] });
		setAttachedMedia({ scope: documentAssetsRef.current, files: [] });
		if (!currentUserId) return;
		const seq = ++attachmentDraftSaveSeqRef.current;
		void clearDraftImageAttachments(currentUserId, narratorId).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("clear", err);
			}
		});
	}, [
		currentUserId,
		narratorId,
		persistCurrentDraftAttachments,
		warnDraftAttachmentsPersistenceFailure,
	]);
	const retryAttachmentRestore = useCallback(() => {
		const scope = documentAssetsRef.current;
		if (
			!scope.currentUserId ||
			!scope.readFailed ||
			!scope.hydrated ||
			scope.hiddenForSend ||
			sendingRef.current
		)
			return;
		// Publish the retry state in its first render, before the effect starts
		// reading. In particular, no pending partial autosave can run meanwhile.
		scope.hydrated = false;
		scope.readFailed = false;
		attachmentDraftHydratedKeyRef.current = null;
		setRetryRequest({ scope, generation: ++scope.restoreGeneration });
	}, [sendingRef]);

	useEffect(() => {
		let cancelled = false;
		const scope = documentAssetsRef.current;
		const isRetry = retryRequest?.scope === scope;
		if (isRetry && retryRequest.generation !== scope.restoreGeneration) return;
		const generation = isRetry ? retryRequest.generation : ++scope.restoreGeneration;
		scope.hydrated = false;
		scope.readFailed = false;
		const localVersionAtRequest = attachmentDraftLocalVersionRef.current;
		const draftKey = currentUserId ? getDraftImageAttachmentKey(currentUserId, narratorId) : null;
		attachmentDraftHydratedKeyRef.current = null;
		if (!isRetry) {
			attachedImagesRef.current = [];
			attachedTextFilesRef.current = [];
			attachedMediaRef.current = [];
			setAttachedImages({ scope: documentAssetsRef.current, files: [] });
			setAttachedTextFiles({ scope: documentAssetsRef.current, files: [] });
			setAttachedMedia({ scope: documentAssetsRef.current, files: [] });
		}
		if (!currentUserId || !draftKey) return;

		const persistLocalChanges = () => {
			if (
				!scope.hiddenForSend &&
				!sendingRef.current &&
				attachmentDraftLocalVersionRef.current !== localVersionAtRequest
			) {
				persistCurrentDraftAttachments(currentUserId, narratorId);
			}
		};
		const finishHydrating = () => {
			scope.hydrated = true;
			attachmentDraftHydratedKeyRef.current = draftKey;
			setHydrationRevision((revision) => revision + 1);
		};

		void loadDraftImageAttachments(currentUserId, narratorId)
			.then((loaded) => {
				if (
					cancelled ||
					scope !== documentAssetsRef.current ||
					generation !== scope.restoreGeneration
				)
					return;
				// Keep this read's valid files available for undo even when membership
				// deletes them before hydration. The pool never drives active files or
				// persistence, and its lifetime is exactly this owner scope.
				scope.restoredResources = new Map(
					[...loaded.images, ...loaded.textFiles, ...(loaded.media ?? [])].map((file) => [
						getComposerAssetId(file),
						file,
					]),
				);
				scope.restoredKinds = new Map<string, ComposerAsset["kind"]>([
					...loaded.images.map((file) => [getComposerAssetId(file), "image"] as const),
					...loaded.textFiles.map((file) => [getComposerAssetId(file), "textFile"] as const),
					...(loaded.media ?? []).map(
						(file) => [getComposerAssetId(file), mediaModality(file.type) ?? "audio"] as const,
					),
				]);
				updateRestoredResources(attachedImagesRef.current, "image");
				updateRestoredResources(attachedTextFilesRef.current, "textFile");
				for (const file of attachedMediaRef.current)
					updateRestoredResources([file], mediaModality(file.type) ?? "audio");
				finishHydrating();
				// A send only hides the UI. Its stored recovery draft must survive,
				// including when the read completes after the files were hidden.
				if (scope.hiddenForSend) return;
				const allowed = scope.allowedIds;
				if (
					allowed ||
					isRetry ||
					attachmentDraftLocalVersionRef.current === localVersionAtRequest
				) {
					// A partial cache is not a replacement for the document's assets.
					// Merge by identity, never filename, and let local files win ties
					// across both attachment kinds. Initial legacy loads without a
					// manifest retain replacement semantics; retries merge retained edits.
					const assets = new Map<string, { file: File; kind: ComposerAsset["kind"] }>();
					const add = (files: File[], kind: ComposerAsset["kind"]) => {
						for (const file of files) {
							const id = getComposerAssetId(file);
							if (!allowed || allowed.has(id)) assets.set(id, { file, kind });
						}
					};
					add(loaded.images, "image");
					add(loaded.textFiles, "textFile");
					for (const file of loaded.media ?? []) add([file], mediaModality(file.type) ?? "audio");
					if (allowed || isRetry) {
						add(attachedImagesRef.current, "image");
						add(attachedTextFilesRef.current, "textFile");
						for (const file of attachedMediaRef.current)
							add([file], mediaModality(file.type) ?? "audio");
					}
					const images = [...assets.values()]
						.filter((asset) => asset.kind === "image")
						.map((asset) => asset.file);
					const textFiles = [...assets.values()]
						.filter((asset) => asset.kind === "textFile")
						.map((asset) => asset.file);
					const media = [...assets.values()]
						.filter((asset) => asset.kind === "audio" || asset.kind === "video")
						.map((asset) => asset.file);
					attachedMediaRef.current = media;
					setAttachedMedia({ scope: documentAssetsRef.current, files: media });
					attachedImagesRef.current = images;
					attachedTextFilesRef.current = textFiles;
					setAttachedImages({ scope: documentAssetsRef.current, files: images });
					setAttachedTextFiles({ scope: documentAssetsRef.current, files: textFiles });
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
				if (
					cancelled ||
					scope !== documentAssetsRef.current ||
					generation !== scope.restoreGeneration
				)
					return;
				warnDraftAttachmentsPersistenceFailure("load", err);
				scope.readFailed = true;
				finishHydrating();
				persistLocalChanges();
			});

		return () => {
			cancelled = true;
		};
	}, [
		currentUserId,
		narratorId,
		retryRequest,
		persistCurrentDraftAttachments,
		warnDraftAttachmentsPersistenceFailure,
		updateRestoredResources,
		sendingRef,
		t,
	]);

	useEffect(() => {
		if (
			!currentUserId ||
			!documentAssetsRef.current.hydrated ||
			documentAssetsRef.current.hiddenForSend ||
			hasUnrestoredDocumentAssets() ||
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
			attachedMedia,
		).catch((err) => {
			if (seq === attachmentDraftSaveSeqRef.current) {
				warnDraftAttachmentsPersistenceFailure("save", err);
			}
		});
	}, [
		attachedImages,
		attachedTextFiles,
		attachedMedia,
		currentUserId,
		hasUnrestoredDocumentAssets,
		narratorId,
		sendingRef,
		warnDraftAttachmentsPersistenceFailure,
	]);

	const composerAssets = composerAssetsFromFiles(attachedImages, attachedTextFiles, attachedMedia);
	return {
		composerAssets,
		attachmentsHydrating: Boolean(currentUserId && !documentAssetsRef.current.hydrated),
		attachmentsRestoreFailed: Boolean(currentUserId && documentAssetsRef.current.readFailed),
		retryAttachmentRestore,
		restoredAttachmentResources: documentAssetsRef.current.restoredResources,
		attachedImages,
		attachedTextFiles,
		attachedImagesRef,
		attachedTextFilesRef,
		attachedMedia,
		attachedMediaRef,
		updateAttachedMedia,
		isDragging,
		setIsDragging,
		dragCounterRef,
		updateAttachedImages,
		updateAttachedTextFiles,
		reconcileDocumentAssets,
		hideAttachedFilesForSend,
		clearAttachedFilesAndDraft,
	};
}
