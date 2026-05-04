import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { type Container, type Graphics, Text, TextStyle } from "pixi.js";
import type {
	PixiLaidOutBlock,
	PixiLaidOutItem,
	PixiLaidOutMarkdownBlock,
} from "./pixi-message-layout";
import type { PixiMessageTheme } from "./pixi-message-theme";
import { getPixiHighlightedTokens, type PixiHighlightToken } from "./pixi-shiki-highlight";
import {
	getPixiToolCategoryIcon,
	getPixiToolChevronIcon,
	getPixiToolStatusIcon,
	type IconSpritePool,
} from "./pixi-tabler-icons";

const TITLE_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 12, fontWeight: "600" });
const SUBTITLE_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 11 });
const BODY_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 14 });
const MONO_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 11 });
const TOOL_NAME_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 12, fontWeight: "600" });
const SMALL_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 12 });
const HEADING_1_STYLE = new TextStyle({
	fontFamily: "sans-serif",
	fontSize: 22,
	fontWeight: "700",
});
const HEADING_2_STYLE = new TextStyle({
	fontFamily: "sans-serif",
	fontSize: 19,
	fontWeight: "700",
});
const HEADING_3_STYLE = new TextStyle({
	fontFamily: "sans-serif",
	fontSize: 17,
	fontWeight: "700",
});
const HEADING_4_STYLE = new TextStyle({
	fontFamily: "sans-serif",
	fontSize: 15,
	fontWeight: "700",
});
const CODE_PADDING_X = 10;
const CODE_PADDING_Y = 7;
const BLOCKQUOTE_INDENT = 16;
const LIST_INDENT = 24;
const AVATAR_INITIAL_STYLE = new TextStyle({
	fontFamily: "sans-serif",
	fontSize: 10,
	fontWeight: "600",
});
const AVATAR_INITIAL_FONT = "600 10px sans-serif";
const DIVIDER_FONT = "12px sans-serif";

function colorForName(theme: PixiMessageTheme, color?: string): number {
	switch (color) {
		case "green":
			return theme.green;
		case "yellow":
			return theme.yellow;
		case "red":
			return theme.red;
		case "blue":
			return theme.blue;
		case "teal":
			return theme.teal;
		case "indigo":
			return theme.indigo;
		case "pink":
			return theme.pink;
		case "orange":
			return theme.orange;
		case "violet":
			return theme.violet;
		case "cyan":
			return theme.cyan;
		case "lime":
			return theme.lime;
		case "grape":
			return theme.grape;
		default:
			return theme.dimmed;
	}
}

function drawRoundRect(
	gfx: Graphics,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
	fill: number,
	stroke: number,
	alpha = 1,
) {
	gfx.roundRect(x, y, w, h, r);
	gfx.fill({ color: fill, alpha });
	gfx.stroke({ color: stroke, alpha: 0.9, width: 1 });
}

export class TextPool {
	private pool: Text[] = [];
	private cursor = 0;
	private styleCache = new Map<string, TextStyle>();

	constructor(private container: Container) {}

	reset(): void {
		this.cursor = 0;
	}

	acquire(text: string, x: number, y: number, style: TextStyle, color: number): Text {
		const resolvedStyle = this.resolveStyle(style, color);
		let node: Text;
		if (this.cursor < this.pool.length) {
			node = this.pool[this.cursor];
		} else {
			node = new Text({ text: "", style: resolvedStyle });
			this.pool.push(node);
			this.container.addChild(node);
		}

		this.cursor++;
		node.visible = true;
		node.alpha = 1;
		node.scale.set(1);
		if (node.style !== resolvedStyle) node.style = resolvedStyle;
		node.text = text;
		node.position.set(x, y);
		return node;
	}

	releaseUnused(): void {
		for (let i = this.cursor; i < this.pool.length; i++) {
			this.pool[i].visible = false;
		}
	}

	private resolveStyle(style: TextStyle, color: number): TextStyle {
		const key = `${style.styleKey}:${color}`;
		const cached = this.styleCache.get(key);
		if (cached) return cached;

		const resolved = style.clone();
		resolved.fill = color;
		this.styleCache.set(key, resolved);
		return resolved;
	}
}

let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
	if (measureCtx) return measureCtx;
	const canvas = document.createElement("canvas");
	measureCtx = canvas.getContext("2d");
	return measureCtx;
}

function measureCanvasTextWidth(text: string, font: string): number {
	const ctx = getMeasureCtx();
	if (!ctx) return 0;
	ctx.font = font;
	return ctx.measureText(text).width;
}

function measureTextWidth(text: string, font: string): number {
	return measureNaturalWidth(prepareWithSegments(text || " ", font));
}

