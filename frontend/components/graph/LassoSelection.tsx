import { useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";

interface Point {
	x: number;
	y: number;
}

/** Ray-casting algorithm: test if point is inside a polygon. */
function pointInPolygon(point: Point, polygon: Point[]): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
		const xi = polygon[i].x;
		const yi = polygon[i].y;
		const xj = polygon[j].x;
		const yj = polygon[j].y;
		if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi)
			inside = !inside;
	}
	return inside;
}

/** Check if any corner of a rectangle is inside the polygon (partial overlap). */
function rectIntersectsPolygon(
	x: number,
	y: number,
	w: number,
	h: number,
	polygon: Point[],
): boolean {
	const corners: Point[] = [
		{ x, y },
		{ x: x + w, y },
		{ x: x + w, y: y + h },
		{ x, y: y + h },
	];
	return corners.some((c) => pointInPolygon(c, polygon));
}

function buildSvgPath(points: Point[]): string {
	if (points.length < 2) return "";
	let d = `M ${points[0].x} ${points[0].y}`;
	for (let i = 1; i < points.length; i++) {
		d += ` L ${points[i].x} ${points[i].y}`;
	}
	d += " Z";
	return d;
}

interface LassoSelectionProps {
	/** "select" = mouse left-drag draws lasso; "pan" = mouse left-drag pans */
	pcDragMode: "select" | "pan";
	/** Called with the set of node IDs enclosed by the lasso. */
	onSelect: (selectedIds: Set<string>) => void;
}

