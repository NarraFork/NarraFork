/**
 * measure-media.ts — Zero-DOM height model for the three MessageBubble media
 * blocks (CONTRACT.md §4, WBS-batch2 P2):
 *
 *   - image            → fixed 200px (Skeleton placeholder is also 200). 🟢
 *   - text_file        → single icon+name+size row, py=2. 🟢
 *   - image_generation → header row (icon + status + optional loader) + image
 *     area. With intrinsic width/height the image area is reserved via aspect
 *     ratio (ZERO measurement). The revisedPrompt can wrap, so the header text
 *     line count is derived with pretext (measure-markdown style). Without
 *     metrics but with an image source, the image area falls back to a
 *     conservative PreparedUnknownBlock placeholder.
 *
 * Chrome constants come from the batch-1 exploration + pretext-fonts.ts +
 * Mantine v7 defaults. Reference template: measure-markdown.ts /
 * measure-message-bubble.ts.
 *
 * ZERO DOM: no getBoundingClientRect / offsetHeight / ResizeObserver. The only
 * variable part (header wrap) uses pretext pure arithmetic; everything else is
 * fixed or aspect-ratio derived.
 */

import { prepareRichInline, type RichInlineItem } from "@chenglou/pretext/rich-inline";
import {
	accumulateFrame,
	type BlockFrame,
	type ElementFrame,
	type MeasuredElement,
	type PreparedBlock,
	type PreparedBlockBase,
	type PreparedFixedBlock,
	type PreparedInlineBlock,
	type PreparedUnknownBlock,
	type RenderLod,
} from "../prepared-block";
import {
	FONT_SIZE,
	FONT_WEIGHT,
	LINE_HEIGHT,
	lineBoxHeight,
	SANS_FAMILY,
	SPACING,
} from "../pretext-fonts";
import { inlineMetrics, pretextLineMetrics } from "./pretext-metrics";

// ── Shared flat block base (media blocks have no list/quote nesting) ─────────
const FLAT_BASE: PreparedBlockBase = {
	marginTop: 0,
	contentLeft: 0,
	quoteRailLefts: [],
	markerText: null,
	markerLeft: null,
	markerClassName: null,
};

// ── image ────────────────────────────────────────────────────────────────────
/** Fixed image height (px). Matches the rendered `<Image h={200}>` and the
 * `<Skeleton h={200}>` loading placeholder. */
export const IMAGE_FIXED_HEIGHT = 200;

export interface MeasureImageInput {
	imageId?: string;
	previewUrl?: string;
	mediaType?: string;
	filename?: string;
	uploadNarratorId?: string;
}

/**
 * Measure an inline image block. Always a fixed 200px tall box (the rendered
 * image is `h={200} w="auto"`, and the loading Skeleton is also 200). Zero
 * measurement.
 */
export function measureImage(
	data: MeasureImageInput,
	contentWidth: number,
	_lod: RenderLod = 5,
): MeasuredElement {
	const block: PreparedFixedBlock = {
		...FLAT_BASE,
		kind: "fixed",
		height: IMAGE_FIXED_HEIGHT,
		tag: "image",
		data: {
			imageId: data.imageId ?? null,
			previewUrl: data.previewUrl ?? null,
			mediaType: data.mediaType ?? null,
			filename: data.filename ?? null,
			uploadNarratorId: data.uploadNarratorId ?? null,
		},
	};
	const blocks: PreparedBlock[] = [block];
	const frame = accumulateFrame(blocks, contentWidth, pretextLineMetrics);
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: Math.min(contentWidth, IMAGE_FIXED_HEIGHT),
	};
}

// ── text_file ──────────────────────────────────────────────────────────────
/** ThemeIcon size="sm" is 22px (dominant height of the single row). */
export const TEXT_FILE_ICON_SIZE = 22;
/** Group py={2}. */
export const TEXT_FILE_PADDING_Y = 2;
/** Single-row height: the ThemeIcon (22) dominates the xs/sm text; + py. */
export const TEXT_FILE_HEIGHT = TEXT_FILE_ICON_SIZE + TEXT_FILE_PADDING_Y * 2; // 26

