import {
	type LayoutLine,
	layoutWithLines,
	measureNaturalWidth,
	prepareWithSegments,
} from "@chenglou/pretext";
import { type MdBlock, type MdInlineToken, parseMarkdownBlocks } from "./pixi-markdown";
import {
	PIXI_MESSAGE_FONT,
	PIXI_MESSAGE_METRICS,
	type PixiMessageHeadingLevel,
	pixiCssFont,
} from "./pixi-message-constants";
import type {
	PixiMessageItem,
	PixiPermissionActionModel,
	PixiToolBadgeModel,
	PixiToolDetailBlockModel,
	PixiToolDetailLineModel,
} from "./pixi-message-model";

export interface PixiLaidOutMarkdownBlock {
	kind: MdBlock["kind"];
	text: string;
	lines: LayoutLine[];
	x: number;
	y: number;
	width: number;
	height: number;
	font: string;
	lineHeight: number;
	level?: number;
	lang?: string;
	inlineTokens?: MdInlineToken[];
	ordered?: boolean;
	index?: number;
	depth?: number;
	checked?: boolean;
	table?: { headers: string[]; rows: string[][]; columnWidths: number[] };
}

export interface PixiLaidOutToolDetailLine extends PixiToolDetailLineModel {
	x: number;
	y: number;
	width: number;
	height: number;
	lines: LayoutLine[];
}

