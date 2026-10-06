/**
 * Pure drawing helpers for the PixiJS ruler layer.
 * All functions receive a PixiTheme for theme-aware rendering.
 */
import { CanvasTextMetrics, Container, Graphics, Text, type TextStyle } from "pixi.js";
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
	isH = true,
	edge: "start" | "end" = "start",
): void {
	const s = Math.max(0.1, scale);
	// Wider ticks (3/s vs old 2/s) to stay visible after decimation increases spacing
	const w = Math.min(6, 3 / s);
	const h = isActive ? Math.min(20, Math.max(14, 20 / s)) : 14;
	const color = isActive ? theme.tickActive : theme.tickDefault;
	const alpha = isActive ? 0.8 : 0.4;
	// edge="start": ticks grow inward from the far end (height-h)
	// edge="end":   ticks grow inward from the near end (0)
	const crossPos = edge === "start" ? height - h : 0;
	if (isH) {
		g.rect(x - w / 2, crossPos, w, h).fill({ color, alpha });
	} else {
		g.rect(crossPos, x - w / 2, h, w).fill({ color, alpha });
	}
}

// --- Density bar (replaces cluster blocks + heatmap) ---

/** Screen-space density data for a single retained tick. */
export interface DensityBarEntry {
	screenX: number;
	screenGapToNext: number;
	skippedCount: number;
}

/**
 * Draw a thin density bar along the ruler track edge.
 * Intensity = number of skipped (decimated) commits between retained ticks.
 * Replaces the old cluster block + heatmap rendering.
 */
export function drawDensityBar(
	g: Graphics,
	theme: PixiTheme,
	entries: DensityBarEntry[],
	trackHeight: number,
	isH = true,
	edge: "start" | "end" = "start",
): void {
	if (entries.length < 2) return;

	const barH = 3;
	// edge="start": bar at far end (near chapter area); edge="end": bar at near end
	const crossPos = edge === "start" ? trackHeight - barH - 1 : 1;

	for (let i = 0; i < entries.length - 1; i++) {
		const e = entries[i];
		if (e.skippedCount <= 0) continue;

		// Density: skipped commits per screen pixel
		const density = e.screenGapToNext > 0 ? e.skippedCount / e.screenGapToNext : 0;
		// Map density to alpha: 0 → 0.05, high → 0.4
		const alpha = Math.min(0.4, 0.05 + density * 8);
		if (alpha < 0.06) continue;

		const segW = e.screenGapToNext;
		if (segW <= 0) continue;

		if (isH) {
			g.rect(e.screenX, crossPos, segW, barH).fill({
				color: theme.accent,
				alpha,
			});
		} else {
			g.rect(crossPos, e.screenX, barH, segW).fill({
				color: theme.accent,
				alpha,
			});
		}
	}
}

// --- Unified chapter node drawing (dot → pill → card) ---

/**
 * Draw a chapter node as a single continuous shape.
 * The `morph.cardBlend` value controls how much "card-ness" is visible:
 *   0 = pure dot/pill, 1 = full card with border + shadow.
 *
 * This replaces the old dual-path drawMorph + drawCard crossfade.
 */
