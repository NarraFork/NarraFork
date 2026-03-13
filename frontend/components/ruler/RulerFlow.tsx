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
import { type RulerData, useRulerData } from "../../hooks/useRuler";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { computeElasticLayout, type TickPosition } from "./elastic-layout";
import { OffscreenBubbles } from "./OffscreenBubbles";
import { ChapterContextMenu, TickContextMenu } from "./RulerContextMenus";
import { type ChapterContextMenuState, SegmentCanvas } from "./SegmentCanvas";
import { RULER_THICKNESS, type RulerEdge, type RulerOrientation } from "./types";

interface RulerFlowProps {
	projectId: string;
	focusChapterId?: string | null;
}

const TICK_WIDTH = 2;
const VIEWPORT_BUFFER = 200;

interface Camera {
	panX: number;
	panY: number;
	scale: number;
	orientation: RulerOrientation;
	edge: RulerEdge;
}

/** Clamp camera so the cross-axis viewport never enters negative world space (crossOffset < 0). */
function clampCamera(cam: Camera): Camera {
	const isH = cam.orientation === "horizontal";
	// crossPan is the screen-space offset of world origin along the cross axis.
	// When crossPan > 0, negative world space is visible — clamp to 0.
	const crossPan = isH ? cam.panY : cam.panX;
	if (crossPan > 0) {
		return isH ? { ...cam, panY: 0 } : { ...cam, panX: 0 };
	}
	return cam;
}

