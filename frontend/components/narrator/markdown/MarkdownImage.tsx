import { fileReferenceApi, localFileImagePreview } from "@frontend/lib/api/file-references";
import { getFileReferenceImageMimeType } from "@shared/file-reference-image";
import { fileTargetFromHref } from "@shared/markdown-file-path";
import { useEffect, useState } from "react";
import { useFileReferenceScope } from "../composer/FileReferenceScope";

/** Relative image URLs are filesystem paths, not routes on the web application. */
export function MarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
	const { context, narratorId } = useFileReferenceScope();
	const external = !!src && /^(?:https?:|\/\/|data:|blob:)/i.test(src);
	// URL decorations are not filename characters; encoded # and ? remain intact.
	const target = external ? null : fileTargetFromHref(src?.split(/[?#]/, 1)[0], context);
	const deviceId = target?.deviceId;
	const path = target?.path;
	const key = JSON.stringify([narratorId, deviceId, path]);
	const [image, setImage] = useState<{ key: string; url: string } | null>(null);

	useEffect(() => {
		setImage(null);
		if (!path || !deviceId || !getFileReferenceImageMimeType(path)) return;
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
				setImage({ key, url: objectUrl });
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

	const url = external ? src : image?.key === key ? image.url : undefined;
	if (!url) return <span title={title}>{alt}</span>;
	return (
		<img src={url} alt={alt ?? ""} title={title} style={{ maxWidth: "100%", height: "auto" }} />
	);
}
