import {
	type ComposerDocument,
	composerDocumentText,
	composerDocumentTextCandidates,
	legacyComposerDocumentText,
	MAX_COMPOSER_DOCUMENT_BYTES,
	parseComposerDocument,
	preMediaComposerDocumentProjection,
} from "@shared/composer-document";
import type { FileReference } from "@shared/file-reference";
import { ValidationError } from "./errors";

export function parseOptionalComposerDocument(value: unknown): ComposerDocument | undefined {
	if (value === undefined || value === null) return undefined;
	if (
		typeof value === "string" &&
		(value.length > MAX_COMPOSER_DOCUMENT_BYTES ||
			Buffer.byteLength(value, "utf8") > MAX_COMPOSER_DOCUMENT_BYTES)
	)
		throw new ValidationError("Composer document exceeds the 2 MiB limit");
	try {
		return parseComposerDocument(typeof value === "string" ? JSON.parse(value) : value);
	} catch {
		throw new ValidationError("Invalid composer document");
	}
}
/**
 * multipart/form-data serialization rewrites every lone LF/CR in string fields to CRLF, while
 * the JSON composerDocument keeps the editor's LF. Recover the exact projection in that case.
 */
export function restoreMultipartComposerText(
	value: string,
	document: ComposerDocument | undefined,
): string {
	if (!document) return value;
	for (const { text } of composerDocumentTextCandidates(document)) if (value === text) return value;
	for (const { text } of composerDocumentTextCandidates(document))
		if (text.replace(/\r\n|\r|\n/g, "\r\n") === value) return text;
	return value;
}
export function validateComposerProjection(
	document: ComposerDocument | undefined,
	text: string,
	references: readonly FileReference[] = [],
): void {
	validateComposerProjectionCandidates(document, text, references, false);
}

function validateComposerProjectionCandidates(
	document: ComposerDocument | undefined,
	text: string,
	references: readonly FileReference[],
	persisted: boolean,
): void {
	if (!document) return;
	const canonical = (ref: FileReference) => [
		ref.id,
		ref.deviceId,
		ref.path,
		ref.label,
		ref.selection
			? [
					ref.selection.startLineNumber,
					ref.selection.startColumn,
					ref.selection.endLineNumber,
					ref.selection.endColumn,
				]
			: null,
		ref.inputRange ?? null,
		ref.expectedHash ?? null,
	];
	const expected = JSON.stringify(references.map(canonical));
	// Version 1 did not identify the projection revision. Only stored rows can use the
	// pre-media candidate, and that revision could not have audio/video assets.
	const candidates = composerDocumentTextCandidates(document);
	if (
		persisted &&
		document.assets.every((asset) => asset.kind === "image" || asset.kind === "textFile")
	)
		candidates.push(preMediaComposerDocumentProjection(document));
	if (
		!candidates.some(
			(projected) =>
				projected.text === text &&
				JSON.stringify(projected.fileReferences.map(canonical)) === expected,
		)
	)
		throw new ValidationError("Composer document does not match text or file references");
}
/**
 * Capture canonicalizes requested references (absolute/realpath, EOF selection), so the
 * client's layout sidecar must adopt the frozen metadata before downstream validation.
 */
export function bindComposerDocumentReferences(
	document: ComposerDocument | undefined,
	references: readonly FileReference[] | undefined,
): ComposerDocument | undefined {
	if (!document || !references?.length) return document;
	const byId = new Map(references.map((ref) => [ref.id, ref]));
	return {
		...document,
		paragraphs: document.paragraphs.map((paragraph) => ({
			children: paragraph.children.map((node) => {
				if (node.type !== "fileReference") return node;
				const captured = byId.get(node.reference.id);
				if (!captured) return node;
				const { inputRange: _range, ...reference } = captured;
				return { ...node, reference };
			}),
		})),
	};
}
// biome-ignore lint/suspicious/noExplicitAny: persisted content blocks are dynamic JSON
export function validatePersistedComposerDocument(value: unknown, blocks: readonly any[]) {
	const document = parseOptionalComposerDocument(value);
	if (!document) return undefined;
	validateComposerProjectionCandidates(
		document,
		blocks
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(""),
		blocks.filter((block) => block.type === "file_reference").map((block) => block.reference),
		true,
	);
	validateComposerAssets(
		document,
		blocks.filter((block) => block.type === "image"),
		blocks.filter((block) => block.type === "text_file"),
		blocks.filter((block) => block.type === "audio" || block.type === "video"),
	);
	return document;
}

