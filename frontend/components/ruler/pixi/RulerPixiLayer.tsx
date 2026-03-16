/**
 * PixiJS rendering layer for the ruler.
 * Handles all high-frequency visual elements: ticks, clusters, heatmap,
 * connector lines, and chapter node morph elements (dot → pill → card).
 * React DOM is only used for interactive NarratorPanel overlays above this layer.
 */
import { Application, Container, Graphics, TextStyle } from "pixi.js";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RulerSegment } from "../../../hooks/useRuler";
import type { CommitCluster } from "../commit-cluster";
import { COLLAPSED_GAP, type ElasticLayout, findTickAtX } from "../elastic-layout";
import { localScale, screenToWorld, viewCenterFromPan, worldToScreen } from "../fisheye";
import {
	CardContainerPool,
	drawChapterNode,
	drawClusterBlock,
	drawConnector,
	drawHeatmap,
	drawRulerTrackBg,
	drawTick,
	TextPool,
} from "../pixi-draw";
import type { RulerOrientation } from "../types";
import { getCenterFade, getMorphFactor, getMorphStyle, type ZoomTierId } from "../zoom-tiers";
import type { PixiTheme } from "./pixi-theme";
import { invalidatePixiThemeCache, resolvePixiTheme, themeStatusColor } from "./pixi-theme";

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
	startCommitSha: string | null;
	mergeCommitSha?: string | null;
	/** World-space layout position within the segment */
	layoutX: number;
	layoutY: number;
	/** The segment's main-axis world position */
	segMainPos: number;
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
	clusters: CommitCluster[];
	tickPositions: Map<string, number>;
	/** Dynamic ruler track thickness (changes when user drags the border) */
	rulerThickness: number;
	/** Commit SHA → first line of commit message */
	commitMessages: Map<string, string>;
	/** Active chapters that should always render as dots even at L0 */
	alwaysVisibleChapters: PixiChapterInfo[];
	/** Set of chapter IDs that have their narrator panel open (rendered by React) */
	openPanelChapterIds?: Set<string>;
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
const CARD_TOP_OFFSET = 2;

