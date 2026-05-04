import { measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { type Container, Graphics, Sprite, Text, TextStyle, Texture } from "pixi.js";
import {
	getPixiAvatarTexture,
	getPixiGeneratedImageTexture,
	getPixiPreviewImageTexture,
	getPixiUploadImageTexture,
	type PixiImageTextureResult,
} from "./pixi-image-textures";
import type { MdInlineToken } from "./pixi-markdown";
import { PIXI_MESSAGE_FONT, PIXI_MESSAGE_METRICS, pixiCssFont } from "./pixi-message-constants";
import type {
	PixiLaidOutBlock,
	PixiLaidOutItem,
	PixiLaidOutMarkdownBlock,
} from "./pixi-message-layout";
import type { PixiPermissionAction } from "./pixi-message-model";
import type { PixiMessageTheme } from "./pixi-message-theme";
import { getPixiHighlightedTokens, type PixiHighlightToken } from "./pixi-shiki-highlight";
import {
	getPixiReasoningIcon,
	getPixiToolCategoryIcon,
	getPixiToolChevronIcon,
	getPixiToolStatusIcon,
	type IconSpritePool,
} from "./pixi-tabler-icons";

const TITLE_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.title,
	fontWeight: PIXI_MESSAGE_FONT.weights.semibold,
});
const SUBTITLE_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.subtitle,
});
const BODY_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.body,
});
const BODY_STRONG_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.body,
	fontWeight: PIXI_MESSAGE_FONT.weights.bold,
});
const BODY_EM_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.body,
	fontStyle: "italic",
});
const BODY_STRIKE_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.body,
});
const INLINE_CODE_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.monoFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.code,
});
const MONO_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.monoFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.code,
});
const TOOL_NAME_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.monoFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.toolName,
	fontWeight: PIXI_MESSAGE_FONT.weights.semibold,
});
const SMALL_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.small,
});
const SMALL_ITALIC_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.small,
	fontStyle: "italic",
});
const HEADING_1_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.headingSizes[1],
	fontWeight: PIXI_MESSAGE_FONT.weights.bold,
});
const HEADING_2_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.headingSizes[2],
	fontWeight: PIXI_MESSAGE_FONT.weights.bold,
});
const HEADING_3_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.headingSizes[3],
	fontWeight: PIXI_MESSAGE_FONT.weights.bold,
});
const HEADING_4_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.headingSizes[4],
	fontWeight: PIXI_MESSAGE_FONT.weights.bold,
});
const CODE_PADDING_X = PIXI_MESSAGE_METRICS.codePaddingX;
const CODE_PADDING_Y = PIXI_MESSAGE_METRICS.codePaddingY;
const CODE_LINE_H = PIXI_MESSAGE_METRICS.codeLineHeight;
const BLOCKQUOTE_INDENT = PIXI_MESSAGE_METRICS.blockquoteIndent;
const LIST_INDENT = PIXI_MESSAGE_METRICS.listIndent;
const AVATAR_INITIAL_STYLE = new TextStyle({
	fontFamily: PIXI_MESSAGE_FONT.sansFamily,
	fontSize: PIXI_MESSAGE_FONT.sizes.avatarInitial,
	fontWeight: PIXI_MESSAGE_FONT.weights.semibold,
});
const AVATAR_INITIAL_FONT = pixiCssFont(
	PIXI_MESSAGE_FONT.sizes.avatarInitial,
	PIXI_MESSAGE_FONT.sansFamily,
	PIXI_MESSAGE_FONT.weights.semibold,
);
const DIVIDER_FONT = pixiCssFont(PIXI_MESSAGE_FONT.sizes.small, PIXI_MESSAGE_FONT.sansFamily);

function parseHexColor(color?: string | null): number | null {
	if (!color) return null;
	const match = color.trim().match(/^#?([0-9a-f]{6})$/i);
	if (!match) return null;
	return Number.parseInt(match[1], 16);
}

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
	stroke: number | null,
	alpha = 1,
) {
	gfx.roundRect(x, y, w, h, r);
	gfx.fill({ color: fill, alpha });
	if (stroke !== null) {
		gfx.stroke({ color: stroke, alpha: 0.9, width: 1 });
	}
}

export class ImageSpritePool {
	private pool: Sprite[] = [];
	private maskPool: Graphics[] = [];
	private cursor = 0;