export interface ComposerAttachmentMetadata {
	name?: string;
	filename?: string;
	size?: number;
	type?: string;
	mimeType?: string;
	mediaType?: string;
	sourceMimeType?: string;
}
/** Bind only server-detected media; uploads may be the suffix after retained edit attachments. */
export function bindComposerMedia(
	document: ComposerDocument | undefined,
	media: readonly ComposerAttachmentMetadata[],
): ComposerDocument | undefined {
	if (!document || !media.length) return document;
	const assets = document.assets.filter(
		(asset) => asset.kind === "audio" || asset.kind === "video",
	);
	const offset = assets.length - media.length;
	if (offset < 0) throw new ValidationError("Composer attachment count does not match uploads");
	const replacements = new Map<string, ComposerDocument["assets"][number]>();
	media.forEach((file, index) => {
		const asset = assets[offset + index];
		const name = file.name ?? file.filename;
		if (
			(name !== undefined && asset.name !== name) ||
			(file.size !== undefined && asset.size !== file.size)
		)
			throw new ValidationError("Composer attachment metadata does not match uploads");
		const mime = file.mediaType;
		const kind =
			file.type === "audio" || file.type === "video"
				? file.type
				: mime?.startsWith("audio/")
					? "audio"
					: mime?.startsWith("video/")
						? "video"
						: undefined;
		if (kind) replacements.set(asset.id, { ...asset, kind, ...(mime ? { mimeType: mime } : {}) });
	});
	return {
		...document,
		assets: document.assets.map((asset) => replacements.get(asset.id) ?? asset),
	};
}
export function bindComposerMediaProjection(
	document: ComposerDocument | undefined,
	text: string,
	references: FileReference[] | undefined,
	media: readonly ComposerAttachmentMetadata[],
) {
	validateComposerProjection(document, text, references);
	if (!document) return { document, text, references };
	const normalized = bindComposerMedia(document, media)!;
	const current = composerDocumentText(document);
	const legacy = legacyComposerDocumentText(document);
	const projection =
		text !== current.text && text === legacy.text
			? legacyComposerDocumentText(normalized)
			: composerDocumentText(normalized);
	return {
		document: normalized,
		text: projection.text,
		references: references ? projection.fileReferences : references,
	};
}
export function validateComposerAssets(
	document: ComposerDocument | undefined,
	images: readonly ComposerAttachmentMetadata[],
	textFiles: readonly ComposerAttachmentMetadata[],
	media: readonly ComposerAttachmentMetadata[] = [],
): void {
	if (!document) return;
	const groups = [
		{ assets: document.assets.filter((asset) => asset.kind === "image"), files: images },
		{ assets: document.assets.filter((asset) => asset.kind === "textFile"), files: textFiles },
		{
			// Audio and video share the multipart media lane: keep its ordinal identity.
			assets: document.assets.filter((asset) => asset.kind === "audio" || asset.kind === "video"),
			files: media,
		},
	];
	for (const { assets, files } of groups) {
		if (assets.length !== files.length)
			throw new ValidationError("Composer attachment count does not match uploads");
		assets.forEach((asset, index) => {
			const file = files[index];
			const name = file.name ?? file.filename;
			// MIME aliases remain advisory. A known media modality must still match its chip.
			// File.type is supplied by the browser and can misclassify container-only audio.
			const mime = file.mediaType ?? file.mimeType ?? "";
			const modality =
				file.type === "audio" || file.type === "video"
					? file.type
					: mime.startsWith("audio/")
						? "audio"
						: mime.startsWith("video/")
							? "video"
							: undefined;
			if (
				(name !== undefined && asset.name !== name) ||
				(file.size !== undefined && asset.size !== file.size) ||
				((asset.kind === "audio" || asset.kind === "video") && modality && asset.kind !== modality)
			)
				throw new ValidationError("Composer attachment metadata does not match uploads");
		});
	}
}
