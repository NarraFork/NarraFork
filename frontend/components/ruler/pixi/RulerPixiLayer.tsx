/**
 * PixiJS rendering layer for the ruler.
 * Handles all high-frequency visual elements: ticks, density bar,
 * connector lines, and chapter node morph elements (dot → pill → card).
 * React DOM is only used for interactive NarratorPanel overlays above this layer.
 */
import { layoutWithLines, measureNaturalWidth, prepareWithSegments } from "@chenglou/pretext";
import { installPixiCanvasPoolHmrGuard } from "@frontend/lib/pixi-hmr";
import { Application, CanvasTextMetrics, Container, Graphics, TextStyle } from "pixi.js";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RulerSegment } from "../../../hooks/useRuler";
import { type ElasticLayout, findTickAtX } from "../elastic-layout";
import { localScale, screenToWorld, viewCenterFromPan, worldToScreen } from "../fisheye";
import {
	CardContainerPool,
	drawActivityBadge,
	drawActivityTooltip,
	drawChapterNode,
	drawConnector,
	drawDensityBar,
	drawRulerTrackBg,
	drawTick,
	type PixiActivityInfo,
	TextPool,
} from "../pixi-draw";
import { decimateTicks, slotWidth } from "../tick-decimation";
import type { RulerOrientation } from "../types";
import {
	DOT_FINAL_SIZE,
	getMorphFactor,
	getMorphStyle,
	getPanelFadeOpacity,
	MORPH_T_DOT,
	type ZoomTierId,
} from "../zoom-tiers";
import type { PixiTheme } from "./pixi-theme";
import { invalidatePixiThemeCache, resolvePixiTheme, themeStatusColor } from "./pixi-theme";

installPixiCanvasPoolHmrGuard();

function destroyPixiApplication(app: Application): void {
	// Workaround for PixiJS v8 ResizePlugin bug: destroy() calls
	// _cancelResize() which may not exist when resizeTo is undefined.
	// biome-ignore lint/suspicious/noExplicitAny: PixiJS ResizePlugin internal
	const pixiApp = app as any;
	if (typeof pixiApp._cancelResize !== "function") {
		pixiApp._cancelResize = () => {};
	}
	// `removeView: true` (not the boolean `true`) — the boolean form reaches
	// `AbstractRenderer.destroy` as `options === true`, which additionally fires
	// `GlobalResourceRegistry.release()`. That empties PROCESS-WIDE pools
	// (`TexturePool._texturePool = {}`) while leaving `_poolKeyHash` populated, so
	// any Text destroyed afterwards — including this app's own stage teardown,
	// which happens BEFORE the renderer is destroyed — hits
	// `this._texturePool[key].push(...)` on `undefined`. The pools are shared
	// globals, not this app's property, so tearing one layer down must not clear
	// them. `removeView` keeps the only behaviour we actually wanted from `true`:
	// detaching the canvas from the DOM.
	app.destroy({ removeView: true }, { children: true });
}

// Reusable buffers to avoid per-frame allocations in redraw.
// Module-level is safe because only one RulerPixiLayer instance exists at a time
// and redraw() is synchronous.
const mergedBuf: PixiChapterInfo[] = [];
const alwaysIdsBuf = new Set<string>();

/** Chapter info needed for morph + connector + card drawing */
export interface PixiChapterInfo {
	id: string;
	status: string;
	title: string;
	branch: string;
	role: string;
	narratorId: string | null;
	narratorStatus: string | null;
	/**
	 * Narrator is parked until an unavailable model recovers. Carried alongside
	 * `narratorStatus` (which stays `"waiting"`) so the card can recolor without
	 * changing the drawn/measured status text.
	 */
	narratorModelUnavailable?: boolean;
	startCommitSha: string | null;
	mergeCommitSha?: string | null;
	/** Parent chapter ID — used to draw connector to parent instead of ruler for orphan chapters */
	parentChapterId?: string | null;
	/** World-space layout position within the segment */
	layoutX: number;
	layoutY: number;
	/** The segment's main-axis world position */
	segMainPos: number;
	/** Panel dimensions (set when narrator panel is open for this chapter) */
	panelWidth?: number;
	panelHeight?: number;
}

interface Camera {
	panX: number;
	panY: number;
	scale: number;
	orientation: string;
	edge: "start" | "end";
}

export interface CardHitRect {
	id: string;
	narratorId: string | null;
	fromSha: string;
	screenX: number;
	screenY: number;
	width: number;
	height: number;
	layoutX: number;
	layoutY: number;
	/** Fisheye local scale at this chapter's main-axis position */
	localScale: number;
	/** Morph factor t ∈ [0, 1] — used by DOM panel to compute cardBlend for cross-fade */
	morphT: number;
}

export interface RulerPixiHandle {
	/** Fast-path: update camera transform without React re-render */
	updateCamera(cam: Camera): void;
	/** Trigger a full re-render of the PixiJS scene */
	render(): void;
	/** Update chapter positions imperatively (e.g. during drag) without React state */
	updateChapters(chapters: PixiChapterInfo[] | null): void;
	/** Get current card hit rects for interaction hit-testing */
	getCardHitRects(): CardHitRect[];
}

