import { Box, Card, Text } from "@mantine/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { NarratorPanel } from "../narrator/NarratorPanel";
import { localScale } from "./fisheye";
import type { RulerOrientation } from "./types";
import { getCardModeForChapter } from "./zoom-tiers";

/** Active segments refresh faster; historical ones can be stale longer. */
function getSegmentStaleTime(segment: RulerSegment): number {
	if (segment.activeChapterCount > 0) return 15_000; // 15s for active
	return 5 * 60 * 1000; // 5min for historical
}

interface SegmentChapter {
	id: string;
	title: string;
	status: string;
	branch: string;
	role: string;
	narratorId: string | null;
	narratorStatus: string | null;
	reviewStatus: string | null;
	startCommitSha: string | null;
	mergeCommitSha: string | null;
	anchorCommitSha: string | null;
	axisOffset: number;
	crossOffset: number;
	panelWidth: number | null;
	panelHeight: number | null;
}

interface SegmentData {
	chapters: SegmentChapter[];
	edges: Array<{ id: string; sourceId: string; targetId: string; type: string }>;
}

export interface CardWorldInfo {
	id: string;
	title: string;
	worldX: number;
	worldY: number;
	worldW: number;
	worldH: number;
	status: string;
	narratorStatus: string | null;
}

export interface ChapterContextMenuState {
	x: number;
	y: number;
	chapter: SegmentChapter;
	fromSha: string;
}

