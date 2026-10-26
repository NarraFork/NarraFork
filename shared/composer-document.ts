import type { FileReference, FileSelection } from "./file-reference";

export const MAX_COMPOSER_DOCUMENT_BYTES = 2 * 1024 * 1024;
export const MAX_COMPOSER_DOCUMENT_NODES = 4096;
export const MAX_COMPOSER_DOCUMENT_TEXT = 200_000;
export const MAX_COMPOSER_QUOTES = 8;
export const MAX_COMPOSER_QUOTE_CHARS = 8000;

export interface ComposerAsset {
	id: string;
	kind: "image" | "textFile";
	name: string;
	size: number;
	mimeType: string;
}
export type ComposerInlineNode =
	| { type: "text"; text: string }
	| { type: "break" }
	| { type: "quote"; id: string; label: string; text: string; anchor?: string }
	| { type: "fileReference"; id: string; reference: FileReference }
	| { type: "attachment"; id: string; assetId: string };
export interface ComposerDocument {
	version: 1;
	paragraphs: { children: ComposerInlineNode[] }[];
	assets: ComposerAsset[];
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid composer object");
	const item = value as Record<string, unknown>;
	if (Object.keys(item).some((key) => !keys.includes(key)))
		throw new Error("Unknown composer field");
	return item;
}
function string(value: unknown, max: number, empty = false): string {
	if (typeof value !== "string" || value.length > max || (!empty && !value.length))
		throw new Error("Invalid composer string");
	return value;
}
function hasControl(value: string, spaces = false): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < (spaces ? 33 : 32) || code === 127) return true;
	}
	return false;
}
function identifier(value: unknown): string {
	const id = string(value, 4096);
	if (hasControl(id, true)) throw new Error("Invalid composer identity");
	return id;
}
function reference(value: unknown): FileReference {
	const item = object(value, [
		"id",
		"deviceId",
		"path",
		"label",
		"selection",
		"inputRange",
		"expectedHash",
	]);
	const result: FileReference = {
		id: identifier(item.id),
		deviceId: identifier(item.deviceId),
		path: string(item.path, 4096),
		label: string(item.label, 4096),
	};
	if (hasControl(result.path + result.label)) throw new Error("Invalid file reference");
	if (item.selection !== undefined) {
		const keys = ["startLineNumber", "startColumn", "endLineNumber", "endColumn"];
		const selection = object(item.selection, keys);
		if (
			keys.some(
				(key) =>
					!Number.isSafeInteger(selection[key]) ||
					Number(selection[key]) < 1 ||
					Number(selection[key]) > 1_000_000,
			)
		)
			throw new Error("Invalid selection");
		const s = selection as unknown as FileSelection;
		if (
			s.endLineNumber < s.startLineNumber ||
			(s.endLineNumber === s.startLineNumber && s.endColumn < s.startColumn)
		)
			throw new Error("Invalid selection");
		result.selection = { ...s };
	}
	if (item.expectedHash !== undefined) result.expectedHash = string(item.expectedHash, 128);
	if (item.inputRange !== undefined) {
		const range = item.inputRange;
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			range.some((n) => !Number.isSafeInteger(n) || n < 0 || n > MAX_COMPOSER_DOCUMENT_TEXT) ||
			range[1] <= range[0]
		)
			throw new Error("Invalid input range");
		result.inputRange = [range[0], range[1]];
	}
	return result;
}

