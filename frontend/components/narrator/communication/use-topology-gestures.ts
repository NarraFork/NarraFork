import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { type PanZoomTransform, pinchStep, zoomAround } from "../../common/pan-zoom-math";

export type TopologyDrag = { kind: "node" | "peer"; id: string };
interface ActivePointer {
	x: number;
	y: number;
	startX: number;
	startY: number;
}
interface Gesture {
	kind: "idle" | "armed" | "pan" | "drag" | "pinch";
	drag?: TopologyDrag;
	longPress?: ReturnType<typeof setTimeout>;
}
export interface TopologyGestureOptions {
	width: number;
	height: number;
	sceneWidth: number;
	sceneHeight: number;
	active: boolean;
	onHover: (drag: TopologyDrag, x: number, y: number) => void;
	onDrop: (drag: TopologyDrag, x: number, y: number) => void;
	onCancel: () => void;
}
const clampScale = (scale: number) => Math.min(1.8, Math.max(0.6, scale));

/** Own only this canvas. Drawers, toolbars and relation lists retain native scrolling. */
export function useTopologyGestures(options: TopologyGestureOptions) {
	const canvasRef = useRef<HTMLDivElement>(null);
	const optionsRef = useRef(options);
	optionsRef.current = options;
	const pointers = useRef(new Map<number, ActivePointer>());
	const gesture = useRef<Gesture>({ kind: "idle" });
	const [drag, setDrag] = useState<TopologyDrag | null>(null);
	const [transform, setTransform] = useState<PanZoomTransform>({ scale: 1, tx: 0, ty: 0 });
	const transformRef = useRef(transform);
	const suppressClick = useRef(false);
	const lastPosition = useRef({ x: 0, y: 0 });
	const apply = useCallback((next: PanZoomTransform) => {
		const { width, height, sceneWidth, sceneHeight } = optionsRef.current;
		const bounded = {
			...next,
			tx: Math.min(70, Math.max(Math.min(0, width - sceneWidth * next.scale) - 70, next.tx)),
			ty: Math.min(70, Math.max(Math.min(0, height - sceneHeight * next.scale) - 70, next.ty)),
		};
		transformRef.current = bounded;
		setTransform(bounded);
	}, []);
	const clearTimer = useCallback(() => {
		if (gesture.current.longPress) clearTimeout(gesture.current.longPress);
	}, []);
	const cancel = useCallback(() => {
		clearTimer();
		gesture.current = { kind: "idle" };
		pointers.current.clear();
		setDrag(null);
		optionsRef.current.onCancel();
	}, [clearTimer]);
	useEffect(() => {
		window.addEventListener("blur", cancel);
		return () => {
			window.removeEventListener("blur", cancel);
			clearTimer();
		};
	}, [cancel, clearTimer]);
	useEffect(() => {
		if (!options.active) cancel();
	}, [options.active, cancel]);
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !options.active) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) {
				const rect = canvas.getBoundingClientRect();
				apply(
					zoomAround(
						transformRef.current,
						clampScale(transformRef.current.scale * Math.exp(-event.deltaY * 0.002)),
						{ x: event.clientX - rect.left, y: event.clientY - rect.top },
						{ x: 0, y: 0 },
					),
				);
			} else
				apply({
					...transformRef.current,
					tx: transformRef.current.tx - event.deltaX,
					ty: transformRef.current.ty - event.deltaY,
				});
		};
		canvas.addEventListener("wheel", wheel, { passive: false });
		return () => canvas.removeEventListener("wheel", wheel);
	}, [apply, options.active]);
	useEffect(() => {
		if (!drag) return;
		let frame: number;
		const step = () => {
			const rect = canvasRef.current?.getBoundingClientRect();
			if (rect) {
				const { x, y } = lastPosition.current;
				const dx = x < rect.left + 32 ? 5 : x > rect.right - 32 ? -5 : 0;
				const dy = y < rect.top + 32 ? 5 : y > rect.bottom - 72 ? -5 : 0;
				if (dx || dy) {
					apply({
						...transformRef.current,
						tx: transformRef.current.tx + dx,
						ty: transformRef.current.ty + dy,
					});
					optionsRef.current.onHover(drag, x, y);
				}
			}
			frame = requestAnimationFrame(step);
		};
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [drag, apply]);

	function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		const target = event.target as Element;
		const handle = target.closest<HTMLElement>("[data-topology-handle]");
		const node = target.closest<HTMLElement>("[data-topology-node]");
		if (!handle && !target.closest("[data-topology-select]") && target.closest("button,a,input"))
			return;
		suppressClick.current = false;
		pointers.current.set(event.pointerId, {
			x: event.clientX,
			y: event.clientY,
			startX: event.clientX,
			startY: event.clientY,
		});
		lastPosition.current = { x: event.clientX, y: event.clientY };
		// Capture the concrete target, not the ancestor canvas: SVG edge clicks and card
		// buttons must retain their native click target while movement still bubbles here.
		target.setPointerCapture(event.pointerId);
		if (pointers.current.size > 1) {
			clearTimer();
			gesture.current = { kind: "pinch" };
			setDrag(null);
			optionsRef.current.onCancel();
			return;
		}
		if (handle) {
			const next: TopologyDrag = {
				kind: handle.dataset.topologyHandle === "peer" ? "peer" : "node",
				id: handle.dataset.dragId ?? "",
			};
			gesture.current = { kind: "drag", drag: next };
			setDrag(next);
			optionsRef.current.onHover(next, event.clientX, event.clientY);
		} else {
			gesture.current = { kind: "armed" };
			if (node && event.pointerType === "touch" && node.dataset.draggable === "true") {
				const next: TopologyDrag = { kind: "node", id: node.dataset.topologyNode ?? "" };
				gesture.current.longPress = setTimeout(() => {
					gesture.current = { kind: "drag", drag: next };
					setDrag(next);
					optionsRef.current.onHover(next, lastPosition.current.x, lastPosition.current.y);
				}, 380);
			}
		}
	}
	function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
		const point = pointers.current.get(event.pointerId);
		if (!point) return;
		const before = [...pointers.current.values()].map((p) => ({ ...p }));
		const dx = event.clientX - point.x;
		const dy = event.clientY - point.y;
		point.x = event.clientX;
		point.y = event.clientY;
		lastPosition.current = { x: event.clientX, y: event.clientY };
		if (gesture.current.kind === "pinch" && before.length >= 2) {
			const after = [...pointers.current.values()];
			const oldMid = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
			const mid = { x: (after[0].x + after[1].x) / 2, y: (after[0].y + after[1].y) / 2 };
			const oldDistance = Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y);
			const distance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
			const rect = canvasRef.current?.getBoundingClientRect();
			if (rect && oldDistance > 0)
				apply(
					pinchStep(
						transformRef.current,
						distance / oldDistance,
						{ x: mid.x - rect.left, y: mid.y - rect.top },
						{ x: mid.x - oldMid.x, y: mid.y - oldMid.y },
						{ x: 0, y: 0 },
						clampScale,
					),
				);
			suppressClick.current = true;
			return;
		}
		if (
			gesture.current.kind === "armed" &&
			Math.hypot(point.x - point.startX, point.y - point.startY) > 7
		) {
			clearTimer();
			gesture.current = { kind: "pan" };
		}
		if (gesture.current.kind === "pan") {
			apply({
				...transformRef.current,
				tx: transformRef.current.tx + dx,
				ty: transformRef.current.ty + dy,
			});
			suppressClick.current = true;
		}
		if (gesture.current.kind === "drag" && gesture.current.drag) {
			suppressClick.current = true;
			optionsRef.current.onHover(gesture.current.drag, event.clientX, event.clientY);
		}
	}
	function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
		if (gesture.current.kind === "drag" && gesture.current.drag)
			optionsRef.current.onDrop(gesture.current.drag, event.clientX, event.clientY);
		pointers.current.delete(event.pointerId);
		clearTimer();
		if (pointers.current.size) {
			gesture.current = { kind: "pan" };
			setDrag(null);
			return;
		}
		gesture.current = { kind: "idle" };
		setDrag(null);
		optionsRef.current.onCancel();
	}
	return {
		canvasRef,
		drag,
		transform,
		cancel,
		reset: () => apply({ scale: 1, tx: 0, ty: 0 }),
		zoom: (factor: number) =>
			apply(
				zoomAround(
					transformRef.current,
					clampScale(transformRef.current.scale * factor),
					{ x: options.width / 2, y: options.height / 2 },
					{ x: 0, y: 0 },
				),
			),
		canvasHandlers: {
			onPointerDown,
			onPointerMove,
			onPointerUp,
			onPointerCancel: cancel,
			onClickCapture: (event: React.MouseEvent) => {
				if (suppressClick.current) {
					event.stopPropagation();
					suppressClick.current = false;
				}
			},
		},
	};
}
