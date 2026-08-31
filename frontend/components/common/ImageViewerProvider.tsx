import { ActionIcon, Menu, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconCopy, IconDownload, IconRotate2, IconRotateClockwise2 } from "@tabler/icons-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { copyImageSourceToClipboard, downloadImageSource } from "../../lib/image-actions";
import { Z } from "../../lib/z-index";
/*
 * The context, its types and `useImageViewer` live in `image-viewer-context.ts`.
 *
 * A hook export beside this component makes the module an INVALID Fast Refresh boundary,
 * and since this provider is mounted in `App.tsx`, that put the invalidation on the app
 * shell's own path — shell edits became full page reloads. See that file's header.
 */
import { ImageViewerContext, type ImageViewerOptions } from "./image-viewer-context";
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

// `useImageViewer` moved to `image-viewer-context.ts` — see the import comment above.
