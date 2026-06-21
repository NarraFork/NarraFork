import { IconGripVertical, IconPlus, IconTerminal2 } from "@tabler/icons-react";
import { useReactFlow } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";

export interface TerminalBubble {
	id: string;
	name: string;
}

interface SelectionToolbarProps {
	selectedNodeIds: string[];
	onFork: (nodeId: string) => void;
	onMergeNew: (nodeIds: string[]) => void;
	onMergeInto: (sourceNodeIds: string[], targetNodeId: string) => void;
	terminals?: TerminalBubble[];
	onOpenTerminal?: (chapterId: string, terminalId: string, terminalName: string) => void;
	onCreateTerminal?: (chapterId: string) => void;
	onDragTerminal?: (
		chapterId: string,
		terminal: { id: string; name: string } | "new",
		screenX: number,
		screenY: number,
	) => void;
}

interface BBox {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

const pillStyle: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	gap: 4,
	padding: "6px 16px",
	borderRadius: 20,
	border: "1px solid var(--mantine-color-indigo-5)",
	fontSize: 13,
	fontWeight: 500,
	cursor: "pointer",
	whiteSpace: "nowrap",
	userSelect: "none",
};

const terminalPillStyle: React.CSSProperties = {
	...pillStyle,
	border: "1px solid var(--mantine-color-teal-5)",
	gap: 5,
};

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
	terminals,
	onOpenTerminal,
	onCreateTerminal,
	onDragTerminal,
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

	// --- Terminal drag state ---
	const [termDragging, setTermDragging] = useState<string | null>(null); // terminal id or "__new__"
	const [termDragLine, setTermDragLine] = useState<{
		x1: number;
		y1: number;
		x2: number;
		y2: number;
	} | null>(null);
	const termDragStartRef = useRef<{ x: number; y: number } | null>(null);
	const termDragInfoRef = useRef<{ id: string; name: string } | "new" | null>(null);

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

		// Listen for container resize (e.g. nav panel drag) to reposition
		const container = pane.closest(".react-flow") as HTMLElement | null;
		let resizeObserver: ResizeObserver | undefined;
		if (container) {
			resizeObserver = new ResizeObserver(computePositions);
			resizeObserver.observe(container);
		}

		return () => {
			observer.disconnect();
			resizeObserver?.disconnect();
		};
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

	// --- Terminal bubble drag handlers ---
	const handleTerminalPointerDown = useCallback(
		(e: React.PointerEvent, terminal: { id: string; name: string } | "new") => {
			e.preventDefault();
			e.stopPropagation();
			termDragStartRef.current = { x: e.clientX, y: e.clientY };
			termDragInfoRef.current = terminal;
			const key = terminal === "new" ? "__new__" : terminal.id;
			setTermDragging(key);
			setTermDragLine({
				x1: e.clientX,
				y1: e.clientY,
				x2: e.clientX,
				y2: e.clientY,
			});
		},
		[],
	);

	useEffect(() => {
		if (!termDragging) return;
		let moved = false;

		const onMove = (e: PointerEvent) => {
			if (!termDragStartRef.current) return;
			const dx = e.clientX - termDragStartRef.current.x;
			const dy = e.clientY - termDragStartRef.current.y;
			if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
			setTermDragLine({
				x1: termDragStartRef.current.x,
				y1: termDragStartRef.current.y,
				x2: e.clientX,
				y2: e.clientY,
			});
		};

		const onUp = (e: PointerEvent) => {
			const info = termDragInfoRef.current;
			const chapterId = selectedNodeIds[0];
			setTermDragging(null);
			setTermDragLine(null);
			termDragStartRef.current = null;
			termDragInfoRef.current = null;

			if (!chapterId || !info) return;

			if (moved && onDragTerminal) {
				// Dragged — place at drop position
				onDragTerminal(chapterId, info, e.clientX, e.clientY);
			} else {
				// Clicked — place next to the node
				if (info === "new") {
					onCreateTerminal?.(chapterId);
				} else {
					onOpenTerminal?.(chapterId, info.id, info.name);
				}
			}
		};

		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, [termDragging, selectedNodeIds, onDragTerminal, onCreateTerminal, onOpenTerminal]);

	if (selectedNodeIds.length < 1 || !toolbarPos || !bbox) return null;

	const isSingle = selectedNodeIds.length === 1;

	// Convert bounding box corners to screen coords for the dashed rect
	const topLeft = flowToScreenPosition({ x: bbox.minX, y: bbox.minY });
	const bottomRight = flowToScreenPosition({ x: bbox.maxX, y: bbox.maxY });
	const rectX = topLeft.x - 8;
	const rectY = topLeft.y - 8;
	const rectW = bottomRight.x - topLeft.x + 16;
	const rectH = bottomRight.y - topLeft.y + 16;

	// Terminal sidebar position: right edge of selection, vertically centered
	const termSidebarX = bottomRight.x + 20;
	const termSidebarY = (topLeft.y + bottomRight.y) / 2;

	const mergeIntoButton = (
		<button
			type="button"
			onPointerDown={handleMergeIntoPointerDown}
			style={{
				...pillStyle,
				background: dragging
					? "var(--mantine-color-indigo-filled)"
					: "var(--mantine-color-default)",
				color: dragging ? "white" : "var(--mantine-color-indigo-4)",
				cursor: dragging ? "grabbing" : "grab",
			}}
		>
			<IconGripVertical size={14} style={{ opacity: 0.7 }} />
			{t("selection.mergeInto")}
		</button>
	);

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
					zIndex: Z.graphOverlay - 1,
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

			{/* Drag connector line (merge into) */}
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
						zIndex: Z.graphOverlay + 1,
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

			{/* Drag connector line (terminal) */}
			{termDragLine && (
				<svg
					role="img"
					aria-label="terminal connector"
					style={{
						position: "fixed",
						inset: 0,
						width: "100vw",
						height: "100vh",
						pointerEvents: "none",
						zIndex: Z.graphOverlay + 1,
					}}
				>
					<line
						x1={termDragLine.x1}
						y1={termDragLine.y1}
						x2={termDragLine.x2}
						y2={termDragLine.y2}
						stroke="var(--mantine-color-teal-5)"
						strokeWidth={2}
						strokeDasharray="8 4"
					/>
					<circle
						cx={termDragLine.x2}
						cy={termDragLine.y2}
						r={6}
						fill="var(--mantine-color-teal-5)"
						opacity={0.8}
					/>
				</svg>
			)}

			{/* Bottom toolbar: Fork / Merge buttons */}
			<div
				style={{
					position: "fixed",
					left: toolbarPos.x,
					top: toolbarPos.y,
					transform: "translateX(-50%)",
					zIndex: Z.graphOverlay,
					display: "flex",
					alignItems: "center",
					gap: 8,
					pointerEvents: "auto",
				}}
			>
				{isSingle ? (
					<>
						<button
							type="button"
							onClick={() => onFork(selectedNodeIds[0])}
							style={{
								...pillStyle,
								background: "var(--mantine-color-indigo-filled)",
								color: "white",
							}}
						>
							{t("selection.fork")}
						</button>
						{mergeIntoButton}
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => onMergeNew(selectedNodeIds)}
							style={{
								...pillStyle,
								background: "var(--mantine-color-indigo-filled)",
								color: "white",
							}}
						>
							{t("selection.merge")}
						</button>
						{mergeIntoButton}
					</>
				)}
			</div>

			{/* Right sidebar: Terminal bubbles — only for single selection */}
			{isSingle && (
				<div
					style={{
						position: "fixed",
						left: termSidebarX,
						top: termSidebarY,
						transform: "translateY(-50%)",
						zIndex: Z.graphOverlay,
						display: "flex",
						flexDirection: "column",
						alignItems: "flex-start",
						gap: 6,
						pointerEvents: "auto",
					}}
				>
					{terminals?.map((term) => (
						<button
							key={term.id}
							type="button"
							onPointerDown={(e) => handleTerminalPointerDown(e, term)}
							style={{
								...terminalPillStyle,
								background:
									termDragging === term.id
										? "var(--mantine-color-teal-filled)"
										: "var(--mantine-color-default)",
								color: termDragging === term.id ? "white" : "var(--mantine-color-teal-4)",
								cursor: termDragging === term.id ? "grabbing" : "grab",
							}}
						>
							<IconTerminal2 size={13} />
							{term.name}
						</button>
					))}
					<button
						type="button"
						onPointerDown={(e) => handleTerminalPointerDown(e, "new")}
						style={{
							...terminalPillStyle,
							background:
								termDragging === "__new__"
									? "var(--mantine-color-teal-filled)"
									: "var(--mantine-color-default)",
							color: termDragging === "__new__" ? "white" : "var(--mantine-color-teal-4)",
							cursor: termDragging === "__new__" ? "grabbing" : "grab",
						}}
					>
						<IconPlus size={13} />
						{t("selection.newTerminal")}
					</button>
				</div>
			)}
		</>
	);
}