export interface PixiLaidOutToolBadge extends PixiToolBadgeModel {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PixiLaidOutPermissionAction extends PixiPermissionActionModel {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PixiLaidOutToolDetailBlock {
	kind: PixiToolDetailBlockModel["kind"];
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
	title?: string;
	subtitle?: string;
	color?: string;
	muted?: boolean;
	mono?: boolean;
	permissionId?: string;
	permissionToolName?: string;
	permissionReason?: string;
	permissionSummary?: string;
	permissionPlanLineCount?: number;
	permissionActions?: PixiLaidOutPermissionAction[];
	badges?: PixiLaidOutToolBadge[];
	lines?: LayoutLine[];
	diffLines?: Array<{
		type: "removed" | "added" | "context";
		text: string;
		oldNo?: number;
		newNo?: number;
		lines: LayoutLine[];
	}>;
	lineNumberPrefix?: string;
	oldLines?: LayoutLine[];
	newLines?: LayoutLine[];
	filename?: string;
	note?: string;
	status?: string;
	lang?: string;
}

export interface PixiLaidOutBlock {
	type: string;
	label?: string;
	color?: string;
	text: string;
	lines: LayoutLine[];
	x: number;
	y: number;
	width: number;
	height: number;
	separatorBefore?: boolean;
	mdBlocks?: PixiLaidOutMarkdownBlock[];
	toolName?: string;
	toolKey?: string;
	toolCallId?: string;
	toolUseId?: string;
	pendingPermissionId?: string;
	pendingPermissionToolName?: string;
	pendingPermissionReason?: string;
	toolCategory?: PixiMessageItem["blocks"][number]["toolCategory"];
	toolSummary?: string;
	toolStatus?: string;
	toolDuration?: string;
	toolStatusColor?: string;
	toolCategoryColor?: string;
	toolIsSubagent?: boolean;
	toolChildCount?: number;
	toolInRun?: boolean;
	toolIsLast?: boolean;
	toolDefaultOpen?: boolean;
	toolExpanded?: boolean;
	toolToggleKey?: string;
	reasoningKey?: string;
	reasoningExpanded?: boolean;
	reasoningToggleKey?: string;
	reasoningCharCount?: number;
	reasoningEncrypted?: boolean;
	reasoningStreaming?: boolean;
	reasoningLabel?: string;
	reasoningCharsLabel?: string;
	reasoningThinkingLabel?: string;
	messageId?: string;
	messageUuid?: string | null;
	blockIndex?: number;
	copyText?: string;
	imageSrc?: string;
	imageId?: string;
	imageUploadNarratorId?: string;
	imageFilename?: string;
	imageMediaType?: string;
	imageSavedPath?: string;
	imageAlt?: string;
	imageStatus?: string;
	toolHeader?: { x: number; y: number; width: number; height: number };
	toolDetailLines?: PixiLaidOutToolDetailLine[];
	toolDetailBlocks?: PixiLaidOutToolDetailBlock[];
}

export interface PixiLaidOutItem {
	item: PixiMessageItem;
	index: number;
	x: number;
	y: number;
	width: number;
	height: number;
	contentWidth: number;
	blocks: PixiLaidOutBlock[];
}

export interface PixiMessageLayoutResult {
	items: PixiLaidOutItem[];
	totalHeight: number;
}

const GAP = 12;
const PADDING_X = 16;
const PADDING_Y = 12;
const USER_PADDING_X = 12;
const USER_PADDING_Y = 12;
const BLOCK_GAP = 8;
const USER_HEADER_H = 20;
const USER_HEADER_CONTENT_GAP = 4;
const HEADER_H = 20;
const TOKEN_H = 18;
const TOOL_SEPARATOR_H = 1;
const TOOL_CARD_PADDING = 8;
const TOOL_HEADER_H = 18;
const TOOL_DETAIL_LINE_H = 18;
const TOOL_DETAIL_GAP = 10;
const MIN_ITEM_H = 34;
const FONT = pixiCssFont(PIXI_MESSAGE_FONT.sizes.body, PIXI_MESSAGE_FONT.sansFamily);
const BODY_STRONG_FONT = pixiCssFont(
	PIXI_MESSAGE_FONT.sizes.body,
	PIXI_MESSAGE_FONT.sansFamily,
	PIXI_MESSAGE_FONT.weights.bold,
);
const BODY_EM_FONT = `italic ${PIXI_MESSAGE_FONT.sizes.body}px ${PIXI_MESSAGE_FONT.sansFamily}`;
const SMALL_FONT = pixiCssFont(PIXI_MESSAGE_FONT.sizes.small, PIXI_MESSAGE_FONT.sansFamily);
const CODE_FONT = pixiCssFont(PIXI_MESSAGE_FONT.sizes.code, PIXI_MESSAGE_FONT.monoFamily);
const INLINE_CODE_PADDING_X = 4;
const HEADING_FONTS: Record<PixiMessageHeadingLevel, string> = {
	1: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[1],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
	2: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[2],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
	3: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[3],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
	4: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[4],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
	5: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[5],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
	6: pixiCssFont(
		PIXI_MESSAGE_FONT.headingSizes[6],
		PIXI_MESSAGE_FONT.sansFamily,
		PIXI_MESSAGE_FONT.weights.bold,
	),
};
const HEADING_LINE_HEIGHTS: Record<1 | 2 | 3 | 4 | 5 | 6, number> = {
	1: 30,
	2: 26,
	3: 24,
	4: 22,
	5: 22,
	6: 22,
};
const LINE_H = 20;
const CODE_LINE_H = PIXI_MESSAGE_METRICS.codeLineHeight;
const SMALL_LINE_H = 17;
const CODE_PADDING_X = PIXI_MESSAGE_METRICS.codePaddingX;
const CODE_PADDING_Y = PIXI_MESSAGE_METRICS.codePaddingY;
const BLOCKQUOTE_INDENT = PIXI_MESSAGE_METRICS.blockquoteIndent;
const LIST_INDENT = PIXI_MESSAGE_METRICS.listIndent;
const LIST_DEPTH_INDENT = 16;
const TABLE_ROW_H = 26;
const TABLE_MAX_ROWS = 12;
const MAX_BLOCK_LINES = 120;

const preparedCache = new Map<string, ReturnType<typeof prepareWithSegments>>();
const itemLayoutCache = new Map<string, CachedItemLayout>();
const MAX_CACHE = 1200;
const MAX_ITEM_LAYOUT_CACHE = 800;

type CachedItemLayout = Pick<PixiLaidOutItem, "width" | "height" | "contentWidth" | "blocks">;

function getPrepared(text: string, font: string) {
	const key = `${font}\u0000${text}`;
	const cached = preparedCache.get(key);
	if (cached) {
		preparedCache.delete(key);
		preparedCache.set(key, cached);
		return cached;
	}
	const prepared = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
	preparedCache.set(key, prepared);
	if (preparedCache.size > MAX_CACHE) {
		const first = preparedCache.keys().next().value;
		if (first !== undefined) preparedCache.delete(first);
	}
	return prepared;
}

function getCachedItemLayout(key: string): CachedItemLayout | undefined {
	const cached = itemLayoutCache.get(key);
	if (!cached) return undefined;
	itemLayoutCache.delete(key);
	itemLayoutCache.set(key, cached);
	return cached;
}

function setCachedItemLayout(key: string, layout: CachedItemLayout): void {
	itemLayoutCache.set(key, layout);
	if (itemLayoutCache.size > MAX_ITEM_LAYOUT_CACHE) {
		const first = itemLayoutCache.keys().next().value;
		if (first !== undefined) itemLayoutCache.delete(first);
	}
}

function itemLayoutCacheKey(item: PixiMessageItem, itemWidth: number): string {
	return `${itemWidth}\u0000${JSON.stringify(item)}`;
}

function layoutText(text: string, width: number, font = FONT, lineHeight = LINE_H) {
	const prepared = getPrepared(text || " ", font);
	const result = layoutWithLines(prepared, Math.max(24, width), lineHeight);
	if (result.lines.length > MAX_BLOCK_LINES) {
		return {
			...result,
			lines: [
				...result.lines.slice(0, MAX_BLOCK_LINES),
				{ ...result.lines[MAX_BLOCK_LINES - 1], text: "…" },
			],
			height: (MAX_BLOCK_LINES + 1) * lineHeight,
		};
	}
	return result;
}

function hasStyledInlineTokens(tokens: MdInlineToken[] | undefined): boolean {
	return !!tokens?.some((token) => token.kind !== "text");
}

function inlineCodeFontForBaseFont(baseFont: string): string {
	if (baseFont === FONT) return CODE_FONT;
	const baseSize = Number.parseInt(baseFont.match(/(\d+)px/)?.[1] ?? "0", 10);
	if (!baseSize) return CODE_FONT;
	return pixiCssFont(
		Math.max(PIXI_MESSAGE_FONT.sizes.code, baseSize - 2),
		PIXI_MESSAGE_FONT.monoFamily,
	);
}

function fontForInlineToken(token: MdInlineToken, baseFont: string): string {
	if (token.kind === "code") return inlineCodeFontForBaseFont(baseFont);
	if (baseFont === FONT && token.kind === "strong") return BODY_STRONG_FONT;
	if (baseFont === FONT && token.kind === "em") return BODY_EM_FONT;
	return baseFont;
}

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
	if (measureCtx) return measureCtx;
	if (typeof document === "undefined") return null;
	const canvas = document.createElement("canvas");
	measureCtx = canvas.getContext("2d");
	return measureCtx;
}

function measureCanvasTextWidth(text: string, font: string): number {
	const ctx = getMeasureCtx();
	if (!ctx) return measureNaturalWidth(getPrepared(text || " ", font));
	ctx.font = font;
	return ctx.measureText(text).width;
}

function shouldMeasureInlineWithCanvas(font: string): boolean {
	return font !== FONT;
}

function measureInlineText(text: string, font: string): number {
	if (shouldMeasureInlineWithCanvas(font)) return measureCanvasTextWidth(text, font);
	return measureNaturalWidth(getPrepared(text || " ", font));
}

function makeInlineLine(text: string, width: number): LayoutLine {
	return {
		text,
		width,
		start: { segmentIndex: 0, graphemeIndex: 0 },
		end: { segmentIndex: 0, graphemeIndex: text.length },
	};
}

function layoutInlineText(
	text: string,
	tokens: MdInlineToken[] | undefined,
	width: number,
	baseFont = FONT,
	lineHeight = LINE_H,
) {
	if (!hasStyledInlineTokens(tokens)) return layoutText(text, width, baseFont, lineHeight);

	const maxWidth = Math.max(24, width);
	const lines: LayoutLine[] = [];
	let line = "";
	let lineWidth = 0;
	let truncated = false;

	const pushLine = () => {
		if (lines.length >= MAX_BLOCK_LINES) {
			truncated = true;
			return;
		}
		lines.push(makeInlineLine(line || " ", lineWidth));
		line = "";
		lineWidth = 0;
	};

	for (const token of tokens ?? [{ kind: "text" as const, text }]) {
		const font = fontForInlineToken(token, baseFont);
		const isCode = token.kind === "code";
		let codeRunOpen = false;
		const openCodeRun = () => {
			if (!isCode || codeRunOpen) return;
			if (line && lineWidth + INLINE_CODE_PADDING_X > maxWidth) pushLine();
			lineWidth += INLINE_CODE_PADDING_X;
			codeRunOpen = true;
		};
		const closeCodeRun = () => {
			if (!isCode || !codeRunOpen) return;
			lineWidth += INLINE_CODE_PADDING_X;
			codeRunOpen = false;
		};
		for (const char of Array.from(token.text)) {
			if (truncated) break;
			if (char === "\n") {
				closeCodeRun();
				pushLine();
				continue;
			}
			openCodeRun();
			const charWidth = measureInlineText(char, font);
			if (line && lineWidth + charWidth + (isCode ? INLINE_CODE_PADDING_X : 0) > maxWidth) {
				if (isCode) codeRunOpen = false;
				pushLine();
				openCodeRun();
			}
			line += char;
			lineWidth += charWidth;
		}
		closeCodeRun();
		if (truncated) break;
	}
	if (!truncated && (line || lines.length === 0)) pushLine();
	if (truncated && lines.length > 0) {
		const last = lines[lines.length - 1];
		lines[lines.length - 1] = makeInlineLine("…", Math.min(last.width, maxWidth));
	}

	return {
		lineCount: lines.length,
		height: Math.max(lineHeight, lines.length * lineHeight),
		lines,
	};
}

function capLines(lines: LayoutLine[], max: number): LayoutLine[] {
	if (lines.length <= max) return lines;
	const capped = lines.slice(0, max);
	capped[capped.length - 1] = { ...capped[capped.length - 1], text: "…" };
	return capped;
}

function ellipsizeLineToWidth(text: string, width: number): LayoutLine {
	const source = text || " ";
	const sourceWidth = measureInlineText(source, CODE_FONT);
	if (sourceWidth <= width) return makeInlineLine(source, sourceWidth);

	const ellipsis = "…";
	const ellipsisWidth = measureInlineText(ellipsis, CODE_FONT);
	if (ellipsisWidth >= width) return makeInlineLine(ellipsis, Math.min(ellipsisWidth, width));

	const chars = Array.from(source);
	let low = 0;
	let high = chars.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = `${chars.slice(0, mid).join("")}${ellipsis}`;
		if (measureInlineText(candidate, CODE_FONT) <= width) low = mid;
		else high = mid - 1;
	}