export function drawChapterNode(
	g: Graphics,
	theme: PixiTheme,
	morph: MorphStyle,
	x: number,
	y: number,
	w: number,
	h: number,
	status: string,
	role: string,
): void {
	if (morph.opacity <= 0 || w <= 0 || h <= 0) return;

	const statusColor = themeStatusColor(theme, status);
	const cb = morph.cardBlend;
	const br = morph.borderRadius;
	const alpha = morph.opacity;

	const isDot = br >= w / 2 && Math.abs(w - h) < 0.5;

	if (isDot) {
		// Pure circle — early return
		g.circle(x + w / 2, y + h / 2, w / 2).fill({ color: statusColor, alpha });
		return;
	}

	// Background: blend from statusColor (pill) → cardBg (card)
	const bgColor =
		cb < 0.01 ? statusColor : cb > 0.99 ? theme.cardBg : lerpColor(statusColor, theme.cardBg, cb);
	// Small pill is slightly more opaque; card is 0.95
	const bgAlpha = alpha * (0.85 + 0.1 * cb);

	g.roundRect(x, y, w, h, br).fill({ color: bgColor, alpha: bgAlpha });

	// Border: blends from subtle pill border → card border
	const isActive = status === "active";
	const isReview = role === "review";
	const pillBorderAlpha = alpha * 0.5 * (1 - cb);
	const cardBorderAlpha = alpha * 0.7 * cb;

	// Pill border (fades out as card appears)
	if (pillBorderAlpha > 0.01) {
		g.roundRect(x, y, w, h, br).stroke({
			width: 1,
			color: theme.pillBorder,
			alpha: pillBorderAlpha,
		});
	}

	// Card border (fades in)
	if (cardBorderAlpha > 0.01) {
		const borderColor = isReview
			? theme.cardReviewBorder
			: isActive
				? theme.cardActiveBorder
				: theme.cardBorder;
		const borderWidth = isReview || isActive ? 1.5 : 1;

		if (isReview) {
			// Dashed border approximation
			const dashLen = 6;
			const gapLen = 4;
			const perimeter = 2 * (w + h);
			let d = 0;
			while (d < perimeter) {
				const end = Math.min(d + dashLen, perimeter);
				const [x1, y1] = perimeterPoint(x, y, w, h, br, d);
				const [x2, y2] = perimeterPoint(x, y, w, h, br, end);
				g.moveTo(x1, y1)
					.lineTo(x2, y2)
					.stroke({ width: borderWidth, color: borderColor, alpha: cardBorderAlpha });
				d = end + gapLen;
			}
		} else {
			g.roundRect(x, y, w, h, br).stroke({
				width: borderWidth,
				color: borderColor,
				alpha: cardBorderAlpha,
			});
		}
	}

	// Status dot inside pill (visible when title shows but card hasn't fully taken over)
	if (morph.titleOpacity > 0 && cb < 0.95) {
		const dotR = 3;
		const dotAlpha = alpha * morph.titleOpacity * (1 - cb);
		g.circle(x + dotR * 3, y + h / 2, dotR).fill({ color: statusColor, alpha: dotAlpha });
	}

	// Shadow (fades in with card)
	if (cb > 0.1) {
		g.roundRect(x + 1, y + 1, w, h, br).fill({
			color: 0x000000,
			alpha: alpha * (cb - 0.1) * 0.09,
		});
	}
}

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
	isH = true,
	edge: "start" | "end" = "start",
): void {
	// Border sits on the side facing the chapter area:
	// edge="start" → border at far end (height-2); edge="end" → border at near end (0).
	const borderAtFar = edge === "start";
	if (isH) {
		g.rect(0, 0, width, height).fill({ color: theme.trackBg, alpha: 1 });
		g.rect(0, borderAtFar ? height - 2 : 0, width, 2).fill({ color: theme.accentBorder, alpha: 1 });
	} else {
		g.rect(0, 0, height, width).fill({ color: theme.trackBg, alpha: 1 });
		g.rect(borderAtFar ? height - 2 : 0, 0, 2, width).fill({ color: theme.accentBorder, alpha: 1 });
	}
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

/** Get a point along the perimeter of a rect (simplified, ignores rounded corners). */
function perimeterPoint(
	x: number,
	y: number,
	w: number,
	h: number,
	_br: number,
	d: number,
): [number, number] {
	const p = 2 * (w + h);
	d = d % p;
	if (d < w) return [x + d, y];
	d -= w;
	if (d < h) return [x + w, y + d];
	d -= h;
	if (d < w) return [x + w - d, y + h];
	d -= w;
	return [x, y + h - d];
}

// ---------------------------------------------------------------------------
// TextPool — reusable PixiJS Text object pool with cursor-based management
// ---------------------------------------------------------------------------

/**
 * Manages a pool of PixiJS Text objects attached to a Container.
 * Call `acquire(style)` to get a Text object (reused or newly created),
 * then call `flush()` at the end of each frame to hide unused texts.
 *
 * Replaces the manual `getPooledText` + `hidePooledTexts` + index tracking pattern.
 */
export class TextPool {
	private pool: Text[] = [];
	private cursor = 0;

	constructor(private container: Container) {}

	/** Get the next available Text object, creating one if the pool is exhausted. */
	acquire(style: TextStyle): Text {
		if (this.cursor < this.pool.length) {
			const t = this.pool[this.cursor];
			t.visible = true;
			if (t.style !== style) t.style = style;
			this.cursor++;
			return t;
		}
		const t = new Text({ text: "", style });
		this.pool.push(t);
		this.container.addChild(t);
		this.cursor++;
		return t;
	}

	/** Hide all texts from cursor onwards and reset cursor for the next frame. */
	flush(): void {
		for (let i = this.cursor; i < this.pool.length; i++) {
			this.pool[i].visible = false;
		}
		this.cursor = 0;
	}

	/** Current number of acquired texts this frame. */
	get count(): number {
		return this.cursor;
	}
}

// ---------------------------------------------------------------------------
// Activity badge + tooltip for collapsed chapters
// ---------------------------------------------------------------------------

/** Activity info passed from the hook to the PixiJS draw layer. */
export interface PixiActivityInfo {
	count: number;
	lastText: string;
	lastToolName: string | null;
	timestamp: number;
}

/** Duration (ms) the tooltip stays fully visible after the last activity. */
const TOOLTIP_VISIBLE_MS = 5000;
/** Duration (ms) for the tooltip fade-out. */
const TOOLTIP_FADE_MS = 1500;

/**
 * Draw a small red notification badge at the top-right corner of a chapter node.
 * Returns the badge center position for tooltip anchoring.
 */
export function drawActivityBadge(
	g: Graphics,
	pool: TextPool,
	badgeStyle: TextStyle,
	activity: PixiActivityInfo,
	nodeX: number,
	nodeY: number,
	nodeW: number,
	_nodeH: number,
	opacity: number,
): { cx: number; cy: number } | null {
	if (activity.count <= 0 || opacity <= 0.01) return null;

	const countStr = activity.count > 99 ? "99+" : String(activity.count);
	const r = countStr.length > 2 ? 10 : 7;
	const cx = nodeX + nodeW - 2;
	const cy = nodeY - 2;

	// Red circle
	g.circle(cx, cy, r).fill({ color: 0xe03131, alpha: opacity * 0.95 });

	// Count text
	const label = pool.acquire(badgeStyle);
	label.text = countStr;
	label.alpha = opacity;
	label.scale.set(1);
	// Center the text in the badge
	const textW = countStr.length * 5.5;
	label.position.set(cx - textW / 2, cy - 5);

	return { cx, cy };
}

/**
 * Draw a tooltip bubble above a chapter node showing the latest activity text.
 * Fades out after TOOLTIP_VISIBLE_MS + TOOLTIP_FADE_MS from the last activity.
 */
export function drawActivityTooltip(
	g: Graphics,
	pool: TextPool,
	style: TextStyle,
	activity: PixiActivityInfo,
	anchorX: number,
	anchorY: number,
	nodeW: number,
	opacity: number,
	now: number,
): void {
	const elapsed = now - activity.timestamp;
	if (elapsed > TOOLTIP_VISIBLE_MS + TOOLTIP_FADE_MS) return;

	let fadeAlpha = 1;
	if (elapsed > TOOLTIP_VISIBLE_MS) {
		fadeAlpha = 1 - (elapsed - TOOLTIP_VISIBLE_MS) / TOOLTIP_FADE_MS;
	}
	const alpha = opacity * fadeAlpha;
	if (alpha <= 0.01) return;

	const text = activity.lastToolName ? `🔧 ${activity.lastToolName}` : activity.lastText;
	if (!text) return;

	// Measure & truncate using CanvasTextMetrics (has built-in caching)
	const maxW = Math.min(200, nodeW * 1.5);
	let displayText = text;
	let textW = CanvasTextMetrics.measureText(displayText, style).width;
	if (textW > maxW) {
		// Binary-search for the longest prefix that fits
		let lo = 1;
		let hi = displayText.length;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			const w = CanvasTextMetrics.measureText(`${displayText.slice(0, mid)}…`, style).width;
			if (w <= maxW) lo = mid;
			else hi = mid - 1;
		}
		displayText = `${displayText.slice(0, lo)}…`;
		textW = CanvasTextMetrics.measureText(displayText, style).width;
	}
	const padX = 8;
	const padY = 5;
	const bubbleW = textW + padX * 2;
	const bubbleH = 20 + padY * 2;
	const bubbleX = anchorX - bubbleW / 2;
	const bubbleY = anchorY - bubbleH - 6;
	const br = 6;

	// Background
	g.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, br).fill({
		color: 0x1a1b1e,
		alpha: alpha * 0.92,
	});
	// Border
	g.roundRect(bubbleX, bubbleY, bubbleW, bubbleH, br).stroke({
		width: 1,
		color: 0x373a40,
		alpha: alpha * 0.6,
	});

	// Text
	const label = pool.acquire(style);
	label.text = displayText;
	label.alpha = alpha;
	label.scale.set(1);
	label.position.set(bubbleX + padX, bubbleY + padY);
}

