import {
	type LayoutCursor,
	layoutWithLines,
	measureNaturalWidth,
	prepareWithSegments,
} from "@chenglou/pretext";
import type { DiffLine } from "./diff-core";
import type { ParsedDiffHunk } from "./parse-unified-diff";
import {
	FONT_WEIGHT,
	LINE_HEIGHT,
	MONO_FAMILY,
	scaledFont,
	scaledLineBoxHeight,
} from "./pretext-fonts";
import { letterSpacingPxFor, scaleFontSize } from "./typography";
import { itemIndexAtOffset, type ListLayout, layoutItems } from "./vlist-virtualization";

export interface DiffTypography {
	font: string;
	fontSize: number;
	lineHeight: number;
	letterSpacing: number;
}

/** Shared detail typography. The scroll painter never imports vlist measurement. */
export function diffTypography(): DiffTypography {
	const fontSize = scaleFontSize(11);
	return {
		font: scaledFont(FONT_WEIGHT.regular, 11, MONO_FAMILY),
		fontSize,
		lineHeight: scaledLineBoxHeight(11, LINE_HEIGHT.xs),
		letterSpacing: letterSpacingPxFor(fontSize),
	};
}

export interface DiffVisualLine {
	start: number;
	end: number;
	width: number;
}

export interface DiffRowLayout {
	content: string;
	visualLines: readonly DiffVisualLine[];
	height: number;
	width: number;
}

export interface DiffRowsLayout extends ListLayout {
	rows: readonly DiffRowLayout[];
	hunks: ReadonlyMap<number, ParsedDiffHunk>;
	/** Original sorted Git hunk descriptors, never re-diffed or copied. */
	allHunks: readonly ParsedDiffHunk[];
	startRow: number;
	totalRows: number;
	beforeHeight: number;
	afterHeight: number;
	gutterWidth: number;
	contentWidth: number;
	wordWrap: boolean;
	typography: DiffTypography;
	maxWidth: number;
}

export interface DiffLayoutOptions {
	/** Actual inner width, including the gutter but excluding scroll-box padding. */
	contentWidth: number;
	wordWrap?: boolean;
	lineNoWidth?: number;
	startRow?: number;
	totalRows?: number;
	hunks?: readonly ParsedDiffHunk[];
	typography?: DiffTypography;
}

/** Monospace gutter advance through the same pretext engine used for wrapping. */
export function diffGutterWidth(typography: DiffTypography, lineNoWidth?: number): number {
	const characters = lineNoWidth == null ? 2 : lineNoWidth * 2 + 2;
	return measureNaturalWidth(
		prepareWithSegments("0".repeat(characters), typography.font, {
			whiteSpace: "pre-wrap",
			letterSpacing: typography.letterSpacing,
		}),
	);
}