	const textValue = `${chars.slice(0, low).join("")}${ellipsis}`;
	return makeInlineLine(textValue, Math.min(width, measureInlineText(textValue, CODE_FONT)));
}

function layoutPhysicalCodeLines(text: string, width: number, maxLines: number): LayoutLine[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.slice(0, maxLines)
		.map((line) => ellipsizeLineToWidth(line, width));
}

function layoutSpecialBlock(
	block: PixiMessageItem["blocks"][number],
	text: string,
	width: number,
): { lines: LayoutLine[]; height: number } | null {
	switch (block.type) {
		case "reasoning":
		case "thinking": {
			if (block.reasoningStreaming && !text.trim()) return { lines: [], height: 22 };
			const result = layoutText(text, Math.max(24, width - 24), SMALL_FONT, SMALL_LINE_H);
			if (!block.reasoningExpanded) return { lines: capLines(result.lines, 1), height: 22 };
			const lines = capLines(result.lines, MAX_BLOCK_LINES);
			return { lines, height: Math.max(48, 30 + lines.length * SMALL_LINE_H) };
		}
		case "web_search":
			return { lines: [], height: 28 };
		case "image":
		case "image_generation":
			return { lines: [], height: 200 };
		case "compact":
		case "segment_compact":
			return { lines: [], height: 28 };
		case "error": {
			const result = layoutText(text, Math.max(24, width - 20), FONT, LINE_H);
			const lines = capLines(result.lines, 8);
			return { lines, height: Math.max(32, lines.length * LINE_H + 16) };
		}
		case "info":
		case "tool_loaded":
		case "tool_unloaded": {
			const result = layoutText(text, Math.max(24, width - 20), SMALL_FONT, SMALL_LINE_H);
			const lines = capLines(result.lines, 8);
			return { lines, height: Math.max(28, lines.length * LINE_H + 12) };
		}
		case "plan": {
			const result = layoutText(text, Math.max(24, width - 20), FONT, LINE_H);
			const lines = capLines(result.lines, 10);
			return { lines, height: Math.max(58, 40 + lines.length * LINE_H) };
		}
		case "merge_summary":
		case "review_feedback":
			return { lines: [], height: 30 };
		case "goal_continuation":
			return { lines: [], height: 28 };
		default:
			return null;
	}
}

