/**
 * vlist-image.tsx — Render-layer image loader for the exact vlist. The pure
 * measure/adapter path is forbidden from touching the DOM or fetching, so the
 * actual <img> resolution lives here in the render layer (allowed to run
 * effects). It mirrors the classic ToolCallCard / MessageBubble image loading:
 *
 *   1. a ready-to-use `previewUrl` (blob:/http[s]/data:)          → use directly
 *   2. a server file path (`filePath`) via /api/fs/preview        → blob fetch
 *   3. an uploaded image id (`imageId` + narratorId) via /api/uploads → blob fetch
 *
 * The image is painted inside a FIXED box whose height the measure layer already
 * reserved (media cap = contentPx), so async loading never shifts layout — the
 * box keeps its height whether or not the blob resolves (zero-drift contract).
 *
 * This module is self-contained inside vlist/ (isolation guard permits internal
 * imports); it only pulls shared app utilities (api token, capability hooks,
 * image viewer) that live OUTSIDE vlist/, which is allowed — the guard only
 * forbids the reverse (outside code importing vlist/).
 */

import { useUploadCapability } from "@frontend/hooks/usePlatform";
import { absorbRenewedToken, clearTokenOnSessionFailure, getToken } from "@frontend/lib/api";
import { useEffect, useState } from "react";
import { useImageViewer } from "../../../common/ImageViewerProvider";
import { MAX_INLINE_IMAGE_SOURCE_CHARS } from "../../image-clipboard";

/** Cap a preview blob so a runaway file never balloons memory (25 MB). */
const MAX_PREVIEW_BLOB_BYTES = 25 * 1024 * 1024;

/**
 * Turn an image_generation `result` payload into a usable `<img>` src.
 *
 * The provider hands back either a data-url or BARE base64; feeding the bare form
 * to `src` renders nothing, so it gets the `data:image/png;base64,` prefix here
 * (same normalization MessageBubble does). Oversized payloads return null so a
 * runaway inline image never becomes a multi-megabyte attribute.
 */
export function inlineImageSrcFromResult(result: string | undefined): string | undefined {
	if (!result || result.length > MAX_INLINE_IMAGE_SOURCE_CHARS) return undefined;
	return result.startsWith("data:") ? result : `data:image/png;base64,${result}`;
}

/** Descriptor the classifier attached to a media detail / media block. */
export interface VListImageRef {
	previewUrl?: string;
	filePath?: string;
	imageId?: string;
	filename?: string;
	sizeKB?: number;
	imageFormat?: string;
	/** Upload-scoped narrator id (falls back to the panel narratorId). */
	uploadNarratorId?: string;
}

/**
 * Resolve an <img> src for a media ref, fetching a blob when needed. Returns
 * the URL (or null while loading / on failure) plus an error flag. Cleans up any
 * object URL it created on unmount / ref change.
 */
export function useResolvedImageSrc(
	ref: VListImageRef | undefined,
	narratorId: string | undefined,
	supported: boolean,
): { src: string | null; error: boolean } {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [error, setError] = useState(false);

	const direct = ref?.previewUrl ?? null;
	const filePath = ref?.filePath;
	const imageId = ref?.imageId;
	const uploadNarratorId = ref?.uploadNarratorId ?? narratorId;

	useEffect(() => {
		// A direct preview URL needs no fetch.
		if (direct) {
			setBlobUrl(null);
			setError(false);
			return;
		}
		if (!supported) return;
		// Decide the fetch endpoint: fs preview by path, else uploads by id.
		let url: string | null = null;
		if (filePath) {
			url = `/api/fs/preview?path=${encodeURIComponent(filePath)}`;
		} else if (imageId && uploadNarratorId) {
			url = `/api/uploads/${uploadNarratorId}/${imageId}`;
		}
		if (!url) return;

		let cancelled = false;
		let objectUrl: string | null = null;
		const headers: Record<string, string> = {};
		const token = getToken();
		if (token) headers.Authorization = `Bearer ${token}`;
		setError(false);
		fetch(url, { headers })
			.then(async (res) => {
				// Pass the token this request actually used: absorbRenewedToken only overwrites
				// storage when it is still the current one, so a tab that switched accounts
				// mid-flight cannot have the previous account's renewal written back over it.
				absorbRenewedToken(res, token ?? undefined);
				if (!res.ok) {
					await clearTokenOnSessionFailure(res);
					throw new Error(`Request failed (${res.status})`);
				}
				return res.blob();
			})
			.then((blob) => {
				if (cancelled) return;
				if (blob.size > MAX_PREVIEW_BLOB_BYTES) throw new Error("Preview too large");
				objectUrl = URL.createObjectURL(blob);
				setBlobUrl(objectUrl);
			})
			.catch(() => {
				if (!cancelled) setError(true);
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [direct, filePath, imageId, uploadNarratorId, supported]);

	return { src: direct ?? blobUrl, error };
}

interface VListImageProps {
	media: VListImageRef;
	/** Panel narrator id (fallback for uploads-scoped fetch). */
	narratorId?: string;
	/** The reserved box height (media cap px) — the image never exceeds it. */
	maxHeight: number;
}

/**
 * Paint a media image inside a reserved, height-capped box. While the blob
 * loads (or if it fails / is unsupported) the box keeps its reserved height with
 * a neutral placeholder, so nothing shifts.
 */
export function VListImage({ media, narratorId, maxHeight }: VListImageProps) {
	const uploadCapability = useUploadCapability();
	const openImageViewer = useImageViewer();
	// Direct preview URLs and fs-preview reads don't need the narrator-serving
	// capability; only uploads-by-id does. Treat non-upload paths as supported.
	const needsUploadServe = !media.previewUrl && !media.filePath && !!media.imageId;
	const supported = !needsUploadServe || uploadCapability.serveNarratorImages.supported;
	const { src, error } = useResolvedImageSrc(media, narratorId, supported);
	const filename = media.filename ?? "image";

	return (
		<div
			style={{
				height: maxHeight,
				maxWidth: "100%",
				width: "fit-content",
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
				background: src ? undefined : "var(--vlist-media-bg)",
			}}
		>
			{src && !error ? (
				// biome-ignore lint/a11y/useKeyWithClickEvents: opens the shared fullscreen viewer (keys handled there)
				<img
					src={src}
					alt={filename}
					onClick={() => openImageViewer({ src, filename, alt: filename })}
					style={{
						height: maxHeight,
						width: "auto",
						maxWidth: "100%",
						objectFit: "contain",
						display: "block",
						cursor: "pointer",
					}}
					loading="lazy"
				/>
			) : (
				<div style={{ height: maxHeight, width: 300, maxWidth: "100%" }} />
			)}
		</div>
	);
}
