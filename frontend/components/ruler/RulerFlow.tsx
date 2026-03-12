import { ActionIcon, Badge, Box, Center, Group, Loader, Stack, Text, Tooltip } from "@mantine/core";
import { IconHome } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type RulerData, useRulerData } from "../../hooks/useRuler";
import { useUserPreferences } from "../../hooks/useUserPreferences";
import { api } from "../../lib/api";
import { computeElasticLayout, type TickPosition } from "./elastic-layout";
import { OffscreenBubbles } from "./OffscreenBubbles";
import { TickContextMenu } from "./RulerContextMenus";
import { SegmentCanvas } from "./SegmentCanvas";

interface RulerFlowProps {
	projectId: string;
	focusChapterId?: string | null;
}

const RULER_HEIGHT = 48;
const TICK_WIDTH = 2;
const VIEWPORT_BUFFER = 200;

interface Camera {
	panX: number;
	panY: number;
	scale: number;
}

export function RulerFlow({ projectId }: RulerFlowProps) {
	const { t } = useTranslation("graph");
	const { data, isLoading, error } = useRulerData(projectId);
	const { data: prefs } = useUserPreferences();

	// --- Camera state: ref is source of truth, state drives render via rAF ---
	const savedCamera = useMemo<Camera>(() => {
		try {
			const raw = (prefs as Record<string, unknown> | undefined)?.graphViewports;
			let viewports: Record<string, { x: number; y: number; zoom: number }> = {};
			if (typeof raw === "string") viewports = JSON.parse(raw);
			else if (raw && typeof raw === "object") viewports = raw as typeof viewports;
			const v = viewports[projectId];
			if (v) return { panX: v.x, panY: v.y, scale: v.zoom };
		} catch {
			/* corrupted */
		}
		return { panX: 40, panY: 0, scale: 1 };
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

	useEffect(() => {
		if (!tickMenu) return;
		const handler = () => setTickMenu(null);
		window.addEventListener("click", handler);
		return () => window.removeEventListener("click", handler);
	}, [tickMenu]);

	// --- Actions ---
	const resetCamera = useCallback(() => {
		cameraRef.current = { panX: 40, panY: 0, scale: 1 };
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
		const vh = (el?.clientHeight ?? 800) - RULER_HEIGHT;
		const s = cameraRef.current.scale;
		const target: Camera = {
			panX: vw / 2 - worldX * s,
			panY: vh / 2 - worldY * s,
			scale: s,
		};

		// Animate over ~300ms
		const start = cameraRef.current;
		const duration = 300;
		const t0 = performance.now();

		const step = (now: number) => {
			const elapsed = now - t0;
			const t = Math.min(1, elapsed / duration);
			// ease-out cubic
			const e = 1 - (1 - t) ** 3;
			const cam: Camera = {
				panX: start.panX + (target.panX - start.panX) * e,
				panY: start.panY + (target.panY - start.panY) * e,
				scale: start.scale + (target.scale - start.scale) * e,
			};
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

	// --- Input handlers ---
	const containerCallbackRef = useCallback(
		(el: HTMLDivElement | null) => {
			wheelCleanupRef.current?.();
			wheelCleanupRef.current = null;
			containerRef.current = el;
			if (!el) return;

			const onWheel = (e: WheelEvent) => {
				const cam = cameraRef.current;
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault();
					const factor = e.deltaY > 0 ? 0.9 : 1.1;
					const rect = el.getBoundingClientRect();
					const mouseX = e.clientX - rect.left;
					const mouseY = e.clientY - rect.top - RULER_HEIGHT;
					const newScale = Math.max(0.1, Math.min(5, cam.scale * factor));
					const worldX = (mouseX - cam.panX) / cam.scale;
					const worldY = (mouseY - cam.panY) / cam.scale;
					cameraRef.current = {
						panX: mouseX - worldX * newScale,
						panY: mouseY - worldY * newScale,
						scale: newScale,
					};
				} else {
					cameraRef.current = {
						...cam,
						panX: cam.panX - e.deltaX,
						panY: cam.panY - e.deltaY,
					};
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
			cameraRef.current = {
				...cameraRef.current,
				panX: panStartRef.current.camX + (e.clientX - panStartRef.current.x),
				panY: panStartRef.current.camY + (e.clientY - panStartRef.current.y),
			};
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
	const { panX, panY, scale } = camera;
	const containerWidth = containerRef.current?.clientWidth ?? 1200;
	const containerHeight = (containerRef.current?.clientHeight ?? 800) - RULER_HEIGHT;

	// Pre-compute visible ticks to avoid per-tick work in render
	const { visibleTicks, expandedTicks } = useMemo(() => {
		const visStart = -panX / scale - VIEWPORT_BUFFER / scale;
		const visEnd = (-panX + containerWidth) / scale + VIEWPORT_BUFFER / scale;
		const visible: typeof layout.ticks = [];
		const expanded: typeof layout.ticks = [];
		for (const tick of layout.ticks) {
			if (tick.x >= visStart && tick.x <= visEnd) visible.push(tick);
			if (tick.isExpanded && tick.segment) expanded.push(tick);
		}
		return { visibleTicks: visible, expandedTicks: expanded };
	}, [layout.ticks, panX, scale, containerWidth]);

	const worldViewTop = -panY / scale;
	const worldViewHeight = containerHeight / scale;

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

	const totalWidth = layout.totalWidth * scale;

	return (
		<Box
			ref={containerCallbackRef}
			style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
		>
			{/* Ruler track */}
			<Box
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					right: 0,
					height: RULER_HEIGHT,
					background: "var(--mantine-color-dark-6)",
					borderBottom: "2px solid var(--mantine-color-indigo-7)",
					zIndex: 10,
					overflow: "hidden",
				}}
			>
				<Text size="xs" c="dimmed" style={{ position: "absolute", right: 8, top: 4, zIndex: 20 }}>
					{t("ruler.commitCount", { count: commits.length })}
				</Text>
				<Box
					style={{
						position: "absolute",
						top: 0,
						left: 0,
						width: totalWidth,
						height: "100%",
						transform: `translateX(${panX}px)`,
					}}
				>
					{visibleTicks.map((tick) => (
						<RulerTick
							key={tick.sha}
							tick={tick}
							commit={commits[tick.index]}
							scale={scale}
							onToggle={toggleSegment}
							onContextMenu={(x, y) =>
								setTickMenu({
									x,
									y,
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
				style={{
					position: "absolute",
					top: RULER_HEIGHT,
					left: 0,
					right: 0,
					bottom: 0,
					background: "var(--mantine-color-dark-8)",
					overflow: "hidden",
				}}
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
						transform: `translate(${panX}px, ${panY}px) scale(${scale})`,
					}}
				>
					{expandedTicks.map((tick) => {
						const seg = tick.segment;
						if (!seg) return null;
						const nextTick = layout.ticks[tick.index + 1];
						const segWidth = nextTick ? nextTick.x - tick.x : 400;
						return (
							<SegmentCanvas
								key={`seg-${tick.sha}`}
								projectId={projectId}
								fromSha={tick.sha}
								toSha={seg.toSha}
								x={tick.x}
								width={segWidth}
								segment={seg}
								scale={scale}
								viewTop={worldViewTop}
								viewHeight={worldViewHeight}
								cardRegistry={cardRegistryRef}
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

			{/* Segment headers — fixed at top of canvas, only X follows camera */}
			{expandedTicks.map((tick) => {
				const seg = tick.segment;
				if (!seg) return null;
				const screenX = tick.x * scale + panX;
				const nextTick = layout.ticks[tick.index + 1];
				const segScreenWidth = (nextTick ? nextTick.x - tick.x : 400) * scale;
				return (
					<Group
						key={`seg-hdr-${tick.sha}`}
						gap={4}
						px={8}
						py={4}
						style={{
							position: "absolute",
							top: RULER_HEIGHT + 2,
							left: screenX,
							width: segScreenWidth,
							zIndex: 5,
							pointerEvents: "none",
						}}
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
				rulerHeight={RULER_HEIGHT}
				onNavigate={navigateToWorld}
			/>

			<Tooltip label={t("ruler.resetView")}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					style={{ position: "absolute", bottom: 12, right: 12, zIndex: 20 }}
					onClick={resetCamera}
				>
					<IconHome size={16} />
				</ActionIcon>
			</Tooltip>

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
		</Box>
	);
}

// --- Memoized tick component to avoid re-rendering all ticks on camera change ---
interface RulerTickProps {
	tick: TickPosition;
	commit: { shortSha: string; message: string } | undefined;
	scale: number;
	onToggle: (sha: string) => void;
	onContextMenu: (x: number, y: number) => void;
}

const RulerTick = memo(function RulerTick({
	tick,
	commit,
	scale,
	onToggle,
	onContextMenu,
}: RulerTickProps) {
	const segment = tick.segment;
	const hasActive = segment && segment.activeChapterCount > 0;
	const isExpandable = segment?.isExpandable;
	const x = tick.x * scale;

	return (
		<Box
			style={{
				position: "absolute",
				left: x,
				top: 0,
				height: "100%",
				display: "flex",
				flexDirection: "column",
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
					width: TICK_WIDTH,
					height: hasActive ? 20 : 14,
					background: hasActive ? "var(--mantine-color-indigo-5)" : "var(--mantine-color-dark-1)",
					marginTop: 4,
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
						maxWidth: 76,
						textAlign: "center",
						lineHeight: 1.2,
						marginTop: 2,
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
						marginTop: 2,
						border: tick.isExpanded ? "2px solid var(--mantine-color-indigo-3)" : "none",
						transition: "all 150ms ease",
					}}
				/>
			)}
		</Box>
	);
});