	constructor(private container: Container) {}

	reset(): void {
		this.cursor = 0;
	}

	acquire(
		texture: Texture,
		x: number,
		y: number,
		width: number,
		height: number,
		alpha = 1,
		mask?: { kind: "circle" | "roundRect"; radius: number },
	): Sprite {
		let sprite: Sprite;
		const index = this.cursor;
		if (index < this.pool.length) {
			sprite = this.pool[index];
		} else {
			sprite = new Sprite(texture);
			this.pool.push(sprite);
			this.container.addChild(sprite);
		}
		this.cursor++;
		sprite.texture = texture;
		sprite.visible = true;
		sprite.alpha = alpha;
		sprite.position.set(x, y);
		sprite.width = width;
		sprite.height = height;
		if (mask) {
			const maskGfx = this.maskForIndex(index);
			maskGfx.clear();
			if (mask.kind === "circle") {
				maskGfx.circle(x + width / 2, y + height / 2, Math.min(width, height) / 2);
			} else {
				maskGfx.roundRect(x, y, width, height, mask.radius);
			}
			maskGfx.fill({ color: 0xffffff, alpha: 1 });
			maskGfx.visible = true;
			maskGfx.renderable = true;
			sprite.mask = maskGfx;
		} else {
			sprite.mask = null;
		}
		return sprite;
	}

	releaseUnused(): void {
		for (let i = this.cursor; i < this.pool.length; i++) {
			this.pool[i].visible = false;
			this.pool[i].mask = null;
		}
		for (let i = this.cursor; i < this.maskPool.length; i++) {
			this.maskPool[i].clear();
		}
	}

	refreshTextures(): void {
		for (const sprite of this.pool) {
			sprite.texture = Texture.EMPTY;
		}
	}

	private maskForIndex(index: number): Graphics {
		let mask = this.maskPool[index];
		if (!mask) {
			mask = new Graphics();
			this.maskPool[index] = mask;
			this.container.addChild(mask);
		}
		return mask;
	}
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