export function LassoSelection({ pcDragMode, onSelect }: LassoSelectionProps) {
	const { screenToFlowPosition, getNodes } = useReactFlow();
	const [points, setPoints] = useState<Point[]>([]);
	const [active, setActive] = useState(false);
	const wrapperRef = useRef<HTMLDivElement>(null);

	// Keep everything in refs so the single effect never needs to re-bind listeners.
	const pcDragModeRef = useRef(pcDragMode);
	pcDragModeRef.current = pcDragMode;
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const screenToFlowRef = useRef(screenToFlowPosition);
	screenToFlowRef.current = screenToFlowPosition;
	const getNodesRef = useRef(getNodes);
	getNodesRef.current = getNodes;

	const drawingRef = useRef(false);
	const currentPointsRef = useRef<Point[]>([]);

	useEffect(() => {
		const el = wrapperRef.current?.closest(".react-flow") as HTMLElement | null;
		if (!el) return;

		/** Is the event target on the blank pane (not a node/edge/handle)? */
		const isOnPane = (target: HTMLElement) =>
			target.closest(".react-flow__pane") !== null &&
			target.closest(".react-flow__node") === null &&
			target.closest(".react-flow__edge") === null &&
			target.closest(".react-flow__handle") === null;

		/**
		 * Looser check for touch-initiated lasso (contextmenu / long-press).
		 * Fixed-position overlays (e.g. SelectionToolbar) live inside the
		 * .react-flow container in the DOM but outside .react-flow__pane,
		 * so the strict isOnPane check fails when the touch lands on them.
		 * We accept any target inside the ReactFlow root that isn't a
		 * node / edge / handle.
		 */
		const canStartTouchLasso = (target: HTMLElement) =>
			el.contains(target) &&
			target.closest(".react-flow__node") === null &&
			target.closest(".react-flow__edge") === null &&
			target.closest(".react-flow__handle") === null &&
			target.closest(".react-flow__controls") === null;

		/** Cancel d3-zoom's ongoing pan. */
		const cancelPan = () => {
			const renderer = el.querySelector(".react-flow__renderer");
			if (renderer) {
				renderer.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
				renderer.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true }));
			}
		};

		const doFinish = () => {
			const lassoPoints = currentPointsRef.current;
			if (lassoPoints.length < 3) return;

			const toFlow = screenToFlowRef.current;
			const flowPolygon = lassoPoints.map((p) => toFlow(p));
			const allNodes = getNodesRef.current();
			const selectedIds = new Set<string>();

			for (const node of allNodes) {
				const w = node.measured?.width ?? node.width ?? 280;
				const h = node.measured?.height ?? node.height ?? 120;
				if (rectIntersectsPolygon(node.position.x, node.position.y, w, h, flowPolygon)) {
					selectedIds.add(node.id);
				}
			}

			onSelectRef.current(selectedIds);
		};

		const doStop = () => {
			if (!drawingRef.current) return;
			drawingRef.current = false;
			doFinish();
			currentPointsRef.current = [];
			setPoints([]);
			setActive(false);

			// After lasso ends, mouseup triggers a click on the pane which
			// causes React Flow to deselect all nodes. Block that click.
			const blocker = (e: Event) => {
				e.stopPropagation();
				e.preventDefault();
			};
			el.addEventListener("click", blocker, { capture: true, once: true });
			// Safety: remove if it didn't fire (e.g. touch path)
			setTimeout(() => el.removeEventListener("click", blocker, { capture: true }), 100);
		};

		const beginLasso = (x: number, y: number) => {
			drawingRef.current = true;
			currentPointsRef.current = [{ x, y }];
			setPoints(currentPointsRef.current);
			setActive(true);
		};

		// --- Mouse lasso ---
		const onMouseDown = (e: MouseEvent) => {
			if (pcDragModeRef.current !== "select") return;
			if (e.button !== 0) return;
			if (!isOnPane(e.target as HTMLElement)) return;
			beginLasso(e.clientX, e.clientY);
		};

		const onMouseMove = (e: MouseEvent) => {
			if (!drawingRef.current) return;
			currentPointsRef.current.push({ x: e.clientX, y: e.clientY });
			setPoints([...currentPointsRef.current]);
		};

		const onMouseUp = () => doStop();

		// --- Touch lasso via contextmenu (long-press on mobile) ---
		const onContextMenu = (e: Event) => {
			const target = e.target as HTMLElement;
			if (!el.contains(target)) return;
			if (!canStartTouchLasso(target)) return;

			e.preventDefault();
			e.stopPropagation();
			// Clear previous selection so the toolbar disappears immediately,
			// preventing it from capturing subsequent touch events.
			onSelectRef.current(new Set());
			cancelPan();
			beginLasso((e as MouseEvent).clientX, (e as MouseEvent).clientY);
		};

		// Touch move/end use capture + non-passive so we can block d3-zoom pan.
		const onTouchMove = (e: TouchEvent) => {
			if (!drawingRef.current) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.touches.length !== 1) return;
			const t = e.touches[0];
			currentPointsRef.current.push({ x: t.clientX, y: t.clientY });
			setPoints([...currentPointsRef.current]);
		};

		const onTouchEnd = () => doStop();

		el.addEventListener("mousedown", onMouseDown);
		window.addEventListener("mousemove", onMouseMove);
		window.addEventListener("mouseup", onMouseUp);
		document.addEventListener("contextmenu", onContextMenu, { capture: true });
		document.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
		document.addEventListener("touchend", onTouchEnd, { capture: true });
		document.addEventListener("touchcancel", onTouchEnd, { capture: true });

		return () => {
			el.removeEventListener("mousedown", onMouseDown);
			window.removeEventListener("mousemove", onMouseMove);
			window.removeEventListener("mouseup", onMouseUp);
			document.removeEventListener("contextmenu", onContextMenu, { capture: true });
			document.removeEventListener("touchmove", onTouchMove, { capture: true });
			document.removeEventListener("touchend", onTouchEnd, { capture: true });
			document.removeEventListener("touchcancel", onTouchEnd, { capture: true });
		};
		// Effect runs once — all mutable state accessed via refs.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const svgPath = buildSvgPath(points);

	return (
		<div ref={wrapperRef} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
			{active && svgPath && (
				<svg
					role="img"
					aria-label="selection lasso"
					style={{
						position: "fixed",
						inset: 0,
						width: "100vw",
						height: "100vh",
						pointerEvents: "none",
						zIndex: 1000,
					}}
				>
					<path
						d={svgPath}
						fill="rgba(99, 102, 241, 0.08)"
						stroke="var(--mantine-color-indigo-5)"
						strokeWidth={1.5}
						strokeDasharray="6 3"
					/>
				</svg>
			)}
		</div>
	);
}
