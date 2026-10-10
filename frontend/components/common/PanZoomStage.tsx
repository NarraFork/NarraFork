import { ActionIcon, Box, Group, Text, Tooltip } from "@mantine/core";
import { IconX, IconZoomIn, IconZoomOut, IconZoomReset } from "@tabler/icons-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";

/**
 * A fullscreen overlay or embedded pan/zoom stage shared by the image viewer
 * and the mermaid diagram fullscreen view. It owns the transform state and all gesture handling
 * (mouse-wheel zoom, drag-pan, two-finger pinch-zoom/pan, keyboard shortcuts)
 * and renders arbitrary `children` as the zoomable content. Feature-specific
 * toolbar buttons are supplied via `renderToolbarExtra`, which receives imperative
 * controls (zoom/reset/rotate) so consumers can wire their own actions.
 */

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
const WHEEL_ZOOM_STEP = 0.0015;
const BUTTON_ZOOM_FACTOR = 1.25;
/**
 * Max pointer travel (px) still treated as a click rather than a drag. Beyond
 * this the gesture is a pan, so a backdrop release will NOT close the overlay.
 */
const BACKDROP_CLICK_MOVE_TOLERANCE_PX = 3;

interface Transform {
	scale: number;
	tx: number;
	ty: number;
	rotation: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0, rotation: 0 };

function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export interface PanZoomControls {
	zoomByFactor: (factor: number) => void;
	reset: () => void;
	rotate: (delta: number) => void;
}

/**
 * Toolbar tooltips are portaled to <body> and would otherwise render at
 * Mantine's default popover z-index (~300), i.e. BEHIND this overlay
 * (Z.imageViewer). Consumers building toolbar-extra tooltips should reuse this
 * value so their tooltips sit above the overlay too.
 */
export const PANZOOM_TOOLTIP_Z = Z.imageViewer + 1;

export interface PanZoomStageProps {
	/** Zoomable content (an <img>, inline SVG host, etc.). */
	children: ReactNode;
	onClose?: () => void;
	/** Fit the parent panel without locking document scrolling or global shortcuts. */
	embedded?: boolean;
	/** Extra toolbar buttons inserted between the reset button and close. */
	renderToolbarExtra?: (controls: PanZoomControls) => ReactNode;
	/** Enable the `r` / `Shift+r` rotate keyboard shortcut. Default false. */
	enableRotateKey?: boolean;
	/** Close when a click without drag lands on the empty backdrop. Default false. */
	closeOnBackdropClick?: boolean;
	/** Right-click handler (e.g. to open a context menu). */
	onContextMenu?: (e: React.MouseEvent) => void;
}

