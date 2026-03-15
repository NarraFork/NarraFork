/**
 * PixiJS rendering layer for the ruler.
 * Handles all high-frequency visual elements: ticks, clusters, heatmap,
 * connector lines, and dot/pill morph elements.
 * React DOM is only used for interactive ChapterCards above this layer.
 */
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { RulerSegment } from "../../../hooks/useRuler";
import type { CommitCluster } from "../commit-cluster";
import { COLLAPSED_GAP, type ElasticLayout } from "../elastic-layout";
import {
	drawClusterBlock,
	drawConnector,
	drawHeatmap,
	drawMorph,
	drawRulerTrackBg,
	drawSegmentBg,
	drawTick,
} from "../pixi-draw";
import type { RulerOrientation } from "../types";
import { getMorphFactor, getMorphStyle, type ZoomTierId } from "../zoom-tiers";
import { invalidatePixiThemeCache, resolvePixiTheme } from "./pixi-theme";

// Re-export for parent
export type { RulerPixiHandle };

/** Chapter info needed for morph + connector drawing */
export interface PixiChapterInfo {
	id: string;
	status: string;
	title: string;
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
	edge: string;
}

interface RulerPixiHandle {
	/** Fast-path: update camera transform without React re-render */
	updateCamera(cam: Camera): void;
	/** Trigger a full re-render of the PixiJS scene */
	render(): void;
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
	scale: number;
	zoomCenterWorldX: number;
	viewportWorldWidth: number;
	tickPositions: Map<string, number>;
	/** Dynamic ruler track thickness (changes when user drags the border) */
	rulerThickness: number;
	/** Commit SHA → first line of commit message */
	commitMessages: Map<string, string>;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const CARD_TOP_OFFSET = 30;

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
	scale,
	zoomCenterWorldX,
	viewportWorldWidth,
	tickPositions,
	rulerThickness,
	commitMessages,
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
	const segBgGfxRef = useRef<Graphics | null>(null);
	const heatmapGfxRef = useRef<Graphics | null>(null);
	const trackBgGfxRef = useRef<Graphics | null>(null);
	const rulerMaskGfxRef = useRef<Graphics | null>(null);

	// Text object pools (reused each frame to avoid GC)
	const tickLabelPoolRef = useRef<Text[]>([]);
	const tickLabelContainerRef = useRef<Container | null>(null);
	const pillLabelPoolRef = useRef<Text[]>([]);
	const pillLabelContainerRef = useRef<Container | null>(null);

	// Cached TextStyle objects — reused across frames, only rebuilt when parameters change
	const cachedStylesRef = useRef<{
		labelStyle: TextStyle | null;
		labelKey: string;
		msgStyle: TextStyle | null;
		msgKey: string;
		pillStyle: TextStyle | null;
		pillKey: string;
	}>({
		labelStyle: null,
		labelKey: "",
		msgStyle: null,
		msgKey: "",
		pillStyle: null,
		pillKey: "",
	});

	// Latest data refs (avoid stale closures in imperative handle)
	const dataRef = useRef({
		layout,
		segments,
		chapters,
		zoomTier,
		clusters,
		scale,
		zoomCenterWorldX,
		viewportWorldWidth,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
	});
	dataRef.current = {
		layout,
		segments,
		chapters,
		zoomTier,
		clusters,
		scale,
		zoomCenterWorldX,
		viewportWorldWidth,
		tickPositions,
		orientation,
		containerWidth,
		containerHeight,
		camera,
		rulerThickness,
		commitMessages,
	};

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

			// Mount PixiJS-created canvas into our container div
			const pixiCanvas = app.canvas as HTMLCanvasElement;
			pixiCanvas.style.position = "absolute";
			pixiCanvas.style.top = "0";
			pixiCanvas.style.left = "0";
			pixiCanvas.style.width = `${containerWidth}px`;
			pixiCanvas.style.height = `${containerHeight}px`;
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
			const segBgGfx = new Graphics();
			const connectorGfx = new Graphics();
			const morphGfx = new Graphics();
			const heatmapGfx = new Graphics();
			const tickGfx = new Graphics();

