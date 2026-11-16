import { fileReferenceApi, localFileImagePreview } from "@frontend/lib/api/file-references";
import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { isRemoteInlineImage } from "@frontend/lib/remote-resource-policy";
import { getFileReferenceImageMimeType } from "@shared/file-reference-image";
import { fileTargetFromHref } from "@shared/markdown-file-path";
import { useEffect, useState } from "react";
import { useOptionalImageViewer } from "../../common/image-viewer-context";
import { useFileReferenceScope } from "../composer/FileReferenceScope";

/** Relative image URLs are filesystem paths, not routes on the web application. */
export function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
	const { context, narratorId } = useFileReferenceScope();
	// Optional: markdown is also rendered without the app shell's providers (standalone
	// renderers and unit tests), where the picture must still paint — just not enlarge.
	const openImageViewer = useOptionalImageViewer();
	const external = !!src && /^(?:https?:|\/\/|data:|blob:)/i.test(src);
	// URL decorations are not filename characters; encoded # and ? remain intact.
	const target = external ? null : fileTargetFromHref(src?.split(/[?#]/, 1)[0], context);
	const deviceId = target?.deviceId;
	const path = target?.path;
	const key = JSON.stringify([narratorId, deviceId, path]);
	// The blob is kept beside the URL purely so the fullscreen viewer can take ownership
	// of the bytes; this component still owns (and revokes) its own URL.
	const [image, setImage] = useState<{ key: string; url: string; blob: Blob } | null>(null);

	useEffect(() => {
		setImage(null);
		if (REMOTE_BUILD || !path || !deviceId || !getFileReferenceImageMimeType(path)) return;
		// A remote path must never fall back to reading the server's filesystem.
		if (!narratorId && deviceId !== "local") return;
		const controller = new AbortController();
		let disposed = false;
		let objectUrl: string | null = null;
		const read = narratorId
			? fileReferenceApi.imagePreview(narratorId, { deviceId, path }, controller.signal)
			: localFileImagePreview(path, controller.signal);
		read.then(
			(blob) => {
				if (disposed) return;
				objectUrl = URL.createObjectURL(blob);
				setImage({ key, url: objectUrl, blob });
			},
			() => {
				// Preserve authored alt text, never retry via an unscoped URL.
				if (!disposed) setImage(null);
			},
		);
		return () => {
			disposed = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [deviceId, path, narratorId, key]);

	const url = REMOTE_BUILD
		? src && isRemoteInlineImage(src)
			? src
			: undefined
		: external
			? src
			: image?.key === key
				? image.url
				: undefined;
	if (!url) return <span title={title}>{alt}</span>;
	const blob = image?.key === key ? image.blob : undefined;
	const filename = path?.split(/[\\/]/).pop() || alt || null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: opens the shared fullscreen viewer; its own dialog handles keys
		<img
			src={url}
			alt={alt ?? ""}
			title={title}
			onClick={
				openImageViewer ? () => openImageViewer({ src: url, blob, filename, alt }) : undefined
			}
			style={{
				maxWidth: "100%",
				height: "auto",
				// The pointer affordance for "this picture enlarges"; absent where no viewer exists.
				cursor: openImageViewer ? "zoom-in" : undefined,
			}}
		/>
	);
}
