/**
 * DOCX → document IR.
 *
 * The body is walked in document order, so paragraphs, tables and drawings keep the sequence
 * a reader sees. Every extraction is bounded: a document cannot make this reader materialise
 * an unbounded string or an unbounded number of blocks.
 *
 * Ported from `examples/plugins/doc-markdown/server/lib/docx.js` (branch
 * `experiment/doc-to-markdown`) into ESM + types. The export-only features of the original
 * (run styling sidecars, outline extraction, page ranges, XLSX) are dropped: a read-only
 * preview needs order, text, headings, lists, tables and pictures.
 *
 * Security: entries are read only by name from a ZIP this module opened itself, and pictures
 * are exposed through generated ids (`a1`, `a2`, …) — never through a path a client supplied.
 */

import { MAX_DOCUMENT_ASSET_BYTES, OMITTED_DOCUMENT_IMAGE_MIMES } from "./limits";
import { type DocumentBlock, renderMarkdown } from "./markdown";
import type { DocumentAssetRef, DocumentPreviewResult } from "./types";
import { walkXml } from "./xml";
import { openZip, type ZipArchive } from "./zip";

const MAX_BLOCKS = 20_000;
const MAX_TEXT_CHARS = 20_000_000;
const MAX_ASSETS = 500;

const HEADING_STYLE_PATTERN = /^(?:heading|标题)\s*([1-6])$/i;

interface BodyEvent {
	type: "open" | "close" | "text";
	name?: string;
	attributes?: Record<string, string>;
	selfClosing?: boolean;
	text?: string;
}

interface ParagraphImage {
	target: string;
}

interface ParagraphInfo {
	text: string;
	level: number;
	numId?: string;
	ilvl?: string;
	images: ParagraphImage[];
}

/* ------------------------------------------------------------------ *
 * Style + relationship helpers
 * ------------------------------------------------------------------ */

/** `word/heading\1`-style style ids resolve through styles.xml to a human name. */
function readStyleNames(zip: ZipArchive): Map<string, string> {
	const xml = zip.text("word/styles.xml");
	const names = new Map<string, string>();
	if (!xml) return names;

	let currentId: string | undefined;
	walkXml(xml, {
		open({ name, attributes }) {
			if (name === "w:style") currentId = attributes["w:styleId"];
			if (name === "w:name" && currentId) names.set(currentId, attributes["w:val"] ?? "");
		},
		close({ name }) {
			if (name === "w:style") currentId = undefined;
		},
		text() {
			return true;
		},
	});
	return names;
}

interface Relationship {
	target: string;
	external: boolean;
}

function readRelationships(zip: ZipArchive, part: string): Map<string, Relationship> {
	const relsPath = part.replace(/([^/]+)$/, "_rels/$1.rels");
	const xml = zip.text(relsPath);
	const rels = new Map<string, Relationship>();
	if (!xml) return rels;

	let currentId: string | undefined;
	let external = false;
	let target = "";
	walkXml(xml, {
		open({ name, attributes }) {
			if (name !== "Relationship") return;
			currentId = attributes.Id;
			external = attributes.TargetMode === "External";
			target = attributes.Target ?? "";
		},
		close({ name }) {
			if (name !== "Relationship" || !currentId) return;
			rels.set(currentId, { target, external });
			currentId = undefined;
		},
		text() {
			return true;
		},
	});
	return rels;
}

/** Map a paragraph style to a Markdown heading level, when it is one. */
function headingLevelFor(
	styleId: string | undefined,
	styleName: string | undefined,
	outlineLevel: string | undefined,
): number {
	if (outlineLevel !== undefined && outlineLevel !== "") {
		const level = Number(outlineLevel);
		if (Number.isInteger(level) && level >= 0 && level <= 5) return level + 1;
	}
	for (const candidate of [styleName, styleId]) {
		if (!candidate) continue;
		const trimmed = candidate.trim();
		const match = HEADING_STYLE_PATTERN.exec(trimmed);
		if (match) return Number(match[1]);
		// Document defaults in non-English templates sometimes only say "Title".
		if (/^title$/i.test(trimmed)) return 1;
	}
	return 0;
}

/* ------------------------------------------------------------------ *
 * Body walk
 * ------------------------------------------------------------------ */