function headingFont(level: number): string {
	return HEADING_FONTS[Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6];
}

function headingLineHeight(level: number): number {
	return HEADING_LINE_HEIGHTS[Math.min(6, Math.max(1, level)) as 1 | 2 | 3 | 4 | 5 | 6];
}

function markdownGapAfter(kind: MdBlock["kind"]): number {
	switch (kind) {
		case "empty":
			return 0;
		case "heading":
			return 6;
		case "code":
			return 8;
		case "hr":
			return 4;
		case "table":
			return 10;
		default:
			return 4;
	}
}

function layoutMarkdownBlocks(markdown: string, width: number) {
	const parsed = parseMarkdownBlocks(markdown);
	const mdBlocks: PixiLaidOutMarkdownBlock[] = [];
	let y = 0;
	let lastGap = 0;

	for (const block of parsed) {
		const add = (mdBlock: PixiLaidOutMarkdownBlock) => {
			lastGap = markdownGapAfter(block.kind);
			mdBlocks.push(mdBlock);
			y += mdBlock.height + lastGap;
		};

		switch (block.kind) {
			case "heading": {
				const font = headingFont(block.level);
				const lineHeight = headingLineHeight(block.level);
				const result = layoutInlineText(block.text, block.inlineTokens, width, font, lineHeight);
				add({
					kind: block.kind,
					text: block.text,
					lines: result.lines,
					x: 0,
					y,
					width,
					height: Math.max(lineHeight, result.height),
					font,
					lineHeight,
					level: block.level,
					inlineTokens: block.inlineTokens,
				});
				break;
			}
			case "paragraph": {
				const result = layoutInlineText(block.text, block.inlineTokens, width, FONT, LINE_H);
				add({
					kind: block.kind,
					text: block.text,
					lines: result.lines,
					x: 0,
					y,
					width,
					height: Math.max(LINE_H, result.height),
					font: FONT,
					lineHeight: LINE_H,
					inlineTokens: block.inlineTokens,
				});
				break;
			}
			case "code": {
				const textWidth = Math.max(24, width - CODE_PADDING_X * 2);
				const result = layoutText(block.text || " ", textWidth, CODE_FONT, CODE_LINE_H);
				add({
					kind: block.kind,
					text: block.text,
					lines: result.lines,
					x: 0,
					y,
					width,
					height: Math.max(CODE_LINE_H, result.height) + CODE_PADDING_Y * 2,
					font: CODE_FONT,
					lineHeight: CODE_LINE_H,
					lang: block.lang,
				});
				break;
			}
			case "blockquote": {
				const textWidth = Math.max(24, width - BLOCKQUOTE_INDENT);
				const result = layoutInlineText(block.text, block.inlineTokens, textWidth, FONT, LINE_H);
				add({
					kind: block.kind,
					text: block.text,
					lines: result.lines,
					x: 0,
					y,
					width,
					height: Math.max(LINE_H, result.height),
					font: FONT,
					lineHeight: LINE_H,
					inlineTokens: block.inlineTokens,
				});
				break;
			}
			case "list-item": {
				const nestedX = Math.min(width - 80, block.depth * LIST_DEPTH_INDENT);
				const textWidth = Math.max(24, width - nestedX - LIST_INDENT);
				const result = layoutInlineText(block.text, block.inlineTokens, textWidth, FONT, LINE_H);
				add({
					kind: block.kind,
					text: block.text,
					lines: result.lines,
					x: nestedX,
					y,
					width: width - nestedX,
					height: Math.max(LINE_H, result.height),
					font: FONT,
					lineHeight: LINE_H,
					inlineTokens: block.inlineTokens,
					ordered: block.ordered,
					index: block.index,
					depth: block.depth,
					checked: block.checked,
				});
				break;
			}
			case "table": {
				const columnCount = Math.max(1, block.headers.length);
				const columnWidth = Math.floor(width / columnCount);
				const columnWidths = Array.from({ length: columnCount }, (_, index) =>
					index === columnCount - 1 ? width - columnWidth * (columnCount - 1) : columnWidth,
				);
				const rows = block.rows.slice(0, TABLE_MAX_ROWS);
				add({
					kind: block.kind,
					text: "",
					lines: [],
					x: 0,
					y,
					width,
					height: (1 + rows.length) * TABLE_ROW_H + 1,
					font: SMALL_FONT,
					lineHeight: SMALL_LINE_H,
					table: { headers: block.headers, rows, columnWidths },
				});
				break;
			}
			case "hr":
				add({
					kind: block.kind,
					text: "",
					lines: [],
					x: 0,
					y,
					width,
					height: 17,
					font: FONT,
					lineHeight: LINE_H,
				});
				break;
			case "empty":
				add({
					kind: block.kind,
					text: "",
					lines: [],
					x: 0,
					y,
					width,
					height: 8,
					font: FONT,
					lineHeight: LINE_H,
				});
				break;
		}
	}

	return {
		mdBlocks,
		height: Math.max(LINE_H, mdBlocks.length > 0 ? y - lastGap : LINE_H),
	};
}

