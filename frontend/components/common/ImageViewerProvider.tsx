import { ActionIcon, Box, Group, Menu, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconCopy,
	IconDownload,
	IconRotate2,
	IconRotateClockwise2,
	IconX,
	IconZoomIn,
	IconZoomOut,
	IconZoomReset,
} from "@tabler/icons-react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyImageSourceToClipboard, downloadImageSource } from "../../lib/image-actions";
import { Z } from "../../lib/z-index";

/**
 * Options describing the image to open in the fullscreen viewer.
 *
 * `src` is the directly-displayable URL (blob:/data:/http(s)/relative). It is
 * used both for on-screen rendering and as the primary source for copy/download.
 * `savedPath` is an optional server-side file path used as a fallback source for
 * copy/download when `src` is a bounded preview that may not be the full image.
 */
export interface ImageViewerOptions {
	src: string;
	/** Optional server file path fetched via /api/fs/preview for copy/download. */
	savedPath?: string | null;
	/** Suggested download filename (extension optional). */
	filename?: string | null;
	/** Accessible alt text / title. */
	alt?: string | null;
}

interface ImageViewerContextValue {
	open: (options: ImageViewerOptions) => void;
}

const ImageViewerContext = createContext<ImageViewerContextValue | null>(null);

const MIN_SCALE = 0.1;
const MAX_SCALE = 12;
const WHEEL_ZOOM_STEP = 0.0015;
const BUTTON_ZOOM_FACTOR = 1.25;

interface Transform {
	scale: number;
	// translation in CSS pixels applied to the image element
	tx: number;
	ty: number;
	rotation: number;
}

const IDENTITY: Transform = { scale: 1, tx: 0, ty: 0, rotation: 0 };

function clampScale(scale: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

function deriveFilename(options: ImageViewerOptions): string {
	const fromName = options.filename?.split(/[\\/]/).pop()?.trim();
	if (fromName) return fromName;
	const fromPath = options.savedPath?.split(/[\\/]/).pop()?.trim();
	if (fromPath) return fromPath;
	// Try to pull a name from a URL path
	try {
		const url = new URL(options.src, window.location.origin);
		const last = url.pathname.split("/").pop()?.trim();
		if (last) return last;
	} catch {
		// ignore
	}
	return "image";
}

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
	const { t } = useTranslation("common");
	const [options, setOptions] = useState<ImageViewerOptions | null>(null);

	const open = useCallback((next: ImageViewerOptions) => {
		if (!next?.src) return;
		setOptions(next);
	}, []);

	const close = useCallback(() => setOptions(null), []);

	const value = useMemo(() => ({ open }), [open]);

	return (
		<ImageViewerContext.Provider value={value}>
			{children}
			{options &&
				createPortal(<ImageViewerOverlay options={options} onClose={close} t={t} />, document.body)}
		</ImageViewerContext.Provider>
	);
}

