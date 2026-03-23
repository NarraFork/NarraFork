import { Box } from "@mantine/core";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
	type NarratorDragState,
	onNarratorDragEnd,
	onNarratorDragMove,
	startNarratorDrag,
} from "../../lib/narrator-drag";
import { NarratorPanel } from "./NarratorPanel";
import type { SplitBranch, SplitDirection, SplitLeaf, SplitNode } from "./split-tree";

const MIN_SIZE_PCT = 15;

/** Which zone the cursor is hovering over */
type DropZone = "left" | "right" | "top" | "bottom" | "center" | null;

function computeDropZone(rect: DOMRect, x: number, y: number): DropZone {
	const rx = (x - rect.left) / rect.width;
	const ry = (y - rect.top) / rect.height;
	const T = 0.25;
	if (rx < T) return "left";
	if (rx > 1 - T) return "right";
	if (ry < T) return "top";
	if (ry > 1 - T) return "bottom";
	return "center";
}

const ZONE_STYLES: Record<NonNullable<DropZone>, React.CSSProperties> = {
	left: { left: 0, top: 0, width: "50%", height: "100%" },
	right: { right: 0, top: 0, width: "50%", height: "100%" },
	top: { left: 0, top: 0, width: "100%", height: "50%" },
	bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
	center: { left: 0, top: 0, width: "100%", height: "100%" },
};

// ── Context for workspace callbacks ──

export interface SplitPanelCallbacks {
	onSplitAndAssign: (
		leafId: string,
		direction: SplitDirection,
		position: "before" | "after",
		narratorId: string,
	) => void;
	onReplace: (leafId: string, narratorId: string) => void;
	onClose: (leafId: string) => void;
	/** Swap the narrators of two leaf panels. */
	onSwap: (leafIdA: string, leafIdB: string) => void;
	/** Move an existing panel (remove from source leaf, split-assign at target). */
	onMoveToSplit: (
		sourceLeafId: string,
		targetLeafId: string,
		direction: SplitDirection,
		position: "before" | "after",
	) => void;
	canClose: boolean;
}

export const SplitPanelCtx = createContext<SplitPanelCallbacks>({
	onSplitAndAssign: () => {},
	onReplace: () => {},
	onClose: () => {},
	onSwap: () => {},
	onMoveToSplit: () => {},
	canClose: false,
});

// ── Main recursive renderer ──

export function SplitPanelContainer({
	node,
	onUpdateSizes,
}: {
	node: SplitNode;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
}) {
	if (node.type === "leaf") {
		return <LeafPanel leaf={node} />;
	}
	return <BranchPanel branch={node} onUpdateSizes={onUpdateSizes} />;
}

// ── Leaf: NarratorPanel with drop overlay ──

/** Threshold below which the panel uses compact (mobile-style) toolbar. */
const COMPACT_WIDTH_THRESHOLD = 640;

