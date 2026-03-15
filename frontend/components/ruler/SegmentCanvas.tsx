import { Badge, Box, Card, Group, Loader, Text } from "@mantine/core";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";
import type { RulerOrientation } from "./types";
import { getCardModeForChapter, getMorphFactor, getMorphStyle } from "./zoom-tiers";

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
	/** Request the parent to fit a world-space rect into the viewport */
	onFitToView?: (worldX: number, worldY: number, worldW: number, worldH: number) => void;
	/** World-space X of the zoom center (for morph proximity) */
	zoomCenterWorldX?: number;
	/** World-space width of the viewport (for morph proximity) */
	viewportWorldWidth?: number;
	/** Callback when chapters are loaded for a segment */
	onChaptersLoaded?: (
		fromSha: string,
		chapters: Array<{
			id: string;
			status: string;
			title: string;
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
		onFitToView,
		zoomCenterWorldX = 0,
		viewportWorldWidth = 1200,
		onChaptersLoaded,
	}: SegmentCanvasProps) {
		const queryClient = useQueryClient();
		const isH = orientation === "horizontal";

		// Determine data detail level based on segment center's card mode
		const segCenterWorld = mainPos + mainSize / 2;
		const segCardMode = getCardModeForChapter(
			scale,
			segCenterWorld,
			zoomCenterWorldX,
			viewportWorldWidth,
		);
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

		const [openNarratorId, setOpenNarratorId] = useState<string | null>(null);
		const prevOpenNarratorIdRef = useRef<string | null>(null);

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
					const rawW = isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : NODE_WIDTH;
					const rawH = isPanelOpen ? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT) : NODE_HEIGHT;
					return {
						id: ch.id,
						title: ch.title,
						worldX: (isH ? mainPos : 0) + ch.layoutX,
						worldY: (isH ? 0 : mainPos) + ch.layoutY + CARD_TOP_OFFSET,
						worldW: rawW,
						worldH: rawH,
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

		// Report chapter data to parent for PixiJS rendering
		useEffect(() => {
			if (onChaptersLoaded && laid.length > 0) {
				onChaptersLoaded(
					fromSha,
					laid.map((ch) => ({
						id: ch.id,
						status: ch.status,
						title: ch.title,
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
			const prev = prevOpenNarratorIdRef.current;
			prevOpenNarratorIdRef.current = openNarratorId;
			if (!openNarratorId || openNarratorId === prev || !onFitToView) return;
			const ch = laid.find((c) => c.narratorId === openNarratorId);
			if (!ch) return;
			const panelW = ch.panelWidth ?? DEFAULT_PANEL_WIDTH;
			const panelH = ch.panelHeight ?? DEFAULT_PANEL_HEIGHT;
			// Card world position: mainPos offsets the segment, +30 is the card top offset
			const worldX = (isH ? mainPos : 0) + ch.layoutX;
			const worldY = (isH ? 0 : mainPos) + ch.layoutY + CARD_TOP_OFFSET;
			onFitToView(worldX, worldY, panelW, panelH);
		}, [openNarratorId, laid, mainPos, isH, onFitToView]);

		// Segment spans the full visible viewport in the cross-axis direction
		const segCrossStart = viewTop - 20;
		const segCrossSize = viewHeight + 40;

		// Compute per-chapter morph — only render ChapterCard when showCardBody=true
		// PixiJS handles dot/pill/connector rendering
		const chapterMorphs = useMemo(
			() =>
				laid.map((ch) => {
					const worldX = (isH ? mainPos : 0) + ch.layoutX + NODE_WIDTH / 2;
					const t = getMorphFactor(scale, worldX, zoomCenterWorldX, viewportWorldWidth);
					const morph = getMorphStyle(t, NODE_WIDTH, NODE_HEIGHT);
					return { ch, t, morph };
				}),
			[laid, isH, mainPos, scale, zoomCenterWorldX, viewportWorldWidth],
		);

		// If no chapter needs card body, render minimal container
		const anyShowCard = chapterMorphs.some((m) => m.morph.showCardBody);
		if (!anyShowCard && !isLoading) {
			// Transparent container — PixiJS draws everything
			return (
				<Box
					style={{
						position: "absolute",
						pointerEvents: "none",
						...(isH
							? { left: mainPos, top: segCrossStart, width: mainSize, height: segCrossSize }
							: { top: mainPos, left: segCrossStart, height: mainSize, width: segCrossSize }),
					}}
				/>
			);
		}

		// --- Full mode: interactive cards with panels ---
		const containerStyle: React.CSSProperties = {
			position: "absolute",
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

					{chapterMorphs.map(({ ch, morph }) => {
						// Only render ChapterCard when morph says showCardBody
						if (!morph.showCardBody) return null;

						const isPanelOpen = openNarratorId === ch.narratorId && !!ch.narratorId;
						const cardWidth = isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : morph.width;
						const cardHeight = isPanelOpen
							? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT)
							: morph.height;

						// Cross-axis visibility culling
						const visualH = cardHeight;
						const multiplier = isPanelOpen ? PANEL_CROSS_MULTIPLIER : CARD_CROSS_MULTIPLIER;
						const bufferHalf = (viewHeight * multiplier - viewHeight) / 2;
						const cullTop = viewTop - bufferHalf;
						const cullBottom = viewTop + viewHeight + bufferHalf;
						const cardTop = ch.layoutY + CARD_TOP_OFFSET;
						const cardBottom = cardTop + visualH;
						if (cardBottom < cullTop || cardTop > cullBottom) return null;

						// Center-fade: smooth transition from centered (morph) to top-left (card)
						const centerFade = morph.showCardBody
							? Math.max(0, 1 - (morph.width - 160) / (NODE_WIDTH - 160))
							: 1;
						const centerOffsetX = ((NODE_WIDTH - morph.width) / 2) * centerFade;
						const centerOffsetY = ((NODE_HEIGHT - morph.height) / 2) * centerFade;

						return (
							<Box key={ch.id}>
								<ChapterCard
									chapter={ch}
									x={ch.layoutX + centerOffsetX}
									y={ch.layoutY + centerOffsetY}
									width={cardWidth}
									height={cardHeight}
									isPanelOpen={isPanelOpen}
									scale={scale}
									onClick={() => {
										if (ch.narratorId) {
											setOpenNarratorId(openNarratorId === ch.narratorId ? null : ch.narratorId);
										}
									}}
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
										const qk = ["rulerSegment", projectId, fromSha, needsFull ? "full" : "summary"];
										queryClient.setQueryData<SegmentData>(qk, (old) => {
											if (!old) return old;
											return {
												...old,
												chapters: old.chapters.map((c) =>
													c.id === ch.id ? { ...c, axisOffset: newX, crossOffset: clampedY } : c,
												),
											};
										});
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
										const qk = ["rulerSegment", projectId, fromSha, needsFull ? "full" : "summary"];
										queryClient.setQueryData<SegmentData>(qk, (old) => {
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
		if (prev.onFitToView !== next.onFitToView) return false;
		if (prev.viewTop !== next.viewTop) return false;
		if (prev.viewHeight !== next.viewHeight) return false;
		if (prev.scale !== next.scale) return false;
		if (prev.zoomCenterWorldX !== next.zoomCenterWorldX) return false;
		if (prev.viewportWorldWidth !== next.viewportWorldWidth) return false;
		if (prev.onChaptersLoaded !== next.onChaptersLoaded) return false;
		return true;
	},
);

function ChapterCard({
	chapter,
	x,
	y,
	width: cardWidth,
	height,
	isPanelOpen,
	scale,
	onClick,
	onContextMenu,
	onDragEnd,
	onResizeEnd,
}: {
	chapter: SegmentChapter & { layoutX: number; layoutY: number };
	x: number;
	y: number;
	width: number;
	height: number;
	isPanelOpen?: boolean;
	scale: number;
	onClick?: () => void;
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
		: isReview
			? "var(--mantine-color-yellow-6)"
			: isActive
				? "var(--mantine-color-indigo-6)"
				: "light-dark(var(--mantine-color-gray-4), var(--mantine-color-dark-4))";

	const currentX = x + dragOffset.dx + resizeDelta.dx;
	const currentY = y + dragOffset.dy + resizeDelta.dy;
	const displayW = isPanelOpen ? Math.max(MIN_PANEL_WIDTH, cardWidth + resizeDelta.dw) : cardWidth;
	const displayH = isPanelOpen ? Math.max(MIN_PANEL_HEIGHT, height + resizeDelta.dh) : height;

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
			padding={6}
			radius="sm"
			withBorder
			style={{
				position: "absolute",
				left: currentX,
				top: currentY + CARD_TOP_OFFSET,
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
				<Text size="11px" fw={600} truncate>
					{chapter.title}
				</Text>
				<Group gap={3} mt={2}>
					<Badge size="xs" variant="light" color={isActive ? "green" : "gray"}>
						{chapter.status}
					</Badge>
					{chapter.narratorStatus && (
						<Box style={{ display: "flex", alignItems: "center", gap: 2 }}>
							<Box
								style={{
									width: 4,
									height: 4,
									borderRadius: "50%",
									background: `var(--mantine-color-${NARRATOR_STATUS_COLORS[chapter.narratorStatus] ?? "gray"}-5)`,
								}}
							/>
							<Text size="8px" c="dimmed">
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