			worldContainer.addChild(segBgGfx);
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

			// Text label containers
			const tickLabelContainer = new Container();
			const pillLabelContainer = new Container();
			rulerContainer.addChild(tickLabelContainer);
			worldContainer.addChild(pillLabelContainer);

			trackBgGfxRef.current = trackBgGfx;
			rulerMaskGfxRef.current = rulerMaskGfx;
			tickLabelContainerRef.current = tickLabelContainer;
			pillLabelContainerRef.current = pillLabelContainer;

			tickGfxRef.current = tickGfx;
			morphGfxRef.current = morphGfx;
			connectorGfxRef.current = connectorGfx;
			segBgGfxRef.current = segBgGfx;
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
	useEffect(() => {
		const app = appRef.current;
		if (!app?.renderer) return;
		app.renderer.resize(containerWidth, containerHeight);
		const pixiCanvas = app.canvas as HTMLCanvasElement;
		if (pixiCanvas) {
			pixiCanvas.style.width = `${containerWidth}px`;
			pixiCanvas.style.height = `${containerHeight}px`;
		}
	}, [containerWidth, containerHeight]);

	// --- Text pool helper ---
	const getPooledText = useCallback(
		(pool: Text[], container: Container, index: number, style: TextStyle): Text => {
			if (index < pool.length) {
				const t = pool[index];
				t.visible = true;
				t.style = style;
				return t;
			}
			const t = new Text({ text: "", style });
			pool.push(t);
			container.addChild(t);
			return t;
		},
		[],
	);

	const hidePooledTexts = useCallback((pool: Text[], fromIndex: number) => {
		for (let i = fromIndex; i < pool.length; i++) {
			pool[i].visible = false;
		}
	}, []);

