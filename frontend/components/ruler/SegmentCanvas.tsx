import { Badge, Box, Card, Group, Loader, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";
import { SubRuler } from "./SubRuler";
import type { RulerOrientation } from "./types";

interface SegmentChapter {
	id: string;
	title: string;
	status: string;
	branch: string;
	role: string;
	narratorId: string | null;
	narratorStatus: string | null;
	reviewStatus: string | null;
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
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;
const DEFAULT_PANEL_WIDTH = 420;
const DEFAULT_PANEL_HEIGHT = 520;
const MIN_PANEL_WIDTH = 300;
const MIN_PANEL_HEIGHT = 200;

export function SegmentCanvas({
	projectId,
	fromSha,
	toSha,
	mainPos,
	mainSize,
	segment,
	scale = 1,
	orientation = "horizontal",
	viewTop = 0,
	viewHeight = 800,
	cardRegistry,
	onChapterContextMenu,
}: SegmentCanvasProps) {
	const queryClient = useQueryClient();
	const isH = orientation === "horizontal";
	const { data, isLoading } = useQuery({
		queryKey: ["rulerSegment", projectId, fromSha],
		queryFn: () => api.getRulerSegment(projectId, fromSha, toSha) as Promise<SegmentData>,
		staleTime: 30_000,
	});

	const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());
	const [openNarratorId, setOpenNarratorId] = useState<string | null>(null);

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
		const cols = Math.max(1, Math.floor((mainSize - padding * 2) / (NODE_WIDTH + gap)));
		return chapters.map((ch, i) => {
			const hasPosition = ch.axisOffset !== 0 || ch.crossOffset !== 0;
			if (hasPosition) return { ...ch, layoutX: ch.axisOffset, layoutY: ch.crossOffset };
			const col = i % cols;
			const row = Math.floor(i / cols);
			return {
				...ch,
				layoutX: padding + col * (NODE_WIDTH + gap),
				layoutY: padding + row * (NODE_HEIGHT + gap),
			};
		});
	}, [chapters, mainSize]);

	// Write card world positions to shared registry (no re-render)
	const cardInfos = useMemo(
		() =>
			laid.map((ch) => ({
				id: ch.id,
				title: ch.title,
				worldX: (isH ? mainPos : 0) + ch.layoutX,
				worldY: (isH ? 0 : mainPos) + ch.layoutY + 30,
				status: ch.status,
			})),
		[laid, mainPos, isH],
	);

	useEffect(() => {
		if (cardRegistry) {
			cardRegistry.current.set(fromSha, cardInfos);
			return () => {
				cardRegistry.current.delete(fromSha);
			};
		}
	}, [cardInfos, cardRegistry, fromSha]);

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
			borderLeft: "1px dashed var(--mantine-color-indigo-8)",
			borderRight: "1px dashed var(--mantine-color-indigo-8)",
		});
	} else {
		Object.assign(containerStyle, {
			top: mainPos,
			left: segCrossStart,
			height: mainSize,
			width: segCrossSize,
			borderTop: "1px dashed var(--mantine-color-indigo-8)",
			borderBottom: "1px dashed var(--mantine-color-indigo-8)",
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

				{laid.map((ch) => {
					const isPanelOpen = openNarratorId === ch.narratorId && !!ch.narratorId;
					const isSubRulerOpen = expandedChapters.has(ch.id);
					const cardWidth = isPanelOpen ? (ch.panelWidth ?? DEFAULT_PANEL_WIDTH) : NODE_WIDTH;
					const cardHeight = isPanelOpen ? (ch.panelHeight ?? DEFAULT_PANEL_HEIGHT) : NODE_HEIGHT;

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
									/>
								</Box>
							)}
						</Box>
					);
				})}
			</Box>
		</Box>
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
					: "var(--mantine-color-dark-4)";

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
				cursor: isDraggingRef.current ? "grabbing" : "grab",
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
				if (e.button !== 0) return;
				pointerDownTargetRef.current = e.target;
				isDraggingRef.current = true;
				dragStartRef.current = {
					x: e.clientX,
					y: e.clientY,
					origX: currentX,
					origY: currentY,
				};
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
						borderTop: "1px solid var(--mantine-color-dark-4)",
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