const BADGE_HEIGHT = 16;
const BADGE_GAP = 4;
const BADGE_MIN_WIDTH = 24;
const BADGE_TEXT_PADDING_X = 7;
const BADGE_DOT_LEFT = 14;
const BADGE_DOT_RIGHT_PADDING = 7;

function measureBadge(badge: PixiToolBadgeModel): number {
	const horizontalPadding =
		badge.variant === "dot" ? BADGE_DOT_LEFT + BADGE_DOT_RIGHT_PADDING : BADGE_TEXT_PADDING_X * 2;
	return Math.max(
		BADGE_MIN_WIDTH,
		Math.ceil(measureInlineText(badge.text || " ", SMALL_FONT) + horizontalPadding),
	);
}

function layoutBadges(
	badges: PixiToolBadgeModel[],
	width: number,
	startY: number,
): PixiLaidOutToolBadge[] {
	const laid: PixiLaidOutToolBadge[] = [];
	let x = TOOL_CARD_PADDING;
	let y = startY;
	for (const badge of badges) {
		const badgeWidth = Math.min(width - TOOL_CARD_PADDING * 2, measureBadge(badge));
		if (x > TOOL_CARD_PADDING && x + badgeWidth > width - TOOL_CARD_PADDING) {
			x = TOOL_CARD_PADDING;
			y += BADGE_HEIGHT + BADGE_GAP;
		}
		laid.push({ ...badge, x, y, width: badgeWidth, height: BADGE_HEIGHT });
		x += badgeWidth + BADGE_GAP;
	}
	return laid;
}

function layoutPermissionActions(
	actions: PixiPermissionActionModel[],
	contentWidth: number,
	startY: number,
): PixiLaidOutPermissionAction[] {
	const laid: PixiLaidOutPermissionAction[] = [];
	let x = TOOL_CARD_PADDING;
	let y = startY;
	for (const action of actions) {
		const width = Math.min(contentWidth, Math.max(62, action.label.length * 7 + 24));
		if (x > TOOL_CARD_PADDING && x + width > TOOL_CARD_PADDING + contentWidth) {
			x = TOOL_CARD_PADDING;
			y += 28;
		}
		laid.push({ ...action, x, y, width, height: 24 });
		x += width + 6;
	}
	return laid;
}