export interface MeasureTextFileInput {
	filename?: string;
	size?: number;
	mediaType?: string;
}

/**
 * Measure a text-file attachment chip: a single row (icon + filename + size).
 * Fixed height regardless of width — the filename is not wrapped in the list
 * view. Zero measurement.
 */
export function measureTextFile(
	data: MeasureTextFileInput,
	contentWidth: number,
	_lod: RenderLod = 5,
): MeasuredElement {
	const block: PreparedFixedBlock = {
		...FLAT_BASE,
		kind: "fixed",
		height: TEXT_FILE_HEIGHT,
		tag: "text_file",
		data: {
			filename: data.filename ?? null,
			size: typeof data.size === "number" ? data.size : null,
			mediaType: data.mediaType ?? null,
		},
	};
	const blocks: PreparedBlock[] = [block];
	const frame = accumulateFrame(blocks, contentWidth, pretextLineMetrics);
	return {
		height: frame.contentHeight,
		blocks,
		frame,
		contentWidth,
		usedWidth: contentWidth,
	};
}

// ── image_generation ─────────────────────────────────────────────────────────
/** Paper p="xs" padding (px). */
export const IMGGEN_PAPER_PADDING = SPACING.xs; // 10
/** Paper withBorder → 1px top + 1px bottom. */
export const IMGGEN_BORDER = 1;
/** Header ThemeIcon size={18}. */
export const IMGGEN_ICON_SIZE = 18;
/** Loader size={12} shown while generating. */
export const IMGGEN_LOADER_SIZE = 12;
/** Group gap={6} between header items. */
export const IMGGEN_GROUP_GAP = 6;
/** Group mb="xs" between header and the reserved image area. */
export const IMGGEN_IMAGE_GAP = SPACING.xs; // 10
/** Header text (xs) line box height. */
export const IMGGEN_HEADER_LINE_HEIGHT = lineBoxHeight(FONT_SIZE.xs, LINE_HEIGHT.xs); // 17
/** GENERATED_IMAGE_MAX_DISPLAY_WIDTH from the original component. */
export const IMGGEN_MAX_DISPLAY_WIDTH = 512;
/** Conservative fallback image area height when intrinsic size is unknown. */
export const IMGGEN_UNKNOWN_IMAGE_HEIGHT = 240;