function paragraphFrom(
	events: BodyEvent[],
	styleNames: Map<string, string>,
	rels: Map<string, Relationship>,
): ParagraphInfo {
	const runs: string[] = [];
	const images: ParagraphImage[] = [];
	let styleId: string | undefined;
	let outlineLevel: string | undefined;
	let numId: string | undefined;
	let ilvl: string | undefined;

	// Run state resets at every `w:r` boundary: OOXML applies character formatting per run.
	let currentRun: string | null = null;
	// Character data belongs to `w:t`/`w:delText`; text nodes anywhere else are the whitespace
	// between pretty-printed elements and must not become paragraph text.
	let inText = 0;

	const flushRun = () => {
		if (currentRun) runs.push(currentRun);
		currentRun = null;
	};

	for (const event of events) {
		if (event.type === "open") {
			const name = event.name as string;
			const attributes = event.attributes ?? {};
			if (name === "w:pStyle") styleId = attributes["w:val"];
			else if (name === "w:outlineLvl") outlineLevel = attributes["w:val"];
			else if (name === "w:numId") numId = attributes["w:val"];
			else if (name === "w:ilvl") ilvl = attributes["w:val"];
			else if (name === "w:t" || name === "w:delText") inText += 1;
			else if (name === "w:r") {
				flushRun();
				currentRun = "";
			} else if (name === "w:tab") {
				if (currentRun === null) currentRun = "";
				currentRun += "\t";
			} else if (name === "w:br" || name === "w:cr") {
				if (currentRun === null) currentRun = "";
				currentRun += "\n";
			} else if (name.endsWith(":blip")) {
				const embed = attributes["r:embed"];
				const rel = embed ? rels.get(embed) : undefined;
				if (rel && !rel.external) images.push({ target: rel.target });
			}
		} else if (event.type === "close") {
			if (event.name === "w:t" || event.name === "w:delText") inText = Math.max(0, inText - 1);
			else if (event.name === "w:r") flushRun();
		} else if (event.type === "text") {
			if (inText <= 0) continue;
			if (currentRun === null) currentRun = "";
			currentRun += event.text ?? "";
		}
	}
	flushRun();

	const text = runs.join("");
	const styleName = styleId ? styleNames.get(styleId) : undefined;
	return {
		text,
		level: headingLevelFor(styleId, styleName, outlineLevel),
		numId,
		ilvl,
		images,
	};
}

function tableFrom(events: BodyEvent[]): {
	rows: string[][];
	merges: string[];
	headerRow: boolean;
} {
	const rows: string[][] = [];
	const merges: string[] = [];
	let row: string[] | undefined;
	let cellText = "";
	let rowIndex = -1;
	let columnIndex = 0;
	let gridSpan = 1;
	let vMerge: string | undefined;
	// Same rule as paragraphs: only `w:t`/`w:delText` carries cell content.
	let inText = 0;

	for (const event of events) {
		if (event.type === "open") {
			const name = event.name as string;
			const attributes = event.attributes ?? {};
			if (name === "w:tr") {
				row = [];
				rowIndex += 1;
				columnIndex = 0;
			} else if (name === "w:tc") {
				cellText = "";
				gridSpan = Number(attributes["w:gridSpan"] ?? 1) || 1;
				vMerge = undefined;
			} else if (name === "w:t" || name === "w:delText") {
				inText += 1;
			} else if (name === "w:gridSpan") {
				gridSpan = Number(attributes["w:val"] ?? 1) || 1;
			} else if (name === "w:vMerge") {
				vMerge = attributes["w:val"] ?? "continue";
			}
		} else if (event.type === "text") {
			if (inText > 0) cellText += event.text ?? "";
		} else if (event.type === "close") {
			const name = event.name;
			if (name === "w:t" || name === "w:delText") inText = Math.max(0, inText - 1);
			else if (name === "w:tc" && row) {
				row.push(cellText.replace(/\s+/g, " ").trim());
				if (gridSpan > 1) {
					for (let extra = 1; extra < gridSpan; extra += 1) row.push("");
					merges.push(`R${rowIndex + 1}C${columnIndex + 1}:span${gridSpan}`);
				}
				if (vMerge === "continue") merges.push(`R${rowIndex + 1}C${columnIndex + 1}:merged`);
				columnIndex += gridSpan;
			} else if (name === "w:tr" && row) {
				rows.push(row);
				row = undefined;
			}
		}
	}

	return { rows, merges: merges.slice(0, 50), headerRow: rows.length > 1 };
}

