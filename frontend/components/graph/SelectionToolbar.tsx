import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface SelectionToolbarProps {
	selectedNodeIds: string[];
	onFork: (nodeId: string) => void;
	onMergeNew: (nodeIds: string[]) => void;
	onMergeInto: (sourceNodeIds: string[], targetNodeId: string) => void;
}

interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/**
 * Floating toolbar shown below the bounding box of selected nodes.
 * Renders two pill buttons: "合并" and "合并到已有节点".
 * Must be mounted inside <ReactFlow>.
 */
export function SelectionToolbar({
	selectedNodeIds,
	onFork,
	onMergeNew,
	onMergeInto,
}: SelectionToolbarProps) {
	const { t } = useTranslation("graph");
	const { getNodes, flowToScreenPosition } = useReactFlow();
	const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);
	const [bbox, setBbox] = useState<BBox | null>(null);

	// --- Drag line state for "merge into existing" ---
	const [dragging, setDragging] = useState(false);
	const [dragLine, setDragLine] = useState<{
		x1: number;
		y1: number;
		x2: number;
		y2: number;
	} | null>(null);
	const dragStartRef = useRef<{ x: number; y: number } | null>(null);

	const selectedSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);

	// Compute bounding box and toolbar position
	const computePositions = useCallback(() => {
		if (selectedNodeIds.length < 1) {
			setToolbarPos(null);
			setBbox(null);
			return;
		}

		const allNodes = getNodes();
		const selected = allNodes.filter((n) => selectedSet.has(n.id));
		if (selected.length < 1) {
			setToolbarPos(null);
			setBbox(null);
			return;
		}

		let minX = Number.POSITIVE_INFINITY;
		let minY = Number.POSITIVE_INFINITY;
		let maxX = Number.NEGATIVE_INFINITY;
		let maxY = Number.NEGATIVE_INFINITY;

		for (const node of selected) {
			const w = node.measured?.width ?? node.width ?? 280;
			const h = node.measured?.height ?? node.height ?? 120;
			minX = Math.min(minX, node.position.x);
			minY = Math.min(minY, node.position.y);
			maxX = Math.max(maxX, node.position.x + w);
			maxY = Math.max(maxY, node.position.y + h);
		}

		setBbox({ minX, minY, maxX, maxY });

		// Toolbar position: center-bottom of bounding box, converted to screen coords
		const bottomCenter = flowToScreenPosition({
			x: (minX + maxX) / 2,
			y: maxY,
		});
		setToolbarPos({ x: bottomCenter.x, y: bottomCenter.y + 12 });
	}, [selectedNodeIds, selectedSet, getNodes, flowToScreenPosition]);

	// Recompute on selection change and on viewport changes (scroll/zoom)
	useEffect(() => {
		computePositions();

		// Listen for viewport changes to reposition
		const pane = document.querySelector(".react-flow__viewport");
		if (!pane) return;

		const observer = new MutationObserver(computePositions);
		observer.observe(pane, { attributes: true, attributeFilter: ["style", "transform"] });
		return () => observer.disconnect();
	}, [computePositions]);

	// --- Drag line handlers for "merge into existing" ---
	const handleMergeIntoPointerDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		dragStartRef.current = { x: e.clientX, y: e.clientY };
		setDragging(true);
		setDragLine({
			x1: e.clientX,
			y1: e.clientY,
			x2: e.clientX,
			y2: e.clientY,
		});
	}, []);

	useEffect(() => {
		if (!dragging) return;

		const onMove = (e: PointerEvent) => {
			if (!dragStartRef.current) return;
			setDragLine({
				x1: dragStartRef.current.x,
				y1: dragStartRef.current.y,
				x2: e.clientX,
				y2: e.clientY,
			});
		};

		const onUp = (e: PointerEvent) => {
			setDragging(false);
			setDragLine(null);
			dragStartRef.current = null;

			// Find the node under the pointer
			const target = document.elementFromPoint(e.clientX, e.clientY);
			const nodeEl = target?.closest(".react-flow__node") as HTMLElement | null;
			if (nodeEl) {
				const targetId = nodeEl.dataset.id;
				if (targetId && !selectedSet.has(targetId)) {
					onMergeInto(selectedNodeIds, targetId);
				}
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [dragging, selectedNodeIds, selectedSet, onMergeInto]);

	if (selectedNodeIds.length < 1 || !toolbarPos || !bbox) return null;

	const isSingle = selectedNodeIds.length === 1;

	// Convert bounding box corners to screen coords for the dashed rect
	const topLeft = flowToScreenPosition({ x: bbox.minX, y: bbox.minY });
	const bottomRight = flowToScreenPosition({ x: bbox.maxX, y: bbox.maxY });
	const rectX = topLeft.x - 8;
	const rectY = topLeft.y - 8;
	const rectW = bottomRight.x - topLeft.x + 16;
	const rectH = bottomRight.y - topLeft.y + 16;

	return (
		<>
			{/* Dashed bounding rect around selected nodes */}
			<svg
				role="img"
				aria-label="selection bounds"
				style={{
					position: "fixed",
					inset: 0,
					width: "100vw",
					height: "100vh",
					pointerEvents: "none",
					zIndex: 999,
				}}
			>
				<rect
					x={rectX}
					y={rectY}
					width={rectW}
					height={rectH}
					fill="none"
					stroke="var(--mantine-color-indigo-5)"
					strokeWidth={1.5}
					strokeDasharray="6 3"
					rx={6}
				/>
			</svg>

			{/* Drag connector line */}
			{dragLine && (
				<svg
					role="img"
					aria-label="merge connector"
					style={{
						position: "fixed",
						inset: 0,
						width: "100vw",
						height: "100vh",
						pointerEvents: "none",
						zIndex: 1001,
					}}
				>
					<line
						x1={dragLine.x1}
						y1={dragLine.y1}
						x2={dragLine.x2}
						y2={dragLine.y2}
						stroke="var(--mantine-color-indigo-5)"
						strokeWidth={2}
						strokeDasharray="8 4"
					/>
					<circle
						cx={dragLine.x2}
						cy={dragLine.y2}
						r={6}
						fill="var(--mantine-color-indigo-5)"
						opacity={0.8}
					/>
				</svg>
			)}

			{/* Toolbar */}
			<div
				style={{
					position: "fixed",
					left: toolbarPos.x,
					top: toolbarPos.y,
					transform: "translateX(-50%)",
					zIndex: 1000,
					display: "flex",
					gap: 8,
					pointerEvents: "auto",
				}}
			>
				{isSingle ? (
					<button
						type="button"
						onClick={() => onFork(selectedNodeIds[0])}
						style={{
							padding: "6px 16px",
							borderRadius: 20,
							border: "1px solid var(--mantine-color-indigo-5)",
							background: "var(--mantine-color-indigo-filled)",
							color: "white",
							fontSize: 13,
							fontWeight: 500,
							cursor: "pointer",
							whiteSpace: "nowrap",
							userSelect: "none",
						}}
					>
						{t("selection.fork")}
					</button>
				) : (
					<>
						<button
							type="button"
							onClick={() => onMergeNew(selectedNodeIds)}
							style={{
								padding: "6px 16px",
								borderRadius: 20,
								border: "1px solid var(--mantine-color-indigo-5)",
								background: "var(--mantine-color-indigo-filled)",
								color: "white",
								fontSize: 13,
								fontWeight: 500,
								cursor: "pointer",
								whiteSpace: "nowrap",
								userSelect: "none",
							}}
						>
							{t("selection.merge")}
						</button>
						<button
							type="button"
							onPointerDown={handleMergeIntoPointerDown}
							style={{
								padding: "6px 16px",
								borderRadius: 20,
								border: "1px solid var(--mantine-color-indigo-5)",
								background: dragging
									? "var(--mantine-color-indigo-filled)"
									: "var(--mantine-color-dark-6)",
								color: dragging ? "white" : "var(--mantine-color-indigo-4)",
								fontSize: 13,
								fontWeight: 500,
								cursor: dragging ? "grabbing" : "grab",
								whiteSpace: "nowrap",
								userSelect: "none",
							}}
						>
							{t("selection.mergeInto")}
						</button>
					</>
				)}
			</div>
		</>
	);
}
