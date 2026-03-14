import { Badge, Box, Card, Group, Loader, Text } from "@mantine/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";
import { getSubRulerRenderMode } from "./focus-stack";
import { SubRuler } from "./SubRuler";
import type { RulerOrientation } from "./types";
import type { ZoomTierId } from "./zoom-tiers";

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
	/** Map of commit SHA → main-axis world position, for drawing connector lines */
	tickPositions?: Map<string, number>;
	/** Request the parent to fit a world-space rect into the viewport */
	onFitToView?: (worldX: number, worldY: number, worldW: number, worldH: number) => void;
	/** Current zoom tier — controls card interactivity and connector visibility */
	zoomTier?: ZoomTierId;
	/** Current focus depth for sub-ruler render mode calculation */
	focusDepth?: number;
	/** Performance degradation level (0=normal, 1=reduced, 2=minimal) */
	degradeLevel?: number;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const DEFAULT_PANEL_WIDTH = 420;
const DEFAULT_PANEL_HEIGHT = 520;
const MIN_PANEL_WIDTH = 300;
const MIN_PANEL_HEIGHT = 200;
/** Cards (collapsed) are rendered within 3× the cross-axis viewport */
const CARD_CROSS_MULTIPLIER = 3;
/** Expanded narrator panels are rendered within 1.5× the cross-axis viewport */
const PANEL_CROSS_MULTIPLIER = 1.5;

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
		viewTop = 0,
		viewHeight = 800,
		cardRegistry,
		onChapterContextMenu,
		tickPositions,
		onFitToView,
		zoomTier = "L2",
		focusDepth = 0,
		degradeLevel = 0,
	}: SegmentCanvasProps) {
		const queryClient = useQueryClient();
		const isH = orientation === "horizontal";
		const { data, isLoading } = useQuery({
			queryKey: ["rulerSegment", projectId, fromSha],
			queryFn: () => api.getRulerSegment(projectId, fromSha, toSha) as Promise<SegmentData>,
			staleTime: getSegmentStaleTime(_segment),
			placeholderData: _segment.activeChapterCount === 0 ? keepPreviousData : undefined,
		});

		const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());
		const [openNarratorId, setOpenNarratorId] = useState<string | null>(null);
		const prevOpenNarratorIdRef = useRef<string | null>(null);

		const toggleChapterExpand = useCallback((chId: string) => {
			setExpandedChapters((prev) => {
				const next = new Set(prev);
				if (next.has(chId)) next.delete(chId);
				else next.add(chId);
				return next;
			});
		}, []);

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

		// Write card world positions to shared registry (no re-render)
		const cardInfos = useMemo(
			() =>
				laid.map((ch) => {
					const isPanelOpen = openNarratorId === ch.narratorId && !!ch.narratorId;
					return {
						id: ch.id,
						title: ch.title,
						worldX: (isH ? mainPos : 0) + ch.layoutX,
						worldY: (isH ? 0 : mainPos) + ch.layoutY + 30,
						worldW: isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : NODE_WIDTH,
						worldH: isPanelOpen ? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT) : NODE_HEIGHT,
						status: ch.status,
					};
				}),
			[laid, mainPos, isH, openNarratorId],
		);

		useEffect(() => {
			if (cardRegistry) {
				cardRegistry.current.set(fromSha, cardInfos);
				return () => {
					cardRegistry.current.delete(fromSha);
				};
			}
		}, [cardInfos, cardRegistry, fromSha]);

		// When a narrator panel opens, request the parent to fit the expanded card into view
		useEffect(() => {
			const prev = prevOpenNarratorIdRef.current;
			prevOpenNarratorIdRef.current = openNarratorId;
			if (!openNarratorId || openNarratorId === prev || !onFitToView) return;
			const ch = laid.find((c) => c.narratorId === openNarratorId);
			if (!ch) return;
			const panelW = ch.panelWidth ?? DEFAULT_PANEL_WIDTH;
			const panelH = ch.panelHeight ?? DEFAULT_PANEL_HEIGHT;
			// Card world position: mainPos offsets the segment, +30 is the card top offset
			const worldX = (isH ? mainPos : 0) + ch.layoutX;
			const worldY = (isH ? 0 : mainPos) + ch.layoutY + 30;
			onFitToView(worldX, worldY, panelW, panelH);
		}, [openNarratorId, laid, mainPos, isH, onFitToView]);

		// Segment spans the full visible viewport in the cross-axis direction
		const segCrossStart = viewTop - 20;
		const segCrossSize = viewHeight + 40;

		const containerStyle: React.CSSProperties = {
			position: "absolute",
			background: "rgba(67, 56, 202, 0.04)",
			pointerEvents: "none",
		};
		if (isH) {
			Object.assign(containerStyle, {
				left: mainPos,
				top: segCrossStart,
				width: mainSize,
				height: segCrossSize,
			});
		} else {
			Object.assign(containerStyle, {
				top: mainPos,
				left: segCrossStart,
				height: mainSize,
				width: segCrossSize,
			});
		}

		return (
			<Box style={containerStyle}>
				{/* Content layer with pointer events restored */}
				<Box
					style={{
						position: "relative",
						...(isH ? { top: -segCrossStart } : { left: -segCrossStart }),
						pointerEvents: "auto",
					}}
				>
					{isLoading && (
						<Box style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
							<Loader size="sm" />
						</Box>
					)}

					{/* Connector lines: tick → chapter card (hidden at L2, simplified at degrade≥1) */}
					{!isLoading && laid.length > 0 && zoomTier !== "L2" && degradeLevel < 2 && (
						<ConnectorLines
							chapters={laid}
							mainPos={mainPos}
							isH={isH}
							scale={scale}
							tickPositions={tickPositions}
							openNarratorId={openNarratorId}
						/>
					)}

					{laid.map((ch) => {
						const isPanelOpen =
							zoomTier !== "L2" && openNarratorId === ch.narratorId && !!ch.narratorId;
						const isSubRulerOpen = expandedChapters.has(ch.id);
						const cardWidth = isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : NODE_WIDTH;
						const cardHeight = isPanelOpen ? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT) : NODE_HEIGHT;

						// Cross-axis visibility culling: panels use 1.5× viewport, cards use 3×
						const multiplier = isPanelOpen ? PANEL_CROSS_MULTIPLIER : CARD_CROSS_MULTIPLIER;
						const bufferHalf = (viewHeight * multiplier - viewHeight) / 2;
						const cullTop = viewTop - bufferHalf;
						const cullBottom = viewTop + viewHeight + bufferHalf;
						const cardTop = ch.layoutY + 30; // CARD_TOP_OFFSET
						const cardBottom = cardTop + cardHeight;
						if (cardBottom < cullTop || cardTop > cullBottom) return null;

						return (
							<Box key={ch.id}>
								<ChapterCard
									chapter={ch}
									x={ch.layoutX}
									y={ch.layoutY}
									width={cardWidth}
									height={cardHeight}
									isExpanded={isSubRulerOpen}
									isPanelOpen={isPanelOpen}
									scale={scale}
									onClick={() => {
										if (zoomTier === "L2") {
											toggleChapterExpand(ch.id);
											return;
										}
										if (ch.narratorId) {
											setOpenNarratorId(openNarratorId === ch.narratorId ? null : ch.narratorId);
										}
									}}
									onDoubleClick={() => toggleChapterExpand(ch.id)}
									onContextMenu={(e) => {
										e.preventDefault();
										e.stopPropagation();
										onChapterContextMenu?.({
											x: e.clientX,
											y: e.clientY,
											chapter: ch,
											fromSha,
										});
									}}
									onDragEnd={(newX, newY) => {
										const clampedY = Math.max(0, newY);
										queryClient.setQueryData<SegmentData>(
											["rulerSegment", projectId, fromSha],
											(old) => {
												if (!old) return old;
												return {
													...old,
													chapters: old.chapters.map((c) =>
														c.id === ch.id ? { ...c, axisOffset: newX, crossOffset: clampedY } : c,
													),
												};
											},
										);
										api.updateRulerPositions(projectId, [
											{
												chapterId: ch.id,
												anchorCommitSha: ch.anchorCommitSha ?? fromSha,
												axisOffset: newX,
												crossOffset: clampedY,
											},
										]);
									}}
									onResizeEnd={(newW, newH, dx, dy) => {
										const newAxisOffset = ch.layoutX + dx;
										const newCrossOffset = Math.max(0, ch.layoutY + dy);
										queryClient.setQueryData<SegmentData>(
											["rulerSegment", projectId, fromSha],
											(old) => {
												if (!old) return old;
												return {
													...old,
													chapters: old.chapters.map((c) =>
														c.id === ch.id
															? {
																	...c,
																	panelWidth: newW,
																	panelHeight: newH,
																	axisOffset: newAxisOffset,
																	crossOffset: newCrossOffset,
																}
															: c,
													),
												};
											},
										);
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
								{isSubRulerOpen && ch.status === "active" && (
									<Box
										style={{
											position: "absolute",
											left: ch.layoutX,
											top: ch.layoutY + 30 + cardHeight + 4,
											width: Math.min(cardWidth + 100, mainSize - ch.layoutX - 8),
										}}
									>
										<SubRuler
											projectId={projectId}
											chapterId={ch.id}
											chapterTitle={ch.title}
											width={Math.min(cardWidth + 100, mainSize - ch.layoutX - 8)}
											depth={0}
											orientation={orientation}
											renderMode={getSubRulerRenderMode(1, focusDepth)}
										/>
									</Box>
								)}
							</Box>
						);
					})}
				</Box>
			</Box>
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
		if (prev.cardRegistry !== next.cardRegistry) return false;
		if (prev.onChapterContextMenu !== next.onChapterContextMenu) return false;
		if (prev.tickPositions !== next.tickPositions) return false;
		if (prev.onFitToView !== next.onFitToView) return false;
		if (prev.viewTop !== next.viewTop) return false;
		if (prev.viewHeight !== next.viewHeight) return false;
		if (prev.zoomTier !== next.zoomTier) return false;
		if (prev.focusDepth !== next.focusDepth) return false;
		if (prev.degradeLevel !== next.degradeLevel) return false;
		return true;
	},
);