/** Group the flat event stream into paragraph/table units, preserving order. */
function groupBodyEvents(
	events: BodyEvent[],
): Array<{ kind: "paragraph" | "table"; events: BodyEvent[] }> {
	const units: Array<{ kind: "paragraph" | "table"; events: BodyEvent[] }> = [];
	let paragraphEvents: BodyEvent[] | undefined;
	let tableDepth = 0;
	let tableEvents: BodyEvent[] = [];

	for (const event of events) {
		if (event.type === "open" && event.name === "w:p") {
			if (tableDepth === 0) paragraphEvents = [];
			else tableEvents.push(event);
			if (tableDepth === 0) continue;
		}
		if (event.type === "open" && event.name === "w:tbl") {
			tableDepth += 1;
			if (tableDepth === 1) tableEvents = [event];
			else tableEvents.push(event);
			continue;
		}
		if (tableDepth > 0) {
			tableEvents.push(event);
			if (event.type === "close" && event.name === "w:tbl") {
				tableDepth -= 1;
				if (tableDepth === 0) {
					units.push({ kind: "table", events: tableEvents });
					tableEvents = [];
				}
			}
			if (event.type === "open" && event.name === "w:p") tableEvents.push(event);
			continue;
		}
		if (event.type === "close" && event.name === "w:p" && paragraphEvents) {
			units.push({ kind: "paragraph", events: paragraphEvents });
			paragraphEvents = undefined;
			continue;
		}
		if (paragraphEvents) paragraphEvents.push(event);
	}

	return units;
}

function readBodyEvents(documentXml: string): BodyEvent[] {
	const events: BodyEvent[] = [];
	let bodyDepth = 0;
	walkXml(documentXml, {
		open(event) {
			if (event.name === "w:body") {
				bodyDepth += 1;
				return true;
			}
			if (bodyDepth > 0) events.push({ type: "open", ...event });
			return true;
		},
		close(event) {
			if (event.name === "w:body") {
				bodyDepth = Math.max(0, bodyDepth - 1);
				return bodyDepth > 0;
			}
			if (bodyDepth > 0) events.push({ type: "close", name: event.name });
			return true;
		},
		text(chunk) {
			if (bodyDepth > 0) events.push({ type: "text", text: chunk });
			return true;
		},
	});
	return events;
}

/* ------------------------------------------------------------------ *
 * Image parts
 * ------------------------------------------------------------------ */

const MIME_BY_EXT: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	svg: "image/svg+xml",
	emf: "image/emf",
	wmf: "image/wmf",
};

/**
 * Extensions whose MIME is in `OMITTED_DOCUMENT_IMAGE_MIMES`.
 *
 * Checked before inflate: an SVG can be the full picture cap (20MB) and sanitizing it would
 * parse that whole document. Dropping the part is enough — the preview has no use for a format
 * it must not execute, and EMF/WMF would not paint. A name match skips the inflate entirely.
 */
const OMITTED_IMAGE_EXTENSIONS = new Set(["svg", "emf", "wmf"]);

function imageExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** True when this part must be omitted rather than returned as an image. */
function omittedImagePart(name: string, bytes?: Uint8Array): boolean {
	if (OMITTED_IMAGE_EXTENSIONS.has(imageExtension(name))) return true;
	return bytes !== undefined && OMITTED_DOCUMENT_IMAGE_MIMES.has(imageMimeFor(name, bytes));
}