function styleForHeading(level?: number): TextStyle {
	switch (level) {
		case 1:
			return HEADING_1_STYLE;
		case 2:
			return HEADING_2_STYLE;
		case 3:
			return HEADING_3_STYLE;
		default:
			return HEADING_4_STYLE;
	}
}

function drawMarkdownTextLines(
	textPool: TextPool,
	mdBlock: PixiLaidOutMarkdownBlock,
	x: number,
	y: number,
	style: TextStyle,
	color: number,
) {
	for (let i = 0; i < mdBlock.lines.length; i++) {
		textPool.acquire(mdBlock.lines[i].text, x, y + i * mdBlock.lineHeight, style, color);
	}
}

function drawMarkdownBlock(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	mdBlock: PixiLaidOutMarkdownBlock,
	blockX: number,
	blockY: number,
) {
	const x = blockX + mdBlock.x;
	const y = blockY + mdBlock.y;

	switch (mdBlock.kind) {
		case "heading":
			drawMarkdownTextLines(textPool, mdBlock, x, y, styleForHeading(mdBlock.level), theme.text);
			break;
		case "paragraph":
			drawMarkdownTextLines(textPool, mdBlock, x, y, BODY_STYLE, theme.text);
			break;
		case "code":
			gfx.roundRect(x, y, mdBlock.width, mdBlock.height, 6);
			gfx.fill({ color: theme.toolBg, alpha: 0.88 });
			gfx.stroke({ color: theme.toolBorder, alpha: 0.58, width: 1 });
			drawMarkdownTextLines(
				textPool,
				mdBlock,
				x + CODE_PADDING_X,
				y + CODE_PADDING_Y,
				MONO_STYLE,
				theme.text,
			);
			break;
		case "blockquote":
			gfx.roundRect(x, y + 1, 3, Math.max(1, mdBlock.height - 2), 2);
			gfx.fill({ color: theme.dimmed, alpha: 0.72 });
			drawMarkdownTextLines(textPool, mdBlock, x + BLOCKQUOTE_INDENT, y, BODY_STYLE, theme.dimmed);
			break;
		case "list-item": {
			const marker = mdBlock.ordered ? `${mdBlock.index ?? 1}.` : "•";
			textPool.acquire(marker, x, y, BODY_STYLE, theme.dimmed);
			drawMarkdownTextLines(textPool, mdBlock, x + LIST_INDENT, y, BODY_STYLE, theme.text);
			break;
		}
		case "hr": {
			const lineY = y + 8;
			gfx.moveTo(x, lineY);
			gfx.lineTo(x + mdBlock.width, lineY);
			gfx.stroke({ color: theme.dimmed, alpha: 0.3, width: 1 });
			break;
		}
		case "empty":
			break;
	}
}

function drawUserAvatar(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	title: string,
	x: number,
	y: number,
) {
	gfx.circle(x + 10, y + 10, 10);
	gfx.fill({ color: theme.indigo, alpha: 1 });
	const initial = title.trim().charAt(0).toUpperCase() || "U";
	const initialWidth = measureTextWidth(initial, AVATAR_INITIAL_FONT);
	textPool.acquire(initial, x + (20 - initialWidth) / 2, y + 3, AVATAR_INITIAL_STYLE, 0xffffff);
}