// --- Connector lines from ruler ticks to chapter cards ---

interface ConnectorLinesProps {
	chapters: Array<{
		id: string;
		status: string;
		startCommitSha: string | null;
		mergeCommitSha?: string | null;
		anchorCommitSha: string | null;
		layoutX: number;
		layoutY: number;
		panelWidth: number | null;
		panelHeight: number | null;
		narratorId: string | null;
	}>;
	mainPos: number;
	isH: boolean;
	scale: number;
	tickPositions?: Map<string, number>;
	openNarratorId: string | null;
}

const CARD_TOP_OFFSET = 30; // ChapterCard uses top: currentY + 30

function ConnectorLines({
	chapters,
	mainPos,
	isH,
	scale,
	tickPositions,
	openNarratorId,
}: ConnectorLinesProps) {
	if (!tickPositions || chapters.length === 0) return null;

	const lines: React.ReactNode[] = [];

	for (const ch of chapters) {
		const isPanelOpen = openNarratorId === ch.narratorId && !!ch.narratorId;
		const cardW = isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : NODE_WIDTH;
		const cardH = isPanelOpen ? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT) : NODE_HEIGHT;
		const isMerged = ch.status === "merged";
		const strokeColor = isMerged ? "rgba(99, 102, 241, 0.25)" : "rgba(99, 102, 241, 0.45)";

		// --- Fork line: startCommitSha tick → card leading edge ---
		const forkSha = ch.startCommitSha;
		if (forkSha) {
			const forkTickMain = tickPositions.get(forkSha);
			if (forkTickMain != null) {
				const tm = forkTickMain - mainPos;
				const cardCross = isH
					? ch.layoutY + CARD_TOP_OFFSET + cardH / 2
					: ch.layoutX + CARD_TOP_OFFSET + cardW / 2;
				const cardMain = isH ? ch.layoutX : ch.layoutY;

				// Quadratic bezier: control point at the L-corner (tm, cardCross)
				// gives a smooth curve from ruler straight down to card straight in.
				const forkPath = isH
					? `M ${tm} 0 Q ${tm} ${cardCross}, ${cardMain} ${cardCross}`
					: `M 0 ${tm} Q ${cardCross} ${tm}, ${cardCross} ${cardMain}`;

				lines.push(
					<path
						key={`fork-${ch.id}`}
						d={forkPath}
						fill="none"
						stroke={strokeColor}
						strokeWidth={1.5 / scale}
						strokeDasharray={isMerged ? `${4 / scale} ${3 / scale}` : undefined}
					/>,
				);
			}
		}

		// --- Merge line: card trailing edge → mergeCommitSha tick ---
		if (isMerged && ch.mergeCommitSha) {
			const mergeTickMain = tickPositions.get(ch.mergeCommitSha);
			if (mergeTickMain != null) {
				const mm = mergeTickMain - mainPos;
				const cardCross = isH
					? ch.layoutY + CARD_TOP_OFFSET + cardH / 2
					: ch.layoutX + CARD_TOP_OFFSET + cardW / 2;
				const cardTrailMain = isH ? ch.layoutX + cardW : ch.layoutY + cardH;

				const mergePath = isH
					? `M ${cardTrailMain} ${cardCross} Q ${mm} ${cardCross}, ${mm} 0`
					: `M ${cardCross} ${cardTrailMain} Q ${cardCross} ${mm}, 0 ${mm}`;

				lines.push(
					<path
						key={`merge-${ch.id}`}
						d={mergePath}
						fill="none"
						stroke="rgba(99, 102, 241, 0.25)"
						strokeWidth={1.5 / scale}
						strokeDasharray={`${4 / scale} ${3 / scale}`}
					/>,
				);
			}
		}
	}

	if (lines.length === 0) return null;

	return (
		<svg
			role="img"
			aria-label="Chapter connector lines"
			style={{
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				overflow: "visible",
				pointerEvents: "none",
			}}
		>
			{lines}
		</svg>
	);
}

