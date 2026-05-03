import { type LayoutLine, layoutWithLines, prepareWithSegments } from "@chenglou/pretext";
import type { PixiMessageItem } from "./pixi-message-model";

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
const BLOCK_GAP = 8;
const HEADER_H = 20;
const TOKEN_H = 18;
const MIN_ITEM_H = 34;
const FONT = "14px sans-serif";
const SMALL_FONT = "12px sans-serif";
const LINE_H = 20;
const SMALL_LINE_H = 17;
const MAX_BLOCK_LINES = 120;

const preparedCache = new Map<string, ReturnType<typeof prepareWithSegments>>();
const MAX_CACHE = 1200;

function getPrepared(text: string, font: string) {
	const key = `${font}\u0000${text}`;
	const cached = preparedCache.get(key);
	if (cached) return cached;
	const prepared = prepareWithSegments(text, font, { whiteSpace: "pre-wrap" });
	preparedCache.set(key, prepared);
	if (preparedCache.size > MAX_CACHE) {
		const first = preparedCache.keys().next().value;
		if (first) preparedCache.delete(first);
	}
	return prepared;
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

export function clearPixiMessageLayoutCache(): void {
	preparedCache.clear();
}

export function layoutPixiMessageItems(
	items: PixiMessageItem[],
	viewportWidth: number,
): PixiMessageLayoutResult {
	const contentMaxWidth = Math.max(260, viewportWidth - 32);
	const laidOut: PixiLaidOutItem[] = [];
	let y = 12;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const isUser = item.role === "user";
		const isAssistant = item.role === "assistant";
		const itemWidth =
			item.kind === "divider"
				? contentMaxWidth
				: isUser
					? Math.min(720, contentMaxWidth * 0.82)
					: contentMaxWidth;
		const x = isUser ? Math.max(16, viewportWidth - itemWidth - 16) : 16;
		const innerWidth = Math.max(80, itemWidth - PADDING_X * 2);
		let innerY = PADDING_Y;
		const blocks: PixiLaidOutBlock[] = [];

		if (item.kind === "divider") {
			laidOut.push({
				item,
				index: i,
				x,
				y,
				width: itemWidth,
				height: 28,
				contentWidth: innerWidth,
				blocks,
			});
			y += 28 + GAP;
			continue;
		}

		innerY += HEADER_H;
		for (const block of item.blocks) {
			const labelHeight = block.label ? SMALL_LINE_H : 0;
			const blockText = block.text || " ";
			const font =
				block.type === "bash_command" || block.type === "tool_use" ? "13px monospace" : FONT;
			const linesResult = layoutText(blockText, innerWidth, font, LINE_H);
			const height = Math.max(LINE_H, linesResult.height) + labelHeight;
			blocks.push({
				type: block.type,
				label: block.label,
				color: block.color,
				text: blockText,
				lines: linesResult.lines,
				x: PADDING_X,
				y: innerY,
				width: innerWidth,
				height,
			});
			innerY += height + BLOCK_GAP;
		}
		if (item.blocks.length === 0) innerY += LINE_H;
		if (item.tokenUsage) {
			const token = layoutText(item.tokenUsage, innerWidth, SMALL_FONT, SMALL_LINE_H);
			blocks.push({
				type: "token_usage",
				text: item.tokenUsage,
				lines: token.lines,
				x: PADDING_X,
				y: innerY,
				width: innerWidth,
				height: TOKEN_H,
			});
			innerY += TOKEN_H;
		}

		const height = Math.max(MIN_ITEM_H, innerY + PADDING_Y - BLOCK_GAP);
		laidOut.push({
			item,
			index: i,
			x,
			y,
			width: itemWidth,
			height,
			contentWidth: innerWidth,
			blocks,
		});
		y += height + GAP;
		if (!isAssistant && !isUser) {
			// no-op; retained to make role-based layout explicit
		}
	}

	return { items: laidOut, totalHeight: Math.max(0, y) };
}
