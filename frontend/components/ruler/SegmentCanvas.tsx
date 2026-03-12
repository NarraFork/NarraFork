import { Badge, Box, Card, Group, Loader, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RulerSegment } from "../../hooks/useRuler";
import { api } from "../../lib/api";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";
import { ChapterContextMenu } from "./RulerContextMenus";
import { SubRuler } from "./SubRuler";

interface SegmentChapter {
	id: string;
	title: string;
	status: string;
	branch: string;
	role: string;
	narratorId: string | null;
	narratorStatus: string | null;
	reviewStatus: string | null;
	localX: number;
	localY: number;
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

interface SegmentCanvasProps {
	projectId: string;
	fromSha: string;
	toSha: string;
	x: number;
	width: number;
	segment: RulerSegment;
	/** Current camera scale — used for inverse-scaling interactive elements */
	scale?: number;
	/** World-space Y of the viewport top edge */
	viewTop?: number;
	/** World-space height of the viewport */
	viewHeight?: number;
	/** Shared mutable map for registering card world positions (no re-render) */
	cardRegistry?: React.MutableRefObject<Map<string, CardWorldInfo[]>>;
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 72;

export function SegmentCanvas({
	projectId,
	fromSha,
	toSha,
	x,
	width,
	segment,
	scale = 1,
	viewTop = 0,
	viewHeight = 800,
	cardRegistry,
}: SegmentCanvasProps) {
	const queryClient = useQueryClient();
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

	const [ctxMenu, setCtxMenu] = useState<{
		x: number;
		y: number;
		chapter: SegmentChapter;
	} | null>(null);

	useEffect(() => {
		if (!ctxMenu) return;
		const handler = () => setCtxMenu(null);
		window.addEventListener("click", handler);
		return () => window.removeEventListener("click", handler);
	}, [ctxMenu]);

	const chapters = data?.chapters ?? [];

	const laid = useMemo(() => {
		const padding = 20;
		const gap = 16;
		const cols = Math.max(1, Math.floor((width - padding * 2) / (NODE_WIDTH + gap)));
		return chapters.map((ch, i) => {
			const hasPosition = ch.localX !== 0 || ch.localY !== 0;
			if (hasPosition) return { ...ch, layoutX: ch.localX, layoutY: ch.localY };
			const col = i % cols;
			const row = Math.floor(i / cols);
			return {
				...ch,
				layoutX: padding + col * (NODE_WIDTH + gap),
				layoutY: padding + row * (NODE_HEIGHT + gap),
			};
		});
	}, [chapters, width]);

	const handleFork = useCallback(
		async (chapterId: string) => {
			try {
				await api.forkChapter(chapterId, {});
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				queryClient.invalidateQueries({ queryKey: ["rulerSegment", projectId, fromSha] });
			} catch {
				// Global error handler
			}
		},
		[projectId, fromSha, queryClient],
	);

	const handleMerge = useCallback(
		async (chapterId: string) => {
			try {
				await api.rulerMerge(projectId, { sourceChapterId: chapterId });
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				queryClient.invalidateQueries({ queryKey: ["rulerSegment", projectId, fromSha] });
			} catch {
				// Global error handler
			}
		},
		[projectId, fromSha, queryClient],
	);

	const handleReview = useCallback(
		async (chapterId: string) => {
			try {
				await api.createReview(chapterId, {});
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				queryClient.invalidateQueries({ queryKey: ["rulerSegment", projectId, fromSha] });
			} catch {
				// Global error handler
			}
		},
		[projectId, fromSha, queryClient],
	);

	const handleAbandon = useCallback(
		async (chapterId: string) => {
			try {
				await api.rulerAbandon(projectId, chapterId);
				queryClient.invalidateQueries({ queryKey: ["ruler", projectId] });
				queryClient.invalidateQueries({ queryKey: ["rulerSegment", projectId, fromSha] });
			} catch {
				// Global error handler
			}
		},
		[projectId, fromSha, queryClient],
	);

	// Write card world positions to shared registry (no re-render)
	const cardInfos = useMemo(
		() =>
			laid.map((ch) => ({
				id: ch.id,
				title: ch.title,
				worldX: x + ch.layoutX,
				worldY: ch.layoutY + 30,
				status: ch.status,
			})),
		[laid, x],
	);

	useEffect(() => {
		if (cardRegistry) {
			cardRegistry.current.set(fromSha, cardInfos);
			return () => {
				cardRegistry.current.delete(fromSha);
			};
		}
	}, [cardInfos, cardRegistry, fromSha]);

	// Segment spans the full visible viewport height in world space
	const segTop = viewTop - 20;
	const segHeight = viewHeight + 40;

	return (
		<Box
			style={{
				position: "absolute",
				left: x,
				top: segTop,
				width,
				height: segHeight,
				borderLeft: "1px dashed var(--mantine-color-indigo-8)",
				borderRight: "1px dashed var(--mantine-color-indigo-8)",
				background: "rgba(67, 56, 202, 0.04)",
				pointerEvents: "none",
			}}
		>
			{/* Content layer with pointer events restored */}
			<Box style={{ position: "relative", top: -segTop, pointerEvents: "auto" }}>
				{isLoading && (
					<Box style={{ display: "flex", justifyContent: "center", paddingTop: 40 }}>
						<Loader size="sm" />
					</Box>
				)}

				{laid.map((ch) => {
					const isPanelOpen = openNarratorId === ch.narratorId && !!ch.narratorId;
					const isSubRulerOpen = expandedChapters.has(ch.id);
					const cardHeight = isPanelOpen ? 360 : NODE_HEIGHT;

					return (
						<Box key={ch.id}>
							<ChapterCard
								chapter={ch}
								x={ch.layoutX}
								y={ch.layoutY}
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
									setCtxMenu({ x: e.clientX, y: e.clientY, chapter: ch });
								}}
								onDragEnd={(newX, newY) => {
									api.updateRulerPositions(projectId, [{ chapterId: ch.id, x: newX, y: newY }]);
									queryClient.invalidateQueries({
										queryKey: ["rulerSegment", projectId, fromSha],
									});
								}}
							/>
							{isSubRulerOpen && ch.status === "active" && (
								<Box
									style={{
										position: "absolute",
										left: ch.layoutX,
										top: ch.layoutY + 30 + cardHeight + 4,
										width: Math.min(NODE_WIDTH + 100, width - ch.layoutX - 8),
									}}
								>
									<SubRuler
										projectId={projectId}
										chapterId={ch.id}
										chapterTitle={ch.title}
										width={Math.min(NODE_WIDTH + 100, width - ch.layoutX - 8)}
										depth={0}
									/>
								</Box>
							)}
						</Box>
					);
				})}

