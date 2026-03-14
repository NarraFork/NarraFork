import { ActionIcon, Badge, Box, Center, Group, Loader, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconArrowsHorizontal,
	IconArrowsVertical,
	IconHome,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarRightCollapse,
} from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RulerData, type RulerSegment, useRulerData } from "../../hooks/useRuler";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { type CommitCluster, clusterCommits, computeHeatmap } from "./commit-cluster";
import { COLLAPSED_GAP, computeElasticLayout, type TickPosition } from "./elastic-layout";
import { OffscreenBubbles } from "./OffscreenBubbles";
import { ChapterContextMenu, TickContextMenu } from "./RulerContextMenus";
import { type ChapterContextMenuState, SegmentCanvas } from "./SegmentCanvas";
import { RULER_THICKNESS, type RulerEdge, type RulerOrientation } from "./types";
import { getZoomTierInfo, type ZoomTierId } from "./zoom-tiers";

interface RulerFlowProps {
	projectId: string;
	focusChapterId?: string | null;
}

const TICK_WIDTH = 2;
/** Multiplier of viewport size used as off-screen buffer for commit ticks on the ruler */
const TICK_VIEWPORT_MULTIPLIER = 5;
/** Multiplier of viewport size used as off-screen buffer for expanded segment canvases */
const SEGMENT_VIEWPORT_MULTIPLIER = 3;

interface Camera {
	panX: number;
	panY: number;
	scale: number;
	orientation: RulerOrientation;
	edge: RulerEdge;
}

interface ClampBounds {
	maxContentCross: number;
	crossViewportSize: number;
	maxContentMain: number;
	mainViewportSize: number;
}

