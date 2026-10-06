import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ImageViewer } from "./ImageViewer";
import { ImageViewerContext, type ImageViewerOptions } from "./image-viewer-context";

/** Own the fullscreen URL independently of the panel that supplied the blob. */
function OwnedImageViewer({
	options,
	onClose,
}: {
	options: ImageViewerOptions;
	onClose: () => void;
}) {
	const [owned, setOwned] = useState<{ blob: Blob; src: string } | null>(null);
	useEffect(() => {
		if (!options.blob) return;
		const src = URL.createObjectURL(options.blob);
		setOwned({ blob: options.blob, src });
		return () => URL.revokeObjectURL(src);
	}, [options.blob]);
	if (options.blob && owned?.blob !== options.blob) return null;
	return (
		<ImageViewer
			options={options.blob && owned ? { ...options, src: owned.src } : options}
			onClose={onClose}
		/>
	);
}

export function ImageViewerProvider({ children }: { children: React.ReactNode }) {
	const [request, setRequest] = useState<{ options: ImageViewerOptions; id: number } | null>(null);
	const open = useCallback((options: ImageViewerOptions) => {
		if (!options.src) return;
		setRequest((previous) => ({ options, id: (previous?.id ?? 0) + 1 }));
	}, []);
	const close = useCallback(() => setRequest(null), []);
	const value = useMemo(() => ({ open }), [open]);
	return (
		<ImageViewerContext.Provider value={value}>
			{children}
			{request &&
				createPortal(
					<OwnedImageViewer key={request.id} options={request.options} onClose={close} />,
					document.body,
				)}
		</ImageViewerContext.Provider>
	);
}