	// --- Full redraw function ---
	const redraw = useCallback(
		(cam: Camera) => {
			const app = appRef.current;
			if (!app) return;

			const d = dataRef.current;
			const isH = cam.orientation === "horizontal";
			const trackH = d.rulerThickness;

			// Update world container transform
			const wc = worldContainerRef.current;
			if (wc) {
				if (isH) {
					wc.position.set(cam.panX, cam.panY + trackH);
					wc.scale.set(cam.scale);
				} else {
					wc.position.set(cam.panX + trackH, cam.panY);
					wc.scale.set(cam.scale);
				}
			}

			// Update ruler container position
			const rc = rulerContainerRef.current;
			if (rc) {
				if (isH) {
					rc.position.set(cam.panX, 0);
					rc.scale.set(cam.scale, 1);
				} else {
					rc.position.set(0, cam.panY);
					rc.scale.set(1, cam.scale);
				}
			}

			// --- Clear all graphics ---
			tickGfxRef.current?.clear();
			morphGfxRef.current?.clear();
			connectorGfxRef.current?.clear();
			segBgGfxRef.current?.clear();
			heatmapGfxRef.current?.clear();
			trackBgGfxRef.current?.clear();
			rulerMaskGfxRef.current?.clear();

			const tickGfx = tickGfxRef.current;
			const morphGfx = morphGfxRef.current;
			const connGfx = connectorGfxRef.current;
			const segBgGfx = segBgGfxRef.current;
			const heatGfx = heatmapGfxRef.current;
			const trackBgGfx = trackBgGfxRef.current;
			const rulerMaskGfx = rulerMaskGfxRef.current;
			if (!tickGfx || !morphGfx || !connGfx || !segBgGfx || !heatGfx || !trackBgGfx) return;

			// --- Update ruler mask to clip contents within the track area ---
			// The mask is in rulerContainer's local space.
			// rulerContainer is positioned at (panX, 0) with scale (scale, 1) for horizontal,
			// so we need a rect that covers the visible viewport in local coords.
			if (rulerMaskGfx) {
				const maskW = isH ? d.containerWidth / cam.scale : trackH;
				const maskH = isH ? trackH : d.containerHeight / cam.scale;
				const maskX = isH ? -cam.panX / cam.scale : 0;
				const maskY = isH ? 0 : -cam.panY / cam.scale;
				rulerMaskGfx.rect(maskX, maskY, maskW, maskH).fill({ color: 0xffffff });
			}

			// --- Resolve theme ---
			const theme = resolvePixiTheme();

			// --- Draw ruler track background ---
			const trackWorldWidth = d.layout.totalWidth + 200;
			drawRulerTrackBg(trackBgGfx, theme, trackWorldWidth, trackH);

			// --- Viewport culling ---
			const mainPan = isH ? cam.panX : cam.panY;
			const mainViewport = isH ? d.containerWidth : d.containerHeight;
			const worldViewStart = -mainPan / cam.scale;
			const worldViewEnd = worldViewStart + mainViewport / cam.scale;
			const buffer = (worldViewEnd - worldViewStart) * 0.5;
			const cullStart = worldViewStart - buffer;
			const cullEnd = worldViewEnd + buffer;

			// --- Draw ticks / clusters ---
			const usesClusters = d.zoomTier === "L0" || d.zoomTier === "L1";

			if (usesClusters && d.clusters.length > 0) {
				for (const cl of d.clusters) {
					if (cl.worldPos + cl.worldSize < cullStart || cl.worldPos - cl.worldSize > cullEnd)
						continue;
					drawClusterBlock(
						tickGfx,
						theme,
						cl.worldPos - cl.worldSize / 2,
						cl.worldSize,
						trackH,
						cl.count,
						cl.activeCount > 0,
					);
				}
			} else {
				// Compute tick stride: skip ticks when they'd be < 8px apart on screen
				const screenGap = COLLAPSED_GAP * cam.scale;
				const tickStride = screenGap < 8 ? Math.ceil(8 / screenGap) : 1;

				for (const tick of d.layout.ticks) {
					if (tick.x < cullStart || tick.x > cullEnd) continue;
					// Always show segment ticks; skip others based on stride
					if (!tick.segment && tickStride > 1 && tick.index % tickStride !== 0) continue;
					drawTick(tickGfx, theme, tick.x, trackH, !!tick.segment, cam.scale);
				}
			}

			// --- Draw tick labels (L2+ only) ---
			const tickLabelContainer = tickLabelContainerRef.current;
			const tickLabelPool = tickLabelPoolRef.current;
			if (tickLabelContainer && !usesClusters) {
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

				const counterScaleX = 1 / cam.scale;
				const labelScreenGap = COLLAPSED_GAP * cam.scale;
				const labelStride = labelScreenGap < 60 ? Math.ceil(60 / labelScreenGap) : 1;

				// Available vertical space for commit message (below SHA line)
				const msgTopOffset = isExpanded ? 18 : 16;
				const availableHeight = trackH - msgTopOffset - 4; // 4px bottom padding
				// Approximate line height for message text
				const msgLineH = 13;
				const maxLines = Math.max(1, Math.floor(availableHeight / msgLineH));

				let labelIdx = 0;
				const ticks = d.layout.ticks;
				for (let ti = 0; ti < ticks.length; ti++) {
					const tick = ticks[ti];
					if (tick.x < cullStart || tick.x > cullEnd) continue;
					if (!tick.segment && labelStride > 1 && tick.index % labelStride !== 0) continue;

					// Compute available width: distance to next visible tick (in world space)
					const nextTick = ticks[ti + 1];
					const tickGap = nextTick ? nextTick.x - tick.x : COLLAPSED_GAP;
					// Padding so text doesn't touch the next tick
					const availableWorldW = Math.max(0, tickGap - 8 / cam.scale);

					// SHA label
					const label = getPooledText(tickLabelPool, tickLabelContainer, labelIdx, labelStyle);
					label.text = tick.sha.slice(0, 7);
					label.scale.set(counterScaleX, 1);
					if (isH) {
						label.position.set(tick.x + 4 / cam.scale, 4);
					} else {
						label.position.set(4, tick.x + 4 / cam.scale);
					}
					labelIdx++;

					// Commit message (when zoomed in enough or ruler expanded)
					if ((showMessages || isExpanded) && availableHeight > msgLineH * 0.5) {
						const msg = d.commitMessages.get(tick.sha);
						if (msg) {
							// Word-wrap width = available world width (counter-scaled to screen px)
							const wrapPx = availableWorldW * cam.scale;
							const msgKey = `${theme.dimmed}:${Math.round(wrapPx)}:${maxLines}`;
							if (sc.msgKey !== msgKey || !sc.msgStyle) {
								sc.msgStyle = new TextStyle({
									fontSize: 10,
									fill: theme.dimmed,
									fontFamily: "sans-serif",
									wordWrap: true,
									wordWrapWidth: Math.max(40, wrapPx),
								});
								sc.msgKey = msgKey;
							}
							const msgLabel = getPooledText(
								tickLabelPool,
								tickLabelContainer,
								labelIdx,
								sc.msgStyle,
							);
							// Truncate to fit available lines
							const charsPerLine = Math.max(4, Math.floor(wrapPx / 6));
							const maxChars = charsPerLine * maxLines;
							msgLabel.text = msg.length > maxChars ? `${msg.slice(0, maxChars)}…` : msg;
							msgLabel.scale.set(counterScaleX, 1);
							if (isH) {
								msgLabel.position.set(tick.x + 4 / cam.scale, msgTopOffset);
							} else {
								msgLabel.position.set(msgTopOffset, tick.x + 4 / cam.scale);
							}
							labelIdx++;
						}
					}
				}
				hidePooledTexts(tickLabelPool, labelIdx);
			} else if (tickLabelContainer) {
				hidePooledTexts(tickLabelPool, 0);
			}

			// --- Draw heatmap (L0 only) ---
			if (d.zoomTier === "L0" && d.clusters.length > 0) {
				drawHeatmap(heatGfx, theme, d.clusters, trackH);
			}

			// --- Draw segment backgrounds ---
			for (const tick of d.layout.ticks) {
				if (!tick.segment) continue;
				if (tick.x > cullEnd) break;
				const nextTick = d.layout.ticks[tick.index + 1];
				const segW = nextTick ? nextTick.x - tick.x : 400;
				if (tick.x + segW < cullStart) continue;

				const crossSize = (isH ? d.containerHeight : d.containerWidth) / cam.scale;
				drawSegmentBg(segBgGfx, theme, tick.x, 0, segW, crossSize);
			}

			// --- Draw morph elements + connectors ---
			const pillLabelContainer = pillLabelContainerRef.current;
			const pillLabelPool = pillLabelPoolRef.current;
			let pillLabelIdx = 0;

			for (const ch of d.chapters) {
				const worldX = ch.segMainPos + ch.layoutX + NODE_WIDTH / 2;
				const t = getMorphFactor(cam.scale, worldX, d.zoomCenterWorldX, d.viewportWorldWidth);
				if (t <= 0) continue;

				const morph = getMorphStyle(t, NODE_WIDTH, NODE_HEIGHT);

				// Don't draw morph if showCardBody — React DOM handles that
				if (!morph.showCardBody) {
					const centerFade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
					const centerOffsetX = (NODE_WIDTH - morph.width) / 2;
					const centerOffsetY = (NODE_HEIGHT - morph.height) / 2;
					const cx =
						ch.segMainPos +
						ch.layoutX +
						NODE_WIDTH / 2 +
						centerOffsetX * centerFade -
						centerOffsetX;
					const cy =
						ch.layoutY +
						CARD_TOP_OFFSET +
						NODE_HEIGHT / 2 +
						centerOffsetY * centerFade -
						centerOffsetY;

					drawMorph(morphGfx, theme, morph, cx, cy, ch.status, cam.scale);

					// Pill title text (only when titleOpacity > 0 and pill is wide enough)
					const screenToWorld = morph.titleOpacity;
					const counterScale = 1 + (1 / cam.scale - 1) * (1 - screenToWorld);
					const pillW = morph.width * counterScale;
					const pillH = morph.height * counterScale;

					if (morph.titleOpacity > 0 && pillW * cam.scale > 30 && pillLabelContainer) {
						const pillFontSize = Math.round(morph.titleFontSize * 2) / 2; // snap to 0.5px
						const pillKey = `${pillFontSize}:${theme.dimmed}`;
						const sc = cachedStylesRef.current;
						if (sc.pillKey !== pillKey || !sc.pillStyle) {
							sc.pillStyle = new TextStyle({
								fontSize: pillFontSize,
								fill: theme.dimmed,
								fontFamily: "sans-serif",
							});
							sc.pillKey = pillKey;
						}
						const label = getPooledText(
							pillLabelPool,
							pillLabelContainer,
							pillLabelIdx,
							sc.pillStyle,
						);
						const maxChars = Math.max(
							2,
							Math.floor((pillW * cam.scale - 22) / (morph.titleFontSize * 0.55)),
						);
						const title = ch.title.length > maxChars ? `${ch.title.slice(0, maxChars)}…` : ch.title;
						label.text = title;
						label.alpha = morph.opacity * morph.titleOpacity;
						label.scale.set(counterScale);
						const left = cx - pillW / 2;
						const top = cy - pillH / 2;
						label.position.set(
							left + 18 * counterScale,
							top + (pillH - morph.titleFontSize * counterScale) / 2,
						);
						pillLabelIdx++;
					}
				}

				// Connector lines (all morph stages)
				const lineOpacity = t * (ch.status === "merged" ? 0.25 : 0.45);
				if (ch.startCommitSha && lineOpacity > 0.01) {
					const forkTickMain = d.tickPositions.get(ch.startCommitSha);
					if (forkTickMain != null) {
						const centerFade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
						const centerOffsetX = (NODE_WIDTH - morph.width) / 2;
						const centerOffsetY = (NODE_HEIGHT - morph.height) / 2;
						const elemLeft = ch.segMainPos + ch.layoutX + centerOffsetX * centerFade;
						const elemTop = ch.layoutY + CARD_TOP_OFFSET + centerOffsetY * centerFade;
						const elemCenterCross = isH ? elemTop + morph.height / 2 : elemLeft + morph.width / 2;
						const elemLeadMain = isH ? elemLeft : elemTop;

						drawConnector(
							connGfx,
							theme,
							forkTickMain,
							elemLeadMain,
							elemCenterCross,
							-trackH / cam.scale,
							isH,
							cam.scale,
							lineOpacity,
						);
					}
				}

				// Merge connector
				if (ch.status === "merged" && ch.mergeCommitSha) {
					const mergeTickMain = d.tickPositions.get(ch.mergeCommitSha);
					if (mergeTickMain != null) {
						const centerFade = t < 0.7 ? 1 : Math.max(0, 1 - (t - 0.7) / 0.3);
						const centerOffsetX = (NODE_WIDTH - morph.width) / 2;
						const centerOffsetY = (NODE_HEIGHT - morph.height) / 2;
						const elemLeft = ch.segMainPos + ch.layoutX + centerOffsetX * centerFade;
						const elemTop = ch.layoutY + CARD_TOP_OFFSET + centerOffsetY * centerFade;
						const elemCenterCross = isH ? elemTop + morph.height / 2 : elemLeft + morph.width / 2;
						const elemTrailMain = isH ? elemLeft + morph.width : elemTop + morph.height;

						drawConnector(
							connGfx,
							theme,
							mergeTickMain,
							elemTrailMain,
							elemCenterCross,
							-trackH / cam.scale,
							isH,
							cam.scale,
							t * 0.25,
						);
					}
				}
			}

			// Hide unused pill labels
			if (pillLabelContainer) {
				hidePooledTexts(pillLabelPool, pillLabelIdx);
			}

			// Render
			app.render();
		},
		[getPooledText, hidePooledTexts],
	);

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
				redraw(cam);
			},
			render() {
				appRef.current?.render();
			},
		}),
		[redraw],
	);

	// Full redraw when data changes (React re-render path)
	// biome-ignore lint/correctness/useExhaustiveDependencies: data read from refs
	useEffect(() => {
		redraw(camera);
	}, [
		pixiReady,
		camera,
		layout,
		segments,
		chapters,
		zoomTier,
		clusters,
		scale,
		zoomCenterWorldX,
		viewportWorldWidth,
		tickPositions,
		orientation,
		rulerThickness,
		commitMessages,
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