export function RulerFlow({ projectId }: RulerFlowProps) {
	const { t } = useTranslation("graph");
	const { data, isLoading, error } = useRulerData(projectId);
	const { data: prefs } = useUserPreferences();

	// --- Camera state: ref is source of truth, state drives render via rAF ---
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
				}
			> = {};
			if (typeof raw === "string") viewports = JSON.parse(raw);
			else if (raw && typeof raw === "object") viewports = raw as typeof viewports;
			const v = viewports[projectId];
			if (v)
				return clampCamera({
					panX: v.x,
					panY: v.y,
					scale: v.zoom,
					orientation: v.rulerOrientation ?? "horizontal",
					edge: v.rulerEdge ?? "start",
				});
		} catch {
			/* corrupted */
		}
		return { panX: 40, panY: 0, scale: 1, orientation: "horizontal", edge: "start" };
	}, [prefs, projectId]);

	const cameraRef = useRef<Camera>(savedCamera);
	const [camera, setCamera] = useState<Camera>(savedCamera);
	const cameraInitializedRef = useRef(false);
	const rafIdRef = useRef(0);

	// Apply saved camera once when prefs load
	useEffect(() => {
		if (cameraInitializedRef.current || !prefs) return;
		cameraInitializedRef.current = true;
		cameraRef.current = savedCamera;
		setCamera(savedCamera);
	}, [savedCamera, prefs]);

	// Batched camera update: write to ref immediately, schedule one rAF for state
	const scheduleRender = useCallback(() => {
		if (rafIdRef.current) return;
		rafIdRef.current = requestAnimationFrame(() => {
			rafIdRef.current = 0;
			setCamera({ ...cameraRef.current });
		});
	}, []);

	// Debounced save to server
	const cameraSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!cameraInitializedRef.current) return;
		if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
		cameraSaveTimerRef.current = setTimeout(() => {
			api.saveGraphViewport(projectId, {
				x: camera.panX,
				y: camera.panY,
				zoom: camera.scale,
				rulerOrientation: camera.orientation,
				rulerEdge: camera.edge,
			});
		}, 800);
		return () => {
			if (cameraSaveTimerRef.current) clearTimeout(cameraSaveTimerRef.current);
		};
	}, [camera, projectId]);

	// --- Expanded segments ---
	const [expandedSegments, setExpandedSegments] = useState<Set<string>>(new Set());
	const containerRef = useRef<HTMLDivElement>(null);
	const wheelCleanupRef = useRef<(() => void) | null>(null);
	const isPanningRef = useRef(false);
	const panStartRef = useRef({ x: 0, y: 0, camX: 0, camY: 0 });
	const queryClient = useQueryClient();

	// --- Offscreen card tracking (ref-based, no re-render) ---
	const cardRegistryRef = useRef<
		Map<
			string,
			Array<{ id: string; title: string; worldX: number; worldY: number; status: string }>
		>
	>(new Map());

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
		cameraRef.current = clampCamera({
			panX: 40,
			panY: 0,
			scale: 1,
			orientation: cam.orientation,
			edge: cam.edge,
		});
		setCamera({ ...cameraRef.current });
	}, []);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Home") resetCamera();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [resetCamera]);

	const animFrameRef = useRef(0);
	const navigateToWorld = useCallback((worldX: number, worldY: number) => {
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
		const target: Camera = clampCamera({
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
			const cam = clampCamera({
				...start,
				panX: start.panX + (target.panX - start.panX) * e,
				panY: start.panY + (target.panY - start.panY) * e,
				scale: start.scale + (target.scale - start.scale) * e,
			});
			cameraRef.current = cam;
			setCamera({ ...cam });
			if (t < 1) {
				animFrameRef.current = requestAnimationFrame(step);
			}
		};

		cancelAnimationFrame(animFrameRef.current);
		animFrameRef.current = requestAnimationFrame(step);
	}, []);

	const handleForkFromCommit = useCallback(
		async (commitSha: string) => {
			try {
				await api.rulerFork(projectId, { startCommitSha: commitSha });
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
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
	const containerCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			wheelCleanupRef.current?.();
			wheelCleanupRef.current = null;
			containerRef.current = el;
			if (!el) return;

			const onWheel = (e: WheelEvent) => {
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
					// Offset for the ruler track
					const canvasMouseMain = isH ? mouseX : mouseY;
					const canvasMouseCross = isH
						? mouseY - (cam.edge === "start" ? RULER_THICKNESS : 0)
						: mouseX - (cam.edge === "start" ? RULER_THICKNESS : 0);
					const newScale = Math.max(0.1, Math.min(5, cam.scale * factor));
					const mainPan = isH ? cam.panX : cam.panY;
					const crossPan = isH ? cam.panY : cam.panX;
					const worldMain = (canvasMouseMain - mainPan) / cam.scale;
					const worldCross = (canvasMouseCross - crossPan) / cam.scale;
					const newMainPan = canvasMouseMain - worldMain * newScale;
					const newCrossPan = canvasMouseCross - worldCross * newScale;
					cameraRef.current = clampCamera({
						...cam,
						panX: isH ? newMainPan : newCrossPan,
						panY: isH ? newCrossPan : newMainPan,
						scale: newScale,
					});
				} else {
					cameraRef.current = clampCamera({
						...cam,
						panX: cam.panX - e.deltaX,
						panY: cam.panY - e.deltaY,
					});
				}
				// If panning is active, rebase the drag origin so the ongoing drag
				// doesn't overwrite the pan offset that zoom/scroll just applied.
				if (isPanningRef.current) {
					const newCam = cameraRef.current;
					panStartRef.current.camX += newCam.panX - oldPanX;
					panStartRef.current.camY += newCam.panY - oldPanY;
				}
				scheduleRender();
			};

			el.addEventListener("wheel", onWheel, { passive: false });
			wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
		},
		[scheduleRender],
	);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button === 1 || (e.button === 0 && e.currentTarget === e.target)) {
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
			cameraRef.current = clampCamera({
				...cameraRef.current,
				panX: panStartRef.current.camX + (e.clientX - panStartRef.current.x),
				panY: panStartRef.current.camY + (e.clientY - panStartRef.current.y),
			});
			scheduleRender();
		},
		[scheduleRender],
	);

	const handlePointerUp = useCallback(() => {
		isPanningRef.current = false;
	}, []);

	const toggleSegment = useCallback((fromSha: string) => {
		setExpandedSegments((prev) => {
			const next = new Set(prev);
			if (next.has(fromSha)) next.delete(fromSha);
			else next.add(fromSha);
			return next;
		});
	}, []);

	const toggleOrientation = useCallback(() => {
		const cam = cameraRef.current;
		const next = clampCamera({
			...cam,
			orientation: cam.orientation === "horizontal" ? "vertical" : "horizontal",
			panX: 40,
			panY: 0,
		});
		cameraRef.current = next;
		setCamera({ ...next });
	}, []);

	const toggleEdge = useCallback(() => {
		const cam = cameraRef.current;
		const next = clampCamera({ ...cam, edge: cam.edge === "start" ? "end" : "start" });
		cameraRef.current = next;
		setCamera({ ...next });
	}, []);

	// --- Layout computation ---
	const rulerData = (data as RulerData) ?? { commits: [], segments: [], activeChapters: [] };
	const commits = rulerData.commits ?? [];
	const segments = rulerData.segments ?? [];

	const commitShas = useMemo(() => commits.map((c) => c.sha), [commits]);
	const layout = useMemo(
		() => computeElasticLayout(commitShas, segments, expandedSegments),
		[commitShas, segments, expandedSegments],
	);

	// --- Derived values ---
	const { panX, panY, scale, orientation, edge } = camera;
	const isHorizontal = orientation === "horizontal";
	const containerWidth = containerRef.current?.clientWidth ?? 1200;
	const containerHeight = containerRef.current?.clientHeight ?? 800;
	// The "main axis" viewport size (along the ruler) and "cross axis" size
	const mainViewport = isHorizontal ? containerWidth : containerHeight;
	const crossViewport = isHorizontal
		? containerHeight - RULER_THICKNESS
		: containerWidth - RULER_THICKNESS;
	// Pan along the main axis
	const mainPan = isHorizontal ? panX : panY;
	const crossPan = isHorizontal ? panY : panX;

	// Pre-compute visible ticks to avoid per-tick work in render
	const { visibleTicks, expandedTicks } = useMemo(() => {
		const visStart = -mainPan / scale - VIEWPORT_BUFFER / scale;
		const visEnd = (-mainPan + mainViewport) / scale + VIEWPORT_BUFFER / scale;
		const visible: typeof layout.ticks = [];
		const expanded: typeof layout.ticks = [];
		for (const tick of layout.ticks) {
			if (tick.x >= visStart && tick.x <= visEnd) visible.push(tick);
			if (tick.isExpanded && tick.segment) expanded.push(tick);
		}
		return { visibleTicks: visible, expandedTicks: expanded };
	}, [layout.ticks, mainPan, scale, mainViewport]);

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

	const totalMainSize = layout.totalWidth * scale;

	// --- Ruler track positioning ---
	const rulerTrackStyle: React.CSSProperties = {
		position: "absolute",
		background: "var(--mantine-color-dark-6)",
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
		background: "var(--mantine-color-dark-8)",
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
	const tickStripStyle: React.CSSProperties = {
		position: "absolute",
		top: 0,
		left: 0,
	};
	if (isHorizontal) {
		Object.assign(tickStripStyle, {
			width: totalMainSize,
			height: "100%",
			transform: `translateX(${panX}px)`,
		});
	} else {
		Object.assign(tickStripStyle, {
			width: "100%",
			height: totalMainSize,
			transform: `translateY(${panY}px)`,
		});
	}

	// --- World transform for the 2D canvas ---
	const worldTransform = isHorizontal
		? `translate(${panX}px, ${panY}px) scale(${scale})`
		: `translate(${panX}px, ${panY}px) scale(${scale})`;

	return (
		<Box
			ref={containerCallbackRef}
			style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
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
				<Box style={tickStripStyle}>
					{visibleTicks.map((tick) => (
						<RulerTick
							key={tick.sha}
							tick={tick}
							commit={commits[tick.index]}
							scale={scale}
							orientation={orientation}
							onToggle={toggleSegment}
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
					{expandedTicks.map((tick) => {
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
			{expandedTicks.map((tick) => {
				const seg = tick.segment;
				if (!seg) return null;
				const screenMain = tick.x * scale + mainPan;
				const nextTick = layout.ticks[tick.index + 1];
				const segScreenSize = (nextTick ? nextTick.x - tick.x : 400) * scale;
				const headerStyle: React.CSSProperties = {
					position: "absolute",
					zIndex: 5,
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
	scale: number;
	orientation: RulerOrientation;
	onToggle: (sha: string) => void;
	onContextMenu: (x: number, y: number) => void;
}

const RulerTick = memo(function RulerTick({
	tick,
	commit,
	scale,
	orientation,
	onToggle,
	onContextMenu,
}: RulerTickProps) {
	const segment = tick.segment;
	const hasActive = segment && segment.activeChapterCount > 0;
	const isExpandable = segment?.isExpandable;
	const pos = tick.x * scale;
	const isH = orientation === "horizontal";

	return (
		<Box
			style={{
				position: "absolute",
				...(isH ? { left: pos, top: 0, height: "100%" } : { top: pos, left: 0, width: "100%" }),
				display: "flex",
				flexDirection: isH ? "column" : "row",
				alignItems: "center",
				cursor: isExpandable ? "pointer" : "default",
			}}
			onClick={isExpandable ? () => onToggle(tick.sha) : undefined}
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
					background: hasActive ? "var(--mantine-color-indigo-5)" : "var(--mantine-color-dark-1)",
					borderRadius: 1,
				}}
			/>
			{scale > 0.4 && (
				<Text
					size="9px"
					c={hasActive ? "indigo.4" : "dimmed"}
					style={{
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
						maxWidth: isH ? 76 : undefined,
						maxHeight: isH ? undefined : 76,
						textAlign: "center",
						lineHeight: 1.2,
						...(isH
							? { marginTop: 2 }
							: { marginLeft: 2, writingMode: "vertical-rl", transform: "rotate(180deg)" }),
					}}
				>
					{commit?.shortSha}
				</Text>
			)}
			{isExpandable && (
				<Box
					style={{
						width: tick.isExpanded ? 10 : 6,
						height: tick.isExpanded ? 10 : 6,
						borderRadius: "50%",
						background: tick.isExpanded
							? "var(--mantine-color-indigo-4)"
							: hasActive
								? "var(--mantine-color-indigo-5)"
								: "var(--mantine-color-dark-3)",
						...(isH ? { marginTop: 2 } : { marginLeft: 2 }),
						border: tick.isExpanded ? "2px solid var(--mantine-color-indigo-3)" : "none",
						transition: "all 150ms ease",
					}}
				/>
			)}
		</Box>
	);
});
