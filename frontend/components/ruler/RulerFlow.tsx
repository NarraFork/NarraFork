import { ActionIcon, Box, Center, Group, Loader, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconArrowsHorizontal,
	IconArrowsVertical,
	IconHome,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarRightCollapse,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RulerData, type RulerSegment, useRulerData } from "../../hooks/useRuler";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { clusterCommits } from "./commit-cluster";
import {
	COLLAPSED_GAP,
	computeElasticLayout,
	findTickAtX,
	type TickPosition,
} from "./elastic-layout";
import { screenToWorld, solvePanForAnchor, viewCenterFromPan, worldToScreen } from "./fisheye";
import { OffscreenBubbles } from "./OffscreenBubbles";
import { type PixiChapterInfo, type RulerPixiHandle, RulerPixiLayer } from "./pixi/RulerPixiLayer";
import { ChapterContextMenu, TickContextMenu } from "./RulerContextMenus";
import { type ChapterContextMenuState, SegmentCanvas } from "./SegmentCanvas";
import {
	DEFAULT_RULER_THICKNESS,
	MAX_RULER_THICKNESS,
	type RulerEdge,
	type RulerOrientation,
} from "./types";
import { getZoomTierInfo, type ZoomTierId } from "./zoom-tiers";

interface RulerFlowProps {
	projectId: string;
	focusChapterId?: string | null;
}

/** Multiplier of viewport size used as off-screen buffer for expanded segment canvases */
const SEGMENT_VIEWPORT_MULTIPLIER = 3;

