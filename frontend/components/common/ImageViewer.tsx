import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	IconCopy,
	IconDownload,
	IconMaximize,
	IconRotate2,
	IconRotateClockwise2,
} from "@tabler/icons-react";
import { useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyImageSourceToClipboard, downloadImageSource } from "../../lib/image-actions";
import { Z } from "../../lib/z-index";
import type { ImageViewerOptions } from "./image-viewer-context";
import { PANZOOM_TOOLTIP_Z, PanZoomStage } from "./PanZoomStage";

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

export interface ImageViewerProps {
	options: ImageViewerOptions;
	embedded?: boolean;
	onClose?: () => void;
	onFullscreen?: () => void;
	onError?: React.ReactEventHandler<HTMLImageElement>;
}

export function ImageViewer({
	options,
	embedded = false,
	onClose,
	onFullscreen,
	onError,
}: ImageViewerProps) {
	const { t } = useTranslation("common");
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
			key={options.src}
			embedded={embedded}
			onClose={onClose}
			onContextMenu={handleContextMenu}
			enableRotateKey
			closeOnBackdropClick={!embedded}
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
					{embedded && onFullscreen && (
						<Tooltip label={t("imageViewer_fullscreen")} withinPortal zIndex={PANZOOM_TOOLTIP_Z}>
							<ActionIcon
								variant="subtle"
								color="gray"
								onClick={onFullscreen}
								aria-label={t("imageViewer_fullscreen")}
							>
								<IconMaximize size={18} />
							</ActionIcon>
						</Tooltip>
					)}
				</>
			)}
		>
			<img
				src={options.src}
				alt={options.alt ?? "image"}
				draggable={false}
				onError={onError}
				style={{
					maxWidth: embedded ? "100cqw" : "90vw",
					maxHeight: embedded ? "100cqh" : "90vh",
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