interface RulerPixiLayerProps {
	containerWidth: number;
	containerHeight: number;
	orientation: RulerOrientation;
	/** Forwarded ref for imperative camera updates */
	pixiRef: React.Ref<RulerPixiHandle>;
	/** Current camera state for initial/data-change redraws */
	camera: Camera;
	// --- Data (updated on React re-render) ---
	layout: ElasticLayout;
	segments: RulerSegment[];
	chapters: PixiChapterInfo[];
	zoomTier: ZoomTierId;
	tickPositions: Map<string, number>;
	/** Dynamic ruler track thickness (changes when user drags the border) */
	rulerThickness: number;
	/** Commit SHA → first line of commit message */
	commitMessages: Map<string, string>;
	/** Active chapters that should always render as dots even at L0 */
	alwaysVisibleChapters: PixiChapterInfo[];
	/** Set of chapter IDs that have their narrator panel open (rendered by React) */
	openPanelChapterIds?: Set<string>;
	/** Activity info for collapsed chapters (badge + tooltip) */
	activityMap?: Map<string, PixiActivityInfo>;
	/** Called when panel blend animation updates — allows parent to sync DOM panels */
	onPanelBlendUpdate?: () => void;
	// --- Interaction callbacks ---
	onChapterClick?: (chapterId: string, narratorId: string | null) => void;
	onChapterContextMenu?: (chapterId: string, screenX: number, screenY: number) => void;
	onChapterDragEnd?: (
		chapterId: string,
		fromSha: string,
		newAxisOffset: number,
		newCrossOffset: number,
	) => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const NODE_MIN_WIDTH = 80;
const NODE_TITLE_PADDING = 24; // horizontal padding inside card for title

// Reusable TextStyles for width measurement (font size updated before each use)
const measureStyle = new TextStyle({ fontFamily: "sans-serif", fontWeight: "600", fontSize: 11 });
const measureBadgeStyle = new TextStyle({ fontFamily: "sans-serif", fontSize: 9 });
const CARD_TOP_OFFSET = 2;

/**
 * Card geometry, exported for RulerFlow's world-space card registry.
 *
 * That registry feeds cross-axis pan bounds and the offscreen bubbles, so its rects
 * must agree with what this layer actually DRAWS. Re-declaring 220 / 72 / 2 there is
 * how the two would drift silently — nothing would look wrong, the bounds would just
 * be a little off.
 */
export const RULER_CARD_GEOMETRY = {
	nodeWidth: NODE_WIDTH,
	nodeHeight: NODE_HEIGHT,
	cardTopOffset: CARD_TOP_OFFSET,
} as const;

function narratorStatusColor(theme: PixiTheme, status: string, modelUnavailable?: boolean): number {
	/*
	 * Waiting for a model to recover arrives as `waiting` plus a separate flag
	 * (the status string is drawn as raw text and measured for card width, so it
	 * must stay short and stable). Recolor only, and check it first so it is not
	 * painted with the attention hue the user cannot act on.
	 */
	if (modelUnavailable) return theme.narratorModelUnavailable;
	switch (status) {
		case "working":
			return theme.narratorWorking;
		case "unread":
			return theme.narratorUnread;
		case "error":
			return theme.narratorError;
		case "waiting":
			return theme.narratorWaiting;
		case "reflecting":
			return theme.narratorReflecting;
		case "manual_override":
			return theme.narratorManualOverride;
		case "interrupted":
			return theme.narratorInterrupted;
		case "suspended":
			return theme.narratorSuspended;
		default:
			return theme.dimmed;
	}
}

export const RulerPixiLayer = memo(function RulerPixiLayer({
	containerWidth,
	containerHeight,
	orientation,
	pixiRef,
	camera,
	layout,
	segments,
	chapters,
	zoomTier,
	tickPositions,
	rulerThickness,
	commitMessages,
	alwaysVisibleChapters,
	openPanelChapterIds,
	activityMap,
	onPanelBlendUpdate,
	onChapterClick: _onChapterClick,
	onChapterContextMenu: _onChapterContextMenu,
	onChapterDragEnd: _onChapterDragEnd,
}: RulerPixiLayerProps) {
	const containerDivRef = useRef<HTMLDivElement>(null);
	const appRef = useRef<Application | null>(null);
	const [pixiReady, setPixiReady] = useState(false);
	const worldContainerRef = useRef<Container | null>(null);
	const rulerContainerRef = useRef<Container | null>(null);

	// Graphics objects (reused, cleared each draw)
	const tickGfxRef = useRef<Graphics | null>(null);
	const morphGfxRef = useRef<Graphics | null>(null);
	const connectorGfxRef = useRef<Graphics | null>(null);
	const heatmapGfxRef = useRef<Graphics | null>(null);
	const trackBgGfxRef = useRef<Graphics | null>(null);
	const rulerMaskGfxRef = useRef<Graphics | null>(null);

	// TextPool instances (created during PixiJS init, reused each frame)
	const tickLabelPoolRef = useRef<TextPool | null>(null);
	const chapterLabelPoolRef = useRef<TextPool | null>(null);
	// Card-phase chapters get their own Container for correct z-order
	const cardPoolRef = useRef<CardContainerPool | null>(null);

	// Cached TextStyle objects — reused across frames, only rebuilt when parameters change
	const cachedStylesRef = useRef<{
		labelStyle: TextStyle | null;
		labelKey: string;
		msgStyle: TextStyle | null;
		msgKey: string;
		chapterTitleKey: string;
		chapterTitleStyle: TextStyle | null;
		cardBadgeKey: string;
		cardBadgeStyle: TextStyle | null;
		activityBadgeStyle: TextStyle | null;
		activityTooltipStyle: TextStyle | null;
	}>({
		labelStyle: null,
		labelKey: "",
		msgStyle: null,
		msgKey: "",
		chapterTitleKey: "",
		chapterTitleStyle: null,
		cardBadgeKey: "",
		cardBadgeStyle: null,
		activityBadgeStyle: null,
		activityTooltipStyle: null,
	});

	// Latest camera ref — tracks the most recent camera state including fast-path
	// updates (zoom/pan animations) that bypass React state. Used by updateChapters()
	// so drag-time redraws use the correct camera instead of stale React state.
	const latestCameraRef = useRef<Camera>(camera);

	// Latest data refs (avoid stale closures in imperative handle)
	// chaptersOverrideRef: set imperatively during drag, cleared only when the
	// chapters prop actually changes (meaning React delivered fresh layout data).
	// Previously this was cleared unconditionally on every render, which caused
	// the override to be wiped when an unrelated prop (camera, scale, …) changed
	// mid-drag, making connectors flash back to stale positions.
	const chaptersOverrideRef = useRef<PixiChapterInfo[] | null>(null);
	const prevChaptersRef = useRef(chapters);
	if (prevChaptersRef.current !== chapters) {
		prevChaptersRef.current = chapters;
		chaptersOverrideRef.current = null;
	}
	const dataRef = useRef({
		layout,
		segments,
		chapters,
		zoomTier,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
		activityMap,
	});
	dataRef.current = {
		layout,
		segments,
		chapters,
		zoomTier,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
		activityMap,
	};

	// Callback ref — avoids stale closure in redraw's rAF callback
	const onPanelBlendUpdateRef = useRef(onPanelBlendUpdate);
	onPanelBlendUpdateRef.current = onPanelBlendUpdate;

	// Hit-test rectangles for card interaction (rebuilt each redraw)
	const cardHitRectsRef = useRef<CardHitRect[]>([]);

	// --- Panel open/close blend animation ---
	// Per-chapter blend factor: 0 = card size, 1 = panel size.
	// Lerps each frame toward the target (1 if panel open, 0 if closed).
	const panelBlendMapRef = useRef<Map<string, number>>(new Map());
	const panelAnimRafRef = useRef(0);

	// --- Initialize PixiJS Application ---
	// biome-ignore lint/correctness/useExhaustiveDependencies: init once
	useEffect(() => {
		const container = containerDivRef.current;
		if (!container) return;

		const app = new Application();
		let destroyed = false;

		const initPromise = app.init({
			width: containerWidth,
			height: containerHeight,
			backgroundAlpha: 0,
			antialias: true,
			autoDensity: true,
			resolution: window.devicePixelRatio || 1,
			autoStart: false,
			resizeTo: undefined,
			preference: "webgl", // Avoid WebGPU issues, use WebGL2
		});

		initPromise.then(() => {
			if (destroyed) {
				destroyPixiApplication(app);
				return;
			}
			appRef.current = app;

			// Use latest dimensions from dataRef (init closure may have stale values)
			const latestW = dataRef.current.containerWidth;
			const latestH = dataRef.current.containerHeight;
			if (latestW !== containerWidth || latestH !== containerHeight) {
				app.renderer.resize(latestW, latestH);
			}

			// Mount PixiJS-created canvas into our container div
			const pixiCanvas = app.canvas as HTMLCanvasElement;
			pixiCanvas.style.position = "absolute";
			pixiCanvas.style.top = "0";
			pixiCanvas.style.left = "0";
			pixiCanvas.style.width = `${latestW}px`;
			pixiCanvas.style.height = `${latestH}px`;
			pixiCanvas.style.pointerEvents = "none";
			container.appendChild(pixiCanvas);

			// Create container hierarchy
			const rulerContainer = new Container();
			const worldContainer = new Container();
			app.stage.addChild(worldContainer);
			app.stage.addChild(rulerContainer); // ruler on top

			worldContainerRef.current = worldContainer;
			rulerContainerRef.current = rulerContainer;

			// Create reusable Graphics objects
			const connectorGfx = new Graphics();
			const morphGfx = new Graphics();
			const heatmapGfx = new Graphics();
			const tickGfx = new Graphics();

			worldContainer.addChild(connectorGfx);
			worldContainer.addChild(morphGfx);

			const trackBgGfx = new Graphics();
			const rulerMaskGfx = new Graphics();
			rulerContainer.addChild(trackBgGfx);
			rulerContainer.addChild(heatmapGfx);
			rulerContainer.addChild(tickGfx);

			// Mask: clip ruler contents to the track area
			rulerContainer.addChild(rulerMaskGfx);
			rulerContainer.mask = rulerMaskGfx;

			// Text pools — one for ruler tick labels, one for dot/pill chapter labels
			const tickLabelContainer = new Container();
			const chapterLabelContainer = new Container();
			rulerContainer.addChild(tickLabelContainer);
			worldContainer.addChild(chapterLabelContainer);

			tickLabelPoolRef.current = new TextPool(tickLabelContainer);
			chapterLabelPoolRef.current = new TextPool(chapterLabelContainer);

			// Card-phase chapters get per-node Containers (appended after chapterLabelContainer)
			// so they render above dot/pill elements with correct internal z-order.
			cardPoolRef.current = new CardContainerPool(worldContainer);

			trackBgGfxRef.current = trackBgGfx;
			rulerMaskGfxRef.current = rulerMaskGfx;

			tickGfxRef.current = tickGfx;
			morphGfxRef.current = morphGfx;
			connectorGfxRef.current = connectorGfx;
			heatmapGfxRef.current = heatmapGfx;

			// Signal ready and trigger initial draw
			setPixiReady(true);
			redraw(dataRef.current.camera);
		});

		return () => {
			destroyed = true;
			cancelAnimationFrame(panelAnimRafRef.current);
			// Only destroy if init completed and app was fully set up. If init is
			// still pending, the then() handler above will destroy the late app.
			const live = appRef.current;
			// Clear the ref BEFORE destroying, not after. `destroy()` runs Pixi
			// internals that can throw (stage teardown touches global pools); a throw
			// used to skip the assignment below and leave `appRef` pointing at a
			// half-destroyed app, after which every `updateCamera` → `redraw` →
			// `app.render()` crashed on a null render pipe. Dropping the reference
			// first makes teardown failure degrade to "layer stops drawing" instead of
			// a render loop throwing on every camera move.
			appRef.current = null;
			if (live) {
				destroyPixiApplication(live);
			}
		};
	}, []); // Only once

	// --- Resize ---
	// Include pixiReady so this runs after async PixiJS init completes,
	// ensuring the renderer picks up the correct viewport dimensions.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pixiReady triggers resize after async init
	useEffect(() => {
		const app = appRef.current;
		if (!app?.renderer) return;
		app.renderer.resize(containerWidth, containerHeight);
		const pixiCanvas = app.canvas as HTMLCanvasElement;
		if (pixiCanvas) {
			pixiCanvas.style.width = `${containerWidth}px`;
			pixiCanvas.style.height = `${containerHeight}px`;
		}
	}, [containerWidth, containerHeight, pixiReady]);

	// --- Full redraw function ---
	const redraw = useCallback((cam: Camera) => {
		const app = appRef.current;
		if (!app) return;

		const d = dataRef.current;
		const isH = cam.orientation === "horizontal";
		const trackH = d.rulerThickness;

		// --- Fisheye parameters ---
		const mainViewport = isH ? d.containerWidth : d.containerHeight;
		const mainPan = isH ? cam.panX : cam.panY;
		const crossPan = isH ? cam.panY : cam.panX;
		const viewCenter = viewCenterFromPan(mainPan, mainViewport, cam.scale);

		// Helper: world main-axis → screen main-axis pixel
		const toScreen = (worldMain: number) =>
			worldToScreen(worldMain, viewCenter, mainViewport, cam.scale);

		// Helper: get local scale at a world position
		const getLocalScale = (worldMain: number) =>
			localScale(worldMain, viewCenter, mainViewport, cam.scale);

		// Update world container — no camera transform, everything is screen-space
		const wc = worldContainerRef.current;
		if (wc) {
			wc.position.set(0, 0);
			wc.scale.set(1);
		}

		// --- Edge-aware ruler offset ---
		// When edge === "end", the ruler track is at the bottom (H) or right (V).
		// Shift the PixiJS ruler container to match the CSS ruler track position.
		const crossViewport = isH ? d.containerHeight : d.containerWidth;
		const rulerOffset = cam.edge === "end" ? crossViewport - trackH : 0;
		// crossBase: where chapter nodes start on the cross axis (screen pixels)
		const crossBase = cam.edge === "end" ? 0 : trackH;

		// Update ruler container — position at ruler offset
		const rc = rulerContainerRef.current;
		if (rc) {
			rc.position.set(isH ? 0 : rulerOffset, isH ? rulerOffset : 0);
			rc.scale.set(1, 1);
		}

		// --- Clear all graphics ---
		tickGfxRef.current?.clear();
		morphGfxRef.current?.clear();
		connectorGfxRef.current?.clear();
		heatmapGfxRef.current?.clear();
		trackBgGfxRef.current?.clear();
		rulerMaskGfxRef.current?.clear();

		const tickGfx = tickGfxRef.current;
		const morphGfx = morphGfxRef.current;
		const connGfx = connectorGfxRef.current;
		const heatGfx = heatmapGfxRef.current;
		const trackBgGfx = trackBgGfxRef.current;
		const rulerMaskGfx = rulerMaskGfxRef.current;
		if (!tickGfx || !morphGfx || !connGfx || !heatGfx || !trackBgGfx) return;

		// --- Update ruler mask to clip contents within the track area ---
		// Everything is now in screen space, so the mask is simply the track rect.
		if (rulerMaskGfx) {
			const maskW = isH ? d.containerWidth : trackH;
			const maskH = isH ? trackH : d.containerHeight;
			rulerMaskGfx.rect(0, 0, maskW, maskH).fill({ color: 0xffffff });
		}

		// --- Resolve theme ---
		const theme = resolvePixiTheme();

		// --- Draw ruler track background (full viewport width) ---
		const trackScreenWidth = isH ? d.containerWidth : d.containerHeight;
		drawRulerTrackBg(trackBgGfx, theme, trackScreenWidth, trackH, isH, cam.edge);

		// --- Viewport culling (screen-space) ---
		const cullBuffer = mainViewport * 0.5;
		const cullStart = -cullBuffer;
		const cullEnd = mainViewport + cullBuffer;

		const allTicks = d.layout.ticks;

		// Pre-compute visible tick range via binary search.
		const worldCullStart = screenToWorld(cullStart, viewCenter, mainViewport, cam.scale);
		const worldCullEnd = screenToWorld(cullEnd, viewCenter, mainViewport, cam.scale);
		const visStartIdx = Math.max(0, findTickAtX(allTicks, worldCullStart) - 1);
		const visEndIdx = Math.min(allTicks.length - 1, findTickAtX(allTicks, worldCullEnd) + 1);

		// --- Decimate ticks based on global scale (pan-stable) ---
		const decimated = decimateTicks(allTicks, cam.scale, visStartIdx, visEndIdx);

		// --- Draw ticks ---
		for (const dt of decimated) {
			const screenX = toScreen(dt.x);
			drawTick(tickGfx, theme, screenX, trackH, dt.isSegment, cam.scale, isH, cam.edge);
		}

		// --- Draw density bar (replaces heatmap + cluster blocks) ---
		// Build screen-space data for the density bar from decimated ticks.
		const densityData = decimated.map((dt, i) => {
			const screenX = toScreen(dt.x);
			const nextDt = decimated[i + 1];
			const nextScreenX = nextDt ? toScreen(nextDt.x) : screenX;
			return { screenX, screenGapToNext: nextScreenX - screenX, skippedCount: dt.skippedCount };
		});
		drawDensityBar(heatGfx, theme, densityData, trackH, isH, cam.edge);

		// --- Draw tick labels ---
		// Slot width = stride * COLLAPSED_GAP * scale, always ≥ MIN_TICK_WIDTH.
		// Zooming in makes slots wider (more text visible); zooming out increases
		// stride (fewer ticks) but each retained tick keeps at least MIN_TICK_WIDTH.
		const tickPool = tickLabelPoolRef.current;
		if (tickPool && decimated.length > 0) {
			const showMessages = d.zoomTier === "L4" || d.zoomTier === "L3";
			const isExpanded = trackH > 60;
			const fontSize = isExpanded ? 11 : 10;

			// Label style: no wordWrap — we truncate manually per tick
			const labelKey = `${fontSize}:${theme.dimmed}`;
			const sc = cachedStylesRef.current;
			if (sc.labelKey !== labelKey || !sc.labelStyle) {
				sc.labelStyle = new TextStyle({
					fontSize,
					fill: theme.dimmed,
					fontFamily: "monospace",
				});
				sc.labelKey = labelKey;
			}
			const labelStyle = sc.labelStyle;

			const labelAvailCross = trackH - 8; // 4px padding each side

			// Label cross-axis positioning depends on edge:
			const edgeEnd = cam.edge === "end";
			const shaOffset = edgeEnd ? trackH - fontSize - 4 : 4;
			const shaCrossSize = isH ? 0 : fontSize + 2;
			// Horizontal:
			//   edge="start": SHA at top (near screen edge), message below SHA, ticks at bottom
			//   edge="end":   SHA at bottom (near screen edge), message near top (after ticks), ticks at top
			// Vertical:
			//   edge="start": SHA at left (near screen edge), message at same X, stacked below SHA in main-axis
			//   edge="end":   SHA at right (near screen edge), message after ticks (left side)
			const msgCrossOffset = isH
				? edgeEnd
					? isExpanded
						? 22
						: 20
					: isExpanded
						? 18
						: 16
				: edgeEnd
					? isExpanded
						? 22
						: 20
					: shaOffset;

			// Available space for commit message (cross-axis)
			const msgAvailH = edgeEnd ? shaOffset - msgCrossOffset - 2 : trackH - msgCrossOffset - 4;
			const msgLineH = 13;

			// Label width grows with zoom. slotWidth = stride * COLLAPSED_GAP * scale.
			const slot = slotWidth(cam.scale);
			const labelWidth = slot - 8; // 8px padding

			// --- Pre-compute message layout (constant across all ticks in this frame) ---
			const msgAvailMain = labelWidth;
			// Vertical mode: when edge="end", msg is in a separate column from SHA,
			// so it gets the full slot height (no shaCrossSize deduction).
			const msgAvailVert =
				edgeEnd && !isH ? Math.max(0, slot - 8) : Math.max(0, slot - shaCrossSize - 8);
			const showMsg = isH
				? (showMessages || isExpanded) && msgAvailH > msgLineH * 0.5 && msgAvailMain > 40
				: msgAvailVert > msgLineH * 0.8;

			// Vertical mode: when edge="end", msg column width is limited to the
			// space between the tick area and the SHA column.
			const msgCrossAvail = !isH && edgeEnd ? shaOffset - msgCrossOffset - 2 : labelAvailCross;
			const msgWrapWidth = isH ? msgAvailMain : msgCrossAvail;
			const maxMsgLines = isH
				? Math.max(1, Math.floor(msgAvailH / msgLineH))
				: Math.max(1, Math.floor(msgAvailVert / msgLineH));

			if (showMsg) {
				const msgKey = `${theme.dimmed}:${Math.round(msgWrapWidth)}:${maxMsgLines}:${isH}`;
				if (sc.msgKey !== msgKey || !sc.msgStyle) {
					sc.msgStyle = new TextStyle({
						fontSize: 10,
						fill: theme.dimmed,
						fontFamily: "sans-serif",
						// No wordWrap — pretext handles line breaking,
						// we feed pre-broken text with \n to PixiJS.
					});
					sc.msgKey = msgKey;
				}
			}

			// SHA: use pretext to determine how many chars fit in labelWidth.
			// Monospace font — measure one char, then divide available width.
			const shaFont = `${fontSize}px monospace`;
			const shaCharPrepared = prepareWithSegments("a", shaFont);
			const shaCharW = measureNaturalWidth(shaCharPrepared);
			const shaCharsH = Math.max(
				4,
				Math.min(7, shaCharW > 0 ? Math.floor(labelWidth / shaCharW) : 7),
			);
			const shaTextWidth = shaCharsH * shaCharW;

			// Pre-measure font for commit messages (sans-serif 10px)
			const msgFont = "10px sans-serif";

			for (let di = 0; di < decimated.length; di++) {
				const dt = decimated[di];
				const screenX = toScreen(dt.x);

				// Fisheye: compute the actual screen gap to the next tick.
				const nextDt = decimated[di + 1];
				const nextScreenX = nextDt ? toScreen(nextDt.x) : screenX + slot;
				const actualGap = nextScreenX - screenX;
				// Available pixel width after padding
				const availPx = actualGap - 8;

				// SHA label
				const label = tickPool.acquire(labelStyle);
				label.rotation = 0;
				if (isH) {
					label.text = dt.sha.slice(0, shaCharsH);
					// Squeeze based on text's actual width: only compress when
					// the gap is smaller than the text, not the full slot.
					const shaSqueeze =
						shaTextWidth > 0 ? Math.max(0, Math.min(1, availPx / shaTextWidth)) : 1;
					label.scale.set(shaSqueeze, 1);
					label.position.set(screenX + 4, shaOffset);

					// Commit message (horizontal)
					if (showMsg) {
						const msg = d.commitMessages.get(dt.sha);
						if (msg && sc.msgStyle) {
							// Let pretext handle wrapping and truncation.
							const msgPrepared = prepareWithSegments(msg, msgFont);
							const msgResult = layoutWithLines(msgPrepared, msgWrapWidth, msgLineH);
							const allLines = msgResult.lines;
							const truncated = allLines.length > maxMsgLines;
							const lines = allLines.slice(0, maxMsgLines);
							if (lines.length > 0) {
								const lineTexts = lines.map((l) => l.text);
								if (truncated) {
									const last = lineTexts.length - 1;
									lineTexts[last] = `${lineTexts[last].trimEnd()}…`;
								}
								const msgLabel = tickPool.acquire(sc.msgStyle);
								msgLabel.text = lineTexts.join("\n");
								msgLabel.rotation = 0;
								// Use laid-out dimensions: width = widest line, height from pretext.
								// Squeeze X based on laid-out width.
								let laidOutW = 0;
								for (const l of lines) {
									if (l.width > laidOutW) laidOutW = l.width;
								}
								const msgSqueeze = laidOutW > 0 ? Math.max(0, Math.min(1, availPx / laidOutW)) : 1;
								msgLabel.scale.set(msgSqueeze, 1);
								msgLabel.position.set(screenX + 4, msgCrossOffset);
							}
						}
					}
				} else {
					// Vertical mode: main axis = Y, squeeze compresses Y scale.
					// Use pretext to measure everything, then compute a single
					// unified squeeze for the entire tick content.
					const shaCharsV = Math.max(
						4,
						Math.min(7, shaCharW > 0 ? Math.floor(labelAvailCross / shaCharW) : 7),
					);
					const shaTextV = dt.sha.slice(0, shaCharsV);

					// Measure commit message if visible
					let msgLaidOutH = 0;
					let msgLineTexts: string[] | null = null;
					if (showMsg) {
						const msg = d.commitMessages.get(dt.sha);
						if (msg && sc.msgStyle) {
							const msgPrepared = prepareWithSegments(msg, msgFont);
							const wrapW = Math.max(1, msgCrossAvail);
							const msgResult = layoutWithLines(msgPrepared, wrapW, msgLineH);
							const allLines = msgResult.lines;
							const truncated = allLines.length > maxMsgLines;
							const lines = allLines.slice(0, maxMsgLines);
							if (lines.length > 0) {
								msgLineTexts = lines.map((l) => l.text);
								if (truncated) {
									const last = msgLineTexts.length - 1;
									msgLineTexts[last] = `${msgLineTexts[last].trimEnd()}…`;
								}
								msgLaidOutH = lines.length * msgLineH;
							}
						}
					}

					if (edgeEnd) {
						// edge="end": SHA and msg in separate cross-axis columns.
						const shaSqueeze = fontSize > 0 ? Math.max(0, Math.min(1, availPx / fontSize)) : 1;
						label.text = shaTextV;
						label.scale.set(1, shaSqueeze);
						label.position.set(shaOffset, screenX + 4);

						if (msgLineTexts && sc.msgStyle) {
							const msgLabel = tickPool.acquire(sc.msgStyle);
							msgLabel.text = msgLineTexts.join("\n");
							msgLabel.rotation = 0;
							const msgSqueeze =
								msgLaidOutH > 0 ? Math.max(0, Math.min(1, availPx / msgLaidOutH)) : 1;
							msgLabel.scale.set(1, msgSqueeze);
							msgLabel.position.set(msgCrossOffset, screenX + 4);
						}
					} else {
						// edge="start": SHA and msg stacked in same column along main axis.
						// Compute total laid-out height, then apply one unified squeeze.
						const gap = 4;
						const totalH = msgLineTexts ? fontSize + gap + msgLaidOutH : fontSize;
						const squeeze = totalH > 0 ? Math.max(0, Math.min(1, availPx / totalH)) : 1;

						label.text = shaTextV;
						label.scale.set(1, squeeze);
						label.position.set(shaOffset, screenX + 4);

						if (msgLineTexts && sc.msgStyle) {
							const msgLabel = tickPool.acquire(sc.msgStyle);
							msgLabel.text = msgLineTexts.join("\n");
							msgLabel.rotation = 0;
							msgLabel.scale.set(1, squeeze);
							msgLabel.position.set(msgCrossOffset, screenX + 4 + (fontSize + gap) * squeeze);
						}
					}
				}
			}
		}
		tickPool?.flush();

		// --- Draw chapter nodes + connectors (unified dot→pill→card) ---
		// Cross axis remains linear — only main axis has fisheye.
		// rulerEdgeCrossScreen: the cross-axis screen position of the ruler edge
		// where connectors originate. Depends on edge placement.
		const rulerEdgeCrossScreen = cam.edge === "end" ? crossViewport - trackH : trackH;
		const chapterPool = chapterLabelPoolRef.current; // for dot/pill text
		const cardPool = cardPoolRef.current; // for card-phase containers

		const cardHitRects = cardHitRectsRef.current;
		cardHitRects.length = 0;

		// Use imperative override if available (e.g. during card drag)
		const chaptersToRender = chaptersOverrideRef.current ?? d.chapters;

		// Merge always-visible active chapters (for L0 where SegmentCanvas is not rendered)
		// Reuse a single array to avoid per-frame allocations
		const always = d.alwaysVisibleChapters;
		let merged: typeof chaptersToRender;
		if (always.length === 0) {
			merged = chaptersToRender;
		} else {
			mergedBuf.length = 0;
			// Collect IDs from chaptersToRender (which may be override data during drag)
			const renderedIds = alwaysIdsBuf;
			renderedIds.clear();
			for (const c of chaptersToRender) {
				mergedBuf.push(c);
				renderedIds.add(c.id);
			}
			// Append always-visible chapters that aren't already in chaptersToRender
			for (const c of always) {
				if (!renderedIds.has(c.id)) mergedBuf.push(c);
			}
			merged = mergedBuf;
		}

		// Pre-compute zoom morph factor — cam.scale is loop-invariant
		const tZoom = getMorphFactor(cam.scale);

		// Card scale factor (clamped) — shared with NarratorPanelOverlay in RulerFlow.
		// Card internal layout (padding, font sizes, badge positions) scales with
		// cam.scale so content stays proportional to the card dimensions.
		const cardScale = cam.scale;

		// --- Panel blend animation: advance per-chapter blend toward target ---
		const blendMap = panelBlendMapRef.current;
		let needsAnimFrame = false;
		const BLEND_LERP = 0.15;
		const BLEND_SNAP = 0.01;

		// Advance blend for chapters that are closing (no longer in openPanelChapterIds)
		for (const [chId, val] of blendMap) {
			if (!d.openPanelChapterIds?.has(chId)) {
				const next = val - val * BLEND_LERP;
				if (next < BLEND_SNAP) {
					blendMap.delete(chId);
				} else {
					blendMap.set(chId, next);
					needsAnimFrame = true;
				}
			}
		}

		// Map of chapter screen positions — used for parent-to-child connectors
		const chapterScreenPos = new Map<
			string,
			{ mainLeft: number; mainSize: number; crossCenter: number }
		>();
		// Deferred connectors for orphan chapters (parent may not be positioned yet)
		const deferredConnectors: Array<{
			parentId: string;
			elemScreenLeft: number;
			elemScreenCenterCross: number;
			opacity: number;
		}> = [];

		for (const ch of merged) {
			const chWorldMain = ch.segMainPos + ch.layoutX;
			// For chapters with an open panel, compute localScale at both the
			// near edge and far edge of the panel along the main axis, then
			// pick the higher value (closer to viewport center). This prevents
			// large panels from shrinking prematurely when only one edge enters
			// the fisheye periphery.
			let ls: number;
			const hasPanel = d.openPanelChapterIds?.has(ch.id);

			// Advance blend for this chapter toward target
			let panelBlend = blendMap.get(ch.id) ?? 0;
			if (hasPanel) {
				const target = 1;
				panelBlend += (target - panelBlend) * BLEND_LERP;
				if (Math.abs(target - panelBlend) < BLEND_SNAP) panelBlend = target;
				else needsAnimFrame = true;
				blendMap.set(ch.id, panelBlend);
			}
			// panelBlend > 0 means panel is either open or animating closed
			const effectivePanel = panelBlend > 0;

			if (effectivePanel && ch.panelWidth) {
				const panelWorldSize = ch.panelWidth / cam.scale;
				const lsNear = getLocalScale(chWorldMain);
				const lsFar = getLocalScale(chWorldMain + panelWorldSize);
				ls = Math.max(lsNear, lsFar);
			} else {
				ls = getLocalScale(chWorldMain);
			}

			// Morph factor is the minimum of two independent factors:
			// 1) Global zoom level — what morph phase the camera scale alone warrants
			// 2) Fisheye edge fade — how much the chapter is compressed at the edge
			// This keeps cards visible as long as the zoom is deep enough AND the
			// chapter hasn't been pushed too far into the fisheye periphery.
			const tEdge = getMorphFactor(ls);
			let t = Math.min(tZoom, tEdge);

			// Active chapters always show at least as a dot
			if (t <= 0 && ch.status === "active") t = 0.15;
			// Merged chapters also show as a smaller dot so they don't vanish on re-mount
			if (t <= 0 && ch.status === "merged") t = 0.1;
			if (t <= 0) continue;
			// Guard against stale/incomplete chapter data after cleanup
			if (!ch.title || !ch.status) continue;

			// Compute per-chapter card width based on measured content widths.
			// CanvasTextMetrics has built-in caching so repeated calls are cheap.
			const titleMeasured = CanvasTextMetrics.measureText(ch.title ?? "", measureStyle);
			const titleNeeded = titleMeasured.width + NODE_TITLE_PADDING;
			// Status row: dot(12+3+3) + status text + gap(10) + narrator dot(6+5) + narrator text
			// Padding: 18px left (dot area) + text widths + gaps
			const statusText = ch.status ?? "";
			const narratorText = ch.narratorStatus ?? "";
			const statusMeasured = CanvasTextMetrics.measureText(statusText, measureBadgeStyle);
			let statusRowWidth = 18 + statusMeasured.width;
			if (narratorText) {
				const nsMeasured = CanvasTextMetrics.measureText(narratorText, measureBadgeStyle);
				statusRowWidth += 10 + 6 + 5 + nsMeasured.width;
			}
			statusRowWidth += 8; // right padding
			// Branch row: 8px left + branch text + 8px right
			const branchText = ch.branch ?? "";
			const branchNeeded = branchText
				? CanvasTextMetrics.measureText(branchText, measureBadgeStyle).width + 16
				: 0;
			const chapterWidth = Math.max(
				NODE_MIN_WIDTH,
				Math.min(NODE_WIDTH, Math.max(titleNeeded, statusRowWidth, branchNeeded)),
			);

			const morph = getMorphStyle(t, chapterWidth, NODE_HEIGHT);

			// --- Panel morph schedule ---
			// When a panel is open (or animating), blend draw size from card/dot
			// dimensions toward panel dimensions using panelBlend.
			// panelFade is a continuous [0,1] value that smoothly transitions
			// the panel visibility as t approaches MORPH_T_DOT, preventing the
			// abrupt disappearance that occurred with the old binary threshold.
			const panelFade = effectivePanel ? getPanelFadeOpacity(t) : 0;
			const panelVisible = panelFade > 0;

			// For chapters with panel blend > 0, compute two sets of dimensions:
			// 1) hitW/hitH — for DOM panel positioning (uses target panel size immediately)
			// 2) connW/connH — for connector line endpoints (smoothly blended)
			let drawW = morph.width;
			let drawH = morph.height;
			let hitW = morph.width;
			let hitH = morph.height;
			if (panelVisible && ch.panelWidth && ch.panelHeight) {
				// Map t from [DOT..1] → zoomBlend [0..1] (0 = dot size, 1 = panel size)
				const zoomBlend = Math.max(0, (t - MORPH_T_DOT) / (1 - MORPH_T_DOT));
				const dotMorph = getMorphStyle(MORPH_T_DOT, chapterWidth, NODE_HEIGHT);
				// Target dimensions at full panel open
				const targetW = dotMorph.width + zoomBlend * (ch.panelWidth - dotMorph.width);
				const targetH = dotMorph.height + zoomBlend * (ch.panelHeight - dotMorph.height);
				// Hit rect: use target size immediately so DOM panel renders at correct size
				hitW = targetW;
				hitH = targetH;
				// Connector endpoints: blend smoothly from card to panel size
				drawW = morph.width + panelBlend * (targetW - morph.width);
				drawH = morph.height + panelBlend * (targetH - morph.height);
			}

			// Dot phase keeps fixed screen size; pill/card scale 1:1 with cam.scale
			// so card dimensions and inter-card distances zoom at the same rate.
			const isDot = t <= MORPH_T_DOT;
			const scaledW = isDot ? drawW : Math.max(DOT_FINAL_SIZE, drawW * cam.scale);
			const scaledH = isDot ? drawH : Math.max(DOT_FINAL_SIZE, drawH * cam.scale);
			// Hit rect dimensions (for DOM panel positioning)
			const hitScaledW = isDot ? hitW : Math.max(DOT_FINAL_SIZE, hitW * cam.scale);
			const hitScaledH = isDot ? hitH : Math.max(DOT_FINAL_SIZE, hitH * cam.scale);

			// Fixed anchor — start edge of the layout slot for all morph phases.
			// Dot/pill/card all grow from this point toward the end of the main axis,
			// keeping the connector endpoint stable throughout the morph transition.
			const elemWorldMain = ch.segMainPos + ch.layoutX;
			const elemScreenLeft = toScreen(elemWorldMain);
			// Main-axis size of the element in screen pixels (used for connector endpoints).
			const elemMainSize = isH ? scaledW : scaledH;

			const elemScreenCross = crossBase + (ch.layoutY + CARD_TOP_OFFSET) * cam.scale + crossPan;
			const elemScreenCenterCross = elemScreenCross + scaledH / 2;

			// --- Draw unified chapter node (single path: dot → pill → card) ---
			// Card visual dimensions stay the same regardless of orientation —
			// only the position axes swap. morph.width is always the card's
			// CSS width and morph.height is always the CSS height.
			// Anchor is the start edge — scaling only extends toward the end.
			const screenW = scaledW;
			const screenH = scaledH;
			const nodeLeft = isH ? elemScreenLeft : elemScreenCross;
			const nodeTop = isH ? elemScreenCross : elemScreenLeft;

			// Track hit rects for card-like chapters AND chapters with open/animating panels.
			// Panels need hit rects for positioning even when cardBlend has dropped to 0.
			// Use hitScaledW/H so DOM panel gets the correct target size immediately.
			if (morph.cardBlend > 0 || effectivePanel) {
				const hrW = effectivePanel ? hitScaledW : screenW;
				const hrH = effectivePanel ? hitScaledH : screenH;
				const hrLeft = isH ? elemScreenLeft : elemScreenCross;
				const hrTop = isH ? elemScreenCross : elemScreenLeft;
				cardHitRects.push({
					id: ch.id,
					narratorId: ch.narratorId,
					fromSha: ch.startCommitSha ?? "",
					screenX: hrLeft,
					screenY: hrTop,
					width: hrW,
					height: hrH,
					layoutX: ch.layoutX,
					layoutY: ch.layoutY,
					localScale: ls,
					morphT: t,
				});
			}

			// Skip PixiJS draw only when the panel is fully visible (blend ≈ 1 AND fade = 1).
			// During the fade transition zone, both panel and PixiJS node are drawn
			// with complementary opacities for a smooth cross-fade.
			const skipDraw = panelVisible && panelBlend >= 1 && panelFade >= 1;

			if (!skipDraw) {
				// Cross-fade: PixiJS node fades in as panel fades out.
				// panelBlend * panelFade gives the effective panel coverage:
				//   panelFade=1, panelBlend=1 → panel fully covers, PixiJS hidden
				//   panelFade=0.5             → panel half-faded, PixiJS half-visible
				//   panelFade=0               → panel gone, PixiJS fully visible
				const animOpacity = panelVisible ? 1 - panelBlend * panelFade : 1;
				const screenMorph = {
					...morph,
					width: screenW,
					height: screenH,
					opacity: morph.opacity * animOpacity,
				};
				const isCard = morph.cardBlend > 0;

				// Card-phase: use per-chapter Container for correct z-order
				// Dot/pill-phase: use shared morphGfx (cheaper, no z-order issue)
				const drawGfx = isCard && cardPool ? cardPool.acquire() : null;
				const targetGfx = drawGfx ? drawGfx.gfx : morphGfx;

				drawChapterNode(
					targetGfx,
					theme,
					screenMorph,
					nodeLeft,
					nodeTop,
					screenW,
					screenH,
					ch.status,
					ch.role,
				);

				// --- Chapter title text (unified for pill + card phases) ---
				if (screenMorph.titleOpacity > 0 && screenW > 30) {
					const cb = screenMorph.cardBlend;
					const titleFontSize = screenMorph.titleFontSize * cardScale;
					// Blend fill color: dimmed (pill) → cardText (card)
					const titleFill = cb > 0.5 ? theme.cardText : theme.dimmed;
					const titleWeight = cb > 0.5 ? "600" : "normal";
					const titleKey = `${Math.round(titleFontSize * 2) / 2}:${titleFill}:${titleWeight}`;
					const sc = cachedStylesRef.current;
					if (sc.chapterTitleKey !== titleKey || !sc.chapterTitleStyle) {
						sc.chapterTitleStyle = new TextStyle({
							fontSize: Math.round(titleFontSize * 2) / 2,
							fill: titleFill,
							fontFamily: "sans-serif",
							fontWeight: titleWeight,
						});
						sc.chapterTitleKey = titleKey;
					}

					// Title text is always horizontal — truncate based on CSS width
					const maxChars = Math.max(
						2,
						Math.floor((screenW - 22 * cardScale) / (titleFontSize * 0.55)),
					);
					const title = ch.title.length > maxChars ? `${ch.title.slice(0, maxChars)}…` : ch.title;

					// Use card slot's own TextPool when in card phase, shared pool otherwise
					const labelPool = drawGfx ? drawGfx.labels : chapterPool;
					if (labelPool) {
						const titleLabel = labelPool.acquire(sc.chapterTitleStyle);
						titleLabel.text = title;
						titleLabel.alpha = screenMorph.opacity * screenMorph.titleOpacity;
						titleLabel.scale.set(1);
						titleLabel.position.set(nodeLeft + 8 * cardScale, nodeTop + 6 * cardScale);

						// Card detail labels — only when card is tall enough
						if (cb > 0 && screenH > 36 * cardScale) {
							const badgeFontSize = 9 * cardScale;
							const badgeKey = `badge:${badgeFontSize}:${theme.dimmed}`;
							if (sc.cardBadgeKey !== badgeKey || !sc.cardBadgeStyle) {
								sc.cardBadgeStyle = new TextStyle({
									fontSize: badgeFontSize,
									fill: theme.dimmed,
									fontFamily: "sans-serif",
								});
								sc.cardBadgeKey = badgeKey;
							}
							const detailAlpha = Math.min(1, (screenH - 36 * cardScale) / (20 * cardScale)) * cb;

							// Status dot + label
							const statusColor = themeStatusColor(theme, ch.status);
							const dotY = nodeTop + 24 * cardScale;
							const dotR = 3 * cardScale;
							targetGfx
								.circle(nodeLeft + 12 * cardScale, dotY + 4 * cardScale, dotR)
								.fill({ color: statusColor, alpha: screenMorph.opacity * detailAlpha });

							const statusLabel = labelPool.acquire(sc.cardBadgeStyle);
							statusLabel.text = ch.status;
							statusLabel.alpha = screenMorph.opacity * 0.8 * detailAlpha;
							statusLabel.scale.set(1);
							statusLabel.position.set(nodeLeft + 18 * cardScale, dotY);

							// Narrator status (if any)
							if (ch.narratorStatus) {
								const nsColor = narratorStatusColor(
									theme,
									ch.narratorStatus,
									ch.narratorModelUnavailable,
								);
								const nsX =
									nodeLeft +
									18 * cardScale +
									(ch.status?.length ?? 0) * 5.5 * cardScale +
									10 * cardScale;
								targetGfx
									.circle(nsX, dotY + 4 * cardScale, 2.5 * cardScale)
									.fill({ color: nsColor, alpha: screenMorph.opacity * detailAlpha });
								const nsLabel = labelPool.acquire(sc.cardBadgeStyle);
								nsLabel.text = ch.narratorStatus;
								nsLabel.alpha = screenMorph.opacity * 0.6 * detailAlpha;
								nsLabel.scale.set(1);
								nsLabel.position.set(nsX + 6 * cardScale, dotY);
							}

							// Branch name — only when card is tall enough
							if (screenH > 52 * cardScale) {
								const branchAlpha = Math.min(1, (screenH - 52 * cardScale) / (16 * cardScale)) * cb;
								const branchLabel = labelPool.acquire(sc.cardBadgeStyle);
								const maxBranchChars = Math.max(
									4,
									Math.floor((screenW - 16 * cardScale) / (badgeFontSize * 0.55)),
								);
								branchLabel.text =
									(ch.branch?.length ?? 0) > maxBranchChars
										? `${ch.branch.slice(0, maxBranchChars)}…`
										: (ch.branch ?? "");
								branchLabel.alpha = screenMorph.opacity * 0.5 * branchAlpha;
								branchLabel.scale.set(1);
								branchLabel.position.set(nodeLeft + 8 * cardScale, nodeTop + 40 * cardScale);
							}
						}

						// Flush card slot's labels immediately (each slot is self-contained)
						if (drawGfx) labelPool.flush();
					}
				}
			}

			// --- Activity badge + tooltip for collapsed chapters ---
			if (!skipDraw && ch.status === "active" && !effectivePanel && chapterPool) {
				const activity = d.activityMap?.get(ch.id);
				if (activity && activity.count > 0) {
					const sc = cachedStylesRef.current;
					if (!sc.activityBadgeStyle) {
						sc.activityBadgeStyle = new TextStyle({
							fontSize: 9,
							fill: 0xffffff,
							fontFamily: "sans-serif",
							fontWeight: "bold",
						});
					}
					if (!sc.activityTooltipStyle) {
						sc.activityTooltipStyle = new TextStyle({
							fontSize: 11,
							fill: 0xc1c2c5,
							fontFamily: "sans-serif",
						});
					}
					const badgeAnchor = drawActivityBadge(
						morphGfx,
						chapterPool,
						sc.activityBadgeStyle,
						activity,
						nodeLeft,
						nodeTop,
						screenW,
						screenH,
						morph.opacity,
					);
					if (badgeAnchor) {
						drawActivityTooltip(
							morphGfx,
							chapterPool,
							sc.activityTooltipStyle,
							activity,
							nodeLeft + screenW / 2,
							nodeTop,
							screenW,
							morph.opacity,
							Date.now(),
						);
					}
				}
			}

			// --- Connector lines (all morph stages, unified position) ---
			// Store screen position for parent-to-child connectors
			chapterScreenPos.set(ch.id, {
				mainLeft: elemScreenLeft,
				mainSize: elemMainSize,
				crossCenter: elemScreenCenterCross,
			});

			const lineOpacity = t * (ch.status === "merged" ? 0.25 : 0.45);
			if (lineOpacity > 0.01) {
				// Check if this chapter's startCommitSha is on the ruler backbone
				const onBackbone = ch.startCommitSha ? d.tickPositions.has(ch.startCommitSha) : true;
				// Review chapters always connect to their parent chapter, not the ruler
				const forceParentConnector = ch.role === "review";

				if ((forceParentConnector || !onBackbone) && ch.parentChapterId) {
					// Orphan chapter: defer connector to after the loop so parent
					// position is guaranteed to be available
					deferredConnectors.push({
						parentId: ch.parentChapterId,
						elemScreenLeft,
						elemScreenCenterCross,
						opacity: lineOpacity,
					});
				} else {
					// Normal chapter: connect from ruler tick to chapter node
					const forkTickMain = ch.startCommitSha
						? (d.tickPositions.get(ch.startCommitSha) ?? ch.segMainPos)
						: ch.segMainPos;
					const forkScreenMain = toScreen(forkTickMain);

					drawConnector(
						connGfx,
						theme,
						forkScreenMain,
						elemScreenLeft,
						elemScreenCenterCross,
						rulerEdgeCrossScreen,
						isH,
						1, // screen space — fixed stroke width
						lineOpacity,
					);
				}
			}

			// Merge connector
			if (ch.status === "merged" && ch.mergeCommitSha) {
				const mergeTickMain = d.tickPositions.get(ch.mergeCommitSha);
				if (mergeTickMain != null) {
					const mergeScreenMain = toScreen(mergeTickMain);

					drawConnector(
						connGfx,
						theme,
						mergeScreenMain,
						elemScreenLeft + elemMainSize,
						elemScreenCenterCross,
						rulerEdgeCrossScreen,
						isH,
						1, // screen space — fixed stroke width
						t * 0.25,
					);
				}
			}
		}

		// Draw deferred connectors for orphan chapters (parent → child)
		for (const dc of deferredConnectors) {
			const parentPos = chapterScreenPos.get(dc.parentId);
			if (parentPos) {
				// Connect from parent chapter's end edge to child chapter's start edge
				drawConnector(
					connGfx,
					theme,
					parentPos.mainLeft + parentPos.mainSize,
					dc.elemScreenLeft,
					dc.elemScreenCenterCross,
					parentPos.crossCenter,
					isH,
					1,
					dc.opacity,
				);
			}
		}

		// Flush unused chapter labels and card containers
		chapterPool?.flush();
		cardPool?.flush();

		// Render
		app.render();

		// Schedule next frame if panel blend animation is in progress
		if (needsAnimFrame) {
			cancelAnimationFrame(panelAnimRafRef.current);
			panelAnimRafRef.current = requestAnimationFrame(() => {
				panelAnimRafRef.current = 0;
				redraw(latestCameraRef.current);
				// Notify parent to sync DOM panel positions with updated hit rects
				onPanelBlendUpdateRef.current?.();
			});
		}
	}, []);

	// --- Watch for Mantine theme changes ---
	useEffect(() => {
		const observer = new MutationObserver(() => {
			invalidatePixiThemeCache();
			redraw(dataRef.current.camera);
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-mantine-color-scheme"],
		});
		return () => observer.disconnect();
	}, [redraw]);

	// Imperative handle for fast-path camera updates
	useImperativeHandle(
		pixiRef,
		() => ({
			updateCamera(cam: Camera) {
				latestCameraRef.current = cam;
				redraw(cam);
			},
			render() {
				appRef.current?.render();
			},
			updateChapters(chs: PixiChapterInfo[] | null) {
				chaptersOverrideRef.current = chs;
				redraw(latestCameraRef.current);
			},
			getCardHitRects() {
				return cardHitRectsRef.current;
			},
		}),
		[redraw],
	);

	// Full redraw when data changes (React re-render path).
	// Skip redraw when only camera changed — the updateCamera fast-path already handled it.
	const prevDataDepsRef = useRef("");
	useEffect(() => {
		latestCameraRef.current = camera;
		// Build a fingerprint of all non-camera dependencies
		// Build activity fingerprint that changes when any activity entry updates
		let activityFp = "0";
		if (activityMap && activityMap.size > 0) {
			const parts: string[] = [];
			for (const [k, v] of activityMap) parts.push(`${k}:${v.count}:${v.timestamp}`);
			activityFp = parts.join(",");
		}
		const dataFingerprint = `${pixiReady}|${layout.totalWidth}|${segments.length}|${chapters.length}|${zoomTier}|${tickPositions.size}|${orientation}|${rulerThickness}|${commitMessages.size}|${alwaysVisibleChapters.length}|${openPanelChapterIds?.size ?? 0}|${activityFp}`;
		if (dataFingerprint === prevDataDepsRef.current) {
			// Only camera changed — updateCamera fast-path already drew this frame
			return;
		}
		prevDataDepsRef.current = dataFingerprint;
		redraw(camera);
	}, [
		pixiReady,
		camera,
		layout,
		segments,
		chapters,
		zoomTier,
		tickPositions,
		orientation,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
		activityMap,
		redraw,
	]);

	return (
		<div
			ref={containerDivRef}
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: containerWidth,
				height: containerHeight,
				pointerEvents: "none",
				zIndex: 1,
			}}
		/>
	);
});