function ChapterCard({
	chapter,
	x,
	y,
	width: cardWidth,
	height,
	isExpanded,
	isPanelOpen,
	scale,
	onClick,
	onDoubleClick,
	onContextMenu,
	onDragEnd,
	onResizeEnd,
}: {
	chapter: SegmentChapter & { layoutX: number; layoutY: number };
	x: number;
	y: number;
	width: number;
	height: number;
	isExpanded?: boolean;
	isPanelOpen?: boolean;
	scale: number;
	onClick?: () => void;
	onDoubleClick?: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onDragEnd?: (newX: number, newY: number) => void;
	onResizeEnd?: (newW: number, newH: number, dx: number, dy: number) => void;
}) {
	const isActive = chapter.status === "active";
	const isReview = chapter.role === "review";
	const panelWheelRef = useRef<HTMLDivElement>(null);
	const isDraggingRef = useRef(false);
	const dragStartRef = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
	const pointerDownTargetRef = useRef<EventTarget | null>(null);
	const headerRef = useRef<HTMLDivElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });

	// Reset drag offset when props position changes (after optimistic update lands)
	const prevPos = useRef({ x, y });
	if (prevPos.current.x !== x || prevPos.current.y !== y) {
		prevPos.current = { x, y };
		if (dragOffset.dx !== 0 || dragOffset.dy !== 0) {
			setDragOffset({ dx: 0, dy: 0 });
		}
	}

	// Resize state
	const isResizingRef = useRef(false);
	const resizeStartRef = useRef({ x: 0, y: 0, origW: 0, origH: 0, corner: "" });
	const [resizeDelta, setResizeDelta] = useState({ dw: 0, dh: 0, dx: 0, dy: 0 });
	const resizeDeltaRef = useRef(resizeDelta);
	resizeDeltaRef.current = resizeDelta;

	// Reset resize delta when props size changes (after optimistic update lands)
	const prevSize = useRef({ w: cardWidth, h: height });
	if (prevSize.current.w !== cardWidth || prevSize.current.h !== height) {
		prevSize.current = { w: cardWidth, h: height };
		if (resizeDelta.dw !== 0 || resizeDelta.dh !== 0) {
			setResizeDelta({ dw: 0, dh: 0, dx: 0, dy: 0 });
		}
	}

	const isCurrentlyResizing = isResizingRef.current || resizeDelta.dw !== 0 || resizeDelta.dh !== 0;

	// Prevent wheel events inside the narrator panel from bubbling to the canvas
	// and block browser Ctrl+wheel zoom
	useEffect(() => {
		const el = panelWheelRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			e.stopPropagation();
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
			}
		};
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	});

	// Global pointer handlers for resize (must track outside the handle element)
	useEffect(() => {
		if (!isPanelOpen) return;
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
			// Clamp: don't let size go below minimum
			const clampedW = Math.max(MIN_PANEL_WIDTH, resizeStartRef.current.origW + dw);
			const clampedH = Math.max(MIN_PANEL_HEIGHT, resizeStartRef.current.origH + dh);
			const actualDw = clampedW - resizeStartRef.current.origW;
			const actualDh = clampedH - resizeStartRef.current.origH;
			// Adjust position offset based on clamped size change
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
			onResizeEnd?.(newW, newH, d.dx, d.dy);
		};
		window.addEventListener("pointermove", handleMove);
		window.addEventListener("pointerup", handleUp);
		return () => {
			window.removeEventListener("pointermove", handleMove);
			window.removeEventListener("pointerup", handleUp);
		};
	}, [isPanelOpen, scale, onResizeEnd]);

	const borderColor = isPanelOpen
		? "var(--mantine-color-indigo-3)"
		: isExpanded
			? "var(--mantine-color-indigo-4)"
			: isReview
				? "var(--mantine-color-yellow-6)"
				: isActive
					? "var(--mantine-color-indigo-6)"
					: "light-dark(var(--mantine-color-gray-4), var(--mantine-color-dark-4))";

	const currentX = x + dragOffset.dx + resizeDelta.dx;
	const currentY = y + dragOffset.dy + resizeDelta.dy;
	const displayW = isPanelOpen ? Math.max(MIN_PANEL_WIDTH, cardWidth + resizeDelta.dw) : NODE_WIDTH;
	const displayH = isPanelOpen ? Math.max(MIN_PANEL_HEIGHT, height + resizeDelta.dh) : NODE_HEIGHT;

	const startResize = (e: React.PointerEvent, corner: string) => {
		e.preventDefault();
		e.stopPropagation();
		isResizingRef.current = true;
		resizeStartRef.current = {
			x: e.clientX,
			y: e.clientY,
			origW: cardWidth,
			origH: height,
			corner,
		};
	};

	const handleStyle = (corner: string): React.CSSProperties => {
		const isBr = corner === "br";
		const size = isBr ? 20 : 14;
		const base: React.CSSProperties = {
			position: "absolute",
			width: size,
			height: size,
			zIndex: 10,
		};
		if (corner === "tl") {
			base.top = -2;
			base.left = -2;
			base.cursor = "nwse-resize";
		} else if (corner === "tr") {
			base.top = -2;
			base.right = -2;
			base.cursor = "nesw-resize";
		} else if (corner === "bl") {
			base.bottom = -2;
			base.left = -2;
			base.cursor = "nesw-resize";
		} else {
			base.bottom = 0;
			base.right = 0;
			base.cursor = "nwse-resize";
			base.overflow = "hidden";
		}
		return base;
	};

	return (
		<Card
			ref={cardRef}
			shadow="sm"
			padding="xs"
			radius="md"
			withBorder
			style={{
				position: "absolute",
				left: currentX,
				top: currentY + 30,
				width: displayW,
				height: displayH,
				borderColor,
				borderWidth: isPanelOpen ? 2 : isReview ? 2 : 1,
				borderStyle: isReview ? "dashed" : "solid",
				opacity: isActive ? 1 : 0.6,
				cursor: isDraggingRef.current ? "grabbing" : isPanelOpen ? "default" : "grab",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				transition:
					isDraggingRef.current || isResizingRef.current
						? "none"
						: "width 200ms ease, height 200ms ease",
				userSelect: "none",
			}}
			onPointerDown={(e) => {
				// Only start drag from header area or when panel is closed (compact card)
				if (e.button !== 0) return;
				pointerDownTargetRef.current = e.target;
				const headerEl = headerRef.current;
				const isFromHeader = headerEl && e.target instanceof Node && headerEl.contains(e.target);
				if (!isPanelOpen || isFromHeader) {
					isDraggingRef.current = true;
					dragStartRef.current = {
						x: e.clientX,
						y: e.clientY,
						origX: currentX,
						origY: currentY,
					};
					(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				}
				e.stopPropagation();
			}}
			onPointerMove={(e) => {
				if (!isDraggingRef.current) return;
				const dx = (e.clientX - dragStartRef.current.x) / scale;
				const dy = (e.clientY - dragStartRef.current.y) / scale;
				setDragOffset({ dx, dy });
			}}
			onPointerUp={(e) => {
				if (!isDraggingRef.current) return;
				isDraggingRef.current = false;
				const dx = (e.clientX - dragStartRef.current.x) / scale;
				const dy = (e.clientY - dragStartRef.current.y) / scale;
				const wasDrag = Math.abs(dx) > 3 || Math.abs(dy) > 3;
				if (wasDrag) {
					const newX = dragStartRef.current.origX + dx;
					const newY = dragStartRef.current.origY + dy;
					onDragEnd?.(newX, newY);
				} else {
					setDragOffset({ dx: 0, dy: 0 });
					// Only toggle panel when clicking the header area, not the panel content
					const headerEl = headerRef.current;
					const downTarget = pointerDownTargetRef.current;
					if (headerEl && downTarget instanceof Node && headerEl.contains(downTarget)) {
						onClick?.();
					}
				}
			}}
			onContextMenu={onContextMenu}
			onDoubleClick={(e) => {
				e.stopPropagation();
				onDoubleClick?.();
			}}
		>
			{/* Resize handles — only when panel is open */}
			{isPanelOpen &&
				(["tl", "tr", "bl", "br"] as const).map((corner) => (
					<Box
						key={corner}
						style={handleStyle(corner)}
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
			<Box ref={headerRef} style={{ cursor: "pointer" }}>
				<Text size="xs" fw={600} truncate>
					{chapter.title}
				</Text>
				<Group gap={4} mt={4}>
					<Badge size="xs" variant="light" color={isActive ? "green" : "gray"}>
						{chapter.status}
					</Badge>
					{chapter.narratorStatus && (
						<Box style={{ display: "flex", alignItems: "center", gap: 3 }}>
							<Box
								style={{
									width: 5,
									height: 5,
									borderRadius: "50%",
									background: `var(--mantine-color-${NARRATOR_STATUS_COLORS[chapter.narratorStatus] ?? "gray"}-5)`,
								}}
							/>
							<Text size="9px" c="dimmed">
								{chapter.narratorStatus}
							</Text>
						</Box>
					)}
				</Group>
				{!isPanelOpen && (
					<Text size="9px" c="dimmed" mt={2} truncate>
						{chapter.branch}
					</Text>
				)}
			</Box>

			{/* Narrator panel */}
			{isPanelOpen && chapter.narratorId && (
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
						<StableNarratorPanel narratorId={chapter.narratorId} />
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
			)}
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