function LeafPanel({ leaf }: { leaf: SplitLeaf }) {
	const { onSplitAndAssign, onReplace, onClose, onSwap, onMoveToSplit, canClose } =
		useContext(SplitPanelCtx);
	const [dropZone, setDropZone] = useState<DropZone>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const dropZoneRef = useRef<DropZone>(null);

	// Track panel width to decide compact vs desktop toolbar
	const [isCompact, setIsCompact] = useState(true);
	useEffect(() => {
		const el = boxRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setIsCompact(width < COMPACT_WIDTH_THRESHOLD);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	/** Track the source leaf id when the drag originates from within the tree. */
	const dragSourceLeafRef = useRef<string | null>(null);

	useEffect(() => {
		const unsubMove = onNarratorDragMove((state: NarratorDragState) => {
			const el = boxRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				state.x >= rect.left &&
				state.x <= rect.right &&
				state.y >= rect.top &&
				state.y <= rect.bottom;
			if (inside) {
				// Don't show drop zone when dragging over the source panel itself
				if (state.sourceLeafId === leaf.id) {
					if (dropZoneRef.current) {
						dropZoneRef.current = null;
						setDropZone(null);
					}
					return;
				}
				const zone = computeDropZone(rect, state.x, state.y);
				dropZoneRef.current = zone;
				dragSourceLeafRef.current = state.sourceLeafId ?? null;
				setDropZone(zone);
			} else if (dropZoneRef.current) {
				dropZoneRef.current = null;
				setDropZone(null);
			}
		});

		const unsubEnd = onNarratorDragEnd((final: NarratorDragState | null) => {
			const zone = dropZoneRef.current;
			const sourceLeafId = dragSourceLeafRef.current;
			dropZoneRef.current = null;
			dragSourceLeafRef.current = null;
			setDropZone(null);
			if (!final || !zone) return;

			// Check if the drop landed on this panel
			const el = boxRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				final.x >= rect.left &&
				final.x <= rect.right &&
				final.y >= rect.top &&
				final.y <= rect.bottom;
			if (!inside) return;

			// Don't drop on self
			if (final.sourceLeafId === leaf.id) return;

			if (zone === "center") {
				if (sourceLeafId) {
					// Drag from within tree → swap
					onSwap(sourceLeafId, leaf.id);
				} else {
					// Drag from sidebar → replace
					onReplace(leaf.id, final.narratorId);
				}
			} else {
				const direction: SplitDirection =
					zone === "left" || zone === "right" ? "horizontal" : "vertical";
				const position: "before" | "after" = zone === "left" || zone === "top" ? "before" : "after";
				if (sourceLeafId) {
					// Drag from within tree → move (remove source, split at target)
					onMoveToSplit(sourceLeafId, leaf.id, direction, position);
				} else {
					// Drag from sidebar → split and assign
					onSplitAndAssign(leaf.id, direction, position, final.narratorId);
				}
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [leaf.id, onSplitAndAssign, onReplace, onSwap, onMoveToSplit]);

	const handleHeaderPointerDown = useCallback(
		(e: React.PointerEvent) => {
			if (!leaf.narratorId) return;
			startNarratorDrag(leaf.narratorId, "", e.clientX, e.clientY, leaf.id);
		},
		[leaf.narratorId, leaf.id],
	);

	return (
		<Box
			ref={boxRef}
			h="100%"
			style={{ position: "relative", overflow: "hidden", borderRadius: 4 }}
		>
			{leaf.narratorId && (
				<NarratorPanel
					key={leaf.narratorId}
					narratorId={leaf.narratorId}
					compact={isCompact}
					onClose={canClose ? () => onClose(leaf.id) : undefined}
					onHeaderPointerDown={handleHeaderPointerDown}
				/>
			)}

			{/* Drop zone overlay */}
			{dropZone && (
				<Box
					style={{
						position: "absolute",
						...ZONE_STYLES[dropZone],
						backgroundColor: "var(--mantine-color-indigo-9)",
						opacity: 0.25,
						borderRadius: 4,
						pointerEvents: "none",
						transition: "all 100ms ease",
					}}
				/>
			)}
		</Box>
	);
}

// ── Branch: flex container with resize handles ──

function BranchPanel({
	branch,
	onUpdateSizes,
}: {
	branch: SplitBranch;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
}) {
	const isHorizontal = branch.direction === "horizontal";
	const containerRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	const handleResizeStart = useCallback(
		/** Called on pointerdown — compute handle offset within container and show overlay */
		(_handleIdx: number, pointerPos: number) => {
			const container = containerRef.current;
			const overlay = overlayRef.current;
			if (!container || !overlay) return null;
			const rect = container.getBoundingClientRect();
			const totalPx = isHorizontal ? rect.width : rect.height;
			const containerStart = isHorizontal ? rect.left : rect.top;
			const handleOffset = pointerPos - containerStart;

			// Show overlay line at current position
			overlay.style.display = "block";
			if (isHorizontal) {
				overlay.style.left = `${handleOffset}px`;
				overlay.style.top = "0";
				overlay.style.width = "2px";
				overlay.style.height = "100%";
			} else {
				overlay.style.top = `${handleOffset}px`;
				overlay.style.left = "0";
				overlay.style.height = "2px";
				overlay.style.width = "100%";
			}

			return {
				totalPx,
				containerStart,
				startPointer: pointerPos,
				startOffset: handleOffset,
				startSizes: [...branch.sizes],
			};
		},
		[branch.sizes, isHorizontal],
	);

	/** Called on pointermove — move overlay line (pure DOM, no React state) */
	const handleResizeMove = useCallback(
		(
			currentPos: number,
			ctx: {
				totalPx: number;
				containerStart: number;
				startPointer: number;
				startOffset: number;
				startSizes: number[];
			},
			handleIdx: number,
		) => {
			const overlay = overlayRef.current;
			if (!overlay) return;
			const delta = currentPos - ctx.startPointer;
			const prevPct = ctx.startSizes[handleIdx - 1];
			const currPct = ctx.startSizes[handleIdx];
			const deltaPct = (delta / ctx.totalPx) * 100;
			// Clamp so neither side goes below MIN_SIZE_PCT
			const clampedDelta = Math.max(
				MIN_SIZE_PCT - prevPct,
				Math.min(currPct - MIN_SIZE_PCT, deltaPct),
			);
			const clampedPx = (clampedDelta / 100) * ctx.totalPx;
			const newOffset = ctx.startOffset + clampedPx;
			if (isHorizontal) {
				overlay.style.left = `${newOffset}px`;
			} else {
				overlay.style.top = `${newOffset}px`;
			}
		},
		[isHorizontal],
	);

	/** Called on pointerup — hide overlay, commit final sizes */
	const handleResizeEnd = useCallback(
		(
			currentPos: number,
			ctx: {
				totalPx: number;
				containerStart: number;
				startPointer: number;
				startOffset: number;
				startSizes: number[];
			},
			handleIdx: number,
		) => {
			const overlay = overlayRef.current;
			if (overlay) overlay.style.display = "none";

			const delta = currentPos - ctx.startPointer;
			const deltaPct = (delta / ctx.totalPx) * 100;
			const prevPct = ctx.startSizes[handleIdx - 1];
			const currPct = ctx.startSizes[handleIdx];
			const clampedDelta = Math.max(
				MIN_SIZE_PCT - prevPct,
				Math.min(currPct - MIN_SIZE_PCT, deltaPct),
			);
			if (Math.abs(clampedDelta) < 0.01) return;

			const newSizes = [...ctx.startSizes];
			newSizes[handleIdx - 1] = prevPct + clampedDelta;
			newSizes[handleIdx] = currPct - clampedDelta;
			onUpdateSizes(branch.id, newSizes);
		},
		[branch.id, onUpdateSizes],
	);

	return (
		<Box
			ref={containerRef}
			h="100%"
			w="100%"
			style={{
				display: "flex",
				flexDirection: isHorizontal ? "row" : "column",
				minWidth: 0,
				minHeight: 0,
				overflow: "hidden",
				position: "relative",
			}}
		>
			{branch.children.map((child, idx) => (
				<ChildWithHandle
					key={child.id}
					child={child}
					idx={idx}
					branch={branch}
					isHorizontal={isHorizontal}
					onUpdateSizes={onUpdateSizes}
					onResizeStart={handleResizeStart}
					onResizeMove={handleResizeMove}
					onResizeEnd={handleResizeEnd}
				/>
			))}
			{/* Drag preview overlay line — positioned via pure DOM */}
			<div
				ref={overlayRef}
				style={{
					display: "none",
					position: "absolute",
					backgroundColor: "var(--mantine-color-indigo-6)",
					borderRadius: 1,
					zIndex: 10,
					pointerEvents: "none",
				}}
			/>
		</Box>
	);
}

interface ResizeCtx {
	totalPx: number;
	containerStart: number;
	startPointer: number;
	startOffset: number;
	startSizes: number[];
}

function ChildWithHandle({
	child,
	idx,
	branch,
	isHorizontal,
	onUpdateSizes,
	onResizeStart,
	onResizeMove,
	onResizeEnd,
}: {
	child: SplitNode;
	idx: number;
	branch: SplitBranch;
	isHorizontal: boolean;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
	onResizeStart: (handleIdx: number, pointerPos: number) => ResizeCtx | null;
	onResizeMove: (currentPos: number, ctx: ResizeCtx, handleIdx: number) => void;
	onResizeEnd: (currentPos: number, ctx: ResizeCtx, handleIdx: number) => void;
}) {
	// Use flex-grow ratio instead of fixed percentage width/height.
	// This lets the flex container naturally account for resize handle widths.
	const flexProp = { flex: `${branch.sizes[idx]} 1 0%` };

	const onResizeStartRef = useRef(onResizeStart);
	onResizeStartRef.current = onResizeStart;
	const onResizeMoveRef = useRef(onResizeMove);
	onResizeMoveRef.current = onResizeMove;
	const onResizeEndRef = useRef(onResizeEnd);
	onResizeEndRef.current = onResizeEnd;

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const pos = isHorizontal ? e.clientX : e.clientY;
			const ctx = onResizeStartRef.current(idx, pos);
			if (!ctx) return;

			document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";

			const onMove = (ev: PointerEvent) => {
				onResizeMoveRef.current(isHorizontal ? ev.clientX : ev.clientY, ctx, idx);
			};
			const onUp = (ev: PointerEvent) => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				onResizeEndRef.current(isHorizontal ? ev.clientX : ev.clientY, ctx, idx);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[idx, isHorizontal],
	);

	return (
		<>
			{idx > 0 && <ResizeHandle direction={branch.direction} onPointerDown={handlePointerDown} />}
			<Box
				style={{
					...flexProp,
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				<SplitPanelContainer node={child} onUpdateSizes={onUpdateSizes} />
			</Box>
		</>
	);
}

// ── Resize handle (visual only, drag logic lives in parent) ──

function ResizeHandle({
	direction,
	onPointerDown,
}: {
	direction: SplitDirection;
	onPointerDown: (e: React.PointerEvent) => void;
}) {
	const isHorizontal = direction === "horizontal";

	return (
		<Box
			onPointerDown={onPointerDown}
			style={{
				flexShrink: 0,
				[isHorizontal ? "width" : "height"]: 6,
				cursor: isHorizontal ? "col-resize" : "row-resize",
				backgroundColor: "transparent",
				transition: "background-color 150ms ease",
				position: "relative",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
			onMouseEnter={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "var(--mantine-color-indigo-9)";
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
			}}
		>
			{/* Always-visible thin line indicator */}
			<Box
				style={{
					position: "absolute",
					[isHorizontal ? "width" : "height"]: 1,
					[isHorizontal ? "height" : "width"]: "100%",
					backgroundColor: "var(--mantine-color-dark-4)",
					pointerEvents: "none",
				}}
			/>
		</Box>
	);
}