/** Compute the hard min/max for each axis. */
function getMainBounds(opts: ClampBounds, scale: number) {
	const max = opts.mainViewportSize; // viewport right edge touches x=0
	const min = -opts.maxContentMain * scale; // viewport left edge touches last content
	return { min, max };
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
function clampCamera(cam: Camera, opts?: ClampBounds): Camera {
	const isH = cam.orientation === "horizontal";
	let mainPan = isH ? cam.panX : cam.panY;
	let crossPan = isH ? cam.panY : cam.panX;

	if (opts) {
		const cb = getCrossBounds(opts, cam.scale);
		crossPan = Math.max(cb.min, Math.min(cb.max, crossPan));

		if (opts.maxContentMain > 0) {
			const mb = getMainBounds(opts, cam.scale);
			mainPan = Math.max(mb.min, Math.min(mb.max, mainPan));
		}
	}

	if (isH) {
		const changed = mainPan !== cam.panX || crossPan !== cam.panY;
		return changed ? { ...cam, panX: mainPan, panY: crossPan } : cam;
	}
	const changed = mainPan !== cam.panY || crossPan !== cam.panX;
	return changed ? { ...cam, panX: crossPan, panY: mainPan } : cam;
}

/**
 * Soft clamp — allows overscroll with rubber-band resistance.
 * The further past the boundary, the harder it is to drag.
 */
const RUBBER_BAND_FACTOR = 0.3;

function rubberBand(value: number, min: number, max: number): number {
	if (value > max) return max + (value - max) * RUBBER_BAND_FACTOR;
	if (value < min) return min + (value - min) * RUBBER_BAND_FACTOR;
	return value;
}

function softClampCamera(cam: Camera, opts?: ClampBounds): Camera {
	const isH = cam.orientation === "horizontal";
	let mainPan = isH ? cam.panX : cam.panY;
	let crossPan = isH ? cam.panY : cam.panX;

	if (opts) {
		const cb = getCrossBounds(opts, cam.scale);
		crossPan = rubberBand(crossPan, cb.min, cb.max);

		if (opts.maxContentMain > 0) {
			const mb = getMainBounds(opts, cam.scale);
			mainPan = rubberBand(mainPan, mb.min, mb.max);
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
		const isH = cam.orientation === "horizontal";
		const { panX: px, panY: py, scale: s } = cam;

		// Tick strip — translate + scale; update counter-scale CSS variable for ticks
		const strip = tickStripRef.current;
		if (strip) {
			strip.style.transform = isH
				? `translateX(${px}px) scaleX(${s})`
				: `translateY(${py}px) scaleY(${s})`;
			strip.style.setProperty("--ruler-counter-scale", String(1 / s));
		}

		// World layer (2D canvas)
		const world = worldLayerRef.current;
		if (world) {
			world.style.transform = `translate(${px}px, ${py}px) scale(${s})`;
		}

		// Segment headers — each child is positioned by screen-space main coordinate
		const hdr = headerLayerRef.current;
		if (hdr) {
			const mainPan = isH ? px : py;
			for (let i = 0; i < hdr.children.length; i++) {
				const child = hdr.children[i] as HTMLElement;
				const worldMain = Number(child.dataset.worldMain);
				const worldSize = Number(child.dataset.worldSize);
				if (Number.isNaN(worldMain)) continue;
				const screenMain = worldMain * s + mainPan;
				const screenSize = worldSize * s;
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

			// Track frame timing for performance monitoring
			const pm = perfMonitorRef.current;
			const now = performance.now();
			if (pm.lastFrame > 0) {
				pm.frameTimes.push(now - pm.lastFrame);
				if (pm.frameTimes.length > 60) pm.frameTimes.shift();
				// Check P95 every 60 frames
				if (pm.frameTimes.length === 60) {
					const sorted = [...pm.frameTimes].sort((a, b) => a - b);
					const p95 = sorted[Math.floor(sorted.length * 0.95)];
					const newLevel =
						p95 > 32
							? Math.min(2, pm.degradeLevel + 1)
							: p95 < 18 && pm.degradeLevel > 0
								? pm.degradeLevel - 1
								: pm.degradeLevel;
					if (newLevel !== pm.degradeLevel) {
						pm.degradeLevel = newLevel;
						setDegradeLevel(newLevel);
					}
				}
			}
			pm.lastFrame = now;
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

	// --- Performance monitoring + adaptive degradation ---
	const perfMonitorRef = useRef({ frameTimes: [] as number[], degradeLevel: 0, lastFrame: 0 });
	const [degradeLevel, setDegradeLevel] = useState(0);

	const containerRef = useRef<HTMLDivElement>(null);
	const wheelCleanupRef = useRef<(() => void) | null>(null);
	const isPanningRef = useRef(false);
	const panStartRef = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
	const segmentsRef = useRef<RulerSegment[]>([]);
	const layoutRef = useRef<{ ticks: TickPosition[]; totalWidth: number }>({
		ticks: [],
		totalWidth: 0,
	});
	const commitShasRef = useRef<string[]>([]);

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
			? (el?.clientHeight ?? 800) - RULER_THICKNESS
			: (el?.clientWidth ?? 1200) - RULER_THICKNESS;
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
	}, []);

	/** Hard clamp — snap to bounds. For navigation, animation targets, etc. */
	const hardClamp = useCallback((cam: Camera) => clampCamera(cam, getBounds()), [getBounds]);

	/** Soft clamp — rubber-band resistance during active interaction. */
	const softClamp = useCallback((cam: Camera) => softClampCamera(cam, getBounds()), [getBounds]);

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

	// --- Context menu ---
	const [tickMenu, setTickMenu] = useState<{
		x: number;
		y: number;
		sha: string;
		message: string;
		hasSegment: boolean;
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
			const canvasW = isH ? vw : vw - RULER_THICKNESS;
			const canvasH = isH ? vh - RULER_THICKNESS : vh;
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
		[hardClamp, syncSmoothTarget, scheduleLightRender],
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
			const canvasW = isH ? vw : vw - RULER_THICKNESS;
			const canvasH = isH ? vh - RULER_THICKNESS : vh;

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
		[hardClamp, syncSmoothTarget, scheduleLightRender],
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

	// --- Input handlers ---
	const wheelBounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const containerCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			wheelCleanupRef.current?.();
			wheelCleanupRef.current = null;
			containerRef.current = el;
			if (!el) return;

			const onWheel = (e: WheelEvent) => {
				cancelAnimationFrame(bounceRafRef.current);
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
						? mouseY - (cam.edge === "start" ? RULER_THICKNESS : 0)
						: mouseX - (cam.edge === "start" ? RULER_THICKNESS : 0);
					const newScale = Math.max(0.1, Math.min(5, cam.scale * factor));
					const mainPan = isH ? cam.panX : cam.panY;
					const crossPan = isH ? cam.panY : cam.panX;

					// Classic zoom: tick.x is scale-independent, so standard
					// world-coordinate anchoring works without any conversion.
					const worldMain = (canvasMouseMain - mainPan) / cam.scale;
					const newMainPan = canvasMouseMain - worldMain * newScale;

					// Cross-axis zoom anchor
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
					const newCrossPan = canvasMouseCross - worldMouseCross * newScale;

					cameraRef.current = softClamp({
						...cam,
						panX: isH ? newMainPan : newCrossPan,
						panY: isH ? newCrossPan : newMainPan,
						scale: newScale,
					});
					scheduleLightRender();
					syncSmoothTarget();
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
						const crossCam = softClamp({
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
						const smoothStep = () => {
							const cur = cameraRef.current;
							const curMain = cur.orientation === "horizontal" ? cur.panX : cur.panY;
							const diff = ss.targetMainPan - curMain;

							// Lerp factor — higher = snappier, lower = smoother
							const LERP = 0.18;
							if (Math.abs(diff) < 0.5) {
								// Close enough — snap and stop
								const finalCam = softClamp({
									...cur,
									...(cur.orientation === "horizontal"
										? { panX: ss.targetMainPan }
										: { panY: ss.targetMainPan }),
								});
								cameraRef.current = finalCam;
								scheduleLightRender();
								ss.animating = false;

								// Trigger bounce check
								if (wheelBounceTimerRef.current) clearTimeout(wheelBounceTimerRef.current);
								wheelBounceTimerRef.current = setTimeout(() => {
									wheelBounceTimerRef.current = null;
									// Commit camera to React state after scroll settles
									setCamera({ ...cameraRef.current });
									animateBounce();
									updatePrefetch();
								}, 120);
								return;
							}

							const newMain = curMain + diff * LERP;
							const newCam = softClamp({
								...cur,
								...(cur.orientation === "horizontal" ? { panX: newMain } : { panY: newMain }),
							});
							cameraRef.current = newCam;
							scheduleLightRender();
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

				// Bounce back after wheel activity stops (for zoom case; smooth scroll handles its own)
				if (e.ctrlKey || e.metaKey) {
					if (wheelBounceTimerRef.current) clearTimeout(wheelBounceTimerRef.current);
					wheelBounceTimerRef.current = setTimeout(() => {
						wheelBounceTimerRef.current = null;
						// Commit camera to React state after zoom interaction settles
						setCamera({ ...cameraRef.current });
						animateBounce();
						updatePrefetch();
					}, 120);
				}
			};

			el.addEventListener("wheel", onWheel, { passive: false });
			wheelCleanupRef.current = () => {
				el.removeEventListener("wheel", onWheel);
				cancelAnimationFrame(smoothScrollRef.current.rafId);
				smoothScrollRef.current.animating = false;
			};
		},
		[scheduleLightRender, softClamp, animateBounce, syncSmoothTarget, updatePrefetch],
	);
	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button === 1 || (e.button === 0 && e.currentTarget === e.target)) {
			cancelAnimationFrame(bounceRafRef.current);
			isPanningRef.current = true;
			panStartRef.current = {
				x: e.clientX,
				y: e.clientY,
				camX: cameraRef.current.panX,
				camY: cameraRef.current.panY,
			};
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			e.preventDefault();
		}
	}, []);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!isPanningRef.current) return;
			cameraRef.current = softClamp({
				...cameraRef.current,
				panX: panStartRef.current.camX + (e.clientX - panStartRef.current.x),
				panY: panStartRef.current.camY + (e.clientY - panStartRef.current.y),
			});
			scheduleLightRender();
		},
		[scheduleLightRender, softClamp],
	);

	const handlePointerUp = useCallback(() => {
		if (isPanningRef.current) {
			isPanningRef.current = false;
			// Commit final camera to React state
			setCamera({ ...cameraRef.current });
			syncSmoothTarget();
			animateBounce();
			updatePrefetch();
		}
	}, [animateBounce, syncSmoothTarget, updatePrefetch]);

	const toggleOrientation = useCallback(() => {
		const cam = cameraRef.current;
		const newOri = cam.orientation === "horizontal" ? "vertical" : "horizontal";
		const isH = newOri === "horizontal";
		const el = containerRef.current;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		const tw = totalMainRef.current;
		const mainPan = -(tw * 1) + mainVp - 40;
		const next = hardClamp({
			...cam,
			orientation: newOri,
			...(isH ? { panX: mainPan, panY: 0 } : { panX: 0, panY: mainPan }),
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

	// --- Layout computation ---
	const rulerData = (data as RulerData) ?? { commits: [], segments: [], activeChapters: [] };
	// Reverse commits so oldest is at x=0 (left) and newest at x=max (right)
	const rawCommits = rulerData.commits ?? [];
	const commits = useMemo(() => [...rawCommits].reverse(), [rawCommits]);
	// Remap segment fromIndex to match the reversed commit order
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

	// Keep ref in sync so layout reads latest segments
	segmentsRef.current = segments;
	layoutRef.current = layout;
	commitShasRef.current = commitShas;

	// Keep totalMainRef in sync for clamp calculations
	totalMainRef.current = layout.totalWidth;

	// --- Memory reclamation: evict stale segment caches ---
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

	// On first load without a saved ruler viewport, position camera at the latest commit (right end).
	// After reversing, newest commit is at x=totalWidth, so we pan to show the right edge.
	// needsInitialPosition is a state so this effect re-runs when prefs finish loading.
	useEffect(() => {
		if (!needsInitialPosition || commits.length === 0) return;
		setNeedsInitialPosition(false);
		const cam = cameraRef.current;
		const isH = cam.orientation === "horizontal";
		const el = containerRef.current;
		const mainVp = isH ? (el?.clientWidth ?? 1200) : (el?.clientHeight ?? 800);
		// Position so the right edge of the viewport aligns with the last tick + some padding
		const mainPan = -(layout.totalWidth * cam.scale) + mainVp - 40;
		const clamped = clampCamera(
			{ ...cam, ...(isH ? { panX: mainPan, panY: 0 } : { panX: 0, panY: mainPan }) },
			getBounds(),
		);
		cameraRef.current = clamped;
		setCamera({ ...clamped });
	}, [needsInitialPosition, commits.length, layout.totalWidth, getBounds]);

	// Build sha → main-axis world position map for connector lines
	const tickPositions = useMemo(() => {
		const map = new Map<string, number>();
		for (const tick of layout.ticks) {
			map.set(tick.sha, tick.x);
		}
		return map;
	}, [layout.ticks]);

	// --- Derived values ---
	const { panX, panY, scale, orientation, edge } = camera;
	const isHorizontal = orientation === "horizontal";
	const containerWidth = containerRef.current?.clientWidth ?? 1200;
	const containerHeight = containerRef.current?.clientHeight ?? 800;

	// --- Zoom Tier ---
	const tierInfo = useMemo(() => getZoomTierInfo(scale), [scale]);
	const zoomTier: ZoomTierId = tierInfo.tier.id;

	// The "main axis" viewport size (along the ruler) and "cross axis" size
	const mainViewport = isHorizontal ? containerWidth : containerHeight;
	const crossViewport = isHorizontal
		? containerHeight - RULER_THICKNESS
		: containerWidth - RULER_THICKNESS;
	// Pan along the main axis
	const mainPan = isHorizontal ? panX : panY;
	const crossPan = isHorizontal ? panY : panX;

	// Pre-compute visible ticks to avoid per-tick work in render.
	// Commit ticks use a generous 5× viewport buffer so the ruler never pops in during scroll.
	// Expanded segments (cards / panels) use a 3× viewport buffer.
	const { visibleTicks, segmentTicks } = useMemo(() => {
		const worldViewportMain = mainViewport / scale;
		const worldViewStart = -mainPan / scale;

		const tickBuffer = (worldViewportMain * TICK_VIEWPORT_MULTIPLIER - worldViewportMain) / 2;
		const tickStart = worldViewStart - tickBuffer;
		const tickEnd = worldViewStart + worldViewportMain + tickBuffer;

		const segBuffer = (worldViewportMain * SEGMENT_VIEWPORT_MULTIPLIER - worldViewportMain) / 2;
		const segStart = worldViewStart - segBuffer;
		const segEnd = worldViewStart + worldViewportMain + segBuffer;

		const visible: typeof layout.ticks = [];
		const segs: typeof layout.ticks = [];
		for (const tick of layout.ticks) {
			if (tick.x >= tickStart && tick.x <= tickEnd) visible.push(tick);
			if (tick.segment) {
				// Cull segments by main-axis visibility (3× viewport)
				const nextTick = layout.ticks[tick.index + 1];
				const segEndX = nextTick ? nextTick.x : tick.x + 400;
				if (segEndX >= segStart && tick.x <= segEnd) {
					segs.push(tick);
				}
			}
		}
		return { visibleTicks: visible, segmentTicks: segs };
	}, [layout.ticks, mainPan, scale, mainViewport]);

	// --- Commit clusters for L0/L1 ---
	const segmentBySha = useMemo(() => {
		const map = new Map<string, RulerSegment>();
		for (const seg of segments) map.set(seg.fromSha, seg);
		return map;
	}, [segments]);

	const clusters = useMemo(
		() => clusterCommits(layout.ticks, segmentBySha, scale),
		[layout.ticks, segmentBySha, scale],
	);
	const usesClusters = zoomTier === "L0" || zoomTier === "L1";

	// --- Heatmap for L0 ---
	const heatmapGradient = useMemo(() => {
		if (zoomTier !== "L0" || clusters.length === 0 || degradeLevel >= 2) return undefined;
		const segs = computeHeatmap(clusters, layout.totalWidth, mainViewport);
		if (segs.length === 0) return undefined;
		const stops = segs.map((s) => {
			const pct = ((s.startX + s.endX) / 2 / layout.totalWidth) * 100;
			const alpha = s.intensity * 0.5;
			return `rgba(99, 102, 241, ${alpha.toFixed(2)}) ${pct.toFixed(1)}%`;
		});
		return `linear-gradient(to right, ${stops.join(", ")})`;
	}, [zoomTier, clusters, layout.totalWidth, mainViewport, degradeLevel]);

	const worldViewTop = -crossPan / scale;
	const worldViewHeight = crossViewport / scale;

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
		background: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
		zIndex: 10,
		overflow: "hidden",
	};
	if (isHorizontal) {
		Object.assign(rulerTrackStyle, {
			left: 0,
			right: 0,
			height: RULER_THICKNESS,
			borderBottom: edge === "start" ? "2px solid var(--mantine-color-indigo-7)" : undefined,
			borderTop: edge === "end" ? "2px solid var(--mantine-color-indigo-7)" : undefined,
			...(edge === "start" ? { top: 0 } : { bottom: 0 }),
		});
	} else {
		Object.assign(rulerTrackStyle, {
			top: 0,
			bottom: 0,
			width: RULER_THICKNESS,
			borderRight: edge === "start" ? "2px solid var(--mantine-color-indigo-7)" : undefined,
			borderLeft: edge === "end" ? "2px solid var(--mantine-color-indigo-7)" : undefined,
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
				? { top: RULER_THICKNESS, bottom: 0 }
				: { top: 0, bottom: RULER_THICKNESS }),
		});
	} else {
		Object.assign(canvasStyle, {
			top: 0,
			bottom: 0,
			...(edge === "start"
				? { left: RULER_THICKNESS, right: 0 }
				: { left: 0, right: RULER_THICKNESS }),
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
	const worldTransform = isHorizontal
		? `translate(${panX}px, ${panY}px) scale(${scale})`
		: `translate(${panX}px, ${panY}px) scale(${scale})`;

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
			<Box style={rulerTrackStyle}>
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
				<Box ref={tickStripRef} style={tickStripStyle}>
					{heatmapGradient && (
						<Box
							style={{
								position: "absolute",
								inset: 0,
								background: heatmapGradient,
								borderRadius: 2,
								pointerEvents: "none",
							}}
						/>
					)}
					{usesClusters
						? clusters.map((cluster) => (
								<RulerClusterTick
									key={`cl-${cluster.startSha}`}
									cluster={cluster}
									orientation={orientation}
									zoomTier={zoomTier}
								/>
							))
						: visibleTicks.map((tick) => (
								<RulerTick
									key={tick.sha}
									tick={tick}
									commit={commits[tick.index]}
									showLabel
									orientation={orientation}
									onContextMenu={(cx, cy) =>
										setTickMenu({
											x: cx,
											y: cy,
											sha: tick.sha,
											message: commits[tick.index]?.message ?? "",
											hasSegment: !!tick.segment,
										})
									}
								/>
							))}
				</Box>
			</Box>

			{/* 2D Canvas */}
			<Box
				style={canvasStyle}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
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
					{!usesClusters &&
						segmentTicks.map((tick) => {
							const seg = tick.segment;
							if (!seg) return null;
							const nextTick = layout.ticks[tick.index + 1];
							const segSize = nextTick ? nextTick.x - tick.x : 400;
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
									tickPositions={tickPositions}
									onFitToView={fitRectToView}
									zoomTier={zoomTier}
									degradeLevel={degradeLevel}
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
					const screenMain = tick.x * scale + mainPan;
					const nextTick = layout.ticks[tick.index + 1];
					const segWorldSize = nextTick ? nextTick.x - tick.x : 400;
					const segScreenSize = segWorldSize * scale;
					const headerStyle: React.CSSProperties = {
						position: "absolute",
						pointerEvents: "none",
					};
					if (isHorizontal) {
						Object.assign(headerStyle, {
							top: (edge === "start" ? RULER_THICKNESS : 0) + 2,
							left: screenMain,
							width: segScreenSize,
						});
					} else {
						Object.assign(headerStyle, {
							left: (edge === "start" ? RULER_THICKNESS : 0) + 2,
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
							data-world-size={segWorldSize}
						>
							<Badge size="xs" variant="light" color="indigo">
								{t("ruler.chapterCount", { count: seg.totalChapterCount })}
							</Badge>
							{seg.activeChapterCount > 0 && (
								<Badge size="xs" variant="filled" color="indigo">
									{t("ruler.activeCount", { count: seg.activeChapterCount })}
								</Badge>
							)}
						</Group>
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
				rulerThickness={RULER_THICKNESS}
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
					hasSegment={tickMenu.hasSegment}
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

// --- Memoized tick component to avoid re-rendering all ticks on camera change ---
interface RulerTickProps {
	tick: TickPosition;
	commit: { shortSha: string; message: string } | undefined;
	showLabel: boolean;
	orientation: RulerOrientation;
	onContextMenu: (x: number, y: number) => void;
}

const RulerTick = memo(function RulerTick({
	tick,
	commit,
	showLabel,
	orientation,
	onContextMenu,
}: RulerTickProps) {
	const segment = tick.segment;
	const hasActive = segment && segment.activeChapterCount > 0;
	const isExpandable = segment?.isExpandable;
	const isH = orientation === "horizontal";
	// Position at world coordinate; the parent strip's CSS transform handles scaling.
	// Counter-scale via CSS variable (updated by applyTransformToDOM) keeps content readable.
	const pos = tick.x;

	return (
		<Box
			style={{
				position: "absolute",
				...(isH ? { left: pos, top: 0, height: "100%" } : { top: pos, left: 0, width: "100%" }),
				display: "flex",
				flexDirection: isH ? "column" : "row",
				alignItems: isH ? "flex-start" : "flex-start",
				cursor: isExpandable ? "pointer" : "default",
				transform: isH
					? "scaleX(var(--ruler-counter-scale, 1))"
					: "scaleY(var(--ruler-counter-scale, 1))",
				transformOrigin: "0 0",
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				onContextMenu(e.clientX, e.clientY);
			}}
		>
			<Box
				style={{
					...(isH
						? { width: TICK_WIDTH, height: hasActive ? 20 : 14, marginTop: 4 }
						: { height: TICK_WIDTH, width: hasActive ? 20 : 14, marginLeft: 4 }),
					background: hasActive
						? "var(--mantine-color-indigo-5)"
						: "light-dark(var(--mantine-color-gray-5), var(--mantine-color-dark-1))",
					borderRadius: 1,
					flexShrink: 0,
				}}
			/>
			{showLabel && (
				<Text
					size="9px"
					c={hasActive ? "indigo.4" : "dimmed"}
					style={{
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						maxWidth: isH ? 76 : undefined,
						maxHeight: isH ? undefined : 76,
						textAlign: isH ? "left" : "center",
						lineHeight: 1.2,
						...(isH
							? { marginTop: 2, marginLeft: -TICK_WIDTH / 2 }
							: {
									marginLeft: 2,
									marginTop: -TICK_WIDTH / 2,
									writingMode: "vertical-rl",
									transform: "rotate(180deg)",
								}),
					}}
				>
					{commit?.shortSha}
				</Text>
			)}
			{isExpandable && (
				<Box
					style={{
						width: 10,
						height: 10,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-4)",
						...(isH
							? { marginTop: 2, marginLeft: -10 / 2 + TICK_WIDTH / 2 }
							: { marginLeft: 2, marginTop: -10 / 2 + TICK_WIDTH / 2 }),
						border: "2px solid var(--mantine-color-indigo-3)",
						transition: "all 150ms ease",
					}}
				/>
			)}
		</Box>
	);
});

/** Aggregated commit cluster tick for L0/L1 zoom levels. */
const RulerClusterTick = memo(function RulerClusterTick({
	cluster,
	orientation,
	zoomTier,
}: {
	cluster: CommitCluster;
	orientation: RulerOrientation;
	zoomTier: ZoomTierId;
}) {
	const isH = orientation === "horizontal";
	const barHeight = Math.min(14, 4 + cluster.count * 0.5);
	const hasActive = cluster.activeCount > 0;
	const bg = hasActive
		? "var(--mantine-color-indigo-6)"
		: "light-dark(var(--mantine-color-gray-5), var(--mantine-color-dark-3))";

	return (
		<Box
			style={{
				position: "absolute",
				...(isH
					? {
							left: cluster.worldPos - cluster.worldSize / 2,
							top: RULER_THICKNESS / 2 - barHeight / 2,
							width: Math.max(4, cluster.worldSize),
							height: barHeight,
						}
					: {
							top: cluster.worldPos - cluster.worldSize / 2,
							left: RULER_THICKNESS / 2 - barHeight / 2,
							height: Math.max(4, cluster.worldSize),
							width: barHeight,
						}),
				background: bg,
				borderRadius: 2,
				opacity: hasActive ? 1 : 0.7,
			}}
		>
			{zoomTier === "L1" && cluster.count > 1 && (
				<Text
					size="8px"
					c="dimmed"
					style={{
						position: "absolute",
						...(isH ? { top: -12, left: 0 } : { left: -12, top: 0 }),
						lineHeight: 1,
						whiteSpace: "nowrap",
					}}
				>
					{cluster.count}
				</Text>
			)}
			{cluster.hasSegments && hasActive && (
				<Box
					style={{
						position: "absolute",
						width: 5,
						height: 5,
						borderRadius: "50%",
						background: "var(--mantine-color-indigo-4)",
						...(isH
							? { top: -8, left: "50%", marginLeft: -2.5 }
							: { left: -8, top: "50%", marginTop: -2.5 }),
					}}
				/>
			)}
		</Box>
	);
});