export function PanZoomStage({
	children,
	onClose,
	embedded = false,
	renderToolbarExtra,
	enableRotateKey = false,
	closeOnBackdropClick = false,
	onContextMenu,
}: PanZoomStageProps) {
	const { t } = useTranslation("common");
	const [transform, setTransform] = useState<Transform>(IDENTITY);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const transformRef = useRef(transform);
	transformRef.current = transform;

	// Pointer tracking for drag-pan and pinch-zoom
	const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
	const dragState = useRef<{
		startTx: number;
		startTy: number;
		startX: number;
		startY: number;
		moved: boolean;
	} | null>(null);
	const pinchState = useRef<{ lastMidX: number; lastMidY: number; lastDist: number } | null>(null);
	// Whether the current gesture still qualifies as a plain "backdrop click"
	// (→ close). It qualifies only if it began on the empty backdrop with a single
	// pointer, never became a pinch, never moved past the drag threshold, and is
	// released back on the empty backdrop. Any of those violations clears it, so a
	// drag / pan / pinch / wheel-zoom never closes the overlay.
	const backdropClickCandidate = useRef(false);

	const reset = useCallback(() => setTransform(IDENTITY), []);

	// Zoom around a viewport anchor point so the pixel under the cursor stays put.
	const zoomAt = useCallback((nextScale: number, anchorX: number, anchorY: number) => {
		setTransform((prev) => {
			const container = containerRef.current;
			if (!container) return prev;
			const rect = container.getBoundingClientRect();
			const cx = rect.left + rect.width / 2;
			const cy = rect.top + rect.height / 2;
			const clamped = clampScale(nextScale);
			const ratio = clamped / prev.scale;
			const originX = cx + prev.tx;
			const originY = cy + prev.ty;
			const tx = prev.tx + (anchorX - originX) * (1 - ratio);
			const ty = prev.ty + (anchorY - originY) * (1 - ratio);
			return { ...prev, scale: clamped, tx, ty };
		});
	}, []);

	// Incrementally apply a two-finger gesture: scale around the current midpoint
	// by `scaleRatio` AND translate by the midpoint's own movement, so the content
	// can be zoomed and panned at the same time (pixels under the fingers stay put).
	const pinchStep = useCallback(
		(scaleRatio: number, midX: number, midY: number, panDx: number, panDy: number) => {
			setTransform((prev) => {
				const container = containerRef.current;
				if (!container) return prev;
				const rect = container.getBoundingClientRect();
				const cx = rect.left + rect.width / 2;
				const cy = rect.top + rect.height / 2;
				const clamped = clampScale(prev.scale * scaleRatio);
				const ratio = clamped / prev.scale;
				const originX = cx + prev.tx;
				const originY = cy + prev.ty;
				const tx = prev.tx + (midX - originX) * (1 - ratio) + panDx;
				const ty = prev.ty + (midY - originY) * (1 - ratio) + panDy;
				return { ...prev, scale: clamped, tx, ty };
			});
		},
		[],
	);

	const zoomByFactor = useCallback(
		(factor: number) => {
			const container = containerRef.current;
			const rect = container?.getBoundingClientRect();
			const anchorX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
			const anchorY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
			zoomAt(transformRef.current.scale * factor, anchorX, anchorY);
		},
		[zoomAt],
	);

	const rotate = useCallback((delta: number) => {
		setTransform((prev) => ({ ...prev, rotation: prev.rotation + delta }));
	}, []);

	// Keyboard shortcuts
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (embedded) {
				const target = e.target instanceof Element ? e.target : null;
				if (
					!stageRef.current?.contains(document.activeElement) ||
					document.querySelector('[data-panzoom-mode="fullscreen"]') ||
					e.ctrlKey ||
					e.metaKey ||
					e.altKey ||
					target?.closest(
						'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
					)
				)
					return;
			}
			if (e.key === "Escape" && onClose) {
				e.preventDefault();
				onClose();
			} else if (e.key === "+" || e.key === "=") {
				e.preventDefault();
				zoomByFactor(BUTTON_ZOOM_FACTOR);
			} else if (e.key === "-" || e.key === "_") {
				e.preventDefault();
				zoomByFactor(1 / BUTTON_ZOOM_FACTOR);
			} else if (e.key === "0") {
				e.preventDefault();
				reset();
			} else if (enableRotateKey && e.key.toLowerCase() === "r") {
				e.preventDefault();
				rotate(e.shiftKey ? -90 : 90);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, zoomByFactor, reset, rotate, enableRotateKey, embedded]);

	// Lock background scroll while the overlay is open
	useEffect(() => {
		if (embedded) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, [embedded]);

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			// Wheel-zoom is an interaction, not a click — never close afterwards.
			backdropClickCandidate.current = false;
			const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_STEP);
			zoomAt(transformRef.current.scale * factor, e.clientX, e.clientY);
		},
		[zoomAt],
	);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button === 2) return; // right-click handled by context menu
		// A backdrop-click candidate must START on the empty backdrop (the canvas
		// element itself, not the content) with a single pointer. A second pointer
		// (pinch) later invalidates it.
		const onBackdrop = e.target === e.currentTarget;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 1) {
			backdropClickCandidate.current = onBackdrop;
			dragState.current = {
				startTx: transformRef.current.tx,
				startTy: transformRef.current.ty,
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
			};
		} else if (pointers.current.size === 2) {
			// Second finger → pinch gesture, never a click.
			backdropClickCandidate.current = false;
			const pts = [...pointers.current.values()];
			const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
			pinchState.current = {
				lastMidX: (pts[0].x + pts[1].x) / 2,
				lastMidY: (pts[0].y + pts[1].y) / 2,
				lastDist: dist,
			};
			dragState.current = null;
		}
	}, []);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!pointers.current.has(e.pointerId)) return;
			pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

			if (pointers.current.size >= 2 && pinchState.current) {
				const pts = [...pointers.current.values()];
				const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
				const midX = (pts[0].x + pts[1].x) / 2;
				const midY = (pts[0].y + pts[1].y) / 2;
				const prev = pinchState.current;
				const scaleRatio = prev.lastDist > 0 ? dist / prev.lastDist : 1;
				const panDx = midX - prev.lastMidX;
				const panDy = midY - prev.lastMidY;
				pinchStep(scaleRatio, midX, midY, panDx, panDy);
				pinchState.current = { lastMidX: midX, lastMidY: midY, lastDist: dist };
				return;
			}

			if (dragState.current) {
				const dx = e.clientX - dragState.current.startX;
				const dy = e.clientY - dragState.current.startY;
				if (
					Math.abs(dx) > BACKDROP_CLICK_MOVE_TOLERANCE_PX ||
					Math.abs(dy) > BACKDROP_CLICK_MOVE_TOLERANCE_PX
				) {
					dragState.current.moved = true;
					// Any real movement turns this into a pan, not a click.
					backdropClickCandidate.current = false;
				}
				setTransform((prev) => ({
					...prev,
					tx: dragState.current ? dragState.current.startTx + dx : prev.tx,
					ty: dragState.current ? dragState.current.startTy + dy : prev.ty,
				}));
			}
		},
		[pinchStep],
	);

	const handlePointerUp = useCallback(
		(e: React.PointerEvent) => {
			pointers.current.delete(e.pointerId);
			if (pointers.current.size < 2) {
				pinchState.current = null;
				if (pointers.current.size === 1) {
					const [p] = [...pointers.current.values()];
					dragState.current = {
						startTx: transformRef.current.tx,
						startTy: transformRef.current.ty,
						startX: p.x,
						startY: p.y,
						moved: true,
					};
				}
			}
			if (pointers.current.size === 0) {
				const wasDrag = dragState.current?.moved;
				const wasBackdropCandidate = backdropClickCandidate.current;
				dragState.current = null;
				backdropClickCandidate.current = false;
				// Only a genuine click on empty backdrop closes: it must have started
				// on the backdrop, stayed a click (no drag/pinch/wheel), AND be
				// released back over the backdrop (not over the image / a toolbar
				// button that happens to overlap the release point).
				if (!wasDrag && closeOnBackdropClick && wasBackdropCandidate) {
					const releaseTarget = document.elementFromPoint(e.clientX, e.clientY);
					if (releaseTarget === containerRef.current) onClose?.();
				}
			}
		},
		[onClose, closeOnBackdropClick],
	);

	// A cancelled gesture (browser took over, e.g. OS gesture) is never a click —
	// drop all pointers and clear the close candidate without invoking onClose.
	const handlePointerCancel = useCallback((e: React.PointerEvent) => {
		pointers.current.delete(e.pointerId);
		if (pointers.current.size < 2) pinchState.current = null;
		if (pointers.current.size === 0) {
			dragState.current = null;
			backdropClickCandidate.current = false;
		}
	}, []);

	const controls: PanZoomControls = { zoomByFactor, reset, rotate };
	const scalePercent = Math.round(transform.scale * 100);
	const gesturing = pointers.current.size > 0;

	return (
		<Box
			ref={stageRef}
			tabIndex={embedded ? 0 : undefined}
			data-panzoom-mode={embedded ? "embedded" : "fullscreen"}
			onPointerDownCapture={
				embedded ? () => stageRef.current?.focus({ preventScroll: true }) : undefined
			}
			style={{
				position: embedded ? "relative" : "fixed",
				inset: embedded ? undefined : 0,
				width: embedded ? "100%" : undefined,
				height: embedded ? "100%" : undefined,
				minHeight: 0,
				overflow: "hidden",
				zIndex: embedded ? undefined : Z.imageViewer,
				background: "rgba(0, 0, 0, 0.85)",
				backdropFilter: "blur(2px)",
				display: "flex",
				flexDirection: "column",
			}}
		>
			{/* Toolbar */}
			<Group
				className="nf-panzoom-toolbar"
				gap={4}
				px="md"
				py="xs"
				justify="center"
				style={{
					position: embedded ? "relative" : "absolute",
					flexShrink: 0,
					top: 0,
					left: 0,
					right: 0,
					zIndex: 2,
				}}
				onPointerDown={(e) => e.stopPropagation()}
			>
				<Group
					gap={4}
					p={4}
					style={{
						background: "rgba(0, 0, 0, 0.55)",
						borderRadius: "var(--mantine-radius-md)",
					}}
				>
					<Tooltip label={t("imageViewer_zoomOut")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => zoomByFactor(1 / BUTTON_ZOOM_FACTOR)}
							aria-label={t("imageViewer_zoomOut")}
						>
							<IconZoomOut size={18} />
						</ActionIcon>
					</Tooltip>
					<Text size="xs" c="gray.3" w={44} ta="center" style={{ userSelect: "none" }}>
						{scalePercent}%
					</Text>
					<Tooltip label={t("imageViewer_zoomIn")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => zoomByFactor(BUTTON_ZOOM_FACTOR)}
							aria-label={t("imageViewer_zoomIn")}
						>
							<IconZoomIn size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_reset")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={reset}
							aria-label={t("imageViewer_reset")}
						>
							<IconZoomReset size={18} />
						</ActionIcon>
					</Tooltip>
					{renderToolbarExtra?.(controls)}
					{onClose && (
						<Tooltip label={t("imageViewer_close")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={onClose}
								aria-label={t("imageViewer_close")}
							>
								<IconX size={18} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>

			{/* Canvas */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: interactive zoom/pan canvas; keyboard shortcuts handled globally */}
			<div
				ref={containerRef}
				onWheel={handleWheel}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerCancel}
				onContextMenu={onContextMenu}
				style={{
					flex: 1,
					minHeight: 0,
					minWidth: 0,
					containerType: embedded ? "size" : undefined,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					overflow: "hidden",
					touchAction: "none",
					// Prevent drag-pan from selecting text inside SVG diagrams.
					userSelect: "none",
					WebkitUserSelect: "none",
					cursor: transform.scale > 1 ? "grab" : "default",
				}}
			>
				<div
					style={{
						transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
						transformOrigin: "center center",
						transition: gesturing ? "none" : "transform 0.12s ease-out",
						willChange: "transform",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					{children}
				</div>
			</div>
		</Box>
	);
}