function layoutToolDetailBlocks(
	blocks: PixiToolDetailBlockModel[],
	innerWidth: number,
	startY: number,
): { blocks: PixiLaidOutToolDetailBlock[]; height: number } {
	const laid: PixiLaidOutToolDetailBlock[] = [];
	let y = startY;
	const contentWidth = Math.max(80, innerWidth - TOOL_CARD_PADDING * 2);
	for (const detail of blocks) {
		if (detail.kind === "badge-row") {
			const badges = layoutBadges(detail.badges, innerWidth, y);
			const height = badges.length > 0 ? Math.max(...badges.map((b) => b.y + b.height - y)) : 16;
			laid.push({
				kind: "badge-row",
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				badges,
			});
			y += height + 5;
			continue;
		}
		if (detail.kind === "section-title") {
			laid.push({
				kind: "section-title",
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height: 17,
				text: detail.text,
			});
			y += 19;
			continue;
		}
		if (detail.kind === "text-line") {
			const result = layoutText(
				detail.text,
				contentWidth,
				detail.mono ? CODE_FONT : SMALL_FONT,
				SMALL_LINE_H,
			);
			const height = Math.max(17, Math.min(result.height, SMALL_LINE_H * 2));
			laid.push({
				...detail,
				kind: "text-line",
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				lines: result.lines.slice(0, 2),
			});
			y += height + 3;
			continue;
		}
		if (detail.kind === "permission-panel") {
			const reasonText = detail.decisionReason || detail.summary || "Awaiting permission";
			const reasonLines = layoutText(
				reasonText,
				contentWidth - 16,
				SMALL_FONT,
				SMALL_LINE_H,
			).lines.slice(0, 2);
			const planText = detail.planPreview?.trim() ?? "";
			const planLines = planText
				? layoutText(
						planText,
						contentWidth - CODE_PADDING_X * 2,
						CODE_FONT,
						CODE_LINE_H,
					).lines.slice(0, 6)
				: [];
			const planHeight = planLines.length
				? CODE_PADDING_Y * 2 + Math.max(CODE_LINE_H, planLines.length * CODE_LINE_H) + 8
				: 0;
			const actionsY = y + 34 + reasonLines.length * SMALL_LINE_H + planHeight;
			const actions = layoutPermissionActions(detail.actions, contentWidth - 16, actionsY);
			const actionsHeight = actions.length
				? Math.max(...actions.map((action) => action.y + action.height - actionsY))
				: 18;
			const height = 42 + reasonLines.length * SMALL_LINE_H + planHeight + actionsHeight;
			laid.push({
				kind: "permission-panel",
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				permissionId: detail.permissionId,
				permissionToolName: detail.toolName,
				permissionReason: detail.decisionReason,
				permissionSummary: detail.summary,
				permissionPlanLineCount: planLines.length,
				text: planText,
				lines: [...reasonLines, ...planLines],
				permissionActions: actions,
			});
			y += height + 6;
			continue;
		}
		if (detail.kind === "code-panel" || detail.kind === "terminal-panel") {
			const maxLines = detail.maxLines ?? 8;
			const panelTextWidth = Math.max(24, contentWidth - CODE_PADDING_X * 2);
			const lines =
				detail.lang === "grep-output"
					? layoutPhysicalCodeLines(detail.text, panelTextWidth, maxLines)
					: layoutText(detail.text, panelTextWidth, CODE_FONT, CODE_LINE_H).lines.slice(
							0,
							maxLines,
						);
			const height = CODE_PADDING_Y * 2 + Math.max(CODE_LINE_H, lines.length * CODE_LINE_H);
			laid.push({
				...detail,
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				lines,
			});
			y += height + 6;
			continue;
		}
		if (detail.kind === "diff-panel") {
			const maxLines = detail.maxLines ?? 8;
			const oldRaw = detail.oldText.split(/\r?\n/);
			const newRaw = detail.newText.split(/\r?\n/);
			const diffLines: NonNullable<PixiLaidOutToolDetailBlock["diffLines"]> = [];
			const shared = Math.min(oldRaw.length, newRaw.length);
			const diffTextWidth = Math.max(60, contentWidth - CODE_PADDING_X * 2 - 54);
			let oldNo = detail.startLine ?? 1;
			let newNo = detail.startLine ?? 1;
			const pushDiff = (
				type: "removed" | "added" | "context",
				text: string,
				oldLineNo?: number,
				newLineNo?: number,
			) => {
				const result = layoutText(text || " ", diffTextWidth, CODE_FONT, CODE_LINE_H);
				diffLines.push({
					type,
					text,
					oldNo: oldLineNo,
					newNo: newLineNo,
					lines: result.lines.slice(0, 2),
				});
			};
			for (let i = 0; i < shared && diffLines.length < maxLines; i++) {
				if (oldRaw[i] === newRaw[i]) {
					pushDiff("context", oldRaw[i], oldNo++, newNo++);
				} else {
					pushDiff("removed", oldRaw[i], oldNo++);
					if (diffLines.length < maxLines) pushDiff("added", newRaw[i], undefined, newNo++);
				}
			}
			for (let i = shared; i < oldRaw.length && diffLines.length < maxLines; i++) {
				pushDiff("removed", oldRaw[i], oldNo++);
			}
			for (let i = shared; i < newRaw.length && diffLines.length < maxLines; i++) {
				pushDiff("added", newRaw[i], undefined, newNo++);
			}
			const height =
				CODE_PADDING_Y * 2 +
				diffLines.reduce((sum, line) => sum + Math.max(1, line.lines.length) * CODE_LINE_H, 0);
			laid.push({
				...detail,
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				diffLines,
			});
			y += height + 6;
			continue;
		}
		if (detail.kind === "todo-row") {
			const result = layoutText(detail.text, contentWidth - 24, SMALL_FONT, SMALL_LINE_H);
			const height = Math.max(18, Math.min(result.height, SMALL_LINE_H * 2));
			laid.push({
				...detail,
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				lines: result.lines.slice(0, 2),
			});
			y += height + 4;
			continue;
		}
		if (detail.kind === "result-card") {
			const titleLines = detail.title
				? layoutText(detail.title, contentWidth - 12, SMALL_FONT, SMALL_LINE_H).lines.slice(0, 1)
				: [];
			const textLines = detail.text
				? layoutText(detail.text, contentWidth - 12, SMALL_FONT, SMALL_LINE_H).lines.slice(0, 2)
				: [];
			const height =
				12 + titleLines.length * 17 + (detail.subtitle ? 15 : 0) + textLines.length * 17;
			laid.push({
				kind: "result-card",
				title: detail.title,
				subtitle: detail.subtitle,
				text: detail.text,
				color: detail.color,
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height,
				lines: [...titleLines, ...textLines],
			});
			y += height + 5;
			continue;
		}
		if (detail.kind === "share-card") {
			const badges = layoutBadges(detail.badges, contentWidth - 52, y + 25).map((b) => ({
				...b,
				x: b.x + 44 - TOOL_CARD_PADDING,
			}));
			const badgeHeight =
				badges.length > 0 ? Math.max(...badges.map((b) => b.y + b.height - (y + 25))) : 0;
			laid.push({
				...detail,
				x: TOOL_CARD_PADDING,
				y,
				width: contentWidth,
				height: Math.max(56, 38 + badgeHeight),
				badges,
			});
			y += Math.max(56, 38 + badgeHeight) + 6;
		}
	}
	return { blocks: laid, height: Math.max(0, y - startY) };
}