const IMGGEN_STATUS_FONT = `${FONT_WEIGHT.regular} ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
// revisedPrompt is fw={500} in the original component.
const IMGGEN_PROMPT_FONT = `500 ${FONT_SIZE.xs}px ${SANS_FAMILY}`;
// ml={4} applied to the revisedPrompt span.
const IMGGEN_PROMPT_GAP = 4;

const IMGGEN_STATUS_CLASS = "vlist-imggen-status";
const IMGGEN_PROMPT_CLASS = "vlist-imggen-prompt";

export interface MeasureImageGenerationInput {
	/** Raw status ("generating" / "in_progress" / "completed" / ...). */
	status?: string;
	/** Localized status text actually rendered (drives header wrap width). */
	statusText?: string;
	/** Revised prompt shown after the status (fw 500, may wrap). */
	revisedPrompt?: string;
	/** Inline base64 / data-url result (image source hint). */
	result?: string;
	savedPath?: string;
	partialSavedPath?: string;
	/** Intrinsic pixel width/height — enables aspect-ratio reservation. */
	width?: number;
	height?: number;
}

interface ImageMetrics {
	width: number;
	height: number;
}

function getImageMetrics(data: MeasureImageGenerationInput): ImageMetrics | null {
	const { width, height } = data;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isFinite(width) ||
		!Number.isFinite(height) ||
		width <= 0 ||
		height <= 0
	) {
		return null;
	}
	return { width, height };
}

function isGeneratingStatus(status: string | undefined): boolean {
	return !!status && status !== "completed";
}

/** Build the header rich-inline flow (status text + optional revisedPrompt). */
function buildHeaderInline(
	data: MeasureImageGenerationInput,
	contentLeft: number,
): PreparedInlineBlock {
	const items: RichInlineItem[] = [];
	const fonts: string[] = [];
	const classNames: string[] = [];
	const hrefs: Array<string | null> = [];

	const statusText = data.statusText ?? "";
	if (statusText.length > 0) {
		items.push({ text: statusText, font: IMGGEN_STATUS_FONT, break: "normal", extraWidth: 0 });
		fonts.push(IMGGEN_STATUS_FONT);
		classNames.push(IMGGEN_STATUS_CLASS);
		hrefs.push(null);
	}
	const prompt = data.revisedPrompt ?? "";
	if (prompt.length > 0) {
		items.push({
			text: prompt,
			font: IMGGEN_PROMPT_FONT,
			break: "normal",
			extraWidth: items.length > 0 ? IMGGEN_PROMPT_GAP : 0,
		});
		fonts.push(IMGGEN_PROMPT_FONT);
		classNames.push(IMGGEN_PROMPT_CLASS);
		hrefs.push(null);
	}
	// Guarantee at least one fragment so pretext produces a valid single line.
	if (items.length === 0) {
		items.push({ text: " ", font: IMGGEN_STATUS_FONT, break: "normal", extraWidth: 0 });
		fonts.push(IMGGEN_STATUS_FONT);
		classNames.push(IMGGEN_STATUS_CLASS);
		hrefs.push(null);
	}

	return {
		...FLAT_BASE,
		kind: "inline",
		flow: prepareRichInline(items),
		lineHeight: IMGGEN_HEADER_LINE_HEIGHT,
		classNames,
		hrefs,
		fonts,
		contentLeft,
	};
}

/**
 * Measure an image_generation block. Header (icon + status + optional loader +
 * wrapping revisedPrompt) stacked above an image area whose height is either
 * aspect-ratio reserved (intrinsic width/height known → zero measurement) or a
 * conservative placeholder (unknown size but an image source exists) or absent.
 */
export function measureImageGeneration(
	data: MeasureImageGenerationInput,
	contentWidth: number,
	_lod: RenderLod = 5,
): MeasuredElement {
	const innerWidth = Math.max(1, contentWidth - IMGGEN_PAPER_PADDING * 2);
	const generating = isGeneratingStatus(data.status);
	const loaderWidth = generating ? IMGGEN_LOADER_SIZE + IMGGEN_GROUP_GAP : 0;
	// Icon + gap (+ loader + gap) reserved to the left of the header text.
	const iconArea = IMGGEN_ICON_SIZE + IMGGEN_GROUP_GAP + loaderWidth;

	const headerBlock = buildHeaderInline(data, iconArea);
	const headerTextWidth = Math.max(1, innerWidth - iconArea);
	const { lineCount, maxLineWidth } = inlineMetrics(headerBlock, headerTextWidth);
	const textHeight = lineCount * IMGGEN_HEADER_LINE_HEIGHT;
	// The header row is at least as tall as the icon.
	const headerHeight = Math.max(IMGGEN_ICON_SIZE, textHeight);

	// Image area.
	const metrics = getImageMetrics(data);
	const hasSource = !!(data.result || data.savedPath || data.partialSavedPath);

	const blocks: PreparedBlock[] = [headerBlock];
	const frames: BlockFrame[] = [
		{ index: 0, top: 0, height: headerHeight, usedWidth: iconArea + maxLineWidth },
	];
	let contentHeight = headerHeight;

	if (metrics) {
		const displayWidth = Math.min(innerWidth, Math.min(metrics.width, IMGGEN_MAX_DISPLAY_WIDTH));
		const imageHeight = Math.round((displayWidth * metrics.height) / metrics.width);
		const imageBlock: PreparedFixedBlock = {
			...FLAT_BASE,
			kind: "fixed",
			marginTop: IMGGEN_IMAGE_GAP,
			height: imageHeight,
			tag: "imggen-image",
			data: {
				displayWidth,
				intrinsicWidth: metrics.width,
				intrinsicHeight: metrics.height,
				result: data.result ?? null,
				savedPath: data.savedPath ?? null,
				partialSavedPath: data.partialSavedPath ?? null,
			},
		};
		const top = headerHeight + IMGGEN_IMAGE_GAP;
		blocks.push(imageBlock);
		frames.push({ index: 1, top, height: imageHeight, usedWidth: displayWidth });
		contentHeight = top + imageHeight;
	} else if (hasSource) {
		const imageBlock: PreparedUnknownBlock = {
			...FLAT_BASE,
			kind: "unknown",
			marginTop: IMGGEN_IMAGE_GAP,
			tag: "image-unknown",
			placeholderHeight: IMGGEN_UNKNOWN_IMAGE_HEIGHT,
			data: {
				result: data.result ?? null,
				savedPath: data.savedPath ?? null,
				partialSavedPath: data.partialSavedPath ?? null,
			},
		};
		const top = headerHeight + IMGGEN_IMAGE_GAP;
		blocks.push(imageBlock);
		frames.push({ index: 1, top, height: IMGGEN_UNKNOWN_IMAGE_HEIGHT, usedWidth: innerWidth });
		contentHeight = top + IMGGEN_UNKNOWN_IMAGE_HEIGHT;
	}

	const usedWidth = frames.reduce((w, f) => Math.max(w, f.usedWidth), 0);
	const frame: ElementFrame = { blocks: frames, contentHeight, usedWidth };
	const height = IMGGEN_PAPER_PADDING * 2 + IMGGEN_BORDER * 2 + contentHeight;

	return {
		height,
		blocks,
		frame,
		contentWidth: innerWidth,
		usedWidth: Math.min(contentWidth, usedWidth + IMGGEN_PAPER_PADDING * 2),
	};
}

// ── Unified dispatcher ───────────────────────────────────────────────────────
export type MediaBlockType = "image" | "image_generation" | "text_file";

export interface MediaBlockInput
	extends MeasureImageInput,
		MeasureTextFileInput,
		MeasureImageGenerationInput {
	type: MediaBlockType | string;
}

/**
 * Dispatch to the correct media measurer by `block.type`. Unknown types fall
 * back to a zero-height empty element (the caller should not route them here).
 */
export function measureMedia(
	block: MediaBlockInput,
	contentWidth: number,
	lod: RenderLod = 5,
): MeasuredElement {
	switch (block.type) {
		case "image":
			return measureImage(block, contentWidth, lod);
		case "text_file":
			return measureTextFile(block, contentWidth, lod);
		case "image_generation":
			return measureImageGeneration(block, contentWidth, lod);
		default: {
			const frame: ElementFrame = { blocks: [], contentHeight: 0, usedWidth: 0 };
			return { height: 0, blocks: [], frame, contentWidth, usedWidth: 0 };
		}
	}
}

export const MEASURE_MEDIA_CONSTANTS = {
	IMAGE_FIXED_HEIGHT,
	TEXT_FILE_ICON_SIZE,
	TEXT_FILE_PADDING_Y,
	TEXT_FILE_HEIGHT,
	IMGGEN_PAPER_PADDING,
	IMGGEN_BORDER,
	IMGGEN_ICON_SIZE,
	IMGGEN_LOADER_SIZE,
	IMGGEN_GROUP_GAP,
	IMGGEN_IMAGE_GAP,
	IMGGEN_HEADER_LINE_HEIGHT,
	IMGGEN_MAX_DISPLAY_WIDTH,
	IMGGEN_UNKNOWN_IMAGE_HEIGHT,
} as const;
