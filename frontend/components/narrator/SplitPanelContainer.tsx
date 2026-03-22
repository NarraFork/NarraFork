import { Box, Text } from "@mantine/core";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type NarratorDragState,
	onNarratorDragEnd,
	onNarratorDragMove,
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
	onSplit: (leafId: string, direction: SplitDirection) => void;
	canClose: boolean;
}

export const SplitPanelCtx = createContext<SplitPanelCallbacks>({
	onSplitAndAssign: () => {},
	onReplace: () => {},
	onClose: () => {},
	onSplit: () => {},
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

function LeafPanel({ leaf }: { leaf: SplitLeaf }) {
	const { onSplitAndAssign, onReplace, onClose, onSplit, canClose } = useContext(SplitPanelCtx);
	const { t } = useTranslation("narrators");
	const [dropZone, setDropZone] = useState<DropZone>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const dropZoneRef = useRef<DropZone>(null);

	// Keep ref in sync for use in event callbacks
	dropZoneRef.current = dropZone;

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
				setDropZone(computeDropZone(rect, state.x, state.y));
			} else if (dropZoneRef.current) {
				setDropZone(null);
			}
		});

		const unsubEnd = onNarratorDragEnd((final: NarratorDragState | null) => {
			const zone = dropZoneRef.current;
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

			if (zone === "center") {
				onReplace(leaf.id, final.narratorId);
			} else {
				const direction: SplitDirection =
					zone === "left" || zone === "right" ? "horizontal" : "vertical";
				const position: "before" | "after" = zone === "left" || zone === "top" ? "before" : "after";
				onSplitAndAssign(leaf.id, direction, position, final.narratorId);
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [leaf.id, onSplitAndAssign, onReplace]);

	return (
		<Box
			ref={boxRef}
			h="100%"
			style={{ position: "relative", overflow: "hidden", borderRadius: 4 }}
		>
			{leaf.narratorId ? (
				<NarratorPanel
					key={leaf.narratorId}
					narratorId={leaf.narratorId}
					compact
					onClose={canClose ? () => onClose(leaf.id) : undefined}
					onSplitHorizontal={() => onSplit(leaf.id, "horizontal")}
					onSplitVertical={() => onSplit(leaf.id, "vertical")}
				/>
			) : (
				<Box
					h="100%"
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						backgroundColor: "var(--mantine-color-dark-7)",
						border: "1px solid var(--mantine-color-dark-5)",
					}}
				>
					<Text size="sm" c="dimmed">
						{t("dropNarratorHere")}
					</Text>
				</Box>
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

	return (
		<Box
			ref={containerRef}
			h="100%"
			style={{
				display: "flex",
				flexDirection: isHorizontal ? "row" : "column",
				minWidth: 0,
				minHeight: 0,
			}}
		>
			{branch.children.map((child, idx) => (
				<ChildWithHandle
					key={child.id}
					child={child}
					idx={idx}
					branch={branch}
					isHorizontal={isHorizontal}
					containerRef={containerRef}
					onUpdateSizes={onUpdateSizes}
				/>
			))}
		</Box>
	);
}

function ChildWithHandle({
	child,
	idx,
	branch,
	isHorizontal,
	containerRef,
	onUpdateSizes,
}: {
	child: SplitNode;
	idx: number;
	branch: SplitBranch;
	isHorizontal: boolean;
	containerRef: React.RefObject<HTMLDivElement | null>;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
}) {
	const sizeProp = isHorizontal
		? { width: `${branch.sizes[idx]}%` }
		: { height: `${branch.sizes[idx]}%` };

	const handleDrag = useCallback(
		(delta: number) => {
			if (!containerRef.current) return;
			const rect = containerRef.current.getBoundingClientRect();
			const totalPx = isHorizontal ? rect.width : rect.height;
			const deltaPct = (delta / totalPx) * 100;

			const newSizes = [...branch.sizes];
			const prevIdx = idx - 1;
			const newPrev = newSizes[prevIdx] + deltaPct;
			const newCurr = newSizes[idx] - deltaPct;

			if (newPrev < MIN_SIZE_PCT || newCurr < MIN_SIZE_PCT) return;
			newSizes[prevIdx] = newPrev;
			newSizes[idx] = newCurr;
			onUpdateSizes(branch.id, newSizes);
		},
		[branch.id, branch.sizes, idx, isHorizontal, containerRef, onUpdateSizes],
	);

	return (
		<>
			{idx > 0 && <ResizeHandle direction={branch.direction} onDrag={handleDrag} />}
			<Box
				style={{
					...sizeProp,
					flexShrink: 0,
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

// ── Resize handle ──

function ResizeHandle({
	direction,
	onDrag,
}: {
	direction: SplitDirection;
	onDrag: (deltaPx: number) => void;
}) {
	const isHorizontal = direction === "horizontal";
	const lastPos = useRef(0);
	const cleanupRef = useRef<(() => void) | null>(null);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			lastPos.current = isHorizontal ? e.clientX : e.clientY;

			const onMove = (ev: PointerEvent) => {
				const current = isHorizontal ? ev.clientX : ev.clientY;
				const delta = current - lastPos.current;
				if (delta !== 0) {
					onDrag(delta);
					lastPos.current = current;
				}
			};

			const onUp = () => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				cleanupRef.current = null;
			};

			document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
			cleanupRef.current = onUp;
		},
		[isHorizontal, onDrag],
	);

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
			}}
			onMouseEnter={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "var(--mantine-color-indigo-9)";
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
			}}
		/>
	);
}