function narratorStatusColor(theme: PixiTheme, status: string): number {
	switch (status) {
		case "running":
			return theme.narratorRunning;
		case "done":
			return theme.narratorDone;
		case "error":
			return theme.narratorError;
		case "waiting":
			return theme.narratorWaiting;
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
	clusters,
	tickPositions,
	rulerThickness,
	commitMessages,
	alwaysVisibleChapters,
	openPanelChapterIds,
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
	}>({
		labelStyle: null,
		labelKey: "",
		msgStyle: null,
		msgKey: "",
		chapterTitleKey: "",
		chapterTitleStyle: null,
		cardBadgeKey: "",
		cardBadgeStyle: null,
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
		clusters,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
	});
	dataRef.current = {
		layout,
		segments,
		chapters,
		zoomTier,
		clusters,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
	};

	// Hit-test rectangles for card interaction (rebuilt each redraw)
	const cardHitRectsRef = useRef<CardHitRect[]>([]);

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
			if (destroyed) return; // Component unmounted before init finished — skip setup
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
			// Only destroy if init completed and app was fully set up
			if (appRef.current) {
				// Workaround for PixiJS v8 ResizePlugin bug: destroy() calls
				// _cancelResize() which may not exist when resizeTo is undefined.
				// See: https://github.com/pixijs/pixijs/issues/10pointer (v8.x)
				// biome-ignore lint/suspicious/noExplicitAny: PixiJS ResizePlugin internal
				const app = appRef.current as any;
				if (typeof app._cancelResize !== "function") {
					app._cancelResize = () => {};
				}
				appRef.current.destroy(true, { children: true });
			}
			appRef.current = null;
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

		// Pre-compute visible tick range via binary search to avoid iterating all ticks.
		// screenToWorld maps screen edges back to world coords; findTickAtX does binary search.
		const worldCullStart = screenToWorld(cullStart, viewCenter, mainViewport, cam.scale);
		const worldCullEnd = screenToWorld(cullEnd, viewCenter, mainViewport, cam.scale);
		const allTicks = d.layout.ticks;
		const visStartIdx = Math.max(0, findTickAtX(allTicks, worldCullStart) - 1);
		const visEndIdx = Math.min(allTicks.length - 1, findTickAtX(allTicks, worldCullEnd) + 1);

		// --- Draw ticks / clusters ---
		const usesClusters = d.zoomTier === "L0" || d.zoomTier === "L1";

		if (usesClusters && d.clusters.length > 0) {
			for (const cl of d.clusters) {
				const clScreen = toScreen(cl.worldPos);
				const clLS = getLocalScale(cl.worldPos);
				const clScreenSize = cl.worldSize * clLS;
				if (clScreen + clScreenSize < cullStart || clScreen - clScreenSize > cullEnd) continue;
				drawClusterBlock(
					tickGfx,
					theme,
					clScreen - clScreenSize / 2,
					clScreenSize,
					trackH,
					cl.count,
					cl.activeCount > 0,
					isH,
					cam.edge,
				);
			}

			// Draw individual ticks for fork/merge commits even in cluster mode
			const forkMergeShas = new Set<string>();
			for (const ch of d.chapters) {
				if (ch.startCommitSha) forkMergeShas.add(ch.startCommitSha);
				if (ch.mergeCommitSha) forkMergeShas.add(ch.mergeCommitSha);
			}
			if (forkMergeShas.size > 0) {
				for (let ti = visStartIdx; ti <= visEndIdx; ti++) {
					const tick = allTicks[ti];
					if (forkMergeShas.has(tick.sha)) {
						const screenX = toScreen(tick.x);
						const ls = getLocalScale(tick.x);
						drawTick(tickGfx, theme, screenX, trackH, true, ls, isH, cam.edge);
					}
				}
			}
		} else {
			// Compute tick stride: skip ticks when they'd be < 8px apart on screen
			const screenGap = COLLAPSED_GAP * cam.scale;
			const tickStride = screenGap < 8 ? Math.ceil(8 / screenGap) : 1;

			for (let ti = visStartIdx; ti <= visEndIdx; ti++) {
				const tick = allTicks[ti];
				const screenX = toScreen(tick.x);
				// Always show segment ticks; skip others based on stride
				if (!tick.segment && tickStride > 1 && tick.index % tickStride !== 0) continue;
				const ls = getLocalScale(tick.x);
				drawTick(tickGfx, theme, screenX, trackH, !!tick.segment, ls, isH, cam.edge);
			}
		}

		// --- Draw tick labels (L2+ only) ---
		const tickPool = tickLabelPoolRef.current;
		if (tickPool && !usesClusters) {
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

			// Center gap: the tick spacing at viewport center (no fisheye compression).
			// Text layout (word-wrap, truncation) is computed against this fixed width
			// so it only changes on zoom, not on pan. Each label is then squeezed along
			// the main axis by the fisheye ratio to fit the actual screen gap.
			const centerGap = COLLAPSED_GAP * cam.scale;

			// --- Horizontal vs Vertical layout parameters ---
			// Horizontal: text flows along X (main axis), width = tick gap, height = trackH
			// Vertical: text flows horizontally within the track width, height = tick gap
			const labelAvailMain = Math.max(0, centerGap - 8);
			const labelAvailCross = trackH - 8; // 4px padding each side

			const labelStride = isH
				? centerGap < 60
					? Math.ceil(60 / centerGap)
					: 1
				: centerGap < 24
					? Math.ceil(24 / centerGap)
					: 1;

			// Label cross-axis positioning depends on edge:
			// edge="start": labels at y≈4 (near screen edge), ticks at y≈trackH (near canvas)
			// edge="end":   labels at y≈trackH-fontSize-4 (near screen edge), ticks at y≈0 (near canvas)
			const edgeEnd = cam.edge === "end";
			const shaOffset = edgeEnd ? trackH - fontSize - 4 : 4;
			// Message offset on cross axis (H mode) or same column offset (V mode)
			const shaCrossSize = isH ? 0 : fontSize + 2;
			const msgCrossOffset = isH
				? edgeEnd
					? shaOffset - (isExpanded ? 14 : 12) // above SHA toward screen edge
					: isExpanded
						? 18
						: 16 // below SHA toward canvas
				: shaOffset;

			// Available space for commit message (H: cross-axis; V: main-axis gap minus SHA)
			const msgAvailH = edgeEnd
				? msgCrossOffset - 4 // space from msgCrossOffset up to track edge
				: trackH - msgCrossOffset - 4; // space from msgCrossOffset down to track edge
			const msgAvailV = Math.max(0, centerGap - shaCrossSize - 8);
			const msgLineH = 13;
			const maxMsgLines = isH
				? Math.max(1, Math.floor(msgAvailH / msgLineH))
				: Math.max(1, Math.floor(msgAvailV / msgLineH));

			// Message text wrapping width
			// H: wrap within tick gap (main axis); V: wrap within track width (cross axis)
			const msgWrapWidth = isH ? labelAvailMain : labelAvailCross;

			// Pre-compute message style
			const showMsg = isH
				? (showMessages || isExpanded) && msgAvailH > msgLineH * 0.5
				: msgAvailV > msgLineH * 0.8;
			if (showMsg) {
				const msgKey = `${theme.dimmed}:${Math.round(msgWrapWidth)}:${maxMsgLines}:${isH}`;
				if (sc.msgKey !== msgKey || !sc.msgStyle) {
					sc.msgStyle = new TextStyle({
						fontSize: 10,
						fill: theme.dimmed,
						fontFamily: "sans-serif",
						wordWrap: true,
						wordWrapWidth: Math.max(40, msgWrapWidth),
						breakWords: true,
					});
					sc.msgKey = msgKey;
				}
			}

			// Truncation limits
			const mainCharsPerLine = Math.max(4, Math.floor(labelAvailMain / 6));
			const crossCharsPerLine = Math.max(4, Math.floor(labelAvailCross / 6));
			const maxChars = isH ? mainCharsPerLine * maxMsgLines : crossCharsPerLine * maxMsgLines;

			for (let ti = visStartIdx; ti <= visEndIdx; ti++) {
				const tick = allTicks[ti];
				if (!tick.segment && labelStride > 1 && tick.index % labelStride !== 0) continue;
				const screenX = toScreen(tick.x);

				// Fisheye squeeze ratio: actual screen gap / center gap
				const nextTick = allTicks[ti + 1];
				const nextScreenX = nextTick ? toScreen(nextTick.x) : screenX + centerGap;
				const squeeze = centerGap > 0 ? Math.min(1, (nextScreenX - screenX) / centerGap) : 1;

				// SHA label
				const label = tickPool.acquire(labelStyle);
				label.rotation = 0;
				if (isH) {
					label.text = tick.sha.slice(0, 7);
					label.scale.set(squeeze, 1);
					label.position.set(screenX + 4, shaOffset);
				} else {
					// Vertical: horizontal text, truncate to fit track width
					const shaChars = Math.max(4, Math.floor(labelAvailCross / (fontSize * 0.6)));
					label.text = tick.sha.slice(0, Math.min(7, shaChars));
					label.scale.set(1, squeeze);
					label.position.set(shaOffset, screenX + 4);
				}

				// Commit message
				if (showMsg) {
					const msg = d.commitMessages.get(tick.sha);
					if (msg && sc.msgStyle) {
						const msgLabel = tickPool.acquire(sc.msgStyle);
						msgLabel.text = msg.length > maxChars ? `${msg.slice(0, maxChars)}…` : msg;
						msgLabel.rotation = 0;
						if (isH) {
							msgLabel.scale.set(squeeze, 1);
							msgLabel.position.set(screenX + 4, msgCrossOffset);
						} else {
							// V: message below SHA in the same column, squeezed along Y
							msgLabel.scale.set(1, squeeze);
							msgLabel.position.set(msgCrossOffset, screenX + shaCrossSize + 4);
						}
					}
				}
			}
		}
		tickPool?.flush();

		// --- Draw heatmap (L0 only) ---
		if (d.zoomTier === "L0" && d.clusters.length > 0) {
			// Map cluster positions to screen space for heatmap
			const screenClusters = d.clusters.map((cl) => {
				const sPos = toScreen(cl.worldPos);
				const ls = getLocalScale(cl.worldPos);
				return {
					worldPos: sPos,
					worldSize: cl.worldSize * ls,
					activeCount: cl.activeCount,
				};
			});
			drawHeatmap(heatGfx, theme, screenClusters, trackH, isH);
		}

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

		for (const ch of merged) {
			const chWorldMain = ch.segMainPos + ch.layoutX + NODE_WIDTH / 2;
			const ls = getLocalScale(chWorldMain);

			// Morph factor is the minimum of two independent factors:
			// 1) Global zoom level — what morph phase the camera scale alone warrants
			// 2) Fisheye edge fade — how much the chapter is compressed at the edge
			// This keeps cards visible as long as the zoom is deep enough AND the
			// chapter hasn't been pushed too far into the fisheye periphery.
			const tZoom = getMorphFactor(cam.scale);
			const tEdge = getMorphFactor(ls);
			let t = Math.min(tZoom, tEdge);

			// Active chapters always show at least as a dot
			if (t <= 0 && ch.status === "active") t = 0.15;
			if (t <= 0) continue;
			// Guard against stale/incomplete chapter data after cleanup
			if (!ch.title || !ch.status) continue;

			const morph = getMorphStyle(t, NODE_WIDTH, NODE_HEIGHT);
			const centerFade = getCenterFade(t);
			const centerOffsetX = (NODE_WIDTH - morph.width) / 2;
			const centerOffsetY = (NODE_HEIGHT - morph.height) / 2;

			// --- Unified position: always compute left-edge world coord ---
			// This ensures pill and card use the exact same anchor through
			// the fisheye transform, eliminating the position jump.
			const elemWorldMain = ch.segMainPos + ch.layoutX + centerOffsetX * centerFade;
			const elemScreenLeft = toScreen(elemWorldMain);
			// Main-axis size of the element in screen pixels (used for connector endpoints).
			// In horizontal mode the card's CSS width runs along the main axis;
			// in vertical mode the card's CSS height runs along the main axis.
			const elemMainSize = isH ? morph.width : morph.height;

			const elemScreenCross =
				crossBase +
				(ch.layoutY + CARD_TOP_OFFSET) * cam.scale +
				crossPan +
				centerOffsetY * centerFade;
			const elemScreenCenterCross = elemScreenCross + morph.height / 2;

			const hasPanel = d.openPanelChapterIds?.has(ch.id);

			// --- Draw unified chapter node (single path: dot → pill → card) ---
			// Card visual dimensions stay the same regardless of orientation —
			// only the position axes swap. morph.width is always the card's
			// CSS width and morph.height is always the CSS height.
			const screenW = morph.width;
			const screenH = morph.height;
			const nodeLeft = isH ? elemScreenLeft : elemScreenCross;
			const nodeTop = isH ? elemScreenCross : elemScreenLeft;

			// Always track hit rects for card-like chapters (panels need them for positioning)
			if (morph.cardBlend > 0) {
				cardHitRects.push({
					id: ch.id,
					narratorId: ch.narratorId,
					fromSha: ch.startCommitSha ?? "",
					screenX: nodeLeft,
					screenY: nodeTop,
					width: screenW,
					height: screenH,
					layoutX: ch.layoutX,
					layoutY: ch.layoutY,
				});
			}

			if (!hasPanel) {
				const screenMorph = { ...morph, width: screenW, height: screenH };
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
				if (morph.titleOpacity > 0 && screenW > 30) {
					const cb = morph.cardBlend;
					const titleFontSize = morph.titleFontSize;
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
					const maxChars = Math.max(2, Math.floor((screenW - 22) / (titleFontSize * 0.55)));
					const title = ch.title.length > maxChars ? `${ch.title.slice(0, maxChars)}…` : ch.title;

					// Use card slot's own TextPool when in card phase, shared pool otherwise
					const labelPool = drawGfx ? drawGfx.labels : chapterPool;
					if (labelPool) {
						const titleLabel = labelPool.acquire(sc.chapterTitleStyle);
						titleLabel.text = title;
						titleLabel.alpha = morph.opacity * morph.titleOpacity;
						titleLabel.scale.set(1);
						titleLabel.position.set(nodeLeft + 8, nodeTop + 6);

						// Card detail labels — only when card is tall enough
						if (cb > 0 && screenH > 36) {
							const badgeFontSize = 9;
							const badgeKey = `badge:${badgeFontSize}:${theme.dimmed}`;
							if (sc.cardBadgeKey !== badgeKey || !sc.cardBadgeStyle) {
								sc.cardBadgeStyle = new TextStyle({
									fontSize: badgeFontSize,
									fill: theme.dimmed,
									fontFamily: "sans-serif",
								});
								sc.cardBadgeKey = badgeKey;
							}
							const detailAlpha = Math.min(1, (screenH - 36) / 20) * cb;

							// Status dot + label
							const statusColor = themeStatusColor(theme, ch.status);
							const dotY = nodeTop + 24;
							targetGfx
								.circle(nodeLeft + 12, dotY + 4, 3)
								.fill({ color: statusColor, alpha: morph.opacity * detailAlpha });

							const statusLabel = labelPool.acquire(sc.cardBadgeStyle);
							statusLabel.text = ch.status;
							statusLabel.alpha = morph.opacity * 0.8 * detailAlpha;
							statusLabel.scale.set(1);
							statusLabel.position.set(nodeLeft + 18, dotY);

							// Narrator status (if any)
							if (ch.narratorStatus) {
								const nsColor = narratorStatusColor(theme, ch.narratorStatus);
								const nsX = nodeLeft + 18 + (ch.status?.length ?? 0) * 5.5 + 10;
								targetGfx
									.circle(nsX, dotY + 4, 2.5)
									.fill({ color: nsColor, alpha: morph.opacity * detailAlpha });
								const nsLabel = labelPool.acquire(sc.cardBadgeStyle);
								nsLabel.text = ch.narratorStatus;
								nsLabel.alpha = morph.opacity * 0.6 * detailAlpha;
								nsLabel.scale.set(1);
								nsLabel.position.set(nsX + 6, dotY);
							}

							// Branch name — only when card is tall enough
							if (screenH > 52) {
								const branchAlpha = Math.min(1, (screenH - 52) / 16) * cb;
								const branchLabel = labelPool.acquire(sc.cardBadgeStyle);
								const maxBranchChars = Math.max(
									4,
									Math.floor((screenW - 16) / (badgeFontSize * 0.55)),
								);
								branchLabel.text =
									(ch.branch?.length ?? 0) > maxBranchChars
										? `${ch.branch.slice(0, maxBranchChars)}…`
										: (ch.branch ?? "");
								branchLabel.alpha = morph.opacity * 0.5 * branchAlpha;
								branchLabel.scale.set(1);
								branchLabel.position.set(nodeLeft + 8, nodeTop + 40);
							}
						}

						// Flush card slot's labels immediately (each slot is self-contained)
						if (drawGfx) labelPool.flush();
					}
				}
			}

			// --- Connector lines (all morph stages, unified position) ---
			const lineOpacity = t * (ch.status === "merged" ? 0.25 : 0.45);
			if (lineOpacity > 0.01) {
				// Prefer exact tick position; fall back to segment origin when the
				// chapter's startCommitSha is not a segment boundary tick or is null.
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

		// Flush unused chapter labels and card containers
		chapterPool?.flush();
		cardPool?.flush();

		// Render
		app.render();
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

	// Full redraw when data changes (React re-render path)
	// biome-ignore lint/correctness/useExhaustiveDependencies: data read from refs
	useEffect(() => {
		latestCameraRef.current = camera;
		redraw(camera);
	}, [
		pixiReady,
		camera,
		layout,
		segments,
		chapters,
		zoomTier,
		clusters,
		tickPositions,
		orientation,
		rulerThickness,
		commitMessages,
		alwaysVisibleChapters,
		openPanelChapterIds,
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