function layoutRow(
	content: string,
	width: number,
	wrap: boolean,
	type: DiffTypography,
): DiffRowLayout {
	if (!content)
		return {
			content,
			visualLines: [{ start: 0, end: 0, width: 0 }],
			height: type.lineHeight,
			width: 0,
		};
	const prepared = prepareWithSegments(content, type.font, {
		whiteSpace: "pre-wrap",
		letterSpacing: type.letterSpacing,
	});
	if (!wrap) {
		const width = measureNaturalWidth(prepared);
		return {
			content,
			visualLines: [{ start: 0, end: content.length, width }],
			height: type.lineHeight,
			width,
		};
	}
	// pre-wrap retains source segments (including soft hyphens), but line.text
	// omits hidden hyphens and may insert a visible '-'. Only cursors are offsets.
	const segmentOffsets = [0];
	for (const segment of prepared.segments) {
		segmentOffsets.push((segmentOffsets[segmentOffsets.length - 1] ?? 0) + segment.length);
	}
	// pretext normalizes CRLF to LF even in pre-wrap. Keep source UTF-16 offsets.
	const sourceOffsets: number[] | undefined = content.includes("\r\n") ? [0] : undefined;
	if (sourceOffsets) {
		for (let source = 0; source < content.length; ) {
			source += content[source] === "\r" && content[source + 1] === "\n" ? 2 : 1;
			sourceOffsets.push(source);
		}
	}
	const graphemeOffsets = new Map<number, number[]>();
	let segmenter: Intl.Segmenter | undefined;
	const sourceOffset = ({ segmentIndex, graphemeIndex }: LayoutCursor): number => {
		let offset = segmentOffsets[segmentIndex] ?? 0;
		if (graphemeIndex > 0) {
			let offsets = graphemeOffsets.get(segmentIndex);
			if (!offsets) {
				segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
				const segment = prepared.segments[segmentIndex] ?? "";
				offsets = Array.from(segmenter.segment(segment), (part) => part.index);
				offsets.push(segment.length);
				graphemeOffsets.set(segmentIndex, offsets);
			}
			offset += offsets[graphemeIndex] ?? 0;
		}
		return sourceOffsets ? (sourceOffsets[offset] ?? 0) : offset;
	};
	const consumedEndOffset = (cursor: LayoutCursor): number => {
		let { segmentIndex } = cursor;
		// Mirrors pretext's normalizeLineStartSegmentIndex: these segments are
		// consumed before the next painted line, even if no next line is emitted.
		// In pre-wrap, real spaces are 'preserved-space', so they are NOT skipped.
		if (cursor.graphemeIndex === 0) {
			while (
				prepared.kinds[segmentIndex] === "soft-hyphen" ||
				prepared.kinds[segmentIndex] === "zero-width-break" ||
				prepared.kinds[segmentIndex] === "space"
			) {
				segmentIndex++;
			}
		}
		return sourceOffset({ segmentIndex, graphemeIndex: cursor.graphemeIndex });
	};
	let offset = 0;
	let maxWidth = 0;
	const visualLines = layoutWithLines(prepared, width, type.lineHeight).lines.map((line) => {
		// A normalized start can skip leading invisible segments. Assign those to
		// this slice too, so every source code unit has exactly one visual owner.
		const start = offset;
		offset = consumedEndOffset(line.end);
		maxWidth = Math.max(maxWidth, line.width);
		return { start, end: offset, width: line.width };
	});
	// An all-discretionary row has no painted lines, but still owns source text.
	if (!visualLines.length) {
		visualLines.push({
			start: 0,
			end: consumedEndOffset({ segmentIndex: 0, graphemeIndex: 0 }),
			width: 0,
		});
	}
	return {
		content,
		visualLines,
		height: Math.max(1, visualLines.length) * type.lineHeight,
		width: maxWidth,
	};
}

/**
 * Exact only inside this instance's bounded projection; outside it, one line box
 * per source row provides a scrollable coordinate system. Moving the projection
 * replaces these estimates, then the caller corrects its own source anchor.
 * Only the immediately preceding projection is consulted for layout reuse.
 */
export function layoutDiffRows(
	lines: readonly DiffLine[],
	options: DiffLayoutOptions,
	previous?: DiffRowsLayout,
): DiffRowsLayout {
	const typography = options.typography ?? diffTypography();
	const wordWrap = options.wordWrap ?? false;
	const startRow = options.startRow ?? 0;
	const totalRows = options.totalRows ?? lines.length;
	const gutterWidth = diffGutterWidth(typography, options.lineNoWidth);
	const contentWidth = Math.max(1, options.contentWidth);
	const width = Math.max(1, contentWidth - gutterWidth);
	const canReuse =
		previous?.contentWidth === contentWidth &&
		previous.wordWrap === wordWrap &&
		previous.gutterWidth === gutterWidth &&
		previous.typography.font === typography.font &&
		previous.typography.lineHeight === typography.lineHeight &&
		previous.typography.letterSpacing === typography.letterSpacing;
	const reusable = new Map(canReuse ? previous.rows.map((row) => [row.content, row]) : []);
	const rows = lines.map(
		(line) => reusable.get(line.content) ?? layoutRow(line.content, width, wordWrap, typography),
	);
	const hunks = new Map<number, ParsedDiffHunk>();
	let beforeHeight = startRow * typography.lineHeight;
	let afterHeight = Math.max(0, totalRows - startRow - lines.length) * typography.lineHeight;
	const hunkHeight = typography.lineHeight + 2;
	for (const hunk of options.hunks ?? []) {
		if (hunk.rowIndex < startRow) beforeHeight += hunkHeight;
		else if (hunk.rowIndex >= startRow + lines.length) afterHeight += hunkHeight;
		else hunks.set(hunk.rowIndex - startRow, hunk);
	}
	const layout = layoutItems(
		rows.map((row, index) => row.height + (hunks.has(index) ? hunkHeight : 0)),
		0,
		beforeHeight,
		afterHeight,
	);
	return {
		...layout,
		rows,
		hunks,
		allHunks: options.hunks ?? [],
		startRow,
		totalRows,
		beforeHeight,
		afterHeight,
		gutterWidth,
		contentWidth,
		wordWrap,
		typography,
		maxWidth: Math.max(contentWidth, ...rows.map((row) => row.width + gutterWidth)),
	};
}

