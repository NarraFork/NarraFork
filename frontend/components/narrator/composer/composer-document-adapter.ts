import {
	type ComposerAsset,
	type ComposerDocument,
	type ComposerInlineNode,
	composerDocumentText,
	readComposerDocument,
} from "@shared/composer-document";
import { mediaModality } from "@shared/media-attachments";
import { parseComposerQuotePrefix } from "./composer-quotes";
import { getComposerAssetId } from "./draft-image-attachments";
import { type FileReferenceInput, readFileReferences } from "./file-reference-input";

export function composerNodeId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ?? `node-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

/** Old records never contained attachment positions: import their actual old order, not a guess. */
export function importComposerInput(input: FileReferenceInput): ComposerDocument {
	const stored = readComposerDocument(input.composerDocument);
	if (stored) return stored;
	const parsed = parseComposerQuotePrefix(input.text);
	const quoteDocument = readComposerDocument({
		version: 1,
		paragraphs: [
			{
				children: parsed.quotes.map((quote) => ({
					type: "quote",
					id: composerNodeId(),
					...quote,
				})),
			},
		],
		assets: [],
	});
	// Legacy prefixes can exceed today's quote limits or use noncanonical spacing.
	// Only promote a lossless, valid prefix; otherwise retain every original character.
	const prefixLength =
		quoteDocument &&
		composerDocumentText(quoteDocument).text === input.text.slice(0, parsed.prefixLength)
			? parsed.prefixLength
			: 0;
	const refs = readFileReferences(input.fileReferences, input.text);
	const children: ComposerInlineNode[] = prefixLength
		? (quoteDocument?.paragraphs[0].children ?? [])
		: [];
	const ranges = refs
		.filter((ref) => ref.inputRange && ref.inputRange[0] >= prefixLength)
		.sort((a, b) => (a.inputRange?.[0] ?? 0) - (b.inputRange?.[0] ?? 0));
	let offset = prefixLength;
	const used = new Set<string>();
	for (const ref of ranges) {
		const range = ref.inputRange;
		if (!range || range[0] < offset) continue;
		if (range[0] > offset)
			children.push({ type: "text", text: input.text.slice(offset, range[0]) });
		children.push({ type: "fileReference", id: ref.id, reference: ref });
		used.add(ref.id);
		offset = range[1];
	}
	if (offset < input.text.length) children.push({ type: "text", text: input.text.slice(offset) });
	for (const ref of refs) {
		if (!used.has(ref.id)) children.push({ type: "fileReference", id: ref.id, reference: ref });
	}
	return { version: 1, paragraphs: [{ children }], assets: [] };
}

export function composerInputFromDocument(composerDocument: ComposerDocument): FileReferenceInput {
	return { ...composerDocumentText(composerDocument), composerDocument };
}

export function composerAssetsFromFiles(
	images: File[],
	textFiles: File[],
	mediaFiles: File[] = [],
): ComposerAsset[] {
	return [
		...images.map((file) => ({ file, kind: "image" as const })),
		...textFiles.map((file) => ({ file, kind: "textFile" as const })),
		...mediaFiles.flatMap((file) => {
			const kind = mediaModality(file.type);
			return kind ? [{ file, kind }] : [];
		}),
	].map(({ file, kind }) => ({
		id: getComposerAssetId(file),
		kind,
		name: file.name,
		size: file.size,
		mimeType: file.type,
	}));
}

/** Merge hydrated/new files without removing missing resources or shifting existing atoms. */
export function withComposerAttachments(
	document: ComposerDocument,
	images: File[],
	textFiles: File[],
	mediaFiles: File[] = [],
): ComposerDocument {
	const files = composerAssetsFromFiles(images, textFiles, mediaFiles);
	const known = new Set(document.assets.map((asset) => asset.id));
	const fresh = files.filter((asset) => !known.has(asset.id));
	if (!fresh.length) return document;
	const paragraphs = document.paragraphs.map((paragraph) => ({
		children: [...paragraph.children],
	}));
	if (!paragraphs.length) paragraphs.push({ children: [] });
	const last = paragraphs[paragraphs.length - 1];
	for (const asset of fresh) {
		last.children.push({ type: "attachment", id: composerNodeId(), assetId: asset.id });
	}
	return { ...document, paragraphs, assets: [...document.assets, ...fresh] };
}

export function composerFileResources(images: File[], textFiles: File[]): Map<string, File> {
	return new Map([...images, ...textFiles].map((file) => [getComposerAssetId(file), file]));
}

export function missingComposerAssets(
	document: ComposerDocument,
	resources: ReadonlyMap<string, unknown>,
): boolean {
	return document.assets.some((asset) => !resources.has(asset.id));
}