interface Camera {
	panX: number;
	panY: number;
	scale: number;
	orientation: RulerOrientation;
	edge: RulerEdge;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const NODE_GAP = 16;

interface ClampBounds {
	maxContentCross: number;
	crossViewportSize: number;
	maxContentMain: number;
	mainViewportSize: number;
}

/** Compute the hard min/max for each axis. */
function getMainBounds(opts: ClampBounds, scale: number) {
	const max = opts.mainViewportSize * 0.75; // allow at most 3/4 viewport empty space at start
	const min = -opts.maxContentMain * scale + opts.mainViewportSize * 0.25; // keep at least 1/4 viewport showing content at end
	return { min, max };
}

/** Rubber-band: the further past the boundary, the more resistance. */
function rubberBand(value: number, min: number, max: number, viewport: number): number {
	const range = viewport * 0.5;
	if (value > max) {
		const over = value - max;
		return max + range * (1 - 1 / (over / range + 1));
	}
	if (value < min) {
		const over = min - value;
		return min - range * (1 - 1 / (over / range + 1));
	}
	return value;
}

function getCrossBounds(opts: ClampBounds, scale: number) {
	const PADDING = 200;
	const max = 0;
	const min =
		opts.maxContentCross > 0
			? Math.min(0, -(opts.maxContentCross + PADDING) * scale + opts.crossViewportSize)
			: 0;
	return { min, max };
}

/** Hard clamp — snaps to bounds. Used for navigation targets and bounce destinations. */
function clampCamera(cam: Camera, opts?: ClampBounds, soft?: boolean): Camera {
	const isH = cam.orientation === "horizontal";
	let mainPan = isH ? cam.panX : cam.panY;
	let crossPan = isH ? cam.panY : cam.panX;

	if (opts) {
		const cb = getCrossBounds(opts, cam.scale);
		crossPan = Math.max(cb.min, Math.min(cb.max, crossPan));

		if (opts.maxContentMain > 0) {
			const mb = getMainBounds(opts, cam.scale);
			if (soft) {
				mainPan = rubberBand(mainPan, mb.min, mb.max, opts.mainViewportSize);
			} else {
				mainPan = Math.max(mb.min, Math.min(mb.max, mainPan));
			}
		}
	}

	if (isH) {
		const changed = mainPan !== cam.panX || crossPan !== cam.panY;
		return changed ? { ...cam, panX: mainPan, panY: crossPan } : cam;
	}
	const changed = mainPan !== cam.panY || crossPan !== cam.panX;
	return changed ? { ...cam, panX: crossPan, panY: mainPan } : cam;
}

export function RulerFlow({ projectId }: RulerFlowProps) {
	const { t } = useTranslation("graph");
	const { data, isLoading, error } = useRulerData(projectId);
	const { data: prefs } = useUserPreferences();
	const queryClient = useQueryClient();
	// --- Camera state: ref is source of truth, state drives render via rAF ---
	const hasRulerViewportRef = useRef(false);
	const savedCamera = useMemo<Camera>(() => {
		try {
			const raw = (prefs as Record<string, unknown> | undefined)?.graphViewports;
			let viewports: Record<
				string,
				{
					x: number;
					y: number;
					zoom: number;
					rulerOrientation?: RulerOrientation;
					rulerEdge?: RulerEdge;
					rulerMainPan?: number;
					rulerCrossPan?: number;
				}
			> = {};
			if (typeof raw === "string") viewports = JSON.parse(raw);
			else if (raw && typeof raw === "object") viewports = raw as typeof viewports;
			const v = viewports[projectId];
			// Only restore if this was saved by the ruler (has rulerMainPan).
			// Classic mode viewports share the same key but have incompatible coordinates.
			if (v?.rulerMainPan != null) {
				hasRulerViewportRef.current = true;
				const ori = v.rulerOrientation ?? "horizontal";
				const isH = ori === "horizontal";
				const mainPan = v.rulerMainPan;
				const crossPan = v.rulerCrossPan ?? 0;
				return clampCamera({
					panX: isH ? mainPan : crossPan,
					panY: isH ? crossPan : mainPan,
					scale: v.zoom,
					orientation: ori,
					edge: v.rulerEdge ?? "start",
				});
			}
		} catch {
			/* corrupted */
		}
		hasRulerViewportRef.current = false;
		return { panX: 40, panY: 0, scale: 1, orientation: "horizontal", edge: "start" };
	}, [prefs, projectId]);

	const cameraRef = useRef<Camera>(savedCamera);
	const [camera, setCamera] = useState<Camera>(savedCamera);
	const [rulerThickness, setRulerThickness] = useState(DEFAULT_RULER_THICKNESS);
	const rulerDragRef = useRef<{ startY: number; startThickness: number } | null>(null);
	const rulerDragCleanupRef = useRef<(() => void) | null>(null);
	const cameraInitializedRef = useRef(false);
	const [needsInitialPosition, setNeedsInitialPosition] = useState(false);
	const rafIdRef = useRef(0);

	// Apply saved camera once when prefs load
	useEffect(() => {
		if (cameraInitializedRef.current || !prefs) return;
		cameraInitializedRef.current = true;
		if (!hasRulerViewportRef.current) {
			setNeedsInitialPosition(true);
		}
		cameraRef.current = savedCamera;
		setCamera(savedCamera);
	}, [savedCamera, prefs]);

	// DOM refs for direct transform updates (bypass React re-render during pan/zoom)
	const tickStripRef = useRef<HTMLDivElement>(null);
	const worldLayerRef = useRef<HTMLDivElement>(null);
	const headerLayerRef = useRef<HTMLDivElement>(null);

	// Direct DOM update — moves transforms without triggering React reconciliation.
	// Only pan/scale changes use this path; layout changes still go through setCamera.
	const applyTransformToDOM = useCallback(() => {
		const cam = cameraRef.current;

		// PixiJS layer — fast-path camera update (handles all fisheye rendering)
		pixiRef.current?.updateCamera(cam);

		// Tick strip — update counter-scale CSS variable
		const strip = tickStripRef.current;
		if (strip) {
			strip.style.setProperty("--ruler-counter-scale", String(1 / cam.scale));
		}

		// Segment headers — position using fisheye
		const hdr = headerLayerRef.current;
		if (hdr) {
			const isH = cam.orientation === "horizontal";
			const el = containerRef.current;
			const mainViewport = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
			const mainPan = isH ? cam.panX : cam.panY;
			const viewCenter = viewCenterFromPan(mainPan, mainViewport, cam.scale);
			for (let i = 0; i < hdr.children.length; i++) {
				const child = hdr.children[i] as HTMLElement;
				const worldMain = Number(child.dataset.worldMain);
				const worldSize = Number(child.dataset.worldSize);
				if (Number.isNaN(worldMain)) continue;
				const screenMain = worldToScreen(worldMain, viewCenter, mainViewport, cam.scale);
				const screenEnd = worldToScreen(worldMain + worldSize, viewCenter, mainViewport, cam.scale);
				const screenSize = screenEnd - screenMain;
				if (isH) {
					child.style.left = `${screenMain}px`;
					child.style.width = `${screenSize}px`;
				} else {
					child.style.top = `${screenMain}px`;
					child.style.height = `${screenSize}px`;
				}
			}
		}
	}, []);

	// Lightweight render: only updates DOM transforms, no React re-render.
	// Used during continuous interactions (zoom, pan, scroll animations).
	// Full React re-render happens only when interaction settles (via setCamera).
	const scheduleLightRender = useCallback(() => {
		if (rafIdRef.current) return;
		rafIdRef.current = requestAnimationFrame(() => {
			rafIdRef.current = 0;
			applyTransformToDOM();
		});
	}, [applyTransformToDOM]);

	// Debounced save to server
	const cameraSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!cameraInitializedRef.current) return;
		if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
		cameraSaveTimerRef.current = setTimeout(() => {
			const isH = camera.orientation === "horizontal";
			const mainPan = isH ? camera.panX : camera.panY;
			const crossPan = isH ? camera.panY : camera.panX;
			const viewportData = {
				x: camera.panX,
				y: camera.panY,
				zoom: camera.scale,
				rulerOrientation: camera.orientation,
				rulerEdge: camera.edge,
				rulerMainPan: mainPan,
				rulerCrossPan: crossPan,
			};
			api.saveGraphViewport(projectId, viewportData);
			// Optimistically update the cached prefs so re-entering ruler restores this position
			queryClient.setQueryData(["user-preferences"], (old: Record<string, unknown> | undefined) => {
				if (!old) return old;
				let viewports: Record<string, unknown> = {};
				try {
					const raw = old.graphViewports;
					if (typeof raw === "string") viewports = JSON.parse(raw);
					else if (raw && typeof raw === "object") viewports = raw as typeof viewports;
				} catch {
					/* corrupted */
				}
				viewports[projectId] = { ...(viewports[projectId] as object), ...viewportData };
				return { ...old, graphViewports: viewports };
			});
		}, 800);
		return () => {
			if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
		};
	}, [camera, projectId, queryClient]);

	const containerRef = useRef<HTMLDivElement>(null);
	const pixiRef = useRef<RulerPixiHandle>(null);
	const cardDragRef = useRef<{
		active: boolean;
		chapterId: string;
		fromSha: string;
		startScreenX: number;
		startScreenY: number;
		startLayoutX: number;
		startLayoutY: number;
		pointerId: number;
	} | null>(null);
	// Chapter data for PixiJS — populated by SegmentCanvas callbacks
	const pixiChaptersMapRef = useRef<
		Map<
			string,
			Array<{
				id: string;
				status: string;
				title: string;
				branch: string;
				role: string;
				narratorId: string | null;
				narratorStatus: string | null;
				startCommitSha: string | null;
				mergeCommitSha?: string | null;
				layoutX: number;
				layoutY: number;
			}>
		>
	>(new Map());
	const [pixiChaptersTick, setPixiChaptersTick] = useState(0);
	const wheelCleanupRef = useRef<(() => void) | null>(null);
	const resizeObserverRef = useRef<ResizeObserver | null>(null);
	const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
	const isPanningRef = useRef(false);
	const panStartRef = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
	// --- Inertia state for drag panning ---
	const panSamplesRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
	const inertiaRafRef = useRef(0);
	const pinchRef = useRef<{
		active: boolean;
		startDist: number;
		startScale: number;
		startPanX: number;
		startPanY: number;
		lastCenterX: number;
		lastCenterY: number;
		frameCount: number;
	}>({
		active: false,
		startDist: 0,
		startScale: 1,
		startPanX: 0,
		startPanY: 0,
		lastCenterX: 0,
		lastCenterY: 0,
		frameCount: 0,
	});
	const segmentsRef = useRef<RulerSegment[]>([]);
	const layoutRef = useRef<{ ticks: TickPosition[]; totalWidth: number }>({
		ticks: [],
		totalWidth: 0,
	});
	const commitShasRef = useRef<string[]>([]);

	// Zoom center: world-space main-axis position of the last zoom gesture.
	// Falls back to viewport center when no zoom is active.
	const zoomCenterWorldRef = useRef<number | null>(null);
	const zoomCenterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// --- Offscreen card tracking (ref-based, no re-render) ---
	const cardRegistryRef = useRef<
		Map<
			string,
			Array<{
				id: string;
				title: string;
				worldX: number;
				worldY: number;
				worldW: number;
				worldH: number;
				status: string;
				narratorStatus: string | null;
			}>
		>
	>(new Map());

	/** Total main-axis content length (commit ruler), updated after layout computation. */
	const totalMainRef = useRef(0);

	/** Gather current content bounds + viewport size into a ClampBounds object. */
	const getBounds = useCallback((): ClampBounds | undefined => {
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		let maxCross = 0;
		for (const cards of cardRegistryRef.current.values()) {
			for (const c of cards) {
				const bottom = isH ? c.worldY + c.worldH : c.worldX + c.worldW;
				if (bottom > maxCross) maxCross = bottom;
			}
		}
		const el = containerRef.current;
		const crossVp = isH
			? (el?.clientHeight ?? 800) - rulerThickness
			: (el?.clientWidth ?? 1200) - rulerThickness;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const maxMain = totalMainRef.current;
		const hasContent = maxCross > 0 || maxMain > 0;
		return hasContent
			? {
					maxContentCross: maxCross,
					crossViewportSize: crossVp,
					maxContentMain: maxMain,
					mainViewportSize: mainVp,
				}
			: undefined;
	}, [rulerThickness]);

	/** Hard clamp — snap to bounds. For navigation, animation targets, etc. */
	const hardClamp = useCallback((cam: Camera) => clampCamera(cam, getBounds()), [getBounds]);
	const softClamp = useCallback((cam: Camera) => clampCamera(cam, getBounds(), true), [getBounds]);

	/** Animate back to hard-clamped position after overscroll. */
	const bounceRafRef = useRef(0);
	const animateBounce = useCallback(() => {
		cancelAnimationFrame(bounceRafRef.current);
		const start = { ...cameraRef.current };
		const target = hardClamp(start);
		if (start.panX === target.panX && start.panY === target.panY) return;

		const duration = 250;
		const t0 = performance.now();
		const step = (now: number) => {
			const t = Math.min(1, (now - t0) / duration);
			const e = 1 - (1 - t) ** 3; // ease-out cubic
			const cam: Camera = {
				...start,
				panX: start.panX + (target.panX - start.panX) * e,
				panY: start.panY + (target.panY - start.panY) * e,
			};
			cameraRef.current = cam;
			if (t < 1) {
				scheduleLightRender();
				bounceRafRef.current = requestAnimationFrame(step);
			} else {
				// Final frame: commit to state
				setCamera({ ...cam });
			}
		};
		bounceRafRef.current = requestAnimationFrame(step);
	}, [hardClamp, scheduleLightRender]);

	// --- Smooth scroll state for main-axis wheel scrolling ---
	const smoothScrollRef = useRef({
		targetMainPan: 0,
		animating: false,
		rafId: 0,
		/** Frame counter — used to throttle React state commits during animation */
		frameCount: 0,
	});

	// Smooth zoom state: accumulates target scale and lerps toward it each frame
	const smoothZoomRef = useRef({
		targetScale: 1,
		/** World-space main-axis position of the zoom anchor */
		anchorWorldMain: 0,
		/** Screen-space main-axis position of the zoom anchor */
		anchorScreenMain: 0,
		/** World-space cross-axis position of the zoom anchor */
		anchorWorldCross: 0,
		/** Screen-space cross-axis position of the zoom anchor */
		anchorScreenCross: 0,
		animating: false,
		rafId: 0,
		frameCount: 0,
	});

	// Keep target in sync when camera changes from other sources (drag, navigate, etc.)
	const syncSmoothTarget = useCallback(() => {
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		smoothScrollRef.current.targetMainPan = isH ? cam.panX : cam.panY;
	}, []);

	// --- Intelligent prefetch for segment data ---
	const prefetchStateRef = useRef({ lastViewCenter: 0, velocity: 0 });
	const prefetchQueueRef = useRef(new Set<string>());
	const updatePrefetch = useCallback(() => {
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		const mPan = isH ? cam.panX : cam.panY;
		const el = containerRef.current;
		const mViewport = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const currentCenter = -mPan / cam.scale + mViewport / cam.scale / 2;

		const ps = prefetchStateRef.current;
		const rawV = currentCenter - ps.lastViewCenter;
		ps.velocity = ps.velocity * 0.7 + rawV * 0.3;
		ps.lastViewCenter = currentCenter;

		// Predict position ~500ms ahead (assume 60fps → 30 frames)
		const predicted = currentCenter + ps.velocity * 30;
		const segs = segmentsRef.current;
		const queue = prefetchQueueRef.current;

		for (const seg of segs) {
			const tick = layoutRef.current.ticks[seg.fromIndex];
			const tickX = tick?.x ?? seg.fromIndex * COLLAPSED_GAP;
			const distance = Math.abs(tickX - predicted);
			if (distance < 1000 && !queue.has(seg.fromSha)) {
				const cached = queryClient.getQueryData(["rulerSegment", projectId, seg.fromSha]);
				if (!cached) {
					queue.add(seg.fromSha);
					queryClient.prefetchQuery({
						queryKey: ["rulerSegment", projectId, seg.fromSha],
						queryFn: () => api.getRulerSegment(projectId, seg.fromSha, seg.toSha),
						staleTime: 30_000,
					});
				}
			}
		}
	}, [projectId, queryClient]);

	/** Animate inertia after drag release. Decays velocity each frame until below threshold.
	 *  Main axis: heavy damping when past clamp bounds (allows slight overscroll then bounce).
	 *  Cross axis: hard clamp — velocity zeroed and position snapped, no overscroll allowed. */
	const animateInertia = useCallback(
		(vx: number, vy: number) => {
			cancelAnimationFrame(inertiaRafRef.current);
			const FRICTION = 0.95;
			const OVERSCROLL_FRICTION = 0.6;
			const MIN_VELOCITY = 0.5;
			let velX = vx;
			let velY = vy;
			let frameCount = 0;

			const step = () => {
				const cam = cameraRef.current;
				const bounds = getBounds();
				const isH = cam.orientation === "horizontal";

				// Per-axis friction: heavy damping on main axis when past bounds
				let frictionMain = FRICTION;
				if (bounds) {
					const mainPan = isH ? cam.panX : cam.panY;
					const mb = bounds.maxContentMain > 0 ? getMainBounds(bounds, cam.scale) : null;
					if (mb && (mainPan < mb.min || mainPan > mb.max)) {
						frictionMain = OVERSCROLL_FRICTION;
					}

					// Cross axis: kill velocity and clamp position immediately
					const crossPan = isH ? cam.panY : cam.panX;
					const cb = getCrossBounds(bounds, cam.scale);
					const clampedCross = Math.max(cb.min, Math.min(cb.max, crossPan));
					if (isH) {
						velY = 0;
						if (clampedCross !== cam.panY) {
							cameraRef.current = { ...cam, panY: clampedCross };
						}
					} else {
						velX = 0;
						if (clampedCross !== cam.panX) {
							cameraRef.current = { ...cam, panX: clampedCross };
						}
					}
				}

				// Apply friction
				if (isH) {
					velX *= frictionMain;
				} else {
					velY *= frictionMain;
				}

				if (Math.abs(velX) < MIN_VELOCITY && Math.abs(velY) < MIN_VELOCITY) {
					// Settle — commit and bounce back to bounds
					setCamera({ ...cameraRef.current });
					syncSmoothTarget();
					animateBounce();
					updatePrefetch();
					return;
				}

				const cur = cameraRef.current;
				cameraRef.current = {
					...cur,
					panX: cur.panX + velX,
					panY: cur.panY + velY,
				};
				scheduleLightRender();

				frameCount++;
				if (frameCount % 4 === 0) {
					setCamera({ ...cameraRef.current });
				}

				inertiaRafRef.current = requestAnimationFrame(step);
			};
			inertiaRafRef.current = requestAnimationFrame(step);
		},
		[scheduleLightRender, animateBounce, syncSmoothTarget, updatePrefetch, getBounds],
	);

	// --- Context menu ---
	const [tickMenu, setTickMenu] = useState<{
		x: number;
		y: number;
		sha: string;
		message: string;
		author: string;
		date: string;
	} | null>(null);

	const [chapterMenu, setChapterMenu] = useState<ChapterContextMenuState | null>(null);

	useEffect(() => {
		if (!tickMenu && !chapterMenu) return;
		const handler = () => {
			setTickMenu(null);
			setChapterMenu(null);
		};
		window.addEventListener("click", handler);
		return () => window.removeEventListener("click", handler);
	}, [tickMenu, chapterMenu]);

	// --- Actions ---
	const resetCamera = useCallback(() => {
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		const el = containerRef.current;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const tw = totalMainRef.current;
		// Jump to the latest commit (right end)
		const mainPan = -(tw * 1) + mainVp - 40;
		cameraRef.current = hardClamp({
			...(isH ? { panX: mainPan, panY: 0 } : { panX: 0, panY: mainPan }),
			scale: 1,
			orientation: cam.orientation,
			edge: cam.edge,
		});
		setCamera({ ...cameraRef.current });
		syncSmoothTarget();
	}, [hardClamp, syncSmoothTarget]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Home") resetCamera();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [resetCamera]);

	// Cleanup timers and event listeners on unmount
	useEffect(() => {
		return () => {
			rulerDragCleanupRef.current?.();
			cancelAnimationFrame(inertiaRafRef.current);
			cancelAnimationFrame(smoothScrollRef.current.rafId);
			cancelAnimationFrame(smoothZoomRef.current.rafId);
			cancelAnimationFrame(bounceRafRef.current);
			cancelAnimationFrame(animFrameRef.current);
			smoothScrollRef.current.animating = false;
			smoothZoomRef.current.animating = false;
			if (zoomCenterTimerRef.current) clearTimeout(zoomCenterTimerRef.current);
			resizeObserverRef.current?.disconnect();
		};
	}, []);

	const animFrameRef = useRef(0);
	const navigateToWorld = useCallback(
		(worldX: number, worldY: number) => {
			const el = containerRef.current;
			const vw = el?.clientWidth ?? 1200;
			const vh = el?.clientHeight ?? 800;
			const cam = cameraRef.current;
			const s = cam.scale;
			const isH = cam.orientation === "horizontal";
			// worldX/worldY are always in CSS coordinate space (X=horizontal, Y=vertical)
			// Canvas area excludes the ruler track
			const canvasW = isH ? vw : vw - rulerThickness;
			const canvasH = isH ? vh - rulerThickness : vh;
			const target: Camera = hardClamp({
				...cam,
				panX: canvasW / 2 - worldX * s,
				panY: canvasH / 2 - worldY * s,
			});

			// Animate over ~300ms
			const start = cameraRef.current;
			const duration = 300;
			const t0 = performance.now();

			const step = (now: number) => {
				const elapsed = now - t0;
				const t = Math.min(1, elapsed / duration);
				// ease-out cubic
				const e = 1 - (1 - t) ** 3;
				const cam = hardClamp({
					...start,
					panX: start.panX + (target.panX - start.panX) * e,
					panY: start.panY + (target.panY - start.panY) * e,
					scale: start.scale + (target.scale - start.scale) * e,
				});
				cameraRef.current = cam;
				if (t < 1) {
					scheduleLightRender();
					animFrameRef.current = requestAnimationFrame(step);
				} else {
					setCamera({ ...cam });
					syncSmoothTarget();
				}
			};

			cancelAnimationFrame(animFrameRef.current);
			animFrameRef.current = requestAnimationFrame(step);
		},
		[hardClamp, syncSmoothTarget, scheduleLightRender, rulerThickness],
	);

	/**
	 * Fit a world-space rectangle into the viewport.
	 * If the rect already fits at the current scale, do nothing.
	 * Otherwise, zoom out (clamped to min 0.3) so the rect fits, and center it.
	 */
	const fitRectToView = useCallback(
		(worldX: number, worldY: number, worldW: number, worldH: number) => {
			const el = containerRef.current;
			const vw = el?.clientWidth ?? 1200;
			const vh = el?.clientHeight ?? 800;
			const cam = cameraRef.current;
			const isH = cam.orientation === "horizontal";
			const canvasW = isH ? vw : vw - rulerThickness;
			const canvasH = isH ? vh - rulerThickness : vh;

			const PADDING = 40;
			const neededW = (worldW + PADDING * 2) * cam.scale;
			const neededH = (worldH + PADDING * 2) * cam.scale;

			// Already fits — don't touch anything
			if (neededW <= canvasW && neededH <= canvasH) return;

			// Need to zoom out
			const targetScale = Math.max(
				0.3,
				Math.min(canvasW / (worldW + PADDING * 2), canvasH / (worldH + PADDING * 2)),
			);

			const centerX = worldX + worldW / 2;
			const centerY = worldY + worldH / 2;
			const target: Camera = hardClamp({
				...cam,
				scale: targetScale,
				panX: canvasW / 2 - centerX * targetScale,
				panY: canvasH / 2 - centerY * targetScale,
			});

			// Animate
			const start = cameraRef.current;
			const duration = 300;
			const t0 = performance.now();

			const step = (now: number) => {
				const elapsed = now - t0;
				const t = Math.min(1, elapsed / duration);
				const e = 1 - (1 - t) ** 3;
				const cam = hardClamp({
					...start,
					panX: start.panX + (target.panX - start.panX) * e,
					panY: start.panY + (target.panY - start.panY) * e,
					scale: start.scale + (target.scale - start.scale) * e,
				});
				cameraRef.current = cam;
				if (t < 1) {
					scheduleLightRender();
					animFrameRef.current = requestAnimationFrame(step);
				} else {
					setCamera({ ...cam });
					syncSmoothTarget();
				}
			};

			cancelAnimationFrame(animFrameRef.current);
			animFrameRef.current = requestAnimationFrame(step);
		},
		[hardClamp, syncSmoothTarget, scheduleLightRender, rulerThickness],
	);

	const handleForkFromCommit = useCallback(
		async (commitSha: string) => {
			try {
				await api.rulerFork(projectId, { startCommitSha: commitSha });
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				queryClient.invalidateQueries({
					queryKey: ["rulerSegment", projectId, commitSha],
				});
			} catch {
				/* global handler */
			}
		},
		[projectId, queryClient],
	);

	const handleChapterFork = useCallback(
		async (chapterId: string) => {
			try {
				await api.forkChapter(chapterId, {});
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				if (chapterMenu) {
					queryClient.invalidateQueries({
						queryKey: ["rulerSegment", projectId, chapterMenu.fromSha],
					});
				}
			} catch {
				/* global handler */
			}
		},
		[projectId, queryClient, chapterMenu],
	);

	const handleChapterMerge = useCallback(
		async (chapterId: string) => {
			try {
				await api.rulerMerge(projectId, { sourceChapterId: chapterId });
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				if (chapterMenu) {
					queryClient.invalidateQueries({
						queryKey: ["rulerSegment", projectId, chapterMenu.fromSha],
					});
				}
			} catch {
				/* global handler */
			}
		},
		[projectId, queryClient, chapterMenu],
	);

	const handleChapterReview = useCallback(
		async (chapterId: string) => {
			try {
				await api.createReview(chapterId, {});
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				if (chapterMenu) {
					queryClient.invalidateQueries({
						queryKey: ["rulerSegment", projectId, chapterMenu.fromSha],
					});
				}
			} catch {
				/* global handler */
			}
		},
		[projectId, queryClient, chapterMenu],
	);

	const handleChapterAbandon = useCallback(
		async (chapterId: string) => {
			try {
				await api.rulerAbandon(projectId, chapterId);
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				if (chapterMenu) {
					queryClient.invalidateQueries({
						queryKey: ["rulerSegment", projectId, chapterMenu.fromSha],
					});
				}
			} catch {
				/* global handler */
			}
		},
		[projectId, queryClient, chapterMenu],
	);

	// --- Tick context menu via hit-testing ---
	const handleTickContextMenu = useCallback((e: React.MouseEvent) => {
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		const mouseMain = isH ? e.clientX - rect.left : e.clientY - rect.top;
		const mainPan = isH ? cam.panX : cam.panY;
		const mvp = isH ? el.clientWidth : el.clientHeight;
		const vc = viewCenterFromPan(mainPan, mvp, cam.scale);
		const worldMain = screenToWorld(mouseMain, vc, mvp, cam.scale);

		const ticks = layoutRef.current.ticks;
		if (ticks.length === 0) return;

		const idx = findTickAtX(ticks, worldMain);
		if (idx < 0) return;
		const tick = ticks[idx];
		const dist = Math.abs(tick.x - worldMain);
		if (dist > COLLAPSED_GAP / 2) return;

		e.preventDefault();
		const commit = commitByShaRef.current.get(tick.sha);
		setTickMenu({
			x: e.clientX,
			y: e.clientY,
			sha: tick.sha,
			message: commit?.message ?? "",
			author: commit?.author ?? "",
			date: commit?.date ?? "",
		});
	}, []);

	// --- Input handlers ---
	const wheelBounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const containerCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			wheelCleanupRef.current?.();
			wheelCleanupRef.current = null;
			// Disconnect previous ResizeObserver
			resizeObserverRef.current?.disconnect();
			resizeObserverRef.current = null;
			containerRef.current = el;
			if (!el) {
				setContainerSize({ width: 0, height: 0 });
				return;
			}

			// Seed initial size synchronously so the first render has correct dimensions
			setContainerSize({ width: el.clientWidth, height: el.clientHeight });

			// Watch for layout changes (window resize, sidebar toggle, etc.)
			const ro = new ResizeObserver((entries) => {
				const entry = entries[0];
				if (!entry) return;
				const { width, height } = entry.contentRect;
				setContainerSize((prev) =>
					prev.width === Math.round(width) && prev.height === Math.round(height)
						? prev
						: { width: Math.round(width), height: Math.round(height) },
				);
			});
			ro.observe(el);
			resizeObserverRef.current = ro;

			const onWheel = (e: WheelEvent) => {
				cancelAnimationFrame(bounceRafRef.current);
				cancelAnimationFrame(inertiaRafRef.current);
				const cam = cameraRef.current;
				const isH = cam.orientation === "horizontal";
				const oldPanX = cam.panX;
				const oldPanY = cam.panY;
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					const factor = e.deltaY > 0 ? 0.9 : 1.1;
					const rect = el.getBoundingClientRect();
					const mouseX = e.clientX - rect.left;
					const mouseY = e.clientY - rect.top;
					const canvasMouseMain = isH ? mouseX : mouseY;
					const canvasMouseCross = isH
						? mouseY - (cam.edge === "start" ? rulerThickness : 0)
						: mouseX - (cam.edge === "start" ? rulerThickness : 0);

					const sz = smoothZoomRef.current;
					// If not currently animating, seed target from current camera
					if (!sz.animating) {
						sz.targetScale = cam.scale;
					}
					sz.targetScale = Math.max(0.1, Math.min(5, sz.targetScale * factor));

					// Compute world-space anchor from current (not target) camera
					const mainPan = isH ? cam.panX : cam.panY;
					const crossPan = isH ? cam.panY : cam.panX;
					const mvp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
					const vc = viewCenterFromPan(mainPan, mvp, cam.scale);
					sz.anchorWorldMain = screenToWorld(canvasMouseMain, vc, mvp, cam.scale);
					sz.anchorScreenMain = canvasMouseMain;

					let worldMouseCross = (canvasMouseCross - crossPan) / cam.scale;
					let maxCardCross = 0;
					for (const cards of cardRegistryRef.current.values()) {
						for (const c of cards) {
							const cc = isH ? c.worldY + c.worldH : c.worldX + c.worldW;
							if (cc > maxCardCross) maxCardCross = cc;
						}
					}
					if (maxCardCross > 0) {
						worldMouseCross = Math.min(worldMouseCross, maxCardCross);
					}
					sz.anchorWorldCross = worldMouseCross;
					sz.anchorScreenCross = canvasMouseCross;

					// Record zoom center for distance-aware LOD
					zoomCenterWorldRef.current = sz.anchorWorldMain;
					if (zoomCenterTimerRef.current) clearTimeout(zoomCenterTimerRef.current);
					zoomCenterTimerRef.current = setTimeout(() => {
						zoomCenterWorldRef.current = null;
					}, 800);

					// Start smooth zoom animation loop if not already running
					if (!sz.animating) {
						sz.animating = true;
						sz.frameCount = 0;
						const zoomStep = () => {
							const cur = cameraRef.current;
							const curIsH = cur.orientation === "horizontal";
							const diff = sz.targetScale - cur.scale;
							const LERP = 0.18;
							const mvp = curIsH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);

							if (Math.abs(diff) < 0.001) {
								// Close enough — snap to target
								const newMainPan = solvePanForAnchor(
									sz.anchorWorldMain,
									sz.anchorScreenMain,
									mvp,
									sz.targetScale,
								);
								const newCrossPan = sz.anchorScreenCross - sz.anchorWorldCross * sz.targetScale;
								cameraRef.current = hardClamp({
									...cur,
									panX: curIsH ? newMainPan : newCrossPan,
									panY: curIsH ? newCrossPan : newMainPan,
									scale: sz.targetScale,
								});
								scheduleLightRender();
								setCamera({ ...cameraRef.current });
								sz.animating = false;

								// Bounce check after settle
								if (wheelBounceTimerRef.current) clearTimeout(wheelBounceTimerRef.current);
								wheelBounceTimerRef.current = setTimeout(() => {
									wheelBounceTimerRef.current = null;
									animateBounce();
									updatePrefetch();
								}, 120);
								return;
							}

							const newScale = cur.scale + diff * LERP;
							const newMainPan = solvePanForAnchor(
								sz.anchorWorldMain,
								sz.anchorScreenMain,
								mvp,
								newScale,
							);
							const newCrossPan = sz.anchorScreenCross - sz.anchorWorldCross * newScale;
							cameraRef.current = hardClamp({
								...cur,
								panX: curIsH ? newMainPan : newCrossPan,
								panY: curIsH ? newCrossPan : newMainPan,
								scale: newScale,
							});
							scheduleLightRender();
							// Commit to React state periodically (not every frame) to reduce GC pressure
							// PixiJS handles morph/LOD in real time via updateCamera
							sz.frameCount = (sz.frameCount ?? 0) + 1;
							if (sz.frameCount % 6 === 0) {
								setCamera({ ...cameraRef.current });
							}
							sz.rafId = requestAnimationFrame(zoomStep);
						};
						sz.rafId = requestAnimationFrame(zoomStep);
					}
				} else {
					e.preventDefault();
					// Map deltaY (primary wheel axis) to main-axis scrolling with smooth animation.
					// deltaX still maps to cross-axis for trackpad two-finger horizontal swipes.
					const delta = e.deltaY + (isH ? e.deltaX : 0);
					const crossDelta = isH ? 0 : e.deltaX;

					const ss = smoothScrollRef.current;
					// If not currently animating, seed target from current camera
					if (!ss.animating) {
						ss.targetMainPan = isH ? cam.panX : cam.panY;
					}
					ss.targetMainPan -= delta;

					// Apply cross-axis immediately (no smoothing needed for minor trackpad input)
					if (crossDelta !== 0) {
						const crossCam = hardClamp({
							...cameraRef.current,
							...(isH
								? { panY: cameraRef.current.panY - crossDelta }
								: { panX: cameraRef.current.panX - crossDelta }),
						});
						cameraRef.current = crossCam;
					}

					// Start smooth animation loop if not already running
					if (!ss.animating) {
						ss.animating = true;
						ss.frameCount = 0;
						const smoothStep = () => {
							const cur = cameraRef.current;
							const curMain = cur.orientation === "horizontal" ? cur.panX : cur.panY;
							const diff = ss.targetMainPan - curMain;

							// Lerp factor — higher = snappier, lower = smoother
							const LERP = 0.25;
							if (Math.abs(diff) < 0.5) {
								// Close enough — snap and stop
								const finalCam = hardClamp({
									...cur,
									...(cur.orientation === "horizontal"
										? { panX: ss.targetMainPan }
										: { panY: ss.targetMainPan }),
								});
								cameraRef.current = finalCam;
								scheduleLightRender();
								setCamera({ ...cameraRef.current });
								ss.animating = false;

								// Trigger bounce check
								if (wheelBounceTimerRef.current) clearTimeout(wheelBounceTimerRef.current);
								wheelBounceTimerRef.current = setTimeout(() => {
									wheelBounceTimerRef.current = null;
									animateBounce();
									updatePrefetch();
								}, 120);
								return;
							}

							const newMain = curMain + diff * LERP;
							const newCam = hardClamp({
								...cur,
								...(cur.orientation === "horizontal" ? { panX: newMain } : { panY: newMain }),
							});
							cameraRef.current = newCam;
							scheduleLightRender();
							// Commit to React state every 4 frames so SegmentCanvas
							// visibility culling updates progressively instead of all at once.
							ss.frameCount++;
							if (ss.frameCount % 4 === 0) {
								setCamera({ ...cameraRef.current });
							}
							ss.rafId = requestAnimationFrame(smoothStep);
						};
						ss.rafId = requestAnimationFrame(smoothStep);
					}
				}
				// If panning is active, rebase the drag origin so the ongoing drag
				// doesn't overwrite the pan offset that zoom/scroll just applied.
				if (isPanningRef.current) {
					const newCam = cameraRef.current;
					panStartRef.current.camX += newCam.panX - oldPanX;
					panStartRef.current.camY += newCam.panY - oldPanY;
				}
			};

			el.addEventListener("wheel", onWheel, { passive: false });

			// --- Touch pinch-to-zoom ---
			const getTouchDist = (t: TouchList) => {
				const dx = t[1].clientX - t[0].clientX;
				const dy = t[1].clientY - t[0].clientY;
				return Math.sqrt(dx * dx + dy * dy);
			};
			const getTouchCenter = (t: TouchList, rect: DOMRect) => ({
				x: (t[0].clientX + t[1].clientX) / 2 - rect.left,
				y: (t[0].clientY + t[1].clientY) / 2 - rect.top,
			});

			const onTouchStart = (e: TouchEvent) => {
				if (e.touches.length !== 2) return;
				e.preventDefault();
				const p = pinchRef.current;
				const rect = el.getBoundingClientRect();
				const center = getTouchCenter(e.touches, rect);
				p.active = true;
				p.startDist = getTouchDist(e.touches);
				p.startScale = cameraRef.current.scale;
				p.startPanX = cameraRef.current.panX;
				p.startPanY = cameraRef.current.panY;
				p.lastCenterX = center.x;
				p.lastCenterY = center.y;
				p.frameCount = 0;
				// Cancel any ongoing animations
				cancelAnimationFrame(bounceRafRef.current);
				cancelAnimationFrame(smoothZoomRef.current.rafId);
				cancelAnimationFrame(inertiaRafRef.current);
				smoothZoomRef.current.animating = false;
			};

			const onTouchMove = (e: TouchEvent) => {
				const p = pinchRef.current;
				if (!p.active || e.touches.length !== 2) return;
				e.preventDefault();

				const rect = el.getBoundingClientRect();
				const newDist = getTouchDist(e.touches);
				const center = getTouchCenter(e.touches, rect);
				const cam = cameraRef.current;
				const isH = cam.orientation === "horizontal";

				// Scale
				const newScale = Math.max(0.1, Math.min(5, p.startScale * (newDist / p.startDist)));

				// Anchor zoom at pinch center
				const canvasMouseMain = isH ? center.x : center.y;
				const canvasMouseCross = isH
					? center.y - (cam.edge === "start" ? rulerThickness : 0)
					: center.x - (cam.edge === "start" ? rulerThickness : 0);
				const mainPan = isH ? p.startPanX : p.startPanY;
				const crossPan = isH ? p.startPanY : p.startPanX;
				const startCenter = isH
					? {
							main: p.lastCenterX,
							cross: p.lastCenterY - (cam.edge === "start" ? rulerThickness : 0),
						}
					: {
							main: p.lastCenterY,
							cross: p.lastCenterX - (cam.edge === "start" ? rulerThickness : 0),
						};

				const pinchMvp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
				const worldMain = screenToWorld(
					startCenter.main,
					viewCenterFromPan(mainPan, pinchMvp, p.startScale),
					pinchMvp,
					p.startScale,
				);
				const worldCross = (startCenter.cross - crossPan) / p.startScale;
				const newMainPan = solvePanForAnchor(worldMain, canvasMouseMain, pinchMvp, newScale);
				const newCrossPan = canvasMouseCross - worldCross * newScale;

				cameraRef.current = softClamp({
					...cam,
					panX: isH ? newMainPan : newCrossPan,
					panY: isH ? newCrossPan : newMainPan,
					scale: newScale,
				});
				scheduleLightRender();

				p.frameCount++;
				if (p.frameCount % 4 === 0) {
					setCamera({ ...cameraRef.current });
				}
			};

			const onTouchEnd = (e: TouchEvent) => {
				const p = pinchRef.current;
				if (!p.active) return;
				if (e.touches.length < 2) {
					p.active = false;
					setCamera({ ...cameraRef.current });
					syncSmoothTarget();
					animateBounce();
					updatePrefetch();
				}
			};

			el.addEventListener("touchstart", onTouchStart, { passive: false });
			el.addEventListener("touchmove", onTouchMove, { passive: false });
			el.addEventListener("touchend", onTouchEnd);
			el.addEventListener("touchcancel", onTouchEnd);

			wheelCleanupRef.current = () => {
				el.removeEventListener("wheel", onWheel);
				el.removeEventListener("touchstart", onTouchStart);
				el.removeEventListener("touchmove", onTouchMove);
				el.removeEventListener("touchend", onTouchEnd);
				el.removeEventListener("touchcancel", onTouchEnd);
				cancelAnimationFrame(smoothScrollRef.current.rafId);
				smoothScrollRef.current.animating = false;
				cancelAnimationFrame(smoothZoomRef.current.rafId);
				smoothZoomRef.current.animating = false;
				cancelAnimationFrame(inertiaRafRef.current);
			};
		},
		[
			scheduleLightRender,
			hardClamp,
			softClamp,
			animateBounce,
			syncSmoothTarget,
			updatePrefetch,
			rulerThickness,
		],
	);

	// --- Layout computation ---
	const rulerData = (data as RulerData) ?? { commits: [], segments: [], activeChapters: [] };

	const toggleOrientation = useCallback(() => {
		const cam = cameraRef.current;
		const newOri = cam.orientation === "horizontal" ? "vertical" : "horizontal";
		const isH = newOri === "horizontal";
		const el = containerRef.current;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const tw = totalMainRef.current;
		const mp = -(tw * 1) + mainVp - 40;
		const next = hardClamp({
			...cam,
			orientation: newOri,
			...(isH ? { panX: mp, panY: 0 } : { panX: 0, panY: mp }),
		});
		cameraRef.current = next;
		setCamera({ ...next });
	}, [hardClamp]);

	const toggleEdge = useCallback(() => {
		const cam = cameraRef.current;
		const next = hardClamp({ ...cam, edge: cam.edge === "start" ? "end" : "start" });
		cameraRef.current = next;
		setCamera({ ...next });
	}, [hardClamp]);

	const rawCommits = rulerData.commits ?? [];
	const commits = useMemo(() => [...rawCommits].reverse(), [rawCommits]);
	const segments = useMemo(() => {
		const len = rawCommits.length;
		if (len === 0) return rulerData.segments ?? [];
		return (rulerData.segments ?? []).map((seg) => ({
			...seg,
			fromIndex: len - 1 - seg.fromIndex,
			toIndex: len - 1 - seg.toIndex,
		}));
	}, [rawCommits, rulerData.segments]);

	const commitShas = useMemo(() => commits.map((c) => c.sha), [commits]);
	const layout = useMemo(() => computeElasticLayout(commitShas, segments), [commitShas, segments]);

	segmentsRef.current = segments;
	layoutRef.current = layout;
	commitShasRef.current = commitShas;

	const commitByShaRef = useRef(new Map<string, (typeof commits)[number]>());
	commitByShaRef.current = useMemo(() => {
		const m = new Map<string, (typeof commits)[number]>();
		for (const c of commits) m.set(c.sha, c);
		return m;
	}, [commits]);

	totalMainRef.current = layout.totalWidth;

	useEffect(() => {
		const timer = setInterval(() => {
			const cam = cameraRef.current;
			const isH = cam.orientation === "horizontal";
			const mPan = isH ? cam.panX : cam.panY;
			const el = containerRef.current;
			const mViewport = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
			const worldStart = -mPan / cam.scale;
			const worldEnd = worldStart + mViewport / cam.scale;
			const bufferSize = (worldEnd - worldStart) * 3;
			const queries = queryClient.getQueriesData({ queryKey: ["rulerSegment", projectId] });
			for (const [key] of queries) {
				const fromSha = key[2] as string;
				const tick = layout.ticks.find((t) => t.sha === fromSha);
				if (!tick) continue;
				if (tick.x < worldStart - bufferSize || tick.x > worldEnd + bufferSize) {
					queryClient.removeQueries({ queryKey: key });
				}
			}
		}, 60_000);
		return () => clearInterval(timer);
	}, [projectId, queryClient, layout.ticks]);

	useEffect(() => {
		if (!needsInitialPosition || commits.length === 0) return;
		setNeedsInitialPosition(false);
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		const el = containerRef.current;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const mainPan = -(layout.totalWidth * cam.scale) + mainVp - 40;
		const clamped = clampCamera(
			{ ...cam, ...(isH ? { panX: mainPan, panY: 0 } : { panX: 0, panY: mainPan }) },
			getBounds(),
		);
		cameraRef.current = clamped;
		setCamera({ ...clamped });
	}, [needsInitialPosition, commits.length, layout.totalWidth, getBounds]);

	const tickPositions = useMemo(() => {
		const map = new Map<string, number>();
		for (const tick of layout.ticks) {
			map.set(tick.sha, tick.x);
		}
		return map;
	}, [layout.ticks]);

	const { panX, panY, scale, orientation, edge } = camera;
	const isHorizontal = orientation === "horizontal";
	const containerWidth = containerSize.width || (containerRef.current?.clientWidth ?? 1200);
	const containerHeight = containerSize.height || (containerRef.current?.clientHeight ?? 800);

	const tierInfo = useMemo(() => getZoomTierInfo(scale), [scale]);
	const zoomTier: ZoomTierId = tierInfo.tier.id;

	const mainViewport = isHorizontal ? containerWidth : containerHeight;
	const crossViewport = isHorizontal
		? containerHeight - rulerThickness
		: containerWidth - rulerThickness;
	const mainPan = isHorizontal ? panX : panY;
	const crossPan = isHorizontal ? panY : panX;

	const worldViewportMain = mainViewport / scale;

	const segmentTicks = useMemo(() => {
		const worldViewStart = -mainPan / scale;
		const segBuffer = (worldViewportMain * SEGMENT_VIEWPORT_MULTIPLIER - worldViewportMain) / 2;
		const segStart = worldViewStart - segBuffer;
		const segEnd = worldViewStart + worldViewportMain + segBuffer;
		const segs: typeof layout.ticks = [];
		for (const tick of layout.ticks) {
			if (tick.segment) {
				const nextTick = layout.ticks[tick.index + 1];
				const segEndX = nextTick ? nextTick.x : tick.x + 400;
				if (segEndX >= segStart && tick.x <= segEnd) {
					segs.push(tick);
				}
			}
		}
		return segs;
	}, [layout.ticks, mainPan, scale, worldViewportMain]);

	const segmentBySha = useMemo(() => {
		const map = new Map<string, RulerSegment>();
		for (const seg of segments) map.set(seg.fromSha, seg);
		return map;
	}, [segments]);

	const clusters = useMemo(
		() => clusterCommits(layout.ticks, segmentBySha, scale),
		[layout.ticks, segmentBySha, scale],
	);
	const worldViewTop = -crossPan / scale;
	const worldViewHeight = crossViewport / scale;

	const fisheyeCenter = viewCenterFromPan(mainPan, mainViewport, scale);

	// Shared state for open narrator panels (lifted from SegmentCanvas for PixiJS interaction)
	const [openPanelChapterIds, setOpenPanelChapterIds] = useState<Set<string>>(new Set());

	const handlePixiChapterClick = useCallback((chapterId: string, _narratorId: string | null) => {
		setOpenPanelChapterIds((prev) => {
			const next = new Set(prev);
			if (next.has(chapterId)) {
				next.delete(chapterId);
			} else {
				next.add(chapterId);
			}
			return next;
		});
	}, []);

	const handlePixiChapterContextMenu = useCallback(
		(chapterId: string, screenX: number, screenY: number) => {
			for (const [_sha, chs] of pixiChaptersMapRef.current) {
				const ch = chs.find((c) => c.id === chapterId);
				if (ch) {
					setChapterMenu({
						x: screenX,
						y: screenY,
						chapter: ch as never,
						fromSha: ch.startCommitSha ?? "",
					});
					break;
				}
			}
		},
		[],
	);

	const handlePixiChapterDragEnd = useCallback(
		(chapterId: string, fromSha: string, newAxisOffset: number, newCrossOffset: number) => {
			const clampedCross = Math.max(0, newCrossOffset);
			const qk = ["rulerSegment", projectId, fromSha, "full"];
			queryClient.setQueryData(qk, (old: unknown) => {
				if (!old || typeof old !== "object") return old;
				const data = old as {
					chapters: Array<{ id: string; axisOffset: number; crossOffset: number }>;
				};
				return {
					...data,
					chapters: data.chapters.map((c) =>
						c.id === chapterId ? { ...c, axisOffset: newAxisOffset, crossOffset: clampedCross } : c,
					),
				};
			});
			api.updateRulerPositions(projectId, [
				{
					chapterId,
					anchorCommitSha: fromSha,
					axisOffset: newAxisOffset,
					crossOffset: clampedCross,
				},
			]);
		},
		[projectId, queryClient],
	);

	// Refs for card interaction callbacks — used in handlePointerUp via refs
	// to avoid circular dependency in useCallback deps
	const pixiClickRef = useRef(handlePixiChapterClick);
	pixiClickRef.current = handlePixiChapterClick;
	const pixiDragEndRef = useRef(handlePixiChapterDragEnd);
	pixiDragEndRef.current = handlePixiChapterDragEnd;

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		// Check card hit first (left click only)
		if (e.button === 0) {
			const hitRects = pixiRef.current?.getCardHitRects() ?? [];
			const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
			const sx = e.clientX - rect.left;
			const sy = e.clientY - rect.top;
			for (const hr of hitRects) {
				if (
					sx >= hr.screenX &&
					sx <= hr.screenX + hr.width &&
					sy >= hr.screenY &&
					sy <= hr.screenY + hr.height
				) {
					cardDragRef.current = {
						active: false,
						chapterId: hr.id,
						fromSha: hr.fromSha,
						startScreenX: e.clientX,
						startScreenY: e.clientY,
						startLayoutX: hr.layoutX,
						startLayoutY: hr.layoutY,
						pointerId: e.pointerId,
					};
					(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
					e.preventDefault();
					return;
				}
			}
		}
		if (e.button === 1 || (e.button === 0 && e.currentTarget === e.target)) {
			cancelAnimationFrame(bounceRafRef.current);
			cancelAnimationFrame(inertiaRafRef.current);
			isPanningRef.current = true;
			panStartRef.current = {
				x: e.clientX,
				y: e.clientY,
				camX: cameraRef.current.panX,
				camY: cameraRef.current.panY,
			};
			panSamplesRef.current = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			e.preventDefault();
		}
	}, []);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			// Card drag
			const cd = cardDragRef.current;
			if (cd) {
				const dx = e.clientX - cd.startScreenX;
				const dy = e.clientY - cd.startScreenY;
				if (!cd.active && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
					cd.active = true;
				}
				return;
			}
			if (!isPanningRef.current || pinchRef.current.active) return;
			cameraRef.current = softClamp({
				...cameraRef.current,
				panX: panStartRef.current.camX + (e.clientX - panStartRef.current.x),
				panY: panStartRef.current.camY + (e.clientY - panStartRef.current.y),
			});
			scheduleLightRender();

			// Record sample for inertia velocity calculation (keep last 5)
			const samples = panSamplesRef.current;
			samples.push({ x: e.clientX, y: e.clientY, t: performance.now() });
			if (samples.length > 5) samples.shift();
		},
		[scheduleLightRender, softClamp],
	);

	const handlePointerUp = useCallback(
		(e: React.PointerEvent) => {
			// Card drag/click end
			const cd = cardDragRef.current;
			if (cd) {
				cardDragRef.current = null;
				if (!cd.active) {
					pixiClickRef.current(cd.chapterId, null);
				} else {
					const cam = cameraRef.current;
					const dx = (e.clientX - cd.startScreenX) / cam.scale;
					const dy = (e.clientY - cd.startScreenY) / cam.scale;
					pixiDragEndRef.current(
						cd.chapterId,
						cd.fromSha,
						cd.startLayoutX + dx,
						cd.startLayoutY + dy,
					);
				}
				return;
			}
			if (isPanningRef.current) {
				isPanningRef.current = false;

				// Compute velocity from recent samples (within last 80ms)
				const samples = panSamplesRef.current;
				const now = performance.now();
				const cutoff = now - 80;
				const recent = samples.filter((s) => s.t >= cutoff);

				if (recent.length >= 2) {
					const first = recent[0];
					const last = recent[recent.length - 1];
					const dt = last.t - first.t;
					if (dt > 0) {
						// Convert px/ms → px/frame (~16.67ms at 60fps)
						const FRAME_MS = 16.67;
						const vx = ((last.x - first.x) / dt) * FRAME_MS;
						const vy = ((last.y - first.y) / dt) * FRAME_MS;
						const speed = Math.sqrt(vx * vx + vy * vy);
						if (speed > 2) {
							setCamera({ ...cameraRef.current });
							syncSmoothTarget();
							animateInertia(vx, vy);
							return;
						}
					}
				}
			}

			// No significant velocity — commit and bounce immediately
			setCamera({ ...cameraRef.current });
			syncSmoothTarget();
			animateBounce();
			updatePrefetch();
		},
		[animateBounce, animateInertia, syncSmoothTarget, updatePrefetch],
	);

	const handleChaptersLoaded = useCallback(
		(
			fromSha: string,
			chapters: Array<{
				id: string;
				status: string;
				title: string;
				branch: string;
				role: string;
				narratorId: string | null;
				narratorStatus: string | null;
				startCommitSha: string | null;
				mergeCommitSha?: string | null;
				layoutX: number;
				layoutY: number;
			}>,
		) => {
			if (chapters.length === 0) {
				pixiChaptersMapRef.current.delete(fromSha);
			} else {
				pixiChaptersMapRef.current.set(fromSha, chapters);
			}
			setPixiChaptersTick((t) => t + 1);
		},
		[],
	);

	/** Lightweight drag-move handler: updates ref + triggers PixiJS redraw without React state. */
	const handleChapterDragMove = useCallback(
		(
			fromSha: string,
			chapters: Array<{
				id: string;
				status: string;
				title: string;
				branch: string;
				role: string;
				narratorId: string | null;
				narratorStatus: string | null;
				startCommitSha: string | null;
				mergeCommitSha?: string | null;
				layoutX: number;
				layoutY: number;
			}>,
		) => {
			if (chapters.length === 0) {
				pixiChaptersMapRef.current.delete(fromSha);
			} else {
				pixiChaptersMapRef.current.set(fromSha, chapters);
			}
			// Rebuild full PixiChapterInfo[] from the map and push to PixiJS imperatively
			const ticks = layoutRef.current.ticks;
			const result: PixiChapterInfo[] = [];
			for (const tick of ticks) {
				if (!tick.segment) continue;
				const chs = pixiChaptersMapRef.current.get(tick.sha);
				if (!chs) continue;
				for (const ch of chs) {
					result.push({
						id: ch.id,
						status: ch.status,
						title: ch.title,
						branch: ch.branch,
						role: ch.role,
						narratorId: ch.narratorId,
						narratorStatus: ch.narratorStatus,
						startCommitSha: ch.startCommitSha,
						mergeCommitSha: ch.mergeCommitSha,
						layoutX: ch.layoutX,
						layoutY: ch.layoutY,
						segMainPos: tick.x,
					});
				}
			}
			pixiRef.current?.updateChapters(result);
		},
		[],
	);

	// Commit SHA → first line of message (for PixiJS tick labels)
	const commitMessages = useMemo(() => {
		const map = new Map<string, string>();
		for (const c of commits) {
			const firstLine = c.message.split("\n")[0];
			if (firstLine) map.set(c.sha, firstLine);
		}
		return map;
	}, [commits]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: pixiChaptersTick triggers recompute
	const pixiChapters = useMemo<PixiChapterInfo[]>(() => {
		const result: PixiChapterInfo[] = [];
		for (const tick of segmentTicks) {
			if (!tick.segment) continue;
			const chapters = pixiChaptersMapRef.current.get(tick.sha);
			if (!chapters) continue;
			for (const ch of chapters) {
				result.push({
					id: ch.id,
					status: ch.status,
					title: ch.title,
					branch: ch.branch,
					role: ch.role,
					narratorId: ch.narratorId,
					narratorStatus: ch.narratorStatus,
					startCommitSha: ch.startCommitSha,
					mergeCommitSha: ch.mergeCommitSha,
					layoutX: ch.layoutX,
					layoutY: ch.layoutY,
					segMainPos: tick.x,
				});
			}
		}
		return result;
	}, [segmentTicks, pixiChaptersTick]);

	// Always-visible active chapters for L0 dot rendering.
	// Uses activeChapters from the main ruler query (no segment fetch needed).
	const alwaysVisibleChapters = useMemo<PixiChapterInfo[]>(() => {
		const activeChapters = rulerData.activeChapters ?? [];
		if (activeChapters.length === 0) return [];
		const result: PixiChapterInfo[] = [];
		// Group active chapters by startCommitSha to compute per-group layout offsets
		const byStartSha = new Map<string, typeof activeChapters>();
		for (const ch of activeChapters) {
			if (!ch.startCommitSha) continue;
			const list = byStartSha.get(ch.startCommitSha) ?? [];
			list.push(ch);
			byStartSha.set(ch.startCommitSha, list);
		}
		for (const [sha, chs] of byStartSha) {
			const segMainPos = tickPositions.get(sha);
			if (segMainPos == null) continue;
			for (let i = 0; i < chs.length; i++) {
				const ch = chs[i];
				// Use persisted offsets when available, fall back to grid layout
				const hasOffset = ch.axisOffset !== 0 || ch.crossOffset !== 0;
				result.push({
					id: ch.id,
					status: "active",
					title: ch.title,
					branch: ch.branch ?? "",
					role: ch.role ?? "branch",
					narratorId: ch.narratorId ?? null,
					narratorStatus: ch.narratorStatus ?? null,
					startCommitSha: ch.startCommitSha,
					layoutX: hasOffset ? ch.axisOffset : 20 + (i % 3) * (NODE_WIDTH + NODE_GAP),
					layoutY: hasOffset ? ch.crossOffset : 20 + Math.floor(i / 3) * (NODE_HEIGHT + NODE_GAP),
					segMainPos,
				});
			}
		}
		return result;
	}, [rulerData.activeChapters, tickPositions]);

	if (isLoading) {
		return (
			<Center h="100%">
				<Loader />
			</Center>
		);
	}
	if (error) {
		return (
			<Center h="100%">
				<Text c="red">{t("loadFailed", { message: error?.message ?? "Unknown" })}</Text>
			</Center>
		);
	}

	// --- Ruler track positioning ---
	const rulerTrackStyle: React.CSSProperties = {
		position: "absolute",
		zIndex: 10,
		overflow: "hidden",
	};
	if (isHorizontal) {
		Object.assign(rulerTrackStyle, {
			left: 0,
			right: 0,
			height: rulerThickness,
			...(edge === "start" ? { top: 0 } : { bottom: 0 }),
		});
	} else {
		Object.assign(rulerTrackStyle, {
			top: 0,
			bottom: 0,
			width: rulerThickness,
			...(edge === "start" ? { left: 0 } : { right: 0 }),
		});
	}

	// --- Canvas area positioning (the area beside the ruler) ---
	const canvasStyle: React.CSSProperties = {
		position: "absolute",
		background: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
		overflow: "hidden",
	};
	if (isHorizontal) {
		Object.assign(canvasStyle, {
			left: 0,
			right: 0,
			...(edge === "start"
				? { top: rulerThickness, bottom: 0 }
				: { top: 0, bottom: rulerThickness }),
		});
	} else {
		Object.assign(canvasStyle, {
			top: 0,
			bottom: 0,
			...(edge === "start"
				? { left: rulerThickness, right: 0 }
				: { left: 0, right: rulerThickness }),
		});
	}

	// --- Tick strip inside ruler track ---
	// Uses translate + scale; individual ticks are at world coordinates with counter-scale.
	// During zoom, applyTransformToDOM updates the strip transform and --ruler-counter-scale
	// CSS variable so ticks stay visually correct without React re-renders.
	const tickStripStyle: React.CSSProperties & Record<string, string | number> = {
		position: "absolute",
		top: 0,
		left: 0,
		transformOrigin: "0 0",
		"--ruler-counter-scale": 1 / scale,
	};
	if (isHorizontal) {
		Object.assign(tickStripStyle, {
			width: layout.totalWidth,
			height: "100%",
			transform: `translateX(${panX}px) scaleX(${scale})`,
		});
	} else {
		Object.assign(tickStripStyle, {
			width: "100%",
			height: layout.totalWidth,
			transform: `translateY(${panY}px) scaleY(${scale})`,
		});
	}

	// --- World transform for the 2D canvas ---
	// No CSS transform — all positioning is done per-element via fisheye (main-axis)
	// and explicit screen-space calculation (cross-axis).
	const worldTransform = "none";

	return (
		<Box
			ref={containerCallbackRef}
			style={{
				width: "100%",
				height: "100%",
				overflow: "hidden",
				position: "relative",
				touchAction: "none",
			}}
		>
			{/* Ruler track */}
			<Box style={rulerTrackStyle} onContextMenu={handleTickContextMenu}>
				<Text
					size="xs"
					c="dimmed"
					style={{
						position: "absolute",
						zIndex: 20,
						...(isHorizontal
							? { right: 8, top: 4 }
							: { bottom: 8, left: 4, writingMode: "vertical-rl", transform: "rotate(180deg)" }),
					}}
				>
					{t("ruler.commitCount", { count: commits.length })}
				</Text>
				<Box ref={tickStripRef} style={tickStripStyle} />
			</Box>

			{/* Drag handle to resize ruler track */}
			<Box
				style={{
					position: "absolute",
					zIndex: 15,
					touchAction: "none",
					...(isHorizontal
						? {
								left: 0,
								right: 0,
								height: 16,
								cursor: "row-resize",
								...(edge === "start"
									? { top: rulerThickness - 8 }
									: { bottom: rulerThickness - 8 }),
							}
						: {
								top: 0,
								bottom: 0,
								width: 16,
								cursor: "col-resize",
								...(edge === "start"
									? { left: rulerThickness - 8 }
									: { right: rulerThickness - 8 }),
							}),
				}}
				onPointerDown={(e: React.PointerEvent) => {
					e.preventDefault();
					(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
					const startPos = isHorizontal ? e.clientY : e.clientX;
					rulerDragRef.current = { startY: startPos, startThickness: rulerThickness };

					const onMove = (ev: PointerEvent) => {
						if (!rulerDragRef.current) return;
						const currentPos = isHorizontal ? ev.clientY : ev.clientX;
						const delta =
							edge === "start"
								? currentPos - rulerDragRef.current.startY
								: rulerDragRef.current.startY - currentPos;
						const newThickness = Math.max(
							DEFAULT_RULER_THICKNESS,
							Math.min(MAX_RULER_THICKNESS, rulerDragRef.current.startThickness + delta),
						);
						setRulerThickness(newThickness);
					};
					const onUp = () => {
						rulerDragRef.current = null;
						rulerDragCleanupRef.current = null;
						document.removeEventListener("pointermove", onMove);
						document.removeEventListener("pointerup", onUp);
						document.removeEventListener("pointercancel", onUp);
					};
					document.addEventListener("pointermove", onMove);
					document.addEventListener("pointerup", onUp);
					document.addEventListener("pointercancel", onUp);
					rulerDragCleanupRef.current = onUp;
				}}
			/>

			{/* PixiJS rendering layer — ticks, clusters, heatmap, connectors, dot/pill morphs */}
			<RulerPixiLayer
				containerWidth={containerWidth}
				containerHeight={containerHeight}
				orientation={orientation}
				pixiRef={pixiRef}
				camera={camera}
				layout={layout}
				segments={segments}
				chapters={pixiChapters}
				zoomTier={zoomTier}
				clusters={clusters}
				tickPositions={tickPositions}
				rulerThickness={rulerThickness}
				commitMessages={commitMessages}
				alwaysVisibleChapters={alwaysVisibleChapters}
				openPanelChapterIds={openPanelChapterIds}
				onChapterClick={handlePixiChapterClick}
				onChapterContextMenu={handlePixiChapterContextMenu}
				onChapterDragEnd={handlePixiChapterDragEnd}
			/>

			{/* 2D Canvas */}
			<Box
				style={canvasStyle}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onContextMenu={handleTickContextMenu}
				onDoubleClick={(e) => {
					if (e.target === e.currentTarget) resetCamera();
				}}
			>
				<Box
					ref={worldLayerRef}
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: 1,
						height: 1,
						overflow: "visible",
						transformOrigin: "0 0",
						transform: worldTransform,
					}}
				>
					{zoomTier !== "L0" &&
						segmentTicks.map((tick) => {
							const seg = tick.segment;
							if (!seg) return null;
							const nextTick = layout.ticks[tick.index + 1];
							const segSize = nextTick ? nextTick.x - tick.x : COLLAPSED_GAP;
							const smp = worldToScreen(tick.x, fisheyeCenter, mainViewport, scale);
							const sme = worldToScreen(tick.x + segSize, fisheyeCenter, mainViewport, scale);
							return (
								<SegmentCanvas
									key={`seg-${tick.sha}`}
									projectId={projectId}
									fromSha={tick.sha}
									toSha={seg.toSha}
									mainPos={tick.x}
									mainSize={segSize}
									segment={seg}
									scale={scale}
									orientation={orientation}
									viewTop={worldViewTop}
									viewHeight={worldViewHeight}
									cardRegistry={cardRegistryRef}
									onChapterContextMenu={setChapterMenu}
									onFitToView={fitRectToView}
									zoomCenterWorldX={fisheyeCenter}
									viewportSize={mainViewport}
									screenMainPos={smp}
									screenMainSize={sme - smp}
									screenCrossOffset={crossPan}
									onChaptersLoaded={handleChaptersLoaded}
									onChapterDragMove={handleChapterDragMove}
								/>
							);
						})}
				</Box>

				{commits.length === 0 && (
					<Center h="100%">
						<Stack align="center" gap="xs">
							<Text c="dimmed">{t("noChapters")}</Text>
						</Stack>
					</Center>
				)}
			</Box>

			{/* Segment headers — fixed at edge of canvas, only main-axis follows camera */}
			<Box
				ref={headerLayerRef}
				style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}
			>
				{segmentTicks.map((tick) => {
					const seg = tick.segment;
					if (!seg) return null;
					const screenMain = worldToScreen(tick.x, fisheyeCenter, mainViewport, scale);
					const nextTick = layout.ticks[tick.index + 1];
					const segWorldEnd = nextTick ? nextTick.x : tick.x + COLLAPSED_GAP;
					const screenEnd = worldToScreen(segWorldEnd, fisheyeCenter, mainViewport, scale);
					const segScreenSize = screenEnd - screenMain;
					const headerStyle: React.CSSProperties = {
						position: "absolute",
						pointerEvents: "none",
					};
					if (isHorizontal) {
						Object.assign(headerStyle, {
							top: (edge === "start" ? rulerThickness : 0) + 2,
							left: screenMain,
							width: segScreenSize,
						});
					} else {
						Object.assign(headerStyle, {
							left: (edge === "start" ? rulerThickness : 0) + 2,
							top: screenMain,
							height: segScreenSize,
						});
					}
					return (
						<Group
							key={`seg-hdr-${tick.sha}`}
							gap={4}
							px={8}
							py={4}
							style={headerStyle}
							wrap={isHorizontal ? "nowrap" : "wrap"}
							data-world-main={tick.x}
							data-world-size={segWorldEnd - tick.x}
						></Group>
					);
				})}
			</Box>

			<OffscreenBubbles
				cards={Array.from(cardRegistryRef.current.values()).flat()}
				panX={panX}
				panY={panY}
				scale={scale}
				viewportWidth={containerWidth}
				viewportHeight={containerRef.current?.clientHeight ?? 800}
				rulerThickness={rulerThickness}
				orientation={orientation}
				edge={edge}
				onNavigate={navigateToWorld}
			/>

			{/* Toolbar — orientation / edge / reset */}
			<Group gap={4} style={{ position: "absolute", bottom: 12, right: 12, zIndex: 20 }}>
				<Tooltip label={isHorizontal ? t("ruler.vertical") : t("ruler.horizontal")}>
					<ActionIcon variant="subtle" color="gray" size="sm" onClick={toggleOrientation}>
						{isHorizontal ? <IconArrowsVertical size={16} /> : <IconArrowsHorizontal size={16} />}
					</ActionIcon>
				</Tooltip>
				<Tooltip label={edge === "start" ? t("ruler.edgeEnd") : t("ruler.edgeStart")}>
					<ActionIcon variant="subtle" color="gray" size="sm" onClick={toggleEdge}>
						{edge === "start" ? (
							<IconLayoutSidebarRightCollapse size={16} />
						) : (
							<IconLayoutSidebarLeftCollapse size={16} />
						)}
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("ruler.resetView")}>
					<ActionIcon variant="subtle" color="gray" size="sm" onClick={resetCamera}>
						<IconHome size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{tickMenu && (
				<TickContextMenu
					x={tickMenu.x}
					y={tickMenu.y}
					commitSha={tickMenu.sha}
					commitMessage={tickMenu.message}
					commitAuthor={tickMenu.author}
					commitDate={tickMenu.date}
					onClose={() => setTickMenu(null)}
					onFork={handleForkFromCommit}
				/>
			)}

			{chapterMenu && (
				<ChapterContextMenu
					x={chapterMenu.x}
					y={chapterMenu.y}
					chapterId={chapterMenu.chapter.id}
					chapterTitle={chapterMenu.chapter.title}
					chapterStatus={chapterMenu.chapter.status}
					chapterRole={chapterMenu.chapter.role}
					onClose={() => setChapterMenu(null)}
					onFork={handleChapterFork}
					onMerge={handleChapterMerge}
					onReview={handleChapterReview}
					onAbandon={handleChapterAbandon}
				/>
			)}
		</Box>
	);
}
