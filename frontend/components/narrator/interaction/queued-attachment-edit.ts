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

import {
	type ComposerAsset,
	type ComposerDocument,
	type ComposerInlineNode,
	parseComposerDocument,
} from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import { MAX_MEDIA_ATTACHMENTS, type MediaRef, mediaModality } from "@shared/media-attachments";
import {
	MAX_EDIT_IMAGES_PER_MESSAGE,
	MAX_EDIT_TEXT_FILES_PER_MESSAGE,
} from "@shared/text-file-types";
import type {
	BufferedImageSummary,
	BufferedTextFileSummary,
	BufferMessageSummary,
} from "../../../lib/api/types";
import {
	composerInputFromDocument,
	composerNodeId,
	importComposerInput,
} from "../composer/composer-document-adapter";
import { getComposerAssetId } from "../composer/draft-image-attachments";
import { trimFileReferenceInput } from "../composer/file-reference-input";

/**
 * Attachments a queued message may carry, per type; mirrors the server limits.
 * Images and text files differ: a message may legitimately carry many
 * screenshots, while text files stay at the lower bound.
 */
export const MAX_QUEUED_IMAGES = MAX_EDIT_IMAGES_PER_MESSAGE;
export const MAX_QUEUED_TEXT_FILES = MAX_EDIT_TEXT_FILES_PER_MESSAGE;
export const MAX_QUEUED_MEDIA = MAX_MEDIA_ATTACHMENTS;

export interface QueuedEditAttachmentState {
	text: string;
	keptImages: BufferedImageSummary[];
	keptMedia?: MediaRef[];
	newMedia?: File[];
	newImages: File[];
	keptTextFiles: BufferedTextFileSummary[];
	newTextFiles: File[];
	fileReferences: FileReference[];
}

export interface QueuedEditPayload {
	keepImageIds: string[];
	keepMediaIds?: string[];
	newMedia?: File[];
	keepTextFiles: { index: number; filename: string }[];
	newImages: File[];
	newTextFiles: File[];
	fileReferences: FileReference[];
	composerDocument?: ComposerDocument;
}

/** The binding is local editor state, never an arbitrary client-provided storage credential. */
export interface ExistingComposerAttachment {
	kind: ComposerAsset["kind"];
	name: string;
	size: number;
	mimeType: string;
	imageId?: string;
	mediaId?: string;
	filePath?: string;
	index?: number;
	uploadNarratorId?: string;
	previewUrl?: string;
}

export interface ComposerEditDetail {
	composerDocument?: ComposerDocument;
	text?: string;
	fileReferences?: FileReference[];
	images?: {
		imageId: string;
		filename?: string;
		mediaType?: string;
		sourceMimeType?: string;
		size?: number;
		uploadNarratorId?: string;
	}[];
	textFiles?: { filename: string; size: number; index?: number; filePath?: string }[];
	media?: MediaRef[];
}

/** The detail response supplies both layout and authorized resource identities from one snapshot. */
export function composerEditDetailAttachments(
	detail: ComposerEditDetail,
	narratorId?: string,
): ExistingComposerAttachment[] | undefined {
	if (!detail.images || !detail.textFiles) return undefined;
	return [
		...detail.images.map((image) => ({
			kind: "image" as const,
			imageId: image.imageId,
			name: image.filename ?? "image",
			size: image.size ?? 0,
			mimeType: image.sourceMimeType ?? image.mediaType ?? "image/png",
			uploadNarratorId: image.uploadNarratorId ?? narratorId,
		})),
		...detail.textFiles.map((file) => ({
			kind: "textFile" as const,
			index: file.index,
			filePath: file.filePath,
			name: file.filename,
			size: file.size,
			mimeType: "text/plain",
		})),
		...(detail.media ?? []).map((media) => {
			const kind = mediaModality(media.mediaType);
			if (!kind) throw new Error("Unsupported attachment modality");
			return {
				kind,
				mediaId: media.mediaId,
				name: media.filename,
				size: media.size,
				mimeType: media.mediaType,
				uploadNarratorId: media.uploadNarratorId ?? narratorId,
			};
		}),
	];
}

export interface ComposerEditSession {
	document: ComposerDocument;
	/** In original server order, followed by locally inserted resources. Retained for undo. */
	bindings: Map<string, ExistingComposerAttachment | File>;
}

export interface ComposerEditSnapshot {
	text: string;
	fileReferences: FileReference[];
	composerDocument: ComposerDocument;
	keepMediaIds: string[];
	newMedia: File[];
	keepImageIds: string[];
	keepTextFilePaths: string[];
	keepTextFiles: { index: number; filename: string }[];
	newImages: File[];
	newTextFiles: File[];
}

