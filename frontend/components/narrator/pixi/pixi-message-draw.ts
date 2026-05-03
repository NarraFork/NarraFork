import { type Container, type Graphics, Text, TextStyle } from "pixi.js";
import type { PixiLaidOutItem } from "./pixi-message-layout";
import type { PixiMessageTheme } from "./pixi-message-theme";

const TITLE_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 12, fontWeight: "600" });
const SUBTITLE_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 11 });
const BODY_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 14 });
const MONO_STYLE = new TextStyle({ fontFamily: "monospace", fontSize: 13 });
const SMALL_STYLE = new TextStyle({ fontFamily: "sans-serif", fontSize: 12 });

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

function addText(
	container: Container,
	text: string,
	x: number,
	y: number,
	style: TextStyle,
	color: number,
) {
	const node = new Text({ text, style });
	node.style.fill = color;
	node.x = x;
	node.y = y;
	container.addChild(node);
	return node;
}

export function drawPixiMessages(opts: {
	container: Container;
	gfx: Graphics;
	items: PixiLaidOutItem[];
	theme: PixiMessageTheme;
	scrollTop: number;
	viewportHeight: number;
	highlightedId?: string | null;
}) {
	const { container, gfx, items, theme, scrollTop, viewportHeight, highlightedId } = opts;
	container.removeChildren();
	gfx.clear();
	const minY = scrollTop - 240;
	const maxY = scrollTop + viewportHeight + 240;

	for (const laid of items) {
		if (laid.y + laid.height < minY || laid.y > maxY) continue;
		const y = laid.y - scrollTop;
		const item = laid.item;
		if (item.kind === "divider") {
			const midY = y + 14;
			gfx.moveTo(laid.x, midY);
			gfx.lineTo(laid.x + laid.width, midY);
			gfx.stroke({ color: theme.yellow, alpha: 0.55, width: 1 });
			addText(
				container,
				item.title,
				laid.x + laid.width / 2 - 60,
				y + 2,
				SMALL_STYLE,
				theme.yellow,
			);
			continue;
		}

		const isUser = item.role === "user";
		const isTool = item.kind === "tool-run";
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
		drawRoundRect(gfx, laid.x, y, laid.width, laid.height, 8, bg, border, isUser ? 0.95 : 0.82);
		if (highlightedId && item.targetIds.includes(highlightedId)) {
			gfx.roundRect(laid.x - 2, y - 2, laid.width + 4, laid.height + 4, 10);
			gfx.stroke({ color: theme.yellow, alpha: 0.95, width: 2 });
		}

		addText(
			container,
			item.title,
			laid.x + 16,
			y + 10,
			TITLE_STYLE,
			isUser ? theme.indigo : theme.text,
		);
		if (item.subtitle) {
			const subtitle = addText(
				container,
				item.subtitle,
				laid.x + laid.width - 134,
				y + 10,
				SUBTITLE_STYLE,
				theme.dimmed,
			);
			subtitle.alpha = 0.85;
		}

		for (const block of laid.blocks) {
			const bx = laid.x + block.x;
			let by = y + block.y;
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
				addText(container, block.label, bx + 8, by + 1, SMALL_STYLE, color);
				by += 20;
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
				addText(container, block.lines[i].text, bx, by + i * 20, style, textColor);
			}
		}
	}
}
