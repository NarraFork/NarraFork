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
import { apiUrl, resolveServerUrl } from "@frontend/lib/base-path";
import { useCallback, useEffect, useState } from "react";
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

/** Shared empty set so an untouched failure record keeps a stable identity. */
const NO_FAILED_SOURCES: ReadonlySet<string> = new Set();

/**
 * Sources whose `<img>` load failed, scoped to ONE media ref identity.
 *
 * A set (not a single value) because the two source lanes — the direct
 * `previewUrl` and a fetched blob — are tried in sequence and must stay retired
 * INDEPENDENTLY. With one slot, recording the blob's failure un-retired the
 * direct URL, which the next render offered again; its failure then un-retired
 * the blob, and the two lanes flip-flopped forever, re-fetching `/api/fs/preview`
 * and allocating a fresh object URL on every cycle.
 *
 * Keyed by identity so a ref that switches to a different image starts clean and
 * the set cannot accumulate across sources.
 */
interface FailedImageSources {
	identity: string;
	srcs: ReadonlySet<string>;
}

/** Identity of a ref's resolvable sources; changing it invalidates past failures. */
function sourceIdentity(
	previewUrl: string | null,
	filePath: string | undefined,
	imageId: string | undefined,
	uploadNarratorId: string | undefined,
): string {
	return JSON.stringify([previewUrl, filePath, imageId, uploadNarratorId]);
}

/** The source lanes a ref can resolve through, plus what already failed. */
export interface ImageSourceState {
	/** `previewUrl` as given — usable straight from the ref, never fetched. */
	rawDirect: string | null;
	/** A durable server path (`/api/fs/preview`). */
	filePath?: string;
	/** An uploaded image id, usable only together with a narrator id. */
	imageId?: string;
	uploadNarratorId?: string;
	/** The blob URL the fetch lane produced, if it has settled. */
	blobUrl: string | null;
	/** True once the blob fetch itself failed (network / 404 / too large). */
	fetchError: boolean;
	/** Every src whose `<img>` load failed for THIS ref identity. */
	failedSrcs: ReadonlySet<string>;
}

/**
 * Decide which source to offer and whether the ref is a dead end.
 *
 * Extracted as a pure function so the lane-retirement rules can be driven through
 * MULTIPLE frames in a test (feeding each result back in), which is the only way
 * to catch a non-converging loop — a single-frame check cannot see two lanes
 * taking turns.
 */
export function resolveImageSource(state: ImageSourceState): {
	direct: string | null;
	error: boolean;
} {
	const { rawDirect, filePath, imageId, uploadNarratorId, blobUrl, failedSrcs } = state;
	const direct = rawDirect != null && failedSrcs.has(rawDirect) ? null : rawDirect;
	// A retired blob makes the fetch lane spent: keeping it "available" here is what
	// would let the direct URL be offered again and restart the flip-flop.
	const deadBlob = blobUrl != null && failedSrcs.has(blobUrl);
	const hasFallback = (!!filePath || !!(imageId && uploadNarratorId)) && !deadBlob;
	const deadDirect = rawDirect != null && failedSrcs.has(rawDirect) && !hasFallback;
	return { direct, error: state.fetchError || deadDirect || deadBlob };
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
): { src: string | null; error: boolean; onLoadError: () => void } {
	const [blobUrl, setBlobUrl] = useState<string | null>(null);
	const [error, setError] = useState(false);
	// A DIRECT previewUrl is never fetched here, so a dead one (see below) can only
	// be discovered by the <img> itself failing to load. Every failed source stays
	// retired for as long as the ref points at the same image.
	const [failed, setFailed] = useState<FailedImageSources | null>(null);

	/*
	 * Resolved against the mount prefix HERE, at the point the value becomes an `<img
	 * src>`, because it cannot be fixed where it is produced: a screenshot's `previewUrl`
	 * is minted by the server as a rooted `/api/shares/<id>/preview` and PERSISTED with
	 * the tool call, so rows written before (or by an older server than) any generator fix
	 * would still carry the rooted form.
	 *
	 * Under a prefix the rooted path reaches the proxy's own root instead of us. The
	 * fallback chain below would eventually recover via `filePath`/`imageId`, so the
	 * symptom is a flash of broken image plus a pointless request — degraded rather than
	 * broken, which is exactly why it would never get reported.
	 */
	const rawDirect = ref?.previewUrl ? resolveServerUrl(ref.previewUrl) : null;
	const filePath = ref?.filePath;
	const imageId = ref?.imageId;
	const uploadNarratorId = ref?.uploadNarratorId ?? narratorId;
	const identity = sourceIdentity(rawDirect, filePath, imageId, uploadNarratorId);
	// Failures recorded for a DIFFERENT image must not suppress this one's sources.
	const failedSrcs = failed?.identity === identity ? failed.srcs : NO_FAILED_SOURCES;
	// Once a direct URL is known dead, stop offering it so the fetch path below can
	// try the durable sources (saved file / upload id) instead.
	const { direct, error: resolvedError } = resolveImageSource({
		rawDirect,
		filePath,
		imageId,
		uploadNarratorId,
		blobUrl,
		fetchError: error,
		failedSrcs,
	});

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
			url = `${apiUrl("/fs/preview")}?path=${encodeURIComponent(filePath)}`;
		} else if (imageId && uploadNarratorId) {
			url = apiUrl(`/uploads/${uploadNarratorId}/${imageId}`);
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

	const src = direct ?? blobUrl;
	/**
	 * A screenshot's `previewUrl` points at an IN-MEMORY share that
	 * `cleanupStaleShares()` wipes on every server start, and that expires on its
	 * own timer (see SCREENSHOT_PREVIEW_EXPIRY_HOURS). So a URL persisted with a
	 * tool call from an earlier run resolves to 404 while the server is otherwise
	 * healthy.
	 *
	 * Nothing fetched that URL here — it went straight to the <img> — so a dead
	 * share painted a broken/blank image inside the reserved box, which is what made
	 * old screenshots read as tall empty placeholders.
	 *
	 * Recording the failure both retires the dead URL (letting the effect above retry
	 * via `filePath` / `imageId`, which survive a restart) and, once every source is
	 * retired, reports `error` so the caller paints a neutral placeholder instead.
	 */
	const onLoadError = useCallback(() => {
		if (!src) return;
		setFailed((prev) => {
			// Accumulate within one image identity; a new identity starts fresh so a
			// previous image's dead sources never suppress this one.
			const base = prev?.identity === identity ? prev.srcs : NO_FAILED_SOURCES;
			if (base.has(src)) return prev;
			return { identity, srcs: new Set(base).add(src) };
		});
	}, [src, identity]);

	return { src, error: resolvedError, onLoadError };
}