/** A new document preserves its identities; legacy records import the old attachment grouping. */
export function seedComposerEditSession(
	input: { text: string; fileReferences: FileReference[]; composerDocument?: ComposerDocument },
	existing: ExistingComposerAttachment[],
): ComposerEditSession {
	const document = input.composerDocument
		? parseComposerDocument(input.composerDocument)
		: importComposerInput(input);
	const bindings: ComposerEditSession["bindings"] = new Map();
	for (const resource of existing) {
		if (
			resource.kind === "image"
				? !resource.imageId
				: resource.kind === "audio" || resource.kind === "video"
					? !resource.mediaId
					: resource.filePath === undefined && resource.index === undefined
		)
			throw new Error("Attachment identity is missing");
	}
	if (input.composerDocument) {
		for (const kind of ["image", "textFile", "media"] as const) {
			const inLane = (value: { kind: ComposerAsset["kind"] }) =>
				kind === "media" ? value.kind === "audio" || value.kind === "video" : value.kind === kind;
			const assets = document.assets.filter(inLane);
			const resources = existing.filter(inLane);
			if (assets.length !== resources.length) throw new Error("Attachment layout is out of date");
			assets.forEach((asset, index) => {
				const resource = resources[index];
				if (
					kind === "media" &&
					(asset.kind !== resource.kind ||
						asset.name !== resource.name ||
						asset.size !== resource.size)
				)
					throw new Error("Attachment layout is out of date");
				bindings.set(asset.id, resource);
			});
		}
		return { document, bindings };
	}
	const nodes: ComposerInlineNode[] = [];
	const assets: ComposerAsset[] = [];
	for (const [index, resource] of existing.entries()) {
		const id = `existing-${resource.kind}-${index}`;
		bindings.set(id, resource);
		assets.push({
			id,
			kind: resource.kind,
			name: resource.name,
			size: resource.size,
			mimeType: resource.mimeType,
		});
		nodes.push({ type: "attachment", id: `node-${id}`, assetId: id });
	}
	return {
		document: {
			...document,
			assets,
			paragraphs: nodes.length
				? [{ children: nodes }, ...document.paragraphs]
				: document.paragraphs,
		},
		bindings,
	};
}

/** Each File gets a stable identity, including files with identical names and bytes. */
export function bindComposerEditFiles(
	session: ComposerEditSession,
	files: File[],
	kind: ComposerAsset["kind"],
) {
	const assets: ComposerAsset[] = [];
	const nodes: ComposerInlineNode[] = [];
	for (const file of files) {
		const id = getComposerAssetId(file);
		session.bindings.set(id, file);
		assets.push({ id, kind, name: file.name, size: file.size, mimeType: file.type });
		nodes.push({ type: "attachment", id: composerNodeId(), assetId: id });
	}
	return { assets, nodes };
}

/**
 * Node order and upload order are different: moving a node must not rebind an asset to
 * another server attachment. Keep arrays and manifest use server order + new files.
 */
export function projectComposerEdit(
	session: ComposerEditSession,
	document: ComposerDocument,
): ComposerEditSnapshot {
	const active = new Set(
		document.paragraphs.flatMap((paragraph) =>
			paragraph.children.flatMap((node) => (node.type === "attachment" ? [node.assetId] : [])),
		),
	);
	const metadata = new Map(document.assets.map((asset) => [asset.id, asset]));
	for (const id of active) {
		if (!session.bindings.has(id) || !metadata.has(id))
			throw new Error("Attachment resource is missing");
	}
	const assets: ComposerAsset[] = [];
	const keepImageIds: string[] = [];
	const keepMediaIds: string[] = [];
	const keepTextFilePaths: string[] = [];
	const keepTextFiles: { index: number; filename: string }[] = [];
	const newImages: File[] = [];
	const newMedia: File[] = [];
	const newTextFiles: File[] = [];
	for (const kind of ["image", "textFile", "media"] as const) {
		for (const [id, resource] of session.bindings) {
			const asset = metadata.get(id);
			if (
				!active.has(id) ||
				!asset ||
				(kind === "media" ? asset.kind !== "audio" && asset.kind !== "video" : asset.kind !== kind)
			)
				continue;
			assets.push(asset);
			if (resource instanceof File) {
				(kind === "image" ? newImages : kind === "media" ? newMedia : newTextFiles).push(resource);
			} else if (kind === "media" && resource.mediaId) {
				keepMediaIds.push(resource.mediaId);
			} else if (kind === "image" && resource.imageId) {
				keepImageIds.push(resource.imageId);
			} else if (kind === "textFile") {
				if (resource.filePath !== undefined) keepTextFilePaths.push(resource.filePath);
				if (resource.index !== undefined)
					keepTextFiles.push({ index: resource.index, filename: resource.name });
			}
		}
	}
	if (keepMediaIds.length + newMedia.length > MAX_QUEUED_MEDIA)
		throw new Error(`Maximum ${MAX_QUEUED_MEDIA} media attachments per message`);
	const composerDocument = { ...document, assets };
	const input = composerInputFromDocument(composerDocument);
	return {
		...input,
		composerDocument,
		keepImageIds,
		keepMediaIds,
		newMedia,
		keepTextFilePaths,
		keepTextFiles,
		newImages,
		newTextFiles,
	};
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
	keptMedia: MediaRef[];
	fileReferences: FileReference[];
} {
	return {
		keptMedia: [...(msg.media ?? [])],
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
		(state.keptMedia?.length ?? 0) > 0 ||
		(state.newMedia?.length ?? 0) > 0 ||
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
		...(state.keptMedia !== undefined
			? { keepMediaIds: state.keptMedia.map((media) => media.mediaId) }
			: {}),
		...(state.newMedia !== undefined ? { newMedia: [...state.newMedia] } : {}),
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
		(state.newMedia?.length ?? 0) > 0 ||
		(state.keptMedia !== undefined &&
			JSON.stringify(state.keptMedia.map((media) => media.mediaId)) !==
				JSON.stringify((original.media ?? []).map((media) => media.mediaId))) ||
		state.newTextFiles.length > 0 ||
		state.keptImages.length !== originalImages.length ||
		state.keptTextFiles.length !== originalTextFiles.length ||
		JSON.stringify(state.fileReferences) !== JSON.stringify(original.fileReferences ?? [])
	);
}