/** Parse only the semantic allowlist, never editor JSON, HTML or browser resource URLs. */
export function parseComposerDocument(value: unknown): ComposerDocument {
	const root = object(value, ["version", "paragraphs", "assets"]);
	if (
		root.version !== 1 ||
		!Array.isArray(root.paragraphs) ||
		!Array.isArray(root.assets) ||
		root.assets.length > 4096 ||
		root.paragraphs.length > MAX_COMPOSER_DOCUMENT_NODES
	)
		throw new Error("Invalid composer document");
	const assetIds = new Set<string>();
	const assets = root.assets.map((value): ComposerAsset => {
		const item = object(value, ["id", "kind", "name", "size", "mimeType"]);
		const id = identifier(item.id);
		if (
			assetIds.has(id) ||
			(item.kind !== "image" && item.kind !== "textFile") ||
			!Number.isSafeInteger(item.size) ||
			Number(item.size) < 0
		)
			throw new Error("Invalid composer asset");
		assetIds.add(id);
		const name = string(item.name, 4096);
		const mimeType = string(item.mimeType, 255, true);
		if (hasControl(name) || name.includes("/") || name.includes("\\") || hasControl(mimeType, true))
			throw new Error("Invalid asset metadata");
		return { id, kind: item.kind, name, size: Number(item.size), mimeType };
	});
	const ids = new Set<string>();
	const refIds = new Set<string>();
	const usedAssets = new Set<string>();
	let nodes = root.paragraphs.length;
	let textChars = 0;
	let quotes = 0;
	const paragraphs = root.paragraphs.map((value) => {
		const paragraph = object(value, ["children"]);
		if (!Array.isArray(paragraph.children)) throw new Error("Invalid composer paragraph");
		nodes += paragraph.children.length;
		if (nodes > MAX_COMPOSER_DOCUMENT_NODES) throw new Error("Too many composer nodes");
		return {
			children: paragraph.children.map((value): ComposerInlineNode => {
				const node = object(value, [
					"type",
					"text",
					"id",
					"label",
					"anchor",
					"reference",
					"assetId",
				]);
				if (node.type === "text") {
					object(value, ["type", "text"]);
					const text = string(node.text, MAX_COMPOSER_DOCUMENT_TEXT, true);
					textChars += text.length;
					return { type: "text", text };
				}
				if (node.type === "break") {
					object(value, ["type"]);
					return { type: "break" };
				}
				const id = identifier(node.id);
				if (ids.has(id)) throw new Error("Duplicate composer node identity");
				ids.add(id);
				if (node.type === "quote") {
					object(value, ["type", "id", "label", "text", "anchor"]);
					if (++quotes > MAX_COMPOSER_QUOTES) throw new Error("Too many composer quotes");
					const text = string(node.text, MAX_COMPOSER_QUOTE_CHARS);
					const label = string(node.label, 80);
					if (/\s/u.test(label[0]) || /[\r\n]/u.test(label)) throw new Error("Invalid quote label");
					textChars += text.length;
					const result: ComposerInlineNode = { type: "quote", id, label, text };
					if (node.anchor !== undefined) {
						const anchor = string(node.anchor, 256);
						if (!/^[mt]:[A-Za-z0-9_-]{4,}$/u.test(anchor)) throw new Error("Invalid quote anchor");
						result.anchor = anchor;
					}
					return result;
				}
				if (node.type === "fileReference") {
					object(value, ["type", "id", "reference"]);
					const ref = reference(node.reference);
					if (refIds.has(ref.id) || refIds.size >= 16)
						throw new Error("Invalid composer references");
					refIds.add(ref.id);
					return { type: "fileReference", id, reference: ref };
				}
				if (node.type === "attachment") {
					object(value, ["type", "id", "assetId"]);
					const assetId = identifier(node.assetId);
					if (!assetIds.has(assetId)) throw new Error("Dangling composer asset");
					usedAssets.add(assetId);
					return { type: "attachment", id, assetId };
				}
				throw new Error("Unknown composer node type");
			}),
		};
	});
	if (
		nodes > MAX_COMPOSER_DOCUMENT_NODES ||
		textChars > MAX_COMPOSER_DOCUMENT_TEXT ||
		usedAssets.size !== assetIds.size
	)
		throw new Error("Invalid composer budget or unused assets");
	const doc: ComposerDocument = { version: 1, paragraphs, assets };
	const encoded = JSON.stringify(doc);
	if (
		encoded.length > MAX_COMPOSER_DOCUMENT_BYTES ||
		new TextEncoder().encode(encoded).byteLength > MAX_COMPOSER_DOCUMENT_BYTES
	)
		throw new Error("Composer document too large");
	// Placeholders lengthen the current projection; a document valid before them stays valid.
	if (legacyComposerDocumentText(doc).text.length > MAX_COMPOSER_DOCUMENT_TEXT)
		throw new Error("Composer projection too long");
	return doc;
}
export function readComposerDocument(value: unknown): ComposerDocument | undefined {
	try {
		return parseComposerDocument(value);
	} catch {
		return undefined;
	}
}
export function composerFileReferenceToken(ref: FileReference): string {
	const s = ref.selection;
	if (!s) return `#file:${ref.label}`;
	const end =
		s.endColumn === 1 && s.endLineNumber > s.startLineNumber
			? s.endLineNumber - 1
			: s.endLineNumber;
	return `#file:${ref.label}:${s.startLineNumber}-${end}`;
}
/** The canonical blockquote a quote node is sent as; sent bubbles turn it back into a chip. */
export function composerQuoteBlock(node: { label: string; text: string; anchor?: string }): string {
	const body = node.text
		.split("\n")
		.map((line) => {
			const escaped = /^\\*\[quote\]/u.test(line) ? `\\${line}` : line;
			return escaped ? `> ${escaped}` : ">";
		})
		.join("\n");
	return `> [quote] ${node.label}${node.anchor ? ` @@${node.anchor}` : ""}\n${body}\n\n`;
}