function layoutToolUseBlock(
	block: PixiMessageItem["blocks"][number],
	innerWidth: number,
): {
	lines: LayoutLine[];
	height: number;
	toolHeader: { x: number; y: number; width: number; height: number };
	toolDetailLines: PixiLaidOutToolDetailLine[];
	toolDetailBlocks: PixiLaidOutToolDetailBlock[];
} {
	const toolOpen = block.toolExpanded ?? block.toolDefaultOpen;
	const blocksLayout = toolOpen
		? layoutToolDetailBlocks(
				block.toolDetailBlocks ?? [],
				innerWidth,
				TOOL_CARD_PADDING + TOOL_HEADER_H + TOOL_DETAIL_GAP,
			)
		: { blocks: [], height: 0 };
	const detailLines: PixiLaidOutToolDetailLine[] = [];
	let y = TOOL_CARD_PADDING + TOOL_HEADER_H + TOOL_DETAIL_GAP + blocksLayout.height;
	for (const detail of toolOpen && blocksLayout.blocks.length === 0
		? (block.toolDetailLines ?? [])
		: []) {
		const labelPrefix = detail.label ? `${detail.label}: ` : "";
		const text = `${labelPrefix}${detail.text}`;
		const font = detail.kind === "code" ? CODE_FONT : detail.kind === "muted" ? SMALL_FONT : FONT;
		const lineHeight = detail.kind === "code" ? CODE_LINE_H : SMALL_LINE_H;
		const width = Math.max(80, innerWidth - TOOL_CARD_PADDING * 2);
		const result = layoutText(text, width, font, lineHeight);
		const height = Math.max(TOOL_DETAIL_LINE_H, Math.min(result.height, lineHeight * 2));
		detailLines.push({
			...detail,
			text,
			lines: result.lines.slice(0, 2),
			x: TOOL_CARD_PADDING,
			y,
			width,
			height,
		});
		y += height + 3;
	}
	return {
		lines: [],
		height: Math.max(TOOL_CARD_PADDING * 2 + TOOL_HEADER_H, y - 3 + TOOL_CARD_PADDING),
		toolHeader: {
			x: TOOL_CARD_PADDING,
			y: TOOL_CARD_PADDING,
			width: innerWidth - TOOL_CARD_PADDING * 2,
			height: TOOL_HEADER_H,
		},
		toolDetailLines: detailLines,
		toolDetailBlocks: blocksLayout.blocks,
	};
}

export function clearPixiMessageLayoutCache(): void {
	preparedCache.clear();
	itemLayoutCache.clear();
}