/** MIME from the stored part's magic bytes, falling back to its extension. */
export function imageMimeFor(name: string, bytes: Uint8Array): string {
	const head = bytes.subarray(0, 12);
	const startsWith = (...values: number[]) => values.every((value, index) => head[index] === value);
	if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (startsWith(0x47, 0x49, 0x46)) return "image/gif";
	if (startsWith(0x42, 0x4d)) return "image/bmp";
	if (startsWith(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57) return "image/webp";
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface ParseDocxOptions {
	/** Absolute path of the document, used in the inline-image placeholders. */
	filePath: string;
	/**
	 * Called for each extracted picture, with the exact ZIP part it came from and its bytes.
	 *
	 * This is how the asset endpoint resolves one id without inventing a second lookup: the
	 * parser's own walk decides which part an id refers to, so a client can never name a part.
	 */
	onAsset?: (asset: DocumentAssetRef, part: string, bytes: Uint8Array) => void;
}

/**
 * Parse a DOCX buffer into a finished preview result (Markdown + asset metadata).
 *
 * Throws on a malformed container; returns normally with `truncated`/`omitted` when a budget
 * stopped the read early.
 */
export function parseDocx(buffer: Buffer, options: ParseDocxOptions): DocumentPreviewResult {
	const zip = openZip(buffer);
	const documentXml = zip.text("word/document.xml");
	if (!documentXml) throw new Error("word/document.xml is missing");

	const styleNames = readStyleNames(zip);
	const rels = readRelationships(zip, "word/document.xml");
	const units = groupBodyEvents(readBodyEvents(documentXml));

	const blocks: DocumentBlock[] = [];
	const assets: DocumentAssetRef[] = [];
	const omitted: string[] = [];
	/** Dedupe: the same picture reused in several places is extracted once. */
	const assetByPart = new Map<string, string>();
	let charBudget = MAX_TEXT_CHARS;
	let truncated = false;
	let pendingList: {
		ordered: boolean;
		level: number;
		items: Array<{ level: number; text: string }>;
	} | null = null;

	const flushList = () => {
		if (!pendingList?.items.length) return;
		blocks.push({ type: "list", ordered: pendingList.ordered, items: pendingList.items });
		pendingList = null;
	};

	for (const unit of units) {
		if (blocks.length >= MAX_BLOCKS) {
			truncated = true;
			omitted.push(`stopped after ${MAX_BLOCKS} blocks`);
			break;
		}

		if (unit.kind === "table") {
			flushList();
			const table = tableFrom(unit.events);
			if (table.rows.length) blocks.push({ type: "table", ...table });
			continue;
		}

		const paragraph = paragraphFrom(unit.events, styleNames, rels);

		for (const image of paragraph.images) {
			const relative = image.target.startsWith("/")
				? image.target.slice(1)
				: `word/${image.target.replace(/^\.\//, "")}`;
			if (!zip.has(relative)) continue;
			// Extension is enough to know the type, so a large SVG is never inflated.
			if (omittedImagePart(relative)) {
				omitted.push("a picture format cannot be previewed");
				continue;
			}

			const existing = assetByPart.get(relative);
			if (existing) {
				flushList();
				blocks.push({ type: "image", assetId: existing, alt: "" });
				continue;
			}
			if (assets.length >= MAX_ASSETS) {
				truncated = true;
				omitted.push(`stopped extracting pictures after ${MAX_ASSETS}`);
				continue;
			}

			let bytes: Uint8Array | undefined;
			try {
				bytes = zip.read(relative);
			} catch {
				omitted.push("a picture could not be extracted");
				continue;
			}
			if (!bytes || bytes.length === 0) continue;
			if (bytes.length > MAX_DOCUMENT_ASSET_BYTES) {
				omitted.push("a picture was too large to include");
				continue;
			}

			const mime = imageMimeFor(relative, bytes);
			// Magic bytes can disagree with the name. Still refuse an active or unpaintable type.
			if (omittedImagePart(relative, bytes)) {
				omitted.push("a picture format cannot be previewed");
				continue;
			}

			const asset: DocumentAssetRef = {
				id: `a${assets.length + 1}`,
				mime,
				byteLength: bytes.length,
			};
			assets.push(asset);
			assetByPart.set(relative, asset.id);
			options.onAsset?.(asset, relative, bytes);
			flushList();
			blocks.push({ type: "image", assetId: asset.id, alt: "" });
		}

		const text = paragraph.text;
		if (!text.trim()) continue;

		charBudget -= text.length;
		if (charBudget <= 0) {
			truncated = true;
			omitted.push("text budget exhausted");
			break;
		}

		if (paragraph.numId) {
			const level = Number(paragraph.ilvl ?? 0) + 1;
			// OOXML encodes bullet vs ordinal in numbering.xml; without resolving it, the
			// conservative choice is a bullet list, which never invents a wrong number.
			pendingList ??= { ordered: false, level, items: [] };
			pendingList.items.push({ level, text });
			continue;
		}

		flushList();

		if (paragraph.level > 0) blocks.push({ type: "heading", level: paragraph.level, text });
		else blocks.push({ type: "paragraph", text });
	}

	flushList();

	const meta: { title?: string; author?: string } = {};
	const coreXml = zip.text("docProps/core.xml");
	if (coreXml) {
		const title = /<dc:title>([^<]*)<\/dc:title>/.exec(coreXml);
		const creator = /<dc:creator>([^<]*)<\/dc:creator>/.exec(coreXml);
		if (title?.[1]) meta.title = title[1];
		if (creator?.[1]) meta.author = creator[1];
	}

	return {
		kind: "docx",
		markdown: renderMarkdown(blocks, options.filePath),
		assets,
		truncated,
		omitted,
		meta,
	};
}

/**
 * Extract one picture's bytes for the asset endpoint.
 *
 * The requested id is resolved by the SAME walk that minted it, so the client only ever names
 * a generated id; it cannot address a ZIP part directly. Returns `undefined` for an unknown id
 * (including one from a different document).
 */
export function readDocxAsset(
	buffer: Buffer,
	assetId: string,
	filePath: string,
): { bytes: Uint8Array; mime: string } | undefined {
	let found: { bytes: Uint8Array; mime: string } | undefined;
	parseDocx(buffer, {
		filePath,
		onAsset(asset, _part, bytes) {
			if (asset.id === assetId) found = { bytes, mime: asset.mime };
		},
	});
	return found;
}