				{ctxMenu && (
					<ChapterContextMenu
						x={ctxMenu.x}
						y={ctxMenu.y}
						chapterId={ctxMenu.chapter.id}
						chapterTitle={ctxMenu.chapter.title}
						chapterStatus={ctxMenu.chapter.status}
						chapterRole={ctxMenu.chapter.role}
						onClose={() => setCtxMenu(null)}
						onFork={handleFork}
						onMerge={handleMerge}
						onReview={handleReview}
						onAbandon={handleAbandon}
					/>
				)}
			</Box>
		</Box>
	);
}

function ChapterCard({
	chapter,
	x,
	y,
	height,
	isExpanded,
	isPanelOpen,
	scale,
	onClick,
	onDoubleClick,
	onContextMenu,
	onDragEnd,
}: {
	chapter: SegmentChapter & { layoutX: number; layoutY: number };
	x: number;
	y: number;
	height: number;
	isExpanded?: boolean;
	isPanelOpen?: boolean;
	scale: number;
	onClick?: () => void;
	onDoubleClick?: () => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onDragEnd?: (newX: number, newY: number) => void;
}) {
	const isActive = chapter.status === "active";
	const isReview = chapter.role === "review";
	const panelWheelRef = useRef<HTMLDivElement>(null);
	const isDraggingRef = useRef(false);
	const dragStartRef = useRef({ x: 0, y: 0, origX: 0, origY: 0 });
	const [dragOffset, setDragOffset] = useState({ dx: 0, dy: 0 });

	// Prevent wheel events inside the narrator panel from bubbling to the canvas
	useEffect(() => {
		const el = panelWheelRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => e.stopPropagation();
		el.addEventListener("wheel", handler, { passive: true });
		return () => el.removeEventListener("wheel", handler);
	});
	const borderColor = isPanelOpen
		? "var(--mantine-color-indigo-3)"
		: isExpanded
			? "var(--mantine-color-indigo-4)"
			: isReview
				? "var(--mantine-color-yellow-6)"
				: isActive
					? "var(--mantine-color-indigo-6)"
					: "var(--mantine-color-dark-4)";

	const currentX = x + dragOffset.dx;
	const currentY = y + dragOffset.dy;

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
				width: isPanelOpen ? 420 : NODE_WIDTH,
				height,
				borderColor,
				borderWidth: isPanelOpen ? 2 : isReview ? 2 : 1,
				borderStyle: isReview ? "dashed" : "solid",
				opacity: isActive ? 1 : 0.6,
				cursor: isDraggingRef.current ? "grabbing" : "grab",
				display: "flex",
				flexDirection: "column",
				overflow: "hidden",
				transition: isDraggingRef.current ? "none" : "width 200ms ease, height 200ms ease",
				userSelect: "none",
			}}
			onPointerDown={(e) => {
				// Only left button, and not on interactive children
				if (e.button !== 0) return;
				isDraggingRef.current = true;
				dragStartRef.current = { x: e.clientX, y: e.clientY, origX: currentX, origY: currentY };
				(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
				e.stopPropagation();
			}}
			onPointerMove={(e) => {
				if (!isDraggingRef.current) return;
				// Divide by scale to convert screen-space delta to world-space
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
					setDragOffset({ dx: 0, dy: 0 });
					onDragEnd?.(newX, newY);
				} else {
					setDragOffset({ dx: 0, dy: 0 });
					onClick?.();
				}
			}}
			onContextMenu={onContextMenu}
			onDoubleClick={(e) => {
				e.stopPropagation();
				onDoubleClick?.();
			}}
		>
			{/* Header */}
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
					}}
				>
					<NarratorPanel key={chapter.narratorId} narratorId={chapter.narratorId} compact />
				</Box>
			)}
		</Card>
	);
}