function ImageViewerOverlay({
	options,
	onClose,
	t,
}: {
	options: ImageViewerOptions;
	onClose: () => void;
	t: (key: string, opts?: Record<string, unknown>) => string;
}) {
	const [transform, setTransform] = useState<Transform>(IDENTITY);
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
	// Whether the current gesture began on the backdrop (not the image itself),
	// so a click-without-drag on empty space closes the viewer.
	const downOnBackdrop = useRef(false);

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
			// Vector from image center (which sits at container center + translation)
			const originX = cx + prev.tx;
			const originY = cy + prev.ty;
			const tx = prev.tx + (anchorX - originX) * (1 - ratio);
			const ty = prev.ty + (anchorY - originY) * (1 - ratio);
			return { ...prev, scale: clamped, tx, ty };
		});
	}, []);

	// Incrementally apply a two-finger gesture: scale around the current midpoint
	// by `scaleRatio` AND translate by the midpoint's own movement, so the image
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
				// Image center currently sits at (container center + translation).
				const originX = cx + prev.tx;
				const originY = cy + prev.ty;
				// Zoom around the midpoint, then add the midpoint's own pan delta.
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

	const handleCopy = useCallback(async () => {
		try {
			await copyImageSourceToClipboard({ imageSrc: options.src, savedPath: options.savedPath });
			notifications.show({ color: "teal", message: t("imageViewer_copySuccess") });
		} catch {
			notifications.show({ color: "red", message: t("imageViewer_copyFailed") });
		}
	}, [options.src, options.savedPath, t]);

	const handleDownload = useCallback(async () => {
		try {
			await downloadImageSource({
				imageSrc: options.src,
				savedPath: options.savedPath,
				filename: deriveFilename(options),
			});
		} catch {
			notifications.show({ color: "red", message: t("imageViewer_downloadFailed") });
		}
	}, [options, t]);

	// Keyboard shortcuts
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
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
			} else if (e.key.toLowerCase() === "r") {
				e.preventDefault();
				rotate(e.shiftKey ? -90 : 90);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, zoomByFactor, reset, rotate]);

	// Lock background scroll while the viewer is open
	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, []);

	const handleWheel = useCallback(
		(e: React.WheelEvent) => {
			e.preventDefault();
			const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_STEP);
			zoomAt(transformRef.current.scale * factor, e.clientX, e.clientY);
		},
		[zoomAt],
	);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (e.button === 2) return; // right-click handled by context menu
		// Record whether the press landed on empty backdrop vs. the image, before
		// pointer capture retargets subsequent events to the container.
		downOnBackdrop.current = e.target === e.currentTarget;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pointers.current.size === 1) {
			dragState.current = {
				startTx: transformRef.current.tx,
				startTy: transformRef.current.ty,
				startX: e.clientX,
				startY: e.clientY,
				moved: false,
			};
		} else if (pointers.current.size === 2) {
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
				if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.current.moved = true;
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
				// If a finger remains, hand control back to single-finger panning
				// starting from the current transform (avoids a jump on lift-off).
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
				// A click without movement on the backdrop closes the viewer.
				const wasDrag = dragState.current?.moved;
				dragState.current = null;
				if (!wasDrag && downOnBackdrop.current) onClose();
			}
		},
		[onClose],
	);

	const handleContextMenu = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY });
	}, []);

	const scalePercent = Math.round(transform.scale * 100);

	return (
		<Box
			style={{
				position: "fixed",
				inset: 0,
				zIndex: Z.imageViewer,
				background: "rgba(0, 0, 0, 0.85)",
				backdropFilter: "blur(2px)",
				display: "flex",
				flexDirection: "column",
			}}
		>
			{/* Toolbar */}
			<Group
				gap={4}
				px="md"
				py="xs"
				justify="center"
				style={{
					position: "absolute",
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
					<Tooltip label={t("imageViewer_zoomOut")} withinPortal>
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
					<Tooltip label={t("imageViewer_zoomIn")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => zoomByFactor(BUTTON_ZOOM_FACTOR)}
							aria-label={t("imageViewer_zoomIn")}
						>
							<IconZoomIn size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_reset")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={reset}
							aria-label={t("imageViewer_reset")}
						>
							<IconZoomReset size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_rotateLeft")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => rotate(-90)}
							aria-label={t("imageViewer_rotateLeft")}
						>
							<IconRotate2 size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_rotateRight")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => rotate(90)}
							aria-label={t("imageViewer_rotateRight")}
						>
							<IconRotateClockwise2 size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_copy")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => void handleCopy()}
							aria-label={t("imageViewer_copy")}
						>
							<IconCopy size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_download")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => void handleDownload()}
							aria-label={t("imageViewer_download")}
						>
							<IconDownload size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_close")} withinPortal>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={onClose}
							aria-label={t("imageViewer_close")}
						>
							<IconX size={18} />
						</ActionIcon>
					</Tooltip>
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
				onPointerCancel={handlePointerUp}
				onContextMenu={handleContextMenu}
				style={{
					flex: 1,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					overflow: "hidden",
					touchAction: "none",
					cursor: transform.scale > 1 ? "grab" : "default",
				}}
			>
				<img
					src={options.src}
					alt={options.alt ?? "image"}
					draggable={false}
					style={{
						maxWidth: "90vw",
						maxHeight: "90vh",
						objectFit: "contain",
						transform: `translate(${transform.tx}px, ${transform.ty}px) scale(${transform.scale}) rotate(${transform.rotation}deg)`,
						transformOrigin: "center center",
						transition: pointers.current.size > 0 ? "none" : "transform 0.12s ease-out",
						userSelect: "none",
						willChange: "transform",
					}}
				/>
			</div>

			{menu &&
				createPortal(
					<Menu
						opened
						onClose={() => setMenu(null)}
						position="bottom-start"
						withinPortal
						zIndex={Z.imageViewer + 1}
						styles={{
							dropdown: {
								position: "fixed",
								left: Math.min(menu.x, window.innerWidth - 200),
								top: Math.min(menu.y, window.innerHeight - 120),
							},
						}}
					>
						<Menu.Target>
							<div
								style={{ position: "fixed", left: menu.x, top: menu.y, pointerEvents: "none" }}
							/>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item
								leftSection={<IconCopy size={14} />}
								onClick={() => {
									void handleCopy();
									setMenu(null);
								}}
							>
								{t("imageViewer_copy")}
							</Menu.Item>
							<Menu.Item
								leftSection={<IconDownload size={14} />}
								onClick={() => {
									void handleDownload();
									setMenu(null);
								}}
							>
								{t("imageViewer_download")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>,
					document.body,
				)}
		</Box>
	);
}

export function useImageViewer() {
	const ctx = useContext(ImageViewerContext);
	if (!ctx) {
		throw new Error("useImageViewer must be used within ImageViewerProvider");
	}
	return ctx.open;
}