export function diffRowBodyTop(layout: DiffRowsLayout, index: number): number {
	return (
		(layout.items[index]?.top ?? 0) +
		(layout.hunks.has(index) ? layout.typography.lineHeight + 2 : 0)
	);
}

/** Source column -> visual line; the end of a growing line belongs to its last wrap. */
export function diffVisualLineAtColumn(row: DiffRowLayout, column: number): number {
	const offset = Math.max(0, Math.min(column, row.content.length));
	const found = row.visualLines.findIndex((line) => offset < line.end);
	return found < 0 ? Math.max(0, row.visualLines.length - 1) : found;
}

export function diffRowTarget(
	layout: DiffRowsLayout,
	index: number,
	column: number,
): { top: number; bottom: number } | null {
	const row = layout.rows[index];
	if (!row) return null;
	const top =
		diffRowBodyTop(layout, index) +
		diffVisualLineAtColumn(row, column) * layout.typography.lineHeight;
	return { top, bottom: top + layout.typography.lineHeight };
}

/** Read anchors contain source columns, not a brittle visual-row index. */
export function diffPositionAtOffset(
	layout: DiffRowsLayout,
	top: number,
): { index: number; column: number; pixelOffset: number } | null {
	if (!layout.rows.length) return null;
	const index = itemIndexAtOffset(layout.items, top);
	const row = layout.rows[index];
	if (!row) return null;
	const bodyTop = diffRowBodyTop(layout, index);
	const visual = Math.max(
		0,
		Math.min(
			row.visualLines.length - 1,
			Math.floor((top - bodyTop) / layout.typography.lineHeight),
		),
	);
	return {
		index,
		column: row.visualLines[visual]?.start ?? 0,
		pixelOffset: top - bodyTop - visual * layout.typography.lineHeight,
	};
}

function hunkCountBefore(layout: DiffRowsLayout, row: number): number {
	let low = 0;
	let high = layout.allHunks.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((layout.allHunks[mid]?.rowIndex ?? 0) < row) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** Estimated outside this projection; Git's known hunk bands remain exact. */
export function estimatedDiffRowTop(layout: DiffRowsLayout, row: number, body = false): number {
	const local = row - layout.startRow;
	if (local >= 0 && local < layout.rows.length)
		return body ? diffRowBodyTop(layout, local) : (layout.items[local]?.top ?? 0);
	const estimate = (at: number) =>
		at * layout.typography.lineHeight +
		hunkCountBefore(layout, at) * (layout.typography.lineHeight + 2);
	const end = layout.startRow + layout.rows.length;
	const last = layout.items[layout.items.length - 1];
	const correction = row >= end && last ? last.bottom - estimate(end) : 0;
	return (
		estimate(row) +
		correction +
		(body && layout.allHunks[hunkCountBefore(layout, row)]?.rowIndex === row
			? layout.typography.lineHeight + 2
			: 0)
	);
}

/** Binary queries only: scrolling never measures rows or computes source diffs. */
export function diffRowAtOffset(layout: DiffRowsLayout, top: number): number {
	const last = layout.items[layout.items.length - 1];
	if (top >= layout.beforeHeight && last && top < last.bottom)
		return layout.startRow + itemIndexAtOffset(layout.items, top);
	let low = 0;
	let high = layout.totalRows;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (estimatedDiffRowTop(layout, mid + 1) > top) high = mid;
		else low = mid + 1;
	}
	return Math.max(0, Math.min(layout.totalRows - 1, low));
}

/** Slice colour/word partitions without changing source bytes across soft wraps. */
export function sliceDiffFragments<T extends { content?: string; value?: string }>(
	parts: readonly T[] | null | undefined,
	start: number,
	end: number,
): T[] | undefined {
	if (!parts) return undefined;
	let offset = 0;
	const output: T[] = [];
	for (const part of parts) {
		const text = part.content ?? part.value ?? "";
		const from = Math.max(0, start - offset);
		const to = Math.min(text.length, end - offset);
		if (to > from)
			output.push({
				...part,
				...(part.content == null
					? { value: text.slice(from, to) }
					: { content: text.slice(from, to) }),
			});
		offset += text.length;
		if (offset >= end) break;
	}
	return output;
}