/** The exact display rectangle a measure layer reserved via `fitImageBox`. */
export interface ExactDisplayBox {
	displayWidth: number;
	displayHeight: number;
}

/**
 * Read a block's exact display geometry, or null when it has none.
 *
 * SINGLE SOURCE for "does this block carry an exact fitted box?". The measure
 * layer reserves either the aspect-fitted rectangle (intrinsic dimensions were
 * persisted) or a fixed-height placeholder, and the render layer must paint the
 * SAME one — a fitted reservation painted in the legacy full-width box is
 * `boxWidth × h/w` tall, which overflows whenever the height cap was the binding
 * constraint (§0 铁律 2). Three call sites made this judgement independently
 * (tool-card media, chat media blocks, user-bubble attachments); one of them
 * drifting is exactly the shape that breaks the invariant, so the predicate
 * lives here and they all call it.
 */
export function readExactDisplayBox(
	data: Record<string, unknown> | undefined,
): ExactDisplayBox | null {
	if (!data) return null;
	const { displayWidth, displayHeight } = data;
	if (typeof displayWidth !== "number" || typeof displayHeight !== "number") return null;
	if (!(displayWidth > 0) || !(displayHeight > 0)) return null;
	return { displayWidth, displayHeight };
}

interface VListImageProps {
	media: VListImageRef;
	/** Panel narrator id (fallback for uploads-scoped fetch). */
	narratorId?: string;
	/** The reserved box height (media cap px) — the image never exceeds it. */
	maxHeight: number;
	/**
	 * Exact display geometry from the measure layer's aspect fit, when the block
	 * carried intrinsic dimensions. In this mode the box IS the image frame
	 * (width × height, no centring), so the paint occupies exactly the reserved
	 * rectangle; absent → the legacy behaviour (full-width box of `maxHeight`
	 * with the image centred inside it).
	 */
	displayWidth?: number;
	displayHeight?: number;
}

/**
 * Paint a media image inside a reserved, height-capped box. While the blob
 * loads (or if it fails / is unsupported) the box keeps its reserved height with
 * a neutral placeholder, so nothing shifts.
 */
export function VListImage({
	media,
	narratorId,
	maxHeight,
	displayWidth,
	displayHeight,
}: VListImageProps) {
	const uploadCapability = useUploadCapability();
	const openImageViewer = useImageViewer();
	// Direct preview URLs and fs-preview reads don't need the narrator-serving
	// capability; only uploads-by-id does. Treat non-upload paths as supported.
	const needsUploadServe = !media.previewUrl && !media.filePath && !!media.imageId;
	const supported = !needsUploadServe || uploadCapability.serveNarratorImages.supported;
	const { src, error, onLoadError } = useResolvedImageSrc(media, narratorId, supported);
	const filename = media.filename ?? "image";
	const usable = src != null && !error;
	// Same predicate the callers use to decide whether to pass the box at all
	// (readExactDisplayBox), so the two sides cannot disagree about which mode
	// this paint is in.
	const exact = readExactDisplayBox({ displayWidth, displayHeight }) != null;

	return (
		<div
			style={
				exact
					? {
							width: displayWidth,
							height: displayHeight,
							maxWidth: "100%",
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "hidden",
							background: usable ? undefined : "var(--vlist-media-bg)",
						}
					: {
							height: maxHeight,
							maxWidth: "100%",
							// A landscape screenshot is width-limited, not height-limited: at
							// `fit-content` the box collapses to the scaled image width and the
							// unused height shows as an empty band. Filling the row and centring
							// the image matches the message bubble's `margin: 0 auto` framing.
							width: "100%",
							borderRadius: "var(--mantine-radius-sm)",
							overflow: "hidden",
							background: usable ? undefined : "var(--vlist-media-bg)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
						}
			}
		>
			{usable ? (
				// biome-ignore lint/a11y/useKeyWithClickEvents: opens the shared fullscreen viewer (keys handled there)
				<img
					src={src}
					alt={filename}
					onClick={() => openImageViewer({ src, filename, alt: filename })}
					onError={onLoadError}
					style={
						exact
							? {
									// The box was reserved at exactly this size by the measure
									// layer's fit formula; contain absorbs the ≤1px rounding error.
									width: "100%",
									height: "100%",
									objectFit: "contain",
									display: "block",
									cursor: "pointer",
								}
							: {
									// `maxHeight` (not a hard height) so a wide screenshot scales on its
									// width and keeps its aspect ratio without letterboxing.
									maxHeight: maxHeight,
									maxWidth: "100%",
									width: "auto",
									height: "auto",
									objectFit: "contain",
									display: "block",
									cursor: "pointer",
								}
					}
					loading="lazy"
				/>
			) : null}
		</div>
	);
}