function layoutPixiMessageItem(item: PixiMessageItem, viewportWidth: number): CachedItemLayout {
	const contentMaxWidth = Math.max(260, viewportWidth - 32);
	const itemWidth = contentMaxWidth;
	const cacheKey = itemLayoutCacheKey(item, itemWidth);
	const cached = getCachedItemLayout(cacheKey);
	if (cached) return cached;

	const isUser = item.role === "user";
	const isAssistant = item.role === "assistant";
	const isToolRun = item.kind === "tool-run";
	const paddingX = isUser ? USER_PADDING_X : PADDING_X;
	const paddingY = isUser ? USER_PADDING_Y : PADDING_Y;
	const innerWidth = Math.max(80, isToolRun ? itemWidth : itemWidth - paddingX * 2);
	const blocks: PixiLaidOutBlock[] = [];

	if (item.kind === "divider") {
		const layout = {
			width: itemWidth,
			height: 28,
			contentWidth: innerWidth,
			blocks,
		};
		setCachedItemLayout(cacheKey, layout);
		return layout;
	}

	let innerY = isToolRun ? 0 : paddingY;
	const isPlainAssistant = isAssistant && item.kind !== "tool-run";
	if (!isPlainAssistant && !isToolRun) {
		innerY += isUser ? USER_HEADER_H + USER_HEADER_CONTENT_GAP : HEADER_H;
	}
	const hasToolSeparators = isToolRun && item.blocks.length >= 2;
	for (let blockIndex = 0; blockIndex < item.blocks.length; blockIndex++) {
		const block = item.blocks[blockIndex];
		const separatorBefore = hasToolSeparators && blockIndex > 0;
		if (separatorBefore) innerY += TOOL_SEPARATOR_H;
		const isToolUse = block.type === "tool_use" && !!block.toolName;
		const labelHeight = block.label && !isToolUse ? SMALL_LINE_H : 0;
		const blockText = block.text || " ";
		const shouldRenderMarkdown = isAssistant && block.type === "text";
		const font = block.type === "bash_command" || block.type === "tool_use" ? CODE_FONT : FONT;
		const toolLayout = isToolUse ? layoutToolUseBlock(block, innerWidth) : null;
		const specialLayout = !toolLayout ? layoutSpecialBlock(block, blockText, innerWidth) : null;
		const mdLayout =
			!toolLayout && !specialLayout && shouldRenderMarkdown
				? layoutMarkdownBlocks(blockText, innerWidth)
				: null;
		const linesResult =
			toolLayout || specialLayout || mdLayout
				? null
				: layoutText(blockText, innerWidth, font, LINE_H);
		const textHeight = toolLayout
			? toolLayout.height
			: specialLayout
				? specialLayout.height
				: mdLayout
					? mdLayout.height
					: Math.max(LINE_H, linesResult?.height ?? LINE_H);
		const height = textHeight + labelHeight;
		blocks.push({
			type: block.type,
			label: block.label,
			color: block.color,
			text: blockText,
			lines: toolLayout?.lines ?? specialLayout?.lines ?? linesResult?.lines ?? [],
			x: isToolRun ? 0 : paddingX,
			y: innerY,
			width: innerWidth,
			height,
			separatorBefore,
			mdBlocks: mdLayout?.mdBlocks,
			messageId: block.messageId,
			messageUuid: block.messageUuid,
			blockIndex: block.blockIndex,
			copyText: block.copyText,
			toolName: block.toolName,
			toolCallId: block.toolCallId,
			toolUseId: block.toolUseId,
			pendingPermissionId: block.pendingPermissionId,
			pendingPermissionToolName: block.pendingPermissionToolName,
			pendingPermissionReason: block.pendingPermissionReason,
			toolCategory: block.toolCategory,
			toolSummary: block.toolSummary,
			toolStatus: block.toolStatus,
			toolDuration: block.toolDuration,
			toolStatusColor: block.toolStatusColor,
			toolCategoryColor: block.toolCategoryColor,
			toolIsSubagent: block.toolIsSubagent,
			toolChildCount: block.toolChildCount,
			toolInRun: block.toolInRun,
			toolIsLast: block.toolIsLast,
			toolKey: block.toolKey,
			toolExpanded: block.toolExpanded,
			toolDefaultOpen: block.toolDefaultOpen,
			reasoningKey: block.reasoningKey,
			reasoningExpanded: block.reasoningExpanded,
			reasoningToggleKey: block.reasoningToggleKey,
			reasoningCharCount: block.reasoningCharCount,
			reasoningEncrypted: block.reasoningEncrypted,
			reasoningStreaming: block.reasoningStreaming,
			reasoningLabel: block.reasoningLabel,
			reasoningCharsLabel: block.reasoningCharsLabel,
			reasoningThinkingLabel: block.reasoningThinkingLabel,
			imageSrc: block.imageSrc,
			imageId: block.imageId,
			imageUploadNarratorId: block.imageUploadNarratorId,
			imageFilename: block.imageFilename,
			imageMediaType: block.imageMediaType,
			imageSavedPath: block.imageSavedPath,
			imageAlt: block.imageAlt,
			imageStatus: block.imageStatus,
			toolHeader: toolLayout?.toolHeader,
			toolDetailLines: toolLayout?.toolDetailLines,
			toolDetailBlocks: toolLayout?.toolDetailBlocks,
		});
		innerY += height + (isToolRun ? 0 : BLOCK_GAP);
	}
	if (item.blocks.length === 0) innerY += LINE_H;
	if (item.tokenUsage) {
		const token = layoutText(item.tokenUsage, innerWidth, SMALL_FONT, SMALL_LINE_H);
		blocks.push({
			type: "token_usage",
			text: item.tokenUsage,
			lines: token.lines,
			x: paddingX,
			y: innerY,
			width: innerWidth,
			height: TOKEN_H,
		});
		innerY += TOKEN_H;
	}

	const height = Math.max(MIN_ITEM_H, isToolRun ? innerY : innerY + paddingY - BLOCK_GAP);
	const layout = {
		width: itemWidth,
		height,
		contentWidth: innerWidth,
		blocks,
	};
	setCachedItemLayout(cacheKey, layout);
	if (!isAssistant && !isUser) {
		// no-op; retained to make role-based layout explicit
	}
	return layout;
}

export function layoutPixiMessageItems(
	items: PixiMessageItem[],
	viewportWidth: number,
): PixiMessageLayoutResult {
	const laidOut: PixiLaidOutItem[] = [];
	let y = 12;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const cached = layoutPixiMessageItem(item, viewportWidth);
		const x = Math.max(16, (viewportWidth - cached.width) / 2);
		laidOut.push({
			item,
			index: i,
			x,
			y,
			width: cached.width,
			height: cached.height,
			contentWidth: cached.contentWidth,
			blocks: cached.blocks,
		});
		y += cached.height + GAP;
	}

	return { items: laidOut, totalHeight: Math.max(0, y) };
}
