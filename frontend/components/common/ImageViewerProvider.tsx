import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCopy, IconDownload, IconRotate2, IconRotateClockwise2 } from "@tabler/icons-react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyImageSourceToClipboard, downloadImageSource } from "../../lib/image-actions";
import { Z } from "../../lib/z-index";
import { PANZOOM_TOOLTIP_Z, PanZoomStage } from "./PanZoomStage";

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
	const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

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

	const handleContextMenu = useCallback((e: React.MouseEvent) => {
		e.preventDefault();
		setMenu({ x: e.clientX, y: e.clientY });
	}, []);

	return (
		<PanZoomStage
			onClose={onClose}
			onContextMenu={handleContextMenu}
			enableRotateKey
			closeOnBackdropClick
			renderToolbarExtra={({ rotate }) => (
				<>
					<Tooltip label={t("imageViewer_rotateLeft")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => rotate(-90)}
							aria-label={t("imageViewer_rotateLeft")}
						>
							<IconRotate2 size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_rotateRight")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => rotate(90)}
							aria-label={t("imageViewer_rotateRight")}
						>
							<IconRotateClockwise2 size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_copy")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => void handleCopy()}
							aria-label={t("imageViewer_copy")}
						>
							<IconCopy size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label={t("imageViewer_download")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
						<ActionIcon
							variant="subtle"
							color="gray"
							onClick={() => void handleDownload()}
							aria-label={t("imageViewer_download")}
						>
							<IconDownload size={18} />
						</ActionIcon>
					</Tooltip>
				</>
			)}
		>
			<img
				src={options.src}
				alt={options.alt ?? "image"}
				draggable={false}
				style={{
					maxWidth: "90vw",
					maxHeight: "90vh",
					objectFit: "contain",
					userSelect: "none",
					display: "block",
				}}
			/>
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
		</PanZoomStage>
	);
}

export function useImageViewer() {
	const ctx = useContext(ImageViewerContext);
	if (!ctx) {
		throw new Error("useImageViewer must be used within ImageViewerProvider");
	}
	return ctx.open;
}