interface SegmentCanvasProps {
	projectId: string;
	fromSha: string;
	toSha: string;
	/** Position along the main axis (world coords) */
	mainPos: number;
	/** Size along the main axis (world coords) */
	mainSize: number;
	segment: RulerSegment;
	/** Current camera scale — used for inverse-scaling interactive elements */
	scale?: number;
	orientation?: RulerOrientation;
	/** World-space cross-axis offset of the viewport top/left edge */
	viewTop?: number;
	/** World-space cross-axis size of the viewport */
	viewHeight?: number;
	/** Shared mutable map for registering card world positions (no re-render) */
	cardRegistry?: React.MutableRefObject<Map<string, CardWorldInfo[]>>;
	/** Callback to open chapter context menu at screen coordinates (lifted out of transform) */
	onChapterContextMenu?: (state: ChapterContextMenuState) => void;
	/** Request the parent to fit a world-space rect into the viewport */
	onFitToView?: (worldX: number, worldY: number, worldW: number, worldH: number) => void;
	/** World-space X of the zoom center (for morph proximity) */
	zoomCenterWorldX?: number;
	/** Screen-space size of the viewport along the main axis (for fisheye) */
	viewportSize?: number;
	/** Screen-space main-axis position of this segment (fisheye-mapped) */
	screenMainPos?: number;
	/** Screen-space main-axis size of this segment (fisheye-mapped) */
	screenMainSize?: number;
	/** Screen-space cross-axis offset (crossPan + rulerThickness) */
	screenCrossOffset?: number;
	/** Callback when chapters are loaded for a segment */
	onChaptersLoaded?: (
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
	) => void;
	/** Lightweight callback during card drag — updates PixiJS without React re-render */
	onChapterDragMove?: (
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
	) => void;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const DEFAULT_PANEL_WIDTH = 420;
const DEFAULT_PANEL_HEIGHT = 520;
const MIN_PANEL_WIDTH = 300;
const MIN_PANEL_HEIGHT = 200;
const CARD_TOP_OFFSET = 30;

export const SegmentCanvas = memo(
	function SegmentCanvas({
		projectId,
		fromSha,
		toSha,
		mainPos,
		mainSize,
		segment: _segment,
		scale = 1,
		orientation = "horizontal",
		onFitToView,
		zoomCenterWorldX = 0,
		viewportSize = 1200,
		screenMainPos,
		screenCrossOffset = 0,
		onChaptersLoaded,
		onChapterDragMove: _onChapterDragMove,
	}: SegmentCanvasProps) {
		const queryClient = useQueryClient();
		const isH = orientation === "horizontal";

		// Determine data detail level based on segment center's card mode
		const segCenterWorld = mainPos + mainSize / 2;
		const segEffectiveScale = localScale(segCenterWorld, zoomCenterWorldX, viewportSize, scale);
		const segCardMode = getCardModeForChapter(segEffectiveScale);
		const needsFull = segCardMode === "full";

		const { data, isLoading } = useQuery({
			queryKey: ["rulerSegment", projectId, fromSha, needsFull ? "full" : "summary"],
			queryFn: () =>
				api.getRulerSegment(
					projectId,
					fromSha,
					toSha,
					needsFull ? "full" : "summary",
				) as Promise<SegmentData>,
			staleTime: getSegmentStaleTime(_segment),
			placeholderData: _segment.activeChapterCount === 0 ? keepPreviousData : undefined,
		});

		const [openNarratorIds, setOpenNarratorIds] = useState<Set<string>>(new Set());
		const prevOpenNarratorIdsRef = useRef<Set<string>>(new Set());

		const chapters = data?.chapters ?? [];

		const laid = useMemo(() => {
			const padding = 20;
			const gap = 16;
			if (isH) {
				// Horizontal: mainSize is X-axis, tile cards along X
				const cols = Math.max(1, Math.floor((mainSize - padding * 2) / (NODE_WIDTH + gap)));
				return chapters.map((ch, i) => {
					if (ch.axisOffset !== 0 || ch.crossOffset !== 0)
						return { ...ch, layoutX: ch.axisOffset, layoutY: ch.crossOffset };
					const col = i % cols;
					const row = Math.floor(i / cols);
					return {
						...ch,
						layoutX: padding + col * (NODE_WIDTH + gap),
						layoutY: padding + row * (NODE_HEIGHT + gap),
					};
				});
			}
			// Vertical: mainSize is Y-axis, tile cards along Y
			const rows = Math.max(1, Math.floor((mainSize - padding * 2) / (NODE_HEIGHT + gap)));
			return chapters.map((ch, i) => {
				if (ch.axisOffset !== 0 || ch.crossOffset !== 0)
					return { ...ch, layoutX: ch.axisOffset, layoutY: ch.crossOffset };
				const row = i % rows;
				const col = Math.floor(i / rows);
				return {
					...ch,
					layoutX: padding + col * (NODE_WIDTH + gap),
					layoutY: padding + row * (NODE_HEIGHT + gap),
				};
			});
		}, [chapters, mainSize, isH]);

		// Report chapter data to parent for PixiJS rendering
		useEffect(() => {
			if (onChaptersLoaded && laid.length > 0) {
				onChaptersLoaded(
					fromSha,
					laid.map((ch) => ({
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
					})),
				);
			}
		}, [laid, fromSha, onChaptersLoaded]);

		// Clear PixiJS data only on full unmount.
		// Intentionally omits onChaptersLoaded from deps — parent must provide a stable
		// (useCallback) reference so this cleanup fires only on unmount, not on re-render.
		// biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup; parent guarantees stable callback ref
		useEffect(() => {
			return () => {
				onChaptersLoaded?.(fromSha, []);
			};
		}, [fromSha]);

		// When a narrator panel opens, request the parent to fit the expanded card into view
		useEffect(() => {
			const prev = prevOpenNarratorIdsRef.current;
			prevOpenNarratorIdsRef.current = openNarratorIds;
			if (!onFitToView) return;
			// Find newly added narrator IDs
			for (const id of openNarratorIds) {
				if (!prev.has(id)) {
					const ch = laid.find((c) => c.narratorId === id);
					if (!ch) continue;
					const panelW = ch.panelWidth ?? DEFAULT_PANEL_WIDTH;
					const panelH = ch.panelHeight ?? DEFAULT_PANEL_HEIGHT;
					const worldX = (isH ? mainPos : 0) + ch.layoutX;
					const worldY = (isH ? 0 : mainPos) + ch.layoutY + CARD_TOP_OFFSET;
					onFitToView(worldX, worldY, panelW, panelH);
					break; // fit the first newly opened one
				}
			}
		}, [openNarratorIds, laid, mainPos, isH, onFitToView]);

		// PixiJS handles all card/morph rendering.
		// React only renders open narrator panels.
		const hasOpenPanel = laid.some((ch) => ch.narratorId && openNarratorIds.has(ch.narratorId));

		if (!hasOpenPanel && !isLoading) {
			// Nothing to render in React — PixiJS handles everything
			return null;
		}

		return (
			<>
				{laid.map((ch) => {
					if (!ch.narratorId || !openNarratorIds.has(ch.narratorId)) return null;

					const panelW = ch.panelWidth ?? DEFAULT_PANEL_WIDTH;
					const panelH = ch.panelHeight ?? DEFAULT_PANEL_HEIGHT;

					// Position panel in screen coordinates
					const panelScreenX = screenMainPos != null ? screenMainPos + ch.layoutX : ch.layoutX;
					const panelScreenY = (ch.layoutY + CARD_TOP_OFFSET) * scale + screenCrossOffset;

					return (
						<NarratorPanelOverlay
							key={ch.id}
							chapter={ch}
							narratorId={ch.narratorId}
							screenX={panelScreenX}
							screenY={panelScreenY}
							width={panelW}
							height={panelH}
							scale={scale}
							onClose={() => {
								setOpenNarratorIds((prev) => {
									const next = new Set(prev);
									// biome-ignore lint/style/noNonNullAssertion: checked above
									next.delete(ch.narratorId!);
									return next;
								});
							}}
							onResizeEnd={(newW, newH, dx, dy) => {
								const newAxisOffset = ch.layoutX + dx;
								const newCrossOffset = Math.max(0, ch.layoutY + dy);
								const qk = ["rulerSegment", projectId, fromSha, needsFull ? "full" : "summary"];
								queryClient.setQueryData<SegmentData>(qk, (old) => {
									if (!old) return old;
									return {
										...old,
										chapters: old.chapters.map((c) =>
											c.id === ch.id
												? {
														...c,
														axisOffset: newAxisOffset,
														crossOffset: newCrossOffset,
														panelWidth: newW,
														panelHeight: newH,
													}
												: c,
										),
									};
								});
								api.updateRulerPositions(projectId, [
									{
										chapterId: ch.id,
										anchorCommitSha: ch.anchorCommitSha ?? fromSha,
										axisOffset: newAxisOffset,
										crossOffset: newCrossOffset,
										width: newW,
										height: newH,
									},
								]);
							}}
						/>
					);
				})}
			</>
		);
	},
	(prev, next) => {
		// Skip re-render when only camera-driven cosmetic props change (scale).
		// viewTop/viewHeight are NOT skipped because they drive cross-axis card culling.
		if (prev.projectId !== next.projectId) return false;
		if (prev.fromSha !== next.fromSha) return false;
		if (prev.toSha !== next.toSha) return false;
		if (prev.mainPos !== next.mainPos) return false;
		if (prev.mainSize !== next.mainSize) return false;
		if (prev.segment !== next.segment) return false;
		if (prev.orientation !== next.orientation) return false;
		if (prev.onFitToView !== next.onFitToView) return false;
		if (prev.scale !== next.scale) return false;
		if (prev.zoomCenterWorldX !== next.zoomCenterWorldX) return false;
		if (prev.viewportSize !== next.viewportSize) return false;
		if (prev.screenMainPos !== next.screenMainPos) return false;
		if (prev.screenCrossOffset !== next.screenCrossOffset) return false;
		if (prev.onChaptersLoaded !== next.onChaptersLoaded) return false;
		if (prev.onChapterDragMove !== next.onChapterDragMove) return false;
		return true;
	},
);

/** Floating narrator panel overlay — rendered when user clicks a card in PixiJS */
function NarratorPanelOverlay({
	chapter,
	narratorId,
	screenX,
	screenY,
	width: panelW,
	height: panelH,
	scale,
	onClose,
	onResizeEnd,
}: {
	chapter: { id: string; title: string };
	narratorId: string;
	screenX: number;
	screenY: number;
	width: number;
	height: number;
	scale: number;
	onClose: () => void;
	onResizeEnd: (newW: number, newH: number, dx: number, dy: number) => void;
}) {
	const isResizingRef = useRef(false);
	const resizeStartRef = useRef({ x: 0, y: 0, origW: 0, origH: 0, corner: "" });
	const [resizeDelta, setResizeDelta] = useState({ dw: 0, dh: 0, dx: 0, dy: 0 });
	const resizeDeltaRef = useRef(resizeDelta);
	resizeDeltaRef.current = resizeDelta;
	const panelWheelRef = useRef<HTMLDivElement>(null);

	const isCurrentlyResizing = isResizingRef.current || resizeDelta.dw !== 0 || resizeDelta.dh !== 0;

	// Prevent wheel events inside the panel from bubbling
	useEffect(() => {
		const el = panelWheelRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) e.preventDefault();
		};
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	});

	// Global pointer handlers for resize
	useEffect(() => {
		const handleMove = (e: PointerEvent) => {
			if (!isResizingRef.current) return;
			const rawDx = (e.clientX - resizeStartRef.current.x) / scale;
			const rawDy = (e.clientY - resizeStartRef.current.y) / scale;
			const corner = resizeStartRef.current.corner;
			let dw = 0;
			let dh = 0;
			let dx = 0;
			let dy = 0;
			if (corner.includes("r")) dw = rawDx;
			if (corner.includes("l")) {
				dw = -rawDx;
				dx = rawDx;
			}
			if (corner.includes("b")) dh = rawDy;
			if (corner.includes("t")) {
				dh = -rawDy;
				dy = rawDy;
			}
			const clampedW = Math.max(MIN_PANEL_WIDTH, resizeStartRef.current.origW + dw);
			const clampedH = Math.max(MIN_PANEL_HEIGHT, resizeStartRef.current.origH + dh);
			const actualDw = clampedW - resizeStartRef.current.origW;
			const actualDh = clampedH - resizeStartRef.current.origH;
			if (corner.includes("l")) dx = -actualDw;
			if (corner.includes("t")) dy = -actualDh;
			setResizeDelta({ dw: actualDw, dh: actualDh, dx, dy });
		};
		const handleUp = () => {
			if (!isResizingRef.current) return;
			isResizingRef.current = false;
			const d = resizeDeltaRef.current;
			const newW = Math.max(MIN_PANEL_WIDTH, resizeStartRef.current.origW + d.dw);
			const newH = Math.max(MIN_PANEL_HEIGHT, resizeStartRef.current.origH + d.dh);
			onResizeEnd(newW, newH, d.dx, d.dy);
		};
		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp);
		return () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
		};
	}, [scale, onResizeEnd]);

	const displayW = Math.max(MIN_PANEL_WIDTH, panelW + resizeDelta.dw);
	const displayH = Math.max(MIN_PANEL_HEIGHT, panelH + resizeDelta.dh);

	const startResize = (e: React.PointerEvent, corner: string) => {
		e.preventDefault();
		e.stopPropagation();
		isResizingRef.current = true;
		resizeStartRef.current = { x: e.clientX, y: e.clientY, origW: panelW, origH: panelH, corner };
	};

	return (
		<Card
			shadow="sm"
			padding={6}
			radius="sm"
			withBorder
			style={{
				position: "absolute",
				left: screenX + resizeDelta.dx,
				top: screenY + resizeDelta.dy,
				width: displayW,
				height: displayH,
				borderColor: "var(--mantine-color-indigo-3)",
				borderWidth: 2,
				borderStyle: "solid",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				transition: isResizingRef.current ? "none" : "width 200ms ease, height 200ms ease",
				userSelect: "none",
				zIndex: 10,
				pointerEvents: "auto",
			}}
		>
			{/* Resize handles */}
			{(["tl", "tr", "bl", "br"] as const).map((corner) => (
				<Box
					key={corner}
					style={{
						position: "absolute",
						width: corner === "br" ? 20 : 14,
						height: corner === "br" ? 20 : 14,
						zIndex: 10,
						...(corner === "tl" ? { top: -2, left: -2, cursor: "nwse-resize" } : {}),
						...(corner === "tr" ? { top: -2, right: -2, cursor: "nesw-resize" } : {}),
						...(corner === "bl" ? { bottom: -2, left: -2, cursor: "nesw-resize" } : {}),
						...(corner === "br"
							? { bottom: 0, right: 0, cursor: "nwse-resize", overflow: "hidden" }
							: {}),
					}}
					onPointerDown={(e) => startResize(e, corner)}
				>
					{corner === "br" && (
						<Box
							style={{
								position: "absolute",
								bottom: 0,
								right: 0,
								width: 0,
								height: 0,
								borderStyle: "solid",
								borderWidth: "0 0 12px 12px",
								borderColor: "transparent transparent var(--mantine-color-indigo-5) transparent",
								opacity: 0.6,
							}}
						/>
					)}
				</Box>
			))}

			{/* Header */}
			<Box style={{ cursor: "pointer" }} onClick={onClose}>
				<Text size="11px" fw={600} truncate>
					{chapter.title}
				</Text>
			</Box>

			{/* Narrator panel */}
			<Box
				ref={panelWheelRef}
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				style={{
					flex: 1,
					minHeight: 0,
					overflow: "hidden",
					borderTop:
						"1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
					marginTop: 6,
					position: "relative",
				}}
			>
				<Box style={{ height: "100%", visibility: isCurrentlyResizing ? "hidden" : "visible" }}>
					<StableNarratorPanel narratorId={narratorId} />
				</Box>
				{isCurrentlyResizing && (
					<Box
						style={{
							position: "absolute",
							inset: 0,
							backgroundColor: "var(--mantine-color-body)",
							opacity: 0.7,
						}}
					/>
				)}
			</Box>
		</Card>
	);
}

/** Memoized wrapper — prevents NarratorPanel from re-rendering during resize drags */
const StableNarratorPanel = memo(function StableNarratorPanel({
	narratorId,
}: {
	narratorId: string;
}) {
	return <NarratorPanel narratorId={narratorId} compact />;
});