	refreshTextures(): void {
		const resolution = window.devicePixelRatio || 1;
		for (const node of this.pool) {
			// Reassigning resolution marks Pixi text dirty even when the string/style is
			// unchanged. This recovers text textures after mobile browsers suspend or
			// restore the WebGL context while the app is in the background.
			node.resolution = resolution;
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

function splitInlineTokensByPretextLines(
	tokens: MdInlineToken[] | undefined,
	visualLines: Array<{ text: string }>,
): MdInlineToken[][] | null {
	if (!tokens?.length) return null;
	const result: MdInlineToken[][] = [];
	let tokenIndex = 0;
	let tokenOffset = 0;

	const peekChar = () => tokens[tokenIndex]?.text[tokenOffset];
	const consumeChars = (count: number): MdInlineToken[] => {
		const chunks: MdInlineToken[] = [];
		let remaining = count;
		while (remaining > 0 && tokenIndex < tokens.length) {
			const token = tokens[tokenIndex];
			const available = token.text.length - tokenOffset;
			const take = Math.min(remaining, available);
			const text = token.text.slice(tokenOffset, tokenOffset + take);
			if (text) chunks.push({ ...token, text });
			tokenOffset += take;
			remaining -= take;
			if (tokenOffset >= token.text.length) {
				tokenIndex++;
				tokenOffset = 0;
			}
		}
		return chunks;
	};

	for (const visualLine of visualLines) {
		while (peekChar() === "\n") consumeChars(1);
		result.push(consumeChars(visualLine.text.length));
	}
	return result;
}

function inlineStyleForToken(token: MdInlineToken, baseStyle: TextStyle): TextStyle {
	if (token.kind === "code") return INLINE_CODE_STYLE;
	if (token.kind === "strong" && baseStyle === BODY_STYLE) return BODY_STRONG_STYLE;
	if (token.kind === "em" && baseStyle === BODY_STYLE) return BODY_EM_STYLE;
	if (token.kind === "delete") return BODY_STRIKE_STYLE;
	return baseStyle;
}

function inlineColorForToken(
	token: MdInlineToken,
	theme: PixiMessageTheme,
	baseColor: number,
): number {
	if (token.kind === "link") return theme.blue;
	if (token.kind === "code") return theme.text;
	if (token.kind === "delete") return theme.dimmed;
	return baseColor;
}

function drawInlineMarkdownTextLines(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	mdBlock: PixiLaidOutMarkdownBlock,
	x: number,
	y: number,
	style: TextStyle,
	color: number,
) {
	const tokenLines = splitInlineTokensByPretextLines(mdBlock.inlineTokens, mdBlock.lines);
	for (let i = 0; i < mdBlock.lines.length; i++) {
		const lineY = y + i * mdBlock.lineHeight;
		const lineTokens = tokenLines?.[i];
		if (!lineTokens?.length) {
			textPool.acquire(mdBlock.lines[i].text, x, lineY, style, color);
			continue;
		}
		let tokenX = x;
		for (const token of lineTokens) {
			if (!token.text) continue;
			const tokenStyle = inlineStyleForToken(token, style);
			const tokenColor = inlineColorForToken(token, theme, color);
			const advance =
				token.kind === "code"
					? measureMonoAdvance(token.text, tokenStyle)
					: textWidth(token.text, tokenStyle);
			if (token.kind === "code") {
				gfx.roundRect(tokenX - 3, lineY + 1, advance + 6, Math.max(14, mdBlock.lineHeight - 4), 4);
				gfx.fill({ color: theme.toolBg, alpha: 0.9 });
				gfx.stroke({ color: theme.toolBorder, alpha: 0.42, width: 1 });
			}
			textPool.acquire(token.text, tokenX, lineY, tokenStyle, tokenColor);
			if (token.kind === "link") {
				const underlineY = lineY + mdBlock.lineHeight - 4;
				gfx.moveTo(tokenX, underlineY);
				gfx.lineTo(tokenX + advance, underlineY);
				gfx.stroke({ color: tokenColor, alpha: 0.55, width: 1 });
			} else if (token.kind === "delete") {
				const strikeY = lineY + mdBlock.lineHeight / 2;
				gfx.moveTo(tokenX, strikeY);
				gfx.lineTo(tokenX + advance, strikeY);
				gfx.stroke({ color: tokenColor, alpha: 0.7, width: 1 });
			}
			tokenX += advance;
		}
	}
}

function drawMarkdownTextLines(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	mdBlock: PixiLaidOutMarkdownBlock,
	x: number,
	y: number,
	style: TextStyle,
	color: number,
) {
	drawInlineMarkdownTextLines(textPool, gfx, theme, mdBlock, x, y, style, color);
}

function drawMarkdownCodeBlock(
	textPool: TextPool,
	theme: PixiMessageTheme,
	mdBlock: PixiLaidOutMarkdownBlock,
	x: number,
	y: number,
): void {
	const highlighted = getPixiHighlightedTokens(mdBlock.text || " ", mdBlock.lang, shikiThemeName());
	const highlightedVisualLines = splitTokensByPretextLines(highlighted, mdBlock.lines);
	for (let i = 0; i < mdBlock.lines.length; i++) {
		drawTokenLine(
			textPool,
			mdBlock.lines[i].text || " ",
			highlightedVisualLines?.[i],
			x + CODE_PADDING_X,
			y + CODE_PADDING_Y + i * CODE_LINE_H,
			theme.text,
		);
	}
}

function truncateCell(text: string, maxChars: number): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > maxChars
		? `${singleLine.slice(0, Math.max(1, maxChars - 1))}…`
		: singleLine;
}

function drawMarkdownTable(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	mdBlock: PixiLaidOutMarkdownBlock,
	x: number,
	y: number,
): void {
	if (!mdBlock.table) return;
	const rowH = 26;
	const cellPadX = 8;
	const headers = mdBlock.table.headers;
	const rows = mdBlock.table.rows;
	const columnWidths = mdBlock.table.columnWidths;

	gfx.roundRect(x, y, mdBlock.width, mdBlock.height, 6);
	gfx.fill({ color: theme.panelBg, alpha: 0.42 });
	gfx.stroke({ color: theme.toolBorder, alpha: 0.58, width: 1 });
	gfx.rect(x, y, mdBlock.width, rowH);
	gfx.fill({ color: theme.toolBg, alpha: 0.82 });

	const drawRow = (cells: string[], rowIndex: number, header = false) => {
		const rowY = y + rowIndex * rowH;
		if (!header && rowIndex % 2 === 0) {
			gfx.rect(x + 1, rowY, mdBlock.width - 2, rowH);
			gfx.fill({ color: theme.toolBg, alpha: 0.22 });
		}
		let cellX = x;
		for (let i = 0; i < columnWidths.length; i++) {
			const cellW = columnWidths[i];
			if (i > 0) {
				gfx.moveTo(cellX, rowY);
				gfx.lineTo(cellX, rowY + rowH);
				gfx.stroke({ color: theme.toolBorder, alpha: 0.35, width: 1 });
			}
			const text = truncateCell(
				cells[i] ?? "",
				Math.max(4, Math.floor((cellW - cellPadX * 2) / 7)),
			);
			textPool.acquire(
				text,
				cellX + cellPadX,
				rowY + 5,
				header ? TOOL_NAME_STYLE : SMALL_STYLE,
				header ? theme.text : theme.dimmed,
			);
			cellX += cellW;
		}
		gfx.moveTo(x, rowY + rowH);
		gfx.lineTo(x + mdBlock.width, rowY + rowH);
		gfx.stroke({ color: theme.toolBorder, alpha: 0.35, width: 1 });
	};

	drawRow(headers, 0, true);
	for (let i = 0; i < rows.length; i++) drawRow(rows[i], i + 1);
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
		case "heading": {
			if ((mdBlock.level ?? 6) <= 2) {
				gfx.roundRect(x, y + 4, 3, Math.max(12, mdBlock.height - 8), 2);
				gfx.fill({ color: theme.accent, alpha: 0.85 });
				drawMarkdownTextLines(
					textPool,
					gfx,
					theme,
					mdBlock,
					x + 10,
					y,
					styleForHeading(mdBlock.level),
					theme.text,
				);
			} else {
				drawMarkdownTextLines(
					textPool,
					gfx,
					theme,
					mdBlock,
					x,
					y,
					styleForHeading(mdBlock.level),
					theme.text,
				);
			}
			break;
		}
		case "paragraph":
			drawMarkdownTextLines(textPool, gfx, theme, mdBlock, x, y, BODY_STYLE, theme.text);
			break;
		case "code":
			gfx.roundRect(x, y, mdBlock.width, mdBlock.height, 6);
			gfx.fill({ color: theme.toolBg, alpha: 0.88 });
			gfx.stroke({ color: theme.toolBorder, alpha: 0.58, width: 1 });
			drawMarkdownCodeBlock(textPool, theme, mdBlock, x, y);
			break;
		case "blockquote":
			gfx.roundRect(x, y + 1, 3, Math.max(1, mdBlock.height - 2), 2);
			gfx.fill({ color: theme.dimmed, alpha: 0.72 });
			drawMarkdownTextLines(
				textPool,
				gfx,
				theme,
				mdBlock,
				x + BLOCKQUOTE_INDENT,
				y,
				BODY_STYLE,
				theme.dimmed,
			);
			break;
		case "list-item": {
			const marker = mdBlock.ordered ? `${mdBlock.index ?? 1}.` : "•";
			if (mdBlock.checked !== undefined) {
				gfx.roundRect(x + 1, y + 4, 12, 12, 3);
				gfx.stroke({ color: mdBlock.checked ? theme.green : theme.dimmed, alpha: 0.75, width: 1 });
				if (mdBlock.checked) {
					gfx.moveTo(x + 4, y + 10);
					gfx.lineTo(x + 7, y + 13);
					gfx.lineTo(x + 13, y + 6);
					gfx.stroke({ color: theme.green, alpha: 0.95, width: 1.5 });
				}
			} else {
				textPool.acquire(marker, x, y, BODY_STYLE, theme.dimmed);
			}
			drawMarkdownTextLines(
				textPool,
				gfx,
				theme,
				mdBlock,
				x + LIST_INDENT,
				y,
				BODY_STYLE,
				theme.text,
			);
			break;
		}
		case "table":
			drawMarkdownTable(textPool, gfx, theme, mdBlock, x, y);
			break;
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
	imagePool: ImageSpritePool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	item: PixiLaidOutItem["item"],
	x: number,
	y: number,
) {
	const bg = parseHexColor(item.creator?.avatarColor) ?? theme.indigo;
	gfx.circle(x + 10, y + 10, 10);
	gfx.fill({ color: bg, alpha: 1 });

	const { texture, status } = getPixiAvatarTexture(item.creator?.id, item.creator?.avatarImageId);
	if (texture && texture !== Texture.EMPTY) {
		imagePool.acquire(texture, x, y, 20, 20, 1, { kind: "circle", radius: 10 });
		return;
	}

	const initial = (item.creator?.username ?? item.title).trim().charAt(0).toUpperCase() || "U";
	const initialWidth = measureTextWidth(initial, AVATAR_INITIAL_FONT);
	textPool.acquire(initial, x + (20 - initialWidth) / 2, y + 3, AVATAR_INITIAL_STYLE, 0xffffff);
	if (status === "loading") {
		gfx.circle(x + 17, y + 17, 2);
		gfx.fill({ color: 0xffffff, alpha: 0.72 });
	} else if (status === "failed") {
		gfx.circle(x + 17, y + 17, 2);
		gfx.fill({ color: theme.red, alpha: 0.95 });
	}
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
	const fontStyle = style.fontStyle ? `${style.fontStyle} ` : "";
	const fontWeight = style.fontWeight ? `${style.fontWeight} ` : "";
	return measureTextWidth(text, `${fontStyle}${fontWeight}${fontSize}px ${family ?? "sans-serif"}`);
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
	const { textPool, iconPool, gfx, block, bx, by, theme } = opts;
	const opened = block.reasoningExpanded === true && !!block.text.trim();
	const thinking = block.reasoningStreaming === true && !block.text.trim();
	const label = thinking
		? `${block.reasoningThinkingLabel ?? "Thinking"}…`
		: (block.reasoningLabel ?? "Reasoning");
	const headerY = by + 2;

	iconPool.acquire(
		getPixiToolChevronIcon(opened, theme.dimmed, 12),
		bx,
		by + 4,
		12,
		thinking ? 0.5 : 1,
	);

	gfx.roundRect(bx + 11, headerY, 16, 16, 4);
	gfx.fill({ color: theme.grape, alpha: 0.16 });
	iconPool.acquire(getPixiReasoningIcon(theme.grape, 10), bx + 14, by + 5, 10);

	const labelStyle = thinking ? SMALL_ITALIC_STYLE : SMALL_STYLE;
	textPool.acquire(label, bx + 31, headerY, labelStyle, theme.dimmed);
	let nextX = bx + 31 + textWidth(label, labelStyle);

	if (!thinking && !block.reasoningEncrypted && block.reasoningCharsLabel) {
		nextX += 6;
		const charsNode = textPool.acquire(
			block.reasoningCharsLabel,
			nextX,
			headerY,
			SMALL_STYLE,
			theme.dimmed,
		);
		charsNode.alpha = 0.5;
		nextX += textWidth(block.reasoningCharsLabel, SMALL_STYLE);
	}

	if (!opened && !thinking) {
		const previewX = nextX + 8;
		const available = Math.max(0, bx + block.width - previewX);
		const maxChars = Math.max(0, Math.floor(available / 6.5));
		if (maxChars > 8) {
			const preview = `— ${compactText(block.text, Math.min(80, maxChars))}`;
			const previewNode = textPool.acquire(preview, previewX, headerY, SMALL_STYLE, theme.dimmed);
			previewNode.alpha = 0.6;
		}
		return;
	}

	if (!opened) return;

	const contentY = by + 25;
	const contentH = Math.max(1, block.height - 29);
	gfx.roundRect(bx, contentY, 2, contentH, 1);
	gfx.fill({ color: theme.grape, alpha: 0.68 });
	for (let i = 0; i < block.lines.length; i++) {
		const node = textPool.acquire(
			block.lines[i].text,
			bx + 16,
			contentY + 4 + i * 17,
			SMALL_STYLE,
			theme.dimmed,
		);
		node.alpha = 0.75;
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

function textureForImageBlock(block: PixiLaidOutBlock): PixiImageTextureResult {
	if (block.type === "image_generation") {
		return getPixiGeneratedImageTexture({
			result: block.imageSrc,
			savedPath: block.imageSavedPath,
		});
	}
	const preview = getPixiPreviewImageTexture(block.imageSrc);
	if (preview.status !== "idle") return preview;
	return getPixiUploadImageTexture(block.imageUploadNarratorId, block.imageId);
}

function drawImageBlock(opts: DrawSpecialBlockOptions) {
	const { textPool, imagePool, gfx, block, bx, by, theme } = opts;
	const textureResult = textureForImageBlock(block);
	const texture = textureResult.texture;
	const maxWidth = Math.min(block.width, 512);
	const maxHeight = block.height;
	const label = block.type === "image_generation" ? "Generated image" : "Attached image";

	if (texture && texture !== Texture.EMPTY && texture.width > 0 && texture.height > 0) {
		const scale = Math.min(maxWidth / texture.width, maxHeight / texture.height, 1);
		const drawWidth = Math.max(1, texture.width * scale);
		const drawHeight = Math.max(1, texture.height * scale);
		const x = bx + Math.max(0, (block.width - drawWidth) / 2);
		const y = by + Math.max(0, (block.height - drawHeight) / 2);
		gfx.roundRect(x, y, drawWidth, drawHeight, 6);
		gfx.fill({ color: theme.systemBg, alpha: 0.3 });
		gfx.stroke({ color: theme.systemBorder, alpha: 0.55, width: 1 });
		imagePool.acquire(texture, x, y, drawWidth, drawHeight, 1, { kind: "roundRect", radius: 6 });
		return;
	}

	const width = Math.min(240, block.width);
	const height = Math.min(140, block.height);
	const x = bx + Math.max(0, (block.width - width) / 2);
	const y = by + Math.max(0, (block.height - height) / 2);
	gfx.roundRect(x, y, width, height, 6);
	gfx.fill({ color: theme.systemBg, alpha: 0.35 });
	drawDashedRect(gfx, x, y, width, height, theme.dimmed);
	const statusLabel =
		textureResult.status === "loading"
			? "Loading image"
			: textureResult.status === "failed"
				? `Image failed: ${textureResult.error ?? "unknown"}`
				: block.imageFilename || block.text || label;
	const text = `📷 ${compactText(statusLabel, 42)}`;
	textPool.acquire(
		text,
		centeredTextX(text, x, width, SMALL_STYLE),
		y + height / 2 - 8,
		SMALL_STYLE,
		textureResult.status === "failed" ? theme.red : theme.dimmed,
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

export interface PixiMessageHitTarget {
	id: string;
	kind: "permission-action";
	permissionId: string;
	action: PixiPermissionAction;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface DrawSpecialBlockOptions {
	textPool: TextPool;
	iconPool: IconSpritePool;
	imagePool: ImageSpritePool;
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

function drawPermissionButton(
	textPool: TextPool,
	gfx: Graphics,
	theme: PixiMessageTheme,
	label: string,
	x: number,
	y: number,
	width: number,
	height: number,
	colorName: string | undefined,
	variant: string | undefined,
	hovered: boolean,
): void {
	const color = colorForName(theme, colorName);
	const filled = variant !== "light";
	gfx.roundRect(x, y, width, height, 5);
	gfx.fill({ color, alpha: filled ? (hovered ? 0.32 : 0.24) : hovered ? 0.16 : 0.08 });
	gfx.stroke({ color, alpha: hovered ? 0.92 : 0.48, width: hovered ? 1.5 : 1 });
	const textW = textWidth(label, SMALL_STYLE);
	textPool.acquire(label, x + Math.max(8, (width - textW) / 2), y + 4, SMALL_STYLE, color);
}

function shikiThemeName(): string {
	return document.documentElement.getAttribute("data-mantine-color-scheme") === "light"
		? "github-light-default"
		: "github-dark-default";
}

const splitTokenLineCache = new WeakMap<
	PixiHighlightToken[][],
	Map<string, PixiHighlightToken[][]>
>();
const MAX_SPLIT_TOKEN_LINE_CACHE = 80;

function flattenHighlightedTokens(lines: PixiHighlightToken[][]): PixiHighlightToken[] {
	const out: PixiHighlightToken[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push({ content: "\n" });
		out.push(...lines[i]);
	}
	return out;
}

function visualLinesCacheKey(visualLines: Array<{ text: string }>): string {
	return visualLines.map((line) => line.text).join("\u0000");
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
	const cacheKey = visualLinesCacheKey(visualLines);
	const tokenCache = splitTokenLineCache.get(highlighted);
	const cached = tokenCache?.get(cacheKey);
	if (cached) return cached;

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

	let nextTokenCache = tokenCache;
	if (!nextTokenCache) {
		nextTokenCache = new Map<string, PixiHighlightToken[][]>();
		splitTokenLineCache.set(highlighted, nextTokenCache);
	}
	nextTokenCache.set(cacheKey, result);
	if (nextTokenCache.size > MAX_SPLIT_TOKEN_LINE_CACHE) {
		const first = nextTokenCache.keys().next().value;
		if (first !== undefined) nextTokenCache.delete(first);
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

function getGrepOutputTokens(text: string, theme: PixiMessageTheme): PixiHighlightToken[][] {
	return text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			if (line === "--") return [{ content: line, color: theme.dimmed }];

			const match = line.match(/^(.*?)([:-])(\d+)([:-])(.*)$/);
			if (!match) {
				return [{ content: line, color: line.startsWith("(") ? theme.dimmed : theme.text }];
			}

			const [, filePath, firstSep, lineNo, secondSep, content] = match;
			const isMatchLine = firstSep === ":" || secondSep === ":";
			return [
				{ content: filePath, color: theme.cyan },
				{ content: firstSep, color: theme.dimmed },
				{ content: lineNo, color: theme.yellow },
				{ content: secondSep, color: theme.dimmed },
				{ content, color: isMatchLine ? theme.text : theme.dimmed },
			];
		});
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
	const isGrepOutput = block.lang === "grep-output";
	const highlighted = isGrepOutput
		? getGrepOutputTokens(block.text ?? "", theme)
		: getPixiHighlightedTokens(block.text ?? "", block.lang, shikiThemeName());
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
		textY += CODE_LINE_H;
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
	y += CODE_PADDING_Y;
	for (const line of block.diffLines ?? []) {
		const prefix = line.type === "removed" ? "-" : line.type === "added" ? "+" : " ";
		const color =
			line.type === "removed" ? theme.red : line.type === "added" ? theme.green : theme.dimmed;
		const rowHeight = Math.max(1, line.lines.length) * CODE_LINE_H;
		if (line.type === "removed" || line.type === "added") {
			gfx.rect(x + 1, y - 1, block.width - 2, rowHeight);
			gfx.fill({ color, alpha: 0.08 });
		}
		const linePrefix = block.lineNumberPrefix ?? "";
		const oldNo = line.oldNo != null ? `${linePrefix}${line.oldNo}`.padStart(3) : "   ";
		const newNo = line.newNo != null ? `${linePrefix}${line.newNo}`.padStart(3) : "   ";
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
			lineY += CODE_LINE_H;
		}
		y += Math.max(1, line.lines.length) * CODE_LINE_H;
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
	hitTargets?: PixiMessageHitTarget[],
	hoveredHitTargetId?: string | null,
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
	if (block.kind === "permission-panel") {
		const x = bx + block.x;
		const y = by + block.y;
		gfx.roundRect(x, y, block.width, block.height, 7);
		gfx.fill({ color: theme.yellow, alpha: 0.08 });
		gfx.stroke({ color: theme.yellow, alpha: 0.55, width: 1 });
		textPool.acquire("Awaiting approval", x + 8, y + 7, TOOL_NAME_STYLE, theme.yellow);
		const toolLabel = block.permissionToolName ? ` ${block.permissionToolName}` : "";
		textPool.acquire(toolLabel, x + 128, y + 7, SMALL_STYLE, theme.dimmed);
		const lines = block.lines ?? [];
		const planLineCount = block.permissionPlanLineCount ?? 0;
		const reasonLineCount = Math.max(0, lines.length - planLineCount);
		let textY = y + 28;
		for (const line of lines.slice(0, reasonLineCount)) {
			textPool.acquire(line.text, x + 8, textY, SMALL_STYLE, theme.dimmed);
			textY += 17;
		}
		if (planLineCount > 0) {
			const planLines = lines.slice(reasonLineCount);
			const panelY = textY + 2;
			const panelH = CODE_PADDING_Y * 2 + Math.max(CODE_LINE_H, planLines.length * CODE_LINE_H);
			gfx.roundRect(x + 8, panelY, block.width - 16, panelH, 5);
			gfx.fill({ color: theme.panelBg, alpha: 0.42 });
			gfx.stroke({ color: theme.yellow, alpha: 0.2, width: 1 });
			for (let i = 0; i < planLines.length; i++) {
				textPool.acquire(
					planLines[i].text,
					x + 8 + CODE_PADDING_X,
					panelY + CODE_PADDING_Y + i * CODE_LINE_H,
					MONO_STYLE,
					theme.text,
				);
			}
		}
		for (const action of block.permissionActions ?? []) {
			const targetId = `${block.permissionId}:${action.action}`;
			const ax = bx + action.x;
			const ay = by + action.y;
			drawPermissionButton(
				textPool,
				gfx,
				theme,
				action.label,
				ax,
				ay,
				action.width,
				action.height,
				action.color,
				action.variant,
				hoveredHitTargetId === targetId,
			);
			if (block.permissionId) {
				hitTargets?.push({
					id: targetId,
					kind: "permission-action",
					permissionId: block.permissionId,
					action: action.action,
					x: ax,
					y: ay,
					width: action.width,
					height: action.height,
				});
			}
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

function drawToolUseBlock(
	opts: DrawSpecialBlockOptions & {
		iconPool: IconSpritePool;
		hitTargets?: PixiMessageHitTarget[];
		hoveredHitTargetId?: string | null;
	},
): boolean {
	const { textPool, iconPool, gfx, block, bx, by, theme, hitTargets, hoveredHitTargetId } = opts;
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
		drawToolDetailBlock(textPool, gfx, theme, detailBlock, bx, by, hitTargets, hoveredHitTargetId);
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

function firstVisibleItemIndex(items: PixiLaidOutItem[], minY: number): number {
	let lo = 0;
	let hi = items.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const item = items[mid];
		if (item.y + item.height < minY) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

export function drawPixiMessages(opts: {
	textPool: TextPool;
	iconPool: IconSpritePool;
	imagePool: ImageSpritePool;
	gfx: Graphics;
	items: PixiLaidOutItem[];
	theme: PixiMessageTheme;
	scrollTop: number;
	viewportHeight: number;
	highlightedId?: string | null;
	bufferPx?: number;
	hitTargets?: PixiMessageHitTarget[];
	hoveredHitTargetId?: string | null;
}) {
	const {
		textPool,
		iconPool,
		imagePool,
		gfx,
		items,
		theme,
		scrollTop,
		viewportHeight,
		highlightedId,
		bufferPx = 240,
		hitTargets,
		hoveredHitTargetId,
	} = opts;
	gfx.clear();
	if (hitTargets) hitTargets.length = 0;
	const minY = scrollTop - bufferPx;
	const maxY = scrollTop + viewportHeight + bufferPx;

	for (let itemIndex = firstVisibleItemIndex(items, minY); itemIndex < items.length; itemIndex++) {
		const laid = items[itemIndex];
		if (laid.y > maxY) break;
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
			drawRoundRect(
				gfx,
				laid.x,
				y,
				laid.width,
				laid.height,
				8,
				bg,
				isUser ? null : border,
				isUser ? theme.userBgAlpha : 0.82,
			);
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
			const headerX = isUser ? laid.x + 12 : laid.x + 16;
			const headerY = y + 12;
			const titleX = isUser ? headerX + 26 : headerX;
			if (isUser) {
				drawUserAvatar(textPool, imagePool, gfx, theme, item, headerX, headerY);
			}
			textPool.acquire(
				item.title,
				titleX,
				headerY + 2,
				TITLE_STYLE,
				isUser ? theme.indigo : theme.text,
			);
			if (item.subtitle) {
				const subtitleText = item.subtitle;
				const subtitleWidth = measureNaturalWidth(
					prepareWithSegments(subtitleText, DIVIDER_FONT, { whiteSpace: "pre-wrap" }),
				);
				const subtitle = textPool.acquire(
					subtitleText,
					laid.x + laid.width - subtitleWidth - 12,
					headerY + 2,
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
			if (
				drawToolUseBlock({
					textPool,
					iconPool,
					imagePool,
					gfx,
					block,
					bx,
					by,
					theme,
					hitTargets,
					hoveredHitTargetId,
				})
			) {
				continue;
			}
			if (drawSpecialBlock({ textPool, iconPool, imagePool, gfx, block, bx, by, theme })) {
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
