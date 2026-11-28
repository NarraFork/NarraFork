import { authorizedFetch } from "@frontend/lib/api";
import { fileReferenceApi, localFileImagePreview } from "@frontend/lib/api/file-references";
import { apiUrl } from "@frontend/lib/base-path";
import { REMOTE_BUILD } from "@frontend/lib/build-target";
import { isRemoteInlineImage } from "@frontend/lib/remote-resource-policy";
import { getFileReferenceImageMimeType } from "@shared/file-reference-image";
import { fileTargetFromHref, isLocalFileHref } from "@shared/markdown-file-path";
import { useEffect, useState } from "react";
import { useOptionalImageViewer } from "../../common/image-viewer-context";
import { useFileReferenceScope } from "../composer/FileReferenceScope";

/**
 * A picture embedded in a document (DOCX) preview.
 *
 * The document parser writes `nf-doc-asset:?doc=<document path>&id=<asset id>` because the
 * picture is a ZIP entry, not a file the client may read. The document path travels in the URL
 * so this component needs nothing from the surrounding tree — markdown images are rendered by a
 * plain react-markdown callback, with no channel for props.
 */
export function parseDocumentAssetTarget(
	src: string | undefined,
): { documentPath: string; assetId: string } | null {
	if (!src?.startsWith("nf-doc-asset:")) return null;
	const query = src.slice(src.indexOf("?") + 1);
	const parameters = new URLSearchParams(query);
	const documentPath = parameters.get("doc");
	const assetId = parameters.get("id");
	if (!documentPath || !assetId) return null;
	return { documentPath, assetId };
}

/** Relative image URLs are filesystem paths, not routes on the web application. */
export function MarkdownImage({
	src,
	alt,
	title,
	previewHeight,
}: {
	src?: string;
	alt?: string;
	title?: string;
	/** Opt-in fit inside an already-reserved preview slot; never reports image dimensions. */
	previewHeight?: number;
}) {
	const { context, narratorId } = useFileReferenceScope();
	// Optional: markdown is also rendered without the app shell's providers (standalone
	// renderers and unit tests), where the picture must still paint — just not enlarge.
	const openImageViewer = useOptionalImageViewer();
	const documentAsset = parseDocumentAssetTarget(src);
	// Destructured so the request effect depends on primitive values (a fresh object every render
	// would re-run the read forever) while still being visible to the hook-dependency check.
	const assetDocumentPath = documentAsset?.documentPath;
	const assetAssetId = documentAsset?.assetId;
	const external = !documentAsset && !!src && /^(?:https?:|\/\/|data:|blob:)/i.test(src);
	// Plain paths discard URL decorations; explicit file links must keep the query/fragment
	// carrying their device and path. Encoded # and ? remain intact in either form.
	const fileHref = isLocalFileHref(src) ? src : src?.split(/[?#]/, 1)[0];
	const target = external ? null : fileTargetFromHref(fileHref, context);
	const deviceId = target?.deviceId;
	const path = target?.path;
	const key = JSON.stringify([
		narratorId,
		deviceId,
		path,
		documentAsset?.documentPath,
		documentAsset?.assetId,
	]);
	// The blob is kept beside the URL purely so the fullscreen viewer can take ownership
	// of the bytes; this component still owns (and revokes) its own URL.
	const [image, setImage] = useState<{ key: string; url: string; blob: Blob } | null>(null);
	const [failedUrl, setFailedUrl] = useState<string | null>(null);

	useEffect(() => {
		setImage(null);
		const controller = new AbortController();
		let disposed = false;
		let objectUrl: string | null = null;

		const accept = (blob: Blob) => {
			if (disposed) return;
			objectUrl = URL.createObjectURL(blob);
			setImage({ key, url: objectUrl, blob });
		};
		const reject = () => {
			// Preserve authored alt text, never retry via an unscoped URL.
			if (disposed) return;
			setImage(null);
		};

		const read = async () => {
			if (assetDocumentPath && assetAssetId) {
				// The asset endpoint is a local `/api/fs/*` route; a remote frontend build has no
				// business reading this server's disk for a picture.
				if (REMOTE_BUILD) return null;
				const response = await authorizedFetch(
					`${apiUrl("/fs/document-asset")}?path=${encodeURIComponent(assetDocumentPath)}&id=${encodeURIComponent(assetAssetId)}`,
					{ signal: controller.signal },
				);
				if (!response.ok) throw new Error("Document picture request failed");
				return response.blob();
			}
			if (REMOTE_BUILD || !path || !deviceId || !getFileReferenceImageMimeType(path)) return null;
			// A remote path must never fall back to reading the server's filesystem.
			if (!narratorId && deviceId !== "local") return null;
			return narratorId
				? fileReferenceApi.imagePreview(narratorId, { deviceId, path }, controller.signal)
				: localFileImagePreview(path, controller.signal);
		};

		read().then(
			(blob) => {
				if (blob) accept(blob);
				else reject();
			},
			() => reject(),
		);

		return () => {
			disposed = true;
			controller.abort();
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
		// `key` encodes every input of this read, including the document path and asset id.
	}, [deviceId, path, narratorId, key, assetDocumentPath, assetAssetId]);

	const url = documentAsset
		? image?.key === key
			? image.url
			: undefined
		: REMOTE_BUILD
			? src && isRemoteInlineImage(src)
				? src
				: undefined
			: external
				? src
				: image?.key === key
					? image.url
					: undefined;
	if (!url || (previewHeight != null && failedUrl === url)) {
		return (
			<span
				title={title}
				style={
					previewHeight != null
						? {
								maxWidth: "100%",
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
							}
						: undefined
				}
			>
				{alt}
			</span>
		);
	}
	const blob = image?.key === key ? image.blob : undefined;
	const filename = path?.split(/[\\/]/).pop() || alt || null;
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: opens the shared fullscreen viewer; its own dialog handles keys
		<img
			src={url}
			alt={alt ?? ""}
			title={title}
			onError={previewHeight != null ? () => setFailedUrl(url) : undefined}
			onClick={
				openImageViewer ? () => openImageViewer({ src: url, blob, filename, alt }) : undefined
			}
			style={{
				maxWidth: "100%",
				...(previewHeight != null
					? {
							// The caller owns the fixed slot. Loading/decode only changes its paint.
							width: "100%",
							height: previewHeight,
							objectFit: "contain" as const,
							display: "block",
						}
					: { height: "auto" }),
				// The pointer affordance for "this picture enlarges"; absent where no viewer exists.
				cursor: openImageViewer ? "zoom-in" : undefined,
			}}
		/>
	);
}