// ---------------------------------------------------------------------------
// CardContainerPool — per-chapter Container pool for card-phase nodes
// ---------------------------------------------------------------------------

/** A pooled card container: owns a Graphics + a TextPool for self-contained z-order. */
export interface CardSlot {
	container: Container;
	gfx: Graphics;
	labels: TextPool;
}

/**
 * Manages a pool of Container objects for card-phase chapter nodes.
 * Each slot contains its own Graphics + TextPool, ensuring correct z-order
 * (a card's text is always above its own background, never above another card).
 *
 * Dot/pill nodes continue using the shared morphGfx + chapterLabelPool.
 * Only card-phase nodes (cardBlend > 0) acquire a slot from this pool.
 */
export class CardContainerPool {
	private pool: CardSlot[] = [];
	private cursor = 0;

	constructor(private parent: Container) {}

	/** Get the next available card slot, creating one if the pool is exhausted. */
	acquire(): CardSlot {
		if (this.cursor < this.pool.length) {
			const slot = this.pool[this.cursor];
			slot.container.visible = true;
			slot.gfx.clear();
			this.cursor++;
			return slot;
		}
		const container = new Container();
		const gfx = new Graphics();
		const labelContainer = new Container();
		container.addChild(gfx);
		container.addChild(labelContainer);
		this.parent.addChild(container);
		const slot: CardSlot = { container, gfx, labels: new TextPool(labelContainer) };
		this.pool.push(slot);
		this.cursor++;
		return slot;
	}

	/** Hide all unused slots and flush their label pools. Reset cursor for next frame. */
	flush(): void {
		for (let i = this.cursor; i < this.pool.length; i++) {
			this.pool[i].container.visible = false;
			this.pool[i].labels.flush();
		}
		this.cursor = 0;
	}
}