function compactText(text: string, maxChars: number): string {
	const singleLine = text.replaceAll("\n", " ").trim();
	if (singleLine.length <= maxChars) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxChars - 1))}…`;
}

function measureMonoAdvance(text: string, style: TextStyle): number {
	if (!text) return 0;
	const fontSize = typeof style.fontSize === "number" ? style.fontSize : 12;
	const family = Array.isArray(style.fontFamily) ? style.fontFamily[0] : style.fontFamily;
	const fontWeight = style.fontWeight ? `${style.fontWeight} ` : "";
	const font = `${fontWeight}${fontSize}px ${family ?? "monospace"}`;
	// Use canvas measurement for token advances. pretext intentionally ignores
	// some standalone whitespace in natural-width measurement, but syntax tokens
	// need exact spaces/tabs to keep operators and words separated.
	return measureCanvasTextWidth(text, font);
}

function textWidth(text: string, style: TextStyle): number {
	const fontSize = typeof style.fontSize === "number" ? style.fontSize : 12;
	const family = Array.isArray(style.fontFamily) ? style.fontFamily[0] : style.fontFamily;
	const fontWeight = style.fontWeight ? `${style.fontWeight} ` : "";
	return measureTextWidth(text, `${fontWeight}${fontSize}px ${family ?? "sans-serif"}`);
}

function centeredTextX(text: string, x: number, width: number, style: TextStyle): number {
	return x + Math.max(0, (width - textWidth(text, style)) / 2);
}

function drawDashedLine(
	gfx: Graphics,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	color: number,
) {
	const dx = x2 - x1;
	const dy = y2 - y1;
	const len = Math.hypot(dx, dy);
	const dash = 7;
	const gap = 5;
	for (let dist = 0; dist < len; dist += dash + gap) {
		const start = dist / len;
		const end = Math.min(len, dist + dash) / len;
		gfx.moveTo(x1 + dx * start, y1 + dy * start);
		gfx.lineTo(x1 + dx * end, y1 + dy * end);
	}
	gfx.stroke({ color, alpha: 0.7, width: 1 });
}

function drawDashedRect(
	gfx: Graphics,
	x: number,
	y: number,
	width: number,
	height: number,
	color: number,
) {
	drawDashedLine(gfx, x, y, x + width, y, color);
	drawDashedLine(gfx, x + width, y, x + width, y + height, color);
	drawDashedLine(gfx, x + width, y + height, x, y + height, color);
	drawDashedLine(gfx, x, y + height, x, y, color);
}

function drawReasoningBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = block.height;
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color: theme.systemBg, alpha: 0.55 });
	gfx.rect(bx, by, 3, height);
	gfx.fill({ color: theme.yellow, alpha: 0.9 });
	textPool.acquire(
		`Reasoning · ${block.text.length.toLocaleString()} chars`,
		bx + 12,
		by + 8,
		SMALL_STYLE,
		theme.yellow,
	);
	const visibleLines = block.lines.slice(0, 3).map((line) => line.text);
	if (block.lines.length > 3 && visibleLines.length > 0) {
		visibleLines[visibleLines.length - 1] =
			`${compactText(visibleLines[visibleLines.length - 1], 96)} …`;
	}
	while (visibleLines.length < 3) visibleLines.push("");
	for (let i = 0; i < 3; i++) {
		textPool.acquire(visibleLines[i], bx + 12, by + 30 + i * 18, SMALL_STYLE, theme.dimmed);
	}
}

function drawWebSearchBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = block.height;
	gfx.roundRect(bx, by, block.width, height, 5);
	gfx.fill({ color: theme.blue, alpha: 0.1 });
	gfx.rect(bx, by, 3, height);
	gfx.fill({ color: theme.blue, alpha: 0.85 });
	textPool.acquire(
		`🔍 ${compactText(block.text || "Searching web", 120)}`,
		bx + 10,
		by + 5,
		SMALL_STYLE,
		theme.blue,
	);
}

function drawImageBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const width = Math.min(200, block.width);
	const height = block.height;
	gfx.roundRect(bx, by, width, height, 6);
	gfx.fill({ color: theme.systemBg, alpha: 0.35 });
	drawDashedRect(gfx, bx, by, width, height, theme.dimmed);
	const label = `📷 ${compactText(block.text || "Attached image", 32)}`;
	textPool.acquire(
		label,
		centeredTextX(label, bx, width, SMALL_STYLE),
		by + 50,
		SMALL_STYLE,
		theme.dimmed,
	);
}

function drawCompactBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = block.height;
	const countMatch = block.text.match(/"messageCount"\s*:\s*(\d+)|messageCount[:=]\s*(\d+)/);
	const count = countMatch?.[1] ?? countMatch?.[2];
	const label =
		block.type === "segment_compact"
			? count
				? `⊟ Segment compacted (${count} messages)`
				: "⊟ Segment compacted"
			: "⊟ Context compacted";
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color: theme.teal, alpha: 0.1 });
	textPool.acquire(
		label,
		centeredTextX(label, bx, block.width, SMALL_STYLE),
		by + 5,
		SMALL_STYLE,
		theme.teal,
	);
}

function drawErrorBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = Math.max(32, block.height);
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color: theme.red, alpha: 0.12 });
	gfx.rect(bx, by, 3, height);
	gfx.fill({ color: theme.red, alpha: 0.9 });
	const lines = block.lines.length > 0 ? block.lines : [{ text: block.text }];
	for (let i = 0; i < lines.length; i++) {
		textPool.acquire(
			`${i === 0 ? "⚠ " : "  "}${lines[i].text}`,
			bx + 10,
			by + 8 + i * 20,
			BODY_STYLE,
			theme.red,
		);
	}
}

function drawInfoBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = Math.max(28, block.height);
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color: theme.systemBg, alpha: 0.6 });
	const lines = block.lines.length > 0 ? block.lines : [{ text: block.text }];
	for (let i = 0; i < lines.length; i++) {
		textPool.acquire(lines[i].text, bx + 10, by + 6 + i * 20, SMALL_STYLE, theme.dimmed);
	}
}

function drawPlanBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = Math.max(58, block.height);
	gfx.roundRect(bx, by, block.width, height, 7);
	gfx.fill({ color: theme.teal, alpha: 0.12 });
	gfx.stroke({ color: theme.teal, alpha: 0.65, width: 1 });
	textPool.acquire("📋 Plan", bx + 10, by + 8, TITLE_STYLE, theme.teal);
	for (let i = 0; i < block.lines.length; i++) {
		textPool.acquire(block.lines[i].text, bx + 10, by + 32 + i * 20, BODY_STYLE, theme.text);
	}
}

function drawMergeSummaryBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const height = block.height;
	const branchInfo = compactText(block.text || "merged", 96);
	const label = `🔀 Merge summary — ${branchInfo}`;
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color: theme.indigo, alpha: 0.13 });
	textPool.acquire(label, bx + 10, by + 6, SMALL_STYLE, theme.indigo);
}

function reviewVerdict(text: string): { color: number; icon: string; label: string } {
	if (text.includes("request_changes")) return { color: 0, icon: "🔧", label: "Request changes" };
	if (text.includes("approve")) return { color: 0, icon: "✅", label: "Approved" };
	return { color: 0, icon: "💬", label: "Comment" };
}

function drawReviewFeedbackBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const verdict = reviewVerdict(block.text);
	const color =
		verdict.label === "Request changes"
			? theme.yellow
			: verdict.label === "Approved"
				? theme.green
				: theme.blue;
	const height = block.height;
	gfx.roundRect(bx, by, block.width, height, 6);
	gfx.fill({ color, alpha: 0.12 });
	textPool.acquire(
		`${verdict.icon} Review feedback — ${verdict.label}: ${compactText(block.text, 90)}`,
		bx + 10,
		by + 6,
		SMALL_STYLE,
		color,
	);
}

function drawGoalContinuationBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, gfx, block, bx, by, theme } = opts;
	const label = `🎯 Goal: ${compactText(block.text, 100)}`;
	const width = Math.min(block.width, Math.max(120, textWidth(label, SMALL_STYLE) + 22));
	gfx.roundRect(bx, by, width, block.height, 14);
	gfx.fill({ color: theme.teal, alpha: 0.13 });
	gfx.stroke({ color: theme.teal, alpha: 0.55, width: 1 });
	textPool.acquire(label, bx + 11, by + 5, SMALL_STYLE, theme.teal);
}

interface DrawSpecialBlockOptions {
	textPool: TextPool;
	gfx: Graphics;
	block: PixiLaidOutBlock;
	bx: number;
	by: number;
	theme: PixiMessageTheme;
}

function drawBadge(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	text: string,
	x: number,
	y: number,
	w: number,
	colorName?: string,
	variant?: string,
): void {
	const color = colorForName(theme, colorName);
	gfx.roundRect(x, y, w, 16, 8);
	gfx.fill({ color, alpha: variant === "outline" ? 0.03 : 0.13 });
	gfx.stroke({ color, alpha: variant === "outline" ? 0.6 : 0.25, width: 1 });
	if (variant === "dot") {
		gfx.circle(x + 8, y + 8, 2);
		gfx.fill({ color, alpha: 0.95 });
		textPool.acquire(text, x + 14, y, SMALL_STYLE, color);
	} else {
		textPool.acquire(text, x + 7, y, SMALL_STYLE, color);
	}
}

function shikiThemeName(): string {
	return document.documentElement.getAttribute("data-mantine-color-scheme") === "light"
		? "github-light-default"
		: "github-dark-default";
}

function flattenHighlightedTokens(lines: PixiHighlightToken[][]): PixiHighlightToken[] {
	const out: PixiHighlightToken[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push({ content: "\n" });
		out.push(...lines[i]);
	}
	return out;
}

function tokenTextLength(tokens: PixiHighlightToken[]): number {
	let length = 0;
	for (const token of tokens) length += token.content.length;
	return length;
}

function splitTokensByPretextLines(
	highlighted: PixiHighlightToken[][] | null,
	visualLines: Array<{ text: string }>,
): PixiHighlightToken[][] | null {
	if (!highlighted) return null;
	const tokens = flattenHighlightedTokens(highlighted);
	const result: PixiHighlightToken[][] = [];
	let tokenIndex = 0;
	let tokenOffset = 0;

	const peekChar = () => tokens[tokenIndex]?.content[tokenOffset];
	const consumeChars = (count: number): PixiHighlightToken[] => {
		const chunks: PixiHighlightToken[] = [];
		let remaining = count;
		while (remaining > 0 && tokenIndex < tokens.length) {
			const token = tokens[tokenIndex];
			const available = token.content.length - tokenOffset;
			const take = Math.min(remaining, available);
			const content = token.content.slice(tokenOffset, tokenOffset + take);
			if (content) chunks.push({ content, color: token.color });
			tokenOffset += take;
			remaining -= take;
			if (tokenOffset >= token.content.length) {
				tokenIndex++;
				tokenOffset = 0;
			}
		}
		return chunks;
	};

	for (const visualLine of visualLines) {
		// Hard line breaks are represented in Shiki's full token stream but are not
		// part of pretext's materialized visual line text. Consume them between
		// physical lines; soft wraps do not have this newline, so they keep flowing.
		while (peekChar() === "\n") consumeChars(1);
		const wanted = visualLine.text.length;
		const chunks = consumeChars(wanted);
		result.push(tokenTextLength(chunks) === wanted ? chunks : []);
	}
	return result;
}

function drawTokenLine(
	textPool: TextPool,
	text: string,
	tokens: PixiHighlightToken[] | undefined,
	x: number,
	y: number,
	fallbackColor: number,
): void {
	if (!tokens?.length) {
		textPool.acquire(text || " ", x, y, MONO_STYLE, fallbackColor);
		return;
	}
	let tokenX = x;
	for (const token of tokens) {
		if (!token.content) continue;
		if (!/^\s+$/.test(token.content)) {
			textPool.acquire(token.content, tokenX, y, MONO_STYLE, token.color ?? fallbackColor);
		}
		tokenX += measureMonoAdvance(token.content, MONO_STYLE);
	}
}

function drawCodePanel(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	block: NonNullable<PixiLaidOutBlock["toolDetailBlocks"]>[number],
	bx: number,
	by: number,
	terminal: boolean,
): void {
	const x = bx + block.x;
	const y = by + block.y;
	const bg = terminal ? 0x101113 : theme.panelBg;
	const fg = terminal ? 0xd8dee9 : theme.text;
	gfx.roundRect(x, y, block.width, block.height, 4);
	gfx.fill({ color: bg, alpha: terminal ? 0.92 : 0.42 });
	gfx.stroke({ color: terminal ? theme.panelBorder : theme.toolBorder, alpha: 0.55, width: 1 });
	let textY = y + CODE_PADDING_Y;
	if (block.title) {
		textPool.acquire(block.title, x + CODE_PADDING_X, textY - 1, SMALL_STYLE, theme.dimmed);
		textY += 17;
	}
	const highlighted = getPixiHighlightedTokens(block.text ?? "", block.lang, shikiThemeName());
	const highlightedVisualLines = splitTokensByPretextLines(highlighted, block.lines ?? []);
	for (let lineIndex = 0; lineIndex < (block.lines ?? []).length; lineIndex++) {
		const line = block.lines?.[lineIndex];
		if (!line) continue;
		// Shiki highlights the complete source to preserve semantic context.
		// pretext decides the visual wraps; we slice the full token stream to match
		// each pretext-produced visual line.
		drawTokenLine(
			textPool,
			line.text,
			highlightedVisualLines?.[lineIndex],
			x + CODE_PADDING_X,
			textY,
			fg,
		);
		textY += 18;
	}
}

function drawDiffPanel(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	block: NonNullable<PixiLaidOutBlock["toolDetailBlocks"]>[number],
	bx: number,
	by: number,
): void {
	const x = bx + block.x;
	let y = by + block.y;
	gfx.roundRect(x, y, block.width, block.height, 4);
	gfx.fill({ color: theme.panelBg, alpha: 0.38 });
	gfx.stroke({ color: theme.toolBorder, alpha: 0.5, width: 1 });
	textPool.acquire(block.title ?? "Diff", x + CODE_PADDING_X, y + 7, SMALL_STYLE, theme.dimmed);
	y += 25;
	for (const line of block.diffLines ?? []) {
		const prefix = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";
		const color =
			line.type === "removed" ? theme.red : line.type === "added" ? theme.green : theme.dimmed;
		const rowHeight = Math.max(1, line.lines.length) * 18;
		if (line.type === "removed" || line.type === "added") {
			gfx.rect(x + 1, y - 1, block.width - 2, rowHeight);
			gfx.fill({ color, alpha: 0.08 });
		}
		const oldNo = line.oldNo != null ? String(line.oldNo).padStart(3) : "   ";
		const newNo = line.newNo != null ? String(line.newNo).padStart(3) : "   ";
		textPool.acquire(`${oldNo} ${newNo}${prefix}`, x + 8, y, MONO_STYLE, color);
		const highlighted = getPixiHighlightedTokens(line.text, block.lang, shikiThemeName());
		const highlightedVisualLines = splitTokensByPretextLines(highlighted, line.lines);
		let lineY = y;
		for (let i = 0; i < line.lines.length; i++) {
			const visualLine = line.lines[i];
			drawTokenLine(
				textPool,
				visualLine.text || " ",
				highlightedVisualLines?.[i],
				x + 60,
				lineY,
				line.type === "context" ? theme.text : color,
			);
			lineY += 18;
		}
		y += Math.max(1, line.lines.length) * 18;
	}
}

function drawResultCard(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	block: NonNullable<PixiLaidOutBlock["toolDetailBlocks"]>[number],
	bx: number,
	by: number,
): void {
	const x = bx + block.x;
	const y = by + block.y;
	const color = colorForName(theme, block.color);
	gfx.roundRect(x, y, block.width, block.height, 4);
	gfx.fill({ color: theme.panelBg, alpha: 0.34 });
	gfx.stroke({ color, alpha: 0.24, width: 1 });
	let textY = y + 6;
	if (block.title) {
		textPool.acquire(block.title, x + 6, textY, TOOL_NAME_STYLE, color);
		textY += 17;
	}
	if (block.subtitle) {
		textPool.acquire(block.subtitle, x + 6, textY, SMALL_STYLE, theme.dimmed);
		textY += 15;
	}
	const consumed = (block.title ? 1 : 0) + (block.subtitle ? 0 : 0);
	for (const line of (block.lines ?? []).slice(consumed)) {
		textPool.acquire(line.text, x + 6, textY, SMALL_STYLE, theme.dimmed);
		textY += 17;
	}
}

function drawToolDetailBlock(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	block: NonNullable<PixiLaidOutBlock["toolDetailBlocks"]>[number],
	bx: number,
	by: number,
): void {
	if (block.kind === "badge-row") {
		for (const badge of block.badges ?? []) {
			drawBadge(
				textPool,
				gfx,
				theme,
				badge.text,
				bx + badge.x,
				by + badge.y,
				badge.width,
				badge.color,
				badge.variant,
			);
		}
		return;
	}
	if (block.kind === "section-title") {
		textPool.acquire(block.text ?? "", bx + block.x, by + block.y, TOOL_NAME_STYLE, theme.text);
		return;
	}
	if (block.kind === "text-line") {
		const color = block.color
			? colorForName(theme, block.color)
			: block.muted
				? theme.dimmed
				: theme.text;
		const style = block.mono ? MONO_STYLE : SMALL_STYLE;
		for (let i = 0; i < (block.lines ?? []).length; i++) {
			textPool.acquire(
				block.lines?.[i]?.text ?? "",
				bx + block.x,
				by + block.y + i * 17,
				style,
				color,
			);
		}
		return;
	}
	if (block.kind === "code-panel" || block.kind === "terminal-panel") {
		drawCodePanel(textPool, gfx, theme, block, bx, by, block.kind === "terminal-panel");
		return;
	}
	if (block.kind === "diff-panel") {
		drawDiffPanel(textPool, gfx, theme, block, bx, by);
		return;
	}
	if (block.kind === "todo-row") {
		const color =
			block.status === "completed"
				? theme.green
				: block.status === "in_progress"
					? theme.blue
					: theme.yellow;
		gfx.circle(bx + block.x + 8, by + block.y + 8, 6);
		gfx.fill({ color, alpha: 0.16 });
		gfx.stroke({ color, alpha: 0.55, width: 1 });
		for (let i = 0; i < (block.lines ?? []).length; i++) {
			textPool.acquire(
				block.lines?.[i]?.text ?? "",
				bx + block.x + 24,
				by + block.y + i * 17,
				SMALL_STYLE,
				block.status === "completed" ? theme.dimmed : theme.text,
			);
		}
		return;
	}
	if (block.kind === "result-card") {
		drawResultCard(textPool, gfx, theme, block, bx, by);
		return;
	}
	if (block.kind === "share-card") {
		const x = bx + block.x;
		const y = by + block.y;
		gfx.roundRect(x, y, block.width, block.height, 6);
		gfx.fill({ color: theme.green, alpha: 0.12 });
		gfx.stroke({ color: theme.green, alpha: 0.3, width: 1 });
		gfx.roundRect(x + 8, y + 10, 28, 28, 6);
		gfx.fill({ color: theme.green, alpha: 0.18 });
		textPool.acquire(block.filename ?? "file", x + 44, y + 8, TOOL_NAME_STYLE, theme.text);
		for (const badge of block.badges ?? []) {
			drawBadge(
				textPool,
				gfx,
				theme,
				badge.text,
				bx + badge.x,
				by + badge.y,
				badge.width,
				badge.color,
				badge.variant,
			);
		}
	}
}

function drawToolUseBlock(opts: DrawSpecialBlockOptions & { iconPool: IconSpritePool }): boolean {
	const { textPool, iconPool, gfx, block, bx, by, theme } = opts;
	if (block.type !== "tool_use" || !block.toolName || !block.toolHeader) return false;
	const categoryColor = colorForName(theme, block.toolCategoryColor);
	const statusColor = colorForName(theme, block.toolStatusColor);
	const header = block.toolHeader;
	const cardX = bx;
	const cardY = by;
	const cardW = block.width;
	const inRun = block.toolInRun === true;
	if (!inRun) {
		gfx.roundRect(cardX, cardY, cardW, block.height, 4);
		gfx.fill({ color: theme.toolBg, alpha: 0.42 });
		gfx.stroke({ color: theme.toolBorder, alpha: 0.85, width: 1 });
	}

	const iconBoxX = bx + header.x;
	const iconBoxY = by + header.y + 1;
	gfx.roundRect(iconBoxX, iconBoxY, 16, 16, 4);
	gfx.fill({ color: categoryColor, alpha: 0.16 });
	iconPool.acquire(
		getPixiToolCategoryIcon(block.toolCategory, categoryColor, 10),
		iconBoxX + 3,
		iconBoxY + 3,
		10,
	);

	const nameX = iconBoxX + 21;
	textPool.acquire(block.toolName, nameX, by + header.y + 2, TOOL_NAME_STYLE, theme.dimmed);
	const nameWidth = textWidth(block.toolName, TOOL_NAME_STYLE) + 5;
	const statusSize = 12;
	const chevronSize = 12;
	const durationWidth = block.toolDuration ? textWidth(block.toolDuration, SMALL_STYLE) : 0;
	const chevronX = bx + header.x + header.width - chevronSize;
	const durationX = chevronX - 6 - durationWidth;
	const statusX = durationX - 16;
	iconPool.acquire(
		getPixiToolStatusIcon(block.toolStatus, statusColor, statusSize),
		statusX,
		by + header.y + 3,
		statusSize,
	);
	if (block.toolDuration) {
		textPool.acquire(block.toolDuration, durationX, by + header.y + 2, SMALL_STYLE, theme.dimmed);
	}
	iconPool.acquire(
		getPixiToolChevronIcon(block.toolDefaultOpen === true, theme.dimmed, chevronSize),
		chevronX,
		by + header.y + 3,
		chevronSize,
		0.85,
	);
	const summary = block.toolSummary || block.text;
	const summaryRight = statusX - 10;
	const summaryMaxChars = Math.max(0, Math.floor((summaryRight - nameX - nameWidth) / 7));
	if (summary && summaryMaxChars > 6) {
		textPool.acquire(
			compactText(summary, summaryMaxChars),
			nameX + nameWidth,
			by + header.y + 2,
			MONO_STYLE,
			theme.text,
		);
	}

	for (const detailBlock of block.toolDetailBlocks ?? []) {
		drawToolDetailBlock(textPool, gfx, theme, detailBlock, bx, by);
	}

	for (const line of block.toolDetailBlocks?.length ? [] : (block.toolDetailLines ?? [])) {
		const lineX = bx + line.x;
		const lineY = by + line.y;
		const color =
			line.kind === "error" ? theme.red : line.kind === "muted" ? theme.dimmed : theme.text;
		const style =
			line.kind === "code" ? MONO_STYLE : line.kind === "muted" ? SMALL_STYLE : BODY_STYLE;
		if (line.kind === "code") {
			gfx.roundRect(lineX - 4, lineY - 1, line.width + 8, line.height + 1, 4);
			gfx.fill({ color: theme.toolBg, alpha: 0.38 });
		} else if (line.kind === "error") {
			gfx.roundRect(lineX - 4, lineY - 1, line.width + 8, line.height + 1, 4);
			gfx.fill({ color: theme.red, alpha: 0.08 });
		}
		for (let i = 0; i < line.lines.length; i++) {
			textPool.acquire(line.lines[i].text, lineX, lineY + i * 17, style, color);
		}
	}
	return true;
}

function drawSpecialBlock(opts: DrawSpecialBlockOptions): boolean {
	switch (opts.block.type) {
		case "reasoning":
		case "thinking":
			drawReasoningBlock(opts);
			return true;
		case "web_search":
			drawWebSearchBlock(opts);
			return true;
		case "image":
		case "image_generation":
			drawImageBlock(opts);
			return true;
		case "compact":
		case "segment_compact":
			drawCompactBlock(opts);
			return true;
		case "error":
			drawErrorBlock(opts);
			return true;
		case "info":
		case "tool_loaded":
		case "tool_unloaded":
			drawInfoBlock(opts);
			return true;
		case "plan":
			drawPlanBlock(opts);
			return true;
		case "merge_summary":
			drawMergeSummaryBlock(opts);
			return true;
		case "review_feedback":
			drawReviewFeedbackBlock(opts);
			return true;
		case "goal_continuation":
			drawGoalContinuationBlock(opts);
			return true;
		default:
			return false;
	}
}

export function drawPixiMessages(opts: {
	textPool: TextPool;
	iconPool: IconSpritePool;
	gfx: Graphics;
	items: PixiLaidOutItem[];
	theme: PixiMessageTheme;
	scrollTop: number;
	viewportHeight: number;
	highlightedId?: string | null;
}) {
	const { textPool, iconPool, gfx, items, theme, scrollTop, viewportHeight, highlightedId } = opts;
	gfx.clear();
	const minY = scrollTop - 240;
	const maxY = scrollTop + viewportHeight + 240;

	for (const laid of items) {
		if (laid.y + laid.height < minY || laid.y > maxY) continue;
		const y = laid.y - scrollTop;
		const item = laid.item;
		if (item.kind === "divider") {
			const midY = y + 14;
			const textWidth = measureTextWidth(item.title, DIVIDER_FONT);
			gfx.moveTo(laid.x, midY);
			gfx.lineTo(laid.x + laid.width, midY);
			gfx.stroke({ color: theme.yellow, alpha: 0.55, width: 1 });
			textPool.acquire(
				item.title,
				laid.x + (laid.width - textWidth) / 2,
				y + 2,
				SMALL_STYLE,
				theme.yellow,
			);
			continue;
		}

		const isUser = item.role === "user";
		const isTool = item.kind === "tool-run";
		const isMultiToolRun = isTool && item.blocks.length >= 2;
		const isPlainAssistant = item.role === "assistant" && item.kind !== "tool-run";
		const hasBubble = !isPlainAssistant && !isTool;
		const isSystem =
			item.role === "system" ||
			item.role === "sys" ||
			item.role === "disp" ||
			item.kind === "action";
		const bg = isUser
			? theme.userBg
			: isTool
				? theme.toolBg
				: isSystem
					? theme.systemBg
					: theme.assistantBg;
		const border = isUser
			? theme.userBorder
			: isTool
				? theme.toolBorder
				: isSystem
					? theme.systemBorder
					: theme.assistantBorder;
		if (hasBubble) {
			drawRoundRect(gfx, laid.x, y, laid.width, laid.height, 8, bg, border, isUser ? 0.95 : 0.82);
		} else if (isMultiToolRun) {
			drawRoundRect(
				gfx,
				laid.x,
				y,
				laid.width,
				laid.height,
				4,
				theme.toolBg,
				theme.toolBorder,
				0.5,
			);
		}
		if (highlightedId && item.targetIds.includes(highlightedId)) {
			gfx.roundRect(laid.x - 2, y - 2, laid.width + 4, laid.height + 4, 10);
			gfx.stroke({ color: theme.yellow, alpha: 0.95, width: 2 });
		}

		if (!isPlainAssistant && !isTool) {
			if (isUser) {
				drawUserAvatar(textPool, gfx, theme, item.title, laid.x + 16, y + 8);
			}
			textPool.acquire(
				item.title,
				isUser ? laid.x + 44 : laid.x + 16,
				y + 10,
				TITLE_STYLE,
				isUser ? theme.indigo : theme.text,
			);
			if (item.subtitle) {
				const subtitle = textPool.acquire(
					item.subtitle,
					laid.x + laid.width - 134,
					y + 10,
					SUBTITLE_STYLE,
					theme.dimmed,
				);
				subtitle.alpha = 0.85;
			}
		}

		for (const block of laid.blocks) {
			const bx = laid.x + block.x;
			let by = y + block.y;
			if (block.separatorBefore) {
				const separatorY = by - 1;
				gfx.moveTo(bx, separatorY);
				gfx.lineTo(bx + block.width, separatorY);
				gfx.stroke({ color: theme.toolBorder, alpha: 0.55, width: 1 });
			}
			if (drawToolUseBlock({ textPool, iconPool, gfx, block, bx, by, theme })) {
				continue;
			}
			if (drawSpecialBlock({ textPool, gfx, block, bx, by, theme })) {
				continue;
			}
			if (block.label) {
				const color = colorForName(theme, block.color);
				gfx.roundRect(
					bx,
					by,
					Math.min(block.width, Math.max(64, block.label.length * 7 + 18)),
					17,
					5,
				);
				gfx.fill({ color, alpha: 0.16 });
				gfx.stroke({ color, alpha: 0.5, width: 1 });
				textPool.acquire(block.label, bx + 8, by + 1, SMALL_STYLE, color);
				by += 20;
			}
			if (block.mdBlocks) {
				for (const mdBlock of block.mdBlocks) {
					drawMarkdownBlock(textPool, gfx, theme, mdBlock, bx, by);
				}
				continue;
			}
			const style =
				block.type === "bash_command" || block.type === "tool_use"
					? MONO_STYLE
					: block.type === "token_usage"
						? SMALL_STYLE
						: BODY_STYLE;
			const textColor =
				block.type === "token_usage"
					? theme.dimmed
					: block.type === "tool_use"
						? theme.text
						: theme.text;
			for (let i = 0; i < block.lines.length; i++) {
				textPool.acquire(block.lines[i].text, bx, by + i * 20, style, textColor);
			}
		}
	}
}