export type ComposerAttachmentPlaceholderKind = "image" | "file";
/** `[image #2: shot.png]`: the number is the 1-based upload order within its kind. */
export const COMPOSER_ATTACHMENT_PLACEHOLDER = /\[(image|file) #([1-9]\d{0,3}): ([^[\]\n]*)\]/gu;
export function composerAttachmentPlaceholderName(name: string): string {
	return name.replace(/[[\]\r\n]/gu, "_");
}
export function composerAttachmentPlaceholder(
	kind: ComposerAttachmentPlaceholderKind,
	index: number,
	name: string,
): string {
	return `[${kind} #${index + 1}: ${composerAttachmentPlaceholderName(name)}]`;
}

/**
 * Typed text that reads as an attachment placeholder gets one extra backslash, so only the
 * projection's own placeholders can claim an image. `unescapeComposerText` reverses it for
 * display. Only documents with attachments escape: text-only documents (including every
 * legacy text import) must keep projecting byte for byte.
 */
export function escapeComposerText(value: string): string {
	return value.replace(/\\*\[(?:image|file) #/gu, (match) => `\\${match}`);
}
export function unescapeComposerText(value: string): string {
	return value.replace(/\\(\\*\[(?:image|file) #)/gu, "$1");
}

/** Where each node landed in the projection, so edits can be mapped back to text nodes. */
export interface ComposerProjectionSpan {
	paragraph: number;
	node: number;
	start: number;
	end: number;
}

function isComposerContentNode(node: ComposerInlineNode): boolean {
	return (node.type === "text" && /\S/u.test(node.text)) || node.type === "fileReference";
}

/**
 * Model-visible projection, positions measured on the final UTF-16 string.
 *
 * Quotes and attachments before the first typed content keep the historical layout: quote
 * blocks as a leading prefix, attachments without any text. Once one of them follows typed
 * content its position carries meaning, so quotes are emitted where they stand and every
 * attachment gets a numbered placeholder at its position.
 */
export function composerDocumentProjection(doc: ComposerDocument): {
	text: string;
	fileReferences: FileReference[];
	spans: ComposerProjectionSpan[];
} {
	const nodes = doc.paragraphs.flatMap((paragraph, p) =>
		paragraph.children.map((node, n) => ({ node, p, n })),
	);
	const firstContent = nodes.findIndex(({ node }) => isComposerContentNode(node));
	const leading = (index: number) => firstContent < 0 || index < firstContent;
	const placeholders = nodes.some(
		({ node }, index) => node.type === "attachment" && !leading(index),
	);
	const kindIndex = new Map<string, number>();
	for (const kind of ["image", "textFile"] as const) {
		let index = 0;
		for (const asset of doc.assets) if (asset.kind === kind) kindIndex.set(asset.id, index++);
	}
	const assets = new Map(doc.assets.map((asset) => [asset.id, asset]));
	const spans: ComposerProjectionSpan[] = [];
	let text = "";
	nodes.forEach(({ node, p, n }, index) => {
		if (node.type === "quote" && leading(index)) {
			const start = text.length;
			text += composerQuoteBlock(node);
			spans.push({ paragraph: p, node: n, start, end: text.length });
		}
	});
	const fileReferences: FileReference[] = [];
	let previousParagraph = -1;
	nodes.forEach(({ node, p, n }, index) => {
		for (; previousParagraph < p; previousParagraph++) if (previousParagraph >= 0) text += "\n";
		if (node.type === "quote" && leading(index)) return;
		const start = text.length;
		if (node.type === "text") text += doc.assets.length ? escapeComposerText(node.text) : node.text;
		if (node.type === "break") text += "\n";
		if (node.type === "fileReference") {
			text += composerFileReferenceToken(node.reference);
			fileReferences.push({ ...node.reference, inputRange: [start, text.length] });
		}
		if (node.type === "quote") {
			// A quote block is only recognizable from the start of a line. The break is always
			// added, so a reader drops exactly one and keeps any line break the user typed.
			if (text) text += "\n";
			const blockStart = text.length;
			text += composerQuoteBlock(node);
			spans.push({ paragraph: p, node: n, start: blockStart, end: text.length });
			return;
		}
		if (node.type === "attachment" && placeholders) {
			const asset = assets.get(node.assetId);
			if (asset)
				text += composerAttachmentPlaceholder(
					asset.kind === "image" ? "image" : "file",
					kindIndex.get(asset.id) ?? 0,
					asset.name,
				);
		}
		spans.push({ paragraph: p, node: n, start, end: text.length });
	});
	// Empty trailing paragraphs still contribute their separators.
	for (; previousParagraph < doc.paragraphs.length - 1; previousParagraph++)
		if (previousParagraph >= 0) text += "\n";
	return { text, fileReferences, spans };
}

export function composerDocumentText(doc: ComposerDocument): {
	text: string;
	fileReferences: FileReference[];
} {
	const { text, fileReferences } = composerDocumentProjection(doc);
	return { text, fileReferences };
}

/**
 * The projection written before positional quotes and attachment placeholders existed: every
 * quote hoisted into the prefix, attachments invisible. Still accepted from stale clients,
 * queued rows and drafts, and still the editor's body offset space once quotes are removed.
 */
export function legacyComposerDocumentText(doc: ComposerDocument): {
	text: string;
	fileReferences: FileReference[];
	spans: ComposerProjectionSpan[];
} {
	const spans: ComposerProjectionSpan[] = [];
	let text = "";
	doc.paragraphs.forEach((paragraph, p) => {
		paragraph.children.forEach((node, n) => {
			if (node.type !== "quote") return;
			const start = text.length;
			text += composerQuoteBlock(node);
			spans.push({ paragraph: p, node: n, start, end: text.length });
		});
	});
	const fileReferences: FileReference[] = [];
	doc.paragraphs.forEach((paragraph, p) => {
		if (p) text += "\n";
		paragraph.children.forEach((node, n) => {
			if (node.type === "quote") return;
			const start = text.length;
			if (node.type === "text") text += node.text;
			if (node.type === "break") text += "\n";
			if (node.type === "fileReference") {
				text += composerFileReferenceToken(node.reference);
				fileReferences.push({ ...node.reference, inputRange: [start, text.length] });
			}
			spans.push({ paragraph: p, node: n, start, end: text.length });
		});
	});
	return { text, fileReferences, spans };
}

/** Both projections a stored document may legitimately be paired with, current first. */
export function composerDocumentTextCandidates(doc: ComposerDocument) {
	const current = composerDocumentProjection(doc);
	const legacy = legacyComposerDocumentText(doc);
	return current.text === legacy.text ? [current] : [current, legacy];
}
