/**
 * Pure drawing helpers for the PixiJS ruler layer.
 * All functions receive a PixiTheme for theme-aware rendering.
 */
import type { Graphics } from "pixi.js";
import type { PixiTheme } from "./pixi/pixi-theme";
import { themeStatusColor } from "./pixi/pixi-theme";
import type { MorphStyle } from "./zoom-tiers";

/** Linearly interpolate between two 0xRRGGBB colors. */
function lerpColor(a: number, b: number, t: number): number {
	const ar = (a >> 16) & 0xff,
		ag = (a >> 8) & 0xff,
		ab = a & 0xff;
	const br = (b >> 16) & 0xff,
		bg = (b >> 8) & 0xff,
		bb = b & 0xff;
	const r = Math.round(ar + (br - ar) * t);
	const g = Math.round(ag + (bg - ag) * t);
	const bl = Math.round(ab + (bb - ab) * t);
	return (r << 16) | (g << 8) | bl;
}

// --- Tick drawing ---

export function drawTick(
	g: Graphics,
	theme: PixiTheme,
	x: number,
	height: number,
	isActive: boolean,
	scale: number,
): void {
	const w = 2 / scale;
	const h = isActive ? Math.max(14, 20 / scale) : 14;
	const color = isActive ? theme.tickActive : theme.tickDefault;
	g.rect(x - w / 2, height - h, w, h).fill({ color, alpha: isActive ? 0.8 : 0.4 });
}

export function drawClusterBlock(
	g: Graphics,
	theme: PixiTheme,
	x: number,
	width: number,
	trackHeight: number,
	count: number,
	hasActive: boolean,
): void {
	const h = Math.min(14, 4 + count * 0.5);
	const color = hasActive ? theme.accent : theme.tickDefault;
	const alpha = hasActive ? 0.5 : 0.25;
	g.roundRect(x, trackHeight - h - 2, Math.max(width, 3), h, 2).fill({ color, alpha });
}

// --- Heatmap ---

export function drawHeatmap(
	g: Graphics,
	theme: PixiTheme,
	segments: Array<{ worldPos: number; worldSize: number; activeCount: number }>,
	trackHeight: number,
): void {
	for (const seg of segments) {
		if (seg.activeCount <= 0) continue;
		const intensity = Math.min(1, seg.activeCount / 5);
		g.rect(seg.worldPos - seg.worldSize / 2, 0, seg.worldSize, trackHeight).fill({
			color: theme.accent,
			alpha: intensity * 0.15,
		});
	}
}

// --- Morph elements (dot / pill) ---

export function drawMorph(
	g: Graphics,
	theme: PixiTheme,
	morph: MorphStyle,
	centerX: number,
	centerY: number,
	status: string,
	scale: number,
): void {
	if (morph.opacity <= 0 || morph.width <= 0) return;

	const color = themeStatusColor(theme, status);

	// Size blending: dot = screen-space (counter-scaled), card = world-space, pill = blend
	// titleOpacity: 0 at dot→pill boundary, 1 at pill→card boundary — perfect blend factor
	const isDot = morph.borderRadius >= morph.width / 2 && morph.width === morph.height;
	const screenToWorld = morph.titleOpacity; // 0 = screen-space, 1 = world-space
	const counterScale = isDot ? 1 / scale : 1 + (1 / scale - 1) * (1 - screenToWorld);
	const w = morph.width * counterScale;
	const h = morph.height * counterScale;
	const br = morph.borderRadius * counterScale;

	const left = centerX - w / 2;
	const top = centerY - h / 2;

	if (isDot) {
		g.circle(centerX, centerY, w / 2).fill({ color, alpha: morph.opacity });
	} else {
		// Rounded rect (pill phase)
		// Small pill: status color background → large pill: theme pillBg
		const bgBlend = morph.titleOpacity; // 0 = pure status color, 1 = pillBg
		const bgColor =
			bgBlend < 0.01
				? color
				: bgBlend > 0.99
					? theme.pillBg
					: lerpColor(color, theme.pillBg, bgBlend);
		const bgAlpha = morph.opacity * (0.85 + 0.15 * (1 - bgBlend)); // small pill more opaque

		g.roundRect(left, top, w, h, br).fill({
			color: bgColor,
			alpha: bgAlpha,
		});
		// Subtle border
		g.roundRect(left, top, w, h, br).stroke({
			width: 1,
			color: theme.pillBorder,
			alpha: morph.opacity * 0.5,
		});
		// Status dot inside pill
		if (morph.titleOpacity > 0) {
			const dotR = 3 * counterScale;
			g.circle(left + dotR * 3, centerY, dotR).fill({ color, alpha: morph.opacity });
		}
	}
}

// --- Connector lines ---

export function drawConnector(
	g: Graphics,
	theme: PixiTheme,
	fromMain: number,
	toMain: number,
	toCross: number,
	fromCross: number,
	isH: boolean,
	scale: number,
	opacity: number,
): void {
	if (opacity <= 0.01) return;

	const sw = 1.5 / scale;

	if (isH) {
		g.moveTo(fromMain, fromCross);
		g.quadraticCurveTo(fromMain, toCross, toMain, toCross);
	} else {
		g.moveTo(fromCross, fromMain);
		g.quadraticCurveTo(toCross, fromMain, toCross, toMain);
	}
	g.stroke({ width: sw, color: theme.accent, alpha: opacity });
}

// --- Ruler track background ---

export function drawRulerTrackBg(
	g: Graphics,
	theme: PixiTheme,
	width: number,
	height: number,
): void {
	g.rect(0, 0, width, height).fill({ color: theme.trackBg, alpha: 1 });
	g.rect(0, height - 2, width, 2).fill({ color: theme.accentBorder, alpha: 1 });
}

// --- Segment background ---

export function drawSegmentBg(
	g: Graphics,
	theme: PixiTheme,
	x: number,
	y: number,
	w: number,
	h: number,
): void {
	g.rect(x, y, w, h).fill({ color: theme.accent, alpha: 0.04 });
}
